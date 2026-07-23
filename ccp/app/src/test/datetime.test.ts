import { afterEach, describe, expect, it } from 'vitest';
import { formatProjectDate, formatProjectTime } from '@/lib/datetime';
import { resetProjectForTests } from '@/lib/project';

/** A minimal, otherwise-valid OTHER project — same fixture shape as
 * project.test.ts's OTHER_PROJECT, duplicated locally (separate test module). */
function otherProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme',
    name: 'Acme — EU',
    github: { owner: 'acme-co', repo: 'terraform-acme', mode: 'org' as const },
    region: 'eu-west-1',
    seedLead: { username: 'lead', displayName: 'Lead', teamId: 'core', defaultPassword: 'change-me' },
    teams: [{ id: 'core', name: 'Core', serviceSlugs: ['s3', 'ec2'] }],
    ...overrides,
  };
}

describe('formatProjectTime / formatProjectDate — sourced from the project config (Task 5)', () => {
  afterEach(() => {
    delete (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__;
    resetProjectForTests();
  });

  it('a project override renders in ITS timezone with ITS label, not the sample’s JST', () => {
    (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__ = otherProject({
      timezone: 'Europe/Paris',
      timezoneLabel: 'CET',
    });
    resetProjectForTests();
    // 08:04Z + 2h (Europe/Paris is UTC+2 in July) = 10:04.
    expect(formatProjectTime('2026-07-06T08:04:00Z')).toBe('6 Jul 2026, 10:04 CET');
  });

  it('absent fields (no override — the bundled sample default) keep the exact current JST outputs', () => {
    expect(formatProjectTime('2026-07-06T08:04:00Z')).toBe('6 Jul 2026, 17:04 JST');
    expect(formatProjectDate('2026-07-06T20:30:00Z')).toBe('7 Jul 2026');
  });

  it('an override that omits timezone/timezoneLabel falls back to a neutral default, never silently to a real estate\'s own label', () => {
    (globalThis as { __CCP_PROJECT__?: unknown }).__CCP_PROJECT__ = otherProject(); // no timezone fields
    resetProjectForTests();
    expect(formatProjectTime('2026-07-06T08:04:00Z')).toBe('6 Jul 2026, 08:04 UTC');
  });

  it('returns an em dash for missing or invalid input', () => {
    expect(formatProjectTime(undefined)).toBe('—');
    expect(formatProjectDate('not-a-date')).toBe('—');
  });
});
