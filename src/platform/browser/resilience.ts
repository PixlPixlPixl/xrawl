/**
 * Extension-side storage-aid key.
 *
 * IndexedDB survives normal extension updates but not eviction or removal.
 * `browser.storage.local` is static extension storage, so a marker written here
 * can outlive a wiped database and let the UI say "your history was cleared"
 * instead of silently starting a new lineage.
 */
import { browser } from '#imports';

const RESILIENCE_KEY = 'xrawl.storage.resilience';

interface ResilienceMarker {
  databaseCreatedAt: number;
}

export async function markDatabaseCreated(now: number): Promise<void> {
  try {
    const marker: ResilienceMarker = { databaseCreatedAt: now };
    await browser.storage.local.set({ [RESILIENCE_KEY]: marker });
  } catch {
    // Storage failures must never take down the game.
  }
}

export async function readDatabaseCreatedAt(): Promise<number | null> {
  try {
    const stored = await browser.storage.local.get(RESILIENCE_KEY);
    const marker = stored[RESILIENCE_KEY] as ResilienceMarker | undefined;
    return marker?.databaseCreatedAt ?? null;
  } catch {
    return null;
  }
}
