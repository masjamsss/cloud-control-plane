import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAudit, resetAuditForTests } from '@/lib/audit';
import {
  PENDING_CHANGES_CAP,
  acknowledgePendingChange,
  getPendingChange,
  listPendingChanges,
  pendingCount,
  proposePendingChange,
  rejectPendingChange,
  resetPendingChangesForTests,
  subscribePendingChangesChanged,
  summarizePending,
} from '@/lib/pendingChanges';
import { PendingChangesBanner } from '@/components/PendingChangesBanner';

/**
 * Task 4 (6-admin-complete-control): the dual-control queue render layer
 * (api spec §6 / admin-multiproject §1.2). `pendingChanges.ts` is a local
 * advisory store — nothing today proposes one from a real write path (Task
 * 2's setters still apply immediately; §0 keeps every write local either
 * way), so `proposePendingChange` exists for fixtures/tests and for the
 * render layer to have something to show ahead of the real ccp-api B6
 * state machine.
 */

beforeEach(() => {
  resetPendingChangesForTests();
  resetAuditForTests();
});

function propose(overrides: Partial<Parameters<typeof proposePendingChange>[0]> = {}) {
  return proposePendingChange({
    proposedBy: 'putra',
    kind: 'limits',
    before: 50,
    after: 80,
    targetKey: 'limits.submissionsPerHour',
    ...overrides,
  });
}

describe('pendingChanges store — list/get', () => {
  it('starts empty', () => {
    expect(listPendingChanges()).toEqual([]);
    expect(pendingCount()).toBe(0);
  });

  it('proposing a change makes it listable and gettable, status PENDING', () => {
    const created = propose();
    expect(created.status).toBe('PENDING');
    expect(created.id).toBeTruthy();
    expect(listPendingChanges()).toHaveLength(1);
    expect(getPendingChange(created.id)).toMatchObject({
      proposedBy: 'putra',
      kind: 'limits',
      before: 50,
      after: 80,
      targetKey: 'limits.submissionsPerHour',
    });
  });

  it('lists newest-first', () => {
    const first = propose({ targetKey: 'a' });
    const second = propose({ targetKey: 'b' });
    const ids = listPendingChanges().map((c) => c.id);
    expect(ids[0]).toBe(second.id);
    expect(ids[1]).toBe(first.id);
  });

  it('getPendingChange returns undefined for an unknown id', () => {
    expect(getPendingChange('no-such-id')).toBeUndefined();
  });

  it('pendingCount only counts PENDING items', () => {
    const a = propose({ targetKey: 'a' });
    propose({ targetKey: 'b' });
    expect(pendingCount()).toBe(2);
    acknowledgePendingChange(a.id);
    expect(pendingCount()).toBe(1);
  });
});

describe('pendingChanges store — bounded storage (0014 scalability finding #2)', () => {
  it('never exceeds PENDING_CHANGES_CAP even when proposals go well past it', () => {
    for (let i = 0; i < PENDING_CHANGES_CAP + 50; i++) propose({ targetKey: `k${i}` });
    expect(listPendingChanges()).toHaveLength(PENDING_CHANGES_CAP);
  });

  it('prunes oldest-first, keeping a contiguous newest-CAP window', () => {
    const overflow = 3;
    const proposed = Array.from({ length: PENDING_CHANGES_CAP + overflow }, (_, i) =>
      propose({ targetKey: `k${i}` }),
    );

    const remaining = listPendingChanges();
    expect(remaining).toHaveLength(PENDING_CHANGES_CAP);
    const remainingIds = new Set(remaining.map((c) => c.id));

    // The `overflow` OLDEST proposals (the first ones made) are gone.
    for (let i = 0; i < overflow; i++) {
      expect(remainingIds.has(proposed[i]!.id), `k${i} should have been pruned`).toBe(false);
      expect(getPendingChange(proposed[i]!.id)).toBeUndefined();
    }
    // Everything from that point on (a contiguous newest-CAP window) survives —
    // no gaps, nothing dropped from the middle.
    for (let i = overflow; i < PENDING_CHANGES_CAP + overflow; i++) {
      expect(remainingIds.has(proposed[i]!.id), `k${i} should have survived`).toBe(true);
    }
  });

  it('a decision (ack/reject) on a surviving item does not exempt it from a later prune', () => {
    const decided = propose({ targetKey: 'decided' });
    acknowledgePendingChange(decided.id);
    // Fill past the cap with fresh proposals — 'decided' is now the oldest item
    // and has no special protection (ack/reject only flips status in place).
    for (let i = 0; i < PENDING_CHANGES_CAP; i++) propose({ targetKey: `k${i}` });
    expect(getPendingChange(decided.id)).toBeUndefined();
    expect(listPendingChanges()).toHaveLength(PENDING_CHANGES_CAP);
  });
});

