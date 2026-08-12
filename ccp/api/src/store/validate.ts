import { z } from 'zod';
import type { Item } from './configStore';
import * as S from './schema';

/**
 * DATA-5 — run the stored rows through the schemas that describe them.
 *
 * `schema.ts` has carried an executable zod schema per entity since the beginning, and
 * `test/store.test.ts` proves those schemas reject malformed fixtures — but nothing ever
 * ran one against data read from the store. `FileStore.load` failed closed on an empty
 * file and on a JSON syntax error, and on nothing else: a hand-edit, a half-restored
 * backup, a partial write by another tool, a row from a version whose invariants this
 * one predates, all loaded and flowed through unchecked `as XItem` casts into auth and
 * domain logic. The failure surfaced as `NaN` lockout math or an `undefined` role deep
 * inside a handler, not as a refused boot naming the row.
 *
 * WHY THIS IS A REPORT AND NOT A THROW. Tightening a schema against data that already
 * exists fails a BOOT rather than a test, which is why the same shim was deferred once
 * already (RESIDUE R-41): getting the legacy passthrough wrong takes the service down at
 * exactly the moment nobody can afford it. So the layers are split by how certain they
 * are —
 *
 *   · the structural invariants the INDEX itself depends on (an item is an object, its
 *     PK/SK are non-empty separator-free strings, no key appears twice) are enforced by
 *     `MemoryStore.importItems` and always fail closed. A row that violates them cannot
 *     be stored or read back correctly under any interpretation;
 *   · everything an ENTITY schema says is checked here and REPORTED, loudly, per row, with
 *     the failing field paths — and refuses the boot only when the operator asks for that
 *     (`CCP_STORE_VALIDATE=strict`).
 *
 * A shape this classifier does not recognise is NOT a violation. Unknown rows are the
 * legacy passthrough: a store written by a newer binary, or a row type retired before this
 * one shipped, must load. They are counted and named in the report so "the validator saw
 * nothing" and "the validator understood nothing" can never look alike (L-1).
 */

/** `{ requestId }` marker written by an idempotent submit — no entity schema of its own. */
const IdempotencyMarker = z.object({ PK: z.string(), SK: z.string(), requestId: z.string() });
/** Presence-only marker rows: their existence is the whole payload. */
const MarkerRow = z.object({ PK: z.string(), SK: z.string() });

type Shape = { name: string; schema: z.ZodTypeAny };

const shape = (name: string, schema: z.ZodTypeAny): Shape => ({ name, schema });

/**
 * (PK, SK) → the entity schema that row must satisfy.
 *
 * Written as a rule per key FAMILY rather than a list of known keys: the families are
 * exactly the key helpers in `schema.ts`, so a new row type is recognised the moment it
 * uses one, and a row keyed by hand — the shape that has no helper and no schema — falls
 * out as `unknown` instead of quietly validating against a neighbour's schema.
 */
