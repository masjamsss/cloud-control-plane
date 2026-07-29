import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store/fileStore';
import { DurabilityError } from '../src/store/configStore';
import { readiness } from '../src/domain/readiness';
import { MemoryStore } from '../src/store/memoryStore';
import type { Item } from '../src/store/configStore';
import { accountKey, accountsGsi } from '../src/store/schema';

/**
 * DATA-3 / ERR-10 — a failed disk persist left memory ahead of disk.
 *
 * `put`/`delete`/`transact` apply to the Map synchronously and THEN await the snapshot.
 * When the snapshot failed, the caller got a 500 — and the Map kept the mutation. Because
 * every snapshot serializes the WHOLE Map, that "failed" write then became durable as a
 * side effect of the next successful persist by any unrelated request; or, if the process
 * died first, it vanished, having already been read and acted on. A response code stopped
 * saying anything about durability.
 *
 * The test that matters most is the LAST one in the first block: a failed write followed
 * by a successful one, showing the failed write's data landing on disk anyway. That is the
 * defect stated as an observable fact rather than as a description.
 */

const dirs: string[] = [];

function mkFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccp-dur-'));
  dirs.push(d);
  return join(d, 'ccp.json');
}

/**
 * A FileStore whose snapshot write can be made to fail on demand.
 *
 * Filesystem permissions are NOT usable for this: the suite runs as uid 0 in CI and in
 * the dev container, and root bypasses the mode bits entirely — a `chmod 0o500` store
 * directory keeps accepting writes, so the "failure" never happens and every assertion
 * about it passes vacuously. That is CI-2's shape (a check that cannot run reporting as
 * though it did), so the injection is explicit instead.
 *
 * `writeAtomic` is `private` only to TypeScript; overriding it here replaces exactly the
 * one step that touches the disk and leaves the fault state machine — which is what
 * DATA-3 is actually about — entirely real. The temp-file behaviour ERR-10 covers is
 * tested separately against a REAL filesystem failure further down.
 */
interface Breakable extends FileStore {
  diskBroken: boolean;
}

/** `writeAtomic` is called as `this.writeAtomic(...)`, so an own property shadows the
 * prototype method — no subclass, and no widening of FileStore's visibility for a test. */
async function openBreakable(file: string): Promise<Breakable> {
  const store = (await FileStore.open(file)) as Breakable;
  const inner = store as unknown as { writeAtomic(json: string): Promise<void> };
  const real = inner.writeAtomic.bind(store);
  store.diskBroken = false;
  inner.writeAtomic = async (json: string): Promise<void> => {
    if (store.diskBroken) throw new Error('ENOSPC: no space left on device');
    await real(json);
  };
  return store;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const row = (sk: string): Item => ({ PK: 'T', SK: sk, value: sk });

describe('a store that cannot persist stops claiming to be authoritative', () => {
  it('reports no fault while writes are landing', async () => {
    const store = await openBreakable(mkFile());
    await store.put(row('a'));
    expect(store.durabilityFault()).toBeNull();
  });

  it('surfaces the write failure to ITS OWN caller — the fault must not swallow the error', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await expect(store.put(row('b'))).rejects.toThrow();
  });

  it('records a fault naming the file and the divergence, once the snapshot fails', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    const fault = store.durabilityFault();
    expect(fault).not.toBeNull();
    expect(fault).toContain(file);
    expect(fault).toMatch(/no longer authoritative/);
  });

  it('THE DEFECT: a failed write must not become durable later — refusing further writes is what stops it', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));

    store.diskBroken = true;
    await store.put(row('FAILED')).catch(() => undefined); // 500 to its caller, but in the Map
    store.diskBroken = false;

    // Before the fix, ANY later successful write re-serialized the whole Map and carried
    // 'FAILED' to disk with it. Now the store refuses, so nothing re-snapshots it.
    await expect(store.put(row('c'))).rejects.toThrow(DurabilityError);

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Array<{ SK: string }>;
    expect(onDisk.map((i) => i.SK)).toEqual(['a']);
  });

  it('refuses every mutating verb, not just put', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    store.diskBroken = false;

    await expect(store.put(row('c'))).rejects.toThrow(DurabilityError);
    await expect(store.delete('T', 'a')).rejects.toThrow(DurabilityError);
    await expect(store.transact([{ kind: 'put', item: row('d') }])).rejects.toThrow(DurabilityError);
  });

  it('still answers READS — memory holds what was already served, and an operator needs to see it', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    store.diskBroken = false;

    expect(await store.get('T', 'a')).toMatchObject({ SK: 'a' });
    expect((await store.query('T')).map((i) => i.SK)).toEqual(['a', 'b']);
  });

  it('never heals: a writable disk does not clear a fault, because the divergence is already made', async () => {
    // A later successful write would prove nothing about how far memory and disk had
    // already diverged. Self-healing here would be a guess — the same guess `load()`
    // refuses to make about a corrupt snapshot.
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    store.diskBroken = false;

    expect(store.durabilityFault()).not.toBeNull();
  });

  it('keeps the FIRST failure as the reason — later ones are its consequences', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    const first = store.durabilityFault();
    await store.put(row('c')).catch(() => undefined);
    expect(store.durabilityFault()).toBe(first);
  });
});

