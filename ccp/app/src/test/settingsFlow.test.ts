import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminSettingsWire, AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';
import {
  ALLOWLIST_SETTING_KEY,
  FREEZE_SETTING_KEY,
  RATE_LIMITS_SETTING_KEY,
  decodeAllowlistRestrictions,
  decodeServerSettings,
  encodeAllowlistRestrictions,
  isParamRestricted,
  loadSettingsVia,
  localSettingsView,
  permittedValues,
  setAllowlistOverrideVia,
  setFreezeVia,
  setRateLimitsVia,
} from '@/features/admin/settingsFlow';
import {
  DEFAULT_LIMITS,
  getAllowlistOverride,
  getSettings,
  isChangeFrozen,
  resetSettingsForTests,
  setChangeFreeze,
  setLimits,
} from '@/lib/settings';

/**
 * The settings flow's honesty proof (the teamsFlow.test.ts pattern) plus the
 * allowlist.restrictions wire-encoding rules the server's §6 classifier
 * demands (domain/dualControl.ts `target:'allowlist'`: any NEW allowed entry
 * → loosening → a second admin; otherwise tightening → applies now).
 */

function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    getAdminSettings: notUsed,
    putAdminSetting: notUsed,
    ...over,
  } as unknown as HttpApiClient;
}

function spy<T extends unknown[], R>(
  impl: (...args: T) => R,
): ((...args: T) => R) & { calls: T[] } {
  const fn = (...args: T): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as T[];
  return fn;
}

const NEVER_CALLED = (): never => {
  throw new Error('server must not be called when not authoritative');
};

beforeEach(resetSettingsForTests);

/* ── the allowlist wire encoding ─────────────────────────────────────────── */

describe('encode/decodeAllowlistRestrictions — the flat allowed-entries wire shape', () => {
  it('round-trips a permitted-subset map through `<opId>::<param>::<value>` entries', () => {
    const overrides = {
      'ebs-grow::volume_type': ['gp3', 'io2'],
      's3-lifecycle::storage_class': ['GLACIER'],
    };
    const wire = encodeAllowlistRestrictions(overrides);
    expect(wire).toEqual([
      'ebs-grow::volume_type::gp3',
      'ebs-grow::volume_type::io2',
      's3-lifecycle::storage_class::GLACIER',
    ]);
    expect(decodeAllowlistRestrictions(wire)).toEqual(overrides);
  });

  it('encodes deterministically (sorted) so identical maps always produce identical wire values', () => {
    const a = encodeAllowlistRestrictions({ 'op::p': ['b', 'a'] });
    const b = encodeAllowlistRestrictions({ 'op::p': ['a', 'b'] });
    expect(a).toEqual(b);
  });

  it('a value containing "::" survives the round trip (only the first two separators split)', () => {
    const overrides = { 'op::p': ['arn::weird::value'] };
    expect(decodeAllowlistRestrictions(encodeAllowlistRestrictions(overrides))).toEqual(overrides);
  });

  it('decodes defensively: non-arrays, non-strings, and malformed entries are skipped', () => {
    expect(decodeAllowlistRestrictions(undefined)).toEqual({});
    expect(decodeAllowlistRestrictions({ not: 'an array' })).toEqual({});
    expect(
      decodeAllowlistRestrictions(['no-separator', 'only::one', 42 as never, 'op::p::ok']),
    ).toEqual({
      'op::p': ['ok'],
    });
  });

  it('§6 monotonicity: narrowing only removes entries; widening/clearing only adds them', () => {
    const before = encodeAllowlistRestrictions({ 'op::p': ['a', 'b'] });
    const narrowed = encodeAllowlistRestrictions({ 'op::p': ['a'] });
    const widened = encodeAllowlistRestrictions({ 'op::p': ['a', 'b', 'c'] });
    // narrow ⊂ before → the server classifies tightening → applies immediately.
    expect(before.filter((e) => !narrowed.includes(e))).toEqual(['op::p::b']);
    expect(narrowed.every((e) => before.includes(e))).toBe(true);
    // widen ⊃ before → a NEW allowed entry → loosening → a second admin must ack.
    expect(widened.filter((e) => !before.includes(e))).toEqual(['op::p::c']);
  });
});

