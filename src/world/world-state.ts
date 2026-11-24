/**
 * World state — the single mutable store of discovered words.
 *
 * Both the perception engine (writes targets) and the UI/messaging layers
 * (read snapshots) talk to this object. It has no DOM dependency: targets
 * arrive as plain data with document-space rects, so a desktop host can
 * populate exactly the same model.
 */
import type { Viewport } from '@/shared/types/geometry';
import { computeVisibility } from '@/shared/types/geometry';
import type { EnvironmentClassification, PageInfo } from '@/shared/types/page';
import type {
  BaseScanStats,
  ScanStats,
  WordCount,
  WorldSnapshot,
  WordTarget,
} from '@/shared/types/word-target';
import { EMPTY_BASE_STATS } from '@/shared/types/word-target';

export type SnapshotReason = 'layout' | 'scroll' | 'stats';
export type SnapshotListener = (snapshot: WorldSnapshot, reason: SnapshotReason) => void;

const TOP_WORDS_LIMIT = 20;
const EMPTY_ENVIRONMENT: EnvironmentClassification = {
  kind: 'unknown',
  confidence: 0,
  reasons: [],
};

export class WorldState {
  private readonly nodeTargets = new Map<string, readonly WordTarget[]>();
  private readonly nodeKeys = new Map<string, string>();
  private readonly listeners = new Set<SnapshotListener>();

