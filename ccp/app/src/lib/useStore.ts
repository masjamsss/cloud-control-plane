/**
 * Shared external-store plumbing. The settings/session/teams
 * stores are unsubscribed module state read at render time: a
 * freeze toggled in another tab, or an admin change in this one, previously
 * only appeared after navigation happened to re-render the reader. Every
 * store below is now a proper `useSyncExternalStore` source; this file is
 * the tiny, store-agnostic plumbing they all share, kept dependency-free and
 * framework-light (no React import here) so it is directly unit-testable —
 * this app has no jsdom/RTL (see src/test/standalone.test.ts), so "subscribe
 * fires on a write, stops firing after unsubscribe" is exactly the kind of
 * thing that must be provable by calling plain functions, not by mounting
 * anything.
 *
 * Two facts drive the shape here:
 *
 * 1. A browser's native `storage` event fires in every OTHER document sharing
 *    the storage, but NEVER in the document that made the write. So cross-tab
 *    reactivity (the `storage` listener) and same-tab reactivity (a local
 *    emitter each store calls right after its own write) are both required —
 *    neither one alone is enough.
 * 2. `useSyncExternalStore`'s contract requires `getSnapshot` to return a
 *    value that is `Object.is`-stable across calls when nothing changed
 *    (otherwise React can loop re-rendering, or warn in dev). Every store's
 *    snapshot function is therefore cached and only rebuilt when its
 *    underlying raw storage string (or, for stores whose key is
 *    project-scoped, the resolved key) actually changes — never a fresh
 *    object built unconditionally on every call.
 */

/** A tiny same-tab pub/sub. */
export interface Emitter {
  subscribe(onChange: () => void): () => void;
  emit(): void;
}

export function createEmitter(): Emitter {
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

/** The exact function shape `useSyncExternalStore` wants for its first argument. */
export type StoreSubscribe = (onStoreChange: () => void) => () => void;

/**
 * Compose a store's `subscribe`: the local emitter (same-tab writes) plus the
 * browser's native `storage` event, filtered to the one storage key this
 * store cares about. `key` is a function, not a plain string, because a
 * couple of these stores are project-scoped (lib/projectScope.ts) — the
 * active project can change at runtime, so the key to watch has to be
 * re-resolved on every call, never captured once at module-init.
 *
 * Guarded for a non-browser (`window`-less) evaluation context — this repo's
 * tests run in plain Node (no jsdom) and exercise this function directly,
 * with no `window` global at all.
 */
export function subscribeWithStorage(emitter: Emitter, key: () => string): StoreSubscribe {
  return function subscribe(onStoreChange: () => void): () => void {
    const unsubscribeLocal = emitter.subscribe(onStoreChange);
    function onStorage(e: StorageEvent): void {
      // e.key === null means clear() was called in another tab — always
      // treat that as a change, since we can no longer tell what it held.
      if (e.key === null || e.key === key()) onStoreChange();
    }
    const hasWindow = typeof window !== 'undefined';
    if (hasWindow) window.addEventListener('storage', onStorage);
    return () => {
      unsubscribeLocal();
      if (hasWindow) window.removeEventListener('storage', onStorage);
    };
  };
}

/**
 * Merge several `subscribe` functions into one — for a store whose snapshot
 * depends on more than one underlying emitter (the session store's User
 * snapshot changes if EITHER the session/credential store OR the account
 * roster changes).
 */
export function combineSubscriptions(...subs: StoreSubscribe[]): StoreSubscribe {
  return function subscribe(onStoreChange: () => void): () => void {
    const unsubs = subs.map((s) => s(onStoreChange));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  };
}
