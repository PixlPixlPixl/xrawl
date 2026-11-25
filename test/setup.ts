/**
 * Must run before any module that imports Dexie: Dexie snapshots the global
 * IndexedDB implementation at module-init time, so a later `fake-indexeddb`
 * import would be invisible to it.
 */
import 'fake-indexeddb/auto';
