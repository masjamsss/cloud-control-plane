import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
