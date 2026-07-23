import type { AdminSettingsWire, AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';
import {
  allowlistKey,
  DEFAULT_LIMITS,
  getSettings,
  LIMITS_BOUNDS,
  setAllowlistOverride,
  setChangeFreeze,
  setLimits,
} from '@/lib/settings';

/**
 * Estate settings' ADVISORY → AUTHORITATIVE branch (pattern; see
 * teamsFlow.ts). Covers the settings ccp-api actually reads back
 * (routes/admin.ts GET /admin/settings): the change-freeze, the disabled-ops
 * list (written via the catalog route — riskFlow.ts), allowlist restrictions,
 * and the server-enforced rate limits. Notification channels and maintenance
 * windows have NO server surface (GET /admin/settings never returns them), so
 * they are deliberately absent here — SettingsAdmin keeps them advisory.
 *
 * `authoritative` is always exactly `can('settings')`; `client` is
 * `lib/api`'s `authClient` (null in mock mode). Server writes are
 * dual-controlled: freeze ON / allowlist-narrow applies immediately,
 * freeze OFF / allowlist-widen returns 202 for a second admin's ack. The
 * non-authoritative branch is the exact pre-existing lib/settings behavior.
 */

export const FREEZE_SETTING_KEY = 'freeze.global';
export const DISABLED_OPS_SETTING_KEY = 'catalog.disabled-ops';
export const RATE_LIMITS_SETTING_KEY = 'rate.limits';
export const ALLOWLIST_SETTING_KEY = 'allowlist.restrictions';

/** The slice of settings both backends can answer, in one view shape. */
export interface SettingsView {
  changeFreeze: boolean;
  disabledOps: string[];
  /** Permitted-subset overrides keyed `opId::param` (lib/settings.allowlistKey). */
  allowlistOverrides: Record<string, string[]>;
  /** The server-enforced pair (middleware/rateLimit.ts). Locally these map to
   * lib/settings' Limits fields of the same meaning. */
  rateLimits: { submissionsPerHour: number; maxOpenPerUser: number };
}

/* ── allowlist.restrictions wire encoding ─────────────────────────────────────
 *
 * The server stores the setting opaquely but CLASSIFIES it for dual-control as
 * a flat allowed-entries array (domain/dualControl.ts `target:'allowlist'`:
 * any entry in `after` not in `before` → loosening → 202; otherwise
 * tightening → applies now). So the wire value is a string[] of
 * `<opId>::<param>::<permittedValue>` entries — one per value L1 may pick —
 * for every param that has ever been restricted:
 *
 *   - narrowing (removing a permitted value) only removes entries → tightening
 *     → applies immediately;
 *   - widening (re-allowing a value) adds entries → loosening → a second
 *     admin must ack;
 *   - CLEARING a restriction is written as the param's FULL base list, never
 *     by deleting its entries — clearing is a widen and must stay
 *     dual-controlled (deleting entries would classify as tightening and
 *     sneak a widen past the second admin).
 *
 * A param with no entries at all is unrestricted (never yet narrowed). The one
 * over-strict consequence: the FIRST restriction on such a param adds entries
 * and classifies as loosening → 202 — a narrowing that waits for a second
 * admin once, fail-safe. Subsequent narrowing applies immediately.
 */

export function encodeAllowlistRestrictions(overrides: Record<string, string[]>): string[] {
  const entries: string[] = [];
  for (const [key, values] of Object.entries(overrides)) {
    for (const value of values) entries.push(`${key}::${value}`);
  }
  return entries.sort();
}

export function decodeAllowlistRestrictions(wire: unknown): Record<string, string[]> {
  if (!Array.isArray(wire)) return {};
  const out: Record<string, string[]> = {};
  for (const raw of wire) {
    if (typeof raw !== 'string') continue;
    const first = raw.indexOf('::');
    if (first < 0) continue;
    const second = raw.indexOf('::', first + 2);
    if (second < 0) continue;
    const key = raw.slice(0, second); // `<opId>::<param>` — lib/settings.allowlistKey shape
    const value = raw.slice(second + 2); // the value itself may contain '::'
    if (!value) continue;
    (out[key] ??= []).push(value);
  }
  return out;
}

/** The values L1 may pick for a param under a view's overrides: the manifest
 * base narrowed by any stored subset, in manifest order. A stored full (or
 * wider) list reads as unrestricted — the explicit-clear convention above. */
export function permittedValues(
  overrides: Record<string, string[]>,
  operationId: string,
  paramName: string,
  base: string[],
): string[] {
  const stored = overrides[allowlistKey(operationId, paramName)];
  if (!stored || stored.length === 0) return [...base];
  const permitted = new Set(stored);
  const narrowed = base.filter((v) => permitted.has(v));
  return narrowed.length > 0 ? narrowed : [...base]; // never soft-lock a param
}

export function isParamRestricted(
  overrides: Record<string, string[]>,
  operationId: string,
  paramName: string,
  base: string[],
): boolean {
  return permittedValues(overrides, operationId, paramName, base).length < base.length;
}

/* ── reads ──────────────────────────────────────────────────────────────────── */

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Decode GET /admin/settings' opaque values into the view — defensively:
 * a missing/never-written key means its default, same as the server's own
 * readers (domain/config.ts loadSetting ?? default). */
export function decodeServerSettings(wire: AdminSettingsWire): SettingsView {
  const rate = (wire[RATE_LIMITS_SETTING_KEY] ?? {}) as Record<string, unknown>;
  const disabled = wire[DISABLED_OPS_SETTING_KEY];
  return {
    changeFreeze: wire[FREEZE_SETTING_KEY] === true,
    disabledOps: Array.isArray(disabled) ? disabled.map(String) : [],
    allowlistOverrides: decodeAllowlistRestrictions(wire[ALLOWLIST_SETTING_KEY]),
    rateLimits: {
      submissionsPerHour: num(rate.submissionsPerHour, DEFAULT_LIMITS.submissionsPerHour),
      maxOpenPerUser: num(rate.maxOpen, DEFAULT_LIMITS.maxOpenPerUser),
    },
  };
}

/** The local store's snapshot — synchronous, so a mock build (and a server
 * render) shows the stored settings on first paint, exactly as it always has. */
export function localSettingsView(): SettingsView {
  const local = getSettings();
  return {
    changeFreeze: local.changeFreeze,
    disabledOps: [...local.disabledOps],
    allowlistOverrides: { ...local.allowlistOverrides },
    rateLimits: {
      submissionsPerHour: local.limits.submissionsPerHour,
      maxOpenPerUser: local.limits.maxOpenPerUser,
    },
  };
}

export async function loadSettingsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<SettingsView> {
  if (authoritative && client) {
    return decodeServerSettings(await client.getAdminSettings());
  }
  return localSettingsView();
}

/* ── writes ─────────────────────────────────────────────────────────────────── */

export async function setFreezeVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  frozen: boolean,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.putAdminSetting(FREEZE_SETTING_KEY, frozen);
  setChangeFreeze(frozen);
  return { applied: true };
}

