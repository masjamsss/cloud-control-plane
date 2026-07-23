import { useSyncExternalStore } from 'react';
import { currentProjectId, scopedKey, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/session';
import { createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * Per-project, admin-editable settings — the "variables a leader may change at
 * any time". Persisted locally today; a real ccp-api
 * keeps the same shape as SETTING#<key> items. Starts with the change-freeze
 * switch and is designed to grow (allowlists, tag defaults, notification
 * channels, windows).
 *
 * Note: like the other stores, the UI reads these; the authoritative server
 * re-enforces them (a frozen estate must reject submissions server-side too).
 *
 * Project-scoped: the storage key is computed at call time from the
 * active project, so switching projects never needs a reload.
 */
/** Where an approval/status change is echoed. */
export type ChannelKind = 'email' | 'chat-webhook';
/** Which lifecycle events a channel is echoed on. */
export type ChannelEvent = 'submitted' | 'approved' | 'rejected' | 'applied';

export interface NotificationChannel {
  id: string;
  kind: ChannelKind;
  target: string;
  events: ChannelEvent[];
}

/** A recurring window (e.g. "no deploys during month-end close"). Advisory today —
 * nothing currently blocks a submission against it; the render layer surfaces it. */
export interface MaintenanceWindow {
  id: string;
  label: string;
  cron: string;
  tz: string;
}

/** Estate-wide numeric guardrails. */
export interface Limits {
  sessionAbsoluteHours: number;
  sessionIdleMinutes: number;
  submissionsPerHour: number;
  maxOpenPerUser: number;
}

export interface GlobalSettings {
  /** When true, the estate is frozen: no new change requests may be submitted. */
  changeFreeze: boolean;
  /** Operation ids an admin has disabled — hidden from pickers and rejected at submit. */
  disabledOps: string[];
  /**
   * Admin narrowing of a param's allowlist, keyed by `<operationId>::<paramName>`.
   * The value is the subset of the manifest allowlist that L1 may currently pick.
   * This can only ever *narrow*: the resolver intersects it with the manifest
   * list, so a leader can tighten the estate at runtime but never introduce a
   * value the Terraform doesn't support. Absent key = no restriction.
   */
  allowlistOverrides: Record<string, string[]>;
  /** Where approvals/status changes are echoed, beyond the in-app bell. */
  notifications: { channels: NotificationChannel[] };
  /** Recurring windows an admin has flagged (informational until ccp-api enforces them). */
  maintenanceWindows: MaintenanceWindow[];
  /** Estate-wide numeric guardrails; mirrors the api spec defaults. */
  limits: Limits;
}

/** Session/submission guardrail bounds an admin may tune within (UI clamps
 * to these; {@link clampLimits} enforces them here too, so the store can never
 * hold an out-of-range value regardless of caller). */
export const LIMITS_BOUNDS: Record<keyof Limits, [number, number]> = {
  sessionAbsoluteHours: [1, 24],
  sessionIdleMinutes: [5, 120],
  submissionsPerHour: [1, 500],
  maxOpenPerUser: [1, 100],
};

export const DEFAULT_LIMITS: Limits = {
  sessionAbsoluteHours: 12,
  sessionIdleMinutes: 30,
  submissionsPerHour: 50,
  maxOpenPerUser: 20,
};

export const DEFAULT_SETTINGS: GlobalSettings = {
  changeFreeze: false,
  disabledOps: [],
  allowlistOverrides: {},
  notifications: { channels: [] },
  maintenanceWindows: [],
  limits: { ...DEFAULT_LIMITS },
};

/** Stable key for an allowlist override: one operation's one parameter. */
export function allowlistKey(operationId: string, paramName: string): string {
  return `${operationId}::${paramName}`;
}

// legacy key from the Gerbang era — reads old data, never written
const LEGACY_KEY = 'gerbang.settings.v1';
const storeKey = (): string => scopedKey('settings');
const memory = new Map<string, string>();
/** Same-tab write notifications — see lib/useStore.ts's module doc for why a
 * native `storage` event alone (wired below via subscribeSettings) isn't enough. */
const emitter = createEmitter();

function readRaw(): string | null {
  // One-time legacy migration: an un-namespaced v1 key surfaces under the
  // sample estate exactly once. Only the localStorage branch has pre-existing
  // legacy data to migrate — the memory-Map fallback starts empty every
  // session, so it needs no migration.
  try {
    if (
      currentProjectId() === SAMPLE_ESTATE_ID &&
      localStorage.getItem(LEGACY_KEY) !== null &&
      localStorage.getItem(storeKey()) === null
    ) {
      localStorage.setItem(storeKey(), localStorage.getItem(LEGACY_KEY)!);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* storage unavailable — memory fallback path needs no migration */
  }
  try {
    return localStorage.getItem(storeKey());
  } catch {
    return memory.get(storeKey()) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(storeKey(), value);
  } catch {
    memory.set(storeKey(), value);
  }
  // Notify same-tab subscribers — the native `storage` event never fires in
  // the document that made the write, only in every OTHER one.
  emitter.emit();
}

function parseOverrides(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > 0) out[key] = value.map(String);
  }
  return out;
}

const CHANNEL_KINDS: ChannelKind[] = ['email', 'chat-webhook'];
const CHANNEL_EVENTS: ChannelEvent[] = ['submitted', 'approved', 'rejected', 'applied'];

function parseChannels(raw: unknown): NotificationChannel[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationChannel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Partial<NotificationChannel>;
    if (typeof c.id !== 'string' || !c.id) continue;
    if (!CHANNEL_KINDS.includes(c.kind as ChannelKind)) continue;
    if (typeof c.target !== 'string') continue;
    const events = Array.isArray(c.events)
      ? c.events.filter((e): e is ChannelEvent => CHANNEL_EVENTS.includes(e as ChannelEvent))
      : [];
    out.push({ id: c.id, kind: c.kind as ChannelKind, target: c.target, events });
  }
  return out;
}

