/**
 * DOM geometry → plain document-space rects.
 *
 * `Range.getClientRects()` returns fragments in viewport coordinates. We
 * translate immediately into document coordinates so a word's geometry is
 * stable while scrolling; the overlay derives viewport rects on demand.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import {
  coalesceRects,
  intersectRects,
  type Rect,
  type ScrollOffset,
} from '@/shared/types/geometry';

const MAX_RECTS_PER_WORD = 32;

/**
 * Reusable Range measurer. Creating one Range per word would allocate tens of
 * thousands of objects per pass on a large article; this reuses a single Range.
 */
export class RangeMeasurer {
  private readonly range: Range;

  constructor(document: Document) {
    this.range = document.createRange();
  }

  measure(node: Text, start: number, end: number, scroll: ScrollOffset, clip: Rect | null): Rect[] {
    try {
      this.range.setStart(node, start);
      this.range.setEnd(node, end);
    } catch {
      // Node was detached mid-pass; the next pass will pick up its replacement.
      return [];
    }

    const clientRects = this.range.getClientRects();
    const rects: Rect[] = [];
    const minSide = XRAWL_CONFIG.scan.minPaintedSidePx;

    for (const clientRect of clientRects) {
      if (clientRect.width <= 0 || clientRect.height <= 0) continue;

      const rect: Rect = {
        x: clientRect.left + scroll.x,
        y: clientRect.top + scroll.y,
        width: clientRect.width,
        height: clientRect.height,
      };

      if (clip !== null) {
        const clipped = intersectRects(rect, clip);
        if (clipped === null) continue;
        if (clipped.width < minSide || clipped.height < minSide) continue;
        rects.push(clipped);
      } else if (rect.width >= minSide && rect.height >= minSide) {
        rects.push(rect);
      }
    }

    return coalesceRects(rects, MAX_RECTS_PER_WORD);
  }

  dispose(): void {
    this.range.detach();
  }
}
