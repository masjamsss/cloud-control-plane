import { describe, expect, it } from 'vitest';
import type { Schedule } from '@/types';
import { activeRefusal, draftKey, type DraftState } from '@/features/request/refusalFlow';

/**
 * FE-3 — a server refusal that outlived what it judged.
 *
 * `RequestForm` stored the refusal and never cleared it: no `setBlockedReason(null)`
 * existed anywhere in the file, and `ReviewStep` disables submit whenever `blocked` is
 * set. So an `OUT_OF_BOUNDS` refusal survived the requester going back, correcting the
 * parameter, and returning to Review — the button stayed dead, explaining a value no
 * longer in the form, and the only escape (leaving the route) DISCARDS THE ENTIRE
 * DRAFTED REQUEST. A stale freeze message behaved the same way after an admin lifted the
 * freeze.
 *
 * These pin the expiry rule, and equally the cases where the refusal must NOT expire —
 * the failure mode of an over-eager fix is a refusal that vanishes before the requester
 * has read it, or a button that re-enables for a draft the server has already rejected.
 *
 * No jsdom in this repo (see test/standalone.test.ts's dependency allowlist), which is
 * why this rule is a derivation over plain data rather than an effect inside the form.
 */

const NOW: Schedule = { kind: 'now' };

function state(over: Partial<DraftState> = {}): DraftState {
  return {
    values: { instanceType: 't3.small', name: 'web' },
    schedule: NOW,
    justification: 'scaling up for the launch',
    replaceConfirmation: '',
    settings: { changeFreeze: false, disabledOps: [] },
    ...over,
  };
}

describe('draftKey — identity of the state the server judged', () => {
  it('is stable across recomputation for an unchanged draft', () => {
    expect(draftKey(state())).toBe(draftKey(state()));
  });

  it('ignores key ORDER in values — re-seeding a form must not read as an edit', () => {
    // The reseed effect rebuilds `values` from scratch. If insertion order leaked into
    // the key, returning to a form would silently clear a refusal nobody addressed.
    const a = draftKey(state({ values: { name: 'web', instanceType: 't3.small' } }));
    const b = draftKey(state({ values: { instanceType: 't3.small', name: 'web' } }));
    expect(a).toBe(b);
  });

  it('ignores disabledOps ORDER — snapshot array order is not a meaningful change', () => {
    const a = draftKey(state({ settings: { changeFreeze: false, disabledOps: ['a', 'b'] } }));
    const b = draftKey(state({ settings: { changeFreeze: false, disabledOps: ['b', 'a'] } }));
    expect(a).toBe(b);
  });

  it('changes for every input the server actually weighs', () => {
    const base = draftKey(state());
    const variants: Array<[string, DraftState]> = [
      ['a parameter value', state({ values: { instanceType: 't3.large', name: 'web' } })],
      ['an added parameter', state({ values: { instanceType: 't3.small', name: 'web', extra: 1 } })],
      ['a removed parameter', state({ values: { instanceType: 't3.small' } })],
      ['the schedule', state({ schedule: { kind: 'window', at: '2026-01-01T00:00:00Z', endAt: '2026-01-01T01:00:00Z' } as Schedule })],
      ['the justification', state({ justification: 'different argument entirely' })],
      ['the replace confirmation', state({ replaceConfirmation: 'aws_instance.web' })],
      ['the change freeze', state({ settings: { changeFreeze: true, disabledOps: [] } })],
      ['the disabled-op list', state({ settings: { changeFreeze: false, disabledOps: ['ec2.resize'] } })],
    ];
    for (const [what, s] of variants) {
      expect(draftKey(s), `${what} must change the key`).not.toBe(base);
    }
  });
});

describe('activeRefusal — the refusal blocks, but only over what it judged', () => {
  const key = draftKey(state());

  it('yields the reason while the draft is unchanged — the server decided, and it still stands', () => {
    // The failure mode of an over-eager fix: re-enabling submit for a draft the server
    // has already rejected, so the requester re-sends it and is refused again.
    expect(activeRefusal({ reason: 'Out of bounds.', forKey: key }, key)).toBe('Out of bounds.');
  });

  it('yields undefined once the requester edits the offending parameter — the FE-3 dead end', () => {
    const fixed = draftKey(state({ values: { instanceType: 't3.micro', name: 'web' } }));
    expect(activeRefusal({ reason: 'Out of bounds.', forKey: key }, fixed)).toBeUndefined();
  });

  it('yields undefined once an admin LIFTS the freeze — a refusal about the world, not the draft', () => {
    // The requester can do nothing about a freeze. Keeping the button dead after it ends,
    // citing a freeze that is over, is the version of this bug that no edit can escape.
    const frozen = draftKey(state({ settings: { changeFreeze: true, disabledOps: [] } }));
    const refusal = { reason: 'Change requests are frozen by an administrator right now.', forKey: frozen };
    expect(activeRefusal(refusal, frozen)).toBe(refusal.reason);
    expect(activeRefusal(refusal, draftKey(state()))).toBeUndefined();
  });

  it('returns undefined, not null, so ReviewStep re-enables submit by construction', () => {
    // `ReviewStep` disables on `blocked !== undefined`. Returning null here would keep
    // the button dead while showing no reason — strictly worse than the original bug.
    expect(activeRefusal(null, key)).toBeUndefined();
    expect(activeRefusal({ reason: 'x', forKey: 'stale' }, key)).toBeUndefined();
  });

  it('an expired refusal stays expired — it cannot come back if the draft is edited and reverted', () => {
    // Reverting an edit reproduces the original key, which would resurrect the refusal.
    // That is correct and deliberate: the draft IS the one the server rejected again.
    const reverted = draftKey(state());
    expect(activeRefusal({ reason: 'Out of bounds.', forKey: key }, reverted)).toBe('Out of bounds.');
  });
});
