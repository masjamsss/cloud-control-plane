import { occupiesQuotaSlot } from '@app-lib/requestStatus';
import type { ConfigStore } from '../../store/configStore';
import type { RequestItem } from '../../store/schema';
import { requestCollectionGsi, requestKey } from '../../store/schema';

/**
 * PERF-14 — the scheduler's candidate set, without re-reading the project's whole request
 * history every minute.
 *
 * WHAT IT COST BEFORE. Each tick called `queryGSI1(requestCollectionGsi(projectId))` per
 * known project: the project's entire REQ partition, deep-cloned row by row (the store
 * seam copies on read, faithfully — a DynamoDB Query is charged for every item it
 * returns), to find a due set that is almost always empty. Measured on a MemoryStore at 20
 * projects x 500 requests: **45 ms per tick, ~44 ms of it inside `queryGSI1`**; at 20 x
 * 2000 it is ~190 ms. It is not a latency problem — nobody is waiting — it is permanent
 * per-minute allocation churn that grows linearly with history and never comes back down.
 *
 * WHY NOT THE OBVIOUS INDEX. The seam has ONE GSI, and request rows already spend its
 * partition key on the collection the list endpoint pages through, so there is no
 * status-scoped partition to add without either a second index in the store seam or
 * repurposing GSI1PK away from the list. Both are somebody else's file.
 *
 * WHY NOT THE FINDING'S OTHER SUGGESTION. "Maintain a small windowed-&-approved side list
 * updated on the transitions that create/destroy eligibility" puts correctness in the
 * hands of every write path that touches a request status — the submit route, approve,
 * cancel, rewindow, the cooling settler, the window settler, the freeze-hold settler, the
 * bundle, the scheduler itself. A transition that forgets to update the list does not
 * fail: it silently strands an approved change that then never applies. That is the worst
 * failure shape this codebase has, and it is not worth a per-minute clone.
 *
 * WHAT THIS DOES INSTEAD — MEMBERSHIP BY EXISTENCE, NOT BY TRANSITION. A request is
 * watched from the moment the index first SEES it (rows are discovered by walking the
 * collection forward from the highest sort key already seen) and stops being watched only
 * when a read of the row itself shows a terminal status. No write path anywhere has to
 * know this class exists, and no missed transition can drop a row out of the watch set,
 * because transitions are not what puts rows in it.
 *
 * THE INDEX IS A CACHE OF *WHICH ROWS*, NEVER OF THEIR CONTENTS. Every tick re-reads each
 * watched row with `store.get`, so the scheduler always decides on fresh state — exactly
 * as it did when it re-read the whole partition. Only membership is remembered, and
 * membership is rebuilt from scratch by a full scan every {@link DEFAULT_RESEED_TICKS}
 * ticks, which bounds any conceivable drift (see the ULID note on {@link nextCursor}) to
 * one re-seed interval instead of forever. Held in memory and per process: a restart
 * re-seeds, which is the correct behaviour for a cache and costs one scan.
 *
 * The result is a tick whose cost tracks the OPEN work in a project rather than its
 * history — `test/schedulerDueIndex.test.ts` pins that as a rule (the per-tick row count
 * must not change when the project's completed history grows 20x), not as a number.
 */

/** How many incremental ticks before the watch set is rebuilt from a full scan. */
export const DEFAULT_RESEED_TICKS = 30;

/** The scheduler's view of this seam: give me the rows worth looking at in this project. */
export interface DueCandidateSource {
  candidates(store: ConfigStore, projectId: string): Promise<RequestItem[]>;
}

/**
 * Is this row worth continuing to watch? The rule is the shared status vocabulary's
 * not-terminal rule (`occupiesQuotaSlot`, ARCH-7), NOT a local list of the statuses the
 * scheduler happens to act on today.
 *
 * That distinction is the whole safety argument. Watching only `AWAITING_DEPLOY_APPROVAL`
 * + `APPLYING` would be enough for the rows the scheduler acts on RIGHT NOW and would
 * silently drop every row that can still come BACK to those statuses — an
 * `AWAITING_CODE_REVIEW` row that gets approved, an `APPROVED_COOLING` row whose cooling
 * elapses, a `WINDOW_EXPIRED` row that is re-windowed. Deriving from "not terminal" means
 * a status added to the vocabulary later is watched until someone decides otherwise,
 * rather than being invisible until someone notices.
 */
