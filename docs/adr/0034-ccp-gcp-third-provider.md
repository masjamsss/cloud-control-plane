# ADR-0034: GCP as the third cloud provider — the 0015 seam widens to `gcp`/`google`, in lanes, fail-closed at every stage

**Status:** Proposed (design + first seam lane — the G1 mechanical seam lands on this
ADR's own branch; every content lane after it is gated on its named evidence, and no
GCP operation is offered to anyone until lane G2's verified ForceNew truth exists)
**Date:** 2026-07-26
**Deciders:** repo owner
**Evidence:** a three-way census of this tree (app/api seam · Go tooling and provider-data
pipeline · importer kits, CI, doctrine), run for this ADR on 2026-07-26. Every claim below
carries its file:line. ADR-0015 is the binding precedent; its proposal (0039) is a private
planning record — cited as history, not as a link (`docs/FUNDAMENTALS.md:19-22`), so this
ADR is written self-contained, per the 0032/0033 pattern.

## Context

ADR-0015 decided: *a project declares its cloud provider; everything provider-specific
resolves through that declaration; everything that makes the portal trustworthy gains zero
provider awareness.* It also predicted this ADR: *"onboarding any further provider becomes
data + curated tables, not architecture (the sandbox already denies `GOOGLE_*`)"*
(`0015:82-83`). This ADR takes that prediction to the test for Google Cloud (the
`google` Terraform provider, portal key `gcp`) — and the census says the prediction holds,
with named exceptions.

### Where Azure actually is (the honest baseline)

Azure is at **S4** of 0015's ladder: S0/S1/S3 complete, S4 substantially complete
(16 azure manifests / 388 ops; the full 1,141-type azurerm ForceNew reflection at
`tools/schemadump/azurerm-v4.81.0-schema.json`; golden fixtures under
`tools/catalogctl/testdata/golden/*-azurerm/`), S2 partial (the exporter kit
`importer/kit-azure/` is built; its federated bootstrap stack is not in this tree), and
S5 not built **for anyone** — the only executor that ships is `DryRunExecutor`
(`ccp/api/src/domain/apply/executor.ts:4-9`). GCP inherits that reality: rules 6 and 7 of
0015 apply verbatim, so a GCP apply lane cannot even be started here.

### What the census verified as genuinely provider-neutral (no GCP work)

- Governance, approvals, 2FA, audit, dual-control, sessions — zero provider strings
  across `ccp/api/src/domain/*` and every route except `projects.ts`.
- The estate data lane: `scripts/gen-project-data.sh:8-13` is *declared* and verified
  provider-agnostic (static `*.tf` parse; no cloud, no terraform).
- CI: all 8 GitHub workflows + both GitLab twins carry **no cloud credential of any
  provider** by invariant (`ccp-onboard.yml:13-24`), machine-enforced by
  `projectsLifecycle.test.ts:596-599` — which already asserts the rendered CI templates
  never mention `GOOGLE_(APPLICATION_)?CREDENTIALS`.
- Prescan's provider-source allowlist already admits `hashicorp/google`
  (`tools/catalogctl/internal/prescan/prescan.go:40` — `registry.terraform.io/hashicorp/*`),
  so a GCP estate repo can be prescanned and trust-acked **today**; it fails only at
  registration and in the catalog — exactly where fail-closed wants it to fail.
- Plan-check R1–R6 and R8–R11, the drift envelope/partition/digest machinery, manifest
  lint rules, `golden_test.go` itself, and the sandbox/scanner credential guards
  (`GOOGLE_*` stays denied — the guards are about the scan process holding no
  credentials, orthogonal to which provider an estate uses).

### The choke points (what a third provider actually touches)

The provider knowledge is **not** one seam. It is ~17 Go/data choke points and ~30
app/api conditional sites, concentrated as follows:

| Cluster | Load-bearing sites |
|---|---|
| Declared unions | `ccp/app/src/lib/providerDisplay.ts:3` (`CloudProvider`), `ccp/app/src/types/projectSchema.ts:36`, `ccp/api/src/routes/projects.ts:209` + `ccp/api/src/store/schema.ts:815` (z.enums), `openapi/ccp-api.yaml` ×4 |
| Registration/identity contract | `projects.ts:196-200` (id regexes), `:116-189` (region/location allowlists), `:227-260` (`refineIdentityShape`), `:266-273` (`IDENTITY_KEYS`), `:350-371` / `:410-420` / `:617-626` (write/projection/register branches), `schema.ts:901-911` (`isIdentityConfirmed`) |
| Go codemod tables | `internal/edit/providershape.go:11,26-31`, `internal/edit/guards.go:57` (`createResourceTypeShape`), `internal/idioms/idioms.go:33` (`AddressShapeRe`, mirrored by `hclSkeleton.ts:98` `ADDRESS_SHAPE`), `internal/edit/idiomrender.go:98-100` (`preventDestroyTypes`, mirrored by `hclSkeleton.ts:444-452`) |
| Per-provider safety data | schemadump registry (`tools/schemadump/gen.sh:35-56`), ForceNew maps + adjudications (`ccp/app/src/data/forcenew-*`), pinned tags (`ccp/app/scripts/lib/forcenewShared.ts:26`), capability ledger (azure: generated JSON; aws: the `awsServices.mjs` taxonomy — **the repo has one of each pattern**), redaction rules (azure precedent: a separate file, never the ×3-vendored canonical), drift security watchlist (`scripts/drift/security-watchlist.json`) |
| Plan-check provider twins | R7 `publicingress.go` (aws) / `publicingress_azure.go` — the recipe is a sibling file + one unconditional append at `plancheck.go:248` |
| Onboarding surfaces | `internal/prescan/providerconfig.go:185,199,210,300` + api `ProviderConfig` (`schema.ts:606-618`; server ships fields **before** the CLI emits them, `:627-638`), importer kit contract (`importer/kit-azure/` is the template: 8 code artifacts + templates + stubbed tests, federation-only auth) |
| Display/catalog | `serviceMeta.ts` binary ternaries, per-provider service maps + Vite globs (`providerCatalog.ts:66-71`), glyphs/categories, `catalog.ts:236-284` (fail-closed provider filter — verified: an unknown provider derives `[]`, never the AWS catalog) |

### The two findings that make "just add the enum value" unsafe

1. **Fail-open-to-AWS dispatches.** ~11 sites treat "not azure" as "aws":
   `providerOfType` (`providerDisplay.ts:12-14`), `SchemaDumpPrefix`
   (`providershape.go:26-31`), `refineIdentityShape` (`projects.ts:238,242`),
   `isIdentityConfirmed` (`schema.ts:903-910`), `identityFieldsFor` /
   `identityProjection` / the register branch, `projectCloudLabel`, `getServiceMeta`,
   `palette.ts:219-223`, `providerCatalog.ts` index ternary. Introducing `gcp` without
   converting these means a GCP project silently validates, displays, and
   schema-checks **as an AWS one** — including through the `IDENTITY_UNCONFIRMED` gate
   that guards the CI data lane, and including validating `google_*` HCL against the
   AWS schema dump. This is a silent-wrong-answer class, not a loud-failure class.
2. **The drift security watchlist fails open for every non-AWS provider.**
   `scripts/drift/security-watchlist.json` is 100% `aws_*` (60 type entries, 44
   creation-security entries, zero `azurerm_*`), and `Hit()` /
   `ScreenCreationSecurity()` (`internal/driftpropose/watchlist.go:102-123`,
   `importwatchlist.go:25-37`) answer `false` for unknown types — so a
   `google_project_iam_binding` (or `azurerm_role_assignment`) discovered out-of-band
   is **portal-importable** with no security screen. Azure shipped with this hole;
   GCP must not, and Azure's must be closed by the same lane (G6).

### Other defects the census surfaced (fixed or assigned by this ADR)

- `guardKnownBlock`'s deferral predicate (`schemablocks.go:110`) is `aws_`-only while
  its owning guard refuses via `IsProviderResourceType` (aws+azurerm) — the refusal
  code for an `azurerm_`-named nested block varies with schema availability. Fixed in G1.
- `schemablocks.go:282-285` still claims "no azurerm schemadump exists yet"; the full
  v4.81.0 dump is committed and discovered. Comment corrected in G1.
- The Go/TS `prevent_destroy` tables have **diverged**: `hclSkeleton.ts:444-452`
  carries 3 aws + 4 azurerm types, `idiomrender.go:98-100` carries the 3 aws only — a
  portal draft for an Azure VM create shows a `lifecycle` guard the codemod does not
  write. Re-mirrored in G1.
- `importer/kit-azure/templates/versions.tf` pins `azurerm = 4.14.0` while the audited
  dump/ForceNew tag is v4.81.0 — under the 0007-C1 version-binding doctrine
  (`ccp/docs/onboarding-security.md:157-162`) a project born from the kit has no
  version-matched safety data. Aligned in G1.
- `forcenew-adjudications-azure.json` is literally `{}` (legal — fail-closed — but it
  means every azurerm verdict rests on reflection alone); `publish-gate.sh` PG-4 knows
  AWS `AKIA` key shapes but not GCP service-account JSON keys; `docs/FUNCTIONAL-TEST-PLAN.md`
  has zero Azure journeys (provider #2 never got them — provider #3 journeys are
  net-new for both). Assigned to lanes G6/G8, not silently absorbed.

## Decision

**Google Cloud becomes the third supported provider, through the same doctrine as 0015 —
provider is a property of a project — built as independent lanes, each behind its own
evidence gate, with the fail-open dispatches converted to explicit fail-closed tables
before any `google_` type flows anywhere.** Portal key `gcp`; Terraform layer name
`google` (mirroring the `azure`/`azurerm` split). GCP identity =
**`gcpProjectId` + `gcpRegion`** (prefixed — unlike Azure's bare `subscriptionId`, a bare
`projectId` would collide with the registry's own project id).

Binding rules — 0015's seven, re-affirmed per provider, plus three born from this census:

1. **Fail-closed parity** — no GCP operation exists until its replace/disrupt verdict is
   verified against the `google` provider schema at the project's pinned version.
2. **Federation only** — Workload Identity Federation everywhere; **no service-account
   JSON keys, ever** (`projectsLifecycle.test.ts:599` already enforces the CI face of
   this; the kit template enforces the estate face).
3. **One provider per Terraform root; one root per estate; scoped credentials per estate.**
4. **Governance untouched** — approval/2FA/roles/audit files are out of scope by definition.
5. **AWS must not notice — and now azurerm must not either.** Every seam change ships
   with byte-identical golden proof for **both** incumbent providers
   (`golden_test.go`'s `bytes.Equal` tree+diff gate; the azure fixtures are now part of
   the "must not notice" set).
6. **The bridge/executor, whenever built, reads provider/scope from project config from
   day one.**
7. **GCP apply arms last** — after the AWS apply lane proves the guardrails, and after a
   GCP rehearsal against a scratch project.
8. **No fail-open dispatch survives the seam lane.** Every `else = aws` branch the census
   names becomes an explicit per-provider table/switch; residual defaults are documented
   at the site and pinned by a test, never implicit.
9. **The sandbox denial of `GOOGLE_*` stays** (`sandbox/run.sh:13`,
   `onboard.go:604-618`, pinned by `contract_test.go:27`). Nothing in any GCP lane may
   relax it — schema-only work needs no credentials, same as both incumbents.
10. **Ordering: server before CLI** for every new wire field (`schema.ts:627-638`) —
    api-side `ProviderConfig`/identity schema ships in the same commit as, or before,
    any catalogctl emitter of the field.

### The lanes

Independent where possible, each with entry conditions and an exit gate. G1 lands with
this ADR; G2 gates every catalog-content lane after it.

| Lane | Scope | Exit gate (evidence) |
|---|---|---|
| **G1 — mechanical seam** (this branch) | Widen the declared unions (`CloudProvider`, both z.enums, OpenAPI); registration contract (`GCP_PROJECT_ID` regex, `GCP_REGION_ALLOWLIST`, 3-way `refineIdentityShape`/`isIdentityConfirmed`/projections, `IDENTITY_KEYS`); Go tables (`providerTypePrefixes`, `createResourceTypeShape`, `AddressShapeRe`+`ADDRESS_SHAPE`, `SchemaDumpPrefix` → fail-closed table); prescan `providerConfig` `gcpProjectId`/`gcpRegion` census + api schema (rule 10); plan-check **R7-google** twin over `google_compute_firewall`; golden groups `*-google/` proving the codemod writes well-formed `google_*` HCL; the census-surfaced defects above; every fail-open conversion (rule 8) | `go test ./...` green with **zero pre-existing aws/azurerm fixture edits**; app+api suites green; a registered `gcp` project renders an **empty catalog** (fail-closed), never the AWS one |
| **G2 — ForceNew ground truth** | `tools/schemadump` `case google)` arm + `main-google.go.tmpl` (**the honest risk of this whole ADR**: terraform-provider-google is heavily plugin-framework, and every `framework_unreflected` type is fail-closed dead weight — the reflected fraction is the go/no-go measurement, per the 0015 "[Likely] proven or stopped" clause); pinned tag; `PROVIDER_TAGS.gcp`; `build-forcenew-map --provider gcp`; attribution update (`tools/schemadump/README.md:232-238` names only aws/azurerm today) | Committed `google-v<tag>-schema.json` + reflection stats reviewed; `forcenew-map-gcp.json` builds; the reflected-fraction number is in the PR body, and the owner accepts it or stops the ladder here |
| **G3 — capability ledger** | `gen-google-ledger.mjs` + `catalog/google-capability-ledger.json`; decide ledger-vs-taxonomy (azure has a generated ledger, aws a hand-curated `.mjs` — GCP follows the **azure/ledger** pattern: `google_<product>_<resource>` naming needs its own family map, zero reuse from azure's 80 Azure-token entries) | Every reflected type classified catalog-candidate / engineer-only / review-needed; summary committed |
| **G4 — catalog content** | `google-*.json` manifests + service tiles/glyphs/categories + `provider-catalog-gcp` tree + third Vite glob; GCP label-key guard in the codemod (`GCP_LABEL_KEY_INVALID` — labels are lowercase-bounded, the analog of azure's `TAG_KEY_CASE_COLLISION` at `setattr.go:286-290`); baseline skeleton goldens + GCP create idioms (`project`+`region`/`zone` args — a third structural pattern distinct from AWS provider-region and Azure per-resource `location`, `hclSkeleton.ts:717-718`) | `verify:safety` green with gcp in scope; golden + skeleton fixtures byte-pinned; manifest-lint `coreServices` extended |
| **G5 — importer kit** | `importer/kit-gcp` per the kit contract (8 code artifacts + templates + stubbed tests); Cloud Asset Inventory captures (the Resource-Graph twin); WIF-only `providers.tf` + `backend "gcs"` with identity-based state auth; two-axis identity guard (project **and** org/folder — the `TENANT_MISMATCH` precedent, `kit-azure/discover.sh:127-131`); `clean_env()` strips `GOOGLE_/CLOUDSDK_/GCLOUD_` | Kit tests green offline via stub binaries; `verify.sh` reused near-verbatim; `docs/FUNDAMENTALS.md:39` PROJECT_INIT row gains the kit README **in the same commit** |
| **G6 — safety data** | `catalog/gcp-redaction-rules.json` (separate file, azure precedent — never the ×3-vendored canonical; needs `private_key`, `credentials`, `oauth_token`, plus `projects/`-path allowlist prefixes); drift watchlist `google_*` curation **and closing the fail-open for azurerm in the same pass**; `publish-gate.sh` PG-4b service-account-JSON key shape; azure adjudications debt noted to owner | Watchlist screens `google_*`/`azurerm_*` security types fail-closed; publish gate catches a planted GCP key fixture |
| **G7 — read-only presence** | `gcp-fixture` vendored project (hand-authored, generic, `example-org` — the ADR-0029 blank-install shape); identity-confirm flow proven end to end (`PUT /projects/:id/identity` with gcp fields); glossary GCP block | The azure-fixture test suite pattern passes for gcp; a gcp project registers → scans → pending-trust with zero code edits |
| **G8 — docs & journeys** | Onboarding runbook + onboarding-security "where the first scan may run" stay provider-neutral (verify, don't fork); FUNCTIONAL-TEST-PLAN gains provider-#2 **and** #3 journeys (the Azure gap is named debt, not precedent); MAINTAINING-THE-CATALOG per-provider regeneration rows | Docs regenerate/verify sections re-run; FUNDAMENTALS rows added same-commit |

Lanes G2→G3→G4 are sequential (each consumes the previous artifact). G5, G6, G8 are
independent of G2–G4 and of each other. G7 needs G1 only. **Apply (S5) is not a lane
here** — rules 6–7.

## Options considered

### Option A: widen the 0015 seam — provider as project property, staged lanes (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — the census counts ~17 Go/data + ~30 app/api touch points, but they are enumerated, concentrated, and half are compile-error-guided (`Record<CloudProvider, …>` exhaustiveness breaks loudly on widening) |
| Cost | Seam is days; the real lifts (google reflection walk, catalog curation, kit) are needed under any option and are the same data-not-architecture pattern Azure proved |
| Team familiarity | High — every pattern (sibling R7 file, golden group per behavior, separate redaction file, ledger generator, kit contract) has a worked azure precedent to copy |

**Pros:** one portal, one governance core, one safety story; the third provider is the
test that the 0015 seam is real, and the census says it is.
**Cons:** every safety data set now exists ×3 and per pinned version; the fail-open
conversions touch validated code paths and need the byte-identity gate taken seriously
(now for two incumbents).

### Option B: a parallel GCP portal (fork)
**Pros:** zero risk to incumbent lanes. **Cons:** duplicates the governance core — the
exact reason 0015 rejected it, now ×3. Rejected.

### Option C: wait for the AWS apply bridge, retrofit GCP later
**Pros:** focus. **Cons:** 0015 already paid for the seam precisely so later providers
would not need to wait; the bridge reads provider from project config by rule 6, so
there is nothing to wait *for* at the seam layer. Rejected knowingly, same as 0015-C.

### Option D: coverage via `gcloud`/REST instead of the `google` provider
Loose, unbounded surface defeats the bounded-forms philosophy; anything the provider
cannot express routes to the existing beyond-catalog engineer lane. Rejected as a
non-goal, mirroring 0015-D.

## Consequences

- **Easier:** the fourth provider. The fail-closed dispatch tables, the two-incumbent
  golden gate, and the lane template make the next one (should it ever come)
  data + curated tables with no architecture discussion at all.
- **Harder:** three ForceNew maps, three watchlist blocks, three redaction files, three
  pinned versions to keep honest; the G2 reflection walk is genuinely uncertain
  (plugin-framework fraction) and is deliberately allowed to stop the ladder.
- **Unchanged, by design:** both two-admin ceremonies; the credential-denial contracts
  (`GOOGLE_*` denied before and after); every governance file; the apply posture
  (DryRun only, for all three providers alike).
- **Revisit:** the reflected-fraction go/no-go after G2; region-vs-zone granularity for
  `gcpRegion` if zonal resources dominate the first estate's catalog; whether the AWS
  service taxonomy should migrate to the ledger pattern once two providers use it.

## Action items

1. [x] Census (three-way, 2026-07-26) — findings recorded above with file:line.
2. [x] G1 mechanical seam — **built on this branch** (2026-07-26): the fail-closed
       dispatch tables land on both sides of the seam (Go `providerSchemaPrefixes`;
       app `providerOfType`/`isIdentityConfirmed`/`refineIdentityShape` as exhaustive
       switches), gcp registers/confirms/walks the ladder with its own
       `gcpProjectId`+`gcpRegion` identity, every catalog surface derives empty for
       gcp, R7-google guards `google_compute_firewall`, five `*-google` golden groups
       + r7-google plan fixtures prove the codemod, and the census defects (deferral
       predicate, stale dump comment, prevent-destroy re-mirror, kit-azure 4.14.0 pin,
       publish-gate PG-4b) are fixed. Exit gate met: zero pre-existing aws/azurerm
       fixture edits; Go, api (1137), and app (2677) suites green.
3. [ ] Owner reads the G2 risk paragraph and greenlights the reflection-walk attempt
       (or stops the ladder at a registrable-but-catalogless GCP, which is a working
       deployment, not a broken one).
4. [ ] G2–G4 sequential behind their gates; G5/G6/G8 in parallel at will; G7 after G1.
5. [ ] Flip to Accepted on the owner's word; ledger row updated in the same commit as
       this file (per `docs/adr/README.md` discipline).
