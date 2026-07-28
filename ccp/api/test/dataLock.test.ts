import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DataLock, DataLockError, lockPathFor } from '../src/store/dataLock';
import { FileStore } from '../src/store/fileStore';
import { runRestore } from '../scripts/restore';
import { writeFileAtomic } from '../src/store/snapshot';

/**
 * CONC-7 / DATA-9 — one writer per data file.
 *
 * `FileStore` rewrites the ENTIRE file from its own private in-memory map on every
 * mutation, and nothing stopped a second process opening the same file. Two of them never
 * see each other's writes and alternately overwrite the whole store — accounts, sessions,
 * requests, both audit chains — silently, behind green health checks. Every in-process
 * guarantee (the chain-head CAS, the `ifEquals` claims) is void across processes, because
 * each condition is evaluated against a map that no longer describes the file.
 *
 * `scripts/restore.ts` was a second writer BY DESIGN: it installs a backup atomically,
 * and the running server's next persist rewrites the file from memory and discards it.
 */

let dir: string;
let dataFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccp-lock-'));
  dataFile = join(dir, 'nested', 'ccp.json'); // nested → also proves the lock mkdir -p's
});

/** Plant a lock file for a holder this process did not create. */
function plantLock(body: string): void {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(lockPathFor(dataFile), body, { flag: 'w' });
}
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const silent = { log: () => {}, error: () => {} };

describe('CONC-7 — the data file has exactly one writer', () => {
  it('THE DEFECT: a second FileStore on the same path refuses to open', async () => {
    const a = await FileStore.open(dataFile);
    await expect(FileStore.open(dataFile)).rejects.toThrow(DataLockError);
    a.close();
  });

  it('…and the refusal names the holder and what to do about it', async () => {
    const a = await FileStore.open(dataFile);
    await expect(FileStore.open(dataFile)).rejects.toThrow(
      new RegExp(`pid ${process.pid} on ${hostname()}`),
    );
    await expect(FileStore.open(dataFile)).rejects.toThrow(/CCP_DATA_LOCK_TAKEOVER=1/);
    a.close();
  });

  it('a released lock lets the next process in — this is a restart, not a wedge', async () => {
    const a = await FileStore.open(dataFile);
    a.close();
    const b = await FileStore.open(dataFile);
    expect(existsSync(lockPathFor(dataFile))).toBe(true);
    b.close();
    expect(existsSync(lockPathFor(dataFile))).toBe(false);
  });

  it('close() is idempotent, so an exit handler can call it after a clean shutdown', async () => {
    const a = await FileStore.open(dataFile);
    a.close();
    expect(() => a.close()).not.toThrow();
  });

  it('a STALE lock from a dead pid on this host is taken over — a crash must not wedge boot', () => {
    // The ERR-2 shape: a claim that outlives its holder and nothing can release it. Here
    // the holder can be PROVEN gone, so taking over is knowledge, not a guess.
    plantLock(JSON.stringify({ pid: 999_999_998, host: hostname(), since: '2026-07-01T00:00:00.000Z' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = DataLock.acquire(dataFile, {});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/clearing a stale lock/));
    lock.release();
  });

  it('a lock from ANOTHER HOST is refused — an unverifiable pid is not a dead one', () => {
    // A shared volume mounted into a second machine is the scenario. This process cannot
    // check a pid it cannot see, and guessing here is exactly the failure being fixed.
    plantLock(JSON.stringify({ pid: 1, host: 'some-other-host', since: '2026-07-01T00:00:00.000Z' }));
    expect(() => DataLock.acquire(dataFile, {})).toThrow(/some-other-host/);
  });

  it('…unless the operator says so explicitly, and then it says what it just did', () => {
    plantLock(JSON.stringify({ pid: 1, host: 'some-other-host', since: '2026-07-01T00:00:00.000Z' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = DataLock.acquire(dataFile, { CCP_DATA_LOCK_TAKEOVER: '1' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/taking over the lock/));
    lock.release();
  });

  it('an UNPARSEABLE lock is refused too — a holder we cannot read is one we cannot rule out', () => {
    plantLock('not json at all');
    expect(() => DataLock.acquire(dataFile, {})).toThrow(/cannot parse/);
  });

  it('release() does NOT delete a lock another process has taken over', () => {
    // Otherwise a takeover plus a late release would hand a third process a lock the real
    // writer believes it holds — the same defect, arrived at politely.
    const lock = DataLock.acquire(dataFile, {});
    plantLock(JSON.stringify({ pid: 424_242, host: 'another-host', since: '2026-07-02T00:00:00.000Z' }));
    lock.release();
    expect(existsSync(lockPathFor(dataFile))).toBe(true);
    const still = JSON.parse(readFileSync(lockPathFor(dataFile), 'utf8')) as { pid: number };
    expect(still.pid).toBe(424_242);
  });

  it('a store that fails to LOAD leaves no lock behind', async () => {
    // An operator fixing a corrupt snapshot must not have to clear a lock first — the
    // failed boot never became the writer.
    await writeFileAtomic(dataFile, '   ');
    await expect(FileStore.open(dataFile)).rejects.toThrow(/empty\/whitespace/);
    expect(existsSync(lockPathFor(dataFile))).toBe(false);
  });

  it('{ lock: false } still opens unlocked — read-only tooling is not a writer', async () => {
    const a = await FileStore.open(dataFile);
    const reader = await FileStore.open(dataFile, { lock: false });
    expect(reader).toBeInstanceOf(FileStore);
    a.close();
  });
});

describe('DATA-9 — a restore cannot land under a running server', () => {
  /** A valid one-item backup with no audit chain (so it verifies trivially). */
  async function backupWithOneItem(): Promise<string> {
    const backup = join(dir, 'backup.json');
    await writeFileAtomic(backup, JSON.stringify([{ PK: 'ACCOUNT#sari', SK: 'META', id: 'sari' }]));
    return backup;
  }

  it('THE DEFECT: restore refuses while the server holds the writer lock', async () => {
    const server = await FileStore.open(dataFile);
    const res = await runRestore({ backup: await backupWithOneItem(), dataFile, force: false, io: silent });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/silently undone by its next write/);
    server.close();
  });

  it('…and the data file is untouched, not half-restored', async () => {
    const server = await FileStore.open(dataFile);
    await server.put({ PK: 'ACCOUNT#budi', SK: 'META', id: 'budi' });
    await runRestore({ backup: await backupWithOneItem(), dataFile, force: false, io: silent });
    server.close();
    const after = await FileStore.open(dataFile);
    expect(await after.get('ACCOUNT#budi', 'META')).not.toBeNull();
    expect(await after.get('ACCOUNT#sari', 'META')).toBeNull();
    after.close();
  });

  it('CONTROL: with the server stopped the restore lands, and releases the lock after', async () => {
    // Without this the test above would pass against a restore that never works at all.
    const res = await runRestore({ backup: await backupWithOneItem(), dataFile, force: false, io: silent });
    expect(res.ok).toBe(true);
    expect(existsSync(lockPathFor(dataFile)), 'restore must not keep the lock').toBe(false);
    const store = await FileStore.open(dataFile);
    expect(await store.get('ACCOUNT#sari', 'META')).not.toBeNull();
    store.close();
  });
});