function parseNotifications(raw: unknown): { channels: NotificationChannel[] } {
  if (!raw || typeof raw !== 'object') return { channels: [] };
  return { channels: parseChannels((raw as { channels?: unknown }).channels) };
}

function parseMaintenanceWindows(raw: unknown): MaintenanceWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: MaintenanceWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Partial<MaintenanceWindow>;
    if (typeof w.id !== 'string' || !w.id) continue;
    if (typeof w.label !== 'string' || typeof w.cron !== 'string' || typeof w.tz !== 'string') continue;
    out.push({ id: w.id, label: w.label, cron: w.cron, tz: w.tz });
  }
  return out;
}

function clampOne(key: keyof Limits, value: unknown): number {
  const [min, max] = LIMITS_BOUNDS[key];
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Clamp every field to {@link LIMITS_BOUNDS}; a missing/malformed field falls
 * back to {@link DEFAULT_LIMITS} before clamping. Used both to defend the store
 * against malformed persisted JSON and to sanitize a caller's {@link setLimits}
 * input — so an out-of-range value can never actually reach storage. */
export function clampLimits(input: Partial<Limits>): Limits {
  return {
    sessionAbsoluteHours: clampOne('sessionAbsoluteHours', input.sessionAbsoluteHours),
    sessionIdleMinutes: clampOne('sessionIdleMinutes', input.sessionIdleMinutes),
    submissionsPerHour: clampOne('submissionsPerHour', input.submissionsPerHour),
    maxOpenPerUser: clampOne('maxOpenPerUser', input.maxOpenPerUser),
  };
}

function parseLimits(raw: unknown): Limits {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LIMITS };
  return clampLimits(raw as Partial<Limits>);
}

/** Pure parse: raw stored JSON (or null) → a fully-defaulted, clamped
 * GlobalSettings. Pulled out of getSettings() so the cache below can gate the
 * (relatively expensive — several sub-parsers, array/object rebuilding) parse
 * on whether the raw string actually changed, not just on whether someone
 * asked (this was the "680 reads/keystroke" pathology's root: a
 * fresh parse on every single call, settings-change or not). */
function parseSettingsRaw(raw: string | null): GlobalSettings {
  if (!raw) return { ...DEFAULT_SETTINGS, disabledOps: [], allowlistOverrides: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return {
      changeFreeze: parsed.changeFreeze === true,
      disabledOps: Array.isArray(parsed.disabledOps) ? parsed.disabledOps.map(String) : [],
      allowlistOverrides: parseOverrides(parsed.allowlistOverrides),
      notifications: parseNotifications(parsed.notifications),
      maintenanceWindows: parseMaintenanceWindows(parsed.maintenanceWindows),
      limits: parseLimits(parsed.limits),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, disabledOps: [], allowlistOverrides: {} };
  }
}

