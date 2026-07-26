# ccp-api performance

Everything here is reproducible with `scripts/bench.ts`. Nothing in this document
is an estimate.

```bash
cd ccp/api
npx tsx scripts/bench.ts --scale 8000 --store both --concurrency 32
```

The bench boots the **real** app (`createApp`) against a deterministically seeded
store and drives the hot endpoints through `app.fetch`, so the numbers are
server-side work rather than loopback noise. The fixture is shaped like a real
estate: a hash-linked audit chain spread over six UTC month partitions, a third
of the request corpus left OPEN so list filtering does real work, and a
pre-written `SETTLEMENT` marker so the one-time boot settlement never pollutes a
sample. Two runs at the same scale are directly comparable, so an A/B against a
code change measures the code and not the fixture.

Absolute numbers below are from one machine and move with how loaded it is —
a run on a busy host came out ~1.5x slower across the board. The *ratios* are
what to read, and they are stable. Always take a before and after in the same
session rather than comparing against the table here.

## Where it started

Measured on the **FileStore** — the store production actually runs — with 8,000
requests and an 8,000-entry audit chain (16,066 items, a 5.9 MiB snapshot):

| Endpoint | p50 | throughput |
|---|---:|---:|
| `GET /healthz` | 178 ms | 5 req/s |
| `GET /auth/me` | 179 ms | 5 req/s |
| `GET /admin/teams` | 168 ms | 6 req/s |
| `GET /admin/accounts` | 178 ms | 5 req/s |
| `GET /admin/audit?limit=50` | 209 ms | 5 req/s |
| `GET /readyz` | 253 ms | 4 req/s |
| `GET /requests?scope=all` | 280 ms | 4 req/s |
| `store.put` (one row) | 176 ms | 6 ops/s |

The whole API served about **5 requests per second**, and the cost was flat
across endpoints — a liveness probe that reads nothing cost the same as listing
the entire estate. That flatness was the clue: the cost had nothing to do with
what any endpoint did.

Scaling was exactly linear. At 2,000 requests every number above was ~4x smaller;
at 8,000 it was ~4x bigger. The API's latency tracked **database size**, not
result size.

## Where it is now

Same fixture, same machine, same command:

| Endpoint | before | after | |
|---|---:|---:|---:|
| `GET /healthz` | 178 ms | **0.09 ms** | 1900x |
| `GET /auth/me` | 179 ms | **0.10 ms** | 1700x |
| `GET /admin/teams` | 168 ms | **0.09 ms** | 1800x |
| `GET /admin/accounts` | 178 ms | **0.19 ms** | 900x |
| `GET /readyz` | 253 ms | **1.05 ms** | 240x |
| `GET /admin/audit?limit=50` | 209 ms | **1.03 ms** | 200x |
| `GET /requests?scope=all&limit=50` | n/a | **2.25 ms** | (new) |
| `GET /requests?scope=all` (unpaged) | 280 ms | 97 ms | 2.9x |
| `store.put` inside a 32-write burst | 126 ms/op | **4.0 ms/op** | 31x |

Concurrent read throughput, 32 requests in flight: **14,394 req/s** on
`/healthz`, 16,472 on `/auth/me`, 12,858 on `/admin/teams`. Over real sockets
(not `app.fetch`) an authenticated `/auth/me` sustains ~2,900 req/s with 32
connections; the remainder is HTTP and TCP, not the API.

## What was actually wrong

### 1. Every request rewrote the entire database

`resolveSession` slid the 30-minute idle window by `PUT`ting the session row on
**every authenticated request**. On the FileStore a put is a full-snapshot
`fsync`. So `GET /healthz` — which reads nothing and touches no session — paid to
serialize and durably rewrite the whole governance database, because a session
cookie happened to ride along on the request.

This is the entire explanation for the flat ~178 ms floor.

The slide is now coalesced to a one-minute granularity
(`SLIDE_GRANULARITY_MS`). The direction is deliberately **fail-closed**: the
stored `lastSeenAt` lags reality by at most a minute, so a session idles out
slightly *early*, never late — the security property is preserved and, at the
margin, enforced slightly more strictly. Within a request the resolved session
still carries the true current value, so nothing downstream observes the lag.

### 2. Every read was a full table scan

`MemoryStore` (which `FileStore` extends) held one flat `Map` and implemented
`query`/`queryGSI1` by **filtering the whole table**. `GET /admin/teams` returns
ten rows; it walked all 16,066 items to find them.

