/**
 * Textual context extraction.
 *
 * A debug target should be readable on its own: the sentence it appears in
 * plus a bit of the surrounding block. Both are derived from the text node
 * (and its nearest block ancestor) so no extra layout work is required.
 *
 * Pure string logic lives here alongside the one DOM dependency (block
 * resolution), keeping the sentence index reusable and testable.
 */
const WHITESPACE = /\s+/g;
const SENTENCE_TERMINATOR = /[.!?\u2026\u3002\uFF01\uFF1F]+(?:["'\u201d\u2019\u00bb)\]]*)\s*/g;
const NON_BLOCK_DISPLAYS = new Set(['inline', 'contents', 'ruby', 'ruby-text', 'none']);

export function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE, ' ').trim();
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}\u2026`;
}

interface SentenceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Precomputes sentence boundaries once per text node. A paragraph contains
 * many words; rescanning it for each word would make context extraction
 * O(words × chars).
 */
export class SentenceIndex {
  private readonly source: string;
  private readonly ranges: readonly SentenceRange[];

  constructor(text: string) {
    this.source = text;

    const ranges: SentenceRange[] = [];
    let start = 0;

    SENTENCE_TERMINATOR.lastIndex = 0;
    for (let match = SENTENCE_TERMINATOR.exec(text); match !== null; match = SENTENCE_TERMINATOR.exec(text)) {
      const end = match.index + match[0].length;
      ranges.push({ start, end });
      start = end;
    }

    ranges.push({ start, end: text.length });
    this.ranges = ranges;
  }

  sentenceAt(start: number, end: number, maxChars: number): string {
    let chosen: SentenceRange = this.ranges.at(-1) ?? { start: 0, end: this.source.length };

    for (const range of this.ranges) {
      if (start >= range.start && end <= range.end) {
        chosen = range;
        break;
      }
    }

    if (chosen.end - chosen.start <= maxChars) {
      return collapseWhitespace(this.source.slice(chosen.start, chosen.end));
    }

    // Long single-sentence paragraphs: return a window around the word.
    const center = (start + end) / 2;
    const windowStart = Math.max(chosen.start, center - maxChars / 2);
    const windowEnd = Math.min(chosen.end, windowStart + maxChars);
    return truncate(collapseWhitespace(this.source.slice(windowStart, windowEnd)), maxChars);
  }
}

export interface ContextLimits {
  readonly sentenceMaxChars: number;
  readonly surroundingMaxChars: number;
  readonly surroundingBlockLimit: number;
}

/**
 * Resolves the nearest block container for a text node and caches its
 * collapsed text. Caches are cleared once per measurement pass so CSS/layout
 * changes cannot serve stale surrounding text.
 */
export class ContextResolver {
  private blockCache = new Map<Element, Element | null>();
  private blockTextCache = new WeakMap<Element, string>();

  constructor(private readonly document: Document) {}

  reset(): void {
    this.blockCache.clear();
    this.blockTextCache = new WeakMap();
  }

  surrounding(node: Text, limits: ContextLimits): string {
    const block = this.resolveBlock(node);
    if (!block) return truncate(collapseWhitespace(node.data), limits.surroundingMaxChars);

    const blockText = this.blockText(block);
    const raw = blockText.length <= limits.surroundingBlockLimit ? blockText : node.data;
    return truncate(collapseWhitespace(raw), limits.surroundingMaxChars);
  }

  private blockText(block: Element): string {
    const cached = this.blockTextCache.get(block);
    if (cached !== undefined) return cached;
    const text = block.textContent ?? '';
    this.blockTextCache.set(block, text);
    return text;
  }

  private resolveBlock(node: Text): Element | null {
    const visited: Element[] = [];
    let current = node.parentElement;
    let resolved: Element | null = null;
    let depth = 0;

    while (
      current &&
      current !== this.document.body &&
      current !== this.document.documentElement &&
      depth < 12
    ) {
      const cached = this.blockCache.get(current);
      if (cached !== undefined) {
        resolved = cached;
        break;
      }

      if (this.isBlock(current)) {
        resolved = current;
        this.blockCache.set(current, current);
        break;
      }

      visited.push(current);
      current = current.parentElement;
      depth += 1;
    }

    // Cache the fully-resolved nearest block for every inline ancestor, so a
    // sibling text node inside the same inline chain resolves in one lookup.
    for (const element of visited) this.blockCache.set(element, resolved);
    return resolved;
  }

  private isBlock(element: Element): boolean {
    const display = element.ownerDocument.defaultView?.getComputedStyle(element).display;
    if (!display) return true;
    return !NON_BLOCK_DISPLAYS.has(display);
  }
}
