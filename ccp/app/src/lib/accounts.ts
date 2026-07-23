import type { Role, User } from '@/types';
import { SEED_ACCOUNTS, SEED_ACCOUNT_DEFAULT_PASSWORD, SEED_LEAD } from '@/config';
import { APP_NAME } from '@/brand';
import { createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * The local account store — the "backend setting for local enrollment".
 * Accounts persist in the browser and passwords are kept ONLY as salted PBKDF2
 * hashes (WebCrypto) — never plaintext. Every function here is the exact shape a
 * real `ccp-api` would expose over a server DB, so the swap is 1:1.
 *
 * Isolation: this module owns identity + credentials. The change-request API
 * (lib/api.ts) and the session (lib/auth.ts) depend on it, not the reverse.
 */

export interface Account {
  id: string; // stable — equals the username, so historical request authorship lines up
  username: string; // unique, lowercased handle — the login id
  displayName: string;
  role: Role;
  teamId: string;
  passwordHash: string; // base64(PBKDF2-SHA256 derived key)
  salt: string; // base64(16 random bytes)
  iterations: number;
  status: 'active' | 'disabled';
  createdAt: string;
  createdBy: string; // enrolling account id, or 'system' for the seed
  /**
   * True when the account must set a new password before it can be used —
   * set on the bootstrap seed (so the documented default cannot linger) and on
   * every admin-initiated reset. Cleared only when the user changes it themselves.
   */
  mustChangePassword?: boolean;
  /** Governance capability, separate from role. Admins control the
   * admin area (settings, users, policy). Granted by another admin. */
  isAdmin?: boolean;
  /** Admin-set 2FA override. `undefined` = use the role default. The Users
   * screen renders the effective per-user "2FA required" state from it and —
   * in a mock build — pins it here via {@link setTotpRequired}; in api mode
   * the server record is the source of truth. */
  totpRequired?: boolean;
  /** The authoritative PER-ACCOUNT role map: `{ [accountId | '*']: { role,
   * teamId? } }`. Server-sourced only (api mode) — the multi-account role +
   * scope assignment panel reads it to show every (scope, role) the user holds.
   * `undefined` on mock/demo rows (the local store is single-account); the
   * scalar `role`/`teamId` above are then the whole truth. */
  roles?: Record<string, { role: Role; teamId?: string }>;
  /**
   * Demo stand-in for the server's login-2FA enrolment state: true once this
   * account has an authenticator set up. Seeded true for privileged accounts
   * (the server forces those to enrol at first sign-in), so the admin
   * "Reset TOTP" action has real state to clear. Api mode never reads this —
   * ccp-api keeps the real enrolment.
   */
  totpEnrolled?: boolean;
  /**
   * Demo stand-in for the server's per-account session store: how many
   * signed-in sessions this account has. Seeded non-zero, bumped by each local
   * sign-in, and cleared by the admin "Revoke sessions" / "Reset TOTP"
   * actions so both visibly act on real local state. Api mode never reads
   * this — ccp-api keeps the real sessions.
   */
  activeSessions?: number;
  /**
   * Multi-device 2FA mock mirror: named devices — the standing Account &
   * security page's device manager acts on this in a mock build. Additive
   * alongside {@link totpEnrolled} (kept in sync at every write site here,
   * never diverges): `totpEnrolled` stays the boolean every existing reader
   * (Users admin, seeding) already uses, this is the richer list the NEW
   * per-device UI needs (name, id, enrolled-at). Seeded privileged rows get
   * one device named "Authenticator" (today's boolean seed, upgraded).
   */
  totpDevices?: Array<{ id: string; name: string; enrolledAt: string }>;
  /**
   * Recovery-code mock mirror: COUNTS ONLY, mirroring the server's own
   * doctrine (no real hashes stored client-side; there is nothing sensitive
   * to protect in a mock build, but the SHAPE is honest about what a real
   * deployment would ever expose). `undefined` = never generated (no 2FA
   * active yet, or reset).
   */
  recovery?: { remaining: number; generatedAt: string };
}

export interface EnrollInput {
  username: string;
  displayName: string;
  role: Role;
  teamId: string;
  password: string;
}

export const MIN_PASSWORD = 8;
const ITERATIONS = 210_000;
const STORE_KEY = 'ccp.accounts.v1';
// Bump whenever the seeded roster or its passwords change (project.json
// seedLead/seedAccounts). ensureSeeded only ever seeds an EMPTY store, so a
// browser opened BEFORE a roster change keeps the stale seed and the new
// name-password logins fail. Recording the version an existing store was seeded
// at lets ensureSeeded detect that staleness and refresh the MOCK demo store to
// the canonical roster on next load. A bump RESETS the mock store to the seed;
// real api-mode identities live in the durable ccp-api store and are
// untouched by any of this.
// v4 (account & security center): privileged rows also seed totpDevices[] +
// recovery so the new Account & security page has real demo state to show.
const SEED_VERSION = 4;
const SEED_VERSION_KEY = 'ccp.accounts.seedVersion';

/* ── Storage (localStorage, with an in-memory fallback for tests/SSR) ───────── */

const memory = new Map<string, string>();
/** Same-tab write notifications — session.ts's useCurrentUser()
 * subscribes to this too: an admin edit to YOUR OWN account (role, team,
 * isAdmin) changes what getCurrentUser() projects, even though the session
 * token itself didn't change. See lib/useStore.ts's module doc. */
const emitter = createEmitter();
function readRaw(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return memory.get(STORE_KEY) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(STORE_KEY, value);
  } catch {
    memory.set(STORE_KEY, value);
  }
  emitter.emit();
}
function readSeedVersion(): number {
  try {
    return Number(localStorage.getItem(SEED_VERSION_KEY)) || 0;
  } catch {
    return Number(memory.get(SEED_VERSION_KEY)) || 0;
  }
}
function writeSeedVersion(v: number): void {
  try {
    localStorage.setItem(SEED_VERSION_KEY, String(v));
  } catch {
    memory.set(SEED_VERSION_KEY, String(v));
  }
}

