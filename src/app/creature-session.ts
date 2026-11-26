/**
 * Folding the live creature into the content session.
 *
 * This is the composition point: it owns the frame loop, feeds the creature
 * current word targets, mounts the SVG overlay, and reports feedings to the
 * background (which is the only thing allowed to write the database).
 *
 * It is deliberately thin. All animation logic lives in `creature/`; this file
 * only moves data between the world snapshot, the engine, and the renderer.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import type { Platform } from '@/platform/types';
import { CreatureEngine } from '@/creature/engine';
import { resolveLoadout } from '@/creature/loadout';
import { CreatureRenderer } from '@/creature/render/svg-renderer';
import { getSpecies, resolveGenetics } from '@/creature/species';
import { buildForageTargets, type ForageTarget } from '@/creature/targets';
import { clampTrailing } from '@/creature/companion';
import type { ForagePlan } from '@/progression/forage';
import { DEFAULT_CREATURE_MODE, type CreatureGenetics, type CreatureMode } from '@/shared/types/creature';
import type { WorldSnapshot } from '@/shared/types/word-target';
import type { FeedingPayload } from '@/data/observation';

export interface CreatureLoadoutInput {
  readonly creatureId: string;
  readonly species: string;
  readonly name?: string;
  readonly genetics: CreatureGenetics;
  readonly upgradeLevels: Readonly<Record<string, number>>;
}

export interface CreatureSessionOptions {
  readonly document: Document;
  readonly window: Window;
  readonly platform: Platform;
  /** Optional loadout supplied by the background (species + genes + purchases). */
  readonly loadout?: CreatureLoadoutInput | null;
  readonly speciesId?: string;
  readonly genetics?: Partial<CreatureGenetics>;
  readonly upgradeLevels?: Readonly<Record<string, number>>;
  /** Session id shared with observations, so feeding events join sessions. */
  readonly sessionId: string;
  readonly sendFeeding: (payload: FeedingPayload) => void;
  readonly creatureId?: string;
}

export class CreatureSession {
  private readonly options: CreatureSessionOptions;
  private readonly engine: CreatureEngine;
  private readonly renderer: CreatureRenderer;
  private readonly forageFilters: { maximumWordLength: number };
  private mounted = false;
  private lastFrameAt = 0;
  private handle: number | null = null;
  private running = false;

  private snapshot: WorldSnapshot | null = null;
  private lastDetectionRadius = 0;

  private currentCreatureId: string;
  private targetCache: { revision: number; targets: ForageTarget[] } | null = null;
  /** Learned scoring components keyed by normalized word, from the background. */
  private plans: ReadonlyMap<string, ForagePlan> = new Map();

  /** Gameplay mode; companion follows the pointer, foraging hunts alone. */
  private mode: CreatureMode = DEFAULT_CREATURE_MODE;
  /** Pointer position in document space, for companion trailing. */
  private pointer: { x: number; y: number } | null = null;
  private trailingDistance = 96;
  /** Word the user clicked in feeding mode, until it is eaten or vanishes. */
  private manualTargetId: string | null = null;

  /** The user's creature toggle (popup), independent of whether this tab is live. */
  private enabled = true;
  /**
   * Whether this tab currently *hosts* the creature. One persistent creature
   * transfers between active tabs: the others hide it rather than spawning a
   * second one with a separate history.
   */
  private present = true;

  constructor(options: CreatureSessionOptions) {
    this.options = options;

    const species = getSpecies(options.loadout?.species ?? options.speciesId ?? 'spider');
    const genetics = resolveGenetics(species.defaults, {
      ...(options.loadout?.genetics ?? {}),
      ...(options.genetics ?? {}),
    });
    const loadout = resolveLoadout(
      genetics,
      options.loadout?.upgradeLevels ?? options.upgradeLevels ?? {},
    );

    this.forageFilters = { maximumWordLength: loadout.attributes.maximumWordLength };
    this.engine = new CreatureEngine({
      appearance: loadout.appearance,
      attributes: loadout.attributes,
      gait: species.gait,
      genetics,
      origin: { x: 600, y: 400 },
    });
    this.lastDetectionRadius = loadout.attributes.detectionRadius;
    this.currentCreatureId = options.loadout?.creatureId ?? options.creatureId ?? 'xrawl-0';

    this.renderer = new CreatureRenderer(options.document, loadout.appearance);
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.options.document.documentElement.appendChild(this.renderer.element);
    this.renderer.applyAppearance(this.engine.appearance);
  }

  destroy(): void {
    this.stop();
    this.renderer.element.remove();
    this.mounted = false;
  }

