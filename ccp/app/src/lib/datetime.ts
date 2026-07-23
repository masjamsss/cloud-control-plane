import { getProject } from '@/lib/project';

/**
 * Timestamp formatting sourced from the active project's configured timezone:
 * the estate's timezone is project DATA (src/data/project.json's
 * `timezone`/`timezoneLabel`), never a constant baked into this file — that is
 * what let one estate's local-timezone literal live here in the first place,
 * coupling the app to a single deployment. A project that predates these
 * optional fields (or omits them) falls back to a neutral, project-agnostic
 * default (UTC) — never silently to another estate's zone, which would just
 * relocate the same coupling.
 */
const NEUTRAL_TIMEZONE = 'UTC';

function activeTimezone(): { timeZone: string; label: string } {
  const project = getProject();
  return {
    timeZone: project.timezone ?? NEUTRAL_TIMEZONE,
    label: project.timezoneLabel ?? NEUTRAL_TIMEZONE,
  };
}

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date + time, e.g. "6 Jul 2026, 15:04 CET" (zone + suffix from the active project). */
export function formatProjectTime(iso: string | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  const { timeZone, label } = activeTimezone();
  const s = d.toLocaleString('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${s} ${label}`;
}

/** Date only, e.g. "6 Jul 2026" (in the active project's timezone). */
export function formatProjectDate(iso: string | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  const { timeZone } = activeTimezone();
  return d.toLocaleDateString('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Whole calendar days between `iso` and `now`, counted on the active
 * project's calendar (its configured timezone — the same source as every
 * timestamp this app renders), never the viewer's machine zone. "1 day old"
 * must flip at the estate's midnight: a snapshot taken at 23:30 estate time
 * is "1 day old" ninety minutes later, and a snapshot from late last night
 * UTC is still "today" if the estate's local date hasn't changed. Returns
 * null for missing/invalid input, and never a negative number (a
 * future-dated timestamp — clock skew — reads as 0, not "-1 days").
 */
export function projectCalendarAgeDays(iso: string | undefined, now: Date = new Date()): number | null {
  const d = parse(iso);
  if (!d) return null;
  const { timeZone } = activeTimezone();
  // en-CA renders YYYY-MM-DD — parseable as a UTC midnight for day arithmetic.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localMidnightUtc = (x: Date): number => {
    const [y, m, day] = fmt.format(x).split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1);
  };
  const days = Math.round((localMidnightUtc(now) - localMidnightUtc(d)) / 86_400_000);
  return Math.max(0, days);
}