describe('permittedValues / isParamRestricted', () => {
  const BASE = ['a', 'b', 'c'];

  it('no stored subset → the full base (unrestricted)', () => {
    expect(permittedValues({}, 'op', 'p', BASE)).toEqual(BASE);
    expect(isParamRestricted({}, 'op', 'p', BASE)).toBe(false);
  });

  it('a stored subset narrows, in manifest order', () => {
    const o = { 'op::p': ['c', 'a'] };
    expect(permittedValues(o, 'op', 'p', BASE)).toEqual(['a', 'c']);
    expect(isParamRestricted(o, 'op', 'p', BASE)).toBe(true);
  });

  it('a stored FULL list reads as unrestricted — the explicit-clear convention', () => {
    const o = { 'op::p': ['a', 'b', 'c'] };
    expect(permittedValues(o, 'op', 'p', BASE)).toEqual(BASE);
    expect(isParamRestricted(o, 'op', 'p', BASE)).toBe(false);
  });

  it('a stored subset that no longer intersects the base never soft-locks the param', () => {
    expect(permittedValues({ 'op::p': ['gone'] }, 'op', 'p', BASE)).toEqual(BASE);
  });
});

/* ── reads ───────────────────────────────────────────────────────────────── */

describe('decodeServerSettings', () => {
  it('decodes all four keys, mapping the server field name maxOpen → maxOpenPerUser', () => {
    const wire: AdminSettingsWire = {
      'freeze.global': true,
      'catalog.disabled-ops': ['ebs-grow'],
      'rate.limits': { submissionsPerHour: 80, maxOpen: 5 },
      'allowlist.restrictions': ['op::p::a'],
    };
    expect(decodeServerSettings(wire)).toEqual({
      changeFreeze: true,
      disabledOps: ['ebs-grow'],
      allowlistOverrides: { 'op::p': ['a'] },
      rateLimits: { submissionsPerHour: 80, maxOpenPerUser: 5 },
    });
  });

  it('never-written keys (absent) decode to the same defaults the server itself reads', () => {
    expect(decodeServerSettings({})).toEqual({
      changeFreeze: false,
      disabledOps: [],
      allowlistOverrides: {},
      rateLimits: {
        submissionsPerHour: DEFAULT_LIMITS.submissionsPerHour,
        maxOpenPerUser: DEFAULT_LIMITS.maxOpenPerUser,
      },
    });
  });
});

describe('loadSettingsVia / localSettingsView', () => {
  it('authoritative + client: decodes GET /admin/settings', async () => {
    const getAdminSettings = spy(async (): Promise<AdminSettingsWire> => ({
      'freeze.global': true,
    }));
    const view = await loadSettingsVia(true, fakeClient({ getAdminSettings }));
    expect(getAdminSettings.calls).toEqual([[]]);
    expect(view.changeFreeze).toBe(true);
  });

  it('not authoritative: the synchronous local snapshot — the server is never called', async () => {
    setChangeFreeze(true);
    setLimits({ submissionsPerHour: 99 });
    const getAdminSettings = spy(NEVER_CALLED);
    const view = await loadSettingsVia(false, fakeClient({ getAdminSettings }));
    expect(getAdminSettings.calls).toEqual([]);
    expect(view).toEqual(localSettingsView());
    expect(view.changeFreeze).toBe(true);
    expect(view.rateLimits.submissionsPerHour).toBe(99);
  });
});

/* ── writes ──────────────────────────────────────────────────────────────── */

describe('setFreezeVia', () => {
  it('authoritative: PUT /admin/settings/freeze.global {value} — 202 on lifting surfaces honestly', async () => {
    const putAdminSetting = spy(async (): Promise<AdminWriteOutcome> => ({
      applied: false,
      pendingId: '01F',
    }));
    const outcome = await setFreezeVia(true, fakeClient({ putAdminSetting }), false);
    expect(putAdminSetting.calls).toEqual([[FREEZE_SETTING_KEY, false]]);
    expect(outcome).toEqual({ applied: false, pendingId: '01F' });
    expect(isChangeFrozen()).toBe(false); // local store untouched
  });

  it('not authoritative: writes lib/settings — the server is never called', async () => {
    const putAdminSetting = spy(NEVER_CALLED);
    const outcome = await setFreezeVia(false, fakeClient({ putAdminSetting }), true);
    expect(putAdminSetting.calls).toEqual([]);
    expect(outcome).toEqual({ applied: true });
    expect(isChangeFrozen()).toBe(true);
  });
});

