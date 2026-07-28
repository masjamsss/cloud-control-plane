/**
 * ccp-api load bench — the reproducible measurement behind every performance claim.
 *
 * Boots the REAL app (`createApp`) against a seeded store, drives the hot endpoints
 * through `app.fetch` (no sockets, so the numbers are server-side work, not loopback
 * noise), and reports p50/p95/p99 + throughput per scenario.
 *
 * Usage:
 *   npx tsx scripts/bench.ts                          # default scale, both stores
 *   npx tsx scripts/bench.ts --scale 5000             # 5000 requests + audit entries
 *   npx tsx scripts/bench.ts --store file             # file | memory | both
 *   npx tsx scripts/bench.ts --iterations 300
 *   npx tsx scripts/bench.ts --json out.json          # machine-readable, for A/B diffs
 *
 * The seed is DETERMINISTIC (fixed ids, fixed timestamps, no randomness in the data
 * shape), so two runs of the same scale are comparable and an A/B against a code
 * change measures the code, not the fixture.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/index';
import type { ConfigStore, Item } from '../src/store/configStore';
import { MemoryStore } from '../src/store/memoryStore';
import { FileStore } from '../src/store/fileStore';
import { mintSession } from '../src/auth/sessions';
import { __setKnownProjects } from '../src/projects';
import {
  accountKey,
  accountsGsi,
  auditKey,
  chainHead,
  policyKey,
  projectCollectionGsi,
  projectKey,
  requestCollectionGsi,
  requestKey,
  settlementKey,
  teamCollectionGsi,
  teamKey,
  yyyymm,
} from '../src/store/schema';
import type { AccountItem, AuditItem, ChainHeadItem, ProjectItem, RequestItem, TeamItem } from '../src/store/schema';
import { auditEntryHash } from '../src/domain/audit';

const PROJECT = 'bench';
const ORIGIN = 'http://bench.local';

/* ── options ─────────────────────────────────────────────────────────────── */

type StoreKind = 'memory' | 'file';

type Options = {
  scale: number;
  iterations: number;
  warmup: number;
  stores: StoreKind[];
  json: string | null;
  only: string | null;
  concurrency: number;
};

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const storeArg = get('--store') ?? 'both';
  return {
    scale: Number(get('--scale') ?? 2000),
    iterations: Number(get('--iterations') ?? 200),
    warmup: Number(get('--warmup') ?? 20),
    stores: storeArg === 'both' ? ['memory', 'file'] : [storeArg as StoreKind],
    json: get('--json') ?? null,
    only: get('--only') ?? null,
    concurrency: Number(get('--concurrency') ?? 32),
  };
}

/* ── deterministic fixture ───────────────────────────────────────────────── */

const ACCOUNT_COUNT = 50;
const TEAM_COUNT = 12;
/** Audit entries are spread over this many UTC months, so the month-partition walk
 *  in `readAuditChronological` is exercised the way a year-old estate exercises it. */
const AUDIT_MONTHS = 6;

const BASE_TIME = Date.UTC(2026, 0, 1);

/** ULID-shaped, lexicographically ordered, deterministic. */
function seqId(prefix: string, i: number): string {
  return `${prefix}${String(i).padStart(20, '0')}`;
}

function benchAccount(id: string, role: 'requester' | 'approver' | 'lead', isAdmin: boolean): AccountItem {
  return {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    roles: { [PROJECT]: { role, teamId: `team-${0}` }, ...(isAdmin ? { '*': { role: 'lead' } } : {}) },
    status: 'active',
    createdAt: new Date(BASE_TIME).toISOString(),
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin,
    credential: { algo: 'argon2id', hash: 'bench-placeholder-never-verified' },
    failedAttempts: 0,
    sessionVersion: 1,
    ...(role === 'requester' ? {} : { totp: { secretEnc: 'bench-enc', enrolledAt: new Date(BASE_TIME).toISOString() } }),
    GSI1PK: accountsGsi(),
    GSI1SK: id,
  } as AccountItem;
}