describe('summarizePending — a pure before→after one-liner', () => {
  it('renders a scalar before/after change', () => {
    const item = propose({ targetKey: 'limits.submissionsPerHour', before: 50, after: 80 });
    expect(summarizePending(item)).toBe('limits.submissionsPerHour: 50 → 80');
  });

  it('renders booleans and missing values legibly', () => {
    const item = propose({ targetKey: 'changeFreeze', before: false, after: true });
    expect(summarizePending(item)).toBe('changeFreeze: false → true');
    const created = propose({
      targetKey: 'notifications.channels[0]',
      before: undefined,
      after: 'a@b.com',
    });
    expect(summarizePending(created)).toBe('notifications.channels[0]: — → a@b.com');
  });

  it('renders objects as compact JSON', () => {
    const item = propose({
      targetKey: 'maintenanceWindows',
      before: { label: 'W', cron: '0 2 * * *' },
      after: { label: 'W2', cron: '0 3 * * *' },
    });
    expect(summarizePending(item)).toBe(
      'maintenanceWindows: {"label":"W","cron":"0 2 * * *"} → {"label":"W2","cron":"0 3 * * *"}',
    );
  });
});

describe('acknowledge / reject — advisory local transitions', () => {
  it('acknowledging moves PENDING → ACKED and records an audit entry', () => {
    const created = propose();
    acknowledgePendingChange(created.id);
    expect(getPendingChange(created.id)?.status).toBe('ACKED');
    expect(listAudit()[0]?.action).toMatch(/acknowledged/i);
  });

  it('rejecting moves PENDING → REJECTED and records an audit entry', () => {
    const created = propose();
    rejectPendingChange(created.id);
    expect(getPendingChange(created.id)?.status).toBe('REJECTED');
    expect(listAudit()[0]?.action).toMatch(/rejected/i);
  });

  it('acknowledging an already-decided item is a no-op (does not flip REJECTED back)', () => {
    const created = propose();
    rejectPendingChange(created.id);
    acknowledgePendingChange(created.id);
    expect(getPendingChange(created.id)?.status).toBe('REJECTED');
  });

  it('acting on an unknown id does not throw', () => {
    expect(() => acknowledgePendingChange('no-such-id')).not.toThrow();
    expect(() => rejectPendingChange('no-such-id')).not.toThrow();
  });
});

describe('subscribePendingChangesChanged — the usePendingCount() external-store source (FE-7)', () => {
  it('fires on a write', () => {
    let calls = 0;
    const unsubscribe = subscribePendingChangesChanged(() => (calls += 1));
    propose();
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('fires once per write, for every kind of write (propose, acknowledge, reject)', () => {
    let calls = 0;
    const unsubscribe = subscribePendingChangesChanged(() => (calls += 1));
    const created = propose();
    expect(calls).toBe(1);
    acknowledgePendingChange(created.id);
    expect(calls).toBe(2);
    const other = propose({ targetKey: 'b' });
    rejectPendingChange(other.id);
    expect(calls).toBe(4);
    unsubscribe();
  });

  it('stops firing after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribePendingChangesChanged(() => (calls += 1));
    propose();
    expect(calls).toBe(1);
    unsubscribe();
    propose({ targetKey: 'after-unsubscribe' });
    expect(calls).toBe(1);
  });

  it('an acknowledge/reject on an unknown id (a no-op write) still does not fire — no localStorage write happened', () => {
    let calls = 0;
    const unsubscribe = subscribePendingChangesChanged(() => (calls += 1));
    acknowledgePendingChange('no-such-id');
    rejectPendingChange('no-such-id');
    expect(calls).toBe(0);
    unsubscribe();
  });
});

describe('<PendingChangesBanner> — count logic (0 → hidden)', () => {
  it('renders nothing when there are no pending items', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PendingChangesBanner)),
    );
    expect(html).toBe('');
  });

  it('renders a link with the count when items are pending', () => {
    propose({ targetKey: 'a' });
    propose({ targetKey: 'b' });
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PendingChangesBanner)),
    );
    expect(html).toContain('2');
    expect(html).toMatch(/<a[^>]*href="\/admin\/pending-changes"/);
  });

  it('does not count ACKED/REJECTED items', () => {
    const a = propose({ targetKey: 'a' });
    propose({ targetKey: 'b' });
    acknowledgePendingChange(a.id);
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PendingChangesBanner)),
    );
    expect(html).toContain('1');
  });
});

/**
 * FE-7 — the mock branch's re-render-on-write (`usePendingCount` wired to
 * `subscribePendingChangesChanged`, tested directly above) and the server
 * branch's route-keyed refetch can't be observed through a real mount/write/
 * re-render cycle without jsdom (see TEST-7) — `renderToStaticMarkup` is a
 * one-shot render per call, so it re-reads the CURRENT store either way and
 * would pass even against the pre-fix bare `pendingCount()` call. Both
 * wirings are pinned at the source level instead, the same technique
 * router.tsx's own registration tests already use for the identical reason.
 */
describe('<PendingChangesBanner> — store/route wiring is pinned (FE-7)', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(SRC, 'components/PendingChangesBanner.tsx'), 'utf8');

  it('the mock branch reads the count through usePendingCount (a real external-store binding), not a bare pendingCount() call', () => {
    expect(source).toContain('usePendingCount');
    expect(source).not.toMatch(/authoritative \? serverCount : pendingCount\(\)/);
  });

  it('the server-count effect is keyed on the route, in addition to `authoritative`', () => {
    expect(source).toContain('useLocation');
    expect(source).toMatch(/\[authoritative,\s*location\.pathname\]/);
  });
});
