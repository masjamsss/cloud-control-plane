# CI/CD & Release Engineering Audit

**Audit date:** unknown-date
**Dimension:** ci-cd
**Repository:** cloud-control-plane (self-service change-management control plane for Terraform-managed AWS estates)

---

## Scope & method

Read in full:

- All eight GitHub workflows: `.github/workflows/{ccp-api,ccp-app,ccp-data,ccp-onboard,ccp-smoke,catalogctl,publish-gate,release-images}.yml`
- Both GitLab estate templates: `.gitlab/ci/ccp-data.gitlab-ci.yml`, `.gitlab/ci/ccp-onboard.gitlab-ci.yml`
- `scripts/publish-gate.sh` (878 lines, all 12 checks), `scripts/gate.sh`, `scripts/gen-project-data.sh`
- `scripts/ci/apply-window-gate.sh`, `scripts/ci/plancheck-gate.sh`
- `scripts/split/publish-gate-allowlist.txt`, `.gitleaks.toml` (header + allowlist)
- `ccp/scripts/run-local.sh` (the smoke's engine), `ccp/api/Dockerfile`, `ccp/app/Dockerfile`, compose build stanzas in `ccp/docker-compose.yml`
- Supporting evidence: `ccp/api/package.json`, `ccp/app/package.json`, `docs/runbooks/account-data-ci.md`, `docs/FUNCTIONAL-TEST-PLAN.md`, `docs/adr/0016-ccp-approval-to-apply-bundle.md`, `tools/catalogctl/windowgate_test.go`, `tools/catalogctl/plancheck_gate_test.go`, `tools/catalogctl/internal/hclops/redact.go` / `redact_test.go`, `ccp/api/test/scheduleWindowCheckParity.test.ts`, `ccp/api/test/createResourceParity.test.ts`, `ccp/api/test/driftBundleSeam.test.ts`, `ccp/api/test/terraformExecutor.test.ts`

Ran:

- `bash scripts/publish-gate.sh --report` on the checkout (clean pass, 2219 files, 69 s; PG-9 SKIP because gitleaks not installed locally)
- A regex probe of the PG-5 secret heuristic against common assignment shapes (see CI-8)
- `python3 -m pytest` in `importer/kit` (**7 failed**, 99 passed) and `importer/kit-azure` (48 passed)
- `go test ./...` in `tools/catalogctl` (all green) and `tools/schemadump` (green)
- Verified via the gitleaks v8.19.0 release notes that the `dir` subcommand the gate invokes was introduced in v8.19.0 — i.e. it does not exist in the v8.18.4 binary CI installs (see CI-2)

Per the audit charter, everything below is framed as robustness/correctness of the delivery pipeline; no security assessment was performed.

---

## Strengths

The delivery engineering here is, file for file, some of the most carefully *written* CI in any repo of this size — the defects are almost all about what is **absent or unwired**, not what is present.

1. **Every workflow explains itself.** Each of the eight workflows opens with a header stating what it gates, why, and what its documented invariants are (`.github/workflows/ccp-onboard.yml:13–24` spells out a trust boundary in the workflow file itself and both GitLab twins repeat it verbatim; `.github/workflows/ccp-smoke.yml:3–9` states exactly what the smoke proves). This is rare and valuable.

2. **Version pins live in exactly one place and are runtime-verified.** `scripts/gen-project-data.sh:70–72` holds the python/node/python-hcl2 pins; the GitHub workflow *reads them out of the script* (`ccp-data.yml:70–90`, `--print-pins`) instead of duplicating them, and the one place GitLab forces a duplicate (the `image:` at `.gitlab/ci/ccp-data.gitlab-ci.yml:29`) is backstopped by the script's own pin check (`gen-project-data.sh:178–194`), which fails loudly on a drifted image. This is the right way to manage GitHub/GitLab duplication.

3. **Deliberate, documented failure-mode design in the data lane.** `gen-project-data.sh:387–405` distinguishes "control plane unreachable" (exit 0, keep the bundle as an artifact for manual upload — `ccp-data.yml:103–110` uploads it with `if: always()`) from "control plane rejected" (hard fail with actionable guidance). `upload-status.json` records what happened. `ccp-data.yml:49–51` uses a concurrency group with `cancel-in-progress: false` so an in-flight upload is never killed by a superseding push — the correct choice for an upload lane.

4. **The publish gate is a thoughtfully engineered scanner.** `scripts/publish-gate.sh` has three explicit scan modes with a documented mode table (lines 36–65), graceful degradation for every missing input (manifest, denylist, jq, gitleaks), a file+substring-scoped allowlist that cannot blanket-exempt a word (`scripts/split/publish-gate-allowlist.txt:17–21`, `_gate_allowlisted` at line 316), and self-referential-noise handling (`GATE_OWN_CONFIG_FILES`, line 336) that keeps the gate's own config in scope for every check except the two it would trivially self-match. Empirically it passes clean on this checkout in 69 s.

5. **Download flakiness treated as a first-class reliability problem.** `publish-gate.yml:24–37` retries the gitleaks fetch with `--retry-all-errors` and documents the observed incident that motivated it ("a red gate should mean 'the gate found something', never 'GitHub's CDN hiccuped'").

6. **The apply-gate scripts are deterministic and genuinely unit-tested.** `scripts/ci/apply-window-gate.sh` isolates the pipeline's only wall-clock read (line 104–106) and injects it into unit-tested Go; `scripts/ci/plancheck-gate.sh` computes/binds the plan digest and hard-fails on mismatch (exit 4, line 83–86). Both are executed end-to-end by `tools/catalogctl/windowgate_test.go:14` and `plancheck_gate_test.go:17` — the tests run the *actual shipped script*, not a copy.

7. **The smoke boots the real thing.** `ccp-smoke.yml` runs `ccp/scripts/run-local.sh --smoke`, which builds the SPA with `VITE_API_BASE` baked, *verifies the base is inlined into the bundle* (run-local.sh:67–71 — a direct guard against silently shipping the mock build), boots the api in production posture so the fail-closed preflight really runs (run-local.sh:76–79), asserts `/readyz` flips to 200 after bootstrap, and verifies the served page is the SPA. This guards the installer surface no other workflow watches.

8. **Estate-side templates pin actions by commit SHA** (`ccp-data.yml:59,84,88,105`; `ccp-onboard.yml:67,116`) — appropriate for files that get copied into foreign repos.

---

## Findings

### CI-1 — Two components' test suites run in no CI at all, and one of them is currently failing
**Severity: high**
**Location:** `.github/workflows/` (absence); `importer/kit/tests/`; `tools/schemadump/schemadump_test.go`; `docs/FUNCTIONAL-TEST-PLAN.md:17`

No workflow anywhere (GitHub or GitLab) runs pytest or touches `importer/`, and `catalogctl.yml`'s path filter covers only `tools/catalogctl/**`, so `tools/schemadump`'s Go suite also runs nowhere. Grepping all workflows for `pytest|schemadump|importer` returns only a comment in `ccp-onboard.yml:72`. The functional test plan claims these are "covered by their own suites" (`docs/FUNCTIONAL-TEST-PLAN.md:17`) — the suites exist, but nothing executes them.

The consequence is not hypothetical: running `python3 -m pytest` in `importer/kit` on this checkout yields **7 failures, 99 passes**. At least one failure is unambiguous checked-in breakage: `tests/test_statediff.py:224` asserts on `scripts/drift/sweep-ignore.json`, a file that does not exist in this repo (`scripts/drift/` ships only `security-watchlist.json`) — evidently removed in the public split with the test left pointing at it. The other class (`test_normalize.py` guard tests failing with `KeyError: '__start_line__'` in `normalize.py:115`) reproduces even with the repo-pinned `python-hcl2==5.1.1` installed. Whether each failure is a code regression or a fixture/toolchain drift, the point is the same: **nobody can see red**, because the suite is wired into nothing. `importer/kit-azure` (48 passed) and `tools/schemadump` (green) happen to pass — but only by luck, not by gating.

**Impact:** the importer toolkit — the documented path for adopting existing environments into Terraform — can regress silently; it already has.

**Recommendation:** add an `importer.yml` workflow (setup-python at the pinned series, `pip install python-hcl2==5.1.1`, `pytest importer/kit/tests importer/kit-azure/tests`) triggered on `importer/**` and `scripts/drift/**`, and extend `catalogctl.yml` (or add a sibling) to run `go test ./...` in `tools/schemadump` on `tools/schemadump/**`. Fix or quarantine the 7 current failures first so the new lane starts green.

### CI-2 — PG-9 (gitleaks) is a silent no-op in CI: the pinned v8.18.4 has no `dir` subcommand, and the script converts the resulting error into PASS
**Severity: high**
**Location:** `.github/workflows/publish-gate.yml:34` (pin); `scripts/publish-gate.sh:762–777` (invocation + count logic)

`publish-gate.yml` installs gitleaks **v8.18.4**. `check_pg9` invokes it as `gitleaks dir "$stage" … --exit-code 0 --no-banner >/dev/null 2>&1` (`publish-gate.sh:762–763`). The `dir` subcommand was introduced in **v8.19.0** (release notes: "Deprecate `detect` and `protect`. Add `git`, `dir`, `stdin`"); v8.18.4 only has `detect`/`protect`. So in the exact environment the workflow constructs, gitleaks exits non-zero with an unknown-command error, all output is discarded by `>/dev/null 2>&1`, the JSON report file stays empty, `[[ -s "$report" ]]` is false, `count` stays 0, and line 777 records **PG-9 PASS 0** — indistinguishable from a genuine clean scan. The install step's `gitleaks version` check succeeds, so nothing in the log looks wrong, and the "not installed → SKIP with warning" path (line 739–743) never triggers because the binary *is* installed.

This matters doubly because the script itself designates gitleaks as the safety net for its own weakest check: "PG-9 (gitleaks) is the authoritative, entropy-aware detector; this check [PG-5] exists to still catch something even when gitleaks isn't installed" (`publish-gate.sh:585–586`). With PG-9 silently dead in CI, the gate's entropy-aware layer does not exist there (see CI-8 for what the remaining heuristic misses). The underlying robustness defect is independent of the version pin: *any* gitleaks failure (bad config, crash, OOM) is converted into PASS rather than SKIP or FAIL.

**Impact:** the flagship always-on backstop of the publish gate reports success in CI without ever scanning; a class of leak the gate advertises catching would sail through.

**Recommendation:** (1) bump the pin to ≥ v8.19.0 (or invoke `gitleaks detect --no-git --source "$stage"` for the pinned version); (2) in `check_pg9`, capture gitleaks' exit code and stderr, and record FAIL (or at minimum SKIP with a loud warning) when the tool itself errors instead of treating an empty report as zero findings; (3) add a canary fixture (a staged file with a known-detectable fake secret in a self-test mode) so a dead scanner can never report PASS.

### CI-3 — Path filters skip validation for cross-component dependencies: app-lib, catalogctl parity, the canonical redaction rules, and the gate scripts themselves
**Severity: high**
**Location:** `.github/workflows/ccp-api.yml:11–17`; `.github/workflows/catalogctl.yml:4–8`

The api is not a self-contained path: it **value-imports** `ccp/app/src/lib/*` via the `@app-lib` alias (`ccp/api/tsconfig.json:13`) — including approval-authority logic (`canApprove`/`canRequest`, `ccp/api/src/routes/requests.ts:5`), policy defaults (`ccp/api/src/domain/config.ts:1`), the shared redactor (`ccp/api/src/domain/drift.ts:6`), and the dependsOn predicate (`ccp/api/src/manifests.ts:4`). But `ccp-api.yml` triggers only on `ccp/api/**`. A PR that edits `ccp/app/src/lib/permissions.ts` runs `ccp-app.yml` and `ccp-smoke.yml` but **never runs the api's typecheck or test suite** — the suite that actually consumes those files for server-side authorization decisions. A signature or behavior break lands on main and is only discovered when the *next* `ccp/api/**` change happens to run CI (or when the smoke happens to crash, which unit-level behavior changes will not).

The same trigger family has three more concrete instances:

- `tools/catalogctl/windowgate_test.go:14` and `plancheck_gate_test.go:17` execute `../../scripts/ci/apply-window-gate.sh` and `../../scripts/ci/plancheck-gate.sh` — but `catalogctl.yml`'s filter is `tools/catalogctl/**` only. **Editing either gate script triggers no run of the tests that validate it** (only `publish-gate.yml` fires, which doesn't execute them).
- `catalog/redaction-rules.json` is the canonical copy of rules that are duplicated as a Go embed (`tools/catalogctl/internal/hclops/redact.go:12–19`, "SYNC OBLIGATION: this copy MUST stay byte-identical") with a drift test at `redact_test.go:276–282` — which only runs when `tools/catalogctl/**` changes. A PR editing only `catalog/redaction-rules.json` runs no workflow that checks the embedded copies, so the fail-closed redaction layers can drift apart on main undetected.
- The api's cross-layer parity suites (`ccp/api/test/scheduleWindowCheckParity.test.ts`, `createResourceParity.test.ts`, `driftBundleSeam.test.ts`) compare the api against the **catalogctl binary and its fixtures** — but a `tools/catalogctl/**` change never triggers `ccp-api.yml`, so a Go-side semantic change that breaks parity is not caught by the parity suite until the next unrelated api PR.