function benchRequest(i: number): RequestItem {
  const id = seqId('REQ', i);
  const at = new Date(BASE_TIME + i * 1000).toISOString();
  // A third of the corpus stays OPEN so the `pending`/`all` scopes do real filtering
  // work rather than short-circuiting on a fully-terminal corpus.
  const status = i % 3 === 0 ? 'AWAITING_DEPLOY_APPROVAL' : i % 3 === 1 ? 'APPLIED' : 'REJECTED';
  return {
    ...requestKey(PROJECT, id),
    id,
    requestUlid: id,
    requester: `user-${i % ACCOUNT_COUNT}`,
    teamId: `team-${i % TEAM_COUNT}`,
    service: 'cloudwatch',
    operationId: 'cloudwatch-alarm-threshold',
    macd: 'Change',
    targetAddress: `aws_cloudwatch_metric_alarm.bench_${i}`,
    params: { threshold: i, period: 300, comparison: 'GreaterThanThreshold' },
    justification: `bench fixture request ${i} — deterministic corpus for load measurement`,
    exposure: 'l2_reviewed',
    risk: 'MEDIUM',
    status,
    approvalsRequired: 1,
    approvals: [],
    schedule: { kind: 'now' },
    createdAt: at,
    updatedAt: at,
    events: [],
    policyVersion: 1,
    GSI1PK: requestCollectionGsi(PROJECT),
    GSI1SK: id,
  } as RequestItem;
}

/** Build the whole fixture as a flat item list (fast bulk load, no per-item persist). */
function buildFixture(scale: number): Item[] {
  const items: Item[] = [];

  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const role = i === 0 ? 'lead' : i % 5 === 0 ? 'approver' : 'requester';
    items.push(benchAccount(`user-${i}`, role, i === 0) as unknown as Item);
  }

  for (let i = 0; i < TEAM_COUNT; i++) {
    items.push({
      ...teamKey(PROJECT, `team-${i}`),
      id: `team-${i}`,
      name: `Team ${i}`,
      serviceSlugs: ['cloudwatch', 'ec2'],
      version: 1,
      GSI1PK: teamCollectionGsi(PROJECT),
      GSI1SK: `team-${i}`,
    } as unknown as TeamItem as unknown as Item);
  }

  items.push({ ...policyKey(PROJECT), low: 1, medium: 1, high: 2, deleteMin: 2, version: 1 } as unknown as Item);

  const project: ProjectItem = {
    ...projectKey(PROJECT),
    id: PROJECT,
    name: 'Bench Estate',
    status: 'ready',
    createdAt: new Date(BASE_TIME).toISOString(),
    createdBy: 'system',
    GSI1PK: projectCollectionGsi(),
    GSI1SK: PROJECT,
  } as unknown as ProjectItem;
  items.push(project as unknown as Item);

  // Settlement marker: this store is already settled, so the boot/first-request
  // settlement pass is a no-op and never pollutes the measurement.
  items.push({ ...settlementKey(), settledAt: new Date(BASE_TIME).toISOString(), version: 1 } as unknown as Item);

  for (let i = 0; i < scale; i++) items.push(benchRequest(i) as unknown as Item);

  // A REAL hash chain (each entry links to its predecessor) spread over AUDIT_MONTHS
  // month partitions, so /admin/audit and /readyz do genuine verification work.
  let prevHash = '';
  const perMonth = Math.ceil(scale / AUDIT_MONTHS);
  for (let i = 0; i < scale; i++) {
    const month = Math.floor(i / perMonth);
    const d = new Date(Date.UTC(2026, month, 1 + (i % 27)));
    const entry = {
      id: seqId('AUD', i),
      at: d.toISOString(),
      actor: `user-${i % ACCOUNT_COUNT}`,
      action: 'request-submitted',
      targetType: 'request',
      targetId: seqId('REQ', i % Math.max(scale, 1)),
      after: { status: 'AWAITING_DEPLOY_APPROVAL', risk: 'MEDIUM' },
    };
    const hash = auditEntryHash(prevHash, entry);
    items.push({
      ...auditKey(PROJECT, yyyymm(d), entry.id),
      ...entry,
      projectId: PROJECT,
      prevHash,
      hash,
    } as unknown as AuditItem as unknown as Item);
    prevHash = hash;
  }
  items.push({
    ...chainHead(PROJECT),
    hash: prevHash,
    count: scale,
    updatedAt: new Date(BASE_TIME).toISOString(),
  } as unknown as ChainHeadItem as unknown as Item);

  return items;
}

/* ── scenarios ───────────────────────────────────────────────────────────── */

type Scenario = {
  name: string;
  /** What this scenario is actually measuring — printed in the report. */
  note: string;
  build: (ctx: { cookie: string }) => Request;
  /** Non-2xx is a bench bug, except where a scenario documents otherwise. */
  expect?: number;
};

