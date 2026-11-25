/**
 * Storage resilience probes.
 *
 * Pure Web Storage API use (no extension APIs), so this module is testable and
 * reusable by a desktop host. Keys live in the extension's default storage.
 */
export interface StorageEstimate {
  readonly usage: number;
  readonly quota: number;
  readonly persisted: boolean;
}

/**
 * Asks the browser to exempt our storage from eviction under pressure. Chrome
 * grants this without a prompt for extensions with `unlimitedStorage`, but the
 * call is still advisory: it returns what actually happened.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = navigator.storage;
    if (!storage) return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    if (typeof storage.persist === 'function') return await storage.persist();
    return false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<StorageEstimate | null> {
  try {
    const storage = navigator.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    const estimate = await storage.estimate();
    const persisted =
      typeof storage.persisted === 'function' ? await storage.persisted() : false;
    return {
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
      persisted,
    };
  } catch {
    return null;
  }
}
