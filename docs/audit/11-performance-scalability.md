# Performance & Scalability Audit — cloud-control-plane

Audit date: 2026-07-26
Dimension: Performance & scalability (`performance`)
Auditor: engineering-audit fleet, performance dimension

---

## Scope & method

Read in full or in targeted depth:

- **Store layer**: `ccp/api/src/store/fileStore.ts`, `store/memoryStore.ts`, `store/schema.ts` (keys, TTL attrs), `store/planSummarySchema.ts`
- **Auth/session hot path**: `ccp/api/src/auth/sessions.ts`, `auth/credentials.ts`, `middleware/session.ts`, `middleware/rateLimit.ts`, `routes/auth.ts` (lockout path)
- **Request pipeline**: `routes/requests.ts` (submit/list/approve/apply/cancel/rewindow), `domain/audit.ts`, `domain/auditQuery.ts`, `domain/cooling.ts`, `domain/schedule.ts` (`settleWindow`), `domain/config.ts`, `domain/feasibility.ts`, `domain/eligibility.ts`, `domain/settlement.ts`, `projects.ts`
- **Effect lanes**: `domain/bundle.ts`, `domain/driftProposals.ts` (§6.3 runner), `domain/driftCheck.ts`, `domain/apply/scheduler.ts`, `domain/apply/loop.ts`, `domain/apply/terraformExecutor.ts`
- **Data plane**: `domain/projectData.ts`, `routes/projectData.ts`, `domain/drift.ts`, `routes/drift.ts` (caps + serve paths), `routes/admin.ts` (audit endpoints), `domain/readiness.ts`, `index.ts`, `server.ts`
- **Frontend**: `ccp/app/vite.config.ts`, `src/main.tsx`, `src/router.tsx`, `src/lib/api.ts`, `src/lib/httpApi.ts`, `src/lib/blockSource.ts`, `src/lib/useStore.ts`, `src/lib/ProjectContext.tsx`, `src/lib/interpreter.ts` (`resolveEnum`), `src/lib/resourceFamily.ts`, `src/data/manifests/index.ts`, `src/features/services/ServiceConsole.tsx` + `VirtualRows.tsx`, `src/components/SchemaForm/SchemaForm.tsx`, `src/features/requests/MyRequests.tsx`, `src/features/dashboard/LeadDashboard.tsx`
- **Ran**: `npx vite build` in `ccp/app` to obtain real bundle sizes; measured `src/data/` on disk (7.5 MB, of which `manifests/` is 3.9 MB across 115 JSON files); inspected the emitted chunks' contents (`riskFloor` ×1642, `enumSource` ×1720, `aws_` ×5258 occurrences in the main chunk) to confirm what is inlined.

Method: every claim below is anchored to code actually read. Ceiling estimates are derived from the code's own constants (e.g. `MAX_RESOURCES = 50_000`, `MAX_UPLOAD_BYTES = 16 MiB`, spawn timeouts of 5/10/15 minutes) and standard cost models (fsync latency, sha256 throughput, zod parse throughput), stated as estimates where they are estimates.

Out of scope per the audit brief: security. `tools/catalogctl` and `importer/` run in CI/CLI contexts, off the serving hot path, and were only skimmed; nothing there gates a user-facing request.

---

## Strengths

The codebase shows real, deliberate performance thinking in several places — worth naming precisely because the findings below are about the places that thinking did not reach:

