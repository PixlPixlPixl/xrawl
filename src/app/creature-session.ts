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
import type { CreatureGenetics } from '@/shared/types/creature';
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
  /** Learned hunting priorities keyed by normalized word, from the background. */
  private priorities: ReadonlyMap<string, number> = new Map();

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

  setVisible(visible: boolean): void {
    const element = this.renderer.element;
    element.style.display = visible ? 'block' : 'none';
    if (visible) this.start();
    else this.stop();
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

    const targets = this.currentTargets();
    const result = this.engine.step({
      dtSeconds: dt,
      targets,
      now: Date.now(),
      satiety: this.satietyFromSnapshot(),
    });

    if (result.feeding) this.reportFeeding(result.feeding.target, result.feeding.eatenAt, result.feeding.nutrition, result.feeding.preferenceDelta);

    const viewport = this.options.platform.viewport.read();
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
    // Rebuild only when the detection radius changes; the target list itself is
    // a cheap filter over the snapshot and must not allocate per frame.
    const cache = this.targetCache;
    if (cache && cache.revision === snapshot.revision) return cache.targets;

    const targets = buildForageTargets(snapshot.targets, {
      maximumWordLength: this.forageFilters.maximumWordLength,
      priorities: this.priorities,
    });
    this.targetCache = { revision: snapshot.revision, targets };
    return targets;
  }

  private satietyFromSnapshot(): number {
    return this.engine.stomachFill / Math.max(1, this.engine.attributes.stomachCapacity);
  }

  private reportFeeding(
    target: ForageTarget,
    eatenAt: number,
    nutrition: number,
    preferenceDelta: number,
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
   * Replace the learned priorities for the words on this page.
   *
   * The candidate list is rebuilt (not patched) because selection reads
   * `priority` from every target: patching a subset would leave the rest on
   * their rarity fallback and quietly bias the comparison.
   */
  applyPriorities(priorities: ReadonlyMap<string, number>): void {
    this.priorities = priorities;
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
