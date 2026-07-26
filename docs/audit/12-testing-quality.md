# Test Suite Quality & Coverage Audit

**Audit date:** unknown-date
**Dimension:** testing (TEST)
**Repository:** `cloud-control-plane` @ `3000920` ("Easy first import: paste a repo address and this system scans it (#2)")

---

## Scope & method

Everything below is based on code actually read and suites actually executed in this environment
(Linux, Node 22 via `npm ci`, Go toolchain present, Python 3 with `python-hcl2` 5.1.1 installed,
**no** `terraform` binary installed).

**Suites executed, honest results:**

| Suite | Command | Result | Duration |
|---|---|---|---|
| `ccp/api` | `npm ci && npm test` (vitest) | **71 files, 1137 passed, 1 skipped** (the skip is the LIVE terraform block in `test/terraformExecutor.test.ts:191` — terraform not installed here) | 67.4 s wall |
| `ccp/app` | `npm ci && npm test` (vitest) | **144 files, 2667 passed, 0 skipped/failed** | 53.0 s wall |
| `tools/catalogctl` | `go test -count=1 ./...` | **all 15 packages ok** (408 `func Test/Fuzz` functions; 80 golden case dirs under `testdata/golden/` across 28 verb families, plus `testdata/driftpropose/golden`) | 8.6 s wall |
| `tools/schemadump` | `go test ./...` | ok (7 test functions) | <1 s (cached) |
| `importer/kit` | `python3 -m pytest tests -q` | **7 FAILED, 99 passed** — details in TEST-1 | 10.0 s |
| `importer/kit-azure` | `python3 -m pytest tests -q` | 48 passed | 3.1 s |
| `ccp/app/scripts` | `python3 -m unittest test_build_inventory` | **1 FAILED, 29 passed** — details in TEST-3 | 4.8 s |

**Files read in depth (non-exhaustive):** `ccp/api/vitest.config.ts`, `ccp/api/test/setup.ts`,
`ccp/api/test/helpers/seed.ts`, `ccp/api/test/{store,fileStore,audit,terraformExecutor,createResourceParity,scheduleWindowCheckParity,dualControl,bundle,linkPr,openapi,totp,windowExpiry,driftButtons,driftProposals,schedulerGating}.test.ts`,
`ccp/api/src/store/{fileStore.ts,fileStore-failclosed.test.ts}`, `ccp/api/src/clock.ts`, `ccp/api/src/routes/requests.ts`,
`ccp/api/test/fixtures/gen-golden.ts`, `ccp/app/vite.config.ts`, `ccp/app/src/test/{setup.ts,coverage,fullCoverage,serverContract,api-enforcement,httpApi.integration,replaceConfirmGate}.test.ts`, `ccp/app/src/test/driftPanel.test.tsx`,
`tools/catalogctl/golden_test.go` and the `internal/edit`, `internal/plancheck`, `internal/prprep`, `internal/windowcheck` test listings,
`importer/kit/normalize.py`, `importer/kit/tests/*`, `importer/kit-azure/normalize.py`, `ccp/app/scripts/test_build_inventory.py`,
`docs/FUNCTIONAL-TEST-PLAN.md`, `scripts/gate.sh`, `scripts/gen-project-data.sh`, and all eight `.github/workflows/*.yml` plus both `.gitlab/ci/*.yml`.

---

## Strengths

The TypeScript and Go suites are, frankly, among the best-constructed I have audited. Concrete
examples, all verified by reading the code:

1. **Behavior-level API testing through the real HTTP surface.** Nearly every `ccp/api` test
   drives the actual Hono app via `app.request(...)` with real cookies, CSRF headers and the
   `x-ccp-project` header (e.g. `ccp/api/test/dualControl.test.ts:38-48`), backed by a
   `MemoryStore` that faithfully implements DynamoDB conditional-write/transact semantics —
   themselves pinned by `ccp/api/test/store.test.ts:204-250` (all-or-nothing transact, `ifEquals`
   abort, `ifNotExists` `ConditionError`). These tests assert observable behavior (status codes,
   stored items, audit entries), not implementation internals.