/** Subscribe to account-roster changes (this tab's writes + other tabs',
 * via the native `storage` event) — composed into session.ts's
 * useCurrentUser() and available for any future accounts-list reader. */
export const subscribeAccountsChanged = subscribeWithStorage(emitter, () => STORE_KEY);

function load(): Account[] {
  const raw = readRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Account[]) : [];
  } catch {
    return [];
  }
}
function save(accounts: Account[]): void {
  writeRaw(JSON.stringify(accounts));
}

/* ── Password hashing (salted PBKDF2-SHA256 via WebCrypto) ──────────────────── */

const subtle = globalThis.crypto.subtle;

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

async function hashPassword(
  password: string,
): Promise<Pick<Account, 'passwordHash' | 'salt' | 'iterations'>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derive(password, salt, ITERATIONS);
  return { passwordHash, salt: bytesToB64(salt), iterations: ITERATIONS };
}

/** Constant-time compare of two equal-length base64 strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(account: Account, password: string): Promise<boolean> {
  const candidate = await derive(password, b64ToBytes(account.salt), account.iterations);
  return timingSafeEqual(candidate, account.passwordHash);
}

/* ── Reads ──────────────────────────────────────────────────────────────────── */

export function listAccounts(): Account[] {
  return load().sort((a, b) => a.displayName.localeCompare(b.displayName));
}
export function getAccount(id: string): Account | undefined {
  return load().find((a) => a.id === id);
}
export function getByUsername(username: string): Account | undefined {
  const u = username.trim().toLowerCase();
  return load().find((a) => a.username === u);
}
export function toUser(account: Account): User {
  return {
    id: account.id,
    name: account.displayName,
    role: account.role,
    teamId: account.teamId,
    isAdmin: account.isAdmin === true,
  };
}

