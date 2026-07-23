import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { ConditionError, type TransactWrite } from '../src/store/configStore';
import { ApiError } from '../src/errors';
import { auditEntryHash, canonicalJson, record, type AuditEntryInput } from '../src/domain/audit';
import { verifyChain, type ChainEntry } from '../scripts/verify-audit-chain';
import { generateGoldenItems } from './fixtures/gen-golden';
import type { AuditItem } from '../src/store/schema';

const golden = JSON.parse(readFileSync(new URL('./fixtures/audit-chain-golden.json', import.meta.url), 'utf8')) as AuditItem[];

async function recordN(store: MemoryStore, entries: AuditEntryInput[]): Promise<AuditItem[]> {
  for (let i = 0; i < entries.length; i++) {
    await record(store, 'sample', entries[i]!, { idFn: () => `e${i}`, nowFn: () => `2026-07-11T10:00:0${i}.000Z` });
  }
  return (await store.query('P#sample#AUDIT#202607')) as AuditItem[];
}

describe('§7 hash-chained audit', () => {
  it('(a) canonicalJson is recursive key-sorted, no-whitespace; arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  it('(b) three record() calls chain: each prevHash === the previous hash and recomputes', async () => {
    const store = new MemoryStore();
    const items = await recordN(store, [
      { action: 'a1', actor: 'x', targetType: 'session', targetId: 'x' },
      { action: 'a2', actor: 'y', targetType: 'request', targetId: 'r', after: { n: 1 } },
      { action: 'a3', actor: 'z', targetType: 'policy', targetId: 'POLICY', before: { high: 2 }, after: { high: 1 } },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]!.prevHash).toBe('');
    expect(items[1]!.prevHash).toBe(items[0]!.hash);
    expect(items[2]!.prevHash).toBe(items[1]!.hash);
    for (let i = 0; i < items.length; i++) {
      expect(items[i]!.hash).toBe(auditEntryHash(i === 0 ? '' : items[i - 1]!.hash, items[i]!));
    }
  });

  it('(c) the golden fixture reproduces byte-for-byte', async () => {
    const regenerated = await generateGoldenItems();
    expect(regenerated).toEqual(golden);
  });

  it('(d) verify CLI: intact → 0; one tampered field → 1 naming the ulid; wrong --head → 2', () => {
    const entries = golden as unknown as ChainEntry[];
    expect(verifyChain(entries).code).toBe(0);

    const tampered = structuredClone(entries);
    tampered[2]!.actor = 'attacker';
    const broken = verifyChain(tampered);
    expect(broken.code).toBe(1);
    expect(broken.badUlid).toBe('u2');

    expect(verifyChain(entries, { head: entries[entries.length - 1]!.hash }).code).toBe(0);
    expect(verifyChain(entries, { head: 'not-the-head' }).code).toBe(2);
  });

  it('(e) chain contention retries once then succeeds; persistent contention → 409 CHAIN_CONTENTION', async () => {
    // A store whose transact fails a fixed number of times, simulating a lost race.
    class FlakyStore extends MemoryStore {
      constructor(private failsLeft: number) {
        super();
      }
      override async transact(writes: TransactWrite[]): Promise<void> {
        if (this.failsLeft > 0) {
          this.failsLeft--;
          throw new ConditionError('simulated race');
        }
        return super.transact(writes);
      }
    }

    const entry: AuditEntryInput = { action: 'x', actor: 'a', targetType: 'session', targetId: 'a' };

    const onceFlaky = new FlakyStore(1); // first attempt races, retry succeeds
    await expect(record(onceFlaky, 'sample', entry)).resolves.toBeTruthy();
    expect(await onceFlaky.query('P#sample#AUDIT#202607')).toHaveLength(1);

    const alwaysFlaky = new FlakyStore(2); // both attempts race → CHAIN_CONTENTION
    await expect(record(alwaysFlaky, 'sample', entry)).rejects.toBeInstanceOf(ApiError);
    await expect(record(new FlakyStore(2), 'sample', entry)).rejects.toMatchObject({ code: 'CHAIN_CONTENTION' });
  });
});
