/**
 * Whole-database export and import.
 *
 * Import replaces the tables present in the envelope inside a single read-write
 * transaction: either every table is swapped or none are. A newer-schema export
 * is rejected rather than silently truncated by older code (`assertImportableSchema`).
 */
import type { XrawlDatabase } from './db';
import { assertImportableSchema } from './db';
import {
  isExportEnvelope,
  XRAWL_EXPORT_FORMAT,
  XRAWL_EXPORT_FORMAT_VERSION,
  type XrawlExportEnvelope,
} from './export-format';
import { XRAWL_TABLE_NAMES, type XrawlTableName } from './schema';

export interface ExportOptions {
  /** Tables to skip, e.g. large embedding caches. */
  readonly exclude?: readonly XrawlTableName[];
  readonly appVersion: string;
  readonly now: number;
}

export async function exportDatabase(
  db: XrawlDatabase,
  options: ExportOptions,
): Promise<XrawlExportEnvelope> {
  const excluded = new Set<XrawlTableName>(options.exclude ?? []);
  const tables: Partial<Record<XrawlTableName, readonly unknown[]>> = {};
  const counts: Partial<Record<XrawlTableName, number>> = {};

  for (const name of XRAWL_TABLE_NAMES) {
    if (excluded.has(name)) continue;
    const rows = await db.table(name).toArray();
    tables[name] = rows;
    counts[name] = rows.length;
  }

  return {
    format: XRAWL_EXPORT_FORMAT,
    formatVersion: XRAWL_EXPORT_FORMAT_VERSION,
    schemaVersion: db.verno,
    exportedAt: options.now,
    appVersion: options.appVersion,
    counts,
    tables,
  };
}

export interface ImportResult {
  readonly imported: Partial<Record<XrawlTableName, number>>;
}

/**
 * Validates the envelope *before* opening a transaction so a bad file cannot
 * wipe live tables halfway through.
 */
export function validateImport(envelope: unknown): XrawlExportEnvelope {
  if (!isExportEnvelope(envelope)) {
    throw new Error('Not a Xrawl export file.');
  }
  if (envelope.formatVersion > XRAWL_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `Export format v${envelope.formatVersion} is newer than this build (v${XRAWL_EXPORT_FORMAT_VERSION}).`,
    );
  }
  assertImportableSchema(envelope.schemaVersion);
  return envelope;
}

export async function importDatabase(
  db: XrawlDatabase,
  envelope: unknown,
): Promise<ImportResult> {
  const validated = validateImport(envelope);
  const tableNames = XRAWL_TABLE_NAMES.filter((name) => validated.tables[name] !== undefined);
  const imported: Partial<Record<XrawlTableName, number>> = {};

  await db.transaction('rw', tableNames.map((name) => db.table(name)), async () => {
    for (const name of tableNames) {
      const rows = validated.tables[name] ?? [];
      const table = db.table(name);
      await table.clear();
      if (rows.length > 0) await table.bulkPut(rows as object[]);
      imported[name] = rows.length;
    }
  });

  return { imported };
}
