import { useSyncExternalStore } from 'react';
import type { Account } from '@/lib/accounts';
import { clearReauth, getByUsername, noteSignIn, noteSignOut, subscribeAccountsChanged, verifyPassword } from '@/lib/accounts';
import { clearApiSession, getApiSessionAccount, isApiMode, subscribeApiSessionChanged } from '@/lib/apiSession';
import { combineSubscriptions, createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * The session. Owns "who is signed in", persisted across reloads. Replaces the
 * old dev role-switcher. Fail-closed: a disabled account or a bad password both
 * return the same generic result, never revealing which was wrong.
 */

const SESSION_KEY = 'ccp.session.v1';

/** Absolute lifetime and idle timeout. A real ccp-api keeps the same limits
 * server-side on an opaque token; here they gate the local session. */
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000; // 12h absolute
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30m idle

interface Session {
  userId: string;
  issuedAt: string;
  lastSeenAt: string;
}

const memory = new Map<string, string>();
/** Same-tab write notifications — fired only on an actual
 * identity change (sign-in, sign-out, expiry), never on the idle-window
 * slide below, so a live useCurrentUser() subscriber isn't woken on every
 * single read. See lib/useStore.ts's module doc for the same-tab-vs-cross-tab
 * split this composes with. */
const emitter = createEmitter();
export const subscribeSessionChanged = subscribeWithStorage(emitter, () => SESSION_KEY);

function read(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return memory.get(SESSION_KEY) ?? null;
  }
}
function write(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, value);
  } catch {
    if (value === null) memory.delete(SESSION_KEY);
    else memory.set(SESSION_KEY, value);
  }
}

function currentSession(): Session | null {
  const raw = read();
  if (!raw) return null;
  let parsed: Session;
  try {
    parsed = JSON.parse(raw) as Session;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.userId !== 'string') return null;

  const now = Date.now();
  const issued = Date.parse(parsed.issuedAt);
  const lastSeen = Date.parse(parsed.lastSeenAt ?? parsed.issuedAt);
  // Expire on absolute lifetime or idle timeout — fail closed on a bad clock/value.
  if (!Number.isFinite(issued) || now - issued > MAX_SESSION_MS) {
    write(null);
    emitter.emit(); // identity change: signed in → signed out
    return null;
  }
  if (!Number.isFinite(lastSeen) || now - lastSeen > IDLE_TIMEOUT_MS) {
    write(null);
    emitter.emit(); // identity change: signed in → signed out
    return null;
  }
  // Slide the idle window forward on activity. Deliberately no emitter.emit()
  // here — this runs on every single read (every getCurrentUser() call), and
  // nothing about the signed-in identity changed, just its timestamp.
  const refreshed: Session = { ...parsed, lastSeenAt: new Date(now).toISOString() };
  write(JSON.stringify(refreshed));
  return refreshed;
}

/** The signed-in account, or null. Null if the session's account is gone/disabled. */
export function currentUser(): Account | null {
  // Authoritative mode: identity is the server session (httpOnly cookie), mirrored
  // into the api-session bridge by the login/TOTP/me flow. The local PBKDF2 store
  // below is never consulted here — a real ccp-api owns who is signed in.
  if (isApiMode) {
    const account = getApiSessionAccount();
    return account && account.status === 'active' ? account : null;
  }
  const session = currentSession();
  if (!session) return null;
  const account = getByUsername(session.userId) ?? undefined;
  if (!account || account.status !== 'active') return null;
  return account;
}

/**
 * SUBSCRIBED "who is signed in" — the same answer {@link currentUser} gives, but as a
 * React binding that re-renders when it changes (FE-5).
 *
 * `currentUser()` is an unsubscribed read. A component calling it sees whatever was true
 * at its last render and is never told the answer changed, so `RequireAuth` kept rendering
 * the app long after the session ended: identity in api mode is the in-memory
 * `apiSession` cache, and nothing outside an explicit logout cleared it. Sessions expire
 * at 12h absolute / 30m idle, so the ordinary path was — idle past the window, click
 * anything, every fetch 401s, and the guard (reading the still-populated cache) keeps the
 * user on a page where nothing works. Recovery meant a manual full reload.
 *
 * Subscribing is only half; the other half is in `httpApi.ts`, which now CLEARS the cache
 * on a session-class 401. Together: the 401 clears, the emit fires, this hook re-renders,
 * and the guard redirects to /login. Either half alone leaves the zombie UI.
 *
 * It also closes a second blindness the finding notes in passing: an unsubscribed guard
 * cannot see a cross-tab sign-out either, and `subscribeSessionChanged` is storage-backed
 * precisely so it can.
 */
export function useAuthedAccount(): Account | null {
  return useSyncExternalStore(subscribeAuthChanged, currentUser, currentUser);
}

/** Every store that can change the answer to "who is signed in". */
export const subscribeAuthChanged = combineSubscriptions(
  subscribeSessionChanged,
  subscribeApiSessionChanged,
  subscribeAccountsChanged,
);

export function currentUserId(): string | null {
  return currentUser()?.id ?? null;
}

export function isAuthenticated(): boolean {
  return currentUser() !== null;
}

export type LoginResult =
  | { ok: true; user: Account; mustChangePassword: boolean }
  | { ok: false; reason: string };

const GENERIC = 'Wrong username or password.';

export async function login(username: string, password: string): Promise<LoginResult> {
  const account = getByUsername(username);
  // Verify even when the account is missing/disabled to avoid a timing signal…
  const ok = account ? await verifyPassword(account, password) : false;
  if (!account || account.status !== 'active' || !ok) {
    return { ok: false, reason: GENERIC };
  }
  const nowIso = new Date().toISOString();
  write(
    JSON.stringify({
      userId: account.username,
      issuedAt: nowIso,
      lastSeenAt: nowIso,
    } as Session),
  );
  // Demo session bookkeeping: this sign-in now counts against the account's
  // sessions, so the admin "Revoke sessions" action acts on real local state.
  noteSignIn(account.id);
  emitter.emit(); // identity change: signed out → signed in
  return { ok: true, user: account, mustChangePassword: account.mustChangePassword === true };
}

export function signOut(): void {
  // Demo session bookkeeping (local sessions only): this session ends, so the
  // account's session count drops by one. Api mode never touches the local
  // account store — the server owns its sessions.
  if (!isApiMode) {
    const user = currentUser();
    if (user) noteSignOut(user.id);
  }
  write(null);
  emitter.emit(); // identity change: signed in → signed out
  // Clear the api-session bridge too (inert in mock mode, where it was never set).
  // The server cookie is killed separately by the api logout call in AccountMenu.
  clearApiSession();
  // A re-auth elevation never survives sign-out — mock mode's in-memory
  // mirror (lib/accounts.ts) follows the same rule. Harmless (a no-op read)
  // in api mode, where the elevation lives server-side on the session.
  clearReauth();
}