**Impact:** the repo's most safety-relevant shared code (authorization predicates, redaction rules, plan/window gate scripts) can change without the suites that gate it running; breakage surfaces post-merge, on unrelated PRs.

**Recommendation:** add the dependency paths to each workflow's filters: `ccp-api.yml` should also trigger on `ccp/app/src/lib/**`, `ccp/app/src/data/manifests/**`, and `tools/catalogctl/**`; `catalogctl.yml` should also trigger on `scripts/ci/**` and `catalog/**`. Path filters must mirror the import graph, not the directory tree.

### CI-4 — The product's core "CI applies" pipeline is not shipped: nothing invokes plancheck-gate.sh or apply-window-gate.sh, and docs/scripts reference a workflow that no longer exists
**Severity: high**
**Location:** `scripts/ci/plancheck-gate.sh:16–20` / `apply-window-gate.sh:22–25` (claims); repo-wide absence of any consumer; `docs/adr/0016-ccp-approval-to-apply-bundle.md:24`; `ccp/scripts/setup.sh:63`; `ccp/scripts/self-update.sh:174`; `scripts/gen-project-data.sh:64`

The PRD's central loop is "a human approves and CI applies." The two scripts that implement the apply-side gates — plan-digest binding ("approve-this-exact-plan", exit 4 on mismatch) and the window/freeze veto — both state that "the workflow invokes the exact script the test exercises" (`plancheck-gate.sh:19–20`, `apply-window-gate.sh:24–25`), and `plancheck-gate.sh:8` names a `ccp/plan-digest` commit status. **No workflow in this repository — GitHub, GitLab, product-side or estate-template — references either script or that status.** A repo-wide search of every `*.yml`/`*.yaml` confirms zero consumers. The estate templates shipped (`ccp-data.yml`, `ccp-onboard.yml` and their GitLab twins) cover data refresh and onboarding only; there is no template for the plan/approve/apply lane at all.

