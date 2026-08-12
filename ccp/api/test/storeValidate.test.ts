import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as S from '../src/store/schema';
import { classifyRow, describeReport, validateMode, validateSnapshot } from '../src/store/validate';
import { FileStore } from '../src/store/fileStore';
import type { Item } from '../src/store/configStore';
import { schemaCases } from './store.test';

/**
 * DATA-5 — the store's read path never ran a stored row through the schema that
 * describes it. `classifyRow` is the NEW logic (which key family maps to which
 * entity schema, written as a rule per family rather than an enumerated key list —
 * L-25); `validateSnapshot`/`describeReport`/`validateMode` are tested against it
 * directly here. The FileStore integration (warn/strict/off actually changing boot
 * behavior) is proven separately below.
 */
describe('classifyRow — key family routing (the new logic; schema correctness is store.test.ts\'s job)', () => {
  const cases: Array<{ label: string; pk: string; sk: string; name: string | null }> = [
    { label: 'account', pk: S.accountKey('sari').PK, sk: S.accountKey('sari').SK, name: 'AccountItem' },
    { label: 'session', pk: S.sessionKey('deadbeef').PK, sk: S.sessionKey('deadbeef').SK, name: 'SessionItem' },
    { label: 'settlement marker', pk: S.settlementKey().PK, sk: S.settlementKey().SK, name: 'SettlementItem' },
    { label: 'instance', pk: S.instanceKey().PK, sk: S.instanceKey().SK, name: 'InstanceItem' },
    { label: 'version-stamp marker', pk: 'VERSIONSTAMP', sk: 'META', name: 'VersionStampMarker' },
    { label: 'project registry row', pk: S.projectKey('acme').PK, sk: S.projectKey('acme').SK, name: 'ProjectItem' },
    { label: 'forge credential', pk: S.forgeCredentialKey('acme').PK, sk: S.forgeCredentialKey('acme').SK, name: 'ProjectForgeCredentialItem' },
    { label: 'drift pointer', pk: S.driftPointerKey('acme').PK, sk: S.driftPointerKey('acme').SK, name: 'DriftPointerItem' },
    { label: 'project data version', pk: S.projectDataVersionKey('acme', 1).PK, sk: S.projectDataVersionKey('acme', 1).SK, name: 'ProjectDataVersionItem' },
    { label: 'drift report version', pk: S.driftVersionKey('acme', 1).PK, sk: S.driftVersionKey('acme', 1).SK, name: 'DriftReportItem' },
    { label: 'drift proposal', pk: S.driftProposalKey('acme', 'a'.repeat(64)).PK, sk: S.driftProposalKey('acme', 'a'.repeat(64)).SK, name: 'DriftProposalItem' },
    { label: 'upload token', pk: S.uploadTokenKey('acme', 't1').PK, sk: S.uploadTokenKey('acme', 't1').SK, name: 'ProjectUploadTokenItem' },
    { label: 'onboard token', pk: S.onboardTokenKey('acme', 't1').PK, sk: S.onboardTokenKey('acme', 't1').SK, name: 'ProjectOnboardTokenItem' },
    { label: 'scan job', pk: S.scanJobKey('acme', 'j1').PK, sk: S.scanJobKey('acme', 'j1').SK, name: 'ProjectScanJobItem' },
    { label: 'team', pk: S.teamKey('acme', 'app-platform').PK, sk: S.teamKey('acme', 'app-platform').SK, name: 'TeamItem' },
    { label: 'policy', pk: S.policyKey('acme').PK, sk: S.policyKey('acme').SK, name: 'PolicyItem' },
    { label: 'risk override', pk: S.riskOverrideKey('acme', 'ec2-resize').PK, sk: S.riskOverrideKey('acme', 'ec2-resize').SK, name: 'RiskOverrideItem' },
    { label: 'setting', pk: S.settingKey('acme', 'limits.submissionsPerHour').PK, sk: S.settingKey('acme', 'limits.submissionsPerHour').SK, name: 'SettingItem' },
    { label: 'request', pk: S.requestKey('acme', '01J0000000000000000000000A').PK, sk: S.requestKey('acme', '01J0000000000000000000000A').SK, name: 'RequestItem' },
    { label: 'approval', pk: S.approvalKey('acme', '01J0000000000000000000000A', 'wati').PK, sk: S.approvalKey('acme', '01J0000000000000000000000A', 'wati').SK, name: 'ApprovalItem' },
    { label: 'request event', pk: S.eventKey('acme', '01J0000000000000000000000A', 1).PK, sk: S.eventKey('acme', '01J0000000000000000000000A', 1).SK, name: 'RequestEventItem' },
    { label: 'idempotency marker', pk: S.requestIdempotencyKey('acme', 'sari', 'k1').PK, sk: S.requestIdempotencyKey('acme', 'sari', 'k1').SK, name: 'IdempotencyMarker' },
    { label: 'pending config change', pk: S.configChangeKey('acme', '01J0000000000000000000000A').PK, sk: S.configChangeKey('acme', '01J0000000000000000000000A').SK, name: 'PendingConfigChangeItem' },
    { label: 'chain head', pk: S.chainHead('acme').PK, sk: S.chainHead('acme').SK, name: 'ChainHeadItem' },
    { label: 'audit entry', pk: S.auditKey('acme', '202607', '01J0000000000000000000000A').PK, sk: S.auditKey('acme', '202607', '01J0000000000000000000000A').SK, name: 'AuditItem' },
    { label: 'a hand-typed row with no key-helper family (adversarial/corrupt)', pk: 'BOGUS#x', sk: 'META', name: null },
    { label: 'a project-scoped row with an unrecognized family (adversarial/corrupt)', pk: 'P#acme#NOPE#x', sk: 'META', name: null },
  ];

  it.each(cases)('$label → $name', ({ pk, sk, name }) => {
    const cls = classifyRow(pk, sk);
    expect(cls?.name ?? null, `classifyRow(${JSON.stringify(pk)}, ${JSON.stringify(sk)})`).toBe(name);
  });

  it('the routing table is exhaustive over every case above — L-1: this loop must not silently test zero families', () => {
    // A regression against "the it.each list quietly shrank to one case and still passed."
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((c) => c.name !== null).length).toBeGreaterThanOrEqual(18);
  });
});

