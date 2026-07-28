import type { ConfigStore } from '../store/configStore';
import type { AuditItem, ChainHeadItem } from '../store/schema';
import { auditKey, chainHead } from '../store/schema';
import { auditEntryHash, verifyChain, type ChainEntry, type VerifyResult } from './audit';
import { nowDate } from '../clock';

/** How far back the month walk is willing to look — ten years of partitions. */
const MAX_MONTHS_WALKED = 120;

/**
 * The month partitions of `projectId`, newest first, starting from the month
 * containing `from`.
 *
 * Stepping back a month with `d.setUTCMonth(d.getUTCMonth() - 1)` is WRONG and was
 * a live correctness bug: on 31 March that asks for 31 February, which JavaScript
 * normalizes forward to 3 March, so the walk yields March twice and the reader
 * accumulated that partition's entries twice. A duplicated block breaks the
 * prevHash linkage at the seam, so a perfectly intact chain reported as BROKEN —
 * `/readyz` 503, `/admin/audit/export` `verified: false` — on 15 days of 2026 and
 * nowhere else. Plain integer arithmetic on (year, month) cannot do that.
 */
function* monthsBackward(projectId: string, from: Date): Generator<string> {
  let year = from.getUTCFullYear();
  // Start ONE MONTH AHEAD of `from`. An entry is stamped with the clock at write
  // time, so a backward adjustment (NTP correction, VM resume) taken just after a
  // month boundary leaves entries in a partition that is now "the future" —
  // invisible to a walk that starts at the current month, which reads as a short
  // chain and therefore as a BROKEN one. That is the same severity as the overflow
  // bug below (503 + "evidence unverified") for the same category of reason, and
  // costs exactly one read of a normally-empty partition to rule out.
  let month = from.getUTCMonth() + 1; // 0-11, may be 12 -> normalized below
  if (month > 11) {
    month = 0;
    year += 1;
  }
  for (let i = 0; i < MAX_MONTHS_WALKED; i++) {
    yield auditKey(projectId, `${year}${String(month + 1).padStart(2, '0')}`, '').PK;
    if (month === 0) {
      month = 11;
      year -= 1;
    } else {
      month -= 1;
    }
  }
}

/**
 * Read-side of the audit chain for the admin surface. The chain is partitioned
 * by month (`P#<project>#AUDIT#<yyyymm>`), so to gather the whole chain we walk
 * month partitions BACKWARD from now, accumulating until we have exactly the
 * CHAINHEAD `count` entries — a deterministic, bounded traversal that needs no
 * table scan (staying within the DynamoDB-shaped ConfigStore seam).
 */

/** The `AuditEntry` projection served to clients (drops PK/SK/projectId storage keys). */
export type AuditEntry = ChainEntry;

export function toAuditEntry(item: AuditItem): AuditEntry {
  const e: AuditEntry = {
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action,
    targetType: item.targetType,
    targetId: item.targetId,
    prevHash: item.prevHash,
    hash: item.hash,
  };
  if (item.before !== undefined) e.before = item.before;
  if (item.after !== undefined) e.after = item.after;
  if (item.requestId !== undefined) e.requestId = item.requestId;
  if (item.interimProfile !== undefined) e.interimProfile = item.interimProfile;
  return e;
}

/** All chain entries oldest→newest, plus the current head (or null at genesis). */
export async function readAuditChronological(
  store: ConfigStore,
  projectId: string,
): Promise<{ entries: AuditItem[]; head: ChainHeadItem | null }> {
  const hKey = chainHead(projectId);
  const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
  const total = head?.count ?? 0;
  if (total === 0) return { entries: [], head };

  const chunks: AuditItem[][] = [];
  let collected = 0;
  // `nowDate()`, not `new Date()`: the one-clock rule (clock.ts) exists so time-
  // dependent behaviour is testable, and reading the wall clock here is what made
  // the month-walk bug above invisible to the suite for as long as it existed.
  for (const monthPk of monthsBackward(projectId, nowDate())) {
    if (collected >= total) break;
    const chunk = (await store.query(monthPk)) as AuditItem[]; // SK-ascending within a month
    if (chunk.length > 0) {
      chunks.push(chunk);
      collected += chunk.length;
    }
  }
  // chunks are newest-month-first; reverse → oldest-month-first, each already SK-ascending.
  return { entries: chunks.reverse().flat(), head };
}

