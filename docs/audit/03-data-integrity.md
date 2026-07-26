# Data Integrity & Persistence Audit — ccp/api store layer

Audit date: unknown-date
Dimension key: `data-integrity` · Finding prefix: `DATA`

## Scope & method

Read in full: `ccp/api/src/store/fileStore.ts`, `memoryStore.ts`, `configStore.ts`,
`schema.ts` (1,418 lines), `planSummarySchema.ts`, `snapshot.ts`,
`fileStore-failclosed.test.ts`; the store consumers that define persistence semantics:
`src/domain/audit.ts`, `auditQuery.ts`, `readiness.ts`, `dualControl.ts`, `settlement.ts`,
`cooling.ts`, `projectData.ts`, `drift.ts` (disk-write section), `driftProposals.ts`
(disk-write section); `src/auth/sessions.ts`; `src/routes/requests.ts` (submit, approve,
reject, link-pr, plan-summary, bundle, cancel/rewindow write paths), `routes/auth.ts`
(login write path), `routes/projectData.ts` (upload/activate), `routes/migrate.ts`,
`routes/admin.ts` (config-change ack/reject wiring); `src/server.ts`, `src/deploy.ts`,
`src/clock.ts`, `src/middleware/rateLimit.ts`; scripts `backup.ts`, `restore.ts`,
`verify-audit-chain.ts`, `restart-survival.ts`; tests `test/store.test.ts`,
`test/fileStore.test.ts`, `test/backupRestore.test.ts`; `ccp/docker-compose.yml` for the
deployment shape. Ran a Node repro to verify the `setUTCMonth` month-walk defect
(DATA-2). No files other than this report were created or modified.

## Architecture summary (as found)

`MemoryStore` (`src/store/memoryStore.ts`) is a `Map`-backed store that mirrors DynamoDB
single-table semantics (PK/SK, one GSI, conditional puts, all-or-nothing `transact`).
`FileStore` (`src/store/fileStore.ts`) **extends** `MemoryStore`: the Map remains the
read source of truth and after every applied mutation the FULL state is serialized and
written to one JSON file via temp-file + `fsync` + atomic `rename`, on a serialized
write chain that each mutator awaits (callers therefore await real durability before an
HTTP response is sent). The audit trail is a per-project hash chain whose head is
advanced by a compare-and-swap inside the same `transact` as the entry put
(`domain/audit.ts:153-233`). Large artifacts (project data versions, drift reports,
drift proposal bodies) live on disk beside the store file, referenced by store rows.

## Strengths

- **Atomic snapshot writes done right at the core.** `FileStore.writeAtomic`
  (`fileStore.ts:87-99`) writes to a uniquely named temp file (`pid` + 6 random bytes),
  `fsync`s the file data, closes, then `rename`s — a reader or a crash sees the old or
  the new complete file, never a torn one. `snapshot.ts:95-106` reuses the same
  discipline for backup/restore.
- **Ordered, awaited durability.** `persist()` (`fileStore.ts:79-85`) captures the JSON
  synchronously and enqueues it on a serialized chain; each mutator `await`s its own
  write, so a 2xx response implies the mutation reached disk. The chain survives a
  rejected write (`fileStore.ts:83`) without stalling later writes.
- **Fail-closed boot on suspicious files.** A present-but-empty/whitespace store file
  refuses to boot rather than silently starting empty (`fileStore.ts:47-56`), with a
  dedicated regression suite (`fileStore-failclosed.test.ts`). The bootstrap path
  additionally refuses to re-provision when the data file exists at all
  (`server.ts:74-80`), and `CCP_STORE=memory` is refused in production
  (`deploy.ts:129-133`).
- **Single source of store semantics.** Because `FileStore extends MemoryStore`, reads,
  conditional writes, and transactional behavior are literally the same code in tests
  and in production — tests against one genuinely validate the other for everything
  except the persistence layer itself, which has its own durability suite
  (`test/fileStore.test.ts`) including "failed `ifNotExists` persists nothing across a
  restart" and "failed transact leaves the prior snapshot intact".
- **DynamoDB-faithful conditional semantics, deliberately hardened.**
  `MemoryStore.transact` validates every condition against the pre-transaction snapshot
  before applying anything (`memoryStore.ts:63-95`), and an `ifEquals` against a
  *missing* item fails closed (`memoryStore.ts:76`) — with a comment naming the ghost-
  resurrection bug this prevents. `get`/`query` clone in and out, so callers can never
  alias internal state (proven in `test/store.test.ts:169-178`).
