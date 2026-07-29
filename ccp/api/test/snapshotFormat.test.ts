import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store/fileStore';
import { parseSnapshotItems, SNAPSHOT_FORMAT_VERSION } from '../src/store/snapshot';
import type { Item } from '../src/store/configStore';

/**
 * DATA-16 — no format/version marker in the snapshot file.
 * DATA-5 — store rows are not validated on load: corrupt-but-parseable state loads silently.
 *
 * Both land in the same place, so they are fixed in the same place: one parser used by
 * every reader of a snapshot (`FileStore.load`, `scripts/backup`, `scripts/restore`).
 *
 * `FileStore.load` did `JSON.parse(raw) as Item[]`. A non-array top level failed only by an
 * incidental `items.map is not a function` further down; any parseable corruption — a
 * hand-edit, a bad restore, a partial write by another tool, a row with no `PK` — loaded
 * clean and flowed through unchecked casts into auth and domain logic. `snapshot.ts` had
 * the proper array check all along and this loader simply did not use it.
 *
 * The PK/SK check is the structural minimum and it is not cosmetic: an item without them
 * keys as `"undefined<NUL>undefined"`, so EVERY such row collapses onto one entry and
 * silently overwrites the others. A file could lose most of itself and still boot.
 *
 * On scope, deliberately: this is NOT a full per-row zod pass. Validating every row against
 * its schema is what the finding calls optional, and R-41 is the standing warning — a shim
 * guessed at rather than designed against real stored shapes fails a BOOT, not a test. The
 * PK/SK check cannot false-positive on any legacy shape, because a row without them was
 * never loadable in any meaningful sense.
 *
 * On the version marker, also deliberately: this release READS both shapes and WRITES the
 * legacy bare array. Writing the envelope is the second half of an expand/contract
 * migration — flip it and a rollback to the previous binary meets a file it cannot parse.
 * See R-49.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempFile(contents?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'snapfmt-'));
  dirs.push(d);
  const f = join(d, 'store.json');
  if (contents !== undefined) writeFileSync(f, contents);
  return f;
}

const ROW: Item = { PK: 'P#sample#REQ#r1', SK: 'META', id: 'r1', status: 'APPLIED' };

const loadFrom = async (contents: string): Promise<FileStore> => {
  const store = new FileStore(tempFile(contents));
  await store.load();
  return store;
};

describe('DATA-16 — the snapshot carries a format version, and an unknown one is refused', () => {
  it('reads the versioned envelope', async () => {
    const store = await loadFrom(JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION, items: [ROW] }));
    expect(await store.get(ROW.PK, ROW.SK)).toMatchObject({ id: 'r1' });
  });

  it('still reads the LEGACY bare array — every snapshot written to date', async () => {
    // The compatibility half. Breaking this would brick every existing deployment on
    // upgrade, which is a far worse outcome than the defect being fixed.
    const store = await loadFrom(JSON.stringify([ROW]));
    expect(await store.get(ROW.PK, ROW.SK)).toMatchObject({ id: 'r1' });
  });

  it('THE POINT: refuses a formatVersion newer than this build understands', async () => {
    // Previously an older binary read a newer file blind and REWROTE it — losing whatever
    // invariant the newer format carried. Refusing is the whole reason for the marker.
    const raw = JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION + 1, items: [ROW] });
    await expect(loadFrom(raw)).rejects.toThrow(/newer than this build understands/);
  });

  it('refuses a nonsense formatVersion rather than guessing', async () => {
    for (const v of ['1', 1.5, 0, -1, null]) {
      const raw = JSON.stringify({ formatVersion: v, items: [ROW] });
      await expect(loadFrom(raw), `formatVersion ${JSON.stringify(v)}`).rejects.toThrow(/unreadable formatVersion|not a JSON array/);
    }
  });

  it('refuses an envelope with no items array', async () => {
    await expect(loadFrom(JSON.stringify({ formatVersion: 1 }))).rejects.toThrow(/no `items` array/);
    await expect(loadFrom(JSON.stringify({ formatVersion: 1, items: {} }))).rejects.toThrow(/no `items` array/);
  });

  it('this build still WRITES the legacy shape — the rollback path stays open (R-49)', async () => {
    // If this ever changes, it must change deliberately and with a migration note, not as
    // a side effect. Pinning the written shape is how that stays true.
    const file = tempFile();
    const store = new FileStore(file);
    await store.put(ROW);

    const written: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(Array.isArray(written), 'still a bare array, readable by the previous binary').toBe(true);
  });
});

describe('DATA-5 — corrupt-but-parseable snapshots are refused, loudly and by row', () => {
  it('THE DEFECT: a row with no PK/SK used to load and collapse onto one entry', async () => {
    // Every such row keys as "undefined/undefined", so a file could lose most of itself
    // and still boot clean. This is the corruption class the finding is really about.
    const raw = JSON.stringify([ROW, { id: 'orphan-a', status: 'APPLIED' }, { id: 'orphan-b' }]);
    await expect(loadFrom(raw)).rejects.toThrow(/row 1 has no string PK\/SK/);
  });

  it('names the row INDEX and something findable in it', async () => {
    // An operator staring at a refused boot needs to know which line of a 50 MB file to
    // open. "Invalid snapshot" would be true and useless.
    const raw = JSON.stringify([ROW, { SK: 'META', id: 'x' }]);
    await expect(loadFrom(raw)).rejects.toThrow(/row 1 .*SK "META"/);

    const raw2 = JSON.stringify([ROW, { id: 'x', status: 'APPLIED' }]);
    await expect(loadFrom(raw2)).rejects.toThrow(/row 1 .*keys \[id, status\]/);
  });

  it('refuses a non-object row instead of failing incidentally later', async () => {
    for (const junk of [null, 42, 'a string', ['nested']]) {
      await expect(loadFrom(JSON.stringify([ROW, junk])), JSON.stringify(junk)).rejects.toThrow(/row 1 is not an object/);
    }
  });

  it('refuses a non-array top level with a real message', async () => {
    // It used to reach `items.map is not a function` — a TypeError from deep inside the
    // store, not a refusal naming the problem.
    await expect(loadFrom(JSON.stringify({ hello: 'world' }))).rejects.toThrow(/not a JSON array of items/);
    await expect(loadFrom('"just a string"')).rejects.toThrow(/not a JSON array of items/);
  });

  it('the pre-existing refusals still hold — empty file, syntax error', async () => {
    await expect(loadFrom('   \n  ')).rejects.toThrow(/empty\/whitespace/);
    await expect(loadFrom('{not json')).rejects.toThrow();
  });

  it('THE CONTROL: a perfectly ordinary snapshot still loads — all of it', async () => {
    // Without this the refusals above prove only that something throws. A tightening that
    // rejected valid stores would be a far worse defect than the one being fixed.
    const rows: Item[] = Array.from({ length: 200 }, (_, i) => ({
      PK: `P#sample#REQ#r-${i}`,
      SK: 'META',
      id: `r-${i}`,
      status: 'APPLIED',
      GSI1PK: 'REQS#sample',
      GSI1SK: `r-${i}`,
      // Unknown/future fields must survive: the whole additive-optional migration story
      // depends on load -> export preserving what this binary does not understand.
      someFutureField: { nested: true },
    }));
    const store = await loadFrom(JSON.stringify(rows));

    expect(await store.queryGSI1('REQS#sample')).toHaveLength(200);
    expect((await store.get('P#sample#REQ#r-7', 'META'))!.someFutureField).toEqual({ nested: true });
  });

  it('parseSnapshotItems is the ONE parser — backup and restore get this for free', () => {
    // The finding notes `restore.ts` verifies the audit chain but not item shapes. Both
    // scripts already call this function, so the check lands there without touching them.
    expect(() => parseSnapshotItems(JSON.stringify([{ id: 'no-keys' }]))).toThrow(/row 0 has no string PK\/SK/);
    expect(parseSnapshotItems(JSON.stringify([ROW]))).toHaveLength(1);
    expect(parseSnapshotItems(JSON.stringify({ formatVersion: 1, items: [ROW] }))).toHaveLength(1);
  });
});