1. **Estate-sized data is kept out of the governance store by design.** `domain/projectData.ts:9-31` explicitly stages inventory/blocks/manifests on disk under `<dataRoot>/<projectId>/v<N>/`, with the store holding only metadata + digests ("the FILES deliberately live outside the FileStore JSON (they are estate-sized, and the governance DB stays small)"). This is the single most important scalability decision in the backend and it was made correctly.
2. **Explicit input caps everywhere.** Uploads: 16 MiB / 50k resources / 100k index entries / 2k chunks (`domain/projectData.ts:36-42`); drift envelopes: 4 MiB (`domain/drift.ts:40`); submits: 256 KiB body, 100 change-set items (`routes/requests.ts:49-55`); plan summaries: 400 resource changes × 80 attr changes with value-length caps (`store/planSummarySchema.ts:22-26`). Nothing user-supplied is unbounded on ingest.
3. **Drift report retention exists** (`domain/drift.ts:45-53`, `driftKeep`, default 90 versions) — one of the few stored collections that is actually pruned.
4. **The upload-lane rate limiter is bounded and self-evicting** (`middleware/rateLimit.ts:64-109`): 10k-bucket cap, idle-bucket sweep, coldest-tenth eviction — a correctly engineered in-memory guard in front of the argon2id verify.
5. **Frontend virtualization is real where it matters most.** `features/services/VirtualRows.tsx` windows expanded resource groups via `@tanstack/react-virtual` above a 40-row threshold (`ServiceConsole.tsx:52`), with measured row heights and a single shared action-picker instance lifted out of the rows (`ServiceConsole.tsx:229-236`).
6. **Keystroke responsiveness on the big list is handled**: the console filter runs off `useDeferredValue` (`ServiceConsole.tsx:294-309`), so typing never blocks paint on the (documented ~1,300-resource) estate.
7. **Frontend state layer avoids re-render storms by construction.** `lib/useStore.ts` documents and implements `Object.is`-stable snapshots for every `useSyncExternalStore` source; `ProjectContext.tsx` memoizes the provider value on `projectId`. No polling timers exist outside one admin scan-status poll (`features/admin/ProjectsAdmin.tsx:683`).
8. **The admin subtree is code-split** (`router.tsx:32-46`) — nine lazy chunks, correctly identified as "largest, least-frequently visited."
9. **The real terraform executor spawns asynchronously** (`domain/apply/terraformExecutor.ts:91`, `promisify(execFile)`) — the one long-running effect in the timer-driven apply lane does *not* block the event loop, and the scheduler has both a claim-guard and a non-reentrancy guard (`domain/apply/loop.ts:111-114`).
10. **Block sources are chunked and lazily loaded with a per-project cache** (`lib/blockSource.ts:93-131`), and the server index is fetched once per project including remembered misses.

---

## Findings

### PERF-1 — Every authenticated request rewrites the entire database to disk (session-slide write × full-store snapshot)

- **Severity: critical**
- **Location**: `ccp/api/src/auth/sessions.ts:82-85` × `ccp/api/src/store/fileStore.ts:58-99` (trigger: `ccp/api/src/middleware/session.ts:58-71`)

Two individually defensible designs multiply into a per-request full-database fsync:

1. `resolveSession` slides the 30-minute idle window by writing the session row back on **every successful resolve**: `await store.put(slid)` (`sessions.ts:83-84`). `withSession` runs on every request (`index.ts:61`), so every authenticated call — including every plain `GET` — performs a store mutation before its handler runs.
2. `FileStore.put` → `persist()` (`fileStore.ts:58-61, 79-85`) snapshots the **whole store** on every mutation: `exportItems()` structured-clones every item and sorts all keys (`memoryStore.ts:24-26`, O(N log N) + O(N) clone), `JSON.stringify` serializes the entire store synchronously on the event loop, then `writeAtomic` writes the full file and `fsync`s it (`fileStore.ts:87-99`). The caller `await`s real durability (`fileStore.ts:60`), and writes are serialized on a single chain (`fileStore.ts:81-84`), so concurrent requests queue behind each other's full-file writes.

The store the snapshot covers is not small and is not bounded: it holds every request row (with its full `events` array, `params`, `planSummary`, and — when the scheduler lane is used — the full pinned plan text `pinnedDiff`, `store/schema.ts:434`), every audit-chain entry ever written (never pruned — see PERF-7), every session ever minted (never expired-swept — see PERF-7), all accounts, teams, settings, proposals rows.

**Concrete ceiling.** Per-request cost ≈ clone+sort+stringify+write+fsync of the whole store. Rough model (Node structuredClone+stringify ≈ 150-300 MB/s; SSD write+fsync ≈ 1-5 ms + transfer):

| Store contents (approx.) | Snapshot size | Added latency per authenticated request | Effective throughput (serialized) |
|---|---|---|---|
| Fresh install (~100 items) | ~100 KB | ~1-2 ms | fine |
| 1 year, small team: ~5k requests + ~30k audit entries | ~30-60 MB | ~150-400 ms | ~3-6 req/s **total** |
| Heavy use: ~20k requests (some with pinned plans) + 100k audit entries | 150+ MB | ~1-2 s | <1 req/s |

Because the SPA fires several parallel API calls per navigation (e.g. `RequestDetail` calls manifests+inventory+request), each of which slides the session, a single page view can enqueue 3-5 full-store snapshots. Memory is amplified too: each queued mutation holds its own complete snapshot string (`fileStore.ts:80-81`), so a burst of 10 concurrent requests against a 50 MB store transiently holds ~500 MB of JSON strings.