/**
 * One page of the chain, NEWEST first — the read behind `GET /admin/audit`.
 *
 * Bounded by construction: it walks month partitions newest-first and stops the
 * moment the page is full, so serving 50 rows costs 50 rows plus whatever
 * partition boundary it lands on. (The endpoint previously loaded the ENTIRE
 * chain, reversed it, and sliced 50 out of the front — a read that grew without
 * limit while the answer stayed the same size.)
 *
 * `cursor` is the `id` of the last entry of the previous page, and its semantics
 * are preserved exactly, including the deliberate one: a cursor that is not in the
 * chain yields an EMPTY page, never a silent full replay from the top.
 */
export async function readAuditPage(
  store: ConfigStore,
  projectId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ items: AuditItem[]; hasMore: boolean }> {
  const hKey = chainHead(projectId);
  const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
  const total = head?.count ?? 0;
  if (total === 0) return { items: [], hasMore: false };

  const items: AuditItem[] = [];
  // Read one MORE than asked so `hasMore` is answered by the same walk rather than
  // by a second pass over the chain.
  const want = opts.limit + 1;
  let found = opts.cursor === undefined;
  let seen = 0;

  for (const monthPk of monthsBackward(projectId, nowDate())) {
    if (items.length >= want || seen >= total) break;
    // Descending: newest entry of the month first (SK == ulid == creation order).
    const chunk = (await store.query(monthPk, undefined, { forward: false })) as AuditItem[];
    seen += chunk.length;
    for (const e of chunk) {
      if (!found) {
        if (e.id === opts.cursor) found = true; // page resumes AFTER the cursor
        continue;
      }
      items.push(e);
      if (items.length >= want) break;
    }
  }

  const hasMore = items.length > opts.limit;
  if (hasMore) items.length = opts.limit;
  return { items, hasMore };
}

/**
 * The newest `n` entries in CHRONOLOGICAL order — the suffix
 * {@link verifyProjectChain} needs to extend an already-verified prefix.
 */
async function readAuditTail(store: ConfigStore, projectId: string, n: number, total: number): Promise<AuditItem[]> {
  if (n <= 0) return [];
  const chunks: AuditItem[][] = [];
  let collected = 0;
  for (const monthPk of monthsBackward(projectId, nowDate())) {
    if (collected >= n || collected >= total) break;
    const chunk = (await store.query(monthPk)) as AuditItem[]; // SK-ascending
    if (chunk.length > 0) {
      chunks.push(chunk);
      collected += chunk.length;
    }
  }
  const chronological = chunks.reverse().flat();
  return chronological.length > n ? chronological.slice(chronological.length - n) : chronological;
}

/**
 * Per-store memo of how far each project's chain has been verified. A WeakMap on
 * the STORE (not a module-global keyed by project id) so two stores in one process
 * — every test file builds several — can never read each other's verdict, and so
 * the memo dies with the store.
 */
const verifiedPrefixes = new WeakMap<ConfigStore, Map<string, { count: number; hash: string }>>();

/** Test/ops hook: forget what has been verified, forcing the next probe to do it all. */
export function __resetChainVerificationCache(store: ConfigStore): void {
  verifiedPrefixes.delete(store);
}

export type ChainVerification = { count: number; verified: boolean; message: string };

