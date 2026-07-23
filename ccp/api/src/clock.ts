/**
 * The one clock. All server time reads go through here so tests can freeze and
 * advance time deterministically (lockout/session acceptance). Production
 * uses `Date.now()`; a test calls `__setNow(() => fixedMs)`.
 */
let _now: () => number = () => Date.now();

export function nowMs(): number {
  return _now();
}
export function nowDate(): Date {
  return new Date(_now());
}
export function nowIso(): string {
  return new Date(_now()).toISOString();
}

/** Test-only: freeze/override the clock. Pass `null` to restore the real clock. */
export function __setNow(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}
