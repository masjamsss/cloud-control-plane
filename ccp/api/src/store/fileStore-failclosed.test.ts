import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './fileStore';

// 0014 B2 adversarial finding: only a truly ABSENT file is a fresh store. An
// existing-but-empty/whitespace file is a corrupt/half-restored snapshot and
// MUST fail closed — never boot a silently-empty governance DB.
describe('FileStore.load fail-closed (0014 B2)', () => {
  const dirs: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'gb-fc-'));
    dirs.push(d);
    return join(d, 'ccp.json');
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('absent file is a fresh store (no throw)', async () => {
    await expect(FileStore.open(mk())).resolves.toBeInstanceOf(FileStore);
  });

  it('existing EMPTY file throws — does not boot a silently-empty store', async () => {
    const f = mk();
    writeFileSync(f, '');
    await expect(FileStore.open(f)).rejects.toThrow(/empty\/whitespace/);
  });

  it('existing WHITESPACE file throws', async () => {
    const f = mk();
    writeFileSync(f, '  \n\t ');
    await expect(FileStore.open(f)).rejects.toThrow(/empty\/whitespace/);
  });

  it('valid empty-array file loads (why the server-side bootstrap file-presence guard also exists)', async () => {
    const f = mk();
    writeFileSync(f, '[]');
    await expect(FileStore.open(f)).resolves.toBeInstanceOf(FileStore);
  });

  it('corrupt JSON still fails closed (baseline unchanged)', async () => {
    const f = mk();
    writeFileSync(f, '{not json');
    await expect(FileStore.open(f)).rejects.toThrow();
  });
});
