/**
 * Debug overlay: outlines every discovered word, shows a stats HUD, and
 * reveals target details on hover.
 *
 * Rendering is a single canvas (one draw call per frame regardless of word
 * count) plus two small DOM elements. All elements are tagged with
 * `data-xrawl-overlay`; the scanner rejects that subtree, and mutation
 * records originating inside it are ignored so hovering never triggers a
 * re-measurement.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import type { EnvironmentClassification, PageInfo } from '@/shared/types/page';
import { containsPoint, toViewportRect, type Rect, type ScrollOffset } from '@/shared/types/geometry';
import type { ScanStats, WorldSnapshot, WordTarget } from '@/shared/types/word-target';
import type { SnapshotReason } from '@/world/world-state';

const ATTRIBUTE = XRAWL_CONFIG.overlayAttribute;
const Z_INDEX = '2147483646';

interface OverlayState {
  readonly targets: readonly WordTarget[];
  readonly stats: ScanStats;
  readonly environment: EnvironmentClassification;
  readonly page: PageInfo;
}

interface HitCell {
  readonly size: number;
  readonly cells: Map<string, number[]>;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function hueFor(word: string): number {
  let hash = 0;
  for (let index = 0; index < word.length; index += 1) {
    hash = (hash * 31 + word.charCodeAt(index)) % 360;
  }
  return hash;
}

export class DebugOverlay {
  private readonly doc: Document;
  private readonly win: Window;

  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private hud: HTMLElement | null = null;
  private tooltip: HTMLElement | null = null;

  private state: OverlayState | null = null;
  private scroll: ScrollOffset = { x: 0, y: 0 };
  private grid: HitCell = { size: XRAWL_CONFIG.overlay.hitTestCellPx, cells: new Map() };

  private pointer: { x: number; y: number } | null = null;
  private hoveredId: string | null = null;
  private renderHandle: number | null = null;
  private visible = false;
  private mounted = false;
  private readonly disposers: Array<() => void> = [];

  constructor(doc: Document, win: Window) {
    this.doc = doc;
    this.win = win;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const canvas = this.doc.createElement('canvas');
    canvas.setAttribute(ATTRIBUTE, 'canvas');
    canvas.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      `z-index:${Z_INDEX}`,
      'display:none',
    ].join(';');
    this.doc.documentElement.appendChild(canvas);
    this.canvas = canvas;
    this.context = canvas.getContext('2d');

    const hud = this.doc.createElement('div');
    hud.setAttribute(ATTRIBUTE, 'hud');
    hud.style.cssText = [
      'position:fixed',
      'top:10px',
      'right:10px',
      `z-index:${Z_INDEX}`,
      'pointer-events:none',
      'display:none',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#d7e6ff',
      'background:rgba(10,13,18,0.86)',
      'border:1px solid rgba(120,170,255,0.28)',
      'border-radius:7px',
      'padding:7px 10px',
      'white-space:pre',
      'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
    ].join(';');
    this.doc.documentElement.appendChild(hud);
    this.hud = hud;

    const tooltip = this.doc.createElement('div');
    tooltip.setAttribute(ATTRIBUTE, 'tooltip');
    tooltip.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      `z-index:${Z_INDEX + 1}`,
      'pointer-events:none',
      'display:none',
      'max-width:380px',
      'font:12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#eaf2ff',
      'background:rgba(12,15,21,0.95)',
      'border:1px solid rgba(120,170,255,0.4)',
      'border-radius:8px',
      'padding:9px 11px',
      'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
    ].join(';');
    this.doc.documentElement.appendChild(tooltip);
    this.tooltip = tooltip;

    const onPointerMove = (event: PointerEvent) => this.handlePointerMove(event);
    const onPointerLeave = () => this.handlePointerLeave();
    const onScroll = () => this.handleScroll();
    const onResize = () => this.render();

    this.win.addEventListener('pointermove', onPointerMove, { passive: true });
    this.win.addEventListener('pointerleave', onPointerLeave, { passive: true });
    this.win.addEventListener('scroll', onScroll, { passive: true });
    this.win.addEventListener('resize', onResize, { passive: true });
    this.doc.addEventListener('visibilitychange', onResize);

    this.disposers.push(() => this.win.removeEventListener('pointermove', onPointerMove));
    this.disposers.push(() => this.win.removeEventListener('pointerleave', onPointerLeave));
    this.disposers.push(() => this.win.removeEventListener('scroll', onScroll));
    this.disposers.push(() => this.win.removeEventListener('resize', onResize));
    this.disposers.push(() => this.doc.removeEventListener('visibilitychange', onResize));

    this.scroll = { x: this.win.scrollX, y: this.win.scrollY };
    this.visible = true;
    this.setVisible(true);
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    if (this.renderHandle !== null) {
      this.win.cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
    this.canvas?.remove();
    this.hud?.remove();
    this.tooltip?.remove();
    this.canvas = null;
    this.context = null;
    this.hud = null;
    this.tooltip = null;
    this.mounted = false;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.canvas) this.canvas.style.display = visible ? 'block' : 'none';
    if (this.hud) this.hud.style.display = visible ? 'block' : 'none';
    if (this.tooltip && !visible) this.tooltip.style.display = 'none';
    this.hoveredId = null;
    if (visible) this.scheduleRender();
  }

  /** Feed a new world snapshot. Scroll updates skip the spatial-index rebuild. */
  syncSnapshot(snapshot: WorldSnapshot, reason: SnapshotReason): void {
    this.state = {
      targets: snapshot.targets,
      stats: snapshot.stats,
      environment: snapshot.environment,
      page: snapshot.page,
    };
    this.scroll = snapshot.viewport.scroll;

    if (reason !== 'scroll') this.rebuildGrid();

    this.updateHud();
    this.scheduleRender();
  }

  render(): void {
    if (!this.mounted || !this.canvas || !this.context) return;

    const dpr = this.win.devicePixelRatio || 1;
    const width = this.win.innerWidth;
    const height = this.win.innerHeight;

    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }

    const context = this.context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    if (!this.visible) return;

    const state = this.state;
    if (!state) return;

    const margin = XRAWL_CONFIG.overlay.cullMarginPx;
    const hovered = this.findHoveredTarget();

    for (const target of state.targets) {
      if (!target.visibility.rendered) continue;

      const isHovered = hovered !== null && hovered.id === target.id;
      const hue = hueFor(target.normalized);
      const alpha = isHovered
        ? XRAWL_CONFIG.overlay.hoveredStrokeAlpha
        : XRAWL_CONFIG.overlay.strokeAlpha * Math.max(0.35, target.visibility.viewportRatio);
      context.strokeStyle = isHovered ? `hsla(${hue}, 95%, 72%, 0.98)` : `hsla(${hue}, 78%, 58%, ${alpha})`;
      context.lineWidth = isHovered ? 2 : 1;

      for (const rect of target.rects) {
        const viewportRect = toViewportRect(rect, this.scroll);
        if (
          viewportRect.x > width + margin ||
          viewportRect.y > height + margin ||
          viewportRect.x + viewportRect.width < -margin ||
          viewportRect.y + viewportRect.height < -margin
        ) {
          continue;
        }

        if (isHovered) {
          context.fillStyle = `hsla(${hue}, 95%, 65%, 0.22)`;
          context.fillRect(viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height);
        }

        this.strokeRect(context, viewportRect);
      }
    }
  }

  private strokeRect(context: CanvasRenderingContext2D, rect: Rect): void {
    const x = Math.round(rect.x) + 0.5;
    const y = Math.round(rect.y) + 0.5;
    const w = Math.max(1, Math.round(rect.width) - 1);
    const h = Math.max(1, Math.round(rect.height) - 1);
    context.strokeRect(x, y, w, h);
  }

  private scheduleRender(): void {
    if (this.renderHandle !== null) return;
    if (!this.visible) return;
    this.renderHandle = this.win.requestAnimationFrame(() => {
      this.renderHandle = null;
      this.render();
    });
  }

  private handleScroll(): void {
    this.scroll = { x: this.win.scrollX, y: this.win.scrollY };
    this.scheduleRender();
  }

  private handlePointerMove(event: PointerEvent): void {
    this.pointer = { x: event.clientX, y: event.clientY };
    if (this.visible) this.scheduleRender();
  }

  private handlePointerLeave(): void {
    this.pointer = null;
    this.hoveredId = null;
    if (this.tooltip) this.tooltip.style.display = 'none';
    this.scheduleRender();
  }

  private findHoveredTarget(): WordTarget | null {
    const state = this.state;
    const pointer = this.pointer;
    if (!state || !pointer) {
      this.updateHover(null);
      return null;
    }

    const docX = pointer.x + this.scroll.x;
    const docY = pointer.y + this.scroll.y;
    const candidates = this.grid.cells.get(
      cellKey(Math.floor(docX / this.grid.size), Math.floor(docY / this.grid.size)),
    );

    let best: WordTarget | null = null;
    let bestArea = Infinity;

    if (candidates) {
      for (const index of candidates) {
        const target = state.targets[index];
        if (!target) continue;

        for (const rect of target.rects) {
          if (!containsPoint(rect, docX, docY)) continue;
          const area = rect.width * rect.height;
          if (area < bestArea) {
            bestArea = area;
            best = target;
          }
        }
      }
    }

    this.updateHover(best);
    return best;
  }

  private updateHover(target: WordTarget | null): void {
    const tooltip = this.tooltip;
    if (!tooltip || !this.pointer) return;

    if (target === null) {
      this.hoveredId = null;
      tooltip.style.display = 'none';
      return;
    }

    if (this.hoveredId !== target.id) {
      this.hoveredId = target.id;
      this.fillTooltip(target);
    }

    tooltip.style.display = 'block';
    const offset = XRAWL_CONFIG.overlay.tooltipOffsetPx;
    const tooltipWidth = tooltip.offsetWidth || 360;
    const tooltipHeight = tooltip.offsetHeight || 120;
    let x = this.pointer.x + offset;
    let y = this.pointer.y + offset;

    if (x + tooltipWidth > this.win.innerWidth - 8) x = this.pointer.x - offset - tooltipWidth;
    if (y + tooltipHeight > this.win.innerHeight - 8) y = this.pointer.y - offset - tooltipHeight;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private fillTooltip(target: WordTarget): void {
    const tooltip = this.tooltip;
    if (!tooltip) return;

    tooltip.replaceChildren();

    const title = this.doc.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:650;letter-spacing:-0.01em;margin-bottom:2px';
    title.textContent = target.text;
    tooltip.appendChild(title);

    if (target.normalized !== target.text.toLowerCase()) {
      const normalized = this.doc.createElement('div');
      normalized.style.cssText = 'color:#9fc2ff;font-size:11px;margin-bottom:5px';
      normalized.textContent = `normalized: ${target.normalized}`;
      tooltip.appendChild(normalized);
    }

    const meta = this.doc.createElement('div');
    meta.style.cssText = 'color:#9db4d4;font-size:11px;margin-bottom:5px';
    meta.textContent = [
      `${target.rects.length} rect${target.rects.length === 1 ? '' : 's'}`,
      `${Math.round(target.visibility.viewportRatio * 100)}% in view`,
      target.environment,
    ].join(' \u00b7 ');
    tooltip.appendChild(meta);

    const sentence = this.doc.createElement('div');
    sentence.style.cssText = 'color:#dbe8ff;margin-bottom:5px';
    sentence.textContent = target.context.sentence;
    tooltip.appendChild(sentence);

    const surrounding = this.doc.createElement('div');
    surrounding.style.cssText = 'color:#8fa4c2;font-size:11px;margin-bottom:6px';
    surrounding.textContent = target.context.surrounding;
    tooltip.appendChild(surrounding);

    const footer = this.doc.createElement('div');
    footer.style.cssText =
      'color:#6f86a6;font-size:10px;border-top:1px solid rgba(120,170,255,0.18);padding-top:5px';
    footer.textContent = `${target.id} \u00b7 ${this.state?.page.url ?? target.page.url}`;
    tooltip.appendChild(footer);
  }

  private rebuildGrid(): void {
    const state = this.state;
    if (!state) return;

    const size = XRAWL_CONFIG.overlay.hitTestCellPx;
    const cells = new Map<string, number[]>();

    for (let index = 0; index < state.targets.length; index += 1) {
      const target = state.targets[index];
      for (const rect of target.rects) {
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.width) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.height) / size);

        // The rect of a huge word could cover thousands of cells; that is
        // pathological enough to cap rather than index.
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) continue;

        for (let cx = x0; cx <= x1; cx += 1) {
          for (let cy = y0; cy <= y1; cy += 1) {
            const key = cellKey(cx, cy);
            const bucket = cells.get(key);
            if (bucket) bucket.push(index);
            else cells.set(key, [index]);
          }
        }
      }
    }

    this.grid = { size, cells };
  }

  private updateHud(): void {
    const hud = this.hud;
    const state = this.state;
    if (!hud || !state) return;

    const stats = state.stats;
    const lines = [
      `xrawl \u00b7 ${stats.targetCount} words`,
      `${stats.visibleInViewport} in view \u00b7 ${stats.uniqueWordCount} unique`,
      `${Math.round(stats.lastPassDurationMs)}ms ${stats.lastPassKind} pass \u00b7 ${state.environment.kind}`,
    ];
    if (stats.lastPassLimited) lines.push('target cap reached');
    hud.textContent = lines.join('\n');
  }
}