/** Display name for an id — falls back to a humanized id for not-yet-enrolled authors. */
export function resolveName(id: string): string {
  const found = getAccount(id);
  if (found) return found.displayName;
  return id
    .split(/[._-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || id;
}

function activeLeads(accounts: Account[], excludeId?: string): Account[] {
  return accounts.filter((a) => a.role === 'lead' && a.status === 'active' && a.id !== excludeId);
}

function activeAdmins(accounts: Account[], excludeId?: string): Account[] {
  return accounts.filter((a) => a.isAdmin === true && a.status === 'active' && a.id !== excludeId);
}

/** Grant or revoke the admin capability. Cannot remove the last active
 * admin — governance would be un-recoverable. */
export function setAdmin(id: string, isAdmin: boolean): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (!isAdmin && account.isAdmin && account.status === 'active' && activeAdmins(accounts, id).length === 0) {
    throw new EnrollError('Cannot remove the last active admin — the admin area would be unreachable.');
  }
  account.isAdmin = isAdmin;
  save(accounts);
}

/* ── Writes (validate + persist) ────────────────────────────────────────────── */

export class EnrollError extends Error {}

export async function enroll(input: EnrollInput, byId: string): Promise<Account> {
  const username = input.username.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    throw new EnrollError('Username must be 2–32 chars: letters, numbers, dot, dash, underscore.');
  }
  if (!displayName) throw new EnrollError('Display name is required.');
  if (input.password.length < MIN_PASSWORD) {
    throw new EnrollError(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  const accounts = load();
  if (accounts.some((a) => a.username === username)) {
    throw new EnrollError(`Username “${username}” is already taken.`);
  }
  const secret = await hashPassword(input.password);
  const account: Account = {
    id: username,
    username,
    displayName,
    role: input.role,
    teamId: input.teamId,
    ...secret,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: byId,
    // Parity with the server (api/src/routes/admin.ts's account-enroll route:
    // `mustChangePassword: true`) — OP-2: an admin-chosen starting password
    // must be rotated by the person it belongs to. Before this the SPA store
    // never set the flag (only resetPassword did), so an admin-enrolled
    // teammate in standalone mode signed in with the admin's password
    // forever, and the admin permanently knew a live credential.
    mustChangePassword: true,
  };
  accounts.push(account);
  save(accounts);
  return account;
}

/** Admin-initiated reset: forces the user to change it on next sign-in. */
export async function resetPassword(id: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD) {
    throw new EnrollError(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  Object.assign(account, await hashPassword(newPassword));
  account.mustChangePassword = true;
  save(accounts);
}

/**
 * The user setting their OWN password — verify-first (the standing account
 * & security card requires proving the current password), then clears the
 * must-change flag. The forced first-login flow passes the password it
 * already holds (proven at login moments earlier); the standing Account
 * page's card genuinely re-proves it here — this current-password check IS
 * the re-authentication for this one action, mirrored in mock mode too: no
 * separate reauth gate on top.
 */
export async function changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD) {
    throw new EnrollError(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (!(await verifyPassword(account, currentPassword))) {
    throw new EnrollError('Wrong username or password.');
  }
  Object.assign(account, await hashPassword(newPassword));
  account.mustChangePassword = false;
  save(accounts);
}

export function setStatus(id: string, status: Account['status']): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (status === 'disabled' && account.role === 'lead' && activeLeads(accounts, id).length === 0) {
    throw new EnrollError('Cannot disable the last active Lead — enrolment would be impossible.');
  }
  account.status = status;
  save(accounts);
}

/** Change a user's role. Cannot demote the last active Lead (governance would stall). */
export function setRole(id: string, role: Role): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (
    account.role === 'lead' &&
    role !== 'lead' &&
    account.status === 'active' &&
    activeLeads(accounts, id).length === 0
  ) {
    throw new EnrollError('Cannot change the role of the last active Lead.');
  }
  account.role = role;
  save(accounts);
}

/** Move a user to another team. */
export function setTeam(id: string, teamId: string): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  account.teamId = teamId;
  save(accounts);
}