describe('ERR-10 — the atomic write leaves nothing behind when it fails', () => {
  it('does not leak a temp file when the RENAME fails — a real filesystem failure, not an injected one', async () => {
    // Deliberately NOT the injected failure used above: that one never reaches the disk,
    // so asserting "no temp file" against it would pass without exercising a single line
    // of the cleanup. This puts a DIRECTORY where the data file belongs, so the temp file
    // is genuinely created and written and the `rename` onto it fails with EISDIR — which
    // root cannot bypass either.
    //
    // It is also the case a narrower catch misses. Cleanup wrapped only around
    // writeFile/sync leaves this leak, and this test is what found that in the first fix.
    const d = mkdtempSync(join(tmpdir(), 'ccp-dur-'));
    dirs.push(d);
    const file = join(d, 'ccp.json');
    mkdirSync(file); // a directory sitting exactly where the snapshot must land

    const store = new FileStore(file);
    await expect(store.put(row('a'))).rejects.toThrow();

    const leaked = readdirSync(d).filter((n) => n.includes('.tmp-'));
    expect(leaked, `leaked temp files: ${leaked.join(', ')}`).toEqual([]);
  });

  it('a successful write leaves no temp file either', async () => {
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put(row('a'));
    await store.put(row('b'));
    expect(readdirSync(join(file, '..')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('readiness reports a durability fault', () => {
  it('a faulted store is NOT ready, and says why', async () => {
    // The point of routing this through readiness: an instance serving reads from a Map
    // that disk will not resurrect looks perfectly healthy to a liveness probe. Readiness
    // is where "answers correctly" and "is authoritative" are allowed to differ.
    const file = mkFile();
    const store = await openBreakable(file);
    await store.put({ ...accountKey('admin'), GSI1PK: accountsGsi(), GSI1SK: 'admin', username: 'admin' });
    store.diskBroken = true;
    await store.put(row('b')).catch(() => undefined);
    store.diskBroken = false;

    const r = await readiness(store);
    expect(r.ready).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no longer authoritative/);
  });

  it('an in-memory store implements no durability seam and is unaffected', async () => {
    // `durabilityFault` is optional precisely so a store with no disk to diverge from
    // implements nothing. If readiness ever required it, MemoryStore would go un-ready.
    const store = new MemoryStore();
    expect((store as { durabilityFault?: unknown }).durabilityFault).toBeUndefined();
    const r = await readiness(store);
    expect(r.reasons.join(' ')).not.toMatch(/authoritative/);
  });
});
