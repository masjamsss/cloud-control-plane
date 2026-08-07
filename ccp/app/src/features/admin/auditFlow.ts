import type { AuditEntry as LocalAuditEntry } from '@/lib/audit';
import type { AuditEntry as ServerAuditEntry, AuditExport, HttpApiClient } from '@/lib/httpApi';

/**
 * Audit history's ADVISORY → AUTHORITATIVE branch.
 * `can('audit')` flipping true is a TRUST signal — AuditHistory drops its
 * "recorded locally" note the instant it does — so the entries it renders had
 * better actually be ccp-api's hash-chained log at that point, not
 * lib/audit's client-forgeable localStorage array still under a mismatched
 * label. This module is the one place that decides which store answers the
 * timeline, pulled out of the component so it's unit-testable without
 * mounting one (this repo has no jsdom — see test/standalone.test.ts). Mirrors
 * features/auth/authFlow.ts's shape.
 */

/** The shape both stores render into — local entries already carry a
 * `summary`; server entries don't, so {@link describeServerEntry} derives one. */
export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  summary: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * A generic, honest fallback label for a server action code this view has no
 * specific formatting for below: kebab/snake-case → capitalized words (e.g.
 * "policy-change" → "Policy change"). GET /admin/audit returns the WHOLE
 * project-wide chain, which may hold actions no admin surface in this build
 * writes yet (policy/risk/settings/enroll/...) — those still render, just
 * without the polish {@link describeServerEntry} gives the flows this build
 * actually wires (team CRUD, TOTP reset, session revoke).
 */
export function humanizeAction(action: string): string {
  const words = action.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return action;
  const [first, ...rest] = words;
  return [`${first!.charAt(0).toUpperCase()}${first!.slice(1)}`, ...rest].join(' ');
}

/** Render one server entry's `action`/`before`/`after` into the {action,
 * summary} shape the local store already carries natively. */
export function describeServerEntry(e: ServerAuditEntry): { action: string; summary: string } {
  const after = isRecord(e.after) ? e.after : undefined;
  const before = isRecord(e.before) ? e.before : undefined;
  const target = e.targetId ? `${e.targetType} ${e.targetId}` : e.targetType;
  switch (e.action) {
    case 'team-create':
      return { action: 'Created team', summary: str(after?.name) ?? e.targetId };
    case 'team-rename': {
      const from = str(before?.name);
      const to = str(after?.name);
      return { action: 'Renamed team', summary: from && to ? `${from} → ${to}` : e.targetId };
    }
    case 'team-set-services':
      return { action: 'Updated team services', summary: e.targetId };
    case 'team-delete':
      return { action: 'Deleted team', summary: str(before?.name) ?? e.targetId };
    case 'totp-reset':
      return { action: 'Reset TOTP', summary: `@${e.targetId}` };
    case 'sessions-revoke':
      return { action: 'Revoked sessions', summary: `@${e.targetId}` };
    default:
      return { action: humanizeAction(e.action), summary: target };
  }
}

export function serverEntryToRow(e: ServerAuditEntry): AuditRow {
  const { action, summary } = describeServerEntry(e);
  return { id: e.id, at: e.at, actor: e.actor, action, summary };
}

export function localEntryToRow(e: LocalAuditEntry): AuditRow {
  return { id: e.id, at: e.at, actor: e.actor, action: e.action, summary: e.summary };
}

/** One page of the timeline. `cursor` mirrors `httpApi.ts`'s `AuditPage.cursor` —
 * present only when the server has more entries beyond this page. The
 * local/advisory branch has no pagination at all (the whole log is always
 * one page), so it never sets one. */
export interface AuditRowsPage {
  rows: AuditRow[];
  cursor?: string;
}

/**
 * Which store answers the timeline: ccp-api's hash-chained log when it
 * serves this flow (`authoritative` — exactly `can('audit')`), else the exact
 * pre-existing local/advisory list, unchanged. `localEntries` is passed in
 * (rather than read here via lib/audit) so this stays a pure function of its
 * arguments, same as the rest of this module.
 *
 * FE-8 — the server call used to always ask for the default page (no
 * `cursor`) and threw the returned `cursor` away, so anything past the
 * server's default 100-entry limit was silently absent — an important gap
 * on an evidence surface. `cursor` (present only in the authoritative
 * branch — the local branch is never paginated) lets a caller (AuditHistory's
 * "Load older" control) walk the rest of the chain.
 */
export async function loadAuditRows(
  authoritative: boolean,
  client: HttpApiClient | null,
  localEntries: LocalAuditEntry[],
  cursor?: string,
): Promise<AuditRowsPage> {
  if (authoritative && client) {
    const page = await client.listAuditEntries(cursor ? { cursor } : undefined);
    return { rows: page.items.map(serverEntryToRow), cursor: page.cursor };
  }
  return { rows: localEntries.map(localEntryToRow) };
}

/** The whole hash-chained log as a self-verifying evidence document — only
 * ever meaningful once ccp-api serves `audit` (the demo export below is
 * the local stand-in). */
export async function exportAuditVia(client: HttpApiClient): Promise<AuditExport> {
  return client.exportAudit();
}

/**
 * The demo export: this browser's advisory audit log as a downloadable
 * document. Deliberately NOT the {@link AuditExport} shape — the local store
 * has no hash chain, so the document says exactly what it is (`source`)
 * instead of carrying fake verification fields. Shares `projectId` with the
 * server document so AuditHistory names the file the same way for both.
 */
export interface LocalAuditExport {
  projectId: string;
  source: 'browser-local';
  count: number;
  entries: LocalAuditEntry[];
}

export function localAuditExport(projectId: string, entries: LocalAuditEntry[]): LocalAuditExport {
  return { projectId, source: 'browser-local', count: entries.length, entries };
}
