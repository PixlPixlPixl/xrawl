import type { ScrollOffset, Viewport, ViewportSize } from '@/shared/types/geometry';

/**
 * Ports the engines use instead of touching browser globals directly.
 *
 * The world/creature engines only ever receive these interfaces. A desktop
 * host (Electron, Tauri, accessibility bridge) implements the same ports and
 * reuses the engine unchanged.
 */
export interface Clock {
  now(): number;
}

/**
 * Timer id returned by `Scheduler.timeout`. Hosts that use object timers
 * should map them to numeric ids inside their platform adapter.
 *
 * (Numeric so the scheduling port stays JSON-friendly and comparable.)
 */
export type TimerHandle = number;

export interface Scheduler extends Clock {
  /**
   * Resolve on the next animation frame while the host is visible, or on a
   * short timer when it is backgrounded (frames are throttled/paused then).
   */
  nextFrame(): Promise<void>;
  timeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface ViewportPort {
  /** Current scroll offset and viewport size. Called once per measurement pass. */
  read(): Viewport;
  scrollOffset(): ScrollOffset;
  size(): ViewportSize;
}

export interface StoragePort {
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Platform {
  readonly scheduler: Scheduler;
  readonly viewport: ViewportPort;
  readonly storage: StoragePort;
}