function req(path: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      cookie,
      'x-ccp-project': PROJECT,
      'x-ccp-client': 'ccp-spa',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const SCENARIOS: Scenario[] = [
  {
    name: 'GET /healthz',
    note: 'floor: middleware chain only, no store reads',
    build: ({ cookie }) => req('/healthz', cookie),
  },
  {
    name: 'GET /auth/me',
    note: 'session resolve + idle-window slide (the per-request write)',
    build: ({ cookie }) => req('/auth/me', cookie),
  },
  {
    name: 'GET /requests?scope=all',
    note: 'the estate list — GSI query over the whole request corpus',
    build: ({ cookie }) => req('/requests?scope=all', cookie),
  },
  {
    name: 'GET /requests?scope=mine',
    note: 'same corpus, filtered to one requester',
    build: ({ cookie }) => req('/requests?scope=mine', cookie),
  },
  {
    name: 'GET /requests?all&limit=50',
    note: 'one page of the estate list — should not track corpus size',
    build: ({ cookie }) => req('/requests?scope=all&limit=50', cookie),
  },
  {
    name: 'GET /admin/accounts',
    note: 'global account directory (small GSI partition, large table)',
    build: ({ cookie }) => req('/admin/accounts', cookie),
  },
  {
    name: 'GET /admin/audit?limit=50',
    note: 'newest-first audit page — walks month partitions',
    build: ({ cookie }) => req('/admin/audit?limit=50', cookie),
  },
  {
    name: 'GET /readyz',
    note: 'readiness probe — verifies every project chain',
    build: ({ cookie }) => req('/readyz', cookie),
  },
  {
    name: 'GET /admin/teams',
    note: 'small scoped GSI partition inside a large table',
    build: ({ cookie }) => req('/admin/teams', cookie),
  },
];

/* ── measurement ─────────────────────────────────────────────────────────── */

type Stat = { name: string; note: string; n: number; p50: number; p95: number; p99: number; max: number; mean: number; rps: number };

function summarize(name: string, note: string, samples: number[]): Stat {
  const s = samples.slice().sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const total = s.reduce((a, b) => a + b, 0);
  const mean = total / s.length;
  return {
    name,
    note,
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1] ?? 0,
    mean,
    rps: mean > 0 ? 1000 / mean : Infinity,
  };
}

const fmt = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(3));

async function runScenario(
  app: ReturnType<typeof createApp>,
  sc: Scenario,
  cookie: string,
  iterations: number,
  warmup: number,
): Promise<Stat> {
  for (let i = 0; i < warmup; i++) {
    const res = await app.fetch(sc.build({ cookie }));
    await res.arrayBuffer();
  }
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const request = sc.build({ cookie });
    const t0 = performance.now();
    const res = await app.fetch(request);
    await res.arrayBuffer(); // drain: JSON serialization is part of the cost
    samples.push(performance.now() - t0);
    if (i === 0 && sc.expect !== undefined && res.status !== sc.expect) {
      throw new Error(`${sc.name}: expected ${sc.expect}, got ${res.status}`);
    }
    if (i === 0 && sc.expect === undefined && res.status >= 400) {
      throw new Error(`${sc.name}: unexpected ${res.status} — ${await res.clone().text()}`);
    }
  }
  return summarize(sc.name, sc.note, samples);
}

/** Write-path cost: N submits' worth of store mutation, measured through the store
 *  seam (route-level submit needs a manifest catalog the bench does not ship). */
async function measureWrites(store: ConfigStore, scale: number, iterations: number): Promise<Stat> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const item = benchRequest(scale + i) as unknown as Item;
    const t0 = performance.now();
    await store.put(item);
    samples.push(performance.now() - t0);
  }
  return summarize('store.put (sequential)', 'the durable-write path — one mutation at a time', samples);
}

/**
 * The number a server actually lives or dies by: what a BURST of concurrent
 * durable writes costs. A store that snapshots per mutation serializes the burst —
 * every writer waits for every earlier writer's full fsync — so per-op cost stays
 * flat and wall-clock grows linearly with the burst. A store that batches pays for
 * roughly one snapshot for the whole burst.
 */
