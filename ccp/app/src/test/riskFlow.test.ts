import { beforeEach, describe, expect, it } from 'vitest';
import type { RiskFloor } from '@/types';
import type { AdminSettingsWire, AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';
import {
  clearRiskVia,
  loadRiskStateVia,
  localRiskState,
  setOpEnabledVia,
  setRiskVia,
} from '@/features/admin/riskFlow';
import {
  listRiskOverrides,
  resetRiskOverridesForTests,
  setRiskOverride,
} from '@/lib/riskOverrides';
import { getSettings, resetSettingsForTests, setOpDisabled } from '@/lib/settings';

/**
 * The risk flow's honesty proof (the teamsFlow.test.ts pattern):
 * `authoritative=true` routes reads through GET /admin/risk +
 * GET /admin/settings and writes through PUT/DELETE /admin/risk/:opId and
 * PUT /admin/catalog/:opId; `authoritative=false` is exactly the pre-existing
 * lib/riskOverrides + lib/settings localStorage behavior.
 */

function fakeClient(over: Partial<HttpApiClient> = {}): HttpApiClient {
  const notUsed = (): never => {
    throw new Error('fakeClient: method not stubbed for this test');
  };
  return {
    listAdminRiskOverrides: notUsed,
    getAdminSettings: notUsed,
    setAdminRiskOverride: notUsed,
    clearAdminRiskOverride: notUsed,
    setAdminCatalogEnabled: notUsed,
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

const OP = { id: 'ebs-grow', riskFloor: 'MEDIUM' as RiskFloor };

beforeEach(() => {
  resetRiskOverridesForTests();
  resetSettingsForTests();
});

describe('localRiskState', () => {
  it('is the synchronous local snapshot of overrides + disabled ops', () => {
    setRiskOverride('ebs-grow', 'HIGH');
    setOpDisabled('s3-update-tags', true);
    expect(localRiskState()).toEqual({
      overrides: { 'ebs-grow': 'HIGH' },
      disabledOps: ['s3-update-tags'],
    });
  });
});

describe('loadRiskStateVia', () => {
  it('authoritative + client: reads the overrides map + the disabled-ops setting from the server', async () => {
    const listAdminRiskOverrides = spy(async () => ({ 'ebs-grow': 'HIGH' as RiskFloor }));
    const getAdminSettings = spy(async (): Promise<AdminSettingsWire> => ({
      'catalog.disabled-ops': ['ec2-stop'],
    }));
    const state = await loadRiskStateVia(
      true,
      fakeClient({ listAdminRiskOverrides, getAdminSettings }),
    );
    expect(listAdminRiskOverrides.calls).toEqual([[]]);
    expect(getAdminSettings.calls).toEqual([[]]);
    expect(state).toEqual({ overrides: { 'ebs-grow': 'HIGH' }, disabledOps: ['ec2-stop'] });
  });

  it('authoritative: a never-written disabled-ops setting (absent key) decodes to []', async () => {
    const state = await loadRiskStateVia(
      true,
      fakeClient({
        listAdminRiskOverrides: spy(async () => ({})),
        getAdminSettings: spy(async (): Promise<AdminSettingsWire> => ({})),
      }),
    );
    expect(state).toEqual({ overrides: {}, disabledOps: [] });
  });

  it('not authoritative: falls back to the local stores — the server is never called', async () => {
    setRiskOverride('ebs-grow', 'LOW');
    const listAdminRiskOverrides = spy(NEVER_CALLED);
    const state = await loadRiskStateVia(false, fakeClient({ listAdminRiskOverrides }));
    expect(listAdminRiskOverrides.calls).toEqual([]);
    expect(state.overrides).toEqual({ 'ebs-grow': 'LOW' });
  });
});

describe('setRiskVia — choosing the manifest floor clears; anything else sets', () => {
  it('authoritative + a non-floor choice: PUT /admin/risk/:opId', async () => {
    const setAdminRiskOverride = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    const clearAdminRiskOverride = spy(NEVER_CALLED);
    const outcome = await setRiskVia(
      true,
      fakeClient({ setAdminRiskOverride, clearAdminRiskOverride }),
      OP,
      'HIGH',
    );
    expect(setAdminRiskOverride.calls).toEqual([['ebs-grow', 'HIGH']]);
    expect(outcome).toEqual({ applied: true });
  });

  it('authoritative + the floor itself: DELETE /admin/risk/:opId (clear, never a floor-valued override)', async () => {
    const setAdminRiskOverride = spy(NEVER_CALLED);
    const clearAdminRiskOverride = spy(async (): Promise<AdminWriteOutcome> => ({
      applied: false,
      pendingId: '01R',
    }));
    const outcome = await setRiskVia(
      true,
      fakeClient({ setAdminRiskOverride, clearAdminRiskOverride }),
      OP,
      'MEDIUM',
    );
    expect(clearAdminRiskOverride.calls).toEqual([['ebs-grow']]);
    // A dual-controlled reduction surfaces as proposed — never a claimed success.
    expect(outcome).toEqual({ applied: false, pendingId: '01R' });
  });

  it('not authoritative: writes lib/riskOverrides — set on a non-floor choice, clear on the floor', async () => {
    const outcome = await setRiskVia(false, fakeClient(), OP, 'HIGH');
    expect(outcome).toEqual({ applied: true });
    expect(listRiskOverrides()).toEqual({ 'ebs-grow': 'HIGH' });
    await setRiskVia(false, fakeClient(), OP, 'MEDIUM');
    expect(listRiskOverrides()).toEqual({});
  });
});

describe('clearRiskVia', () => {
  it('authoritative: DELETE /admin/risk/:opId', async () => {
    const clearAdminRiskOverride = spy(async (): Promise<AdminWriteOutcome> => ({ applied: true }));
    expect(await clearRiskVia(true, fakeClient({ clearAdminRiskOverride }), 'ebs-grow')).toEqual({
      applied: true,
    });
    expect(clearAdminRiskOverride.calls).toEqual([['ebs-grow']]);
  });

  it('not authoritative: clears the local override', async () => {
    setRiskOverride('ebs-grow', 'HIGH');
    await clearRiskVia(false, fakeClient(), 'ebs-grow');
    expect(listRiskOverrides()).toEqual({});
  });
});

describe('setOpEnabledVia — the catalog toggle', () => {
  it('authoritative: PUT /admin/catalog/:opId {enabled}', async () => {
    const setAdminCatalogEnabled = spy(async (): Promise<AdminWriteOutcome> => ({
      applied: false,
      pendingId: '01E',
    }));
    const outcome = await setOpEnabledVia(
      true,
      fakeClient({ setAdminCatalogEnabled }),
      'ebs-grow',
      true,
    );
    expect(setAdminCatalogEnabled.calls).toEqual([['ebs-grow', true]]);
    expect(outcome).toEqual({ applied: false, pendingId: '01E' });
  });

  it('not authoritative: writes lib/settings disabledOps (enabled:false → disabled)', async () => {
    await setOpEnabledVia(false, fakeClient(), 'ebs-grow', false);
    expect(getSettings().disabledOps).toEqual(['ebs-grow']);
    await setOpEnabledVia(false, fakeClient(), 'ebs-grow', true);
    expect(getSettings().disabledOps).toEqual([]);
  });
});