describe('setAllowlistOverrideVia', () => {
  const BASE = ['gp2', 'gp3', 'io2'];

  it('authoritative + a narrowing: rewrites allowlist.restrictions with the subset entries', async () => {
    const putAdminSetting = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    await setAllowlistOverrideVia(
      true,
      fakeClient({ putAdminSetting }),
      {},
      'ebs-grow',
      'volume_type',
      ['gp3', 'io2'],
      BASE,
    );
    expect(putAdminSetting.calls).toEqual([
      [ALLOWLIST_SETTING_KEY, ['ebs-grow::volume_type::gp3', 'ebs-grow::volume_type::io2']],
    ]);
  });

  it('authoritative + clearing (null): writes the explicit FULL base list — a widen the §6 classifier must dual-control, never a silent key deletion', async () => {
    const putAdminSetting = spy(
      async (_key: string, _value: unknown): Promise<AdminWriteOutcome> => ({
        applied: false,
        pendingId: '01A',
      }),
    );
    const current = { 'ebs-grow::volume_type': ['gp3'] };
    const outcome = await setAllowlistOverrideVia(
      true,
      fakeClient({ putAdminSetting }),
      current,
      'ebs-grow',
      'volume_type',
      null,
      BASE,
    );
    const [key, wire] = putAdminSetting.calls[0]!;
    expect(key).toBe(ALLOWLIST_SETTING_KEY);
    expect(wire).toEqual([
      'ebs-grow::volume_type::gp2',
      'ebs-grow::volume_type::gp3',
      'ebs-grow::volume_type::io2',
    ]);
    // Every previous entry is still present — clearing only ADDS entries.
    for (const e of encodeAllowlistRestrictions(current)) expect(wire).toContainEqual(e);
    expect(outcome).toEqual({ applied: false, pendingId: '01A' });
  });

  it('authoritative: an empty or full selection is also written as the explicit full list', async () => {
    const putAdminSetting = spy(
      async (_key: string, _value: unknown): Promise<AdminWriteOutcome> => ({ applied: true }),
    );
    await setAllowlistOverrideVia(
      true,
      fakeClient({ putAdminSetting }),
      {},
      'op',
      'p',
      [],
      ['a', 'b'],
    );
    expect(putAdminSetting.calls[0]![1]).toEqual(['op::p::a', 'op::p::b']);
    await setAllowlistOverrideVia(
      true,
      fakeClient({ putAdminSetting }),
      {},
      'op',
      'p',
      ['a', 'b'],
      ['a', 'b'],
    );
    expect(putAdminSetting.calls[1]![1]).toEqual(['op::p::a', 'op::p::b']);
  });

  it('authoritative: other params’ stored entries are preserved verbatim in the rewrite', async () => {
    const putAdminSetting = spy(
      async (_key: string, _value: unknown): Promise<AdminWriteOutcome> => ({ applied: true }),
    );
    const current = { 'other::param': ['x'] };
    await setAllowlistOverrideVia(
      true,
      fakeClient({ putAdminSetting }),
      current,
      'op',
      'p',
      ['a'],
      ['a', 'b'],
    );
    expect(putAdminSetting.calls[0]![1]).toEqual(['op::p::a', 'other::param::x']);
  });

  it('not authoritative: writes lib/settings (full/empty clears the key there — local semantics unchanged)', async () => {
    const putAdminSetting = spy(NEVER_CALLED);
    await setAllowlistOverrideVia(
      false,
      fakeClient({ putAdminSetting }),
      {},
      'op',
      'p',
      ['a'],
      ['a', 'b'],
    );
    expect(putAdminSetting.calls).toEqual([]);
    expect(getAllowlistOverride('op', 'p')).toEqual(['a']);
    await setAllowlistOverrideVia(false, fakeClient({ putAdminSetting }), {}, 'op', 'p', null, [
      'a',
      'b',
    ]);
    expect(getAllowlistOverride('op', 'p')).toBeNull();
  });
});

describe('setRateLimitsVia', () => {
  it('authoritative: PUTs rate.limits under the server field name maxOpen, clamped to bounds', async () => {
    const putAdminSetting = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    await setRateLimitsVia(true, fakeClient({ putAdminSetting }), {
      submissionsPerHour: 9999, // above the 500 bound
      maxOpenPerUser: 0, // below the 1 bound
    });
    expect(putAdminSetting.calls).toEqual([
      [RATE_LIMITS_SETTING_KEY, { submissionsPerHour: 500, maxOpen: 1 }],
    ]);
  });

  it('not authoritative: writes lib/settings limits — the server is never called', async () => {
    const putAdminSetting = spy(NEVER_CALLED);
    const outcome = await setRateLimitsVia(false, fakeClient({ putAdminSetting }), {
      submissionsPerHour: 80,
      maxOpenPerUser: 5,
    });
    expect(putAdminSetting.calls).toEqual([]);
    expect(outcome).toEqual({ applied: true });
    expect(getSettings().limits.submissionsPerHour).toBe(80);
    expect(getSettings().limits.maxOpenPerUser).toBe(5);
  });

  it('local writes stay session-field-preserving (only the pair changes)', async () => {
    setLimits({ sessionAbsoluteHours: 6 });
    await setRateLimitsVia(false, fakeClient(), { submissionsPerHour: 70, maxOpenPerUser: 7 });
    expect(getSettings().limits.sessionAbsoluteHours).toBe(6);
  });
});