describe('validateSnapshot — runs recognized rows through their schema, reports rather than throws', () => {
  it('every schemaCases valid fixture passes; dropping its required field is reported as a violation naming that field', () => {
    for (const c of schemaCases) {
      const clean = validateSnapshot([c.valid]);
      expect(clean.violations, c.name).toEqual([]);
      expect(clean.checked, c.name).toBe(1);
      expect(clean.unknown, c.name).toBe(0);

      const broken = { ...c.valid } as Record<string, unknown>;
      delete broken[c.drop];
      const dirty = validateSnapshot([broken as Item]);
      expect(dirty.violations, c.name).toHaveLength(1);
      expect(dirty.violations[0]!.shape).toBe(c.name);
      expect(dirty.violations[0]!.issues.some((i) => i.startsWith(c.drop)), dirty.violations[0]!.issues.join('; ')).toBe(true);
    }
  });

  it('an unrecognized row is counted as unknown, never as a violation — the legacy-passthrough rule', () => {
    const report = validateSnapshot([{ PK: 'FUTURE-BINARY#x', SK: 'META', someField: 1 }]);
    expect(report.violations).toEqual([]);
    expect(report.unknown).toBe(1);
    expect(report.unknownKeys).toEqual(['FUTURE-BINARY#x/META']);
    expect(report.checked).toBe(0);
  });

  it('caps the unknown-key sample and the per-row issue list rather than growing unbounded', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ PK: `UNKNOWN#${i}`, SK: 'META' }));
    const report = validateSnapshot(many);
    expect(report.unknown).toBe(15);
    expect(report.unknownKeys.length).toBeLessThan(15);

    const brokenAccount = { ...S.accountKey('x') }; // every required field missing at once
    const dirty = validateSnapshot([brokenAccount]);
    expect(dirty.violations[0]!.issues.length).toBeLessThanOrEqual(6);
  });

  it('DATA-14 — a row with GSI1PK but no GSI1SK is flagged half-indexed (served by queryGSI1 here, absent from a real composite-key GSI)', () => {
    const row = { ...S.accountKey('sari'), id: 'sari', username: 'sari', displayName: 'S', role: 'requester', teamId: 't', status: 'active', createdAt: 'x', createdBy: 'x', mustChangePassword: false, isAdmin: false, credential: { algo: 'argon2id', hash: 'x' }, failedAttempts: 0, sessionVersion: 1, GSI1PK: S.accountsGsi() };
    const report = validateSnapshot([row as unknown as Item]);
    expect(report.halfIndexed).toEqual([`${row.PK}/${row.SK}`]);
  });

  it('a row with BOTH GSI1PK and GSI1SK is not flagged half-indexed', () => {
    const row = { ...S.teamKey('acme', 'app-platform'), id: 'app-platform', name: 'App Platform', serviceSlugs: [], version: 1, GSI1PK: S.teamCollectionGsi('acme'), GSI1SK: 'app-platform' };
    const report = validateSnapshot([row]);
    expect(report.halfIndexed).toEqual([]);
  });
});

