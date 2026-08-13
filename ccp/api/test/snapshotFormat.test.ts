import { describe, expect, it } from 'vitest';
import { SNAPSHOT_FORMAT_VERSION, parseSnapshotItems, serializeSnapshot } from '../src/store/snapshot';
import type { Item } from '../src/store/configStore';

/**
 * DATA-16 — the snapshot file carries no marker saying which invariants it was
 * written under. An older binary reading a newer file has no way to know it should
 * refuse, and because every write rewrites the WHOLE store, it silently downgrades
 * the file to its own older format on the very next persist. `SNAPSHOT_FORMAT_VERSION`
 * fixes the one direction that cannot be recovered from: reading forward.
 *
 * CONC-8's chunked writer (`serializeSnapshot`) emits the SAME envelope this parses —
 * tested together because the two are one contract, not two independent pieces.
 */
describe('parseSnapshotItems — the legacy bare array, forever', () => {
  it('reads a bare JSON array with no marker at all (every file written before DATA-16)', () => {
    const items: Item[] = [{ PK: 'A', SK: 'B' }];
    expect(parseSnapshotItems(JSON.stringify(items))).toEqual(items);
  });

  it('an empty legacy array is a valid (empty) store', () => {
    expect(parseSnapshotItems('[]')).toEqual([]);
  });
});

describe('parseSnapshotItems — the enveloped format', () => {
  it('reads {formatVersion, items} at the current version', () => {
    const items: Item[] = [{ PK: 'A', SK: 'B' }, { PK: 'C', SK: 'D' }];
    const raw = JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION, items });
    expect(parseSnapshotItems(raw)).toEqual(items);
  });

  it('refuses a formatVersion NEWER than this binary understands — the direction that cannot self-heal', () => {
    const raw = JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION + 1, items: [] });
    expect(() => parseSnapshotItems(raw, 'the data file')).toThrow(
      new RegExp(`the data file was written in format version ${SNAPSHOT_FORMAT_VERSION + 1}.*reads at most ${SNAPSHOT_FORMAT_VERSION}`),
    );
  });

  it('refuses formatVersion 0 and negative/non-integer values — not a legacy array, not a valid marker either', () => {
    for (const bad of [0, -1, 1.5, 'v1']) {
      const raw = JSON.stringify({ formatVersion: bad, items: [] });
      expect(() => parseSnapshotItems(raw), JSON.stringify(bad)).toThrow(/formatVersion/);
    }
  });

  it('refuses an envelope-shaped object with items missing or not an array', () => {
    expect(() => parseSnapshotItems(JSON.stringify({ formatVersion: 1 }))).toThrow(/items.*missing/);
    expect(() => parseSnapshotItems(JSON.stringify({ formatVersion: 1, items: 'nope' }))).toThrow(/items.*not an array/);
  });

  it('refuses a payload that is neither an array nor an object (a bare string/number/null)', () => {
    expect(() => parseSnapshotItems('null')).toThrow(/not a store snapshot/);
    expect(() => parseSnapshotItems('42')).toThrow(/not a store snapshot/);
    expect(() => parseSnapshotItems('"oops"')).toThrow(/not a store snapshot/);
  });

  it('names the source file in every error — an operator debugging a boot failure needs to know WHICH file', () => {
    const raw = JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION + 1, items: [] });
    expect(() => parseSnapshotItems(raw, 'ccp data file /var/lib/ccp/ccp.json')).toThrow(/\/var\/lib\/ccp\/ccp\.json/);
  });

  it('empty/whitespace input is refused closed, the same as before DATA-16', () => {
    expect(() => parseSnapshotItems('')).toThrow(/empty\/whitespace/);
    expect(() => parseSnapshotItems('   \n\t')).toThrow(/empty\/whitespace/);
  });
});

describe('serializeSnapshot — the chunked writer round-trips through parseSnapshotItems', () => {
  function collect(items: readonly Item[], itemsPerChunk?: number): string {
    return [...serializeSnapshot(items, itemsPerChunk)].join('');
  }

  it('an empty store serializes to a valid, parseable envelope', () => {
    const raw = collect([]);
    expect(parseSnapshotItems(raw)).toEqual([]);
  });

  it('round-trips items byte-identically to JSON.stringify(items), just enveloped', () => {
    const items: Item[] = [
      { PK: 'ACCOUNT#sari', SK: 'META', id: 'sari', nested: { a: [1, 2, 3], b: null } },
      { PK: 'ACCOUNT#budi', SK: 'META', id: 'budi' },
    ];
    const raw = collect(items);
    expect(parseSnapshotItems(raw)).toEqual(items);
    expect(JSON.parse(raw)).toEqual({ formatVersion: SNAPSHOT_FORMAT_VERSION, items });
  });

  it('the chunk boundary never lands mid-item — every chunk size still round-trips the same items', () => {
    const items: Item[] = Array.from({ length: 37 }, (_, i) => ({ PK: `X#${i}`, SK: 'META', i }));
    for (const perChunk of [1, 2, 5, 37, 1000]) {
      expect(parseSnapshotItems(collect(items, perChunk)), `itemsPerChunk=${perChunk}`).toEqual(items);
    }
  });

  it('produces MULTIPLE chunks for a store larger than one chunk — this is the yielding behavior CONC-8 exists for', () => {
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({ PK: `X#${i}`, SK: 'META' }));
    const chunks = [...serializeSnapshot(items, 3)];
    // header + ceil(10/3)=4 item-chunks + footer = 6, never one giant string.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(collect(items, 1000)); // same bytes regardless of chunking
  });

  it('special characters in a value survive the chunk boundary (a chunk split is between items, never inside one)', () => {
    const items: Item[] = [
      { PK: 'A', SK: 'META', text: 'line1\nline2\t"quoted"\\backslash' },
      { PK: 'B', SK: 'META', text: '{"looks":"like json but is a string value"}' },
    ];
    expect(parseSnapshotItems(collect(items, 1))).toEqual(items);
  });
});
