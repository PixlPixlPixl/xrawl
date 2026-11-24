/**
 * Visibility checks with a per-layout-generation cache.
 *
 * Rejecting an invisible *element* prunes its whole subtree from the walk,
 * which is both correct for `display: none` and much cheaper than testing
 * every descendant.
 */
const NEVER_RENDERED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BASE',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'PICTURE',
  'IMG',
  'MAP',
  'AREA',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'OPTGROUP',
  'DATALIST',
  'PROGRESS',
  'METER',
  'OUTPUT',
  'SLOT',
  'DIALOG',
]);

interface CacheEntry {
  readonly generation: number;
  readonly visible: boolean;
}

type CheckVisibilityElement = Element & {
  checkVisibility?: (options?: {
    checkOpacity?: boolean;
    checkVisibilityCSS?: boolean;
    opacityProperty?: boolean;
    visibilityProperty?: boolean;
    contentVisibilityAuto?: boolean;
  }) => boolean;
};

export class VisibilityCache {
  private generation = 1;
  private readonly ownCache = new WeakMap<Element, CacheEntry>();

  /** Called whenever layout-affecting state may have changed. */
  invalidate(): void {
    this.generation += 1;
  }

  isVisible(element: Element | null, document: Document): boolean {
    if (!element) return false;
    if (element === document.documentElement) return true;
    if (!element.isConnected) return false;

    for (let current: Element | null = element; current && current !== document.documentElement; current = current.parentElement) {
      if (!this.isOwnVisible(current)) return false;
    }

    return true;
  }

  isOwnVisible(element: Element): boolean {
    const cached = this.ownCache.get(element);
    if (cached && cached.generation === this.generation) return cached.visible;

    const visible = this.checkOwnVisibility(element);
    this.ownCache.set(element, { generation: this.generation, visible });
    return visible;
  }

  private checkOwnVisibility(element: Element): boolean {
    if (NEVER_RENDERED_TAGS.has(element.tagName)) return false;

    const htmlElement = element as HTMLElement;
    // `hidden` is the declarative API; inline `display` can override it, but
    // treating it as hidden is the conservative, expected reading.
    if (htmlElement.hidden === true) return false;

    const checkVisibility = (element as CheckVisibilityElement).checkVisibility;
    if (typeof checkVisibility === 'function') {
      try {
        const result = checkVisibility.call(element, {
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        });
        if (result === false) return false;
      } catch {
        // Fall through to manual inspection.
      }
    }

    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;

    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.contentVisibility === 'hidden') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;

    return true;
  }
}