This degrades continuously under **normal** use (the store only ever grows — nothing that lands in it is deleted), which is why it is rated critical rather than high: a moderately active instance reaches unusable request latencies within its first year without any abnormal input.

**Recommendation** (in order of leverage):
1. Stop writing on the read path: slide `lastSeenAt` only when it has moved by a meaningful fraction of `IDLE_MS` (e.g. >60 s since last write). This alone removes ~99% of snapshot writes with zero semantic change (idle expiry precision drops from per-request to ±1 min).
2. Replace snapshot-per-mutation with an append-only journal + periodic compaction, or debounce/coalesce `persist()` (snapshot at most once per N ms, `await` only the coalesced write). The crash-safety argument (`fileStore.ts:8-22`) survives a coalesced snapshot as long as mutations still resolve after their covering snapshot lands.
3. Land the DynamoDB (or SQLite) backend the `ConfigStore` seam was built for before any multi-team deployment.

### PERF-2 — `spawnSync` on the serving thread: the API freezes for up to 10-15 minutes during bundle/drift work

- **Severity: high**
- **Location**: `ccp/api/src/domain/bundle.ts:112-125`, `ccp/api/src/domain/driftProposals.ts:810-847`, `ccp/api/src/domain/driftCheck.ts:49-61`

Three effect lanes shell out with **`spawnSync`**, which blocks the entire Node event loop — no other request, health probe, or timer runs while they execute:

1. **Apply bundle** (`POST /requests/:id/apply`, `routes/requests.ts:921-926` → `runBundle(realSteps(cfg), …)`): `git clone` (5-min timeout), the operator's gate command via `spawnSync('bash', ['-lc', cmd], { timeout: 15 * 60_000 })` (`bundle.ts:113-119`), commit, push, trigger — all synchronous, all inside the HTTP handler. A normal gate run (terraform init + plan) takes minutes; for that entire time the API serves **nothing** — every other user's request, `/healthz`, and `/readyz` stall, which under an orchestrator's liveness probe can get the process killed mid-bundle.
2. **Drift proposal generation** (`realDriftGenSteps`, `driftProposals.ts:814-841`): `git clone` (5-min timeout) + generator command (10-min timeout), both `spawnSync`. The route deliberately fire-and-forgets it (`scheduleDriftGeneration`, `driftProposals.ts:1044-1063`, "the CI upload never blocks on a git clone") — but the async wrapper is defeated by the synchronous spawn inside: the *caller's* response returns, then the event loop freezes for the full clone+generation anyway, stalling every request that arrives during it.
3. **Drift check trigger** (`realDriftCheckSteps`, `driftCheck.ts:52-58`, 5-min timeout), awaited inside the `POST .../drift/check` handler (`routes/drift.ts:1101`).

All three lanes are opt-in (`CCP_BUNDLE=1`, generator config, `CCP_DRIFT_CHECK_CMD`), which caps today's blast radius — but they are the product's headline flows, and any deployment that arms them gets a single-user system for minutes at a time.

**Recommendation**: switch all three to `child_process.spawn`/`execFile` with promises (the codebase already does this correctly in `terraformExecutor.ts:91,137`). The step-injection seams (`BundleSteps`, `DriftGenSteps`, `DriftCheckSteps`) make this a contained change: make the step methods async, keep the orchestration order. The existing one-in-flight guards (`bundle` state on the row, `genState`, `inFlightProjects`) already prevent concurrency once the calls stop blocking.

### PERF-3 — `GET /requests` has no pagination and ships full rows (events, params, plan summaries, pinned plan text), with an O(n) write-capable settle loop per call

- **Severity: high**
- **Location**: `ccp/api/src/routes/requests.ts:508-542` (list), `:184-195` (`toChangeRequest`)

The list endpoint:
1. Fetches **every** request in the project (`store.queryGSI1(requestCollectionGsi(projectId))`, line 520) — itself a full store scan with a structured clone per matching row (`memoryStore.ts:52-57`).
2. Runs a **sequential** `await settleCooling(...)` + `await settleWindow(...)` per row (line 526). For settled rows these are cheap early-return no-ops (`cooling.ts:42`, `schedule.ts:286-288`), but every row that *does* need settling performs a chain-head read + audited transact — on FileStore, a full-store snapshot each (PERF-1). After a weekend during which 50 windowed requests expired, the Monday-morning first `GET /requests` performs 50 sequential audited writes before responding — tens of seconds on a grown store. Two users loading the queue concurrently race those settles; a settle that loses twice throws `CHAIN_CONTENTION` (`schedule.ts:320-322`), turning a **read** into a 409 for one of them.
3. Serializes every row through `toChangeRequest`, which strips only `PK/SK/GSI*/requestUlid/eventSeq/riskOverrideVersion` (lines 185-192) and keeps everything else — the full `events` timeline, `params`, `items`, `planSummary` (up to 400×80 attr rows), and notably **`pinnedDiff`, the entire pinned terraform plan text** (`store/schema.ts:424-434`), for any request the scheduler lane ever planned. `scope=all` at 2,000 historical requests with even 10% carrying 50 KB plans is a ~15-25 MB JSON response, rebuilt from scratch (clone + ladder computation per row) on every queue refresh.

