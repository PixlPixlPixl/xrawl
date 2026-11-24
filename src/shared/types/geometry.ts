/**
 * Geometry primitives shared by every layer.
 *
 * Deliberately DOM-free: the world engine and platform adapters convert
 * browser geometry (`DOMRect`, viewport coordinates) into these plain
 * records before anything else sees them. A desktop host can produce the
 * same records from its own accessibility/layout APIs.
 *
 * Coordinate spaces used throughout Xrawl:
 *  - **document space** — origin at the document's top-left. Stable while
 *    scrolling; this is what word targets store.
 *  - **viewport space** — origin at the visible viewport's top-left.
 *    Derived from document space by subtracting the current scroll offset.
 *
 * All functions here are pure; nothing in this module touches the DOM.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScrollOffset {
  readonly x: number;
  readonly y: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly scroll: ScrollOffset;
  readonly size: ViewportSize;
}

/**
 * A word's rendered/on-screen state. "Rendered" means the word produced
 * layout boxes; CSS-hidden words never become targets. `viewportRatio` is
 * pure geometry and can be refreshed on scroll without touching the DOM.
 */
export interface Visibility {
  readonly rendered: boolean;
  readonly inViewport: boolean;
  readonly viewportRatio: number;
}

export const ORIGIN: ScrollOffset = Object.freeze({ x: 0, y: 0 });

export function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function toViewportRect(rect: Rect, scroll: ScrollOffset): Rect {
  return { x: rect.x - scroll.x, y: rect.y - scroll.y, width: rect.width, height: rect.height };
}

export function toDocumentRect(rect: Rect, scroll: ScrollOffset): Rect {
  return { x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height };
}

/** The viewport as a rect expressed in document space. */
export function viewportClip(viewport: Viewport): Rect {
  return {
    x: viewport.scroll.x,
    y: viewport.scroll.y,
    width: viewport.size.width,
    height: viewport.size.height,
  };
}

export function roundRect(rect: Rect, precision = 1): Rect {
  const round = (value: number) => Math.round(value / precision) * precision;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

export function computeVisibility(rects: readonly Rect[], viewport: Viewport): Visibility {
  if (rects.length === 0) {
    return { rendered: false, inViewport: false, viewportRatio: 0 };
  }

  const clip = viewportClip(viewport);
  let totalArea = 0;
  let visibleArea = 0;

  for (const rect of rects) {
    totalArea += area(rect);
    const overlap = intersectRects(rect, clip);
    if (overlap) visibleArea += area(overlap);
  }

  return {
    rendered: true,
    inViewport: visibleArea > 0,
    viewportRatio: totalArea > 0 ? Math.min(1, visibleArea / totalArea) : 0,
  };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Merge fragments that came from the same rendered word.
 *
 * `Range.getClientRects()` splits a single word whenever it crosses inline
 * element boundaries (e.g. `<em>foo</em>bar`) or weird glyph/layout cases,
 * producing several boxes. Adjacent fragments on the same line are collapsed
 * into one rect so the debug overlay draws one outline per rendered word run.
 */
export function coalesceRects(input: Rect[], maxRects = 32): Rect[] {
  const rects = input
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({ ...rect }))
    .slice(0, maxRects);

  if (rects.length < 2) return rects;

  const gapTolerance = 1.5;
  let merged = true;
  let guard = 0;

  while (merged && guard < 6) {
    merged = false;
    guard += 1;

    outer: for (let i = 0; i < rects.length; i += 1) {
      const a = rects[i];
      for (let j = i + 1; j < rects.length; j += 1) {
        const b = rects[j];
        const verticalOverlap =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        const minHeight = Math.min(a.height, b.height);
        const horizontalGap =
          Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);

        if (verticalOverlap >= minHeight * 0.7 && horizontalGap <= gapTolerance) {
          rects[i] = unionRect(a, b);
          rects.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return rects;
}