The surrounding evidence shows this is a scrub artifact rather than a design choice: ADR-0016 describes the flow as running in `terraform.yml` ("CI re-plans in a neutral environment", `0016-ccp-approval-to-apply-bundle.md:24`); `ccp/scripts/setup.sh:63` cites `.github/workflows/terraform.yml TF_VERSION` for its Terraform pin; `ccp/scripts/self-update.sh:174` greps update diffs for `^\.github/workflows/terraform.yml` to warn about toolchain changes (a warning that can now never fire for that path); `gen-project-data.sh:64` says its pins "mirror .github/workflows/terraform.yml portal-data-freshness exactly". That workflow does not exist in this repo.

**Impact:** an adopting estate gets excellent gate *scripts* and no pipeline that runs them — they must hand-assemble the most safety-critical workflow (terraform plan → digest → status → plan-check → window gate → apply) from ADR prose, with all the drift and mis-wiring risk that implies. Meanwhile four shipped scripts/docs point operators at a file that isn't there.

**Recommendation:** ship a reference `ccp-apply.yml` estate template (even if inert-by-default like `ccp-data.yml`) that wires `plancheck-gate.sh` and `apply-window-gate.sh` exactly as the tests exercise them, and posts the `ccp/plan-digest` status; update or annotate the four stale `terraform.yml` references to point at whatever replaces it.

