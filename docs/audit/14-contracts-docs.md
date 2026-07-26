# API Contracts, Schemas & Documentation Accuracy Audit

**Dimension:** contracts-docs · **Audit date:** unknown-date

## Scope & method

This audit compared the repository's contract artifacts and documentation against the code that
actually ships:

- **OpenAPI vs routes** — read all 1,277 lines of `ccp/api/openapi/ccp-api.yaml` and compared every
  declared path against the routes registered in `ccp/api/src/index.ts` and every file under
  `ccp/api/src/routes/` (auth, account, requests, admin, migrate, projects, projectData, drift,
  scanJobs, instance), including per-route auth gates, request/response shapes, and error codes.
- **App types vs API store schema** — read `ccp/app/src/types/` (manifest, request, user, project,
  drift, inventory, planSummary, index) against `ccp/api/src/store/schema.ts` (all 24 zod item
  shapes), `ccp/api/src/domain/driftProposals.ts`, `ccp/api/src/domain/feasibility.ts`, and the
  serving projections in `routes/drift.ts` / `routes/projects.ts`; traced consumers
  (`features/drift/driftProposalState.ts`, `ImportDrawer.tsx`, `lib/httpApi.ts`, `lib/api.ts` mock).
- **catalog/** — validated `redaction-rules.json` / `azure-redaction-rules.json` structure, checked
  the three vendored `redaction-rules.json` copies for byte-identity (sha256), and recomputed every
  table in `azure-capability-ledger-summary.md` from `azure-capability-ledger.json` (1,141 rows).
- **Docs vs code** — `README.md`, `ccp/README.md`, `ccp/docs/` (API-SPEC, DOMAIN-MODEL,
  ERROR-STATES, PERMISSIONS, SETTINGS-CATALOG, MAINTAINING-THE-CATALOG, onboarding-runbook,
  go-live), `docs/FUNDAMENTALS.md`, `docs/adr/` (ledger + spot reads), `docs/runbooks/`,
  `tools/catalogctl/README.md` vs `internal/cli/cli.go` and `internal/edit/`. Spot-verified dozens
  of specific claims (settings keys, TTLs, caps, gates, readiness body, ports, catalogctl
  `--server`/`CCP_ONBOARD_TOKEN`, CI workflow files).
- **Env-var completeness** — enumerated every `process.env.*` read in `ccp/api/src` +
  `ccp/api/scripts` (39 variables) and mapped each to its operator-facing documentation
  (`ccp/.env.example`, `ccp/api/.env.example`, `ccp/api/README.md`, `ccp/README.md`,
  docker-compose files, `ccp/docs/go-live.md`).
- **Link integrity** — mechanically resolved every relative `.md` link in every markdown file in the
  tree (excluding `node_modules` and `docs/audit`).

Nothing was executed against a live server; all claims below are anchored to code read directly.

## Strengths

The documentation corpus here is, structurally, among the best I have audited — the dominant defect
class is *staleness against a fast-moving codebase*, not carelessness:

- **Self-aware, evidence-cited docs.** Every code-derived doc (`ccp/docs/API-SPEC.md`,
  `PERMISSIONS.md`, `SETTINGS-CATALOG.md`, `ERROR-STATES.md`, `DOMAIN-MODEL.md`) pins a measurement
  commit, cites `file:line` for every claim, ships a runnable "Regenerate / verify" section, and —
  remarkably — a "Known tensions & caveats" section that honestly documents its own spec-vs-code
  gaps (e.g. API-SPEC.md:250-267 lists the `/catalog` phantom routes, the `/v2` mismatch, and the
  undeclared `plan-summary`/`audit/export` routes).
- **Verified-accurate claims.** Spot checks held up almost everywhere: the four settings keys
  (`routes/admin.ts:156`), session TTLs 12h/30m (`auth/sessions.ts:9-10`), `REAUTH_MS` 10 min
  (`:18`), dual-control 72h expiry (`domain/dualControl.ts:216,346`), 5-device TOTP cap
  (`auth/totp.ts:113`), rate defaults `{50, 20}` (`domain/config.ts:55`), `/readyz` body incl.
  `estates` (`domain/readiness.ts:23-33`), go-live ports 8800/8801, the onboarding runbook's
  `catalogctl onboard --server` + env-only `CCP_ONBOARD_TOKEN` contract
  (`tools/catalogctl/internal/onboard/onboard.go:524-536`), and the referenced CI workflow files
  (`.github/workflows/ccp-onboard.yml`, `ccp-data.yml`, `.gitlab/ci/*`) all exist as documented.
- **Capability ledger summary is exactly right.** Every number in
  `catalog/azure-capability-ledger-summary.md` — the 341/257/543/1141 bucket totals, all 14
  family×bucket rows, and the safe-op-class counts (tag_update 387 = 33.9%, grow_disk 7 = 0.6%,
  tighten_tls 1 = 0.1%, resize 0) — recomputes exactly from `azure-capability-ledger.json`.
- **Redaction-rules vendoring invariant holds.** The three copies (`catalog/`,
  `ccp/app/src/data/`, `tools/catalogctl/internal/hclops/`) are byte-identical
  (sha256 `1dce30a7…`), as `MAINTAINING-THE-CATALOG.md:44` claims, and sync tests exist on both
  engines (`ccp/app/src/test/redact.test.ts`, `tools/catalogctl/internal/hclops/redact_test.go`).
- **One type world where it matters most.** The API validates submits against the *same* bundled
  manifests and the same TypeScript types the SPA uses (`ccp/api/src/manifests.ts:14`,
  `ccp/api/tsconfig.json:13-14` maps `@/*` → `../app/src/*`), structurally eliminating
  manifest-contract drift between front and back end.
- **The manifest count checkpoint is true**: `manifests.test.ts:12` pins 114 and there are exactly
  114 manifest files.
- **Serving projections match the spec.** `publicProject` / `publicProjectSummary`
  (`routes/projects.ts:427-489`) match the OpenAPI `Project`/`ProjectSummary` shapes, including the
  `rawReport`-never-serializes and two-tier disclosure claims; `computeFeasibility`
  (`domain/feasibility.ts:31-43`) returns exactly the documented
  `{eligibleApprovers, feasible, interimProfileWillApply:false}`.

## Findings

### DOC-1 · high · OpenAPI declares two `/catalog/*` endpoints that do not exist — and the parity test pins the phantoms

**Location:** `ccp/api/openapi/ccp-api.yaml:526-529`, `ccp/api/src/index.ts:80-103`,
`ccp/api/test/openapi.test.ts:17-33`

`GET /catalog/manifests` and `GET /catalog/inventory` are declared in the YAML, but `createApp`
mounts only `/instance`, `/auth`, `/requests`, `/admin/migrate`, `/admin/instance`, `/admin`,
`/projects`, and `/scan-jobs` — there is no `/catalog` route group anywhere in `ccp/api/src`; both
paths 404. The SPA never calls them (it uses `GET /projects/:id/manifests` / `/inventory`,
`lib/httpApi.ts:2000-2024`). Worse, the "parity" test `openapi.test.ts` asserts these exact strings
*are present* in the YAML (`'/catalog/manifests:'`, `'/catalog/inventory:'` in the required-path
list), so CI actively entrenches the phantom endpoints: deleting them from the spec fails the build.

**Impact:** any client generated from the YAML — nominally "the source of truth"
(API-SPEC.md:3, FUNDAMENTALS.md row API_SPEC) — calls endpoints that do not exist; the enforcement
mechanism guards the lie.

**Recommendation:** delete both paths from the YAML and from the test's required list (or implement
the routes if the alias is wanted); replace the string-containment parity test with a route-table
diff (enumerate Hono routes at test time and compare against parsed YAML paths in both directions).

### DOC-2 · high · Shipped routes absent from the OpenAPI spec; `POST /requests/:id/apply` is documented nowhere at all

**Location:** `ccp/api/src/routes/requests.ts:834` (plan-summary), `:887` (apply),
`ccp/api/src/routes/admin.ts:692` (audit/export), `ccp/api/src/index.ts:68-76` (healthz/readyz)

Routes registered in code but missing from `ccp-api.yaml`'s `paths`:

| Route | Also documented in API-SPEC.md? |
|---|---|
| `POST /requests/:id/plan-summary` (lead-only, CI records the plan) | yes, flagged "not in YAML" (API-SPEC.md:80) |
| `POST /requests/:id/apply` (ADR-0016 bundle: lead/admin-only, `BUNDLE_DISARMED`/`APPLY_FORBIDDEN`/`BUNDLE_RUNNING`) | **no — absent from API-SPEC's endpoint table, PERMISSIONS.md's §2 matrix, and the YAML** |
| `GET /admin/audit/export` (whole-chain evidence download) | yes, flagged "not in YAML" (API-SPEC.md:111) |
| `GET /healthz`, `GET /readyz` | yes, in an explicit "code-only; not in the YAML" section (API-SPEC.md:26-31) |

The apply route is the most consequential gap: it is the one-click approval-to-apply bundle — the
most privileged verb on the requests surface — and no contract document or endpoint table anywhere
in the repo describes it. It is only *referenced in passing* as "the apply-route precedent" by
PERMISSIONS.md §9 and API-SPEC.md §Drift (see DOC-12).

**Impact:** spec-driven clients, reviewers, and operators have no authoritative description of the
apply verb's auth tier, states, or error codes; the YAML understates the API's mutation surface.

**Recommendation:** add all five paths to the YAML (healthz/readyz may be a separate "infra" tag);
add an apply row to API-SPEC.md's requests table and PERMISSIONS.md §2.

### DOC-3 · medium · OpenAPI `servers: [{url: /v2}]` does not match any deployed base path

**Location:** `ccp/api/openapi/ccp-api.yaml:6`; `ccp/api/src/index.ts:80-103`;
`ccp/app/src/lib/httpApi.ts:1049`; `ccp/docs/go-live.md:106-111`; `ccp/.env.example:23`

The YAML declares base `/v2`. The Hono app mounts everything at the root; the SPA client builds
URLs as `${baseUrl}${path}` with paths like `/auth/login` and no `/v2` segment anywhere; and the
*shipped* reverse-proxy topology (go-live.md nginx block, `ccp/.env.example`'s
`VITE_API_BASE=https://ccp.example.com/api`) exposes the API under `/api`, not `/v2`. No proxy
config in the repo rewrites `/v2`. API-SPEC.md:9 and :256 note the mismatch but the YAML —
"authoritative" — still asserts it.

**Impact:** a client generated from the spec addresses `/v2/auth/login` and gets 404 on every
deployment topology this repo ships.

**Recommendation:** change `servers` to `/` (optionally listing `/api` as the recommended proxied
base), or actually mount the app under `/v2`.

### DOC-4 · medium · Multiple docs and a code header cite `ccp/docs/specs/ccp-api.md`, which does not exist in this repo

**Location:** `ccp/api/src/errors.ts:6`; `ccp/docs/ERROR-STATES.md:107,177-182`;
`ccp/docs/API-SPEC.md:132`; `ccp/docs/onboarding-runbook.md:5`

`errors.ts`'s header says "Statuses and codes are transcribed verbatim from
`ccp/docs/specs/ccp-api.md`"; ERROR-STATES.md's §"Header transcription claim" analyzes that spec
and its Regenerate step 6 `grep`s it; API-SPEC.md points to "specs/ccp-api.md §11.4" for data-plane
detail; the onboarding runbook names "`specs/ccp-api.md` §11" as a companion document. There is no
`specs/` directory under `ccp/docs/` (or anywhere in the tree) — the file stayed in the private
monorepo when the public split was made. The verification command in ERROR-STATES.md fails with
"No such file or directory".

**Impact:** the error taxonomy's claimed provenance is unverifiable; documented verification
procedures fail; readers are sent to a document they cannot open.

**Recommendation:** either publish the spec, or repoint these references at the artifacts that do
exist (`ccp/api/openapi/ccp-api.yaml` + `ccp/docs/API-SPEC.md`/`ERROR-STATES.md`) and drop the dead
grep from the regenerate section.

### DOC-5 · medium · ~100 broken relative markdown links across the published tree

**Location:** repo-wide; representative: `docs/adr/README.md` (10 broken links, incl.
`0020-ccp-data-birth-blank-install.md`, `0021-ccp-control-scope-and-settlement.md`,
`../proposals/README.md`, `../../ccp/DECISIONS.md`, five `../superpowers/specs/*` links);
`ccp/docs/SETTINGS-CATALOG.md:20`, `API-SPEC.md:31,166`, `DOMAIN-MODEL.md:28-29,126-135`,
`ERROR-STATES.md:36`, `PERMISSIONS.md:16`, `onboarding-runbook.md:15,230,264` (all →
`docs/adr/0020-…`/`0021-…`); `docs/adr/0013…md` → `../runbooks/second-approver-enrolment.md`;
`importer/kit/README.md` → `../../docs/cicd.md`, `../../docs/runbooks/new-env-import.md`;
`importer/kit-azure/**` → `azure-subscription-import.md`, `drift-detection.md`,
`emergency-changes.md`; `tools/catalogctl/README.md` → 5 proposal/superpowers paths

A mechanical scan of every relative `.md` link found exactly 100 that resolve to nothing. Three
distinct classes:

1. **Private-split casualties with no public stand-in**: ADRs 0020/0021 are deliberately private
   (ADR README publication note) with public summaries 0029/0030 — yet eight *current, public*
   docs under `ccp/docs/` still hyperlink the private filenames, and the ledger itself links
   `[0020](0020-ccp-data-birth-blank-install.md)` in the 0029 row. `docs/FUNDAMENTALS.md:19-22`'s
   disclaimer covers "dated ADRs citing the planning archive" but not these live cross-links.
2. **Runbooks that never shipped**: `docs/runbooks/` contains only `account-data-ci.md`, but docs
   link `second-approver-enrolment.md`, `azure-subscription-import.md`, `drift-detection.md`
   (also referenced in prose by `ccp/app/src/types/drift.ts:6` as where the drift taxonomy lives),
   `emergency-changes.md`, `new-env-import.md`, plus `docs/cicd.md` and `ccp/DECISIONS.md`
   (named by `ccp/README.md`'s sibling docs and `docs/adr/README.md`).
3. **Planning-archive citations** (`docs/proposals/*`, `docs/superpowers/*`) — covered by the
   FUNDAMENTALS disclaimer for ADRs, but also present in `tools/catalogctl/README.md` and
   `ccp/api/openapi/ccp-api.yaml:995,1070,1105` where no disclaimer applies. `docs/adr/README.md`
   also names `scripts/split/public-excludes.txt`, which does not exist
   (`scripts/split/` holds only `publish-gate-allowlist.txt`).

**Impact:** readers following the docs' own navigation hit dead ends constantly; several "see X for
the full contract" statements are unfulfillable (the drift taxonomy, the second-approver runbook,
the CI/CD doc).

**Recommendation:** add a link-checker to CI (the scan above is ~20 lines of Python); repoint the
live `ccp/docs/` links at ADR-0029/0030; either publish or delete references to the five phantom
runbooks and `docs/cicd.md`; convert planning-archive citations to non-link code formatting per the
FUNDAMENTALS convention.

### DOC-6 · medium · API-SPEC.md states the opposite of current code on `PUT /projects/:id/identity` gating

**Location:** `ccp/docs/API-SPEC.md:129` vs `ccp/api/src/routes/projects.ts:1261-1263`

API-SPEC.md's identity row says: "Callable repeatedly to correct a mistake. **Not gated on project
status or archived.**" Current code fails closed: `if (!isOnboardable(project)) return
apiError(c, "STATE_CONFLICT")` — the route is now restricted to draft/pending-trust and refuses
archived projects, exactly as the (updated) OpenAPI YAML describes at length
(`ccp-api.yaml:876-904`: "GATED to draft/pending-trust, and refused for an archived project
(409 STATE_CONFLICT)"). The doc was measured at d781c25 (2026-07-17-era text with a 2026-07-25
insertion) and the gate was added afterward; the two authoritative-looking documents now
contradict each other, and the human-readable one is wrong.

**Impact:** an operator following API-SPEC.md will attempt a post-trust identity correction and be
surprised by a 409; worse, the doc asserts the *absence* of a safety gate that exists.

**Recommendation:** fix the API-SPEC.md row; add the identity route to the doc's regenerate greps
so the gate's presence is re-checkable.

### DOC-7 · medium · App `DriftProposal` type does not match the wire: `importPayload` has a different shape, and top-level `arn`/`tfType` are mock-only

**Location:** `ccp/app/src/types/drift.ts:302-329` vs `ccp/api/src/domain/driftProposals.ts:563-571`
and `ccp/api/src/routes/drift.ts:221-245`; consumer at
`ccp/app/src/features/drift/ImportDrawer.tsx:65,79`; mock at `ccp/app/src/lib/api.ts:928-929`

Three-way divergence on the served proposal row:

1. The app types `DriftProposal.importPayload` as `DriftImportPayload`
   (`{address, targetFile, importBlock, skeletonHcl}`), but the API serves the *proposal-level*
   payload `DriftImportProposalPayloadSchema` — `{arn, tfType, liveId, targetFile, importBlock,
   skeletonHcl}`, explicitly **without** `address` ("address is not repeated here",
   driftProposals.ts:559-560). The OpenAPI YAML gets this right
   (`DriftImportProposalPayload`, ccp-api.yaml:171-177).
2. Consequently `ImportDrawer.tsx:79` (`payload?.address ?? finding.name`) can never render the
   address in api mode — the fallback always fires. Benign today, but the type actively asserts a
   field the wire never carries.
3. The app type documents top-level `DriftProposal.arn`/`tfType` as "the finding identity this
   proposal pins, so the SPA can match a generated import proposal back to its originating
   finding" (drift.ts:318-324). The store row does carry them (driftProposals.ts:991), and the
   *mock* serves them (api.ts:928-929) — but the real API's `listRichProposals`
   (routes/drift.ts:227-242) omits them from the projection, and the YAML's `DriftProposal`
   schema does not declare them. The actual matcher
   (`driftProposalState.ts:103`, keyed on `finding.importPayload.address` vs `p.addresses`)
   doesn't need them, so this is dead-but-documented contract surface where mock and API disagree.

**Impact:** type-checked code can read fields that are `undefined` in production but populated in
tests/mock — the exact class of bug the shared-types discipline elsewhere in this repo exists to
prevent.

**Recommendation:** split the two payload types in `types/drift.ts` (finding-level vs
proposal-level) to mirror the API; either serve `arn`/`tfType` from `listRichProposals` (and add
them to the YAML) or delete them from the app type and the mock.

### DOC-8 · medium · catalogctl README makes two explicit completeness claims that are false

**Location:** `tools/catalogctl/README.md:63-76` vs `tools/catalogctl/internal/cli/cli.go:29-77`;
README "The `edit` verbs (12)" vs `internal/edit/edit.go:44,144` + `internal/edit/create.go:32`

1. The subcommand table is prefaced "Verified directly against `internal/cli/cli.go` — **this is
   the complete list, no more, no fewer**" and lists six subcommands (`drift-propose`, `edit`,
   `expected-diff`, `onboard`, `plan-check`, `pr-prepare`). `cli.go` registers **nine**: also
   `drift-edit` (:29), `scan-worker` (:71, the ADR-0033 scanner worker), and `window-check` (:77 —
   which the API's own `domain/schedule.ts:24-28` names as its parity oracle).
2. "The `edit` verbs (12) … this *is* the exhaustive list" omits `create_resource`, which is
   dispatched via the create-handler table (`create.go:32`, `edit.go:144`) and present in the app's
   `CodemodOp` union (`types/manifest.ts:38`) — 13 verbs, not 12.

**Impact:** a doc that stakes its credibility on "no more, no fewer" is missing a third of the CLI
surface, including the scanner worker an operator may need to reason about when arming ADR-0033.

**Recommendation:** update both lists; better, generate the table from `cli.go` (each subcommand
already self-registers) or add a doc-parity test like the manifest-count checkpoint.

### DOC-9 · medium · Four operator-facing env vars are undocumented (two of them documented nowhere at all)

**Location:** `ccp/api/src/domain/apply/loop.ts:64,68` (`CCP_APPLY_FROZEN`,
`CCP_APPLY_AUTO_REVERT`); `ccp/api/src/domain/driftProposals.ts:90` (`CCP_DRIFT_IMPORT`);
`ccp/api/src/domain/driftCheck.ts:30` (`CCP_DRIFT_CHECK_CMD`); doc surfaces:
`ccp/api/.env.example`, `ccp/api/README.md`, `ccp/.env.example`, `ccp/docs/go-live.md`

Mapping all 39 env vars the API reads against every operator-facing doc:

- **`CCP_APPLY_FROZEN`** (master freeze for the 0038 auto-apply scheduler — the operator's
  emergency stop) and **`CCP_APPLY_AUTO_REVERT`**: mentioned in *zero* markdown, env-example, or
  compose files — only in code comments.
- **`CCP_DRIFT_IMPORT`**: gates the entire import-flavor submission lane
  (`409 DRIFT_DISARMED` without it, per the YAML's own text) but appears only inside
  `ccp-api.yaml`; absent from `ccp/api/README.md`'s env table, both `.env.example`s, and go-live.md
  — an operator cannot discover how to arm the feature the drift portal renders.
- **`CCP_DRIFT_CHECK_CMD`**: arms the "Start drift check" button; described in API-SPEC.md and
  DOMAIN-MODEL.md prose but absent from the deploy reference (`ccp/api/README.md`, which
  `ccp/README.md:139-143` designates as *the* place "every environment variable … is documented")
  and from every `.env.example`.

By contrast the scanner/forge/instance families are thoroughly covered in `ccp/.env.example` and
`docker-compose.yml` — the gap is specific to the apply/drift arming knobs.

**Impact:** the documented promise "every environment variable … is documented in api/README.md"
is false; the undocumented pair includes the auto-apply *freeze switch*, exactly the knob an
operator needs findable in an incident.

**Recommendation:** add all four to `ccp/api/README.md`'s env table (and the drift/apply ones to
`ccp/.env.example`'s armed-overlay section); consider a test that diffs
`grep -ohrE 'process\.env\.CCP_[A-Z_]+' src/` against the README table.

### DOC-10 · medium · ERROR-STATES.md's "every error code the API can return" is missing 8 taxonomy codes and 6 inline literals

**Location:** `ccp/docs/ERROR-STATES.md:3,93-103,169-171` vs `ccp/api/src/errors.ts:42,140-147,
161-176,259-283` and inline emissions in `routes/drift.ts`, `routes/requests.ts:892-906`

The doc's opening sentence promises "every error code the API can return". Added to the taxonomy
after the doc's measurement commit and absent from its tables: `SCANNER_KEY_INVALID`,
`DRIFT_PROPOSAL_STALE`, `INSTANCE_STALE`, `DRIFT_NOT_ADOPTABLE`, `DRIFT_PROPOSAL_REQUIRED`,
`SCANNER_DISABLED`, `FORGE_CREDENTIAL_REFUSED`, `SCAN_TARGET_REFUSED` (0 occurrences of each in
the doc). The inline-literal table ("expect NOT_FOUND, TOTP_ENROLLMENT_REQUIRED, CANCEL_FORBIDDEN,
REWINDOW_FORBIDDEN, INTERNAL **and nothing else**" — regenerate step 4) is likewise stale: code now
also emits `DRIFT_DISARMED` (7 sites), `DRIFT_CHECK_FORBIDDEN`, `DRIFT_GENERATE_FORBIDDEN`,
`BUNDLE_DISARMED`, `BUNDLE_RUNNING`, `APPLY_FORBIDDEN` as inline `c.json({code…})` literals.
(PERMISSIONS.md §9 documents the two drift literals and asserts "ERROR-STATES.md is unchanged" —
true, and that is precisely the problem.)

**Impact:** the error-taxonomy reference — the doc the SPA and operators are pointed at for every
4xx — silently under-reports the API's error surface by ~14 codes; its own verification command now
produces results that contradict its "and nothing else" expectation.

**Recommendation:** re-run the doc's own regenerate procedure and fold in the drift/scanner/bundle
codes; update regenerate step 4's expectation list.

### DOC-11 · medium · OpenAPI types `ChangeRequest.planSummary` as a string; the API stores and serves a structured object

**Location:** `ccp/api/openapi/ccp-api.yaml:59` vs `ccp/api/src/store/schema.ts:393-400`
(`PlanSummarySchema.optional()`), `ccp/api/src/store/planSummarySchema.ts`,
`ccp/app/src/types/planSummary.ts:37-42`

The YAML declares `planSummary: {type: string}`. Since the plan-summary route landed, the field is
the structured `PlanSummary` object (`{resourceChanges[], counts{create,update,replace,delete,noop},
recordedAt?, runUrl?}`); the schema comment even records that the string shape was "the Stage-0
fiction — no route ever wrote it, so no durable row carries the old shape". API-SPEC.md:261 flags
this; the YAML remains wrong.

**Impact:** a generated client types the field `string` and breaks on every real response carrying
a plan summary.

**Recommendation:** add a `PlanSummary` schema to the YAML (mirroring
`store/planSummarySchema.ts`) and reference it from `ChangeRequest` — alongside declaring the
`plan-summary` route itself (DOC-2).

### DOC-12 · medium · DOMAIN-MODEL.md's entity catalog is missing a third of the store's item types

**Location:** `ccp/docs/DOMAIN-MODEL.md` §2 vs `ccp/api/src/store/schema.ts:941,975,1013,1069,
1105,1144,1176,1279`

The entity catalog (§2.1/§2.2, "Entities, relations, persistence … for the Cloud Control Plane")
has no rows for 8 of the 24 exported item shapes: `InstanceItem` (ADR-0023 identity),
`ProjectDataVersionItem` (the served-data version registry), `ProjectUploadTokenItem` (the CI
credential — the doc itself admits this one at line 32: "not independently catalogued … a
pre-existing gap"), `ProjectScanJobItem`, `DriftReportItem`, `DriftPointerItem`,
`DriftProposalItem`, and `ProjectForgeCredentialItem`. The §5 event catalog *was* extended with the
drift/scanner events, so the doc is half-updated: events for entities the entity catalog does not
contain. The §3 mermaid diagram and §4.2 key-scheme table have the same gaps.

**Impact:** the designated DOMAIN_MODEL/DATABASE fundamental (FUNDAMENTALS.md rows 28-29) does not
describe the drift-telemetry, scanner, data-plane-version, or instance-identity persistence at all
— the newest and least-understood parts of the store.

**Recommendation:** add the missing rows (the schema.ts doc comments contain nearly all needed
prose) and extend the key-scheme table; consider generating the key table from the exported
`*Key()` helpers.

### DOC-13 · medium · Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML prose)

**Location:** `ccp/app/src/types/request.ts:4-46`; `ccp/api/src/domain/apply/scheduler.ts:41,52-53`;
`ccp/api/src/middleware/rateLimit.ts:22`; `ccp/api/openapi/ccp-api.yaml:54`

The server stores `status` as a free string by design, but the three descriptions of its vocabulary
disagree: the scheduler writes `APPLYING`, `HALTED_DRIFT`, `HALTED_APPLY_FAILED` — `APPLYING` is in
the SPA union but the two `HALTED_*` statuses are not (an api-mode SPA rendering a halted request
falls to the type-unsafe path); the rate limiter counts `CHANGES_REQUESTED` as slot-occupying and
`plan-summary` refuses `WITHDRAWN`, yet neither appears in the YAML's known-values prose for
`ChangeRequest.status`; and the SPA union carries many mock-only statuses the server never writes
(documented). DOMAIN-MODEL.md:288 flags the divergence as a known tension; nothing has reconciled
it.

**Impact:** consumers keying on the documented status set will mis-render or mis-filter
scheduler-written states; the wire prose in the authoritative YAML under-describes the values a
client can actually receive.

**Recommendation:** treat the YAML's known-values list as the registry: add the scheduler statuses
and `CHANGES_REQUESTED`/`WITHDRAWN`, and add `HALTED_DRIFT`/`HALTED_APPLY_FAILED` to the SPA's
`RequestStatus` union (with api-mode-only doc comments like `WINDOW_EXPIRED`'s).

### DOC-14 · low · PERMISSIONS.md §9 cites a "§2 apply row" that does not exist

**Location:** `ccp/docs/PERMISSIONS.md:135` ("the apply-route precedent (`routes/requests.ts`
`POST /:id/apply`, PERMISSIONS.md §2's own 'senior-only' apply row)") vs §2's matrix
(PERMISSIONS.md:24-41)

The §2 role×capability matrix contains no apply row — the doc cites itself for content it doesn't
have. Combined with DOC-2, the apply verb (lead-or-admin, `requests.ts:900-903`) is absent from
every permission table in the repo while being used as the *precedent* other rows are calibrated
against.

**Recommendation:** add the apply row to §2 (requester ✘ / approver ✘ / lead ✔ / isAdmin ✔,
`APPLY_FORBIDDEN`, `BUNDLE_DISARMED` off-by-default note) and keep the §9 cross-reference.

### DOC-15 · low · MAINTAINING-THE-CATALOG.md points at a generated-output directory that does not exist in the tree

**Location:** `ccp/docs/MAINTAINING-THE-CATALOG.md:66` vs repo tree (no `docs/operations/`);
generator `tools/schemadump/gen-azure-capability-reference.mjs:262` writes to the same missing path

The "Generated catalog data — regenerate, never hand-edit" list names
`docs/operations/terraform-capability-reference-azure/` as committed generated output. The
directory is absent (evidently excluded from the public split); the generator would recreate it on
run, but as shipped the doc invites readers to consult files that are not there.

**Recommendation:** either commit the generated reference, or annotate the row as
"generated on demand, not committed in the public tree".

### DOC-16 · low · Assorted OpenAPI request/response gaps against route behavior

**Location:** `ccp/api/openapi/ccp-api.yaml:432-436,530-541,648-652,197-202`

- `GET /requests` declares a `cursor` query parameter and a `cursor` response field; the handler
  (`routes/requests.ts:508-541`) reads neither and never paginates — the declared pagination is
  fictional.
- `GET /admin/audit` is described as "uncapped (replaces audit.ts CAP=500)" and declares only
  `cursor`; code supports `?limit=` (default 100, cap 1000 — `routes/admin.ts:678-679`), so it is
  neither uncapped nor limit-less.
- `POST /admin/accounts` body omits the optional `projectId` binding field the handler accepts and
  bases its cross-tenant dual-control classification on (`routes/admin.ts:52,333-336,360`).
- `DriftChangedAttr` omits `pathSegments`, which the API tolerates/passes through and the app type
  documents (`types/drift.ts:17-33`).

**Recommendation:** fix each in the YAML; these are exactly the drifts a schema-driven parity test
(DOC-1 recommendation) would catch mechanically.

### DOC-17 · low · The code-derived docs' line citations have drifted from HEAD

**Location:** e.g. `ccp/docs/DOMAIN-MODEL.md:28` (ProjectItem "schema.ts:536-555" → actually
`schema.ts:793`), `ccp/docs/API-SPEC.md:80` (plan-summary "requests.ts:786-828" → `:834`),
`API-SPEC.md:111` (audit/export "admin.ts:687-690" → `:692`), `API-SPEC.md:30` (healthz
"index.ts:52" → `:68`)

Every code-derived doc pins its measurement commit (d781c25 / 3a77618, 2026-07-17) and warns that
edits shift line numbers, and the regenerate greps are mostly content-anchored — so this is
disciplined staleness, not error. But nine days of heavy development (drift portal, scanner,
identity gating, restore flavor) have moved most citations by 5-260 lines, and some *behavioral*
claims (DOC-6) have inverted. The "Regenerate / verify" sections exist precisely for this; they
have not been re-run.

**Recommendation:** re-run each doc's regenerate section and re-stamp the measurement commit;
consider a CI job that executes the regenerate commands and fails on expectation mismatches.

## Minor observations

- `ccp/api/test/openapi.test.ts` is honestly described by API-SPEC.md:4 as a spec-completeness
  gate, "not a route-by-route code↔spec differ" — accurate, but it means no automation exists for
  the drift class in DOC-1/DOC-2/DOC-16.
- The YAML's security-scheme note "Non-GET also requires X-Ccp-Client header" (`ccp-api.yaml:11`)
  overstates: `/auth/*` non-GET routes and both Bearer token lanes are exempt
  (`middleware/session.ts:73-92`); `/auth/logout` is nominally session-secured by inheritance but
  code clears the cookie without requiring one. Both are already flagged in API-SPEC.md:263,267.
- `/auth/totp`'s YAML summary says the TOTP step is "for approver/lead"; `needsTotp` also covers
  admins and `totpRequired`-pinned accounts, and since ADR-0024 any enrolled account is challenged
  (`auth/totp.ts:67-71`, `routes/auth.ts:149`). Flagged in API-SPEC.md:264; the YAML text remains.
- `ERROR-STATES.md:88` documents `ACCOUNT_LOCKED` and `ENGINEER_REVIEW_REQUIRED` as
  defined-but-never-emitted; still true today (`errors.ts:81,290`) — dead taxonomy entries worth
  pruning or wiring.
- `SETTINGS-CATALOG.md`'s caveats about `allowlist.restrictions` being server-stored but enforced
  by no server read path, and `rate.limits` accepting arbitrary JSON, both re-verified true against
  current code — commendable honesty, but both remain open engineering gaps the doc can only
  describe.
- `ccp/app/.env.example` still frames `VITE_GITHUB_OWNER`/`VITE_GITHUB_REPO` as "GitHub target for
  the generated Terraform PRs (personal repo today)" — pre-multi-project phrasing; the registry now
  carries per-project repos (host-agnostic `RepoRef`), so these build-time knobs deserve a
  "sample/mock-mode only" note.
- The ADR ledger's status discipline (Superseded/Accepted/Proposed with dated banners and
  "0027 is not skipped by accident" notes) is exemplary; only its dead links (DOC-5) let it down.
- `docs/FUNCTIONAL-TEST-PLAN.md` and `docs/runbooks/account-data-ci.md` were skimmed for
  referenced-artifact existence only (workflows and scripts named do exist); a journey-level
  accuracy pass was out of budget for this dimension and is assumed covered by the testing-quality
  dimension.

## Overall grade: B

**Justification.** The documentation *system* is unusually strong: code-derived docs with pinned
commits, file:line evidence, runnable verification sections, and candid self-reported caveats; the
capability-ledger summary and redaction-rule invariants verify exactly; most spot-checked claims
hold. But the artifact the repo designates as the API source of truth — the OpenAPI YAML — declares
two endpoints that don't exist (with a CI test pinning them), omits five that do (including the
most privileged verb on the requests surface, which no document anywhere describes), and carries a
wrong server base and a wrong `planSummary` type; the human-readable API-SPEC now *contradicts*
current code on the identity-gate; the error-taxonomy reference under-reports ~14 codes; and the
public split left ~100 dead links plus references to a spec file that is the claimed provenance of
the error taxonomy. These are real truthfulness defects in the authoritative contracts, kept from
being worse only by the docs' own honesty about their limits — solidly a B, not an A.