**Concrete ceiling**: response assembly is O(total requests ever), not O(open requests). At ~500 requests the endpoint is fine (~1 MB); at ~5,000 it is ~5-10 MB per refresh plus PERF-1's snapshot on the same call (the session slide); at ~20,000 the approvals queue becomes tens of MB and multi-second.

**Recommendation**: add `limit`/cursor to `GET /requests` (the GSI1SK is a ULID — it is already a natural cursor); default `scope=all` to a recent window; strip `pinnedDiff` (and arguably full `events`) from the *list* projection, keeping them on `GET /requests/:id`; move settlement out of the list path (settle only the page being returned, or run it opportunistically from the existing scheduler tick).

### PERF-4 — `/readyz` re-verifies every audit chain hash on every probe: O(total audit entries) CPU per health check

- **Severity: high**
- **Location**: `ccp/api/src/domain/readiness.ts:41-57`; wired at `ccp/api/src/index.ts:73-76`

The readiness probe calls `exportAuditChain` for **every** known project (`readiness.ts:49-52`), which loads the entire chain into memory (`auditQuery.ts:36-59`: month-partition walk, cloning every entry) and recomputes **every** sha256 link (`verifyChain`, `audit.ts:107-120`, one `canonicalJson` + one sha256 per entry).

Every mutation in the system appends a chain entry — submits, approvals, settles, uploads, login failures, admin changes — so the chain grows without bound (no pruning path exists). At 100k total entries (a busy year across a handful of projects), each probe clones 100k items and computes 100k canonical-JSON serializations + hashes: hundreds of ms to seconds of *synchronous* CPU on the event loop, per probe, forever. A 10-30 s probe interval turns this into a permanent background load of several percent to tens of percent of one core, with periodic latency spikes for real traffic — and on a slow disk-grown store, probe timeouts that make the orchestrator restart a healthy process (the failure mode readiness probes exist to prevent).

**Recommendation**: verify chains **incrementally** — persist the last-verified `(ulid, hash)` per project and verify only entries after it (the chain structure makes suffix verification exactly as sound); or verify fully at boot and on an explicit admin action, and have `/readyz` check only store-loaded + accounts>0 + head-row consistency. Full re-verification belongs in `GET /admin/audit/export` (where it already lives) and the offline CLI, not the probe path.

### PERF-5 — Frontend main bundle is 3.76 MB (663 KB gzip) with all 115 manifest JSONs inlined and zod-parsed at module init

- **Severity: high**
- **Location**: `ccp/app/src/data/manifests/index.ts:12-18`; consumed by `src/lib/api.ts:32` / `src/lib/httpApi.ts:22`; build output measured

