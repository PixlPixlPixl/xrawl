/**
 * Word scanner — the perception engine's orchestrator.
 *
 * Responsibilities:
 *  - incremental, chunked measurement of the document in reading order;
 *  - caching segmentation per text node (unchanged text is never re-parsed);
 *  - observing DOM mutations, resizes, visibility, navigation, and nested
 *    scrollers, and deciding when geometry actually needs re-measuring;
 *  - publishing plain word targets into `WorldState`.
 *
 * It knows the DOM (perception is allowed to) but nothing about creatures,
 * progression, rendering, or storage.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import { hashString, stableKey } from '@/shared/id';
import type { Platform, TimerHandle } from '@/platform/types';
import { computeVisibility, toViewportRect, type Rect, type Viewport } from '@/shared/types/geometry';
import type { PassKind, WordContext, WordTarget } from '@/shared/types/word-target';
import { EMPTY_BASE_STATS } from '@/shared/types/word-target';
import { EnvironmentTracker } from '@/world/environment/tracker';
import type { WorldState } from '@/world/world-state';
import { ClipResolver } from './clipping';
import { ContextResolver, SentenceIndex, type ContextLimits } from './context';
import { RangeMeasurer } from './geometry';
import { iterateTextNodes } from './text-discovery';
import { VisibilityCache } from './visibility';
import { SegmentationCache, type WordSegment } from './word-segmentation';

interface TrackedNode {
  readonly id: string;
  node: Text;
  text: string;
  segments: readonly WordSegment[];
  sentenceIndex: SentenceIndex;
  targets: readonly WordTarget[];
  /** Layout/content fingerprint; equal key ⇒ nothing changed. */
  key: string;
}

interface Measurement {
  readonly targets: WordTarget[];
  readonly key: string;
  readonly segments: readonly WordSegment[];
  readonly sentenceIndex: SentenceIndex;
}

interface PassRequest {
  readonly kind: PassKind;
  readonly root: Element | null;
}

const CONTEXT_LIMITS: ContextLimits = {
  sentenceMaxChars: XRAWL_CONFIG.scan.sentenceMaxChars,
  surroundingMaxChars: XRAWL_CONFIG.scan.surroundingMaxChars,
  surroundingBlockLimit: XRAWL_CONFIG.scan.surroundingBlockLimit,
};

const KIND_RANK = { initial: 0, layout: 1, resize: 2, manual: 3 } satisfies Record<PassKind, number>;

function strongerKind(a: PassKind | null, b: PassKind): PassKind {
  if (a === null) return b;
  return KIND_RANK[a] >= KIND_RANK[b] ? a : b;
}

export class WordScanner {
  private readonly doc: Document;
  private readonly platform: Platform;
  private readonly world: WorldState;
  private readonly win: Window | null;

  private readonly segmentation = new SegmentationCache();
  private readonly visibility = new VisibilityCache();
  private readonly measurer: RangeMeasurer;
  private readonly clips: ClipResolver;
  private readonly contextResolver: ContextResolver;
  private readonly tracker = new EnvironmentTracker();

  private readonly nodeIds = new WeakMap<Text, string>();
  private readonly nodes = new Map<string, TrackedNode>();
  private nextNodeId = 1;

  private started = false;
  private disposed = false;
  private running = false;
  private restartRequest: PassRequest | null = null;

  private pendingTimer: TimerHandle | null = null;
  private resizeTimer: TimerHandle | null = null;
  private scopedTimer: TimerHandle | null = null;
  private scrollRescanTimer: TimerHandle | null = null;
  private scrollValidateTimer: TimerHandle | null = null;
  private autoSettleTimer: TimerHandle | null = null;
  private autoSettleUsed = false;
  private resizePending = false;
  private scopedRoot: Element | null = null;
  private scrollFramePending = false;
  private observer: MutationObserver | null = null;
  private readonly observedShadowRoots = new WeakSet<ShadowRoot>();
  private cleanups: Array<() => void> = [];