### CI-5 — Whether the api's live parity/integration suites run in CI depends on unpinned runner-preinstalled toolchains; nothing asserts they ran
**Severity: medium**
**Location:** `ccp/api/test/scheduleWindowCheckParity.test.ts:25–30`; `createResourceParity.test.ts:21`; `driftBundleSeam.test.ts:131,174`; `terraformExecutor.test.ts:32,191`; `.github/workflows/ccp-api.yml:30–35` (no setup-go, no terraform pin)

`ccp-api.yml` provisions Node only. The api suite's cross-layer tests build the real catalogctl binary with `spawnSync('go', ['build', …])` and are explicitly "best-effort: SKIP (never fail) when Go is unavailable" — the test's own comment states plainly: "`ccp-api.yml` (this suite's own CI job) does NOT set up Go" (`scheduleWindowCheckParity.test.ts:25–26`). Whether these parity checks execute therefore depends on whatever Go GitHub happens to preinstall on `ubuntu-latest` satisfying `tools/catalogctl/go.mod`'s `go 1.25` directive — an unpinned, changing input. Likewise `terraformExecutor.test.ts:191` gates its live plan→pin→digest-gated-apply block on a runner-preinstalled, version-unpinned `terraform`. A runner image update can silently flip these from "ran" to "skipped" (or run them against a different toolchain), and a green `ccp-api` check does not distinguish the cases.

