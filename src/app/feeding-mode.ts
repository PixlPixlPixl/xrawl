/**
 * Manual feeding selection mode.
 *
 * A modal pick: while active, clicks feed a word instead of reaching the page.
 * That is the whole reason this exists as a *mode* - the creature must never
 * hijack links, buttons or text selection during normal browsing, so feeding is
 * only possible when the user has explicitly asked for it.
 *
 * The hit test uses the already-measured geometry (`creature/targets.ts`), never
 * the DOM: perception is the single source of truth for what a word is, and a
 * second, ad-hoc lookup here could disagree with the outlines the user sees.
 */
import type { Rect } from '@/shared/types/geometry';

export interface FeedingCandidate {
  readonly id: string;
  readonly word: string;
  /** Document-space rects of the word, for the highlight box. */
  readonly rects: readonly Rect[];
}

export interface FeedingModeOptions {
  readonly document: Document;
  readonly window: Window;
  /** Which word is under a document-space point, if any. */
  readonly resolve: (point: { x: number; y: number }) => FeedingCandidate | null;
  /**
   * Hand the word to the creature. Return `false` when it cannot be taken
   * (the word left the page), so the user is told instead of the click
   * disappearing into nothing.
   */
  readonly onFeed: (candidate: FeedingCandidate) => boolean;
  readonly onChange?: (active: boolean) => void;
}

const HIGHLIGHT_STYLE =
  'position:absolute;pointer-events:none;border:1px solid rgba(95,168,255,0.9);' +
  'border-radius:3px;background:rgba(95,168,255,0.12);box-shadow:0 0 0 1px rgba(95,168,255,0.35);' +
  'z-index:2147483646;display:none;transition:left 60ms linear,top 60ms linear,' +
  'width 60ms linear,height 60ms linear;';

export class FeedingMode {
  private readonly options: FeedingModeOptions;
  private readonly highlight: HTMLElement;
  private isActive = false;
  private previousCursor = '';
  private rejectTimer: number | null = null;

  constructor(options: FeedingModeOptions) {
    this.options = options;

    const highlight = options.document.createElement('div');
    highlight.setAttribute('data-xrawl-overlay', 'true');
    highlight.setAttribute('aria-hidden', 'true');
    highlight.style.cssText = HIGHLIGHT_STYLE;
    options.document.documentElement.appendChild(highlight);
    this.highlight = highlight;

    options.window.addEventListener('pointermove', this.onPointerMove, { passive: true, capture: true });
    options.window.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    options.window.addEventListener('click', this.onClick, { capture: true });
    options.window.addEventListener('keydown', this.onKeyDown, { capture: true });
  }

  get active(): boolean {
    return this.isActive;
  }

  setActive(active: boolean): void {
    if (this.isActive === active) return;
    this.isActive = active;
    if (!active) {
      this.clearRejection();
      this.hideHighlight();
      this.options.document.documentElement.style.cursor = this.previousCursor;
    } else {
      this.previousCursor = this.options.document.documentElement.style.cursor;
      this.options.document.documentElement.style.cursor = 'crosshair';
    }
    this.options.onChange?.(active);
  }

  destroy(): void {
    this.setActive(false);
    this.clearRejection();
    this.highlight.remove();
    const window = this.options.window;
    window.removeEventListener('pointermove', this.onPointerMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointerdown', this.onPointerDown, { capture: true } as EventListenerOptions);
    window.removeEventListener('click', this.onClick, { capture: true } as EventListenerOptions);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true } as EventListenerOptions);
  }

  private pointOf(event: MouseEvent): { x: number; y: number } {
    const view = this.options.window;
    return { x: event.clientX + view.scrollX, y: event.clientY + view.scrollY };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.isActive) return;
    const point = this.pointOf(event);
    const candidate = this.options.resolve(point);
    if (candidate === null) {
      this.hideHighlight();
      return;
    }
    this.positionHighlight(candidate.rects);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.isActive) return;
    // Swallow the press so a link never sees a mousedown it did not earn.
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.isActive) return;
    event.preventDefault();
    event.stopPropagation();

    const candidate = this.options.resolve(this.pointOf(event));
    if (candidate === null) return;

    // The word was measured a moment ago; if the creature refused it, say so
    // instead of letting the click look like a no-op.
    if (!this.options.onFeed(candidate)) {
      this.positionHighlight(candidate.rects);
      this.flashUnavailable();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isActive || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.setActive(false);
  };

  private positionHighlight(rects: FeedingCandidate['rects']): void {
    if (rects.length === 0) {
      this.hideHighlight();
      return;
    }

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }

    this.highlight.style.left = `${left}px`;
    this.highlight.style.top = `${top}px`;
    this.highlight.style.width = `${right - left}px`;
    this.highlight.style.height = `${bottom - top}px`;
    this.highlight.style.display = 'block';
  }

  /** Red flash: the word under the pointer could not be fed. */
  private flashUnavailable(): void {
    this.highlight.style.borderColor = 'rgba(255,110,110,0.95)';
    this.highlight.style.background = 'rgba(255,110,110,0.14)';
    if (this.rejectTimer !== null) this.options.window.clearTimeout(this.rejectTimer);
    this.rejectTimer = this.options.window.setTimeout(() => {
      this.rejectTimer = null;
      this.clearRejection();
    }, 320);
  }

  private clearRejection(): void {
    if (this.rejectTimer !== null) {
      this.options.window.clearTimeout(this.rejectTimer);
      this.rejectTimer = null;
    }
    this.highlight.style.borderColor = '';
    this.highlight.style.background = '';
  }

  private hideHighlight(): void {
    this.highlight.style.display = 'none';
  }
}
