import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/store/fileStore';
import { ConditionError, type Item } from '../src/store/configStore';
import * as S from '../src/store/schema';
import { record } from '../src/domain/audit';
import { verifyChain, type ChainEntry } from '../scripts/verify-audit-chain';
import { bootstrap } from '../scripts/bootstrap';
import type { AccountItem, AuditItem, ChainHeadItem } from '../src/store/schema';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccp-fs-'));
  file = join(dir, 'nested', 'ccp.json'); // nested → also proves mkdir -p
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Simulate a process restart: a brand-new store instance loading the same file from disk. */
async function restart(): Promise<FileStore> {
  return FileStore.open(file);
}

describe('FileStore durability (simulated restart = new instance reading disk)', () => {
  it('a fresh file path opens empty; a put survives restart', async () => {
    const a = await FileStore.open(file);
    expect(await a.get('ACCOUNT#sari', 'META')).toBeNull();

    const item: Item = { ...S.accountKey('sari'), id: 'sari', GSI1PK: S.accountsGsi(), GSI1SK: 'sari' };
    await a.put(item);

    const b = await restart();
    expect(await b.get('ACCOUNT#sari', 'META')).toEqual(item);
  });

  it('query and queryGSI1 ordering survive a restart', async () => {
    const a = await FileStore.open(file);
    const pk = S.requestKey('sample', 'X').PK;
    await a.put({ PK: pk, SK: 'EVT#000002', n: 2 });
    await a.put({ PK: pk, SK: 'EVT#000001', n: 1 });
    const gsi = S.requestCollectionGsi('sample');
    await a.put({ ...S.requestKey('sample', 'b'), GSI1PK: gsi, GSI1SK: 'b' });
    await a.put({ ...S.requestKey('sample', 'a'), GSI1PK: gsi, GSI1SK: 'a' });

    const b = await restart();
    expect((await b.query(pk, 'EVT#')).map((e) => e.SK)).toEqual(['EVT#000001', 'EVT#000002']);
    expect((await b.queryGSI1(gsi)).map((i) => i.GSI1SK)).toEqual(['a', 'b']);
  });

  it('a failed ifNotExists put persists NOTHING (survives across restart)', async () => {
    const a = await FileStore.open(file);
    const k = S.accountKey('budi');
    await a.put({ ...k, id: 'budi' });
    await expect(a.put({ ...k, id: 'IMPOSTER' }, { ifNotExists: true })).rejects.toBeInstanceOf(ConditionError);

    const b = await restart();
    expect((await b.get(k.PK, k.SK))?.id).toBe('budi'); // the imposter never landed
  });

  it('transact is all-or-nothing on disk: a failed batch leaves the prior snapshot intact', async () => {
    const a = await FileStore.open(file);
    const head = S.chainHead('sample');
    await a.put({ ...head, hash: 'GENESIS', lastUlid: '', count: 0 });
    const other = S.requestKey('sample', 'R1');
    await expect(
      a.transact([
        { kind: 'put', item: { ...other, id: 'R1' } },
        { kind: 'update', pk: head.PK, sk: head.SK, set: { hash: 'NEW' }, ifEquals: { attr: 'hash', value: 'WRONG' } },
      ]),
    ).rejects.toBeInstanceOf(ConditionError);

    const b = await restart();
    expect(await b.get(other.PK, other.SK)).toBeNull(); // put rolled back
    expect((await b.get(head.PK, head.SK))?.hash).toBe('GENESIS'); // head untouched
  });

  it('a committed transact batch survives a restart', async () => {
    const a = await FileStore.open(file);
    const head = S.chainHead('sample');
    await a.put({ ...head, hash: 'GENESIS', lastUlid: '', count: 0 });
    const audit = S.auditKey('sample', '202607', '01J0000000000000000000000A');
    await a.transact([
      { kind: 'put', item: { ...audit, hash: 'H1' }, ifNotExists: true },
      { kind: 'update', pk: head.PK, sk: head.SK, set: { hash: 'H1', count: 1 }, ifEquals: { attr: 'hash', value: 'GENESIS' } },
    ]);

    const b = await restart();
    expect((await b.get(audit.PK, audit.SK))?.hash).toBe('H1');
    expect(await b.get(head.PK, head.SK)).toMatchObject({ hash: 'H1', count: 1 });
  });

  it('many concurrent mutations all land (serialized write queue loses nothing)', async () => {
    const a = await FileStore.open(file);
    const N = 40;
    await Promise.all(
      Array.from({ length: N }, (_, i) => a.put({ ...S.requestKey('sample', `r${i}`), GSI1PK: S.requestCollectionGsi('sample'), GSI1SK: `r${String(i).padStart(3, '0')}` })),
    );
    const b = await restart();
    expect(await b.queryGSI1(S.requestCollectionGsi('sample'))).toHaveLength(N);
  });

  it('a hash-chained audit log survives restart and still verifies', async () => {
    const a = await FileStore.open(file);
    for (let i = 0; i < 5; i++) {
      await record(a, 'sample', { action: `a${i}`, actor: 'putra', targetType: 'session', targetId: 'putra' });
    }
    const headBefore = (await a.get(S.chainHead('sample').PK, 'CHAINHEAD')) as ChainHeadItem;

    const b = await restart();
    const entries = (await b.query('P#sample#AUDIT#202607')) as AuditItem[];
    expect(entries).toHaveLength(5);
    const headAfter = (await b.get(S.chainHead('sample').PK, 'CHAINHEAD')) as ChainHeadItem;
    expect(headAfter).toEqual(headBefore); // chain head durable

    const verdict = verifyChain(entries as unknown as ChainEntry[], { head: headAfter.hash });
    expect(verdict.code).toBe(0); // chain intact + head matches after reload
  });
});

describe('bootstrap refuses to re-provision a populated durable store', () => {
  it('a second bootstrap across a restart refuses and leaves accounts + file unchanged', async () => {
    const a = await FileStore.open(file);
    const first = await bootstrap(a, { print: () => {} });
    expect(first.ok).toBe(true);
    const accountsBefore = (await a.queryGSI1(S.accountsGsi())) as AccountItem[];
    expect(accountsBefore).toHaveLength(1);

    // Restart, then attempt to bootstrap again against the durable data.
    const b = await restart();
    const second = await bootstrap(b, { print: () => {} });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('BACKEND_NOT_EMPTY');

    const c = await restart();
    const accountsAfter = (await c.queryGSI1(S.accountsGsi())) as AccountItem[];
    expect(accountsAfter).toEqual(accountsBefore); // no fresh admin, no reset
  });
});