**Impact:** the suites that prove the TS window-verdict port matches the Go binary verdict-for-verdict — the exact property XLAYER-41 in the functional test plan calls load-bearing — may or may not be running on any given CI day; nobody would notice the difference.

**Recommendation:** add `actions/setup-go@v5` (with `go-version-file: tools/catalogctl/go.mod`) and a pinned terraform install to `ccp-api.yml`; in CI, export an env flag (e.g. `CCP_CI_REQUIRE_TOOLCHAINS=1`) that turns these skips into failures so green means "parity verified", not "parity possibly attempted".

### CI-6 — release-images publishes on any tag with no quality gate, mutable version stamping, and an unconditional `latest`
**Severity: medium**
**Location:** `.github/workflows/release-images.yml:21–29` (triggers), `:56–59` and `:89–92` (tag rules)

The release workflow has no `needs`, no check-suite condition, and no branch/tag restriction beyond the `v*` pattern: pushing a tag at **any** commit — including one whose PR ran no test workflows because of path filtering (CI-3), or an entirely untested branch head — builds and publishes to GHCR immediately. Additional versioning defects:

- `workflow_dispatch` accepts a free-text `version` input (default `0.1.0`) and stamps it from **any ref**, silently overwriting an existing `0.1.0` image in the registry — published version tags are mutable, so "image v0.1.0" is not a stable artifact reference.
- `type=raw,value=latest` is applied unconditionally in both jobs (lines 59, 92). Tagging a maintenance release (`v0.1.1` after `v0.2.0`) or running a dispatch build repoints `latest` backwards.
- The `version` input is never validated (not semver-checked, not compared to `package.json` or an existing tag).
- The two jobs are independent; if `api` pushes and `app-demo` fails (or vice versa) the release is half-published with no rollback or retry story, and there is no concurrency group to serialize competing tag pushes.

**Impact:** a bad or untested commit can become the published `latest` image through normal use of the workflow; consumers pinning a version tag can still receive different bytes after a re-dispatch.

**Recommendation:** gate publishing on the test workflows for the tagged commit (e.g. a reusable-workflow call or `gh api` check-suite assertion as a first job both build jobs `need`); restrict `latest` with `enable={{is_default_branch}}` or metadata-action's `flavor: latest=auto`; validate the dispatch `version` against `^\d+\.\d+\.\d+$` and refuse to overwrite an existing tag; add a `concurrency` group.

### CI-7 — The Docker build path (the documented production install) is never exercised by CI; images are first built at release time
**Severity: medium**
**Location:** `ccp/api/Dockerfile`, `ccp/app/Dockerfile`, `ccp/runner/Dockerfile`, `ccp/scanner/Dockerfile`, `ccp/toolbox/Dockerfile`, `ccp/docker-compose.yml:33–195`; absence in `.github/workflows/`

