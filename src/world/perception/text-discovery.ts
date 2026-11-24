/**
 * DOM text-node discovery.
 *
 * Responsibilities:
 *  - walk the document in reading order, skipping whole subtrees that are
 *    hidden, editable, sensitive, or not part of rendered content;
 *  - expose text nodes only (geometry/segmentation happen downstream).
 *
 * Element-level rejection is important: `TreeWalker` prunes a rejected
 * element's subtree, so a `display: none` container costs one style read
 * instead of one per descendant.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import type { VisibilityCache } from './visibility';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Tags that carry no discoverable prose (or are pure UI chrome). */
const EXCLUDED_TAGS = new Set([
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
  'BUTTON',
  'SLOT',
  'DIALOG',
]);

const SENSITIVE_AUTOCOMPLETE =
  /(current-password|new-password|one-time-code|cc-number|cc-name|cc-exp|cc-csc|cc-type|webauthn|password|pwd)/i;

const SENSITIVE_DESCRIPTOR =
  /(pass(word|code|phrase)|secret|token|api[-_ ]?key|ssn|social[-_ ]?security|security[-_ ]?code|cvv|cvc|card[-_ ]?number|credit[-_ ]?card|routing[-_ ]?number|iban|account[-_ ]?number|otp|one[-_ ]?time|pin)/i;

function isSensitiveControl(control: Element): boolean {
  const tag = control.tagName;
  if (tag === 'INPUT') {
    const type = (control as HTMLInputElement).type.toLowerCase();
    if (type === 'password') return true;
  }

  const autocomplete = control.getAttribute('autocomplete') ?? '';
  if (autocomplete !== '' && SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;

  const descriptors = [
    control.id,
    control.getAttribute('name') ?? '',
    control.getAttribute('placeholder') ?? '',
  ].join(' ');
  return SENSITIVE_DESCRIPTOR.test(descriptors);
}

function isSensitiveContainer(element: Element): boolean {
  if (element.tagName === 'FORM') {
    for (const control of element.querySelectorAll('input, textarea, select')) {
      if (isSensitiveControl(control)) return true;
    }
    return false;
  }

  const autocomplete = element.getAttribute('autocomplete');
  return autocomplete !== null && SENSITIVE_AUTOCOMPLETE.test(autocomplete);
}

function isEditable(element: Element): boolean {
  const contentEditable = element.getAttribute('contenteditable');
  return contentEditable !== null && contentEditable.toLowerCase() !== 'false';
}

function elementIsExcluded(element: Element, document: Document, visibility: VisibilityCache): boolean {
  // Cheapest, most certain rejections first.
  if (element.hasAttribute(XRAWL_CONFIG.overlayAttribute)) return true;
  if (element.namespaceURI !== null && element.namespaceURI !== XHTML_NAMESPACE) return true;
  if (EXCLUDED_TAGS.has(element.tagName)) return true;
  if (isEditable(element)) return true;
  if (isSensitiveContainer(element)) return true;

  // Style flush last: it is the only check that reads computed layout.
  return !visibility.isVisible(element, document);
}

export function isCandidateText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (EXCLUDED_TAGS.has(parent.tagName)) return false;
  if (!node.data.trim()) return false;
  return true;
}

/**
 * Yields text nodes in document order. Hidden/editable/sensitive subtrees are
 * pruned by the walker; the caller only sees candidates.
 */
export function* iterateTextNodes(
  document: Document,
  root: Node,
  visibility: VisibilityCache,
): Generator<Text, void, undefined> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.TEXT_NODE) {
        return isCandidateText(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        return elementIsExcluded(node as Element, document, visibility)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (current.nodeType === Node.TEXT_NODE) yield current as Text;
  }
}
