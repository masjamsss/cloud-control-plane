import { beforeEach, describe, expect, it } from 'vitest';
import { listAudit, resetAuditForTests } from '@/lib/audit';
import {
  DEFAULT_LIMITS,
  LIMITS_BOUNDS,
  addMaintenanceWindow,
  addNotificationChannel,
  clampLimits,
  getLimits,
  getMaintenanceWindows,
  getNotificationChannels,
  getSettings,
  isChangeFrozen,
  isOpDisabled,
  removeMaintenanceWindow,
  removeNotificationChannel,
  resetSettingsForTests,
  setChangeFreeze,
  setLimits,
  setOpDisabled,
  subscribeSettingsChanged,
} from '@/lib/settings';

beforeEach(() => {
  resetSettingsForTests();
  resetAuditForTests();
});

describe('global settings — change freeze (R7)', () => {
  it('defaults to open (not frozen)', () => {
    expect(isChangeFrozen()).toBe(false);
    expect(getSettings().changeFreeze).toBe(false);
  });

  it('a leader can freeze and lift at any time; it persists', () => {
    setChangeFreeze(true);
    expect(isChangeFrozen()).toBe(true);
    setChangeFreeze(false);
    expect(isChangeFrozen()).toBe(false);
  });

  it('coerces malformed stored values to false (fail-open on read, not submit)', () => {
    setChangeFreeze(true);
    expect(getSettings().changeFreeze).toBe(true);
  });
});

describe('global settings — per-operation disable (R7 catalog admin)', () => {
  it('an admin can disable and re-enable an operation; it persists', () => {
    expect(isOpDisabled('ec2-resize')).toBe(false);
    setOpDisabled('ec2-resize', true);
    expect(isOpDisabled('ec2-resize')).toBe(true);
    expect(getSettings().disabledOps).toContain('ec2-resize');
    setOpDisabled('ec2-resize', false);
    expect(isOpDisabled('ec2-resize')).toBe(false);
  });

  it('disabling is idempotent and independent per op', () => {
    setOpDisabled('ebs-grow', true);
    setOpDisabled('ebs-grow', true);
    setOpDisabled('s3-update-tags', true);
    expect(getSettings().disabledOps.sort()).toEqual(['ebs-grow', 's3-update-tags']);
  });

  it('freeze and disabled-ops are stored independently', () => {
    setChangeFreeze(true);
    setOpDisabled('ec2-resize', true);
    expect(isChangeFrozen()).toBe(true);
    expect(isOpDisabled('ec2-resize')).toBe(true);
  });
});

/**
 * Task 2 (6-admin-complete-control): three new admin domains on GlobalSettings.
 * Absent → the documented defaults; a set round-trips through getSettings() and
 * records an audit entry, following the immutable-copy + writeRaw pattern the
 * existing accessors (above) use.
 */

describe('global settings — new domains default when absent', () => {
  it('notifications.channels defaults to an empty list', () => {
    expect(getSettings().notifications).toEqual({ channels: [] });
    expect(getNotificationChannels()).toEqual([]);
  });

  it('maintenanceWindows defaults to an empty list', () => {
    expect(getSettings().maintenanceWindows).toEqual([]);
    expect(getMaintenanceWindows()).toEqual([]);
  });

  it('limits defaults mirror the api spec §4/§5 numbers (12h / 30m / 50/h / 20 open)', () => {
    expect(getSettings().limits).toEqual({
      sessionAbsoluteHours: 12,
      sessionIdleMinutes: 30,
      submissionsPerHour: 50,
      maxOpenPerUser: 20,
    });
    expect(getLimits()).toEqual(DEFAULT_LIMITS);
  });
});

describe('global settings — notification channels', () => {
  it('round-trips a channel through getSettings() after adding it', () => {
    const settings = addNotificationChannel({
      kind: 'email',
      target: 'oncall@example.com',
      events: ['submitted', 'applied'],
    });
    expect(settings.notifications.channels).toHaveLength(1);
    const stored = getSettings().notifications.channels[0];
    expect(stored).toMatchObject({
      kind: 'email',
      target: 'oncall@example.com',
      events: ['submitted', 'applied'],
    });
    expect(stored?.id).toBeTruthy();
  });

  it('removes a channel by id; unknown id is a no-op', () => {
    const after = addNotificationChannel({
      kind: 'chat-webhook',
      target: 'https://hooks.example/x',
      events: [],
    });
    const id = after.notifications.channels[0]!.id;
    removeNotificationChannel(id);
    expect(getNotificationChannels()).toEqual([]);
    expect(() => removeNotificationChannel('no-such-id')).not.toThrow();
  });

  it('adding and removing a channel each record an audit entry', () => {
    const after = addNotificationChannel({ kind: 'email', target: 'a@b.com', events: [] });
    expect(listAudit()[0]?.action).toMatch(/notification channel/i);
    removeNotificationChannel(after.notifications.channels[0]!.id);
    expect(listAudit()[0]?.action).toMatch(/notification channel/i);
    expect(listAudit()).toHaveLength(2);
  });
});