`ccp-smoke` deliberately runs the docker-free `run-local.sh` path. No workflow ever runs `docker build` on a PR or push: the first time `ccp/api/Dockerfile` or `ccp/app/Dockerfile` is built is inside `release-images.yml` — i.e. during the release itself — and the `runner`, `scanner`, and `toolbox` images plus the `docker-compose.yml` wiring (the actual go-live path via `install.sh` → `docker compose up --build`, compose lines 29–33) are built **only on the operator's machine**. The api image also has real build-time coupling that can rot independently of the api source (the repo-root build context and vendored `app/src` slice, `ccp/api/Dockerfile:15–24`, plus a pinned external docker-CLI download at lines 74–86 whose URL can go stale).

**Impact:** Dockerfile or compose bit-rot is discovered at release time or by the first operator to install — precisely the "installer bit-rot" failure mode `ccp-smoke.yml`'s header says the smoke exists to prevent, but for the path real deployments actually use.

**Recommendation:** add a `docker-build.yml` PR workflow (path-filtered on the Dockerfiles, compose files, and their contexts) that runs `docker build` for all five images (no push, single arch, with buildx cache) and ideally `docker compose config` validation; optionally boot the api container and curl `/readyz` for a containerized smoke.

### CI-8 — PG-5's secret heuristic misses the most common real-world shapes, and its designated backstop is dead in CI
**Severity: medium**
**Location:** `scripts/publish-gate.sh:608` (pattern), `:585–586` (backstop rationale)

The PG-5 pattern is `(_TOKEN|_SECRET|_KEY|[Pp]assword)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9+/=_-]{16,}`. Verified empirically against representative lines:

| Probe | Caught? |
|---|---|
| `ADMIN_PASSWORD=Xq9rT2vLbN8sWd41` | **no** (`[Pp]assword` never matches all-caps `PASSWORD`, the dominant env-var convention) |
| `DB_PASSWD: Xq9rT2vLbN8sWd41` | **no** |
| `apikey = "Xq9rT2vLbN8sWd41abc"` | **no** (`_KEY` requires the underscore) |
| `db_password: Xq9rT2vLbN8sWd41` | yes |
| `API_TOKEN=Xq9rT2vLbN8sWd41` | yes |

Values under 16 chars or containing spaces/symbols outside the base64-ish class also pass. The script explicitly accepts this approximateness because "PG-9 (gitleaks) is the authoritative, entropy-aware detector" (lines 585–586) — but per CI-2, PG-9 currently scans nothing in CI, so the layered design collapses to this heuristic alone there. Also note content checks use `grep -I` (`publish-gate.sh:376`), so a secret inside any binary-classified file is invisible to PG-1…PG-6; PG-8 only catches known blob extensions.

**Impact:** in the gate's real CI posture, an `*_PASSWORD=`-style literal — the most common accidental commit shape — produces zero hard-fail findings.

**Recommendation:** fix CI-2 first (restores the entropy layer); then cheaply widen PG-5: `([_A-Za-z](TOKEN|SECRET|KEY|PASSW(OR)?D)|[Pp]assword|[Aa]pi[_-]?[Kk]ey)` with case-insensitive matching on the name portion, and consider lowering the value-length floor to 12.

### CI-9 — The recurring data lane keeps the silent-skip gate its own sibling workflow documents as a trap
**Severity: medium**
**Location:** `.github/workflows/ccp-data.yml:56`; contrast `.github/workflows/ccp-onboard.yml:55–60`; `docs/runbooks/account-data-ci.md:82–91`

`ccp-data.yml` gates on `if: ${{ vars.CI_RUNNER != '' }}`. `ccp-onboard.yml`'s header explains, about this exact construct: "Guarding on vars.CI_RUNNER … is a trap: an operator who follows the runbook exactly …, the job silently SKIPS, and nothing explains why" — and fixes it for the onboarding lane by gating on `CCP_PROJECT_ID`, a variable the operator must set anyway. The recurring lane kept the trap. The runbook now mitigates with bold documentation ("**required, and easy to miss** … skips silently on every push … this lane's single most common setup failure", `account-data-ci.md:82–91`) — an admission that the design fails in practice. The failure mode is nasty precisely because it is invisible and unbounded: every merge produces a grey skipped job, no data is ever uploaded, and the portal's estate data goes quietly stale.

**Impact:** a predictable misconfiguration turns the freshness pipeline off indefinitely with green-looking CI.