2. **Cross-layer parity harnesses — a genuinely rare practice.**
   `ccp/api/test/createResourceParity.test.ts` builds the *real* `catalogctl` binary
   (`go build`, lines 36-49) and asserts, for 29 op/variant cases, that the Go verb's authored
   HCL is **byte-for-byte** equal to the TS draft renderer the requester saw (line 161), including
   a dedicated `${…}`→`$${…}` escape-parity case (lines 176-185).
   `ccp/api/test/scheduleWindowCheckParity.test.ts` re-expresses the Go window fixtures by
   *independent transcription* (deliberately not parsing the YAML — line 100-104's comment) and
   compares TS verdicts against the live binary verdict-for-verdict, including inclusive-start /
   exclusive-end boundaries. This is the correct defense for a system whose core promise is
   "the draft the requester saw is the HCL the engineer reviews."

3. **A golden corpus that tests refusals as hard as successes.**
   `tools/catalogctl/golden_test.go` runs 80 case directories; for exit-0 cases it byte-compares
   the whole edited tree *and* the emitted diff (`golden_test.go:112-116`), then re-runs the verb
   to prove idempotence (empty diff, exit 0 — lines 118-129); for refusal cases it asserts the
   exit code, the `REFUSE` message, **and that the tree is untouched** (line 109). A subtly wrong
   HCL edit — one changed byte, wrong whitespace, a reformatted untouched file — fails this
   harness. There is no `-update` flag, so goldens cannot be blanket-regenerated over a bug.

4. **A real end-to-end apply-pipeline proof exists.** `ccp/api/test/terraformExecutor.test.ts`
   layers (a) toolchain-free fail-closed pre-checks (tampered planfile, digest mismatch →
   "PLAN CHANGED SINCE APPROVAL", plan-only refusal, unsafe request id — lines 111-187) under
   (b) a LIVE block (line 191) that runs real `terraform init/plan/apply` on an offline
   `terraform_data` sandbox, drives the real scheduler, asserts the provisioner artifact was
   written, then mutates the root post-approval and asserts `HALTED_DRIFT` with **no** apply
   (lines 241-266). Similarly, `ccp/api/test/bundle.test.ts:27-38` tests the CAS push against a
   real local bare git repository, not a mock.

5. **Deterministic time.** All server time flows through one injectable clock
   (`ccp/api/src/clock.ts`); expiry tests freeze it (`test/windowExpiry.test.ts:63-125`), and
   the app's session tests use `vi.setSystemTime` (`ccp/app/src/test/session-security.test.ts:67-86`).
   TOTP tests use real time but the server verifies with `window: 1` (`src/auth/totp.ts:16`),
   which removes the period-boundary flake.

6. **Fault injection where it matters.** `ccp/api/test/audit.test.ts:60-83` injects a
   `FlakyStore` to prove chain-contention retries once then surfaces `409 CHAIN_CONTENTION`.
   `ccp/api/src/store/fileStore-failclosed.test.ts` pins the fail-closed corpus (absent = fresh;
   empty/whitespace/corrupt = refuse to boot). `ccp/api/test/fileStore.test.ts` proves durability
   *across simulated restart* including the negative cases (a failed `ifNotExists` put and a
   failed transact leave the on-disk snapshot untouched — lines 55-80) and that 40 concurrent
   puts all land through the serialized write chain (lines 97-105).

7. **Test hygiene with documented rationale.** `ccp/api/test/setup.ts` resets the module-global
   known-projects cache before every test, with an honest comment explaining the latent
   cross-test-contamination bug it closes. `ccp/api/test/helpers/seed.ts` builds realistic
   fixtures (legacy-shaped vs. new-roles-shaped accounts modeled as *distinct* fixture shapes,
   never both — lines 68-72) and documents exactly which invariant `sessionCookieFor` bypasses.

8. **The audit-chain golden is regenerated, not trusted.** `ccp/api/test/fixtures/gen-golden.ts`
   is the single source; the test regenerates the chain and byte-compares against the committed
   JSON, so any hash-algorithm drift fails loudly.

9. **`docs/FUNCTIONAL-TEST-PLAN.md` is a real traceability artifact.** 100+ cases across 13
   journeys, each with an "Automated?" column citing the pinning test file, an explicit
   manual-only list (§15), and even a documented *known divergence* (XLAYER-14) rather than a
   pretended green. Very few repos have this.

10. **Importer tests are hermetic by construction.** `importer/kit/tests/test_scripts.py` runs
    the shell scripts against stub `aws`/`terraform` binaries and strips all `AWS_*`/`TF_TOKEN_*`
    env vars so ambient credentials can never reach a test.

---

## Findings

### TEST-1 — `importer/kit` test suite is red at HEAD: 7 of 106 tests fail
- **Severity:** high
- **Location:** `importer/kit/normalize.py:105` (root cause), `importer/kit/tests/test_normalize.py:72,82,89,124`, `importer/kit/tests/test_statediff.py:224`, `importer/kit/tests/kitpaths.py:39`
- **Description:** `python3 -m pytest tests` in `importer/kit` fails 7 tests (verified twice, exit 1).
  Two independent causes:
  1. **Six failures** — `normalize.py split` crashes with `KeyError: '__start_line__'`
     (`normalize.py:115`) because `parse_resources` calls `hcl2.load(fh)` **without**
     `with_meta=True` (`normalize.py:105`). The Azure twin was fixed and says so explicitly:
     `importer/kit-azure/normalize.py:100-102` — *"with_meta=True attaches `__start_line__`/`__end_line__`
     per block — required on the repo-pinned python-hcl2 5.1.1 …, where a plain load() omits them"* —
     but the fix was never propagated back to the AWS kit. The repo's own pin
     (`scripts/gen-project-data.sh:65,168`, `python-hcl2==5.1.1`) guarantees the crash. The AWS
     kit's `split` command is therefore broken as shipped, and the tests correctly catch it.
  2. **One failure** — `test_real_sweep_ignore_json_is_well_formed_and_seeded`
     (`test_statediff.py:224`) opens the "shipped production file"
     `scripts/drift/sweep-ignore.json` (`kitpaths.py:39`), which does not exist anywhere in the
     repo — `scripts/drift/` contains only `security-watchlist.json`. Both problems date to the
     initial public release commit (`git log` shows no later touch).
- **Impact:** Anyone running the documented command (`importer/kit/README.md:26,159`) gets a red
  suite; the six `normalize` failures reflect a genuinely broken production code path (Terraform
  adoption `split` step) that shipped without anyone noticing, and the seventh means a
  spec-referenced production artifact is missing. A red-at-HEAD suite also trains contributors to
  ignore failures.
- **Recommendation:** Port `with_meta=True` (and the same comment) from
  `importer/kit-azure/normalize.py:102` to `importer/kit/normalize.py:105`; either commit the
  seeded `scripts/drift/sweep-ignore.json` the statediff spec requires or update
  `kitpaths.py`/the test to the file that actually shipped. Then wire the suite into CI (TEST-2)
  so it can never rot silently again.

### TEST-2 — No CI lane executes any Python test suite; `gate.sh` omits them too
- **Severity:** high
- **Location:** `.github/workflows/` (all eight workflows; grep for `pytest`/`unittest` matches nothing), `.gitlab/ci/*.yml`, `scripts/gate.sh:36-60` (go/api/app/tf sections only)
- **Description:** Three Python suites exist — `importer/kit/tests` (106 tests),
  `importer/kit-azure/tests` (48 tests), `ccp/app/scripts/test_build_inventory.py` (30 tests) —
  and none is invoked by any GitHub workflow, any GitLab job, or the local pre-push mirror
  `scripts/gate.sh` (which runs only `go test`, the two `npm test`s, and terraform fmt/validate).
  `ccp-data.yml` sets up Python (line 86) but only to run the generator, never its tests. There is
  also no `requirements.txt`/`pyproject.toml` anywhere pinning the Python test environment
  (`python-hcl2` is pinned only inside `scripts/gen-project-data.sh`).
- **Impact:** This is the direct cause of TEST-1 and TEST-3 shipping red: the only components with
  no CI test lane are exactly the ones that are broken at HEAD. The importer is the adoption
  path for real customer estates — its regression suite currently protects nothing.
- **Recommendation:** Add an `importer.yml` workflow (path-filtered on `importer/**` and
  `scripts/drift/**`) that installs `python-hcl2==5.1.1` (reusing the `--print-pins` mechanism of
  `gen-project-data.sh`) and runs both pytest suites plus `test_build_inventory.py`; add a
  matching `gate_py` section to `scripts/gate.sh`.

### TEST-3 — `ccp/app/scripts/test_build_inventory.py` fails at HEAD (stale fixture premise)
- **Severity:** medium
- **Location:** `ccp/app/scripts/test_build_inventory.py:92-103`
- **Description:** `test_unmanaged_resource_type_is_excluded` writes an `aws_sqs_queue` resource
  and asserts the generated inventory is empty ("a resource type no manifest covers must not
  appear"), but the run produces `{address: 'aws_sqs_queue.jobs', service: 'queue', …}` — the
  catalog has since grown to cover SQS (the app now advertises "full provisionable coverage",
  `ccp/app/src/test/fullCoverage.test.ts`), and the test's premise was never updated. 29 of 30
  tests pass; this one has presumably been red since the catalog expansion.
- **Impact:** The inventory generator that feeds `ccp-data.yml`'s production data lane has a unit
  suite nobody runs and that fails when run — the "managed filtering" property it was written to
  protect is currently unverifiable.
- **Recommendation:** Change the fixture to a genuinely uncovered type (or assert the new
  expected behavior for SQS), and wire the file into the CI lane from TEST-2.

### TEST-4 — The highest-value integration tests skip silently when a toolchain is missing, and nothing asserts they ran in CI
- **Severity:** high
- **Location:** `ccp/api/test/terraformExecutor.test.ts:32,191`; `ccp/api/test/createResourceParity.test.ts:36-49,61-66,155`; `ccp/api/test/scheduleWindowCheckParity.test.ts:135`; `ccp/api/test/driftBundleSeam.test.ts:117-174`; `ccp/app/src/test/httpApi.integration.test.ts:24-29`; `.github/workflows/ccp-api.yml` (no Go/terraform setup step); `.github/workflows/ccp-app.yml` (installs only `ccp/app` deps)
- **Description:** The suites that prove the request-to-PR/apply pipeline end-to-end are all
  guarded by `describe.skipIf(<toolchain present>)`:
  - the LIVE terraform plan→pin→apply→halt-on-drift proof skips without a `terraform` binary
    (it skipped in this audit's run: "1137 passed | 1 skipped");
  - both TS↔Go parity harnesses skip when `go build` fails or `go` is absent
    (`buildCatalogctl()` returns `null` and only `console.warn`s);
  - the seam-fixture parity blocks skip when the fixture files are absent;
  - the SPA↔API integration proof (`httpApi.integration.test.ts`) skips whenever
    `ccp/api/node_modules/.bin/tsx` is absent — and its own comment states this is the **normal
    CI condition**: *"CI's ccp-app job installs only ccp/app deps, so skip cleanly when tsx is
    absent."* The real-HTTP login→TOTP→session proof therefore **never runs in GitHub CI**, only
    on developer machines that happen to have installed both packages.
  Meanwhile `ccp-api.yml` sets up Node only; the parity and LIVE-terraform blocks run in CI today
  purely because GitHub's `ubuntu-latest` image happens to preinstall Go and Terraform — an
  unpinned, undeclared dependency. The GitLab mirror (`.gitlab/ci/`) has no api/app test lane at
  all. No environment variable (e.g. `CI=1` ⇒ fail-instead-of-skip) or post-run assertion checks
  that the skippable blocks actually executed.
- **Impact:** A runner-image change, a self-hosted `vars.CI_RUNNER`, or a GitLab-only deployment
  silently deletes the only end-to-end tests of the product's core pipeline while the check stays
  green. This is precisely the failure mode that let TEST-1 ship.
- **Recommendation:** In CI workflows, install Go/Terraform explicitly (the repo already pins
  Go via `go.mod` in other workflows) and export something like `CCP_TEST_REQUIRE_TOOLCHAINS=1`
  that converts each `skipIf` into a hard failure; add an api-deps install step (or a dedicated
  cross-package job) to `ccp-app.yml` so `httpApi.integration.test.ts` runs in CI.

### TEST-5 — No code-coverage measurement anywhere; `coverage.test.ts` is not code coverage
- **Severity:** medium
- **Location:** `ccp/api/package.json`, `ccp/app/package.json` (no `@vitest/coverage-*` dependency, no coverage script), `ccp/api/vitest.config.ts`, `ccp/app/vite.config.ts:40-46` (no `coverage` key), `.github/workflows/catalogctl.yml:25` (plain `go test`, no `-cover`)
- **Description:** Despite the size of the suites (≈3,800 JS/TS tests, 408 Go test functions),
  no component measures statement/branch coverage, and no CI gate enforces a floor. The files
  named `coverage.test.ts`, `fullCoverage.test.ts`, `adminCoverage.test.ts` are **catalog-data
  drift gates** — excellent ones (e.g. `coverage.test.ts:80-101` fails if any of the 311 browsable
  services lacks a team or metadata; `fullCoverage.test.ts:81-97` fails on any dead op-less
  provision tile) — but they measure the data catalog, not code execution.
- **Impact:** Untested code paths are invisible. Given the demonstrated pattern (the parts of the
  repo without a metric or a lane are the parts that rotted), there is no way to know, e.g., how
  much of the 1,077-line `driftProposals.ts` or the request route's contention-retry branches
  (`src/routes/requests.ts:695-707`) the suite actually executes.
- **Recommendation:** Add `@vitest/coverage-v8` with a modest enforced floor per package (start
  at the current measured number, ratchet up), and `-coverprofile` in `catalogctl.yml`; publish
  the summary in CI output so dead spots become visible.

### TEST-6 — No route-level concurrency/race tests; store-level concurrency only
- **Severity:** medium
- **Location:** `ccp/api/test/fileStore.test.ts:97-105` (the only `Promise.all` concurrency test), `ccp/api/src/routes/requests.ts:695-707` (untested race branches)
- **Description:** The approve route contains carefully written race handling — a per-approver
  dedupe item whose lost race maps to `409 ALREADY_APPROVED` (`requests.ts:700`) and a
  chain-contention retry-once loop — but no test issues two *concurrent* approvals (two different
  approvers racing on the same request, or the same approver double-submitting in flight) through
  the HTTP surface. The audit-chain contention path is exercised only via the synthetic
  `FlakyStore` (`test/audit.test.ts:60-83`), never via genuine interleaving. Similarly, crash
  recovery is tested only as "new instance reads the last snapshot" (`fileStore.test.ts:24-27`);
  there is no test that a crash artifact — a stray `ccp.json.tmp-*` file left by a kill between
  `fsync` and `rename` (`src/store/fileStore.ts:90-98`) — is tolerated/cleaned on the next boot,
  nor any accumulation check.
- **Impact:** The status-transition CAS guards (`ifEquals` on `status`, `requests.ts:914,1018,1127`)
  and the dedupe-race branch are the exact code that protects approval integrity under the
  documented two-instance misuse (FUNCTIONAL-TEST-PLAN OPS-06) and under a double-clicked UI;
  they are currently verified only by reading, not by test.
- **Recommendation:** Add route-level race tests (`Promise.all` of two `POST /approve` with
  different sessions; assert exactly one ladder step recorded and the loser's error code), and a
  FileStore test that pre-plants a stale `*.tmp-*` file plus a valid snapshot and asserts a clean
  boot.

### TEST-7 — The SPA has no DOM/interaction testing; ~25 test files pin UI by source-string inspection
- **Severity:** medium
- **Location:** `ccp/app/package.json` (no jsdom / @testing-library anywhere), `ccp/app/src/test/driftPanel.test.tsx:19-23`, `ccp/app/src/test/fullCoverage.test.ts:130-150`, 25 files matching `readFileSync` under `ccp/app/src/test/`
- **Description:** The app deliberately ships without jsdom/RTL ("The repo has no jsdom/RTL …
  the tile/console UX is pinned by source inspection" — `fullCoverage.test.ts:131-134`).
  Components are tested via `renderToStaticMarkup` (SSR strings), which means **no effects ever
  run** (`useEffect` is skipped in SSR), no events fire, and no state transitions are exercised;
  and 25 of 144 test files additionally assert against the component *source text*, e.g.
  `expect(src).toContain('provisionPathFor(primaryType)')` (`fullCoverage.test.ts:137-149`).
  Source-pinning is the definition of mirroring the implementation: it fails on harmless renames
  and passes on behavioral bugs that keep the string intact.
- **Impact:** Every interactive gate the functional plan treats as load-bearing — the typed
  forces-replace confirmation (DEMO-07), the freeze banner flow, the approval button disabling —
  is verified only at the pure-logic layer (`replaceConfirmGate.test.ts` tests `replaceConfirmMet`
  and SSR output) plus grep. The plan itself presupposes the missing layer: XLAYER-01 is marked
  "new RTL case" though RTL does not exist in the repo. Click-to-submit wiring regressions
  (a handler not attached, an effect-driven fetch dropped) are invisible to this suite.
- **Recommendation:** Introduce a thin jsdom+RTL (or Playwright component) lane for the ~6
  interactive gates the plan names, and treat `readFileSync`-based assertions as a stopgap to be
  retired file-by-file; where they must stay, assert rendered output rather than source text.

### TEST-8 — Golden-tree comparison is one-directional: extra files created by an edit go unnoticed
- **Severity:** medium
- **Location:** `tools/catalogctl/golden_test.go:57-70` (`mustEqualTree`)
- **Description:** `mustEqualTree` iterates only the entries of `wantDir` and byte-compares each
  against `gotDir`. A verb that writes an *additional* file not present in `expected/` (a stray
  scratch file, a duplicated `service_2.tf`, a leaked lockfile) passes the golden gate; the same
  asymmetry applies to the refusal path's untouched-tree check (line 109), so a refusal that
  leaves new debris behind also passes "untouched". Since catalogctl is *the only component that
  writes Terraform*, "produces exactly these files and no others" is part of the contract the
  goldens exist to pin.
- **Impact:** A subtly wrong HCL edit that *modifies* an expected file is reliably caught
  (byte-exact, diff-checked, idempotence-checked — a genuine strength), but a wrong edit that
  *adds* output is not.
- **Recommendation:** In `mustEqualTree`, also read `gotDir` and fail on any entry absent from
  `wantDir` (three lines of Go).

### TEST-9 — Sleep-based synchronization in async API tests (flake and false-pass risk)
- **Severity:** low
- **Location:** `ccp/api/test/driftButtons.test.ts:406`, `ccp/api/test/driftProposals.test.ts:836,849,867`, `ccp/api/test/schedulerGating.test.ts:82`
- **Description:** A handful of tests wait on wall-clock sleeps: `driftButtons.test.ts:406` sleeps
  200 ms and then asserts the fire-and-forget drift runner *did* record a failure audit entry —
  under a CPU-saturated CI box (this very suite pegs the machine; `httpApi.integration.test.ts:99-101`
  already raised its own boot timeout to 60 s for exactly that reason) the runner can take longer
  and the test fails spuriously. The inverse pattern (`schedulerGating.test.ts:82`,
  `driftProposals.test.ts:849` — sleep 20–30 ms then assert nothing happened) can *false-pass* if
  the erroneous background work is merely slow.
- **Impact:** Occasional red CI on the positive waits; a theoretical blind spot on the negative
  ones. Bounded — four call sites.
- **Recommendation:** Expose a completion promise/hook from the fire-and-forget runner for tests
  to await (the codebase already does this style elsewhere, e.g. FileStore's `persist()` returns
  the durability promise), or poll-with-deadline instead of fixed sleeps.

### TEST-10 — Functional test plan drift: stale counts, loose citations, and "new" rows with no tracking
- **Severity:** low
- **Location:** `docs/FUNCTIONAL-TEST-PLAN.md:365` (§15), rows ADMIN-01, ADMIN-04, REQ-16, XLAYER-01..73
- **Description:** The plan's traceability data has drifted from reality: §15 claims "65 files,
  977 tests" for the api (actual: 71 files, 1138 tests) and "141 files, 2631+" for the app
  (actual: 144, 2667). Several "Automated?" citations name test files that do not exist as such —
  ADMIN-01 cites "`ccp/api/test/teams` coverage" and ADMIN-04 "`ccp/api/test/settings` coverage";
  the behaviors are in fact covered (`DUPLICATE_TEAM`/`TEAM_NOT_EMPTY` live in
  `ccp/api/test/adminSurface.test.ts`, freeze enforcement across `adv2/changeSet/driftButtons`
  et al.), but the pointers cannot be followed. About a dozen XLAYER rows are marked "new"/"new
  RTL case"/"manual release drill" with no issue tracking, and XLAYER-14 documents a live
  TS-vs-Go divergence (`cidr_blocks` vs `cidr_block`) whose only backstop is a manual
  `terraform validate` in the PR lane — no automated regression pins the divergence's resolution
  seam. The plan's own footer ("update the row in the same PR") sets the right rule; it just
  isn't being enforced.
- **Impact:** Erodes the plan's value as the audit/traceability record it clearly aspires to be.
- **Recommendation:** Regenerate the §15 numbers from CI output, fix the two dead citations, and
  convert the "new" rows into tracked issues (or an explicit "deferred" table).

### TEST-11 — OpenAPI contract test is substring matching, not conformance
- **Severity:** low
- **Location:** `ccp/api/test/openapi.test.ts:1-30`
- **Description:** The "OpenAPI contract" test reads `openapi/ccp-api.yaml` as a string and
  asserts the presence of substrings (`'openapi: 3.1.0'`, `'/requests/{id}/approve:'`, …). It
  never parses the YAML, never validates it as OpenAPI 3.1, and never compares it against the
  actual routes the Hono app serves — a route added to the app but not the spec (or a response
  shape change) passes.
- **Impact:** The spec can drift arbitrarily from the implementation while its "contract test"
  stays green; only path-name deletions are caught.
- **Recommendation:** Parse and schema-validate the document, and diff its path set against the
  app's registered routes (Hono exposes them); ideally validate a few live responses against the
  spec's response schemas.

### TEST-12 — One test file consumes ~60% of the api suite wall time by rebuilding catalogctl per run
- **Severity:** low
- **Location:** `ccp/api/test/createResourceParity.test.ts:36-49` (fresh `go build` into a new temp dir every run), suite log: `createResourceParity.test.ts (29 tests) 41716ms` of 67 s total
- **Description:** The parity harness `go build`s catalogctl into a `mkdtempSync` directory on
  every vitest invocation and then shells out ~30 times (`spawnSync` per case, each creating and
  validating a scratch env). `scheduleWindowCheckParity.test.ts` builds a second copy the same
  way. The Go build cache softens repeat cost, but the api suite's latency (and its sensitivity
  to Go-toolchain hiccups) is dominated by this one file.
- **Impact:** Developer feedback loop and CI minutes; also couples `npm test` in `ccp/api` to an
  undeclared Go dependency (see TEST-4).
- **Recommendation:** Build once to a content-addressed path (keyed on `git rev-parse` of
  `tools/catalogctl` or the go.sum hash) shared by both parity files, or split the parity harness
  into an explicitly toolchain-gated CI job.

---

## Minor observations

- The api suite's single skip in this environment was the LIVE terraform block — expected here
  (no terraform binary), but see TEST-4 for why that skip must be loud in CI.
- `ccp/api/test/scanWorker.test.ts` trips `grep`'s binary-file heuristic (embedded control bytes
  in a fixture string) — harmless, but worth a `--binary-files=text`-style note for future greps.
- Route tests that read the current month's audit partition via `yyyymm(new Date())`
  (e.g. `dualControl.test.ts:50-52`) would flake only if a test straddles a UTC month rollover
  mid-run — negligible, noted for completeness.
- `ccp/api/scripts/restart-survival.ts` (cited by plan OPS-01) and `proof-terraform-executor.ts`
  are manual proof scripts, not part of `npm test`; store-level restart is automated in
  `fileStore.test.ts`, but the full process-restart journey (sessions, TOTP decrypt across
  restart with a fixed `CCP_TOTP_KEY`) runs only when a human runs the script.
- The app suite prints a few intentional `WARN`/`[ccp] … skipped` lines from negative-path tests
  (e.g. `extract-blocks` invalid-JSON handling); they are assertions' side effects, not failures,
  but they make eyeballing CI logs noisier than necessary.
- `importer/kit-azure` (48 tests) is green and includes `reconcile.py` coverage the AWS kit has
  no analogue for; when TEST-1 is fixed, consider porting the azure suite's structure back.
- Golden maintenance is manual (no `-update` flag) — a deliberate and defensible safety choice
  for a Terraform-writing tool, at the cost of tedious fixture edits.
- `ccp-smoke.yml` genuinely runs the install journey (production-posture boot, `/readyz`,
  mock-bundle detection) on every `ccp/**` PR — a rare and valuable installer-rot gate.

---

## Overall grade: B

**Justification.** The TypeScript and Go cores are exemplary — behavior-level API tests over real
DynamoDB-semantics stores, byte-for-byte TS↔Go parity harnesses, a refusal-and-idempotence golden
corpus, injectable clocks, fault injection, and a real (if optional) end-to-end terraform proof;
the request→PR→apply pipeline is far better tested than in most systems of this kind, and a
detailed functional test plan traces manual scenarios to automated pins. But the dimension is
dragged down by process failures at the edges: two Python suites and one Python script suite are
red at HEAD (7+1 failures), no CI lane runs *any* Python test (which is exactly why the broken
importer `split` shipped), the highest-value integration tests can silently skip out of CI with
nothing to notice, the SPA has zero DOM/interaction coverage with ~25 files pinning UI by
source-string grep, and no component measures code coverage at all. Fixing the CI wiring and the
red suites (TEST-1..4) — mostly small, mechanical changes — would move this to an A-.