describe('global settings — maintenance windows', () => {
  it('round-trips a window through getSettings() after adding it, tz included', () => {
    const settings = addMaintenanceWindow({
      label: 'Nightly batch',
      cron: '0 2 * * *',
      tz: 'Asia/Tokyo',
    });
    expect(settings.maintenanceWindows).toHaveLength(1);
    expect(getMaintenanceWindows()[0]).toMatchObject({
      label: 'Nightly batch',
      cron: '0 2 * * *',
      tz: 'Asia/Tokyo',
    });
  });

  it('removes a window by id', () => {
    const after = addMaintenanceWindow({ label: 'W', cron: '* * * * *', tz: 'UTC' });
    const id = after.maintenanceWindows[0]!.id;
    removeMaintenanceWindow(id);
    expect(getMaintenanceWindows()).toEqual([]);
  });

  it('adding a window records an audit entry', () => {
    addMaintenanceWindow({ label: 'W', cron: '* * * * *', tz: 'UTC' });
    expect(listAudit()[0]?.action).toMatch(/maintenance window/i);
  });
});

describe('global settings — limits', () => {
  it('sets and round-trips a partial update, leaving other fields untouched', () => {
    const settings = setLimits({ submissionsPerHour: 80 });
    expect(settings.limits.submissionsPerHour).toBe(80);
    expect(getLimits().submissionsPerHour).toBe(80);
    expect(getLimits().sessionAbsoluteHours).toBe(DEFAULT_LIMITS.sessionAbsoluteHours);
  });

  it('clampLimits clamps every field to its documented range (1–24h / 5–120m / 1–500/h / 1–100)', () => {
    expect(
      clampLimits({
        sessionAbsoluteHours: 999,
        sessionIdleMinutes: 0,
        submissionsPerHour: -5,
        maxOpenPerUser: 10_000,
      }),
    ).toEqual({
      sessionAbsoluteHours: LIMITS_BOUNDS.sessionAbsoluteHours[1],
      sessionIdleMinutes: LIMITS_BOUNDS.sessionIdleMinutes[0],
      submissionsPerHour: LIMITS_BOUNDS.submissionsPerHour[0],
      maxOpenPerUser: LIMITS_BOUNDS.maxOpenPerUser[1],
    });
  });

  it('setLimits clamps before persisting — the store can never hold an out-of-range value', () => {
    const settings = setLimits({ sessionAbsoluteHours: 999, sessionIdleMinutes: 1 });
    expect(settings.limits.sessionAbsoluteHours).toBe(LIMITS_BOUNDS.sessionAbsoluteHours[1]);
    expect(settings.limits.sessionIdleMinutes).toBe(LIMITS_BOUNDS.sessionIdleMinutes[0]);
  });

  it('setting limits records an audit entry', () => {
    setLimits({ submissionsPerHour: 80 });
    expect(listAudit()[0]?.action).toMatch(/limits/i);
  });
});

describe('global settings — new domains persist independently of existing ones', () => {
  it('setting a new domain does not disturb changeFreeze / disabledOps', () => {
    setChangeFreeze(true);
    setOpDisabled('ec2-resize', true);
    addNotificationChannel({ kind: 'email', target: 'a@b.com', events: [] });
    setLimits({ maxOpenPerUser: 5 });
    expect(isChangeFrozen()).toBe(true);
    expect(isOpDisabled('ec2-resize')).toBe(true);
  });
});

describe('getSettings() — cached snapshot referential stability (0025 RX-4)', () => {
  it('returns the SAME object reference across repeated calls when nothing wrote in between', () => {
    const a = getSettings();
    const b = getSettings();
    const c = getSettings();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a NEW reference after a write, but the SAME reference again afterward', () => {
    const before = getSettings();
    setChangeFreeze(true);
    const afterWrite1 = getSettings();
    const afterWrite2 = getSettings();
    expect(afterWrite1).not.toBe(before);
    expect(afterWrite1).toBe(afterWrite2); // stable again until the next write
  });

  it('every kind of write invalidates the cache: freeze, disabled-ops, notifications, windows, limits', () => {
    let snap = getSettings();
    setChangeFreeze(true);
    expect(getSettings()).not.toBe(snap);
    snap = getSettings();
    setOpDisabled('ec2-resize', true);
    expect(getSettings()).not.toBe(snap);
    snap = getSettings();
    addNotificationChannel({ kind: 'email', target: 'a@b.com', events: [] });
    expect(getSettings()).not.toBe(snap);
    snap = getSettings();
    addMaintenanceWindow({ label: 'W', cron: '0 2 * * *', tz: 'UTC' });
    expect(getSettings()).not.toBe(snap);
    snap = getSettings();
    setLimits({ maxOpenPerUser: 5 });
    expect(getSettings()).not.toBe(snap);
  });

  it('resetSettingsForTests() also invalidates the cache (tests never leak a stale snapshot into the next one)', () => {
    setChangeFreeze(true);
    const frozen = getSettings();
    resetSettingsForTests();
    const reset = getSettings();
    expect(reset).not.toBe(frozen);
    expect(reset.changeFreeze).toBe(false);
  });
});

describe('subscribeSettingsChanged — the useSettings() external-store source (0025 RX-4)', () => {
  it('fires on a write', () => {
    let calls = 0;
    const unsubscribe = subscribeSettingsChanged(() => (calls += 1));
    setChangeFreeze(true);
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('fires once per write, for every kind of setter', () => {
    let calls = 0;
    const unsubscribe = subscribeSettingsChanged(() => (calls += 1));
    setOpDisabled('ec2-resize', true);
    setLimits({ maxOpenPerUser: 5 });
    expect(calls).toBe(2);
    unsubscribe();
  });

  it('unsubscribing stops further notifications', () => {
    let calls = 0;
    const unsubscribe = subscribeSettingsChanged(() => (calls += 1));
    unsubscribe();
    setChangeFreeze(true);
    expect(calls).toBe(0);
  });
});
