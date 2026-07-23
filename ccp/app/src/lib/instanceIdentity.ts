import { useSyncExternalStore } from 'react';
import { APP_NAME, APP_TAGLINE } from '@/brand';
import { authClient } from '@/lib/api';
import { createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * The runtime instance-identity seam (the instance-identity hybrid model —
 * see the generic-branding decision record and design spec). Resolution
 * order, first paint → steady state:
 *
 *   1. Baked default (brand.ts) — synchronous, always present: the mock/
 *      standalone answer and the pre-hydration answer.
 *   2. Cached last-known runtime identity — a browser-local,
 *      non-project-scoped cache (`ccp.instance-identity`), written every
 *      time the runtime identity resolves. Read at MODULE INIT so a cold load
 *      after a prior rename never flashes the stale baked/old name.
 *   3. Runtime identity — in api mode, the ONE boot-time `GET /instance`
 *      (unauthenticated), resolved once and adopted everywhere. Mock mode
 *      never calls out (authClient is null there — the standalone-parity
 *      invariant): the resolved identity stays byte-for-byte the baked
 *      layer, zero network.
 *
 * `getInstanceIdentity()` is the synchronous getter for module-scope/
 * render-time reads that do not need live re-render on a later rename (body
 * copy assembled per render or per call — BeyondCatalogForm, NotInControlPlane,
 * palette/boundary entries). `useInstanceIdentity()` is the subscribed hook
 * for durable CHROME surfaces that must repaint immediately after a Settings
 * rename with no reload (AppShell wordmark + document.title, LoginPage,
 * FirstRunPage, TOTP enrollment copy).
 */

export interface InstanceIdentity {
  name: string;
  tagline: string;
}

/** Browser-local cache key — deliberately NOT project-scoped (identity is
 * global, sibling to the accounts partition, never per-estate). */
export const INSTANCE_IDENTITY_CACHE_KEY = 'ccp.instance-identity';

const emitter = createEmitter();
const memory = new Map<string, string>();

function bakedIdentity(): InstanceIdentity {
  return { name: APP_NAME, tagline: APP_TAGLINE };
}

function readCache(): InstanceIdentity | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(INSTANCE_IDENTITY_CACHE_KEY);
  } catch {
    raw = memory.get(INSTANCE_IDENTITY_CACHE_KEY) ?? null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceIdentity>;
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null;
    return { name: parsed.name, tagline: typeof parsed.tagline === 'string' ? parsed.tagline : '' };
  } catch {
    return null;
  }
}

function writeCache(identity: InstanceIdentity): void {
  const raw = JSON.stringify(identity);
  try {
    localStorage.setItem(INSTANCE_IDENTITY_CACHE_KEY, raw);
  } catch {
    memory.set(INSTANCE_IDENTITY_CACHE_KEY, raw);
  }
  // Same-tab notification (the native `storage` event never fires in the
  // document that made the write — lib/useStore.ts's module doc).
  emitter.emit();
}

// Module-scope resolved identity: the cached last-known value (if any)
// overrides the baked default at MODULE INIT — kills the flash-of-old-name on
// a cold load after a prior rename. A successful boot resolve overrides it
// again below.
let current: InstanceIdentity = readCache() ?? bakedIdentity();

/** The current best-known identity — synchronous, always present. For
 * render-path/module-scope code that rebuilds its own copy per call (never
 * cached in a module-scope literal — that would freeze it at import time). */
export function getInstanceIdentity(): InstanceIdentity {
  return current;
}

function adopt(identity: InstanceIdentity): void {
  current = identity;
  writeCache(identity);
}

let bootStarted = false;

/**
 * Kick off the ONE boot-time `GET /instance` (api mode only — `authClient` is
 * null in mock mode, so this is a no-op there: the standalone-parity
 * invariant, zero network in a standalone build). Idempotent — safe to call
 * from every subscriber; only the first call does anything. A resolved
 * `{name: null}` (no INSTANCE item seeded yet) leaves the baked/cached layer
 * untouched, matching the design.
 */
export function ensureInstanceIdentityLoaded(): void {
  if (bootStarted || !authClient) return;
  bootStarted = true;
  void authClient
    .getInstance()
    .then((resolved) => {
      if (resolved.name) adopt({ name: resolved.name, tagline: resolved.tagline ?? '' });
    })
    .catch(() => {
      // A network hiccup at boot stays on the baked/cached layer — never
      // worse than what already painted.
    });
}

/** After a Settings/first-run rename succeeds, adopt the server's own echoed
 * identity everywhere immediately — no rebuild, no re-resolve. */
export function adoptInstanceIdentity(identity: InstanceIdentity): void {
  adopt(identity);
}

/** Test-only reset — a fresh module-scope baseline for isolated test files. */
export function resetInstanceIdentityForTests(): void {
  current = bakedIdentity();
  bootStarted = false;
  try {
    localStorage.removeItem(INSTANCE_IDENTITY_CACHE_KEY);
  } catch {
    memory.delete(INSTANCE_IDENTITY_CACHE_KEY);
  }
}

/** Exported for direct testability (no jsdom/RTL in this repo — see
 * test/standalone.test.ts's exact dependency allowlist), same pattern as
 * lib/settings.ts's subscribeSettingsChanged: "fires on a write, stops firing
 * after unsubscribe" is provable by calling plain functions, not by mounting
 * anything. */
export const subscribeInstanceIdentityChanged = subscribeWithStorage(
  emitter,
  () => INSTANCE_IDENTITY_CACHE_KEY,
);

/**
 * Chrome-surface hook: starts the boot resolve on first subscription, then
 * renders the current best-known identity — live-updating on a rename in
 * this tab (the emitter) or a cache refresh written by another tab (the
 * native `storage` event, via subscribeWithStorage).
 */
export function useInstanceIdentity(): InstanceIdentity {
  ensureInstanceIdentityLoaded();
  return useSyncExternalStore(
    subscribeInstanceIdentityChanged,
    getInstanceIdentity,
    getInstanceIdentity,
  );
}

// Boot resolve: module import time is effectively app-boot time for this
// seam's consumers (every chrome surface imports brand.ts/this module at
// module scope already, the same doctrine lib/api.ts's own module-init side
// effect follows). A no-op in mock mode/tests (authClient is null).
ensureInstanceIdentityLoaded();