// ── Cached snapshot ───────────────────────────────────────────
// getSettings() must stay safe to call fresh at any moment (e.g. RequestForm's
// submit-time freeze/disabled-op re-check, R7) — so this cache is purely an
// optimization, never a source of staleness: it re-parses whenever EITHER the
// project scope (settings are project-scoped) or the raw stored
// string differs from what produced the cached object, and returns the exact
// same object reference otherwise. That referential stability is what lets
// useSettings() below be a well-behaved useSyncExternalStore source (a fresh
// object every call would make React think the store changes on every
// render, which either loops or triggers React's dev-mode tear warning).
let cachedKey: string | undefined;
let cachedRaw: string | null | undefined;
let cachedSnapshot: GlobalSettings | undefined;

function computeSettingsSnapshot(): GlobalSettings {
  const key = storeKey();
  const raw = readRaw();
  if (cachedSnapshot !== undefined && key === cachedKey && raw === cachedRaw) {
    return cachedSnapshot;
  }
  cachedKey = key;
  cachedRaw = raw;
  cachedSnapshot = parseSettingsRaw(raw);
  return cachedSnapshot;
}

export function getSettings(): GlobalSettings {
  return computeSettingsSnapshot();
}

/** Subscribe to this store changing (this tab's writes + other tabs', via the
 * native `storage` event) — exported for direct testing (no jsdom/RTL in this
 * repo — see lib/useStore.ts's module doc) and reused by useSettings() below. */
export const subscribeSettingsChanged = subscribeWithStorage(emitter, storeKey);

/**
 * React binding for the settings store. `getSnapshot` and
 * `getServerSnapshot` are the SAME cached pure function `getSettings()` uses —
 * so a server-string render (react-dom/server's renderToStaticMarkup, this
 * repo's whole testing story, C2) sees exactly the snapshot the existing
 * pure-function tests already construct by hand, and every reader (hook or
 * not) shares one cache, invalidated only by an actual write.
 */
export function useSettings(): GlobalSettings {
  return useSyncExternalStore(
    subscribeSettingsChanged,
    computeSettingsSnapshot,
    computeSettingsSnapshot,
  );
}

export function isChangeFrozen(): boolean {
  return getSettings().changeFreeze;
}

export function setChangeFreeze(frozen: boolean): GlobalSettings {
  const next: GlobalSettings = { ...getSettings(), changeFreeze: frozen };
  writeRaw(JSON.stringify(next));
  return next;
}

export function isOpDisabled(operationId: string): boolean {
  return getSettings().disabledOps.includes(operationId);
}

export function setOpDisabled(operationId: string, disabled: boolean): GlobalSettings {
  const current = getSettings();
  const set = new Set(current.disabledOps);
  if (disabled) set.add(operationId);
  else set.delete(operationId);
  const next: GlobalSettings = { ...current, disabledOps: [...set] };
  writeRaw(JSON.stringify(next));
  return next;
}

/**
 * The admin-permitted subset for one param, or null if unrestricted. Raw stored
 * value — the caller intersects with the manifest base via {@link narrowAllowlist}.
 */
export function getAllowlistOverride(operationId: string, paramName: string): string[] | null {
  const stored = getSettings().allowlistOverrides[allowlistKey(operationId, paramName)];
  return stored && stored.length > 0 ? stored : null;
}

/**
 * Set (or clear) the permitted subset for one param. Passing null, an empty
 * list, or the full base list clears the restriction — an override is only ever
 * stored when it is a genuine, non-empty narrowing, which keeps semantics clean
 * and prevents an accidental soft-lock (deselect-all ≠ block everything).
 */
export function setAllowlistOverride(
  operationId: string,
  paramName: string,
  values: string[] | null,
  base?: string[],
): GlobalSettings {
  const current = getSettings();
  const next: Record<string, string[]> = { ...current.allowlistOverrides };
  const key = allowlistKey(operationId, paramName);
  const unique = values ? [...new Set(values.map(String))] : [];
  const isFullOrEmpty = unique.length === 0 || (base !== undefined && unique.length >= base.length);
  if (isFullOrEmpty) delete next[key];
  else next[key] = unique;
  const settings: GlobalSettings = { ...current, allowlistOverrides: next };
  writeRaw(JSON.stringify(settings));
  return settings;
}

