import { createHash } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { ConfigStore, TransactWrite } from '../store/configStore';
import { ConditionError } from '../store/configStore';
import type { AuditItem, ChainHeadItem } from '../store/schema';
import { auditKey, chainHead, yyyymm } from '../store/schema';
import { ApiError } from '../errors';
import { nowIso } from '../clock';

/**
 * Hash-chained, tamper-evident audit. Every entry links to the previous
 * via `hash = sha256(prevHash + "\n" + canonicalJson(entryWithoutHashFields))`,
 * written in the SAME transaction as the CHAINHEAD conditional update so the chain
 * cannot fork. Per the frozen multi-project keying, the chain is PER-PROJECT
 * (projectId is an explicit arg); projectId is NOT part of the hashed content —
 * the algorithm defines the entry shape without it, and the per-project chain
 * partition + prevHash linkage already prevent cross-chain reuse.
 */

export type AuditEntryInput = {
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
};

export type RecordOpts = { idFn?: () => string; nowFn?: () => string };

/**
 * MONOTONIC ulid — the audit chain's SK order MUST match creation order (verify
 * walks entries by SK). Plain ulid() can reorder within the same millisecond.
 */
const ulid = monotonicFactory();

/** Recursive key-sorted, no-whitespace JSON. Arrays keep order; only objects sort. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The exact fields the hash covers (excludes PK/SK/GSI/projectId/prevHash/hash; omits undefined). */
export function entryForHash(item: {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action,
    targetType: item.targetType,
    targetId: item.targetId,
  };
  if (item.before !== undefined) out.before = item.before;
  if (item.after !== undefined) out.after = item.after;
  if (item.requestId !== undefined) out.requestId = item.requestId;
  if (item.interimProfile !== undefined) out.interimProfile = item.interimProfile;
  return out;
}

/** The hash of an entry given its predecessor's hash (genesis prevHash = ''). */
export function auditEntryHash(prevHash: string, item: Parameters<typeof entryForHash>[0]): string {
  return createHash('sha256')
    .update(`${prevHash}\n${canonicalJson(entryForHash(item))}`)
    .digest('hex');
}

/** The verify-time shape of a chain entry (a superset-tolerant AuditItem projection). */
export type ChainEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  interimProfile?: boolean;
  prevHash: string;
  hash: string;
};

export type VerifyResult = { code: 0 | 1 | 2; badUlid?: string; message: string };

/**
 * Walk entries oldest→newest, recompute every hash + prevHash linkage, and
 * (given a head) compare the tail to the chain head. 0 intact · 1 broken (names
 * the first bad ulid) · 2 head mismatch. Canonical impl — the offline CLI and the
 * admin export endpoint both call THIS, so on-disk and served verdicts can't diverge.
 */
export function verifyChain(entries: ChainEntry[], opts?: { head?: string }): VerifyResult {
  let prevHash = '';
  for (const e of entries) {
    const recomputed = auditEntryHash(prevHash, e);
    if (e.prevHash !== prevHash || e.hash !== recomputed) {
      return { code: 1, badUlid: e.id, message: `chain broken at ${e.id}` };
    }
    prevHash = e.hash;
  }
  if (opts?.head !== undefined && prevHash !== opts.head) {
    return { code: 2, message: `head mismatch: computed ${prevHash || '(empty)'} != ${opts.head}` };
  }
  return { code: 0, message: `ok: ${entries.length} entries intact` };
}

function buildAuditItem(
  projectId: string,
  id: string,
  at: string,
  entry: AuditEntryInput,
  prevHash: string,
  hash: string,
): AuditItem {
  return {
    ...auditKey(projectId, yyyymm(new Date(at)), id),
    id,
    projectId,
    at,
    action: entry.action,
    actor: entry.actor,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ...(entry.before !== undefined ? { before: entry.before } : {}),
    ...(entry.after !== undefined ? { after: entry.after } : {}),
    ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
    ...(entry.interimProfile !== undefined ? { interimProfile: entry.interimProfile } : {}),
    prevHash,
    hash,
  };
}

/**
 * Pure variant: fold an audit append (audit put + CHAINHEAD conditional update)
 * into the CALLER's domain transaction. Callers concat `writes` with their own and
 * run ONE transact. `head` is the current CHAINHEAD (or null at genesis).
 */
export function recordIn(
  projectId: string,
  head: ChainHeadItem | null,
  entry: AuditEntryInput,
  opts?: RecordOpts,
): { writes: TransactWrite[]; newHash: string; id: string } {
  const id = (opts?.idFn ?? (() => ulid()))();
  const at = (opts?.nowFn ?? (() => nowIso()))();
  const prevHash = head?.hash ?? '';
  const count = head?.count ?? 0;
  const hash = auditEntryHash(prevHash, { id, at, ...entry });
  const auditItem = buildAuditItem(projectId, id, at, entry, prevHash, hash);
  const hKey = chainHead(projectId);
  const headWrite: TransactWrite = head
    ? { kind: 'update', pk: hKey.PK, sk: hKey.SK, set: { hash, lastUlid: id, count: count + 1 }, ifEquals: { attr: 'hash', value: prevHash } }
    : { kind: 'put', item: { ...hKey, hash, lastUlid: id, count: 1 } satisfies ChainHeadItem, ifNotExists: true };
  return { writes: [{ kind: 'put', item: auditItem, ifNotExists: true }, headWrite], newHash: hash, id };
}

/**
 * Standalone append (login and other single-mutation callers). Reads CHAINHEAD,
 * appends in one transact; a chain-contention ConditionError retries ONCE, then
 * throws 409 CHAIN_CONTENTION. Signature is unchanged from the Task-4 placeholder.
 */
export async function record(
  store: ConfigStore,
  projectId: string,
  entry: AuditEntryInput,
  opts?: RecordOpts,
): Promise<{ id: string; hash: string }> {
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes, newHash, id } = recordIn(projectId, head, entry, opts);
    try {
      await store.transact(writes);
      return { id, hash: newHash };
    } catch (e) {
      if (e instanceof ConditionError) {
        if (attempt === 0) continue; // one retry against the fresh head
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  // unreachable
  throw new ApiError('CHAIN_CONTENTION');
}

/**
 * Fold an audit append into the CALLER's domain writes and run ONE transact.
 * Use when the ONLY conditional writes are the domain puts on fresh keys + the
 * chain head (submit, admin apply). A ConditionError retries once against the
 * fresh head, then 409 CHAIN_CONTENTION. Callers that carry their OWN dedupe
 * condition (e.g. approve's ifNotExists) must NOT use this — they need to tell a
 * dedupe failure apart from chain contention.
 */
export async function transactWithAudit(
  store: ConfigStore,
  projectId: string,
  domainWrites: TransactWrite[],
  entry: AuditEntryInput,
  opts?: RecordOpts,
): Promise<{ id: string; hash: string }> {
  const hKey = chainHead(projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes, newHash, id } = recordIn(projectId, head, entry, opts);
    try {
      await store.transact([...domainWrites, ...writes]);
      return { id, hash: newHash };
    } catch (e) {
      if (e instanceof ConditionError) {
        if (attempt === 0) continue;
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  throw new ApiError('CHAIN_CONTENTION');
}