/** Rename a user (display name only — identity and authorization untouched). */
export function setDisplayName(id: string, displayName: string): void {
  const name = displayName.trim();
  if (!name) throw new EnrollError('Display name is required.');
  if (name.length > 80) throw new EnrollError('Display name must be 80 characters or fewer.');
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  account.displayName = name;
  save(accounts);
}

/**
 * PERMANENTLY remove an account (Disable stays the reversible option). The
 * same fail-closed guards the server enforces: never yourself, never the last
 * active admin, never the last active Lead.
 */
export function removeAccount(id: string, byId: string): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (id === byId) throw new EnrollError('You cannot delete your own account. Ask another admin to do it.');
  if (account.isAdmin === true && activeAdmins(accounts, id).length === 0) {
    throw new EnrollError('Cannot delete the last active admin — the admin area would be unreachable.');
  }
  if (account.role === 'lead' && activeLeads(accounts, id).length === 0) {
    throw new EnrollError('Cannot delete the last active Lead — assign another Lead first.');
  }
  save(accounts.filter((a) => a.id !== id));
}

/* ── Account security (demo stand-ins for ccp-api's 2FA + session state) ── */

/** What the two revoking actions report back — mirrors the server's own
 * result shape so the Users screen describes both backends the same way. */
export interface AccountSecurityResult {
  sessionsRevoked: number;
}

/** Pin this account's 2FA requirement true/false (the admin toggle's local
 * write). The effective value the row renders is derived in usersFlow's
 * `effectiveTotpRequired` — an explicit pin wins over the role default. */
export function setTotpRequired(id: string, required: boolean): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  account.totpRequired = required;
  save(accounts);
}

/** Clear this account's authenticator enrolment. Server parity: a TOTP reset
 * also revokes every live session (the old sessions were minted under the old
 * factor), and the count reported is what was actually cleared. Clears ALL
 * devices and the recovery codes with it — the admin path is unchanged in
 * meaning, widened in effect now that 2FA is multi-device. */
export function resetAccountTotp(id: string): AccountSecurityResult {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  const sessionsRevoked = account.activeSessions ?? 0;
  account.totpEnrolled = false;
  account.totpDevices = undefined;
  account.recovery = undefined;
  account.activeSessions = 0;
  save(accounts);
  return { sessionsRevoked };
}

/** Sign this account out everywhere: clear its session count. */
export function revokeAccountSessions(id: string): AccountSecurityResult {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  const sessionsRevoked = account.activeSessions ?? 0;
  account.activeSessions = 0;
  save(accounts);
  return { sessionsRevoked };
}

/** Best-effort session bookkeeping for the demo store: a local sign-in adds a
 * session, a sign-out ends one. Never throws — session bookkeeping must never
 * break the sign-in/out it decorates (mirrors recordAudit's posture). */
export function noteSignIn(id: string): void {
  try {
    const accounts = load();
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    account.activeSessions = (account.activeSessions ?? 0) + 1;
    save(accounts);
  } catch {
    /* bookkeeping only */
  }
}

export function noteSignOut(id: string): void {
  try {
    const accounts = load();
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    account.activeSessions = Math.max(0, (account.activeSessions ?? 0) - 1);
    save(accounts);
  } catch {
    /* bookkeeping only */
  }
}

/* ── Re-authentication (mock mirror) ───────────────────────────────────────
 * In-memory per-tab elevation + PBKDF2 password verify; password-only (mock
 * holds no TOTP secrets — a named parity gap, same class as the mock's
 * boolean enrolment). Deliberately module-scope, NEVER persisted to
 * localStorage: a reload always re-demands elevation, matching
 * `lib/apiSession.ts`'s own "each tab establishes its own state
 * independently" doctrine for the exact same reason. */

/** Ten minutes — the same window the server fixes on the session item;
 * duplicated here deliberately, the same "one constant per package, not
 * shared across the api/app boundary" precedent as
 * `MAX_SESSION_MS`/`IDLE_TIMEOUT_MS` in lib/auth.ts. */
export const REAUTH_MS = 10 * 60 * 1000;