It is now partitioned the way the DynamoDB table it stands in for is partitioned:
a primary index keyed by `PK` (rows keyed by `SK`) and a GSI1 index keyed by
`GSI1PK`, each with a lazily rebuilt sort order. Reads touch exactly one
partition, so a ten-row read costs ten rows whether the table holds a hundred
items or a hundred thousand.

### 3. The clone was the wrong clone

The store deep-copies on every read, every write and every snapshot, and used
`structuredClone` — which pays for cycle tracking and the full structured-clone
algorithm. Store items are JSON values *by contract*: `FileStore` round-trips
the entire store through `JSON.stringify`/`JSON.parse` on every snapshot and
every boot, so anything that does not survive that round trip is already corrupt
at the next restart.

A JSON-value clone is therefore both correct and much faster — measured on these
item shapes, **0.41 µs/item against 4.19 µs** (`src/store/clone.ts`).

### 4. The durable write did not batch

Each mutation queued its own full snapshot, so N concurrent writers meant N
serializations and N `fsync`s, each waiting behind the last.

`FileStore` now batches: mutations that arrive while a write is in flight join
the **next** snapshot instead of queueing one each. This is sound because the
store never rolls a mutation back — a snapshot taken after N mutations have
landed necessarily contains all N, so one write can honour all N durability
promises. Each caller's contract is unchanged and still strict: `await
store.put(x)` resolves only once a snapshot *containing x* is durably on disk.

Sequential write latency is unchanged (~126 ms at this scale) because a single
isolated write still serializes the whole store — that is the documented
full-snapshot durability trade-off, not a bug. What changed is the number that
matters for a server: **per-operation cost inside a burst fell 31x**.

### 5. `/readyz` re-verified the whole chain on every probe

`readiness()` called `exportAuditChain`, which read every entry, re-SHA-256'd
every entry, and built the full evidence projection — then discarded all of it
and kept three fields. A readiness probe runs every few seconds forever, so the
cheapest endpoint in the system was the one that got slowest as the estate aged.

`verifyProjectChain` verifies in full on the first probe of a process, then
re-hashes only entries appended since. See "Deliberate trade-offs" below.

### 6. `GET /admin/audit` loaded the whole chain to serve 50 rows

It read every entry, reversed the array, and sliced a page off the front — a read
that grows forever while the answer stays the same size. `readAuditPage` walks
month partitions newest-first and stops when the page is full. Cursor semantics
are preserved exactly, including the deliberate one: an unknown cursor yields an
empty page, never a silent replay from the top.

### 7. `GET /requests` never implemented the pagination it declared

`openapi/ccp-api.yaml` has specified a `cursor` parameter on `GET /requests`, and
a `cursor` field on its response, since the contract was written. The handler
honoured neither and returned every request the estate had ever seen in one
response. At 8,000 requests that is ~6 MB of JSON per call, growing forever.

Pagination is now real and **opt-in**, so nothing that calls it today changes:
without `limit` the response is byte-for-byte what it always was. With `limit`
the GSI partition is walked in chunks and the walk stops as soon as the page is
full. A `cursor` without a `limit` is a 422 rather than a silently ignored
parameter — the failure mode that let this gap sit unnoticed in the first place.

### 8. Smaller repeated work on hot paths

- `toChangeRequest` built **two** full copies of every request
  (rest-destructure, then spread), once per row of every list response. It was
  the single largest cost in the list endpoint after the store was fixed. Now one
  pass, one object, same key order.
- The request list `await`ed two settlement functions per row that are no-ops for
  almost every row. An `await` on a function that immediately returns its
  argument still costs a promise and a microtask turn — 2N turns to do no work.
  It now screens with the settlers' **own** synchronous guards, exported from the
  settlers themselves so the screen cannot drift from the rule it screens for.
- `corsOrigins()` re-split, re-trimmed and re-filtered the environment variable on
  every request, inside the CORS origin callback that runs before anything else.
  Memoized on the raw string, so a deploy can still change it without a rebuild.
- `checkSubmitRateLimit` made three full passes over the project's entire request
  history with two intermediate arrays, to answer "have we hit a cap yet". One
  pass, two counters, early exit.
- `MemoryStore` rebuilt the key-sorted snapshot layout on every durable write —
  about a fifth of the write on a large store. Now cached and invalidated on
  structural change.

## Correctness bugs found while measuring

Two of these are not performance issues at all. They were found because
profiling forced a careful read of code that had not been read carefully.

### A date-triggered false "audit chain broken"

The chain reader walks month partitions backward from now, and stepped back with
`d.setUTCMonth(d.getUTCMonth() - 1)`. On 31 March that asks for 31 February,
which JavaScript normalizes **forward** to 3 March — so the walk yielded March
twice, `readAuditChronological` accumulated that partition's entries twice, and
the duplicated block broke the `prevHash` linkage at the seam.

An intact chain then reported as **broken**. That is not cosmetic: the chain is
the evidence of record, so a broken verdict makes `/readyz` answer 503 (which
pulls the instance out of service) and `/admin/audit/export` report
`verified: false`. It fires on **15 days of 2026** — the 29th, 30th and 31st,
depending on the length of the preceding month — and on no other day.

The walk is now plain integer arithmetic on `(year, month)`, which cannot
overflow. `test/auditMonthWalk.test.ts` pins every day a month can end on and
fails against the old code.

### The audit reader bypassed the clock seam

It could not have been caught, because the reader called `new Date()` directly
instead of going through `clock.ts` like every other time-dependent path in this
codebase. The one-clock rule exists precisely so this is testable; the reader had
opted out, so no test could pin a date to try. It now reads `nowDate()`.

### A raw NUL byte in the source

`memoryStore.ts` used a literal NUL control byte as its composite-key separator,
which made the file `data` rather than text to git, grep and editors — it did not
appear in content searches at all.

NUL is the *right* separator: it is the one character that cannot appear in a PK
or SK, so a printable one would let `{PK:'A B', SK:'C'}` and `{PK:'A', SK:'B C'}`
collide on the same composite key and silently overwrite each other. The value is
unchanged; it is now written as a `\u0000` escape, so one well-meaning "strip the
weird character" edit cannot reintroduce the collision.

## Deliberate trade-offs

**Incremental chain verification.** `verifyProjectChain` verifies the whole chain
on the first probe of a process, then re-hashes only entries appended since. It
is sound because the first pass catches what actually matters — a corrupt,
truncated or half-restored snapshot is a property of what was loaded at boot, and
it is caught before serving — and because the chain is append-only through this
process afterwards. The memo is per-**store** (a `WeakMap`, not a module global,
so two stores in one process cannot read each other's verdict) and is only used
if the anchor entry still re-hashes **from its content** to the remembered value.
Trusting its stored `hash` field would let a content rewrite walk straight past,
which is exactly the shape tampering takes.

What it deliberately does **not** do is detect a rewrite deep inside an
already-verified prefix. That is what the evidence surfaces are for:
`GET /admin/audit/export` and `scripts/verify-audit-chain.ts` still verify every
entry every time, and `test/auditPaging.test.ts` pins that they catch a rewritten
prefix the memo path does not.

**Session slide granularity.** One minute of lag on `lastSeenAt`, in the
fail-closed direction, in exchange for removing ~99% of session writes. Tune with
`SLIDE_GRANULARITY_MS` in `src/auth/sessions.ts`.

**Full-snapshot durability.** Unchanged. `FileStore` still writes the entire
store on every (batched) mutation, with temp file + `fsync` + atomic rename, so a
`kill -9` at any instant leaves either the prior complete snapshot or the new
one, never a torn file. Write latency is therefore O(store size): ~126 ms at
16,000 items / 5.9 MiB, of which ~49% is `JSON.stringify`, ~19% the disk write
and ~12% the `fsync`. Batching means that cost is paid once per burst rather than
once per writer. Moving to an append-only log or the DynamoDB backend the
`ConfigStore` seam was designed for is the next step if single-write latency ever
becomes the constraint — it was not worth changing the durability model of a
governance database for a number that concurrency already fixes.

## The store seam

`ConfigStore.query` and `queryGSI1` gained the DynamoDB `Query` parameters the
paged readers needed, spelled the way DynamoDB spells them:

- `limit` — DynamoDB `Limit`
- `forward` — DynamoDB `ScanIndexForward`
- `after` — `ExclusiveStartKey`, reduced to the one component that varies within
  a partition

All three are optional and default to the previous behaviour, so every existing
call site is untouched. Modelling them here rather than faking pagination above
the seam keeps it honest: the local store cannot make a read look cheap that the
real table would charge for.
