import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/store/snapshot';

/**
 * DATA-6 / DATA-13 — snapshot.ts's standalone writeFileAtomic (used by
 * scripts/backup.ts and scripts/restore.ts) had drifted from the discipline
 * FileStore.writeAtomic was given under ERR-10: no directory fsync after the rename
 * (DATA-6 — the rename is atomic against a process kill, but the directory entry itself
 * is not durable against power loss until the directory's own metadata is flushed), and
 * no temp-file cleanup when the rename itself fails rather than the write (DATA-13 — a
 * narrower catch around just writeFile/sync misses exactly this case).
 *
 * Same shape as storeDurabilityFault.test.ts's "ERR-10" block, applied to the
 * standalone copy backup/restore actually call.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('snapshot writeFileAtomic — DATA-6 / DATA-13', () => {
  it('does not leak a temp file when the RENAME fails (a real filesystem failure)', async () => {
    // A directory sitting exactly where the target file belongs makes the temp file
    // genuinely created and written, and the rename onto it fail with EISDIR — the
    // case a cleanup wrapped only around writeFile/sync misses entirely.
    const d = mkdtempSync(join(tmpdir(), 'ccp-snap-'));
    dirs.push(d);
    const file = join(d, 'backup.json');
    mkdirSync(file);

    await expect(writeFileAtomic(file, '[]')).rejects.toThrow();

    const leaked = readdirSync(d).filter((n) => n.includes('.tmp-'));
    expect(leaked, `leaked temp files: ${leaked.join(', ')}`).toEqual([]);
  });

  it('a successful write leaves no temp file and lands the exact bytes', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ccp-snap-'));
    dirs.push(d);
    const file = join(d, 'backup.json');

    await writeFileAtomic(file, '[{"PK":"A","SK":"B"}]');

    expect(readdirSync(d).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('[{"PK":"A","SK":"B"}]');
  });

  it('creates missing parent directories (mkdir -p) before writing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ccp-snap-'));
    dirs.push(d);
    const file = join(d, 'nested', 'deep', 'backup.json');

    await writeFileAtomic(file, 'x');

    expect(readFileSync(file, 'utf8')).toBe('x');
  });
});