/** Thrown by every ⚿-gated mock mutation below when the caller has no fresh
 * elevation — the mock-mode analogue of the server's `403 REAUTH_REQUIRED`,
 * so the SAME "call → catch → show the re-auth dialog → retry" UI flow works
 * unchanged in either mode. */
export class ReauthRequiredError extends EnrollError {}

let reauthAt: number | null = null;

/** True within {@link REAUTH_MS} of the last successful {@link reauthWithPassword}. */
export function isReauthFresh(now: number = Date.now()): boolean {
  return reauthAt !== null && now - reauthAt <= REAUTH_MS;
}

/** Re-prove the CURRENT password (mock has no TOTP secrets to check a code
 * against — password-only, by design). Success elevates this tab for
 * {@link REAUTH_MS}; failure leaves any existing elevation untouched. */
export async function reauthWithPassword(id: string, password: string): Promise<boolean> {
  const account = getAccount(id);
  const ok = account ? await verifyPassword(account, password) : false;
  if (ok) reauthAt = Date.now();
  return ok;
}

/** Drops the elevation — called on sign-out (an elevation never survives it). */
export function clearReauth(): void {
  reauthAt = null;
}

/** Test-only reset. */
export function resetReauthForTests(): void {
  reauthAt = null;
}

function requireFreshReauth(): void {
  if (!isReauthFresh()) throw new ReauthRequiredError('Please confirm it is you before continuing.');
}

/* ── Multi-device 2FA (mock mirror) ────────────────────────────────────────── */

export const MAX_TOTP_DEVICES = 5;

export interface TotpDeviceView {
  id: string;
  name: string;
  enrolledAt: string;
}

export function listTotpDevices(id: string): TotpDeviceView[] {
  return getAccount(id)?.totpDevices ?? [];
}

const DEVICE_NAME_MAX = 40;

function randomBase32Secret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC4648 base32
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Mirrors the server's begin step (`POST /auth/totp-devices`): a locally
 * generated pseudo-secret + `otpauth://` URI, real enough for the offline QR
 * renderer to paint something scannable-looking. The mock verifies NO
 * cryptographic code at confirm — it has no real TOTP secret to check a code
 * against (the same "no mock equivalent for a real secret" gap the existing
 * boolean `totpEnrolled` already named); confirm only validates the code is
 * 6 digits, matching how mock login has never included a real TOTP step.
 */
export function beginAddTotpDevice(id: string): { secret: string; otpauthUri: string } {
  requireFreshReauth();
  const account = getAccount(id);
  if (!account) throw new EnrollError('No such account.');
  if ((account.totpDevices ?? []).length >= MAX_TOTP_DEVICES) {
    throw new EnrollError('You already have 5 authenticator devices — remove one before adding another.');
  }
  const secret = randomBase32Secret();
  const label = `${encodeURIComponent(APP_NAME)}:${encodeURIComponent(account.username)}`;
  const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(APP_NAME)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUri };
}

const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I (Crockford-style, unambiguous)
const RECOVERY_CODE_COUNT = 10;

function randomRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let raw = '';
  for (const b of bytes) raw += RECOVERY_CODE_ALPHABET[b % RECOVERY_CODE_ALPHABET.length];
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

function generateMockRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, randomRecoveryCode);
}

/**
 * Confirm a device add: names it and appends it to the list (⚿ re-auth
 * required). The account's FIRST device auto-issues recovery codes,
 * returned once — the same "shown once" ceremony the server's
 * `/auth/totp-devices/confirm` response carries.
 */