- **Tamper-evident audit chain with contention control.** Entries are hash-chained and
  appended in the same `transact` as a CAS on the `CHAINHEAD` row (`audit.ts:159-169`),
  using a monotonic ULID factory so SK order equals creation order (`audit.ts:34-37`).
  One canonical `verifyChain` serves the admin export, `/readyz`, the offline CLI, and
  restore, so verdicts cannot diverge by implementation.
- **Verified backup/restore with a refusal gate.** `scripts/backup.ts` parses and
  chain-verifies before copying; `scripts/restore.ts` refuses to install a snapshot
  whose chain does not verify unless `--force` is passed, and installs atomically
  (`restore.ts:48-59`). Round-trip is tested (`test/backupRestore.test.ts`).
- **A real crash test.** `scripts/restart-survival.ts` drives a real server over HTTP,
  `kill -9`s the process group, restarts against the same file, and asserts accounts,
  TOTP, requests, approvals, settings, and the verifying chain all survive.
- **Idempotent submit.** The idempotency marker is written `ifNotExists` in the same
  transact as the request row (`routes/requests.ts:472-503`), scoped to
  (project, requester, key) (`schema.ts:1365-1374`), and the loss path re-resolves the
  winner's request rather than erroring.
- **Readiness that "does not lie".** `/readyz` probes account count and re-verifies
  every project chain (`domain/readiness.ts`), so a wiped or corrupted store reads 503
  rather than green.
- **Exceptionally documented migration invariants.** `schema.ts` documents, per field,
  whether it is additive-optional, which read-time shim canonicalizes legacy shapes
  (`rolesOf`, `totpDevicesOf`, `repoRefOf` at `schema.ts:751-759`), and the
  producer/consumer ordering contract for `.strict()` schemas
  (`schema.ts:632-639`). The one-time settlement migration is idempotent, marker-
  guarded, written last, and fail-closed on unconfigurable stores
  (`domain/settlement.ts:188-219`).

## Findings

### DATA-1 · HIGH — Request-row writes lack optimistic concurrency: concurrent approvals/rejections silently lose updates and can corrupt the quorum ledger

- **Location:** `ccp/api/src/routes/requests.ts:693` (approve), `:746` (reject), `:812`
  (link-pr), `:874` (plan-summary); retry loop `:688-706`.
- **Description:** Approve, reject, link-pr, and plan-summary each read the
  `RequestItem`, build a full replacement row in memory, and write it back with an
  **unguarded** `{ kind: 'put', item: updated }`. There is no `ifEquals` on the request
  row (contrast: cancel at `:1018`, rewindow at `:1127`, the bundle claim at `:914`,
  and `settleCooling` at `domain/cooling.ts:67` all correctly CAS on `status`). The
  approvals quorum itself is stored as an embedded array on this row (`approvals`,
  `events`), while the per-approver dedupe is a *separate* `ApprovalItem` row put
  `ifNotExists`.
- **Failure scenario (verified by code walk):** approvers A and B act on the same
  2-signature request concurrently. Both read `approvals: []`. A commits: `ApprovalItem`
  A + row with `approvals: [A]` + chain head advanced. B's transact then either
  (a) succeeds directly — B's `ApprovalItem` is a different SK so `ifNotExists` passes,
  and B's stale row (`approvals: [B]`) **overwrites** A's — or (b) hits chain-head
  contention, in which case the retry loop at `:688-706` re-reads **only the chain
  head**, replays the stale domain writes, and commits the overwrite deterministically.
  Result: two `ApprovalItem` rows exist, the authoritative row says 1/2, A is
  permanently refused by the `ALREADY_APPROVED` dedupe (`:610`) while A's signature is
  not counted — the request can strand. An approve/reject race similarly lets a
  full-quorum `APPLIED` row be overwritten to `REJECTED` (or vice versa) because reject
  (`:746`) also writes the whole stale row. The audit chain records both actions, so the
  evidence and the authoritative state diverge. The same unguarded read-modify-write
  pattern exists on the account row in the login path
  (`routes/auth.ts:109-116, 135-138` — concurrent failed logins can lose
  `failedAttempts` increments, and a login-success put can clobber a concurrent admin
  change to the same account row).