/**
 * The values L1 may actually pick for a param: the manifest allowlist narrowed
 * by any admin override. Always a subset of `base` — an override can never widen
 * beyond what the Terraform supports.
 */
export function narrowAllowlist(operationId: string, paramName: string, base: string[]): string[] {
  const override = getAllowlistOverride(operationId, paramName);
  if (!override) return base;
  const permitted = new Set(override);
  return base.filter((v) => permitted.has(v));
}

/* ── Notification channels ───────────────────────
 * Advisory (local store, same as every other group here) — a real ccp-api
 * keeps the same shape server-side. Every write records an audit entry so
 * "who added/removed which channel, when" is always answerable. */

export function getNotificationChannels(): NotificationChannel[] {
  return getSettings().notifications.channels;
}

export function addNotificationChannel(input: Omit<NotificationChannel, 'id'>): GlobalSettings {
  const current = getSettings();
  const channel: NotificationChannel = { id: crypto.randomUUID(), ...input, events: [...input.events] };
  const next: GlobalSettings = {
    ...current,
    notifications: { channels: [...current.notifications.channels, channel] },
  };
  writeRaw(JSON.stringify(next));
  recordAudit(getCurrentUser().id, 'Added notification channel', `${channel.kind} → ${channel.target}`);
  return next;
}

export function removeNotificationChannel(id: string): GlobalSettings {
  const current = getSettings();
  const removed = current.notifications.channels.find((c) => c.id === id);
  const next: GlobalSettings = {
    ...current,
    notifications: { channels: current.notifications.channels.filter((c) => c.id !== id) },
  };
  writeRaw(JSON.stringify(next));
  if (removed) {
    recordAudit(getCurrentUser().id, 'Removed notification channel', `${removed.kind} → ${removed.target}`);
  }
  return next;
}

/* ── Maintenance windows ─────────────────────────
 * Informational until ccp-api enforces them — nothing today blocks a
 * submission against one; the render layer just surfaces them. */

export function getMaintenanceWindows(): MaintenanceWindow[] {
  return getSettings().maintenanceWindows;
}

export function addMaintenanceWindow(input: Omit<MaintenanceWindow, 'id'>): GlobalSettings {
  const current = getSettings();
  const window: MaintenanceWindow = { id: crypto.randomUUID(), ...input };
  const next: GlobalSettings = { ...current, maintenanceWindows: [...current.maintenanceWindows, window] };
  writeRaw(JSON.stringify(next));
  recordAudit(getCurrentUser().id, 'Added maintenance window', `${window.label} · ${window.cron} (${window.tz})`);
  return next;
}

export function removeMaintenanceWindow(id: string): GlobalSettings {
  const current = getSettings();
  const removed = current.maintenanceWindows.find((w) => w.id === id);
  const next: GlobalSettings = {
    ...current,
    maintenanceWindows: current.maintenanceWindows.filter((w) => w.id !== id),
  };
  writeRaw(JSON.stringify(next));
  if (removed) recordAudit(getCurrentUser().id, 'Removed maintenance window', removed.label);
  return next;
}

/* ── Limits ──────────────────────────────────────────────── */

export function getLimits(): Limits {
  return getSettings().limits;
}

function summarizeLimits(l: Limits): string {
  return `${l.sessionAbsoluteHours}h session · ${l.sessionIdleMinutes}m idle · ${l.submissionsPerHour}/h submissions · ${l.maxOpenPerUser} open/user`;
}

/** Merge onto the current limits and clamp (never partially applied — every
 * field in the result is always in-bounds, see {@link clampLimits}). */
export function setLimits(partial: Partial<Limits>): GlobalSettings {
  const current = getSettings();
  const next: GlobalSettings = { ...current, limits: clampLimits({ ...current.limits, ...partial }) };
  writeRaw(JSON.stringify(next));
  recordAudit(getCurrentUser().id, 'Updated session/submission limits', summarizeLimits(next.limits));
  return next;
}

/** Test-only reset. */
export function resetSettingsForTests(): void {
  writeRaw(JSON.stringify(DEFAULT_SETTINGS));
}
