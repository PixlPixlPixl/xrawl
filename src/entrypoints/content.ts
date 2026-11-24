import { defineContentScript } from '#imports';
import { startContentSession } from '@/app/content-session';

/**
 * The word-discovery debug harness runs on every http(s) page.
 *
 * `document_idle` gives normal paragraphs a chance to lay out before the
 * first measurement pass; dynamically injected text is handled by the
 * scanner's MutationObserver.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // Defensive guard against double injection (HMR / manual reload).
    if (document.documentElement.hasAttribute('data-xrawl-active')) return;
    document.documentElement.setAttribute('data-xrawl-active', 'true');
    startContentSession();
  },
});