- **Impact:** Corruption of the approvals/status ledger — the system's core record —
  under the most natural concurrency this product invites (two seniors working the same
  pending request). Borderline critical; rated high because the race window is a few
  awaited microtasks within a single Node process.
- **Recommendation:** Give `RequestItem` a monotonic `version` (or CAS on
  `updatedAt`/`status` + `approvals.length`) and make every request mutation a guarded
  `update` whose retry path re-reads the *row*, not just the chain head, and re-derives
  the mutation (the codebase already has this shape in `settleCooling`). Alternatively
  derive quorum from the `ApprovalItem` rows (already transactional) instead of the
  embedded array.

### DATA-2 · HIGH — Audit month-walk duplicates the current month at month ends: audit export corrupts and `/readyz` goes red on ~7 days a year

- **Location:** `ccp/api/src/domain/auditQuery.ts:49-56` (specifically `:55`,
  `d.setUTCMonth(d.getUTCMonth() - 1)`).
- **Description:** `readAuditChronological` walks month partitions backward by mutating
  one `Date` with `setUTCMonth(m-1)`. When the current UTC day-of-month does not exist
  in the previous month, JavaScript normalizes forward: verified by repro —
  `2026-07-31 → setUTCMonth(5) → 2026-07-01` — so the **same month partition is queried
  and pushed twice**. This occurs on May 31, Jul 31, Oct 31, Dec 31, and Mar 29–31
  (crossing into February). The duplicated chunk breaks `verifyChain` (the repeated
  first entry's `prevHash` no longer matches), and the double-counted `collected` can
  terminate the walk before older months are gathered.
- **Impact:** On those calendar days, for any project with audit entries in the current
  month: `GET /admin/audit` serves duplicated entries; the audit **export** — the
  self-verifying evidence document — reports `chain broken` (a false tamper alarm, and
  the offline `verify-audit-chain` CLI run against such an export exits non-zero); and
  `domain/readiness.ts:50-52` marks every such chain unverified, flipping `/readyz` to
  503 — an orchestrated deployment takes itself out of rotation on a recurring
  schedule. This is "breaks under normal use," on a timer.
- **Recommendation:** Iterate year/month as integers (e.g. decrement a `(y, m)` pair or
  use `Date.UTC(y, m-1, 1)` anchored to day 1) instead of mutating a date that carries
  a day-of-month. Add a regression test with a frozen clock at `2026-07-31T10:00Z`.

### DATA-3 · HIGH — A failed disk persist is not rolled back from memory: served state diverges from disk, and "failed" writes silently commit later

- **Location:** `ccp/api/src/store/fileStore.ts:58-71` (mutators), `:79-85` (persist).
- **Description:** Each mutator applies to the in-memory Map first (`super.put(...)`)
  and then awaits `persist()`. If `writeAtomic` fails (ENOSPC, EACCES, EIO), the error
  correctly propagates to the caller (typically a 500) — but the Map still holds the
  mutation. Because every later snapshot serializes the *whole* Map, the "failed"
  mutation becomes durable as a side effect of the **next** successful persist by any
  other request; conversely, if the process dies before any later persist succeeds, the
  mutation vanishes while other requests may have already *read* it and acted on it.
- **Failure scenario:** Disk briefly full. Admin's account-disable returns 500; the
  admin retries or escalates. Meanwhile a session-slide write (see DATA-6) succeeds a
  minute later and durably commits the "failed" disable. Or: an approval returns 500,
  the client re-approves, and gets `ALREADY_APPROVED` because the failed write was
  live in memory the whole time. Under sustained ENOSPC, the server keeps mutating
  memory while every caller is told the operation failed — an arbitrary, invisible
  divergence between served state and the state a restart will resurrect.
- **Impact:** Response codes stop being truthful about durability; read-your-writes
  holds for data the store may lose; operations reported failed can materialize later.
- **Recommendation:** On persist failure, restore the pre-mutation state (capture the
  prior item(s) before apply and roll back the Map), or at minimum mark the store
  read-only/unhealthy (fail `/readyz`) after a persist failure until a snapshot
  succeeds, so divergence cannot compound silently.

### DATA-4 · HIGH — Full-file rewrite + fsync on every mutation, including a session write on every authenticated request, against a store that only ever grows

- **Location:** `ccp/api/src/auth/sessions.ts:83-85` (idle-window slide `put` on every
  `resolveSession`); `ccp/api/src/store/fileStore.ts:79-99` (full snapshot per write);
  no expiry/pruning of `SessionItem` (`ttl` at `schema.ts:246` is written but read by
  nothing) and no audit-chain retention anywhere.
- **Description:** Three compounding facts. (1) Every authenticated request — including
  every GET — slides `lastSeenAt` and calls `store.put`, which on `FileStore`
  serializes and fsyncs the **entire** database. (2) The store grows monotonically:
  every login success/failure/lockout appends an immutable `AuditItem`
  (`routes/auth.ts:117-129, 153, 166, 179`), and expired sessions (including abandoned
  5-minute TOTP pre-sessions minted on *every* login attempt) are never deleted —
  `resolveSession` returns `expired` without cleanup, and only explicit
  logout/revocation deletes rows. (3) `JSON.stringify` of the whole store runs on the
  event loop, and writes are strictly serialized, so sustained throughput is bounded by
  one full-file fsync per mutation.
- **Impact:** Per-request write amplification of O(total lifetime history). A year of
  moderate use (tens of MB of audit entries + orphaned session rows) means tens of MB
  serialized + written + fsynced per authenticated GET, with event-loop stalls, growing
  ENOSPC exposure (temp file + final file), and SSD wear. `/readyz` compounds it by
  re-reading and re-hashing every chain on each probe. This degrades progressively and
  will bite production long before "the governance DB is small" stops being true.
- **Recommendation:** Debounce/coalesce the session-slide write (e.g. only persist a
  slide when >N seconds newer, or hold sessions in a separate small file); sweep
  expired sessions and pre-sessions; collapse the write chain to the latest snapshot
  when multiple are queued; and define audit retention/archival (month partitions are
  already the natural unit) or move cold months out of the hot file.

### DATA-5 · MEDIUM — Store rows are not validated against the schemas on load: corrupt-but-parseable state is accepted silently

- **Location:** `ccp/api/src/store/fileStore.ts:55` (`JSON.parse(raw) as Item[]`);
  `memoryStore.ts:29-31` (`importItems` trusts `PK`/`SK`); 76 unchecked `as XItem`
  casts across 19 files at read sites (e.g. `auth/sessions.ts:67,72`,
  `routes/requests.ts:586`).
- **Description:** `schema.ts` defines an executable zod schema for every item shape,
  and `test/store.test.ts` proves they reject malformed fixtures — but nothing ever
  runs them against data read from the store. `FileStore.load` fails closed only on
  empty/whitespace and JSON syntax errors; any *parseable* corruption (hand-edit, bad
  restore, partial write by a different tool, rows from a newer/older version with
  violated invariants, items missing `PK`/`SK` — which silently key as
  `"undefined undefined"`) loads and flows through unchecked casts into auth and domain
  logic. A non-array top-level JSON value fails only with an incidental
  `items.map is not a function` TypeError — `snapshot.ts:25-32` has the proper
  array-shape check (`parseSnapshotItems`) but `FileStore.load` does not reuse it.
  `restore.ts` likewise verifies the audit chain but not item shapes.
- **Impact:** The "bad data fails closed" property holds only for the two crudest
  corruption classes. Everything subtler is undefined behavior at read time (`NaN`
  lockout math, `undefined` role lookups, crashes deep in handlers) rather than a
  refused boot naming the bad row.
- **Recommendation:** Reuse `parseSnapshotItems` in `FileStore.load`; validate at least
  `PK`/`SK` string-ness per item at import; optionally add a boot-time (or
  `--validate`) pass that runs each row through its schema keyed off the PK/SK shape
  and refuses (or quarantines) violations with row-level diagnostics.

### DATA-6 · MEDIUM — `rename` durability is not guaranteed: no directory fsync after the atomic swap

- **Location:** `ccp/api/src/store/fileStore.ts:98`; `ccp/api/src/store/snapshot.ts:105`.
- **Description:** `writeAtomic` fsyncs the temp file's *data* but never fsyncs the
  parent **directory** after `rename`. On POSIX filesystems the rename is a directory
  operation; without a directory fsync, a power failure shortly after a successful
  `await rename(...)` may leave the *old* file in place after recovery. Atomicity
  (old-or-new, never torn) still holds — durability of the acknowledged write does not.
- **Impact:** A caller that received a 2xx (the code carefully awaits "real
  durability", `fileStore.ts:73-78`) can find that write rolled back after a host power
  loss. For this system that can mean an approval or audit entry acknowledged to a human
  disappearing — with the audit chain simply shorter, undetectably.
- **Recommendation:** After `rename`, open the parent directory and `fsync` its handle
  (both in `fileStore.writeAtomic` and `snapshot.writeFileAtomic`). The project-data /
  drift disk writers (`domain/projectData.ts:317-342`, `domain/drift.ts:574-586`,
  `domain/driftProposals.ts:681-693`) fsync nothing at all before rename; they are
  digest-checked or schema-checked on read, but the same cheap hardening applies.

### DATA-7 · MEDIUM — The 72-hour dual-control expiry is unenforced: `sweepExpired` is dead code and `ackPending` never checks `expiresAt`

- **Location:** `ccp/api/src/domain/dualControl.ts:240-268` (ack — no expiry check),
  `:347-358` (`sweepExpired` — defined, exported, called from no production path;
  verified by repo-wide grep).
- **Description:** Every pending loosening change is stamped
  `expiresAt = now + 72h` (`dualControl.ts:216`) and the schema documents an `EXPIRED`
  status (`schema.ts:519`). But no route or background task calls `sweepExpired`, and
  `ackPending` validates only `status === 'PENDING'`, `!self`, and the drift guard —
  never the clock. A stale proposal (e.g. a senior-role grant or password reset with a
  pre-hashed credential in `apply`) remains ackable weeks later, guarded only by
  `accountVersion` drift where the target happened to change in between.
- **Impact:** The documented 72h containment window for two-person changes is fiction;
  `EXPIRED` is an unreachable state in production data.
- **Recommendation:** Check `Date.parse(pending.expiresAt) < nowMs()` inside
  `ackPending` (fail with `STATE_CONFLICT`/`EXPIRED`), and call `sweepExpired` from
  `GET /admin/config-changes` (it already loads the same GSI partition).

### DATA-8 · MEDIUM — Pending-change status transitions have no CAS: concurrent ack + reject can apply a change and record it as REJECTED

- **Location:** `ccp/api/src/domain/dualControl.ts:274` (ack's status update — no
  `ifEquals`), `:340` (reject's — no `ifEquals`), `:353` (`sweepExpired`'s unconditional
  `put`).
- **Description:** `ackPending` and `rejectPending` both read the pending row, verify
  `status === 'PENDING'` in memory, and then write the status transition with an
  *unconditional* update. Interleaving A-ack / B-reject (both reads before either
  write): A's transact applies the change and sets `APPLIED`; B's transact then sets
  `REJECTED` — both succeed. The store now says the change was rejected while its
  effect is live (the audit chain shows `config-apply` then `config-reject`, so
  forensics can untangle it, but the record of decision is wrong). Two concurrent acks
  likewise both replay `applyToWrite(apply)` when the spec carries no guard.
  `sweepExpired`'s unconditional `put` of a stale row could similarly overwrite a
  just-landed ack with `EXPIRED` (currently moot per DATA-7).
- **Impact:** The dual-control record — precisely the thing two-person integrity exists
  to keep truthful — can disagree with the applied state.
- **Recommendation:** Add `ifEquals: { attr: 'status', value: 'PENDING' }` to the
  pending-row update inside both ack and reject transacts (and to the sweep), mapping a
  condition failure to `STATE_CONFLICT`.

### DATA-9 · MEDIUM — No single-writer guard: restore can be silently clobbered by a running server; nothing prevents two processes on one file

- **Location:** `ccp/api/scripts/restore.ts:59` (writes the live data file with no
  running-server check); `ccp/api/src/store/fileStore.ts` (no lock file / advisory
  lock anywhere).
- **Description:** `FileStore` holds the entire store in memory and rewrites the file
  from memory on every mutation. A restore executed while the server runs installs the
  backup atomically — and then the server's very next persist (e.g. a session slide
  triggered by any authenticated request) rewrites the file from its in-memory state,
  silently discarding the restore with no error anywhere. More generally, nothing
  (lock file, O_EXCL pid file, flock) stops a second api process — an operator's
  `npm run dev` against the production `CCP_DATA_DIR`, or a scaled compose service —
  from opening the same file; the two last-writer-wins each other wholesale.
- **Impact:** A documented disaster-recovery procedure that quietly does nothing is a
  data-loss trap in exactly the situation (an incident) where the operator is least
  able to notice; dual-process operation corrupts by snapshot ping-pong.
- **Recommendation:** Take an exclusive advisory lock (or pid/lock file with liveness
  check) on open in `FileStore.open`, held for the process lifetime; make `restore.ts`
  refuse when the lock is held. Document "stop the api before restore" in the script's
  usage text either way.

### DATA-10 · MEDIUM — Backup/restore covers only the store JSON; the on-disk project-data/drift root it references is out of scope, with no consistency check

- **Location:** `ccp/api/scripts/backup.ts:34-42` (copies only `dataFile`);
  `src/domain/projectData.ts:300-307` (content root `<CCP_DATA_DIR>/projects` "beside
  the FileStore's ccp.json, never inside it"); referencing rows:
  `ProjectDataVersionItem.chunks`/`digests` (`schema.ts:975-1006`),
  `ProjectItem.dataActive` (`schema.ts:852-859`), `DriftReportItem`/`DriftProposalItem`
  (`schema.ts:1105-1216`).
- **Description:** The durable state spans two stores: the snapshot file and a directory
  tree of immutable version dirs, drift reports, and proposal bodies that store rows
  point into. `backup.ts` captures only the former. A restore therefore reconstructs
  rows (`dataActive`, version metadata, drift pointers) whose files may be gone or from
  a different point in time; nothing at boot or in `/readyz` cross-checks that the
  active version's files exist or match their recorded digests. Serves fail closed to
  404/`report:null` (`projectData.ts:366-395`, `drift.ts:588-596`), so this degrades
  rather than corrupts — but silently, behind a green readiness probe.
- **Impact:** After a disk-death restore, "ready" projects can serve nothing (or stale
  content restored from a different backup generation) with no operator signal; the
  recorded go-live digests (`ProjectArtifacts`) attest content that is no longer
  present.
- **Recommendation:** Extend backup/restore to include the projects root (or document
  loudly that it must be captured together), and add a boot-time / readiness
  cross-check: for each `dataActive` and drift pointer, stat the files and (cheaply)
  compare digests, reporting mismatches in `/readyz` reasons.

### DATA-11 · MEDIUM — v1 migration writes rows that violate the store schemas, including an `id`≠`username` shape that breaks session resolution

- **Location:** `ccp/api/src/routes/migrate.ts:68-95` (accounts), `:103-105` (policy).
- **Description:** The v1 import validates against v1 shapes only and writes store rows
  by cast, never through the store schemas. Concretely: (1) `V1Policy` is unbounded
  `z.number()` (`migrate.ts:36`) while `PolicyItem` requires ints 1..5
  (`schema.ts:294-306`) — a v1 doc with `high: 0` or `7.5` lands verbatim and drives
  `approvalsRequired` math out of contract. (2) `V1Account.username` has no character
  constraints (`migrate.ts:22`), unlike enroll's `^[a-z0-9._-]{2,32}$`
  (`routes/admin.ts:43`), so arbitrary bytes reach `accountKey` PKs (see also DATA-15).
  (3) The import preserves v1 `id` while keying the row by `username`
  (`migrate.ts:70-71`); the runtime invariant everywhere else is `id === username`
  (enroll sets `id: username`, `routes/admin.ts:340`; sessions store
  `userId = account.id` and resolve via `accountKey(session.userId)`,
  `auth/sessions.ts:69`). An imported account with `id !== username` can pass login
  (looked up by username) but every session it mints resolves to a nonexistent
  `ACCOUNT#<id>` row → `invalid` — the account can authenticate yet never hold a
  session.
- **Impact:** A migration designed for exactly one moment (first adoption) can plant
  schema-violating rows and permanently un-loginable accounts, discovered only in
  production use.
- **Recommendation:** Parse each constructed row through its store schema
  (`AccountItem.parse`, `PolicyItem.parse`) before `put`; normalize/enforce
  `id = username` (or reject mismatches loudly); clamp/validate policy bounds.

### DATA-12 · LOW — Crash between the version-row transact and the file write leaves an activatable orphan row in the upload lane

- **Location:** `ccp/api/src/routes/projectData.ts:297-324` (row-first allocation,
  compensating delete on file-write *failure* only), `:358-360` (activate checks only
  row existence).
- **Description:** The upload lane commits the audited version row first, then writes
  the files, deleting the row if the write *throws*. A process crash between the two
  (or between failure and the compensating delete) leaves a durable, listed version row
  with no files — and `POST /:id/data/:version/activate` verifies only that the row
  exists, so two admins can activate it; the `dataActive` pointer then serves 404s.
  The recorded audit entry claims a successful upload either way.
- **Impact:** Fail-closed at serve time, but an inconsistent registry (phantom staged
  versions) that humans can promote; low blast radius given the dual-control step.
- **Recommendation:** At activate, stat the version directory (or verify digests)
  before accepting; optionally sweep row-without-files orphans at boot.

### DATA-13 · LOW — Failed atomic writes leak temp files in the store path

- **Location:** `ccp/api/src/store/fileStore.ts:90-98`; `snapshot.ts:97-105`.
- **Description:** If `writeFile`/`sync` throws (the ENOSPC case), the temp file is
  left behind — there is no unlink in the failure path and no startup sweep of
  `*.tmp-*`. Under repeated ENOSPC each attempt can strand another partial multi-MB
  snapshot, worsening the very condition that caused the failure. (The
  drift/projectData writers *do* clean up their temp artifacts on failure —
  `drift.ts:582-585`, `driftProposals.ts:689-692`, `projectData.ts:338-341`.)
- **Recommendation:** `rm` the temp path in a catch/finally, and sweep stale
  `<file>.tmp-*` on `FileStore.open`.

### DATA-14 · LOW — Seam-fidelity gaps between MemoryStore and the promised DynamoDB semantics

- **Location:** `ccp/api/src/store/memoryStore.ts:63-95`; conventions at
  `domain/settlement.ts:174`, `domain/dualControl.ts:274`; `memoryStore.ts:52-57`.
- **Description:** The seam's stated goal is byte-identical semantics with a future
  DynamoDB backend (`configStore.ts:1-8`), but several behaviors the codebase now
  relies on are not expressible or differ there: (1) `transact` permits multiple writes
  to the same key (DynamoDB `TransactWriteItems` rejects that) and has no 100-item
  bound; (2) `ifEquals: { value: undefined }` is used to mean "attribute absent"
  (settlement's roles guard) — not a plain equality `ConditionExpression`; (3)
  `set: { GSI1PK: undefined }` is the idiom for index removal (a DynamoDB `SET` cannot
  take undefined — it needs `REMOVE`); (4) `queryGSI1` returns items lacking `GSI1SK`
  (sorted by SK fallback), whereas a composite-key GSI omits them entirely. Tests
  passing against MemoryStore therefore do not validate these behaviors for the future
  backend.
- **Recommendation:** Either encode these conventions explicitly in the `ConfigStore`
  contract (e.g. `ifAbsent`, `removeAttrs`) so a DynamoDB adapter must implement them,
  or tighten MemoryStore to reject what DynamoDB rejects.

### DATA-15 · LOW — Map key concatenation with a space separator is aliasable in principle; client-controlled bytes reach PKs unconstrained

- **Location:** `ccp/api/src/store/memoryStore.ts:4-5` (`keyOf = pk + ' ' + sk`);
  `schema.ts:1368-1374` + `routes/requests.ts:95` (idempotency key: any 1–200 chars,
  including spaces and `#`, concatenated into a PK); `migrate.ts:22` (unconstrained
  imported usernames).
- **Description:** `get`/`put`/`delete` identity is the string `PK + ' ' + SK`, so two
  distinct (PK, SK) pairs alias whenever `PK1 + ' ' + SK1 === PK2 + ' ' + SK2`. With
  today's SK vocabulary (no SK contains a space) no collision is constructible, but
  nothing enforces that invariant, and the idempotency-key PK embeds arbitrary client
  bytes. DynamoDB keys are native tuples — it would never alias — so this is also a
  seam divergence.
- **Recommendation:** Use a non-printable separator (`' '`) or a tuple-keyed
  nested map; constrain `idempotencyKey` to a safe charset at the schema.

### DATA-16 · LOW — No format/version marker in the snapshot file; migration rests entirely on convention

- **Location:** `ccp/api/src/store/fileStore.ts:80` (bare JSON array on disk);
  `schema.ts` throughout (additive-optional discipline).
- **Description:** The on-disk snapshot is a bare item array with no schema-version or
  producer stamp. The migration story — additive optional fields plus read-time shims,
  with unknown fields surviving load→export because items are opaque records — is real
  and unusually well documented, and old-binary/new-file round-trips preserve unknown
  fields. But there is no way for an older binary to *detect* a file whose invariants
  it predates (it will read and rewrite it blind), and no place to hang a future
  breaking migration.
- **Recommendation:** Wrap the array in `{ formatVersion: 1, items: [...] }` (loading
  the bare-array legacy shape transparently), and fail closed on a `formatVersion`
  above the binary's known max.

### DATA-17 · LOW — Calendar-dependent test: the FileStore audit-durability test hardcodes month `202607`

- **Location:** `ccp/api/test/fileStore.test.ts:115`.
- **Description:** `record()` writes audit entries under the *current* UTC month
  partition, but the test reads back `P#sample#AUDIT#202607`. It passes only while the
  wall clock says July 2026; from 2026-08-01 the query returns 0 entries and the
  restart-durability assertion fails.
- **Recommendation:** Build the PK with `yyyymm()` (or freeze the clock via
  `__setNow`).

## Minor observations

- **Monotonic-ULID restart edge:** the audit chain's ordering guarantee relies on a
  per-process monotonic factory (`audit.ts:37`); a restart within the same millisecond
  as the last pre-crash entry could in principle mint a ULID that sorts earlier,
  breaking SK-order == creation-order. Probability negligible; noted for completeness.
- **`FileStore`'s constructor is public** (`fileStore.ts:27`): `new FileStore(f)`
  without `load()` silently starts empty and will overwrite the existing file on the
  first mutation. Only `FileStore.open` is used today; a private constructor would
  remove the footgun.
- **`persist()`'s comment overstates synchrony** (`fileStore.ts:19-21`, `:74`): the
  snapshot is captured after the `await super.put(...)` microtask boundary, not
  literally "right after the synchronous Map apply". Harmless today (any Map snapshot
  is transaction-consistent because `transact` applies synchronously), but the
  invariant deserves stating precisely since correctness depends on "no awaits inside
  apply".
- **`killAllSessions`/`killOtherSessions` delete row-by-row** (`sessions.ts:89-127`),
  each triggering a full snapshot write; a crash mid-loop leaves a partial revocation
  (self-healing on retry, but N fsyncs where one transact would do).
- **`RequestEventItem`/`eventKey` appear vestigial** (`schema.ts:480-488`, `:1382-1387`):
  events are stored as an embedded array on `RequestItem`; the standalone event-row
  shape is used only by test fixtures. Dead schema invites divergence.
- **Load errors lack file context:** a JSON syntax error from `FileStore.load`
  surfaces as a bare `SyntaxError` without naming the store file (contrast the
  excellent empty-file message at `fileStore.ts:51-53`).
- **`/readyz` re-verifies every chain from a full month-walk per probe**
  (`readiness.ts:49-53`) — O(history) reads per health check; fine now, couples to
  DATA-4's growth curve.
- **Two homes for store tests** (`src/store/fileStore-failclosed.test.ts` vs
  `test/fileStore.test.ts`, `test/store.test.ts`) — cosmetic.

## Overall grade: C

The core persistence mechanics are genuinely well engineered — atomic temp+fsync+rename
snapshots, awaited durability, fail-closed boot on suspicious files, a DynamoDB-faithful
transactional seam shared verbatim between the test and durable stores, a hash-chained
audit log with CAS-protected heads, verified backup/restore, and a real kill-9 restart
proof. But the layer above the seam undermines that foundation with four high-severity
defects: unguarded read-modify-write on the request row that can corrupt the approvals
ledger under the product's most natural concurrency (DATA-1); a verified calendar bug
that duplicates audit partitions, falsifies the evidence export, and flips `/readyz`
red on ~7 days a year (DATA-2); no memory rollback on persist failure, so responses stop
being truthful about durability (DATA-3); and unbounded full-file write amplification on
every authenticated request (DATA-4). Add the unenforced dual-control expiry, the
schema layer that is never applied at the persistence boundary, and the restore-under-
live-server trap, and the dimension sits at "strong bones, several production-likely
integrity defects" — a C.