  private passCount = 0;
  private mutationBatches = 0;
  private deferredPasses = 0;
  private deferredForHiddenDoc = false;
  private lastPassDurationMs = 0;
  private lastPassFinishedAt = 0;

  constructor(options: { document: Document; platform: Platform; world: WorldState }) {
    this.doc = options.document;
    this.platform = options.platform;
    this.world = options.world;
    this.win = options.document.defaultView;
    this.measurer = new RangeMeasurer(this.doc);
    this.clips = new ClipResolver(this.doc);
    this.contextResolver = new ContextResolver(this.doc);
  }

  start(): void {
    if (this.started || this.disposed) return;
    if (this.doc.body === null) return;

    this.started = true;
    this.attachListeners();
    this.discoverShadowRoots();
    this.requestPass('initial', 0, null);
  }

  rescan(): void {
    this.autoSettleUsed = false;
    this.requestPass('manual', 0, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.observer?.disconnect();
    this.observer = null;

    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];

    this.clearTimer('pendingTimer');
    this.clearTimer('resizeTimer');
    this.clearTimer('scopedTimer');
    this.clearTimer('scrollRescanTimer');
    this.clearTimer('scrollValidateTimer');
    this.clearTimer('autoSettleTimer');

    this.measurer.dispose();
    this.nodes.clear();
  }

