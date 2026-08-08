import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/store/snapshot';

/**
 * DATA-6/DATA-13 — `snapshot.writeFileAtomic` (the backup/restore scripts' standalone
 * write path — deliberately NOT sharing code with FileStore.writeAtomic, see its own
 * doc comment) had neither of FileStore.writeAtomic's ERR-10 hardening steps: no
 * cleanup of the temp file on a failed write (DATA-13), and no directory fsync after a
 * successful rename (DATA-6 — a POSIX rename is a directory operation, so without
 * flushing the directory's own metadata a crash shortly after could resurrect the OLD
 * file on recovery).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccp-snapshot-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic — happy path (unaffected by the DATA-6/DATA-13 hardening)', () => {
  it('writes the file and it reads back byte-identical', async () => {
    const file = join(dir, 'nested', 'snapshot.json');
    await writeFileAtomic(file, '[{"ok":true}]');
    expect(readFileSync(file, 'utf8')).toBe('[{"ok":true}]');
  });

  it('leaves no tmp file behind on success', async () => {
    const file = join(dir, 'snapshot.json');
    await writeFileAtomic(file, '[]');
    const leftover = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(leftover).toEqual([]);
  });
});

describe('DATA-13 — a failed write no longer leaks its temp file', () => {
  it('the tmp file is removed when rename fails (target is a non-empty directory)', async () => {
    // A file cannot be renamed onto an existing NON-EMPTY directory (ENOTEMPTY/EISDIR,
    // platform-independent) — this forces the rename step specifically to fail, with
    // `tmp` already fully written, which is exactly the failure shape DATA-13 describes
    // (the tmp file survives writeFile/sync/close and only the final step throws).
    const target = join(dir, 'snapshot.json');
    mkdirSync(target);
    writeFileSync(join(target, 'occupied.txt'), 'not empty');

    await expect(writeFileAtomic(target, '[{"data":1}]')).rejects.toThrow();

    const leftover = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(leftover, `stale temp file(s) leaked: ${leftover.join(', ')}`).toEqual([]);
  });
});
