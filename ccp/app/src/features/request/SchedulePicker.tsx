import type { JSX } from 'react';
import type { Schedule } from '@/types';
import { formatProjectTime } from '@/lib/datetime';
import './request.css';

export interface SchedulePickerProps {
  value: Schedule;
  onChange: (schedule: Schedule) => void;
  /**
   * The radio group's `name` — must be unique among every SchedulePicker
   * that can be mounted on screen AT THE SAME TIME, or the two instances'
   * native radio grouping collides (HTML groups by `name` string across the
   * whole document, not by component instance) even though each instance's
   * `checked` stays independently React-controlled. Defaults to `'sched'`,
   * the original single-instance-per-page assumption; callers that can
   * co-mount with another SchedulePicker (features/drift/'s three surfaces
   * — the per-proposal drawer, the batch resolution form, and the
   * legitimize drawer can all be open together) must pass a distinct name.
   */
  name?: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HALF_HOUR_MS = 30 * MINUTE_MS;

/**
 * Mirrors `ccp/api/src/domain/schedule.ts`'s V3-V5 constants —
 * kept in sync BY CONVENTION, not by import (the same "LIMITS_BOUNDS mirrors the
 * api spec" pattern `lib/settings.ts` already uses for the rate-limit defaults).
 * The server is the enforcement; this is
 * courtesy — a client that disagrees just gets a clean 422 back.
 */
export const MIN_LEAD_MS = HALF_HOUR_MS;
export const MAX_HORIZON_MS = 90 * DAY_MS;
export const DEFAULT_WINDOW_MS = 4 * HOUR_MS;
export const MAX_WINDOW_MS = 24 * HOUR_MS;

const DURATION_OPTIONS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 1 * HOUR_MS },
  { label: '2 hours', ms: 2 * HOUR_MS },
  { label: '4 hours', ms: DEFAULT_WINDOW_MS },
  { label: '8 hours', ms: 8 * HOUR_MS },
];

