/**
 * Typed messaging helpers around `browser.runtime` / `browser.tabs`.
 *
 * Kept intentionally thin: message shapes live in `shared/types/messaging.ts`
 * so the world engine's debug harness and the popup agree on one contract.
 */
import { browser } from '#imports';
import type { XrawlResponse } from '@/shared/types/messaging';

export async function sendRuntimeMessage<T>(message: object): Promise<XrawlResponse<T> | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage(message);
    return (response as XrawlResponse<T>) ?? null;
  } catch {
    // No receiving context (e.g. popup opened on a tab without our content
    // script) is expected; callers render an empty state.
    return null;
  }
}

export async function sendTabMessage<T>(tabId: number, message: object): Promise<XrawlResponse<T> | null> {
  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, message);
    return (response as XrawlResponse<T>) ?? null;
  } catch {
    return null;
  }
}

export function onRuntimeMessage(
  handler: (
    message: unknown,
    sender: { tab?: { id?: number } },
    sendResponse: (response?: unknown) => void,
  ) => boolean | void,
): () => void {
  const listener = (
    message: unknown,
    sender: { tab?: { id?: number } },
    sendResponse: (response?: unknown) => void,
  ) => handler(message, sender, sendResponse);

  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

export async function getActiveTab(): Promise<{ id?: number; url?: string } | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return null;
    return { id: tab.id, url: tab.url };
  } catch {
    return null;
  }
}