export function confirmAddTotpDevice(id: string, code: string, name: string): { id: string; name: string; enrolledAt: string; recoveryCodes?: string[] } {
  requireFreshReauth();
  const trimmed = name.trim();
  if (!trimmed) throw new EnrollError('Enter a name for this device.');
  if (trimmed.length > DEVICE_NAME_MAX) throw new EnrollError(`Device name must be ${DEVICE_NAME_MAX} characters or fewer.`);
  if (!/^\d{6}$/.test(code.trim())) throw new EnrollError('Enter the 6-digit code from your authenticator app.');

  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  const existing = account.totpDevices ?? [];
  if (existing.length >= MAX_TOTP_DEVICES) {
    throw new EnrollError('You already have 5 authenticator devices — remove one before adding another.');
  }
  const device: TotpDeviceView = { id: `device-${crypto.randomUUID()}`, name: trimmed, enrolledAt: new Date().toISOString() };
  account.totpDevices = [...existing, device];
  account.totpEnrolled = true;

  let recoveryCodes: string[] | undefined;
  if (existing.length === 0) {
    const codes = generateMockRecoveryCodes();
    account.recovery = { remaining: codes.length, generatedAt: new Date().toISOString() };
    recoveryCodes = codes;
  }
  save(accounts);
  return { id: device.id, name: device.name, enrolledAt: device.enrolledAt, ...(recoveryCodes ? { recoveryCodes } : {}) };
}

/**
 * Remove a device by id (⚿ re-auth required). `isNeedsTotp` is the caller's
 * `needsTotp` mirror (`features/admin/usersFlow.ts#effectiveTotpRequired`) —
 * injected rather than imported here to keep this module's dependency
 * direction (features depend on lib, never the reverse). Refuses removing
 * the LAST device while it returns true; when the last device removal IS
 * allowed, the recovery-code set is cleared with it too.
 */
export function removeTotpDevice(
  id: string,
  deviceId: string,
  isNeedsTotp: (a: Pick<Account, 'role' | 'isAdmin' | 'totpRequired'>) => boolean,
): void {
  requireFreshReauth();
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  const devices = account.totpDevices ?? [];
  const target = devices.find((d) => d.id === deviceId);
  if (!target) throw new EnrollError('No such device.');
  const remaining = devices.filter((d) => d.id !== deviceId);
  if (remaining.length === 0 && isNeedsTotp(account)) {
    throw new EnrollError('That is your last authenticator device and 2FA is required for your account — add another before removing it.');
  }
  account.totpDevices = remaining;
  account.totpEnrolled = remaining.length > 0;
  if (remaining.length === 0) account.recovery = undefined;
  save(accounts);
}

/* ── Recovery codes (mock mirror) ──────────────────────────────────────────── */

export interface RecoveryStatus {
  remaining: number;
  generatedAt?: string;
}

/** Counts only, ever — mirrors `GET /auth/recovery-codes`. */
export function getRecoveryStatus(id: string): RecoveryStatus {
  const recovery = getAccount(id)?.recovery;
  return recovery ? { remaining: recovery.remaining, generatedAt: recovery.generatedAt } : { remaining: 0 };
}

/** Replace the WHOLE set (⚿ re-auth required); refused when no device is
 * enrolled — codes exist only while 2FA is active. */
export function regenerateRecoveryCodes(id: string): { codes: string[]; generatedAt: string } {
  requireFreshReauth();
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if ((account.totpDevices ?? []).length === 0) {
    throw new EnrollError('Set up an authenticator device before generating recovery codes.');
  }
  const codes = generateMockRecoveryCodes();
  const generatedAt = new Date().toISOString();
  account.recovery = { remaining: codes.length, generatedAt };
  save(accounts);
  return { codes, generatedAt };
}

/** Sign out every OTHER session (⚿ re-auth required) — the mock's session
 * model is a COUNT, not individual rows, so "others" means "every session
 * but the one open right now": zeroes {@link Account.activeSessions} exactly
 * like the existing admin `revokeAccountSessions`, reused here for the
 * self-service action. */
export function revokeOwnOtherSessions(id: string): AccountSecurityResult {
  requireFreshReauth();
  return revokeAccountSessions(id);
}

/* ── Seeding ────────────────────────────────────────────────────────────────── */

/**
 * First run: seed the full engineer roster so the system is usable AND
 * demonstrates real separation-of-duties out of the box — the one
 * bootstrap Lead (also admin) plus every `SEED_ACCOUNTS` entry from
 * project.json (2 more Leads/Approvers/Requesters split across the 3
 * teams). Idempotent: only runs when the store is empty, and seeds
 * everyone in a single save so a crash mid-seed can't leave a partial
 * roster half-idempotent.
 */