  private attachListeners(): void {
    if (this.win !== null) {
      const onScroll = (event: Event) => this.handleScroll(event);
      this.win.addEventListener('scroll', onScroll, { passive: true, capture: true });
      this.cleanups.push(() => this.win?.removeEventListener('scroll', onScroll, { capture: true }));

      const onResize = () => this.handleResize();
      this.win.addEventListener('resize', onResize, { passive: true });
      this.cleanups.push(() => this.win?.removeEventListener('resize', onResize));

      const onVisibilityChange = () => this.handleVisibilityChange();
      this.doc.addEventListener('visibilitychange', onVisibilityChange);
      this.cleanups.push(() => this.doc.removeEventListener('visibilitychange', onVisibilityChange));
    }

    // Animations can reveal content (or move it) without any DOM mutation.
    const onPresentationEnd = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && this.isOverlayNode(target)) return;
      this.scheduleLayoutPass();
    };
    this.doc.addEventListener('animationend', onPresentationEnd, true);
    this.doc.addEventListener('transitionend', onPresentationEnd, true);
    this.cleanups.push(() => this.doc.removeEventListener('animationend', onPresentationEnd, true));
    this.cleanups.push(() => this.doc.removeEventListener('transitionend', onPresentationEnd, true));

    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...XRAWL_CONFIG.scan.mutationAttributeFilter],
    });
    // Images, iframes, and ads can change layout without a DOM mutation.
    const onResourceLoad = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && this.isOverlayNode(target)) return;
      this.scheduleLayoutPass();
    };
    this.doc.addEventListener('load', onResourceLoad, true);
    this.cleanups.push(() => this.doc.removeEventListener('load', onResourceLoad, true));

    // Document growth/shrink (lazy lists, collapsing panels) moves every
    // word below it; the first callback is just the initial size.
    let resizeObserverSeenInitial = false;
    const resizeObserver = new ResizeObserver(() => {
      if (!resizeObserverSeenInitial) {
        resizeObserverSeenInitial = true;
        return;
      }
      this.scheduleLayoutPass();
    });
    resizeObserver.observe(this.doc.body);
    this.cleanups.push(() => resizeObserver.disconnect());

    // Web-font swaps reflow text without touching the DOM.
    void this.doc.fonts?.ready.then(() => {
      if (!this.disposed) this.scheduleLayoutPass();
    });
  }

  private handleScroll(event: Event): void {
    if (this.disposed) return;

    const target = event.target;
    // Nested scrollers change word geometry without moving the window; they
    // need a scoped re-measure rather than a cheap viewport update.
    const targetElement =
      target instanceof Node && target.nodeType === Node.ELEMENT_NODE
        ? (target as Element)
        : null;
    if (
      targetElement !== null &&
      targetElement !== this.doc.documentElement &&
      targetElement !== this.doc.body
    ) {
      this.requestScopedPass(targetElement);
      return;
    }

    if (this.scrollFramePending) return;
    this.scrollFramePending = true;
    void this.platform.scheduler.nextFrame().then(() => {
      this.scrollFramePending = false;
      if (this.disposed) return;
      // Pure geometry: no DOM reads and no text re-measurement.
      this.world.setViewport(this.platform.viewport.read());
      // content-visibility sections may have become rendered by scrolling;
      // they need a real pass once scrolling settles.
      if (
        this.visibility.contentVisibilitySkipped ||
        this.visibility.contentVisibilityPresent
      ) {
        this.scheduleScrollRescan();
      }
      this.scheduleScrollValidation();
    });
  }

  private requestScopedPass(root: Element): void {
    if (this.doc.visibilityState === 'hidden') {
      this.deferredForHiddenDoc = true;
      return;
    }

    this.scopedRoot = root;
    this.clearTimer('scopedTimer');
    this.scopedTimer = this.platform.scheduler.timeout(() => {
      this.scopedTimer = null;
      const scopedRoot = this.scopedRoot;
      this.scopedRoot = null;
      if (scopedRoot?.isConnected) this.requestPass('layout', 0, scopedRoot);
    }, XRAWL_CONFIG.scan.scopedScrollDebounceMs);
  }

  private handleResize(): void {
    if (this.disposed) return;
    // A resize re-measures everything; a pending scroll-only rescan is redundant.
    this.resizePending = true;
    this.clearTimer('scrollRescanTimer');
    this.clearTimer('resizeTimer');
    this.resizeTimer = this.platform.scheduler.timeout(() => {
      this.resizeTimer = null;
      if (this.doc.visibilityState === 'hidden') {
        this.deferredForHiddenDoc = true;
        return;
      }
      this.requestPass('resize', 0, null);
    }, XRAWL_CONFIG.scan.resizeDebounceMs);
  }

  private handleVisibilityChange(): void {
    if (this.disposed) return;
    if (this.doc.visibilityState === 'visible' && this.deferredForHiddenDoc) {
      this.deferredForHiddenDoc = false;
      this.requestPass('layout', 0, null);
    }
  }

  private onMutations(records: readonly MutationRecord[]): void {
    if (this.disposed) return;

    let relevant = false;
    for (const record of records) {
      if (!this.isOverlayNode(record.target)) {
        relevant = true;
        break;
      }
    }
    if (!relevant) return;

    this.mutationBatches += 1;

    if (this.doc.visibilityState === 'hidden') {
      this.deferredForHiddenDoc = true;
      this.deferredPasses += 1;
      return;
    }

    // Debounce with adaptive backoff: a live-updating page never gets to
    // monopolise the main thread, and a cheap page is measured promptly.
    this.scheduleLayoutPass();
  }

  private scheduleLayoutPass(): void {
    if (this.disposed) return;

    if (this.doc.visibilityState === 'hidden') {
      this.deferredForHiddenDoc = true;
      this.deferredPasses += 1;
      return;
    }

    const now = this.platform.scheduler.now();
    const spacing = Math.max(
      XRAWL_CONFIG.scan.minMutationPassSpacingMs,
      this.lastPassDurationMs * 3,
    );
    const sinceLastPass = now - this.lastPassFinishedAt;
    const delay = Math.max(XRAWL_CONFIG.scan.mutationDebounceMs, spacing - sinceLastPass);

    this.clearTimer('pendingTimer');
    this.pendingTimer = this.platform.scheduler.timeout(() => {
      this.pendingTimer = null;
      this.requestPass('layout', 0, null);
    }, delay);
  }

  private scheduleScrollRescan(): void {
    if (this.disposed || this.doc.visibilityState === 'hidden') return;
    if (this.resizePending) return;

    this.clearTimer('scrollRescanTimer');
    this.scrollRescanTimer = this.platform.scheduler.timeout(() => {
      this.scrollRescanTimer = null;
      this.requestPass('layout', 0, null);
    }, XRAWL_CONFIG.scan.scrollRescanDelayMs);
  }

  /**
   * Sample a few tracked words after scrolling stops. If any stored
   * document-space rect no longer matches the DOM, layout shifted without a
   * signal we observe (lazy panels, inline content growth, etc.), so schedule
   * a real pass instead of leaving stale outlines on screen.
   */
  private scheduleScrollValidation(): void {
    if (this.disposed || this.doc.visibilityState === 'hidden') return;
    if (this.resizePending) return;

    this.clearTimer('scrollValidateTimer');
    this.scrollValidateTimer = this.platform.scheduler.timeout(() => {
      this.scrollValidateTimer = null;
      if (this.running) return;

      this.clips.reset();
      const viewport = this.platform.viewport.read();
      const tracked = [...this.nodes.values()];
      if (tracked.length === 0) return;

      const samples = Math.min(12, tracked.length);
      const stride = Math.max(1, Math.floor(tracked.length / samples));
      let checked = 0;

      for (let index = 0; index < tracked.length && checked < samples; index += stride) {
        const node = tracked[index];
        checked += 1;
        if (!node.node.isConnected) {
          this.requestPass('layout', 0, null);
          return;
        }

        const target = node.targets[0];
        if (target === undefined) {
          if (node.segments.length > 0) {
            this.requestPass('layout', 0, null);
            return;
          }
          continue;
        }

        const segment = node.segments[target.source.segmentIndex];
        if (segment === undefined) continue;

        const rects = this.measurer.measure(
          node.node,
          segment.start,
          segment.end,
          viewport.scroll,
          this.clips.clipFor(node.node, viewport.scroll),
        );
        const stored = target.rects[0];
        const current = rects[0];

        if (stored === undefined || current === undefined) {
          this.requestPass('layout', 0, null);
          return;
        }

        const drift = Math.max(
          Math.abs(stored.x - current.x),
          Math.abs(stored.y - current.y),
          Math.abs(stored.width - current.width),
          Math.abs(stored.height - current.height),
        );
        if (drift > 1.5) {
          this.requestPass('layout', 0, null);
          return;
        }
      }
    }, XRAWL_CONFIG.scan.scrollRescanDelayMs);
  }

  private requestPass(kind: PassKind, delayMs: number, root: Element | null): void {
    if (this.disposed) return;

    if (this.running) {
      const existing = this.restartRequest;
      const fullPass = root === null || existing?.root === null;
      this.restartRequest = {
        kind: strongerKind(existing?.kind ?? null, kind),
        root: fullPass ? null : (existing?.root ?? root),
      };
      return;
    }

    this.clearTimer('pendingTimer');

    if (delayMs <= 0) {
      void this.runPass(kind, root);
      return;
    }

    this.pendingTimer = this.platform.scheduler.timeout(() => {
      this.pendingTimer = null;
      void this.runPass(kind, root);
    }, delayMs);
  }

  private async runPass(kind: PassKind, root: Element | null): Promise<void> {
    if (this.disposed || this.running) return;

    const body = this.doc.body;
    if (body === null || this.doc.designMode === 'on' || body.isContentEditable) {
      // Whole document is editable: nothing here is safe to treat as content.
      this.world.setBaseStats(this.baseStats(kind, 0, 0, false, false, 0));
      this.world.commit();
      return;
    }

    this.running = true;
    this.passCount += 1;
    if (kind === 'resize') this.resizePending = false;

    const startedAt = this.platform.scheduler.now();
    const viewport = this.platform.viewport.read();

    // A new pass means CSS/layout input may have changed.
    this.visibility.invalidate();
    this.clips.reset();
    this.contextResolver.reset();

    const refresh = this.tracker.refresh(this.doc);
    this.world.setPage(refresh.page);
    this.world.setEnvironment(refresh.environment);
    this.world.setViewport(viewport);

    const scoped = root !== null;
    const walkRoot: Node = root ?? body;
    const seen = new Set<string>();
    const pageKey = hashString(refresh.page.url);
    const environmentKind = refresh.environment.kind;
    const maxTargets = XRAWL_CONFIG.scan.maxTargets;

    let scanOrder = 0;
    let processedNodes = 0;
    let passTargets = 0;
    let limited = false;
    let changed = false;
    let uncommitted = false;
    let lastProgressiveCommit = startedAt;

    const iterator = iterateTextNodes(this.doc, walkRoot, this.visibility);

    try {
      for (let step = iterator.next(); !step.done; step = iterator.next()) {
        if (this.disposed) return;

        const node = step.value;
        if (!node.isConnected) continue;
        if (passTargets >= maxTargets) {
          limited = true;
          break;
        }

        const tracked = this.track(node);
        seen.add(tracked.id);
        // A pass can yield across frames; scroll may change while it runs, so
        // measure each node against its own current scroll offset.
        const nodeViewport = this.platform.viewport.read();
        const clip = this.clips.clipFor(node, nodeViewport.scroll);

        const measurement = this.measureNode(
          tracked,
          node,
          nodeViewport,
          pageKey,
          environmentKind,
          scanOrder,
          clip,
        );

        scanOrder += measurement.targets.length;
        passTargets += measurement.targets.length;
        processedNodes += 1;

        if (measurement.key !== tracked.key) {
          changed = true;
          uncommitted = true;
          tracked.text = node.data;
          tracked.segments = measurement.segments;
          tracked.sentenceIndex = measurement.sentenceIndex;
          tracked.targets = measurement.targets;
          tracked.key = measurement.key;
          this.world.upsertNode(tracked.id, measurement.targets, measurement.key);
        }

        if (processedNodes % XRAWL_CONFIG.scan.nodesPerFrame === 0) {
          await this.platform.scheduler.nextFrame();
          if (this.disposed) return;

          const now = this.platform.scheduler.now();
          if (uncommitted && now - lastProgressiveCommit >= 150) {
            this.world.setBaseStats(this.baseStats(kind, startedAt, processedNodes, limited, true, 0));
            this.world.commit();
            uncommitted = false;
            lastProgressiveCommit = now;
          }
        }
      }

      if (!scoped) {
        this.pruneUnseenNodes(seen);
        this.discoverShadowRoots();
      }

      // Reconcile viewport geometry with the scroll position after the pass.
      this.world.setViewport(this.platform.viewport.read());

      const elapsed = this.platform.scheduler.now() - startedAt;
      this.lastPassDurationMs = elapsed;
      this.world.setBaseStats(
        this.baseStats(kind, startedAt, processedNodes, limited, changed, elapsed),
      );
      this.world.commit();
      // Lazy content-visibility rendering can complete after this pass with
      // no mutation or animation to observe. Run one deferred settle pass.
      if (!scoped && !this.autoSettleUsed && this.visibility.contentVisibilityPresent) {
        this.autoSettleUsed = true;
        this.clearTimer('autoSettleTimer');
        this.autoSettleTimer = this.platform.scheduler.timeout(() => {
          this.autoSettleTimer = null;
          this.requestPass('layout', 0, null);
        }, XRAWL_CONFIG.scan.contentVisibilitySettleMs);
      }
    } finally {
      iterator.return(undefined);

      const finishedAt = this.platform.scheduler.now();
      this.lastPassFinishedAt = finishedAt;
      this.lastPassDurationMs = Math.max(this.lastPassDurationMs, finishedAt - startedAt);
      this.running = false;

      if (this.restartRequest !== null) {
        const pending = this.restartRequest;
        this.restartRequest = null;
        this.requestPass(pending.kind, this.adaptiveDelay(pending.kind), pending.root);
      }
    }
  }

  private adaptiveDelay(kind: PassKind): number {
    if (kind === 'manual') return 0;
    const spacing = Math.max(
      XRAWL_CONFIG.scan.minMutationPassSpacingMs,
      this.lastPassDurationMs * 3,
    );
    const sinceLastPass = this.platform.scheduler.now() - this.lastPassFinishedAt;
    return Math.max(0, spacing - sinceLastPass);
  }

  private baseStats(
    kind: PassKind,
    startedAt: number,
    processedNodes: number,
    limited: boolean,
    changed: boolean,
    elapsed: number,
  ): typeof EMPTY_BASE_STATS {
    return {
      passes: this.passCount,
      lastPassKind: kind,
      lastPassStartedAt: startedAt,
      lastPassDurationMs: elapsed,
      lastPassNodeCount: processedNodes,
      lastPassLimited: limited,
      lastPassChanged: changed,
      mutationBatches: this.mutationBatches,
      deferredPasses: this.deferredPasses,
      segmentation: this.segmentation.stats,
    };
  }

  private track(node: Text): TrackedNode {
    let nodeId = this.nodeIds.get(node);
    if (nodeId === undefined) {
      nodeId = `n${this.nextNodeId}`;
      this.nextNodeId += 1;
      this.nodeIds.set(node, nodeId);
    }

    let tracked = this.nodes.get(nodeId);
    if (tracked === undefined) {
      tracked = {
        id: nodeId,
        node,
        text: '',
        segments: [],
        sentenceIndex: new SentenceIndex(''),
        targets: [],
        key: '',
      };
      this.nodes.set(nodeId, tracked);
    }
    return tracked;
  }

  private measureNode(
    tracked: TrackedNode,
    node: Text,
    viewport: Viewport,
    pageKey: string,
    environmentKind: WordTarget['environment'],
    scanOrder: number,
    clip: Rect | null,
  ): Measurement {
    const text = node.data;
    const textChanged = tracked.text !== text;
    const segments = textChanged ? this.segmentation.get(text) : tracked.segments;
    const sentenceIndex = textChanged ? new SentenceIndex(text) : tracked.sentenceIndex;
    const surrounding = this.contextResolver.surrounding(node, CONTEXT_LIMITS);
    const textHash = hashString(text);

    const targets: WordTarget[] = [];
    const keyParts: Array<string | number> = [pageKey, environmentKind, textHash, surrounding];
    let localOrder = scanOrder;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const rects = this.measurer.measure(node, segment.start, segment.end, viewport.scroll, clip);
      if (rects.length === 0) continue;

      const baseVisibility = computeVisibility(rects, viewport);
      const visibility =
        baseVisibility.inViewport && this.isOccluded(node, rects, viewport)
          ? { ...baseVisibility, occluded: true }
          : baseVisibility;

      const id = `${pageKey}:${tracked.id}:${index}`;
      const context: WordContext = {
        sentence: sentenceIndex.sentenceAt(segment.start, segment.end, CONTEXT_LIMITS.sentenceMaxChars),
        surrounding,
      };

      targets.push({
        id,
        fingerprint: stableKey(pageKey, segment.normalized, textHash, index),
        text: segment.text,
        normalized: segment.normalized,
        rects,
        visibility,
        context,
        page: this.tracker.currentPage,
        environment: environmentKind,
        scanOrder: localOrder,
        source: { nodeId: tracked.id, segmentIndex: index },
      });

      localOrder += 1;
      keyParts.push(id);
      for (const rect of rects) {
        keyParts.push(
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        );
      }
    }

    return {
      targets,
      key: stableKey(...keyParts),
      segments,
      sentenceIndex,
    };
  }

  /**
   * A word whose center point is not covered by its own subtree is hidden
   * behind a later-painted element (dialog, overlay panel, stacked card), so
   * outlining it would draw a box over unrelated content.
   */
  /**
   * Shadow roots are invisible to the document-level MutationObserver, so
   * observe every open root and recurse into nested hosts.
   */
  private discoverShadowRoots(): void {
    const observer = this.observer;
    if (observer === null) return;

    const observeTree = (root: Document | ShadowRoot): void => {
      for (const element of root.querySelectorAll('*')) {
        const shadow = element.shadowRoot;
        if (shadow === null) continue;
        if (!this.observedShadowRoots.has(shadow)) {
          this.observedShadowRoots.add(shadow);
          observer.observe(shadow, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: [...XRAWL_CONFIG.scan.mutationAttributeFilter],
          });
        }
        observeTree(shadow);
      }
    };

    observeTree(this.doc);
  }

  private composedParent(element: Element): Element | null {
    if (element.parentElement !== null) return element.parentElement;
    const root = element.getRootNode();
    return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
      ? (root as ShadowRoot).host
      : null;
  }

  private isComposedRelated(top: Element, parent: Element): boolean {
    if (top === parent || parent.contains(top) || top.contains(parent)) return true;

    let current: Element | null = parent;
    let depth = 0;
    while (current !== null && depth < 64) {
      if (current === top) return true;
      current = this.composedParent(current);
      depth += 1;
    }
    return false;
  }

  private isOccluded(node: Text, rects: readonly Rect[], viewport: Viewport): boolean {
    const parent = node.parentElement;
    if (!parent) return false;
    const view = this.doc.defaultView;
    if (!view) return false;
    // Text that ignores pointer events (common for image overlays) cannot be
    // hit-tested reliably; do not hide it based on a false negative.
    if (view.getComputedStyle(parent).pointerEvents === 'none') return false;

    for (const rect of rects) {
      const viewportRect = toViewportRect(rect, viewport.scroll);
      const x = viewportRect.x + viewportRect.width / 2;
      const y = viewportRect.y + viewportRect.height / 2;
      if (x < 0 || y < 0 || x >= viewport.size.width || y >= viewport.size.height) continue;

      const stack = this.doc.elementsFromPoint(x, y);
      const top = stack[0];
      if (top === undefined) continue;
      if (this.isComposedRelated(top, parent)) return false;
      // Semi-transparent backdrops still show the text; only a solid cover
      // should hide the word.
      if (this.isOpaqueCover(top)) return true;
    }

    return false;
  }

  private isOpaqueCover(element: Element): boolean {
    const view = this.doc.defaultView;
    if (!view) return false;

    if (element.tagName === 'IMG' || element.tagName === 'VIDEO' || element.tagName === 'PICTURE') {
      return true;
    }

    const style = view.getComputedStyle(element);
    if (Number(style.opacity) < 0.9) return false;
    if (style.backgroundImage !== 'none') return true;

    const color = style.backgroundColor;
    if (color === 'transparent') return false;
    if (color.startsWith('rgba')) {
      const alpha = Number(color.split(',')[3]?.replace(')', '').trim());
      return Number.isFinite(alpha) && alpha >= 0.9;
    }

    return color.startsWith('rgb');
  }

  private pruneUnseenNodes(seen: ReadonlySet<string>): void {
    for (const [nodeId, tracked] of [...this.nodes]) {
      if (seen.has(nodeId)) continue;
      this.nodes.delete(nodeId);
      this.nodeIds.delete(tracked.node);
      this.world.removeNode(nodeId);
    }
  }

  private isOverlayNode(node: Node): boolean {
    const element =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return element !== null && element.closest(`[${XRAWL_CONFIG.overlayAttribute}]`) !== null;
  }

  private clearTimer(
    field:
      | 'pendingTimer'
      | 'resizeTimer'
      | 'scopedTimer'
      | 'scrollRescanTimer'
      | 'scrollValidateTimer'
      | 'autoSettleTimer',
  ): void {
    const handle = this[field];
    if (handle !== null) {
      this.platform.scheduler.clearTimeout(handle);
      this[field] = null;
    }
  }
}