function watchable(req: Pick<RequestItem, 'status'>): boolean {
  return occupiesQuotaSlot(req.status);
}

/** The GSI1 sort key a row is walked by — the seam's own fallback rule (`GSI1SK ?? SK`),
 * with the id as the last resort so a row that predates the GSI attributes still sorts. */
function sortKeyOf(req: RequestItem): string {
  return req.GSI1SK ?? req.id;
}

/**
 * The highest sort key in a batch, or `prev` when the batch is empty. Taken as a MAXIMUM
 * rather than "the last row", so an out-of-order batch can never rewind the cursor.
 *
 * ULID NOTE, stated rather than assumed: request sort keys are ULIDs, which order by
 * creation millisecond, with random low bits WITHIN a millisecond. So two rows created in
 * the same millisecond can be walked out of order, and a row could in principle sort below
 * a cursor taken from its own millisecond and be missed by the incremental walk. That is
 * why the full re-seed exists and why it is not optional: it bounds that (and any future
 * id-format surprise) to one re-seed interval. The alternative — trusting the walk —
 * would be a silent strand, which is the failure this index is built to avoid.
 */
function nextCursor(rows: RequestItem[], prev: string | undefined): string | undefined {
  let max = prev;
  for (const r of rows) {
    const sk = sortKeyOf(r);
    if (max === undefined || sk > max) max = sk;
  }
  return max;
}

interface ProjectState {
  cursor: string | undefined;
  watched: Set<string>;
  ticksSinceSeed: number;
}

/** Counters a test can assert on — this class's whole point is a cost claim, and a cost
 * claim nothing measures is a comment. */
export interface DueIndexStats {
  /** Full scans performed (the initial seed plus each periodic re-seed). */
  seeds: number;
  /** Rows currently watched in this project. */
  watched: number;
}

export class RequestDueIndex implements DueCandidateSource {
  private readonly state = new Map<string, ProjectState>();
  private readonly reseedTicks: number;
  private readonly seeds = new Map<string, number>();

  constructor(opts: { reseedEveryTicks?: number } = {}) {
    this.reseedTicks = opts.reseedEveryTicks ?? DEFAULT_RESEED_TICKS;
  }

  async candidates(store: ConfigStore, projectId: string): Promise<RequestItem[]> {
    const gsi = requestCollectionGsi(projectId);
    const st = this.state.get(projectId) ?? { cursor: undefined, watched: new Set<string>(), ticksSinceSeed: 0 };
    this.state.set(projectId, st);

    // SEED / RE-SEED — the only full scan. Its rows are already in hand and already
    // fresh, so this branch does no follow-up reads at all.
    if (st.cursor === undefined || st.ticksSinceSeed >= this.reseedTicks) {
      const all = (await store.queryGSI1(gsi)) as RequestItem[];
      const live = all.filter(watchable);
      st.watched = new Set(live.map((r) => r.id));
      st.cursor = nextCursor(all, undefined);
      st.ticksSinceSeed = 0;
      this.seeds.set(projectId, (this.seeds.get(projectId) ?? 0) + 1);
      return live;
    }

    // INCREMENTAL — everything created since the last walk. On a quiet project this
    // returns nothing and clones nothing: the seam skips rows before `after` without
    // copying them, and a real Query with an ExclusiveStartKey does not read them either.
    st.ticksSinceSeed++;
    const fresh = (await store.queryGSI1(gsi, { after: st.cursor })) as RequestItem[];
    st.cursor = nextCursor(fresh, st.cursor);
    for (const r of fresh) if (watchable(r)) st.watched.add(r.id);

    // Re-read each watched row: membership is remembered, state never is. A row that has
    // reached a terminal status (or vanished) leaves the set here, which is the only place
    // it can leave.
    const out: RequestItem[] = [];
    for (const id of [...st.watched]) {
      const k = requestKey(projectId, id);
      const row = (await store.get(k.PK, k.SK)) as RequestItem | null;
      if (row === null || !watchable(row)) {
        st.watched.delete(id);
        continue;
      }
      out.push(row);
    }
    return out;
  }

  stats(projectId: string): DueIndexStats {
    return { seeds: this.seeds.get(projectId) ?? 0, watched: this.state.get(projectId)?.watched.size ?? 0 };
  }
}