/** ISO string → the value a <input type="datetime-local"> expects (local, no zone). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The <input type="datetime-local"> value → an ISO instant, or undefined if unparseable/empty. */
export function localInputToIso(raw: string): string | undefined {
  if (raw === '') return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The next half-hour boundary at or after `minMs` — epoch-aligned, so it lands
 * on a clean :00/:30 in UTC (and in the active project's display timezone too,
 * for any zone whose offset is itself a multiple of 30 minutes — true of every
 * zone this project's data currently ships; a stored/compared
 * instant is always the UTC one regardless). */
function ceilToHalfHour(minMs: number): number {
  return Math.ceil(minMs / HALF_HOUR_MS) * HALF_HOUR_MS;
}

/** The default `at` a fresh "schedule a window" choice seeds: the next half-hour
 * boundary at least MIN_LEAD_MS out (kills the old footgun
 * default of "right now," already past by submit time). */
export function defaultWindowAt(nowMs: number = Date.now()): string {
  return new Date(ceilToHalfHour(nowMs + MIN_LEAD_MS)).toISOString();
}

function durationMsOf(schedule: Schedule): number {
  if (schedule.kind !== 'window' || !schedule.endAt) return DEFAULT_WINDOW_MS;
  const d = Date.parse(schedule.endAt) - Date.parse(schedule.at);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_WINDOW_MS;
}

/**
 * Client-side mirror of the api's V2-V5 — inline, non-blocking-until-
 * submit feedback only; the server is the enforcement (ReviewStep.tsx disables
 * Submit on a non-undefined return, same posture as the old `windowInvalid`
 * check it replaces). V1/V6 aren't "errors" (V1: kind:'now' never applies; V6 is
 * normalization, invisible to the user).
 */
export function scheduleError(schedule: Schedule, nowMs: number = Date.now()): string | undefined {
  if (schedule.kind !== 'window') return undefined;
  if (schedule.at === '') return 'Pick a date and time.';
  const atMs = Date.parse(schedule.at);
  if (!Number.isFinite(atMs)) return 'Pick a valid date and time.';
  if (atMs < nowMs + MIN_LEAD_MS) return 'The window must start at least 30 minutes from now.';
  if (atMs > nowMs + MAX_HORIZON_MS) return 'The window may not be more than 90 days out.';
  if (schedule.endAt) {
    const endMs = Date.parse(schedule.endAt);
    if (!Number.isFinite(endMs) || endMs <= atMs) return 'The window must end after it starts.';
    if (endMs - atMs > MAX_WINDOW_MS) return 'The window may not be longer than 24 hours.';
  }
  return undefined;
}

/**
 * When an approved change applies. Two options — apply right after approval, or
 * pick a maintenance window (start + duration). Nothing auto-applies either way;
 * the window just defers the apply until the chosen time. Returns a Schedule via
 * onChange. A live estate-timezone preview and inline V3-V5 errors mirror the
 * server's own rules so a doomed submission is visible before
 * Review, not after a round trip.
 */
export function SchedulePicker({ value, onChange, name = 'sched' }: SchedulePickerProps): JSX.Element {
  const kind = value.kind;
  const localValue = value.kind === 'window' ? isoToLocalInput(value.at) : '';
  const error = scheduleError(value);
  const duration = durationMsOf(value);

  const chooseWindow = (): void => {
    if (value.kind === 'window') return;
    const at = defaultWindowAt();
    onChange({ kind: 'window', at, endAt: new Date(Date.parse(at) + DEFAULT_WINDOW_MS).toISOString() });
  };

  const onDateChange = (raw: string): void => {
    const at = localInputToIso(raw);
    if (at === undefined) {
      onChange({ kind: 'window', at: '', endAt: undefined });
      return;
    }
    onChange({ kind: 'window', at, endAt: new Date(Date.parse(at) + duration).toISOString() });
  };

  const onDurationChange = (ms: number): void => {
    if (value.kind !== 'window' || value.at === '') return;
    const atMs = Date.parse(value.at);
    if (!Number.isFinite(atMs)) return;
    onChange({ kind: 'window', at: value.at, endAt: new Date(atMs + ms).toISOString() });
  };

  return (
    <div className="sched" role="radiogroup" aria-label="When to apply">
      <label className={`sched__opt${kind === 'now' ? ' sched__opt--on' : ''}`}>
        <input
          type="radio"
          name={name}
          checked={kind === 'now'}
          onChange={() => onChange({ kind: 'now' })}
        />
        <span className="sched__opt-body">
          <span className="sched__opt-title">Apply right after approval</span>
          <span className="sched__opt-help">
            The change applies as soon as it has the approvals it needs.
          </span>
        </span>
      </label>

      <label className={`sched__opt${kind === 'window' ? ' sched__opt--on' : ''}`}>
        <input
          type="radio"
          name={name}
          checked={kind === 'window'}
          onChange={chooseWindow}
        />
        <span className="sched__opt-body">
          <span className="sched__opt-title">Schedule a maintenance window</span>
          <span className="sched__opt-help">
            Hold the approved change and apply it at a date and time you pick.
          </span>
          {kind === 'window' && (
            <>
              <span className="sched__row">
                <input
                  type="datetime-local"
                  className="sched__when"
                  value={localValue}
                  aria-label="Maintenance window date and time"
                  aria-invalid={error !== undefined}
                  onChange={(e) => onDateChange(e.target.value)}
                />
                <select
                  className="sched__duration"
                  aria-label="Maintenance window duration"
                  value={duration}
                  onChange={(e) => onDurationChange(Number(e.target.value))}
                >
                  {DURATION_OPTIONS.map((d) => (
                    <option key={d.ms} value={d.ms}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </span>
              {value.at !== '' && !error && (
                <span className="sched__preview">
                  = {formatProjectTime(value.at)}
                  {value.endAt ? ` → ${formatProjectTime(value.endAt)}` : ''}
                </span>
              )}
              {error && (
                <span className="rq-field__error" role="alert">
                  {error}
                </span>
              )}
            </>
          )}
        </span>
      </label>
    </div>
  );
}