**Recommendation:** gate on `vars.CCP_PROJECT_ID != ''` exactly as `ccp-onboard.yml` does (the template stays inert in the public repo, which sets no project id), keeping `vars.CI_RUNNER` purely as the optional `runs-on` override it already is on line 57.

### CI-10 — Push-trigger path filters omit the workflow file itself on ccp-api and ccp-smoke
**Severity: low**
**Location:** `.github/workflows/ccp-api.yml:14–17`; `.github/workflows/ccp-smoke.yml:17–20`

Both workflows include their own file in the `pull_request` paths but not in the `push`(main) paths, unlike `ccp-app.yml:15–19` and `catalogctl.yml:6–8` which include it in both. A merge touching only the workflow file runs the PR-side validation but no post-merge run on main — so main's checks list won't reflect the changed workflow until an unrelated change fires it, and bisecting a workflow regression on main gets harder.

**Recommendation:** add `.github/workflows/ccp-api.yml` / `ccp-smoke.yml` to their own push path lists.

### CI-11 — Stale toolchain claims: gate.sh advertises checks CI does not run
**Severity: low**
**Location:** `scripts/gate.sh:3–5,130`; `scripts/gen-project-data.sh:64`; `importer/kit-azure/README.md:195`

`gate.sh`'s header says it "mirrors the GitHub Actions workflows (catalogctl, ccp-api, ccp-app, terraform)" and its checkov branch prints "checkov not installed — SKIP (runs in CI)" (line 130) — but no terraform workflow exists and checkov runs in no CI anywhere in this repo, so the local gate reassures developers about a CI backstop that isn't there. Same stale `terraform.yml` citations as CI-4 in `gen-project-data.sh:64` and `importer/kit-azure/README.md:195`. (Note `gate.sh` *does* correctly mirror-and-extend elsewhere — e.g. it runs `gofmt -l` at line 41, which `catalogctl.yml` does not.)

**Recommendation:** update the header and the SKIP message to state the truth ("no CI backstop; install checkov locally for full mode"), or restore the lane.

### CI-12 — Inconsistent action pinning, with a comment that contradicts the file it sits in; setup-go caching is configured to a nonexistent root go.sum
**Severity: low**
**Location:** `.github/workflows/ccp-data.yml:27` vs `:84–88`; `catalogctl.yml:20–22`; `ccp-onboard.yml:94`

`ccp-data.yml:27` says "Action pins follow the repo-wide convention (checkout@v4 / setup-node@v4)" while the file actually pins `setup-python` v6.3.0 and `setup-node` v6.4.0 by SHA — different majors from the "convention" it cites, and different from the mutable `@v4` tags the other six workflows use. Divergent pinning styles and majors across eight files is drift waiting to happen. Separately, `setup-go@v5` in `catalogctl.yml`/`ccp-onboard.yml` enables module caching by default but is given no `cache-dependency-path`; the go.sum lives at `tools/catalogctl/go.sum`, not the repo root, so the cache step warns and module caching is ineffective (a performance gap only — notably there are *no* stale-cache hazards anywhere in the pipelines: all npm caching is lockfile-keyed via setup-node, and no workflow caches build outputs).

**Recommendation:** pick one pinning convention (SHA-pinned everywhere is the better one) and apply it to all eight workflows; add `cache-dependency-path: tools/catalogctl/go.sum` (and the ccp-onboard equivalent) to setup-go.

### CI-13 — The smoke proves boot + serve, not the system's function; PR runs of it are triggered by any `ccp/**` docs change
**Severity: low**
**Location:** `.github/workflows/ccp-smoke.yml:14–20`; `ccp/scripts/run-local.sh:91–120`

