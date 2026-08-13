import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/store/fileStore';
import { bootstrap } from '../scripts/bootstrap';
import { record } from '../src/domain/audit';
import { exportAuditChain } from '../src/domain/auditQuery';
import { accountsGsi, type AccountItem } from '../src/store/schema';
import { runBackup } from '../scripts/backup';
import { runRestore } from '../scripts/restore';

/**
 * Task 3 — the operational answer to "what if the disk/host dies". A backup, a wiped
 * data file, then a restore must round-trip the accounts AND the audit chain, and the
 * chain must still verify. Restore also refuses a corrupt/empty backup (fail-closed).
 */

let dir: string;
let dataFile: string;
let backupFile: string;
const silent = { log: () => {}, error: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccp-br-'));
  dataFile = join(dir, 'ccp.json');
  backupFile = join(dir, 'backup.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Build a real durable store: one bootstrap admin + a 4-entry audit chain on 'sample'. */
async function seedStore(): Promise<{ head: string; count: number; accountIds: string[] }> {
  const store = await FileStore.open(dataFile);
  await bootstrap(store, { print: () => {} }); // seeds 'putra'
  for (let i = 0; i < 4; i++) {
    await record(store, 'sample', { action: `act-${i}`, actor: 'putra', targetType: 'session', targetId: 'putra' });
  }
  const chain = await exportAuditChain(store, 'sample');
  const accounts = (await store.queryGSI1(accountsGsi())) as AccountItem[];
  expect(chain.verified).toBe(true);
  // The seeding "server" goes away before anything else opens this file. CONC-7/DATA-9
  // gave the data file a single-writer lock, and a restore landing under a LIVE server is
  // the exact defect it closes: the atomic write installs the backup, and the server's
  // next persist rewrites the file from its own memory and silently discards it.
  store.close();
  return { head: chain.head, count: chain.count, accountIds: accounts.map((a) => a.id) };
}

describe('backup → wipe → restore round-trips accounts + audit chain', () => {
  it('restores byte-identical accounts and a still-verifying chain after the file is wiped', async () => {
    const before = await seedStore();
    expect(before.count).toBe(4);
    expect(before.accountIds).toEqual(['putra']);

    // 1) back up the live data file
    const b = await runBackup({ dataFile, out: backupFile, io: silent });
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.summary.allVerified).toBe(true);
      expect(b.summary.accountCount).toBe(1);
      expect(b.summary.chains).toEqual([
        expect.objectContaining({ projectId: 'sample', count: 4, head: before.head, verified: true }),
      ]);
    }
    expect(existsSync(backupFile)).toBe(true);

    // 2) DISK DEATH — the data file vanishes
    rmSync(dataFile);
    expect(existsSync(dataFile)).toBe(false);

    // 3) restore from the backup
    const r = await runRestore({ backup: backupFile, dataFile, io: silent });
    expect(r.ok).toBe(true);

    // 4) a fresh process reads the restored file: accounts + chain survived and verify
    const restored = await FileStore.open(dataFile);
    const accounts = (await restored.queryGSI1(accountsGsi())) as AccountItem[];
    expect(accounts.map((a) => a.id)).toEqual(before.accountIds);

    const chain = await exportAuditChain(restored, 'sample');
    expect(chain.verified).toBe(true); // hash linkage intact after restore
    expect(chain.count).toBe(before.count);
    expect(chain.head).toBe(before.head); // byte-identical evidence head
  });
});

describe('restore fails closed on a bad backup', () => {
  it('refuses a backup whose audit chain does not verify (unless --force)', async () => {
    await seedStore();
    await runBackup({ dataFile, out: backupFile, io: silent });

    // Tamper one audit entry's hash → the chain no longer verifies.
    const items = JSON.parse(readFileSync(backupFile, 'utf8')) as Array<Record<string, unknown>>;
    const entry = items.find((it) => typeof it.PK === 'string' && /AUDIT#\d{6}$/.test(it.PK as string));
    expect(entry).toBeDefined();
    entry!.hash = 'deadbeef-tampered';
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, JSON.stringify(items));

    rmSync(dataFile); // simulate we're restoring into a lost store

    const refused = await runRestore({ backup: corrupt, dataFile, io: silent });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/does not verify/i);
    expect(existsSync(dataFile)).toBe(false); // nothing was written

    // --force installs it anyway (deliberate disaster restore)
    const forced = await runRestore({ backup: corrupt, dataFile, force: true, io: silent });
    expect(forced.ok).toBe(true);
    expect(existsSync(dataFile)).toBe(true);
  });

  it('refuses an empty/whitespace backup (fail-closed parse)', async () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '   \n ');
    const res = await runRestore({ backup: empty, dataFile, io: silent });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/empty\/whitespace|not a valid snapshot/i);
  });

  it('backup of an absent data file reports failure', async () => {
    const res = await runBackup({ dataFile: join(dir, 'nope.json'), out: backupFile, io: silent });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not exist/i);
  });
});

