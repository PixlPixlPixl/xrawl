/**
 * Shared test harness: a real (in-memory) IndexedDB per test, with the Dexie
 * database opened against it. `fake-indexeddb` implements the actual spec —
 * index ordering, compound keys, transactions — so these tests exercise the
 * storage layer itself rather than a mock of it.
 */
import 'fake-indexeddb/auto';
import type { XrawlDatabase } from '@/data/db';
import { createXrawlDatabase, type XrawlDbOptions } from '@/data/db';
import type { Migration } from '@/data/migrations';

let counter = 0;

/** Each call gets a unique database name so tests cannot leak into each other. */
export function freshDatabaseName(prefix = 'xrawl-test'): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface OpenedDatabase {
  readonly db: XrawlDatabase;
  readonly name: string;
  close(): void;
  /** Deletes the underlying database, then closes. */
  destroy(): Promise<void>;
}

export async function openDatabase(
  options: { name?: string; migrations?: readonly Migration[]; schemaVersion?: number } = {},
): Promise<OpenedDatabase> {
  const name = options.name ?? freshDatabaseName();
  const dbOptions: XrawlDbOptions = {
    migrations: options.migrations,
    schemaVersion: options.schemaVersion,
  };
  const db = createXrawlDatabase(name, dbOptions);
  await db.open();

  return {
    db,
    name,
    close() {
      db.close();
    },
    async destroy() {
      db.close();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    },
  };
}

export function nowAt(offsetMs = 0): number {
  return 1_700_000_000_000 + offsetMs;
}