/**
 * Set (or clear, with `values: null` or an empty/full list) one param's
 * permitted subset. The server path rewrites the WHOLE allowlist.restrictions
 * value from `current` + this change under the encoding rules above; the
 * local path is lib/settings.setAllowlistOverride, unchanged.
 */
export async function setAllowlistOverrideVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  current: Record<string, string[]>,
  operationId: string,
  paramName: string,
  values: string[] | null,
  base: string[],
): Promise<AdminWriteOutcome> {
  if (authoritative && client) {
    const key = allowlistKey(operationId, paramName);
    const unique = values ? [...new Set(values.map(String))] : [];
    const subset = base.filter((v) => unique.includes(v)); // manifest order, base-bounded
    const next: Record<string, string[]> = { ...current };
    // Clearing (null/empty/full) is written as the explicit FULL base list —
    // a widen the classifier must see as loosening (never a key deletion).
    next[key] = subset.length === 0 || subset.length >= base.length ? [...base] : subset;
    return client.putAdminSetting(ALLOWLIST_SETTING_KEY, encodeAllowlistRestrictions(next));
  }
  setAllowlistOverride(operationId, paramName, values, base);
  return { applied: true };
}

/** Clamp one server-enforced limit into its admin-tunable bounds (the same
 * LIMITS_BOUNDS the local editor clamps to). */
function clampBound(key: 'submissionsPerHour' | 'maxOpenPerUser', value: number): number {
  const [min, max] = LIMITS_BOUNDS[key];
  const n = Number.isFinite(value) ? Math.round(value) : DEFAULT_LIMITS[key];
  return Math.min(max, Math.max(min, n));
}

/**
 * Write the server-enforced rate-limit pair. The wire field is `maxOpen`
 * (domain/config.ts RateLimits) — the app's `maxOpenPerUser` under its server
 * name. Session lifetimes are NOT here: ccp-api fixes them (12h absolute,
 * 30m idle — auth/sessions.ts), so there is deliberately no server write for
 * them.
 */
export async function setRateLimitsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  limits: { submissionsPerHour: number; maxOpenPerUser: number },
): Promise<AdminWriteOutcome> {
  const submissionsPerHour = clampBound('submissionsPerHour', limits.submissionsPerHour);
  const maxOpenPerUser = clampBound('maxOpenPerUser', limits.maxOpenPerUser);
  if (authoritative && client) {
    return client.putAdminSetting(RATE_LIMITS_SETTING_KEY, {
      submissionsPerHour,
      maxOpen: maxOpenPerUser,
    });
  }
  setLimits({ submissionsPerHour, maxOpenPerUser });
  return { applied: true };
}