/**
 * Verify `projectId`'s chain, re-hashing only what this process has not already
 * verified. This is the readiness probe's read, and a readiness probe runs every
 * few seconds forever: re-reading and re-SHA-256-ing the entire chain each time
 * makes the cheapest endpoint in the system the most expensive one, and makes it
 * get worse every day the estate is used.
 *
 * The soundness argument, stated plainly because it is the whole point:
 *
 *   · The FIRST probe in a process verifies the chain in full. That is the check
 *     that matters — a corrupt, truncated or half-restored snapshot is a property
 *     of what was loaded from disk at boot, and it is caught before serving.
 *   · Afterwards the chain is APPEND-ONLY through this process (`recordIn` puts a
 *     new entry with `ifNotExists` and conditionally advances CHAINHEAD; nothing
 *     rewrites an existing entry), so re-verifying the prefix cannot find anything
 *     the first pass did not.
 *   · The memo is only USED if the entry at the end of the verified prefix still
 *     hashes to the remembered value — RE-HASHED from its content, not read off
 *     its own `hash` field. If it does not — a rewritten prefix, a truncation, a
 *     store swapped underneath — the memo is discarded and the whole chain is
 *     verified from genesis.
 *
 * What this deliberately does NOT do is re-read the chain to detect tampering that
 * bypassed the store API entirely. That is what `scripts/verify-audit-chain.ts`
 * (offline, full, on the file) and `GET /admin/audit/export` (full, on demand,
 * the evidence document) are for — both still verify every entry every time.
 */
export async function verifyProjectChain(store: ConfigStore, projectId: string): Promise<ChainVerification> {
  const hKey = chainHead(projectId);
  const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
  const total = head?.count ?? 0;
  if (total === 0) {
    return { count: 0, verified: true, message: verifyChain([], head ? { head: head.hash } : undefined).message };
  }

  let memo = verifiedPrefixes.get(store);
  if (!memo) {
    memo = new Map();
    verifiedPrefixes.set(store, memo);
  }
  const cached = memo.get(projectId);

  if (cached && cached.count <= total) {
    // Read the unverified suffix plus the last VERIFIED entry, so the prefix can be
    // re-anchored before anything is trusted.
    const tail = await readAuditTail(store, projectId, total - cached.count + 1, total);
    const anchor = tail[0] as unknown as ChainEntry | undefined;
    // The anchor is RE-HASHED from its content, not merely compared on its stored
    // `hash` field. Trusting the stored field would let an edit that rewrites an
    // entry's content while leaving its hash alone walk straight past the memo —
    // and that is precisely the shape tampering takes. Recomputing costs one hash.
    const anchorIntact =
      anchor !== undefined && anchor.hash === cached.hash && auditEntryHash(anchor.prevHash, anchor) === cached.hash;
    if (anchorIntact && tail.length === total - cached.count + 1) {
      const suffix = tail.slice(1) as unknown as ChainEntry[];
      let prevHash = cached.hash;
      for (const e of suffix) {
        if (e.prevHash !== prevHash || e.hash !== auditEntryHash(prevHash, e)) {
          memo.delete(projectId); // the extension is bad — never memo a broken chain
          return { count: total, verified: false, message: `chain broken at ${e.id}` };
        }
        prevHash = e.hash;
      }
      if (head !== null && prevHash !== head.hash) {
        memo.delete(projectId);
        return { count: total, verified: false, message: `head mismatch: computed ${prevHash || '(empty)'} != ${head.hash}` };
      }
      memo.set(projectId, { count: total, hash: prevHash });
      return { count: total, verified: true, message: `ok: ${total} entries intact` };
    }
    memo.delete(projectId); // anchor did not match — fall through to a full verification
  }

  const { entries } = await readAuditChronological(store, projectId);
  const verification = verifyChain(entries as unknown as ChainEntry[], head ? { head: head.hash } : undefined);
  const last = entries[entries.length - 1];
  if (verification.code === 0 && last) memo.set(projectId, { count: entries.length, hash: last.hash });
  else memo.delete(projectId);
  return { count: total, verified: verification.code === 0, message: verification.message };
}

export type AuditExport = {
  projectId: string;
  head: string;
  count: number;
  verified: boolean;
  verification: VerifyResult;
  entries: AuditEntry[];
};

/** The full chain as a self-verifying evidence document (chronological, head-checked). */
export async function exportAuditChain(store: ConfigStore, projectId: string): Promise<AuditExport> {
  const { entries, head } = await readAuditChronological(store, projectId);
  const verification = verifyChain(entries as unknown as ChainEntry[], head ? { head: head.hash } : undefined);
  return {
    projectId,
    head: head?.hash ?? '',
    count: head?.count ?? 0,
    verified: verification.code === 0,
    verification,
    entries: entries.map(toAuditEntry),
  };
}