`vite build` emits `dist/assets/index-DZ3jsjMo.js` at **3,758 kB minified / 663 kB gzip** (vite's own >500 kB warning fires). Inspection of the chunk confirms the catalog is inlined: 1,642 `riskFloor` occurrences (= every operation), 5,258 `aws_` + 2,057 `azurerm_` type strings. The cause is `src/data/manifests/index.ts`, which eagerly globs all 115 manifest JSONs (3.9 MB on disk) **and** runs `parseManifests(raw)` — a full zod deep-parse of the entire catalog — at module-evaluation time (line 18), on the critical path of first paint for every visitor including the login page (`lib/api.ts` is imported by essentially every route module). Only the admin subtree and the first-run page are code-split (`router.tsx:32-46`); catalog, console, request forms, drift, approvals, dashboard, and the whole bundled sample estate all ride the entry chunk.

**Concrete cost**: ~3.8 MB of JS to parse/execute on first load (multi-second on mid-range mobile; 663 KB over the wire), plus an estimated 100-500 ms of main-thread zod parsing before anything renders — paid even by a user who only ever visits the approvals queue of a server-backed project whose manifests come from the API anyway (`httpApi.ts:1206-1216`).

**Recommendation**: make the bundled sample catalog lazy — `import.meta.glob` without `eager`, parsed on first `listManifests()` call (it is already behind an async API); route-split the heavy leaf routes (`DriftPage` at 905 lines, `ApprovalsQueue`, `RequestDetail`, the request forms) the way the admin subtree already is; consider `manualChunks` to separate vendor React from catalog data so the data chunk caches independently.

### PERF-6 — API mode re-downloads and re-parses the full inventory + manifest set on every route mount; the serve endpoints send no caching headers

- **Severity: medium**
- **Location**: frontend `ccp/app/src/lib/httpApi.ts:1206-1228` (no memoization), 19 call sites (e.g. `ServiceConsole.tsx:137-141`, `RequestDetail.tsx:505-506`, `ApprovalsQueue.tsx:573-574`, `MyRequests.tsx:221-222`); backend `ccp/api/src/routes/projectData.ts:492-521` (`serveActive`) and `ccp/api/src/domain/projectData.ts:366-395` (`readFileSync`)

`api.getInventory()` / `api.listManifests()` in api mode fetch `GET /projects/:id/inventory` / `/manifests` fresh on **every** call — there is no client-side cache, and every navigation (catalog → console → resource → form → back) re-triggers the fetch pair from its mount effect. `listManifests` additionally re-runs the full `parseManifests` zod pass per call (`httpApi.ts:1211`). Server-side, `serveActive` returns the file with only `Content-Type` (`routes/projectData.ts:520`) — no `ETag`, no `Cache-Control`, no 304 path — and reads it with **synchronous** `readFileSync` (`projectData.ts:391`), blocking the event loop for the read of a file that can be most of the 16 MiB upload cap.

**Concrete ceiling**: an estate at the 50k-resource cap yields an inventory JSON in the 10-15 MB range. Every user re-downloads it on every service-console visit and re-holds a parsed copy; ten users navigating actively ≈ hundreds of MB/hour of redundant transfer, with the API doing sync multi-MB file reads per request in between full-store snapshots (PERF-1). At the documented ~1,300-resource estate this is ~1 MB per navigation — tolerable but still wasteful.

**Recommendation**: cache inventory/manifests per `(projectId, activeVersion)` in the client (the version is available from the project registry; even a simple module-level `Map` keyed by project id with invalidation on project switch would remove >90% of fetches); add `ETag: <digest>` (the server already stores per-part sha256 digests — `ProjectDataVersionItem.digests`) + `If-None-Match` handling; switch the serve read to async `fs.promises.readFile` or a streamed response.

### PERF-7 — Nothing in the store is ever purged: sessions, idempotency markers, and the audit chain grow forever (and every byte is re-serialized per request)

- **Severity: medium**
- **Location**: `ccp/api/src/auth/sessions.ts:43` (`ttl` written), `ccp/api/src/store/memoryStore.ts` / `fileStore.ts` (no TTL sweep anywhere), `ccp/api/src/routes/requests.ts:472-475` (idempotency markers), `ccp/api/src/domain/audit.ts` (append-only chain)

Session rows carry a DynamoDB-style `ttl` attribute (`sessions.ts:43`, `schema.ts:246`) that **no code enforces**: expired sessions are only deleted on explicit logout (`routes/auth.ts:319`), self-service revoke, or `killAllSessions`. A user who closes the tab leaves a dead 500-byte row forever; `listLiveSessions` filters them from display (`sessions.ts:139-145`) but never deletes. Idempotency markers (`requestIdempotencyKey` rows) and the per-project audit chain are likewise append-only with no retention (contrast the drift lane, which *does* prune, `domain/drift.ts:45-53`).

Alone this is slow-burn bloat (~10-50 MB/year for a small team). Its real cost is as the **multiplier on PERF-1**: every dead session row and every historical audit entry is structured-cloned, sorted, and re-stringified on *every authenticated request*, and re-hashed on every `/readyz` probe (PERF-4).

**Recommendation**: sweep expired sessions opportunistically (on login, or a per-hour pass in the scheduler tick — a `queryGSI1`-free scan is fine at this scale once PERF-1 is fixed); age out idempotency markers (they only need to outlive a client retry horizon — days); design an audit-chain archival story (export + truncate-with-anchor: the exported document is already self-verifying, `auditQuery.ts:71-82`).

### PERF-8 — Admin audit "pagination" materializes and re-sorts the whole chain per page; cursor lookup is a linear scan

- **Severity: medium**
- **Location**: `ccp/api/src/routes/admin.ts:1195-1218`; `ccp/api/src/domain/auditQuery.ts:36-59`

`GET /admin/audit` calls `readAuditChronological` — which loads **every** chain entry (clone per item, month-partition walk) — then `slice().reverse()`, then finds the cursor by `findIndex` (O(n)), then slices the page (`admin.ts:1196-1216`). The `limit` parameter (max 1000, default 100) bounds only the response body, not the server work: every page of the admin Audit History screen costs O(total chain) reads + clones + a full reverse. At a 100k-entry chain each page view is ~100k structured clones (~100-300 ms plus GC pressure) — and the SPA's per-page fetch turns paging *through* the history into repeated full-chain materialization. `GET /admin/audit/export` (`admin.ts:1221-1228`) legitimately needs the whole chain but additionally re-verifies every hash and builds the entire document in memory in one `c.json` — a multi-hundred-MB allocation at large chain sizes.

**Recommendation**: page at the store: iterate month partitions newest-first and stop once `limit` rows are collected (the partition scheme, `auditKey(project, yyyymm, ulid)`, was designed for exactly this — the comment at `auditQuery.ts:6-12` says so); resolve the cursor by its ULID's embedded month rather than `findIndex`; stream the export.

### PERF-9 — `ServiceConsole` loads the entire block-source corpus on every service page mount, fetching server chunks sequentially

- **Severity: medium**
- **Location**: `ccp/app/src/features/services/ServiceConsole.tsx:143-150`; `ccp/app/src/lib/blockSource.ts:188-215`

`ServiceConsole`'s mount effect calls `allBlockSources()` — documented in `blockSource.ts:186-187` as "on-demand only, from the rare panel that needs a whole-estate answer, never on initial load" — to feed the family-rollup join (`buildResourceFamilies`, line 260-263). In api mode `allBlockSources` fetches **every** chunk file of the project **sequentially** (`for … await serverChunkFor` per chunk, `blockSource.ts:194-197`), then holds the entire HCL corpus in one `Record`.

**Concrete ceiling**: the server permits up to 2,000 chunk files (`domain/projectData.ts:39`). A mid-size estate with 150 chunk files at ~60 ms RTT each ≈ **9 s of serial fetching** before the console renders resources, on the *first* service page visit per project (the chunk cache makes later visits cheap — but the first-visit stall is on the product's main screen). Memory: the corpus can approach the full 16 MiB bundle, held for the session.

**Recommendation**: fetch chunks with bounded concurrency (`Promise.all` over a pool of 6-8); better, restrict the rollup join to the chunks that contain the current service's addresses (the index maps address → chunk, so the needed chunk set is computable up front); render the flat list immediately and upgrade to the rolled-up view when blocks arrive (the code already degrades gracefully to the flat list on load failure).

### PERF-10 — Submit-path full scans: rate-limit check and feasibility each re-scan whole collections per submission

- **Severity: medium**
- **Location**: `ccp/api/src/middleware/rateLimit.ts:28-45`; `ccp/api/src/domain/eligibility.ts:63` via `routes/requests.ts:342,362`

Every submit runs:
- `checkSubmitRateLimit`: `queryGSI1(requestCollectionGsi(projectId))` — clone **every request row in the project** (full `events`/`params`/`planSummary` copies) to count the requester's last-hour submissions and open slots (`rateLimit.ts:34-42`). O(all requests ever) work and allocation per submit, growing forever.
- `computeFeasibility` → `eligibleApprovers` → `loadAccounts`: clone the full global account directory (`config.ts:63-65`) per submit, and again per `GET /requests/:id/feasibility`.

On top, `MemoryStore.query`/`queryGSI1` are themselves linear scans over the *entire* item map with a `structuredClone` per match (`memoryStore.ts:45-57`) — there is no per-PK index — so every "query" anywhere in the API is O(total store items). These constants are small today; they multiply with PERF-1's growth curve (each submit at 10k historical requests clones 10k full rows just to count ~20 of them).

**Recommendation**: maintain per-requester open/hour counters (a single small row updated in the submit transact), or at minimum project the scan (count without cloning — add a count/keys-only query to the `ConfigStore` seam); index `MemoryStore` by PK (a `Map<PK, Map<SK, Item>>`) so queries stop scanning the world.

### PERF-11 — Per-project audit chain head serializes all writes and surfaces contention as user-facing 409s after one retry

- **Severity: medium**
- **Location**: `ccp/api/src/domain/audit.ts:153-233` (`recordIn`/`record`/`transactWithAudit`, 2 attempts → `CHAIN_CONTENTION`); same loop hand-rolled in `routes/requests.ts:477-504, 688-707, 946-960, 1014-1037`, `domain/cooling.ts:63-81`, `domain/schedule.ts:300-322`, `domain/apply/scheduler.ts:357-383`

Every mutation in a project CASes the same `CHAINHEAD` row. Between the head read and the transact there are multiple awaits (and, on FileStore, a full snapshot write), so concurrent mutations in one project routinely collide; each site retries **once** and then throws `CHAIN_CONTENTION` (HTTP 409) at the user. Effective write throughput per project is therefore ~1/(snapshot latency), and under even three concurrent actors (two approvers + the settle loop of someone's `GET /requests`, PERF-3) the third writer can lose twice and get a 409 for a normal approve click. This is an availability ceiling rather than a raw-speed one: the design is a deliberate integrity choice (the hash chain cannot fork), but one retry is a very small budget given how long the FileStore holds the window open.

**Recommendation**: raise the retry budget with jittered backoff (the loop is already idempotent-safe at every site); shrink the contention window by fixing PERF-1 (the snapshot dominates it); longer-term, consider batching audit appends per tick for system actors (cooling/window settles) so human writes rarely meet system writes on the head.

### PERF-12 — Upload ingest does 4+ full canonical-JSON passes over the 16 MiB bundle synchronously on the event loop

- **Severity: medium**
- **Location**: `ccp/api/src/routes/projectData.ts:232-267`; `ccp/api/src/domain/projectData.ts:136-154, 218-296`; same pattern for drift at `routes/drift.ts:288-293`

`PUT /projects/:id/data` runs, all synchronously between awaits: `JSON.parse` of up to 16 MiB → strict zod parse of the whole bundle → `digestsOf(parsed)` (one `canonicalJson` — a recursive, sort-every-object serialization — per part, over the whole bundle) → `rerunRedaction` (per-resource `canonicalJson` **twice** per resource ×50k, per-block redact + compare) → `digestsOf(stored)` again. That is ≥4 full serializations plus redaction of the complete estate: multi-second synchronous CPU for a large bundle, during which the single-threaded server answers nothing (compounding with PERF-1's snapshot when the version row lands). Uploads are CI-driven and rare, which is why this is medium — but one CI push freezing every interactive user for seconds is still a real production annoyance, and it scales with estate size, not with traffic.

**Recommendation**: compute digests in the same pass as redaction (redact first, hash once; compare uploader digests against a single pre-redaction pass); yield between chunks (`setImmediate` every N resources) or move ingest to a worker thread; the strictly bounded input size makes a worker-thread port trivial to reason about.

### PERF-13 — SchemaForm recomputes inventory-derived enums for every field on every keystroke

- **Severity: low**
- **Location**: `ccp/app/src/components/SchemaForm/SchemaForm.tsx:68-71`; `ccp/app/src/lib/interpreter.ts:94-112` (`resolveEnum`)

`SchemaForm` calls `resolveEnum(param, inventory, operationId)` inline in render for every inventory/allowlist-sourced param; `resolveEnum` filters and maps the **entire** `inventory.resources` array per call. Every keystroke in any field lifts state to the parent (`values` changes), re-rendering the whole form and re-running the scan for each enum field. At the documented ~1,300-resource estate with 3-4 enum fields this is ~5k operations/keystroke — imperceptible. At the 50k-resource cap it is ~200k operations + allocations per keystroke: visible jank on mid-range hardware. Same pattern one level up: `MyRequests.tsx:236-241` rebuilds a name-by-address `Map` over the full inventory per data change (memoized — fine), but `matchResource` (`ServiceConsole.tsx:55-60`) stringifies every attribute of every resource per filter recompute (deferred, so paint-safe — CPU still burned).

**Recommendation**: memoize `resolveEnum` results per `(operationId, param.name, inventory)` — the inventory object is stable between fetches, so a `WeakMap`-keyed cache collapses this to one scan per form; or precompute a `type → addresses` index once per inventory load and have `resolveEnum` read the index.

### PERF-14 — Scheduler tick re-scans every project's full request collection every minute

- **Severity: low**
- **Location**: `ccp/api/src/domain/apply/scheduler.ts:161-166`; `ccp/api/src/domain/apply/loop.ts:35, 120-127`

With `CCP_SCHEDULER=1`, every 60 s tick calls `runDueApplies` per known project, each doing `queryGSI1(requestCollectionGsi(projectId))` — a full store scan plus a structured clone of **every** request row in that project (PERF-10's `MemoryStore` cost) — to find the usually-empty due set. At 20 projects × 10k total store items that is ~200k map iterations plus cloning all request rows, every minute, forever: not a latency problem, but permanent allocation/GC churn that grows with history, in exchange for finding on the order of zero due rows. The loop's own non-reentrancy and claim design are sound (see Strengths #9).

**Recommendation**: once a status index exists (or the PK-indexed store of PERF-10), query only `AWAITING_DEPLOY_APPROVAL`/`APPLYING` rows; alternatively maintain a small "windowed & approved" side list updated on the transitions that create/destroy eligibility.

### PERF-15 — Request-history views render unbounded lists without windowing

- **Severity: low**
- **Location**: `ccp/app/src/features/requests/MyRequests.tsx:342-356`; `ccp/app/src/features/approvals/ApprovalsQueue.tsx` (lane rendering); `ccp/app/src/features/dashboard/LeadDashboard.tsx:86`

`MyRequests` renders every request the server returns (which, per PERF-3, is every request ever, terminal included) grouped into lanes with no cap, no virtualization, and a full re-sort per filter change (`MyRequests.tsx:271-278`). `LeadDashboard` fetches `listAllRequests()` to compute its charts client-side. The DOM cost is real once history crosses a few thousand rows (each row renders badges, ladder state, timestamps). This is bounded today by PERF-3's server behavior — fixing pagination there should include windowing (or `VirtualRows`-style virtualization, already in the codebase) here.

---

## Minor observations

- **`MemoryStore.exportItems` sorts by concatenated key with a `' '` separator** (`memoryStore.ts:4-7, 24-26`) on every persist — O(N log N) per mutation is subsumed by PERF-1 but worth noting as an independent cost.
- **`FileStore.load` / `manifests.ts` boot reads are synchronous** (`fileStore.ts:47-56`, `manifests.ts:20`) — fine at boot; noted only for completeness.
- **argon2id verifies are safely bounded**: `@node-rs/argon2` runs on the libuv threadpool (≤4 concurrent × 19 MiB, `credentials.ts:12-17`), and login has per-account exponential lockout (`routes/auth.ts:108-118`); the upload lane adds its own token bucket. No unbounded CPU/memory amplification here — a genuinely well-handled hot spot.
- **`withSettlement`/`withProject` per-request overhead is properly cached** (`settlement.ts:75, 226-229` WeakMap; `projects.ts:28-29` hydration flag) — the middleware stack costs two map lookups after first hydration.
- **The React Compiler pilot is annotation-only** (`vite.config.ts:19-22`) — no perf effect today; the manual memoization discipline in `ServiceConsole` is doing the work and doing it well.
- **`bundleRequestPayload`/audit `after` payloads keep chain entries small on purpose** (`routes/requests.ts:864-866` audits counts, not the whole summary) — good instinct that partially mitigates PERF-4/PERF-7 growth rates.
- **Drift serve endpoints** read the (≤4 MiB) stored report with sync `readFileSync` per `GET /projects/:id/drift` (`domain/drift.ts:590-596`) — same pattern and same fix as PERF-6's serve path.
- **Docker healthcheck cadence**: the compose file probes only the runner (`ccp/docker-compose.yml:127-132`); nothing in-repo probes `/readyz` on an interval, so PERF-4's cost is deployment-dependent — but `/readyz` is the documented infra probe (`index.ts:71-76`) and any standard k8s/ELB setup will hit it every 10-30 s.

---

## Overall grade: D

**Justification.** The architecture makes several correct big-picture calls — estate-sized data off the hot store, strict ingest caps, real list virtualization, a properly async terraform executor — and the frontend state layer is built to avoid the classic re-render pathologies. But the serving core has a compounding, unbounded cost structure: an append-forever store that is fully re-serialized and fsynced on **every authenticated request** (PERF-1) — including plain reads, via the session idle-slide — with no pagination on the request list (PERF-3), O(entire-audit-history) health probes (PERF-4), and synchronous process spawns that freeze the whole API for minutes when the product's headline flows are armed (PERF-2). The frontend ships a 3.76 MB main bundle with the full catalog zod-parsed before first paint (PERF-5) and re-downloads the inventory on every navigation in api mode (PERF-6). None of these bite in a demo; all of them bite on the timescale of months of ordinary single-team use, because nothing that grows is ever pruned and nothing that scans is ever indexed. The fixes are individually tractable (a debounced session slide plus a coalesced snapshot alone would move the ceiling by ~two orders of magnitude), which is precisely why the current state grades poorly: the ceilings are low, near, and reached under normal use, not under abuse.
