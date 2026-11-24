import type { EnvironmentClassification, PageInfo } from './page';
import type { ScanStats, WorldSnapshot } from './word-target';

export interface StatusPayload {
  readonly stats: ScanStats;
  readonly page: PageInfo;
  readonly environment: EnvironmentClassification;
  /** Whether the in-page outline overlay is currently shown. */
  readonly overlayVisible: boolean;
  readonly capturedAt: number;
}

/** content → background */
export interface StatsPushMessage {
  readonly type: 'xrawl/stats';
  readonly payload: StatusPayload;
}

/** popup → background */
export interface CachedStatsRequest {
  readonly type: 'xrawl/get-cached-stats';
  readonly tabId: number;
}

/** background → popup (+ any other listeners) */
export interface StatsBroadcastMessage {
  readonly type: 'xrawl/stats-broadcast';
  readonly tabId: number;
  readonly payload: StatusPayload;
}

/** popup → content */
export type ContentRequest =
  | { readonly type: 'xrawl/get-stats' }
  | { readonly type: 'xrawl/get-snapshot' }
  | { readonly type: 'xrawl/rescan' }
  | { readonly type: 'xrawl/set-overlay'; readonly visible: boolean }
  | { readonly type: 'xrawl/download-snapshot' };

export interface ExportPayload {
  readonly snapshot: WorldSnapshot;
  readonly truncated: boolean;
  readonly exportedTargetCount: number;
}

export interface DownloadResult {
  readonly bytes: number;
  readonly truncated: boolean;
  readonly count: number;
}

export type XrawlResponse<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isContentRequest(message: unknown): message is ContentRequest {
  if (!isObject(message) || typeof message.type !== 'string') return false;
  switch (message.type) {
    case 'xrawl/get-stats':
    case 'xrawl/get-snapshot':
    case 'xrawl/rescan':
    case 'xrawl/download-snapshot':
      return true;
    case 'xrawl/set-overlay':
      return typeof message.visible === 'boolean';
    default:
      return false;
  }
}

export function isStatsPushMessage(message: unknown): message is StatsPushMessage {
  return isObject(message) && message.type === 'xrawl/stats' && isObject(message.payload);
}

export function isCachedStatsRequest(message: unknown): message is CachedStatsRequest {
  return isObject(message) && message.type === 'xrawl/get-cached-stats' && typeof message.tabId === 'number';
}

export function isStatsBroadcast(message: unknown): message is StatsBroadcastMessage {
  return (
    isObject(message) &&
    message.type === 'xrawl/stats-broadcast' &&
    typeof message.tabId === 'number' &&
    isObject(message.payload)
  );
}
