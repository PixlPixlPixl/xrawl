/**
 * Overflow clipping for word geometry.
 *
 * `Range.getClientRects()` reports layout boxes, not paint bounds: text inside
 * `overflow: hidden/auto/scroll` (carousels, horizontally clipped strips) still
 * produces rects beyond the visible area. Without this step the debug overlay
 * paints outlines for content the user cannot see, over unrelated text.
 *
 * Clip boxes are cached per parent element for one pass; resets are tied to the
 * same layout generation as the rest of perception.
 */
import { intersectRects, type Rect, type ScrollOffset } from '@/shared/types/geometry';

const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'scroll', 'auto']);
const EMPTY_CLIP: Rect = { x: 0, y: 0, width: 0, height: 0 };

function composedParent(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : null;
}

export class ClipResolver {
  private readonly doc: Document;
  private cache = new WeakMap<Element, Rect | null>();

  constructor(doc: Document) {
    this.doc = doc;
  }

  reset(): void {
    this.cache = new WeakMap();
  }

  clipFor(node: Text, scroll: ScrollOffset): Rect | null {
    const parent = node.parentElement;
    if (!parent) return null;
    return this.clipForElement(parent, scroll);
  }

  private clipForElement(element: Element, scroll: ScrollOffset): Rect | null {
    const cached = this.cache.get(element);
    if (cached !== undefined) return cached;

    const ownClip = this.ownClipRect(element, scroll);
    const parent = composedParent(element);
    let clip = ownClip;

    if (parent && parent !== this.doc.documentElement) {
      const parentClip = this.clipForElement(parent, scroll);
      if (parentClip !== null) {
        clip = clip === null ? parentClip : (intersectRects(clip, parentClip) ?? EMPTY_CLIP);
      }
    }

    this.cache.set(element, clip);
    return clip;
  }

  private ownClipRect(element: Element, scroll: ScrollOffset): Rect | null {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return null;
    // No box means no overflow/clip-path of its own; ancestors still apply.
    if (style.display === 'contents') return null;

    const box = element.getBoundingClientRect();
    const clips: Rect[] = [];
    const toDocRect = (left: number, top: number, width: number, height: number): Rect => ({
      x: box.left + scroll.x + left,
      y: box.top + scroll.y + top,
      width,
      height,
    });

    const clipsX = CLIPPING_OVERFLOW.has(style.overflowX);
    const clipsY = CLIPPING_OVERFLOW.has(style.overflowY);
    if (clipsX || clipsY || style.contain.includes('paint')) {
      clips.push(toDocRect(0, 0, box.width, box.height));
    }

    const legacy = this.legacyClipRect(style, box);
    if (legacy !== null) clips.push(toDocRect(legacy.left, legacy.top, legacy.width, legacy.height));

    const shape = this.clipPathRect(style.clipPath, box);
    if (shape !== null) clips.push(toDocRect(shape.left, shape.top, shape.width, shape.height));

    if (clips.length === 0) return null;

    let clip = clips[0];
    for (let index = 1; index < clips.length; index += 1) {
      clip = intersectRects(clip, clips[index]) ?? EMPTY_CLIP;
    }
    return clip;
  }

  /** Legacy CSS `clip: rect(top, right, bottom, left)`; absolute/fixed only. */
  private legacyClipRect(
    style: CSSStyleDeclaration,
    box: DOMRect,
  ): { left: number; top: number; width: number; height: number } | null {
    if (style.clip === 'auto' || !style.clip.startsWith('rect(')) return null;
    if (style.position !== 'absolute' && style.position !== 'fixed') return null;

    let body = style.clip.slice(5).trim();
    if (body.endsWith(')')) body = body.slice(0, -1);
    const parts = body.split(',').map((part) => part.trim());
    if (parts.length !== 4) return null;

    const offset = (value: string, fallback: number): number => {
      if (value === 'auto') return fallback;
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const top = offset(parts[0], 0);
    const right = offset(parts[1], box.width);
    const bottom = offset(parts[2], box.height);
    const left = offset(parts[3], 0);

    return { left, top, width: right - left, height: bottom - top };
  }

  /**
   * Common visually-hidden shapes. Full `clip-path` geometry is not
   * evaluated, but `inset()` and zero-radius circles/ellipses are.
   */
  private clipPathRect(
    clipPath: string,
    box: DOMRect,
  ): { left: number; top: number; width: number; height: number } | null {
    if (clipPath === 'none' || clipPath === '') return null;

    const inset = /^inset\((.*)\)$/s.exec(clipPath);
    if (inset !== null) {
      let body = inset[1].trim();
      const roundIndex = body.search(/\bround\b/);
      if (roundIndex >= 0) body = body.slice(0, roundIndex).trim();
      if (body === '' || body.includes('calc')) return null;

      const parts = body.split(/\s+/);
      if (parts.length < 1 || parts.length > 4) return null;

      const length = (value: string, base: number): number | null => {
        if (value.endsWith('%')) {
          const percent = Number.parseFloat(value);
          return Number.isFinite(percent) ? (base * percent) / 100 : null;
        }
        const px = Number.parseFloat(value);
        return Number.isFinite(px) ? px : null;
      };

      const topValue = parts[0];
      const rightValue = parts[1] ?? parts[0];
      const bottomValue = parts[2] ?? parts[0];
      const leftValue = parts[3] ?? (parts[1] ?? parts[0]);

      const top = length(topValue, box.height);
      const right = length(rightValue, box.width);
      const bottom = length(bottomValue, box.height);
      const left = length(leftValue, box.width);
      if (top === null || right === null || bottom === null || left === null) return null;

      return { left, top, width: box.width - left - right, height: box.height - top - bottom };
    }

    const shape = /^(circle|ellipse)\((.*)\)$/s.exec(clipPath);
    if (shape !== null) {
      const values = shape[2]
        .split(/\s+/)
        .filter((part) => /^[0-9.]+(?:px|%)?$/.test(part));
      if (values.length > 0 && values.every((part) => Number.parseFloat(part) === 0)) {
        return { left: 0, top: 0, width: 0, height: 0 };
      }
    }

    return null;
  }
}
