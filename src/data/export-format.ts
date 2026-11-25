/**
 * Export/import envelopes.
 *
 * The envelope carries the schema version and a per-table row count, so an
 * import can refuse a forward-incompatible file and a user can see what they are
 * about to replace before confirming. Rows are plain JSON: the same file is
 * readable by a script, a runner, and a future desktop host.
 */
import type { XrawlTableName } from './schema';

export const XRAWL_EXPORT_FORMAT = 'xrawl-export';
export const XRAWL_EXPORT_FORMAT_VERSION = 1;

export interface XrawlExportEnvelope {
  readonly format: typeof XRAWL_EXPORT_FORMAT;
  readonly formatVersion: number;
  /** Dexie/IndexedDB version that produced the dump. */
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly counts: Partial<Record<XrawlTableName, number>>;
  readonly tables: Partial<Record<XrawlTableName, readonly unknown[]>>;
}

export function isExportEnvelope(value: unknown): value is XrawlExportEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<XrawlExportEnvelope>;
  return (
    candidate.format === XRAWL_EXPORT_FORMAT &&
    typeof candidate.formatVersion === 'number' &&
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.tables === 'object' &&
    candidate.tables !== null
  );
}
