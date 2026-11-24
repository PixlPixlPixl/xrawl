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
]);

/** Composed parent: crosses from a shadow tree to its host. */
function composedParent(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : null;
}

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
  private readonly textVisibilityCache = new WeakMap<Element, CacheEntry>();
  private readonly autoHiddenElements = new Set<Element>();
  private hasAutoContent = false;

  /** Called whenever layout-affecting state may have changed. */
  invalidate(): void {
    this.generation += 1;
    this.autoHiddenElements.clear();
    this.hasAutoContent = false;
  }

  /** True when the last pass skipped content inside `content-visibility: auto`. */
  get contentVisibilitySkipped(): boolean {
    return this.autoHiddenElements.size > 0;
  }

  /** True when the page uses `content-visibility: auto` at all. */
  get contentVisibilityPresent(): boolean {
    return this.hasAutoContent;
  }

  isVisible(element: Element | null, document: Document): boolean {
    if (!element) return false;
    if (element === document.documentElement) return true;
    if (!element.isConnected) return false;

    for (let current: Element | null = element; current && current !== document.documentElement; current = composedParent(current)) {
      if (!this.isOwnVisible(current)) return false;
    }

    return true;
  }

  /**
   * A text node inherits `visibility`, but descendants may override it with
   * `visibility: visible`. So hidden elements are traversed rather than pruned;
   * the final check happens against the text node's parent.
   */
  textIsVisible(node: Text): boolean {
    const parent = node.parentElement;
    if (!parent) return false;

    const cached = this.textVisibilityCache.get(parent);
    if (cached && cached.generation === this.generation) return cached.visible;

    const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
    const visible =
      style === undefined || (style.visibility !== 'hidden' && style.visibility !== 'collapse');
    this.textVisibilityCache.set(parent, { generation: this.generation, visible });
    return visible;
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

    const style = element.ownerDocument.defaultView?.getComputedStyle(element);

    // `display: contents` generates no box of its own, so checkVisibility()
    // reports false even when its children paint normally. Descendants decide.
    if (style?.display === 'contents') {
      return !(style.opacity !== '' && Number(style.opacity) === 0);
    }

    if (style?.contentVisibility === 'auto') this.hasAutoContent = true;
    const checkVisibility = (element as CheckVisibilityElement).checkVisibility;
    if (typeof checkVisibility === 'function') {
      try {
        // Deliberately exclude CSS `visibility`: descendants can override it.
        const result = checkVisibility.call(element, {
          checkOpacity: true,
          contentVisibilityAuto: true,
        });
        if (result === false) {
          if (this.insideAutoContentVisibility(element, style)) {
            this.autoHiddenElements.add(element);
          }
          return false;
        }
      } catch {
        // Fall through to manual inspection.
      }
    }

    if (!style) return true;

    if (style.display === 'none') return false;
    if (style.contentVisibility === 'hidden') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;

    return true;
  }

  /**
   * A skipped descendant has `content-visibility: visible` computed; only an
   * ancestor carries `auto`. Check the chain so a skipped section is recorded
   * even when the pruned element itself is not the auto container.
   */
  private insideAutoContentVisibility(
    element: Element,
    ownStyle: CSSStyleDeclaration | undefined,
  ): boolean {
    if (ownStyle?.contentVisibility === 'auto') return true;

    const view = element.ownerDocument.defaultView;
    for (
      let current = element.parentElement;
      current && current !== element.ownerDocument.documentElement;
      current = current.parentElement
    ) {
      const style = view?.getComputedStyle(current);
      if (style?.contentVisibility === 'auto') return true;
    }
    return false;
  }
}