export function classifyRow(pk: string, sk: string): Shape | null {
  // GLOBAL identity + registry
  if (pk.startsWith('ACCOUNT#') && sk === 'META') return shape('AccountItem', S.AccountItem);
  if (pk.startsWith('SESSION#') && sk === 'META') return shape('SessionItem', S.SessionItem);
  if (pk === 'SETTLEMENT' && sk === 'META') return shape('SettlementItem', S.SettlementItem);
  if (pk === 'INSTANCE' && sk === 'META') return shape('InstanceItem', S.InstanceItem);
  if (pk === 'VERSIONSTAMP' && sk === 'META') return shape('VersionStampMarker', MarkerRow);
  if (pk.startsWith('PROJECT#')) {
    if (sk === 'META') return shape('ProjectItem', S.ProjectItem);
    if (sk === 'FORGECRED') return shape('ProjectForgeCredentialItem', S.ProjectForgeCredentialItem);
    if (sk === 'DRIFT#latest') return shape('DriftPointerItem', S.DriftPointerItem);
    if (sk.startsWith(S.PROJECT_DATA_SK_PREFIX)) return shape('ProjectDataVersionItem', S.ProjectDataVersionItem);
    if (sk.startsWith(S.DRIFT_VERSION_SK_PREFIX)) return shape('DriftReportItem', S.DriftReportItem);
    if (sk.startsWith(S.DRIFT_PROPOSAL_SK_PREFIX)) return shape('DriftProposalItem', S.DriftProposalItem);
    if (sk.startsWith('UPLOADTOKEN#')) return shape('ProjectUploadTokenItem', S.ProjectUploadTokenItem);
    if (sk.startsWith(S.ONBOARD_TOKEN_SK_PREFIX)) return shape('ProjectOnboardTokenItem', S.ProjectOnboardTokenItem);
    if (sk.startsWith(S.SCAN_JOB_SK_PREFIX)) return shape('ProjectScanJobItem', S.ProjectScanJobItem);
    return null;
  }
  // PROJECT-SCOPED — `P#<projectId>#<family>`
  if (!pk.startsWith('P#')) return null;
  const rest = pk.slice(2);
  const cut = rest.indexOf('#');
  if (cut < 0) return null;
  const family = rest.slice(cut + 1);
  if (family.startsWith('TEAM#') && sk === 'META') return shape('TeamItem', S.TeamItem);
  if (family === 'POLICY') return shape('PolicyItem', S.PolicyItem); // SK: CURRENT | VERSION#<n>
  if (family.startsWith('RISKOVR#') && sk === 'CURRENT') return shape('RiskOverrideItem', S.RiskOverrideItem);
  if (family.startsWith('SETTING#') && sk === 'CURRENT') return shape('SettingItem', S.SettingItem);
  if (family.startsWith('REQ#')) {
    if (sk === 'META') return shape('RequestItem', S.RequestItem);
    if (sk.startsWith('APPROVAL#')) return shape('ApprovalItem', S.ApprovalItem);
    if (sk.startsWith('EVT#')) return shape('RequestEventItem', S.RequestEventItem);
    return null;
  }
  if (family.startsWith('IDEMPOTENCY#') && sk === 'META') return shape('IdempotencyMarker', IdempotencyMarker);
  if (family.startsWith('CONFIGCHANGE#') && sk === 'META') return shape('PendingConfigChangeItem', S.PendingConfigChangeItem);
  if (family === 'AUDIT' && sk === 'CHAINHEAD') return shape('ChainHeadItem', S.ChainHeadItem);
  if (/^AUDIT#\d{6}$/.test(family)) return shape('AuditItem', S.AuditItem);
  return null;
}

export type RowViolation = {
  index: number;
  pk: string;
  sk: string;
  shape: string;
  /** Field paths + messages from the schema, e.g. `roles.sample.role: Required`. */
  issues: string[];
};

export type SnapshotReport = {
  total: number;
  /** Rows whose shape was recognised AND run through a schema. */
  checked: number;
  violations: RowViolation[];
  /** Rows no rule recognised — carried through untouched (see the module doc). */
  unknown: number;
  /** A bounded sample of the unrecognised keys, for the report line. */
  unknownKeys: string[];
  /** Rows carrying GSI1PK with no GSI1SK: served here, absent from a real GSI (DATA-14). */
  halfIndexed: string[];
};

const MAX_ISSUES_PER_ROW = 6;
const MAX_UNKNOWN_SAMPLE = 10;

/** Run every row through the schema for its key family. Never throws on the DATA. */
export function validateSnapshot(items: readonly Item[]): SnapshotReport {
  const report: SnapshotReport = { total: items.length, checked: 0, violations: [], unknown: 0, unknownKeys: [], halfIndexed: [] };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const pk = typeof it?.PK === 'string' ? it.PK : '';
    const sk = typeof it?.SK === 'string' ? it.SK : '';
    if (typeof it?.GSI1PK === 'string' && typeof it.GSI1SK !== 'string') report.halfIndexed.push(`${pk}/${sk}`);
    const cls = classifyRow(pk, sk);
    if (!cls) {
      report.unknown++;
      if (report.unknownKeys.length < MAX_UNKNOWN_SAMPLE) report.unknownKeys.push(`${pk}/${sk}`);
      continue;
    }
    report.checked++;
    const res = cls.schema.safeParse(it);
    if (res.success) continue;
    report.violations.push({
      index: i,
      pk,
      sk,
      shape: cls.name,
      issues: res.error.issues.slice(0, MAX_ISSUES_PER_ROW).map((iss) => `${iss.path.join('.') || '<row>'}: ${iss.message}`),
    });
  }
  return report;
}

/** How the validator behaves at boot. */
export type ValidateMode = 'off' | 'warn' | 'strict';

/**
 * `CCP_STORE_VALIDATE` — `warn` (default), `strict` (refuse to boot on any violation),
 * or `off`. An unrecognised value is `warn`: a typo in an ops variable must not silently
 * turn a check off (L-1), and must not brick a boot either.
 */
export function validateMode(env: Record<string, string | undefined> = process.env): ValidateMode {
  const v = (env.CCP_STORE_VALIDATE ?? '').trim().toLowerCase();
  return v === 'off' || v === 'strict' ? v : 'warn';
}

/** The operator-facing lines for a report that found something. Empty when clean. */
export function describeReport(report: SnapshotReport, source: string): string[] {
  const lines: string[] = [];
  for (const v of report.violations) {
    lines.push(`  row ${v.index} ${v.pk}/${v.sk} (${v.shape}): ${v.issues.join('; ')}`);
  }
  if (lines.length > 0) {
    lines.unshift(
      `${source}: ${report.violations.length} of ${report.checked} recognised row(s) do not match their schema — this store's data is corrupt or was written by an incompatible version:`,
    );
    lines.push(
      '  Set CCP_STORE_VALIDATE=strict to refuse to boot on this, or =off to skip the check entirely. Booting anyway: the rows above are served as-is.',
    );
  }
  for (const key of report.halfIndexed.slice(0, MAX_UNKNOWN_SAMPLE)) {
    lines.push(`${source}: row ${key} has GSI1PK but no GSI1SK — served by queryGSI1 here, absent from a composite-key GSI on DynamoDB (DATA-14).`);
  }
  return lines;
}