async function measureConcurrentWrites(store: ConfigStore, scale: number, burst: number, rounds: number): Promise<Stat> {
  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const base = scale + 10_000 + r * burst;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: burst }, (_, i) => store.put(benchRequest(base + i) as unknown as Item)));
    samples.push((performance.now() - t0) / burst); // per-op cost within the burst
  }
  return summarize(`store.put (x${burst} concurrent)`, 'per-op cost inside a concurrent write burst', samples);
}

/** Sustained read throughput with `concurrency` requests in flight, not one at a time. */
async function measureThroughput(
  app: ReturnType<typeof createApp>,
  sc: Scenario,
  cookie: string,
  total: number,
  concurrency: number,
): Promise<{ rps: number; meanMs: number }> {
  let issued = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < total) {
        issued++;
        const res = await app.fetch(sc.build({ cookie }));
        await res.arrayBuffer();
      }
    }),
  );
  const elapsed = performance.now() - t0;
  return { rps: (total / elapsed) * 1000, meanMs: elapsed / total };
}

/* ── driver ──────────────────────────────────────────────────────────────── */

async function openStore(kind: StoreKind, items: Item[], dir: string): Promise<{ store: ConfigStore; cleanup: () => void }> {
  if (kind === 'memory') {
    const s = new MemoryStore();
    s.importItems(items);
    return { store: s, cleanup: () => undefined };
  }
  const file = join(dir, 'bench.json');
  const s = new FileStore(file);
  s.importItems(items);
  // One durable write to materialize the file, so the first measured mutation is not
  // paying for directory creation.
  await s.put(items[0]!);
  return { store: s, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  process.env.CCP_CORS_ORIGIN = ORIGIN;

  console.log(`ccp-api bench — scale ${opts.scale} requests + ${opts.scale} audit entries, ${opts.iterations} iterations/scenario\n`);

  const fixture = buildFixture(opts.scale);
  console.log(`fixture: ${fixture.length} store items\n`);

  const results: Record<string, Stat[]> = {};

  for (const kind of opts.stores) {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-bench-'));
    const { store, cleanup } = await openStore(kind, fixture, dir);
    try {
      __setKnownProjects([PROJECT]);
      const app = createApp(store, { projectDataRoot: join(dir, 'projects') });
      const token = await mintSession(store, 'user-0', 1);
      const cookie = `ccp_session=${token}`;

      console.log(`── ${kind} store ${'─'.repeat(74 - kind.length)}`);
      console.log(
        `${'scenario'.padEnd(30)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)} ${'max'.padStart(9)} ${'req/s'.padStart(10)}`,
      );

      const stats: Stat[] = [];
      for (const sc of SCENARIOS) {
        if (opts.only && !sc.name.includes(opts.only)) continue;
        const stat = await runScenario(app, sc, cookie, opts.iterations, opts.warmup);
        stats.push(stat);
        console.log(
          `${stat.name.padEnd(30)} ${fmt(stat.p50).padStart(9)} ${fmt(stat.p95).padStart(9)} ${fmt(stat.p99).padStart(9)} ${fmt(stat.max).padStart(9)} ${stat.rps.toFixed(0).padStart(10)}`,
        );
      }
      if (!opts.only) {
        for (const w of [
          await measureWrites(store, opts.scale, Math.min(opts.iterations, 100)),
          await measureConcurrentWrites(store, opts.scale, opts.concurrency, 10),
        ]) {
          stats.push(w);
          console.log(
            `${w.name.padEnd(30)} ${fmt(w.p50).padStart(9)} ${fmt(w.p95).padStart(9)} ${fmt(w.p99).padStart(9)} ${fmt(w.max).padStart(9)} ${w.rps.toFixed(0).padStart(10)}`,
          );
        }

        // Concurrent read throughput — what the server sustains, as opposed to how
        // fast one idle request completes.
        console.log(`\n  concurrent read throughput (${opts.concurrency} in flight):`);
        for (const sc of SCENARIOS) {
          const t = await measureThroughput(app, sc, cookie, Math.max(opts.iterations, 100), opts.concurrency);
          console.log(`  ${sc.name.padEnd(30)} ${t.rps.toFixed(0).padStart(8)} req/s   (${fmt(t.meanMs)} ms mean)`);
        }
      }
      console.log();
      results[kind] = stats;
    } finally {
      cleanup();
    }
  }

  if (opts.json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.json, JSON.stringify({ scale: opts.scale, iterations: opts.iterations, results }, null, 2));
    console.log(`wrote ${opts.json}`);
  }
}

void main();
