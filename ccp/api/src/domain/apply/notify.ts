/**
 * 0038 T5 — the human-alert seam for scheduled auto-apply.
 *
 * Cloud Control Plane has NO server-side notification DISPATCHER today (the app's
 * `notifications.channels` setting is UI config the server never sends through). So
 * the scheduler surfaces state to humans the two ways this codebase actually does:
 *   1. the request `events[]` timeline (user-facing) — appended on the status write, and
 *   2. the hash-chained audit (tamper-evident record) — under `actor:'system:scheduler'`.
 * BOTH are done by the scheduler directly.
 *
 * This `Notifier` is the THIRD, injectable channel: an explicit "alert a human" seam so
 * a halt or a failure can page someone. It ships with a {@link ConsoleNotifier} default;
 * real email/Slack/PagerDuty wiring lands in a LATER step behind this SAME interface —
 * the parallel of {@link ./executor.DryRunExecutor} being the seam where real terraform
 * lands later. Nothing here performs network I/O.
 */

export type NotificationKind =
  | 'apply-started'
  | 'applied'
  | 'halted-no-plan'
  | 'halted-quorum'
  | 'halted-drift'
  | 'apply-failed'
  | 'reverted'
  | 'frozen';

export interface SchedulerNotification {
  kind: NotificationKind;
  projectId: string;
  requestId: string;
  message: string;
  /** ISO instant, derived from the scheduler's `now` param (never a live clock read). */
  at: string;
}

export interface Notifier {
  notify(n: SchedulerNotification): void | Promise<void>;
}

/**
 * The default human-alert channel: log a structured line. A `halted-*`/`apply-failed`
 * notification is exactly the "a human must look now" signal a later step routes to a
 * real pager. Deliberately dependency-free and side-effect-light (stdout only).
 */
export class ConsoleNotifier implements Notifier {
  notify(n: SchedulerNotification): void {
    const level = n.kind === 'applied' || n.kind === 'apply-started' ? 'log' : 'warn';
    // eslint-disable-next-line no-console
    console[level](`[ccp:scheduler] ${n.kind} ${n.projectId}/${n.requestId} — ${n.message}`);
  }
}

/** A no-op notifier for contexts that only want the audit + event trail. */
export const nullNotifier: Notifier = { notify: () => {} };
