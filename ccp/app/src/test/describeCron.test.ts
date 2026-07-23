import { describe, expect, it } from 'vitest';
import { describeCron } from '@/features/admin/SettingsAdmin';

/**
 * Maintenance-window cron preview (Task 3, 6-admin-complete-control). Best-effort
 * plain-English description of a handful of common 5-field expressions; anything
 * it doesn't recognize falls back to the raw expression verbatim — no cron dep.
 */
describe('describeCron — best-effort plain-English preview', () => {
  it('every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
  });

  it('every hour, at a given minute', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour, at minute 0');
    expect(describeCron('15 * * * *')).toBe('Every hour, at minute 15');
  });

  it('every day at a fixed time, zero-padded', () => {
    expect(describeCron('0 0 * * *')).toBe('Every day at 00:00');
    expect(describeCron('30 2 * * *')).toBe('Every day at 02:30');
  });

  it('a fixed weekday and time', () => {
    expect(describeCron('0 0 * * 0')).toBe('Every Sunday at 00:00');
    expect(describeCron('45 8 * * 5')).toBe('Every Friday at 08:45');
  });

  it('a fixed day of the month and time', () => {
    expect(describeCron('0 9 1 * *')).toBe('On day 1 of every month at 09:00');
  });

  it('falls back to the raw expression for anything unrecognized (no cron dep)', () => {
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *');
    expect(describeCron('not a cron')).toBe('not a cron');
    expect(describeCron('')).toBe('');
  });
});