  /** Popup toggle: the creature is enabled at all. */
  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.applyVisibility();
  }

  /**
   * Whether this tab is the one hosting the creature.
   *
   * A background tab keeps its session (and its snapshot cache) but stops
   * rendering and simulating; the creature reappears here the moment the tab is
   * focused again, with the same identity and progression.
   */
  setPresent(present: boolean): void {
    this.present = present;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const visible = this.enabled && this.present;
    this.renderer.element.style.display = visible ? 'block' : 'none';
    if (visible) this.start();
    else this.stop();
  }

  setMode(mode: CreatureMode): void {
    this.mode = mode;
    this.engine.setMode(mode);
    this.manualTargetId = null;
    this.targetCache = null;
  }

  getMode(): CreatureMode {
    return this.mode;
  }

  /** Pointer in document space; the engine only reads it in companion mode. */
  setPointer(point: { x: number; y: number } | null): void {
    this.pointer = point;
  }

  setTrailingDistance(distance: number): void {
    this.trailingDistance = clampTrailing(distance);
  }

  /**
   * Ask the creature to eat a specific word (manual feeding mode).
   *
   * Returns false when the word is no longer on the page, so the caller can tell
   * the user rather than silently doing nothing.
   */
  feed(targetId: string | null, word?: string): boolean {
    if (!this.snapshot) return false;
    const targets = this.currentTargets();
    const match =
      (targetId === null ? undefined : targets.find((target) => target.id === targetId)) ??
      (word === undefined ? undefined : targets.find((target) => target.word === word));

    if (!match) return false;
    this.manualTargetId = match.id;
    return true;
  }

  /** Feed page snapshots in; the creature only consumes eligible words. */
  syncSnapshot(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
  }

  start(): void {
    if (this.running || !this.mounted) return;
    this.running = true;
    this.lastFrameAt = this.options.platform.scheduler.now();
    this.scheduleFrame();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null && this.options.window.cancelAnimationFrame) {
      this.options.window.cancelAnimationFrame(this.handle);
    }
    this.handle = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    const win = this.options.window;
    if (typeof win.requestAnimationFrame === 'function') {
      this.handle = win.requestAnimationFrame(() => this.frame());
      return;
    }
    this.handle = win.setTimeout(() => this.frame(), XRAWL_CONFIG.creature.frameIntervalMs) as unknown as number;
  }

  private frame(): void {
    this.handle = null;
    if (!this.running) return;

    const now = this.options.platform.scheduler.now();
    const dt = Math.min(0.12, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;

    const viewport = this.options.platform.viewport.read();
    const targets = this.currentTargets();
    // A manual pick whose word has left the page is stale: forgetting it stops
    // the engine asking for a target that no longer exists.
    if (this.manualTargetId !== null && !targets.some((target) => target.id === this.manualTargetId)) {
      this.manualTargetId = null;
    }

    // The pointer is tracked in client coordinates (that is what events carry);
    // the engine works in document space, so the scroll offset is applied here.
    const follow =
      this.pointer === null
        ? null
        : { x: this.pointer.x + viewport.scroll.x, y: this.pointer.y + viewport.scroll.y };

    const result = this.engine.step({
      dtSeconds: dt,
      targets,
      now: Date.now(),
      mode: this.mode,
      follow,
      trailingDistance: this.trailingDistance,
      manualTargetId: this.manualTargetId,
    });

    if (result.feeding) {
      if (result.feeding.source === 'manual') this.manualTargetId = null;
      this.reportFeeding(
        result.feeding.target,
        result.feeding.eatenAt,
        result.feeding.nutrition,
        result.feeding.preferenceDelta,
        result.feeding.source,
      );
    }

    this.renderer.render(result.pose, {
      scrollX: viewport.scroll.x,
      scrollY: viewport.scroll.y,
      width: viewport.size.width,
      height: viewport.size.height,
    });

    this.scheduleFrame();
  }

  private currentTargets(): ForageTarget[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    // Rebuild once per snapshot revision (and whenever the loadout or the
    // learned plans change); the target list is a filter over the snapshot and
    // must not be allocated per frame.
    const cache = this.targetCache;
    if (cache && cache.revision === snapshot.revision) return cache.targets;

    const targets = buildForageTargets(snapshot.targets, {
      maximumWordLength: this.forageFilters.maximumWordLength,
      plans: this.plans,
    });
    this.targetCache = { revision: snapshot.revision, targets };
    return targets;
  }

  private reportFeeding(
    target: ForageTarget,
    eatenAt: number,
    nutrition: number,
    preferenceDelta: number,
    source: 'manual' | 'autonomous',
  ): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    this.options.sendFeeding({
      sessionId: this.options.sessionId,
      creatureId: this.currentCreatureId,
      word: target.word,
      eatenAt,
      environment: target.environment as FeedingPayload['environment'],
      pageUrl: snapshot.page.url,
      pageTitle: snapshot.page.title,
      contextSentence: target.contextSentence,
      fingerprint: target.fingerprint,
      source,
      nutrition,
      preferenceDelta,
    });
  }

  /**
   * Apply a loadout fetched from the background after the session has started.
   *
   * Purchases only change attributes; a genetics change rebuilds the rig. Both
   * go through the engine so the renderer never sees a half-updated creature.
   */
  applyLoadout(loadout: CreatureLoadoutInput): void {
    const species = getSpecies(loadout.species);
    const genetics = resolveGenetics(species.defaults, loadout.genetics);
    const resolved = resolveLoadout(genetics, loadout.upgradeLevels);

    this.currentCreatureId = loadout.creatureId;
    this.lastDetectionRadius = resolved.attributes.detectionRadius;
    this.engine.setAttributes(resolved.attributes);
    this.forageFilters.maximumWordLength = resolved.attributes.maximumWordLength;
    this.targetCache = null;

    // Only rebuild the body if construction actually changed; a pure upgrade
    // must not reset the gait mid-stride.
    const next = JSON.stringify(resolved.appearance);
    if (next !== JSON.stringify(this.engine.appearance)) {
      this.engine.setAppearance(resolved.appearance);
      this.renderer.applyAppearance(resolved.appearance);
      this.targetCache = null;
    }
  }

  /**
   * Replace the learned scoring components for the words on this page.
   *
   * The candidate list is rebuilt (not patched) because every target carries its
   * components: patching a subset would leave the rest on their fallback plan and
   * quietly bias the comparison.
   */
  applyPlans(plans: ReadonlyMap<string, ForagePlan>): void {
    this.plans = plans;
    this.targetCache = null;
  }

  /** Exposed for tests and for the popup to show a live stat. */
  get engineReference(): CreatureEngine {
    return this.engine;
  }

  get creatureName(): string {
    return this.options.loadout?.name ?? 'Xrawl';
  }

  get detectionRadius(): number {
    return this.lastDetectionRadius;
  }
}

/** Convenience: the feeding payload shape reuses the page-level message type. */
export type { FeedingPayload };