export async function ensureSeeded(): Promise<void> {
  if (load().length > 0) {
    // A store already exists. Keep it if it was seeded at the current version;
    // otherwise it predates a roster/password change (e.g. a browser opened
    // before the change) — reset the MOCK demo store so the current roster's
    // name-password logins work. Real api-mode accounts are never in this store.
    if (readSeedVersion() === SEED_VERSION) return;
    writeRaw('[]');
  }

  const leadSecret = await hashPassword(SEED_LEAD.defaultPassword);
  const lead: Account = {
    id: SEED_LEAD.username,
    username: SEED_LEAD.username,
    displayName: SEED_LEAD.displayName,
    role: 'lead',
    teamId: SEED_LEAD.teamId,
    ...leadSecret,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
    // MOCK-mode demo posture: the roster signs in with name-passwords as-is (no
    // forced change). Real api-mode deployment enrols each person with a strong
    // password + TOTP in the durable ccp-api store — unchanged by this seed.
    mustChangePassword: false,
    isAdmin: true, // bootstrap admin; grants the capability to others from Users
    // Demo security state: privileged accounts arrive with an authenticator
    // set up and live sessions, so Reset TOTP / Revoke sessions act on
    // something real instead of an empty store.
    totpEnrolled: true,
    totpDevices: [{ id: 'device-authenticator', name: 'Authenticator', enrolledAt: new Date().toISOString() }],
    recovery: { remaining: RECOVERY_CODE_COUNT, generatedAt: new Date().toISOString() },
    activeSessions: 2,
  };

  const rest: Account[] = [];
  for (const seed of SEED_ACCOUNTS) {
    // Per-account name-password (MOCK demo); falls back to the shared default.
    const secret = await hashPassword(seed.password ?? SEED_ACCOUNT_DEFAULT_PASSWORD);
    // Same demo security state as the bootstrap Lead: seniors (approver/lead/
    // admin) have an authenticator set up + 2 live sessions; requesters have
    // one signed-in session and no authenticator yet.
    const privileged = seed.role !== 'requester' || seed.isAdmin === true;
    rest.push({
      id: seed.username,
      username: seed.username,
      displayName: seed.displayName,
      role: seed.role,
      teamId: seed.teamId,
      ...secret,
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: 'system',
      mustChangePassword: false, // MOCK demo: name-password works as-is (see SEED_LEAD)
      ...(seed.isAdmin ? { isAdmin: true } : {}), // none today — SEED_LEAD is the only admin
      totpEnrolled: privileged,
      ...(privileged
        ? {
            totpDevices: [{ id: 'device-authenticator', name: 'Authenticator', enrolledAt: new Date().toISOString() }],
            recovery: { remaining: RECOVERY_CODE_COUNT, generatedAt: new Date().toISOString() },
          }
        : {}),
      activeSessions: privileged ? 2 : 1,
    });
  }

  save([lead, ...rest]);
  writeSeedVersion(SEED_VERSION);
}

/** Test-only: wipe the store so a test starts from a clean slate. */
export function resetStoreForTests(): void {
  writeRaw('[]');
  writeSeedVersion(0);
}

/** Test-only: plant demo security state on an account (what ensureSeeded does
 * for the roster), so security-action tests need no full re-seed. */
export function setSecurityStateForTests(
  id: string,
  state: {
    totpEnrolled?: boolean;
    activeSessions?: number;
    totpDevices?: Account['totpDevices'];
    recovery?: Account['recovery'];
  },
): void {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new EnrollError('No such account.');
  if (state.totpEnrolled !== undefined) account.totpEnrolled = state.totpEnrolled;
  if (state.activeSessions !== undefined) account.activeSessions = state.activeSessions;
  if (state.totpDevices !== undefined) account.totpDevices = state.totpDevices;
  if (state.recovery !== undefined) account.recovery = state.recovery;
  save(accounts);
}