describe('validateMode — CCP_STORE_VALIDATE parsing', () => {
  it('recognizes off/strict case-insensitively; anything else (including unset) is warn — L-1: a typo must not silently disable the check', () => {
    expect(validateMode({ CCP_STORE_VALIDATE: 'off' })).toBe('off');
    expect(validateMode({ CCP_STORE_VALIDATE: 'OFF' })).toBe('off');
    expect(validateMode({ CCP_STORE_VALIDATE: 'strict' })).toBe('strict');
    expect(validateMode({ CCP_STORE_VALIDATE: ' Strict ' })).toBe('strict');
    expect(validateMode({ CCP_STORE_VALIDATE: 'warn' })).toBe('warn');
    expect(validateMode({ CCP_STORE_VALIDATE: 'strcit' })).toBe('warn'); // typo — fails open to the checking side, not the silent side
    expect(validateMode({})).toBe('warn');
  });
});

describe('describeReport — operator-facing lines', () => {
  it('is empty for a clean report', () => {
    expect(describeReport(validateSnapshot([]), 'src')).toEqual([]);
  });

  it('names the source, the row, its shape, and the field issues; ends with the how-to-configure line', () => {
    const broken = { ...S.accountKey('sari') };
    const lines = describeReport(validateSnapshot([broken]), 'ccp data file /tmp/x.json');
    expect(lines[0]).toContain('ccp data file /tmp/x.json');
    expect(lines.some((l) => l.includes('ACCOUNT#sari/META'))).toBe(true);
    expect(lines.some((l) => l.includes('AccountItem'))).toBe(true);
    expect(lines.at(-1)).toContain('CCP_STORE_VALIDATE=strict');
  });

  it('reports halfIndexed rows too, even when there are no schema violations', () => {
    const row = { PK: 'X', SK: 'Y', GSI1PK: 'Z' };
    const lines = describeReport(validateSnapshot([row]), 'src');
    expect(lines.some((l) => l.includes('GSI1PK but no GSI1SK'))).toBe(true);
  });
});

/* ── FileStore integration: the mode actually changes boot behavior ─────────────────── */

const roots: string[] = [];
function mkFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-storevalidate-'));
  roots.push(dir);
  return join(dir, 'ccp.json');
}
afterEach(() => {
  delete process.env.CCP_STORE_VALIDATE;
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('FileStore.load — CCP_STORE_VALIDATE actually gates the boot', () => {
  async function writeBrokenStore(file: string): Promise<void> {
    const s1 = await FileStore.open(file);
    // A row that will fail its OWN schema once read back: PolicyItem requires integers
    // 1..5, this one is out of range — written directly (bypassing route-level
    // validation) to simulate a hand-edit / half-restored backup / older-binary row.
    await s1.put({ ...S.policyKey('acme'), low: 0, medium: 1, high: 2, deleteMin: 2, version: 1 });
    s1.close(); // release the exclusive lock — the next open() in each test IS the restart
  }

  it('strict: refuses to boot on a violating row, naming it', async () => {
    const file = mkFile();
    await writeBrokenStore(file);
    process.env.CCP_STORE_VALIDATE = 'strict';
    await expect(FileStore.open(file)).rejects.toThrow(/PolicyItem/);
  });

  it('warn (default): boots anyway and logs the violation to stderr — does not throw', async () => {
    const file = mkFile();
    await writeBrokenStore(file);
    process.env.CCP_STORE_VALIDATE = 'warn';
    const spy: string[] = [];
    const orig = console.error;
    console.error = (s: unknown) => spy.push(String(s));
    try {
      const s2 = await FileStore.open(file);
      expect(s2).toBeTruthy();
    } finally {
      console.error = orig;
    }
    expect(spy.some((l) => l.includes('PolicyItem'))).toBe(true);
  });

  it('off: boots silently, no report at all', async () => {
    const file = mkFile();
    await writeBrokenStore(file);
    process.env.CCP_STORE_VALIDATE = 'off';
    const spy: string[] = [];
    const orig = console.error;
    console.error = (s: unknown) => spy.push(String(s));
    try {
      await FileStore.open(file);
    } finally {
      console.error = orig;
    }
    expect(spy).toEqual([]);
  });

  it('a clean store never logs anything, in any mode', async () => {
    const file = mkFile();
    const s1 = await FileStore.open(file);
    await s1.put({ ...S.policyKey('acme'), low: 1, medium: 1, high: 2, deleteMin: 2, version: 1 });
    s1.close();
    for (const mode of ['off', 'warn', 'strict']) {
      process.env.CCP_STORE_VALIDATE = mode;
      const spy: string[] = [];
      const orig = console.error;
      console.error = (s: unknown) => spy.push(String(s));
      let reopened: FileStore;
      try {
        reopened = await FileStore.open(file);
      } finally {
        console.error = orig;
      }
      reopened!.close();
      expect(spy, mode).toEqual([]);
    }
  });
});