/* ── DATA-10: backup/restore also covers the on-disk project-data/drift root ── */

describe('DATA-10 — backup/restore covers the project-data root, not just the store JSON', () => {
  let projectDataRoot: string;
  beforeEach(() => {
    projectDataRoot = join(dir, 'projects');
  });

  it('backup captures the project-data root; restore installs it back after disk death', async () => {
    await seedStore();
    mkdirSync(join(projectDataRoot, 'acme', 'v1', 'blocks'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), '{"resources":[]}');
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'blocks', 'index.json'), '{}');

    const b = await runBackup({ dataFile, out: backupFile, projectDataRoot, io: silent });
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.projectDataOut).not.toBeNull();
      expect(existsSync(b.projectDataOut!)).toBe(true);
      expect(existsSync(join(b.projectDataOut!, 'acme', 'v1', 'inventory.json'))).toBe(true);
    }

    // DISK DEATH — both the store file AND the project-data root vanish
    rmSync(dataFile);
    rmSync(projectDataRoot, { recursive: true, force: true });
    expect(existsSync(projectDataRoot)).toBe(false);

    const r = await runRestore({ backup: backupFile, dataFile, projectDataRoot, io: silent });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectDataRoot).toBe(projectDataRoot);

    expect(readFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'utf8')).toBe('{"resources":[]}');
    expect(readFileSync(join(projectDataRoot, 'acme', 'v1', 'blocks', 'index.json'), 'utf8')).toBe('{}');
  });

  it('restore REPLACES the project-data root wholesale — a file added after the backup does not survive', async () => {
    await seedStore();
    mkdirSync(join(projectDataRoot, 'acme', 'v1'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'v1-content');
    await runBackup({ dataFile, out: backupFile, projectDataRoot, io: silent });

    // A v2 upload lands AFTER the backup was taken.
    mkdirSync(join(projectDataRoot, 'acme', 'v2'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v2', 'inventory.json'), 'v2-content');

    const r = await runRestore({ backup: backupFile, dataFile, projectDataRoot, io: silent });
    expect(r.ok).toBe(true);
    // v1 (in the backup) survives, byte-identical …
    expect(readFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'utf8')).toBe('v1-content');
    // … but v2 (not in the backup) is gone — a merge would have kept it, a replace does not.
    expect(existsSync(join(projectDataRoot, 'acme', 'v2'))).toBe(false);
  });

  it('a backup taken before any project-data root existed has no companion dir; restore leaves the CURRENT root untouched and warns loudly', async () => {
    await seedStore();
    // projectDataRoot does not exist yet at backup time (fresh install, no uploads).
    const b = await runBackup({ dataFile, out: backupFile, projectDataRoot, io: silent });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.projectDataOut).toBeNull();

    // Something exists in the CURRENT root by the time restore runs.
    mkdirSync(join(projectDataRoot, 'acme', 'v1'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'still-here');

    const errors: string[] = [];
    const capturing = { log: () => {}, error: (s: string) => errors.push(s) };
    const r = await runRestore({ backup: backupFile, dataFile, projectDataRoot, io: capturing });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectDataRoot).toBeNull();
    expect(readFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'utf8')).toBe('still-here'); // untouched
    expect(errors.some((e) => /WARNING.*no companion project-data backup/i.test(e))).toBe(true);
  });

  it('--skip-project-data on backup omits the companion dir even when the root exists', async () => {
    await seedStore();
    mkdirSync(join(projectDataRoot, 'acme', 'v1'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'x');

    const b = await runBackup({ dataFile, out: backupFile, projectDataRoot, skipProjectData: true, io: silent });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.projectDataOut).toBeNull();
  });

  it('--skip-project-data on restore leaves the current root untouched even when a companion backup exists', async () => {
    await seedStore();
    mkdirSync(join(projectDataRoot, 'acme', 'v1'), { recursive: true });
    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'original');
    await runBackup({ dataFile, out: backupFile, projectDataRoot, io: silent });

    writeFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'modified-after-backup');

    const r = await runRestore({ backup: backupFile, dataFile, projectDataRoot, skipProjectData: true, io: silent });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectDataRoot).toBeNull();
    expect(readFileSync(join(projectDataRoot, 'acme', 'v1', 'inventory.json'), 'utf8')).toBe('modified-after-backup');
  });

  it('a project-data root with NO projects (empty dir) round-trips as an empty companion dir, not "does not exist"', async () => {
    await seedStore();
    mkdirSync(projectDataRoot, { recursive: true }); // exists, but empty — no projects onboarded

    const b = await runBackup({ dataFile, out: backupFile, projectDataRoot, io: silent });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.projectDataOut).not.toBeNull(); // the root existed, so it WAS copied
  });
});