What ccp-smoke proves is real and valuable (see Strengths #7) but ends at: `/readyz` 200, bundle-is-not-mock, `index.html` contains `<div id="root">`. No authenticated request, no catalog fetch, no request-lifecycle call is exercised — a regression that breaks every API route except the health endpoints, or a bundle that throws on load, still smokes green. It also serves via `vite preview`, not the nginx config the shipped app image uses (`ccp/app/Dockerfile:35–37`), so the SPA-fallback/caching config is untested (compounding CI-7). Meanwhile the trigger `ccp/**` includes `ccp/docs/**`, spending a full build+boot on documentation edits. Minor doc drift: `run-local.sh:19` documents `APP_PORT` default 4173; the code default is 8800 (line 32).

**Recommendation:** after `/readyz`, add two or three curl assertions through the real surface (e.g. login with the bootstrap OTP, `GET /catalog` via the API, one 401 check), and consider `paths-ignore: ccp/docs/**`.

---

## Minor observations

- **PG-1 allowlist provenance:** `publish-gate.sh:437` allowlists two 12-digit account ids that are not from the documentation-reserved family (`276181064229`, `439286490199`) with no comment explaining what vendor-published ids they are. Each allowlist entry should carry its provenance, or a future maintainer cannot distinguish "AWS-published service account" from "someone allowlisted a leak".
- **PG-6 exempts `package-lock.json` wholesale** (`publish-gate.sh:653`) — a pragmatic trade-off, but a real person's email in a lockfile `author` field would pass; worth a one-line comment acknowledging the accepted gap.
- **PG-7 is vacuous in default mode by construction** (same excludes list builds the scan set) — the script says so honestly at lines 682–685; fine, but it means the escapee check only has teeth in `--tree` mode, which no CI job runs (the assembled-tree rehearsal is manual).
- **Publish-gate performance:** the per-file, per-pattern grep loop (`grep_scan`, lines 373–389) spawns ~15k+ processes; 69 s at 2,219 files. Linear in denylist length too — a private deployment with a long denylist could see multi-minute gates. A single `grep -r --include` pass per pattern (or `git grep`) would cut this by an order of magnitude.
- **Bash version portability:** `publish-gate.sh` needs bash ≥ 4.4 (`mapfile`, `globstar`, empty-array expansion under `set -u`); macOS's system bash 3.2 cannot run it. A version guard at the top would convert confusing errors into an actionable message for private-side operators on laptops.
- **`ccp-app.yml` help gate depends on unpinned runner python:** `npm run help:check` runs `python3 scripts/list-missing-help.py` (`ccp/app/package.json`) with no setup-python step — works on today's ubuntu-latest, silently coupled to the image.
- **No PR-level concurrency groups** on the test workflows — successive pushes to one PR run redundant full suites; `concurrency: { group: ..., cancel-in-progress: true }` would save minutes (correctly *not* wanted on `ccp-data`, which already documents why, lines 48–51).
- **GitLab coverage is estate-templates only, by design** — the control plane's own quality gates (api/app/catalogctl tests, publish gate, smoke) have no GitLab equivalents; a deployment mirroring the product repo to GitLab gets zero CI. Acceptable, but nowhere stated.
- **The GitLab ccp-data twin has no inertness gate** (`.gitlab/ci/ccp-data.gitlab-ci.yml:34` runs on every default-branch commit); it degrades safely only because `gen-project-data.sh:141–144` exits 0 when the scan root is absent — the graceful behavior is in the script, not the pipeline, which is fine but worth knowing when editing the script's soft-fail.
- **Interactive `run-local.sh` prints a hardcoded bootstrap username `putra`** (line 138) — a personal-looking default in an otherwise scrupulously genericized repo; if it is the api's actual seeded name, it belongs in a config constant.

---

## Overall grade: C

**Justification.** What exists is crafted with unusual care: self-documenting workflows, single-source-of-truth version pins verified at runtime, deliberate failure-mode design in the data lane, a smoke that genuinely boots the production posture, and gate scripts that are deterministic and executed by real tests. But the audit question is whether CI *gates what matters*, and there the record is poor: an entire component's test suite runs nowhere and is currently failing on checkout (CI-1); the publish gate's authoritative secret scanner is a silent no-op in the exact environment CI builds for it (CI-2), while its fallback heuristic misses `*_PASSWORD=` (CI-8); path filters don't follow the import graph, so the api's authorization/redaction dependencies and the apply-gate scripts can change without their tests running (CI-3); and the product's central "CI applies" pipeline is simply not shipped, with four files still pointing at the workflow that used to hold it (CI-4). Release publishing is ungated and its version tags are mutable (CI-6), and the Docker path real installs use is never built in CI (CI-7). These are the kinds of gaps that do not announce themselves — several were designed to fail loud and currently fail silent. High craft, materially incomplete coverage: **C**.
