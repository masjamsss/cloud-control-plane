import { useSyncExternalStore } from 'react';
import type { User } from '@/types';
import { currentUser, currentUserId, subscribeSessionChanged } from '@/lib/auth';
import { toUser, subscribeAccountsChanged } from '@/lib/accounts';
import { subscribeApiSessionChanged } from '@/lib/apiSession';
import { combineSubscriptions } from '@/lib/useStore';

/**
 * Thin compatibility shim over the real session (lib/auth) + account store
 * (lib/accounts). Existing screens call getCurrentUser()/currentUserId() and get
 * a plain User; identity, credentials and enrolment live in those modules now.
 */

const ANON: User = { id: 'anonymous', name: 'Signed out', role: 'requester', teamId: '' };

/** The signed-in user as a plain User. Routes are guarded, so behind the app
 * shell this is always a real account; ANON is only a defensive fallback. */
export function getCurrentUser(): User {
  const account = currentUser();
  return account ? toUser(account) : ANON;
}

export { currentUserId };

// ── useSyncExternalStore binding ──────────────────────────────
// getCurrentUser() above stays exactly as it was — every recordAudit(…) /
// submit-time caller keeps a plain, always-fresh read, unchanged. This is a
// SEPARATE cache used only by useCurrentUser() below: auth.ts's
// currentUser()/getByUsername() rebuild fresh objects from a fresh JSON.parse
// every call regardless of whether anything changed, so instead of caching by
// reference (which would never hit), this caches by VALUE — the projected
// User's fields are compared to the previous snapshot, and the OLD object
// reference is reused when they're equal. That's what makes this a
// well-behaved useSyncExternalStore source (see lib/useStore.ts's module doc).
let cachedUser: User | undefined;

function usersEqual(a: User, b: User): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.role === b.role &&
    a.teamId === b.teamId &&
    a.isAdmin === b.isAdmin
  );
}

function computeUserSnapshot(): User {
  const next = getCurrentUser();
  if (cachedUser !== undefined && usersEqual(cachedUser, next)) return cachedUser;
  cachedUser = next;
  return cachedUser;
}

// The signed-in User can change because the session/credential store changed
// (sign in/out, expiry), because the api-mode session bridge changed (login/
// TOTP/me, logout), OR because an admin edited the account itself (role,
// team, isAdmin) — all three are independent stores, so all three are
// subscribed.
const subscribeUser = combineSubscriptions(
  subscribeSessionChanged,
  subscribeApiSessionChanged,
  subscribeAccountsChanged,
);

/** React binding for "who is signed in" — see settings.ts's
 * useSettings() for the getServerSnapshot/no-jsdom rationale, identical here. */
export function useCurrentUser(): User {
  return useSyncExternalStore(subscribeUser, computeUserSnapshot, computeUserSnapshot);
}