  private page: PageInfo = { url: '', title: '' };
  private environment: EnvironmentClassification = EMPTY_ENVIRONMENT;
  private viewport: Viewport = { scroll: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
  private baseStats: BaseScanStats = EMPTY_BASE_STATS;

  private structureDirty = false;
  private statsDirty = false;
  private vocabDirty = false;
  private targetsCache: WordTarget[] | null = null;
  private snapshotCache: WorldSnapshot | null = null;
  private revision = 0;
  private visibleInViewport = 0;
  private vocabulary = { uniqueWordCount: 0, topWords: [] as readonly WordCount[] };

  /**
   * Insert or replace the targets owned by one text node. `key` is the
   * scanner's layout fingerprint; an identical key means no structural
   * change, so repeated passes over unchanged text are free.
   */
  upsertNode(nodeId: string, targets: readonly WordTarget[], key: string): boolean {
    if (this.nodeKeys.get(nodeId) === key) return false;

    if (targets.length === 0) return this.removeNode(nodeId);

    this.nodeKeys.set(nodeId, key);
    this.nodeTargets.set(nodeId, targets);
    this.markStructural();
    return true;
  }

  removeNode(nodeId: string): boolean {
    if (!this.nodeTargets.delete(nodeId)) return false;
    this.nodeKeys.delete(nodeId);
    this.markStructural();
    return true;
  }

  setPage(page: PageInfo): boolean {
    if (this.page.url === page.url && this.page.title === page.title) return false;
    this.page = page;
    this.markStructural();
    return true;
  }

  setEnvironment(environment: EnvironmentClassification): boolean {
    if (
      this.environment.kind === environment.kind &&
      this.environment.confidence === environment.confidence
    ) {
      return false;
    }
    this.environment = environment;
    this.markStructural();
    return true;
  }

  /**
   * Update the viewport and re-derive visibility from cached document-space
   * rects. This is the scroll path: no DOM reads and no re-measurement.
   */
  setViewport(viewport: Viewport): boolean {
    const previous = this.viewport;
    if (
      previous.scroll.x === viewport.scroll.x &&
      previous.scroll.y === viewport.scroll.y &&
      previous.size.width === viewport.size.width &&
      previous.size.height === viewport.size.height
    ) {
      return false;
    }

    this.viewport = viewport;
    this.recomputeVisibility();

    if (this.snapshotCache) {
      this.snapshotCache = {
        ...this.snapshotCache,
        viewport,
        stats: { ...this.snapshotCache.stats, visibleInViewport: this.visibleInViewport },
      };
    }

    this.emit(this.snapshotCache ?? this.getSnapshot(), 'scroll');
    return true;
  }

  setBaseStats(stats: BaseScanStats): void {
    this.baseStats = stats;
    this.statsDirty = true;
  }

  /** Publish accumulated changes if any. Returns true when listeners ran. */
  commit(): boolean {
    if (!this.structureDirty && !this.statsDirty) return false;

    if (this.structureDirty) {
      this.structureDirty = false;
      this.revision += 1;
      this.targetsCache = null;
      this.snapshotCache = null;
      if (this.vocabDirty) {
        this.rebuildVocabulary();
        this.vocabDirty = false;
      }
      this.statsDirty = false;
      const snapshot = this.getSnapshot();
      this.emit(snapshot, 'layout');
      return true;
    }

    this.statsDirty = false;
    this.snapshotCache = this.snapshotCache
      ? { ...this.snapshotCache, stats: this.buildStats() }
      : this.getSnapshot();
    this.emit(this.snapshotCache ?? this.getSnapshot(), 'stats');
    return true;
  }

  getSnapshot(): WorldSnapshot {
    if (this.snapshotCache) return this.snapshotCache;

    const targets = this.buildTargets();
    this.statsDirty = false;
    const snapshot: WorldSnapshot = {
      revision: this.revision,
      page: this.page,
      environment: this.environment,
      viewport: this.viewport,
      targets,
      stats: this.buildStats(targets),
      capturedAt: Date.now(),
    };
    this.snapshotCache = snapshot;
    return snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private markStructural(): void {
    this.structureDirty = true;
    this.statsDirty = true;
    this.vocabDirty = true;
  }

  private recomputeVisibility(): void {
    let visible = 0;
    for (const targets of this.nodeTargets.values()) {
      for (const target of targets) {
        target.visibility = computeVisibility(target.rects, this.viewport);
        if (target.visibility.inViewport) visible += 1;
      }
    }
    this.visibleInViewport = visible;
  }

  private buildTargets(): WordTarget[] {
    if (this.targetsCache) return this.targetsCache;
    const targets: WordTarget[] = [];
    for (const nodeTargetSet of this.nodeTargets.values()) {
      for (const target of nodeTargetSet) targets.push(target);
    }
    targets.sort((a, b) => {
      const orderDelta = a.scanOrder - b.scanOrder;
      if (orderDelta !== 0) return orderDelta;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    this.targetsCache = targets;
    return targets;
  }

  private buildStats(targets: readonly WordTarget[] = this.buildTargets()): ScanStats {
    let rectCount = 0;
    let visibleInViewport = 0;
    for (const target of targets) {
      rectCount += target.rects.length;
      if (target.visibility.inViewport) visibleInViewport += 1;
    }
    this.visibleInViewport = visibleInViewport;

    return {
      ...this.baseStats,
      targetCount: targets.length,
      textNodeCount: this.countNodesWithTargets(),
      rectCount,
      visibleInViewport,
      uniqueWordCount: this.vocabulary.uniqueWordCount,
      topWords: this.vocabulary.topWords,
    };
  }

  private countNodesWithTargets(): number {
    let count = 0;
    for (const targets of this.nodeTargets.values()) {
      if (targets.length > 0) count += 1;
    }
    return count;
  }

  private rebuildVocabulary(): void {
    const counts = new Map<string, number>();
    for (const targets of this.nodeTargets.values()) {
      for (const target of targets) {
        counts.set(target.normalized, (counts.get(target.normalized) ?? 0) + 1);
      }
    }

    const topWords = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_WORDS_LIMIT)
      .map(([word, count]) => ({ word, count }));

    this.vocabulary = { uniqueWordCount: counts.size, topWords };
  }

  private emit(snapshot: WorldSnapshot, reason: SnapshotReason): void {
    for (const listener of this.listeners) listener(snapshot, reason);
  }
}
