import { afterEach, describe, expect, it } from 'vitest';
import { APP_NAME, APP_TAGLINE } from '@/brand';
import { authClient } from '@/lib/api';
import {
  adoptInstanceIdentity,
  ensureInstanceIdentityLoaded,
  getInstanceIdentity,
  resetInstanceIdentityForTests,
  subscribeInstanceIdentityChanged,
} from '@/lib/instanceIdentity';

/**
 * ADR-0023 — the instance-identity seam. This repo has no jsdom/RTL
 * (test/standalone.test.ts's exact dependency allowlist), so these tests
 * exercise the pure/exported functions directly — same doctrine as
 * lib/settings.ts's subscribeSettingsChanged tests — rather than mounting
 * useInstanceIdentity() in a component.
 */

afterEach(() => {
  resetInstanceIdentityForTests();
});

describe('getInstanceIdentity — baked default, no runtime override', () => {
  it('resolves to brand.ts APP_NAME/APP_TAGLINE with nothing cached/adopted', () => {
    expect(getInstanceIdentity()).toEqual({ name: APP_NAME, tagline: APP_TAGLINE });
  });

  it('mock mode: authClient is null in this test build (no VITE_API_BASE) — ADR-0007 parity', () => {
    // The seam's own boot-fetch gate (ensureInstanceIdentityLoaded) is a
    // no-op whenever authClient is null — proving THIS is what keeps a mock/
    // standalone test run byte-for-byte on the baked brand, zero network.
    expect(authClient).toBeNull();
  });
});

describe('ensureInstanceIdentityLoaded — mock mode never resolves (no authClient)', () => {
  it('is a safe no-op: calling it repeatedly never throws and never changes the identity', () => {
    expect(() => {
      ensureInstanceIdentityLoaded();
      ensureInstanceIdentityLoaded();
      ensureInstanceIdentityLoaded();
    }).not.toThrow();
    expect(getInstanceIdentity()).toEqual({ name: APP_NAME, tagline: APP_TAGLINE });
  });
});

describe('adoptInstanceIdentity — the Settings/first-run rename path', () => {
  it('updates the synchronous getter immediately', () => {
    adoptInstanceIdentity({ name: 'Acme Cloud Control Plane', tagline: 'Change control for Acme' });
    expect(getInstanceIdentity()).toEqual({
      name: 'Acme Cloud Control Plane',
      tagline: 'Change control for Acme',
    });
  });

  it('never throws with no localStorage in this plain-Node test env — the in-memory Map fallback absorbs the write', () => {
    // This repo runs vitest under plain Node (no jsdom/RTL) — `localStorage`
    // is not a global here at all, so adopt()'s cache write must degrade to
    // the module's own in-memory fallback rather than throwing.
    expect(() =>
      adoptInstanceIdentity({ name: 'Acme Cloud Control Plane', tagline: '' }),
    ).not.toThrow();
    expect(getInstanceIdentity().name).toBe('Acme Cloud Control Plane');
  });

  it('a subsequent read (e.g. another consumer calling getInstanceIdentity()) sees the adopted value, not a stale one', () => {
    adoptInstanceIdentity({ name: 'First', tagline: '' });
    adoptInstanceIdentity({ name: 'Second', tagline: 'x' });
    expect(getInstanceIdentity()).toEqual({ name: 'Second', tagline: 'x' });
  });
});

describe('subscribeInstanceIdentityChanged — the useInstanceIdentity() external-store source', () => {
  it('fires on adoptInstanceIdentity', () => {
    let calls = 0;
    const unsubscribe = subscribeInstanceIdentityChanged(() => (calls += 1));
    adoptInstanceIdentity({ name: 'Acme', tagline: '' });
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('unsubscribing stops further notifications', () => {
    let calls = 0;
    const unsubscribe = subscribeInstanceIdentityChanged(() => (calls += 1));
    unsubscribe();
    adoptInstanceIdentity({ name: 'Acme', tagline: '' });
    expect(calls).toBe(0);
  });
});

describe('resetInstanceIdentityForTests — isolation between test files', () => {
  it('restores the baked default and re-arms the boot-resolve gate', () => {
    adoptInstanceIdentity({ name: 'Acme', tagline: 'x' });
    expect(getInstanceIdentity().name).toBe('Acme');
    resetInstanceIdentityForTests();
    expect(getInstanceIdentity()).toEqual({ name: APP_NAME, tagline: APP_TAGLINE });
  });
});
