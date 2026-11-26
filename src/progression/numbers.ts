/** Small numeric helpers shared by the progression modules. */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function clamp11(value: number): number {
  return clamp(value, -1, 1);
}

/** Round to two decimals so stored totals stay comparable between saves. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
