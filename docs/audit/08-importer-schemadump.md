# Importer Kit & Schemadump Robustness Audit

Audit date: 2026-07-26
Dimension: `importer` — importer/kit (AWS), importer/kit-azure, tools/schemadump
Auditor scope note: this is an engineering-quality audit (correctness, robustness, error handling, parity, test/CI discipline). Cybersecurity assessment is explicitly out of scope.

---

## Scope & method

Read in full:

- `importer/kit/`: `discover.py`, `discover.sh`, `gen-imports.py`, `normalize.py`, `payloads.py`, `statediff.py`, `verify.sh`, `services.json`, `templates/` (versions/backend), `testdata/` (capture-happy, capture-malformed, capture-unknown, coverage fixtures, generated fixtures, stub-bin), `tests/` (all seven files incl. `kitpaths.py`, fixtures).
- `importer/kit-azure/`: `discover.py`, `discover.sh`, `gen-imports.py`, `normalize.py`, `reconcile.py`, `run-aztfexport.sh`, `verify.sh`, `azure-services.json`, `templates/versions.tf`, `testdata/` (paged/happy/malformed captures, stub `az`/`aztfexport`/`terraform`), `tests/`, `README.md`.
- `tools/schemadump/`: `schemadump.go`, `schemadump_test.go`, `main.go.tmpl`, `gen.sh`, `validate.py`, `types.txt`, `types-azure.txt`, `gen-azure-ledger.mjs` (in full), `gen-azure-capability-reference.mjs` / `gen-azure-provisioning-catalog.mjs` (skimmed), `README.md`, committed artifacts `aws-v6.53.0-schema.json.gz` (metadata inspected via `zcat`) and `azurerm-v4.81.0-schema.json`.
- Consumers / context: `catalog/azure-capability-ledger.json` + `-summary.md`, `ccp/app/scripts/lib/forcenewShared.ts` (dump loading + pins), `ccp/app/scripts/gen-aws-tag-catalog.mjs` and `gen-azure-tag-catalog.mjs` (gz handling, ledger bucket consumption), `.github/workflows/*.yml`, `.gitlab/ci/*`, `scripts/gen-project-data.sh` (python-hcl2 pin), `scripts/drift/` contents, `importer/README.md`, `importer/kit/README.md`.

Executed:

- `python3 -m pytest importer/kit/tests` under the **repo-pinned** `python-hcl2==5.1.1` (pin verified at `scripts/gen-project-data.sh:65,168-169` and `.gitlab/ci/ccp-data.gitlab-ci.yml:19`): **7 failed, 99 passed**. Failures analyzed below (IMP-1, IMP-2).
- `python3 -m pytest importer/kit-azure/tests`: **48 passed**.
- `go test ./...` in `tools/schemadump`: **ok** (all reflection-path tests pass).
- Reproduction runs: `normalize.py split`/`guard` crash reproduction; `kit-azure/discover.py build` on the happy fixture; committed Azure ledger inspected programmatically (family/bucket/safe-op tallies).

---

## Strengths

The two kits are, structurally, some of the most disciplined operational tooling in the repo:

- **Refuse-loud doctrine is real, not aspirational.** Every silent-loss path is either surfaced in the manifest (`ignored[]` with reasons, `unmapped_captures`, `missing_captures`, `manual_followup`, `coverage`) or a typed refusal (`REFUSE <CODE>:`, exit 2) — `importer/kit/discover.py:59-61,343,369-373`, mirrored in `importer/kit-azure/discover.py`. The doctrine is *tested*: e.g. `importer/kit/tests/test_discover.py:60-75,143-171`.
- **Determinism is enforced by test.** `capturedAt` is passed through from `capture-meta.json`, never from the clock (`importer/kit/discover.py:303-314,422`); byte-identical rerun tests exist for discover, gen-imports, statediff and payloads (`test_statediff.py:261-271`, `test_payloads.py:197`).
- **Offline-by-construction pipeline.** Only `discover.sh` touches the cloud; every Python stage reads recorded JSON, so the whole pipeline is fixture-testable. The test harness strips `AWS_*`/`ARM_*`/`TF_TOKEN_*` from subprocess envs and pins stub binaries (`importer/kit/tests/kitpaths.py:51-63`), so a regression cannot reach real credentials even accidentally.
- **Identity guards before any capture.** AWS: 12-digit account check + `sts get-caller-identity` match (`importer/kit/discover.sh:64-67,101-107`); Azure: GUID validation + subscription *and* tenant match, re-checked offline at build time (`importer/kit-azure/discover.sh:52-55,127-141`, `discover.py:377-390`). Both are covered by stub-driven tests (`test_scripts.py` in each kit).
- **Coverage sweeps make the unknown loud.** AWS: `resourcegroupstaggingapi` family sweep with covered/manual/unrecognized bucketing and account-id redaction of sample ARNs (`discover.py:199-278`); Azure: full-type-granularity classification off the primary ARG capture, plus a `BANNED_KQL` guard refusing `limit/take/sample` clauses that would silently suppress ARG paging (`kit-azure/discover.py:64-65,88-93`).
- **`reconcile.py` is a genuinely good idea well executed**: it converts aztfexport's silent best-effort into a set-diff against the ARG ground truth, case-insensitive on ARM ids, with `--strict` refusal (`importer/kit-azure/reconcile.py`). `run-aztfexport.sh` always forces `--hcl-only` and adds a post-hoc `*.tfstate` tripwire (`run-aztfexport.sh:53-70`) — a read-only regression detector rather than trust in a flag.
- **`payloads.py`'s line-scanner withhold semantics** are careful: unterminated/duplicate blocks withhold *only* the affected address, secrets withhold rather than mask, and a failed probe never turns into a refusal (`payloads.py:112-166,271-340`); the decoy-brace and ambiguous fixtures pin exactly these behaviors (`testdata/generated/generated.tf.fixture`, `tests/fixtures/generated-ambiguous.tf.fixture`).
- **schemadump navigates its three real pitfalls correctly**: internal/-package import via in-checkout build, non-SIV module paths via git-tag clone with commit-SHA provenance (`gen.sh:76-116`), and — critically — the lazy `SchemaFunc` schema resolution via `SchemaMap()` (`schemadump.go:184-201`), with a dedicated empty-dump regression test (`schemadump_test.go:71-104`). Framework resources are marked `framework_unreflected` fail-closed rather than guessed. `validate.py` adds hard-coded ground-truth checks (aws_instance/instance_type in-place, availability_zone ForceNew, etc.) and a structural cross-check against `terraform providers schema -json`.
- **The dump-version pin is cross-checked downstream**: `ccp/app/scripts/lib/forcenewShared.ts:21-27` pins `aws v6.53.0`/`azure v4.81.0` and the map build refuses a mismatched dump — a real staleness tripwire for the schema dumps themselves (the generated *catalog* files are a different story — IMP-8).

---

## Findings

### IMP-1 — `importer/kit/normalize.py` `split`/`guard` crash under the repo-pinned python-hcl2 (KeyError, not a refusal)

- **Severity:** high
- **Location:** `importer/kit/normalize.py:105` (crash site `:115-116`); contrast `importer/kit-azure/normalize.py:100-102`
- **Description:** `parse_resources()` calls `hcl2.load(fh)` without `with_meta=True` and then reads `body["__start_line__"]` / `body["__end_line__"]`. On the repo-pinned `python-hcl2==5.1.1` (`scripts/gen-project-data.sh:168-169`), a plain `load()` does not attach the meta keys, so **every `split` and `guard` invocation dies with a raw `KeyError: '__start_line__'` traceback and exit 1** — verified by reproduction (`normalize.py split` against the kit's own `testdata/generated/generated.tf.fixture` → traceback, exit 1) and by 6 failing tests in `importer/kit/tests/test_normalize.py` (all SplitTest and GuardTest cases). The Azure sibling was fixed and even carries a comment explaining exactly this hazard ("required on the repo-pinned python-hcl2 5.1.1 … where a plain load() omits them", `kit-azure/normalize.py:100-101`); the fix was never back-ported to the AWS kit. This is the divergence risk of the copied-not-shared kits materialized.
- **Impact:** Runbook phases 3-4 for a new AWS environment (`split` into per-service files, `guard` inserting `prevent_destroy`) are unusable under the documented toolchain. The failure also violates the kit's own contract ("Exit codes: 0 ok · 2 refusal", `normalize.py:43`): operators get a Python traceback instead of a `REFUSE` message. No data is corrupted (the crash happens at parse time, before any write), but a core pipeline stage is simply broken.
- **Recommendation:** Change `importer/kit/normalize.py:105` to `hcl2.load(fh, with_meta=True)` (identical to the Azure kit), re-run the suite (all 6 tests then pass), and add the pinned-hcl2 test run to CI (see IMP-3) so the two kits cannot drift on this again. Longer term, extract `parse_resources`/`leading_comments`/guard logic into one shared module.

### IMP-2 — `scripts/drift/sweep-ignore.json` is missing: the statediff sweep refuses out of the box

- **Severity:** high
- **Location:** `importer/kit/statediff.py:97` (`DEFAULT_IGNORE`); failing pin `importer/kit/tests/test_statediff.py:220-239`
- **Description:** `statediff.py`'s default (and spec-documented, docstring lines 17-23) ignore file is `scripts/drift/sweep-ignore.json`. That file does not exist — `scripts/drift/` contains only `security-watchlist.json`. `load_ignore_rules()` treats an unreadable file as `REFUSE BAD_IGNORE` (`statediff.py:147-151`), so the documented drift-workflow invocation exits 2 immediately. The test that pins the real file's shape and its direct usability (`test_real_sweep_ignore_json_is_well_formed_and_seeded`, which expects ≥5 rules, the `aws:autoscaling:groupName` tagKey seed and the bootstrap-stack id rows) fails with `FileNotFoundError`.
- **Impact:** The out-of-band-provisioning sweep lane (statediff → candidates → gen-imports → payloads) cannot run with defaults; either the file was never committed or was deleted without updating the three call sites (script default, spec/docstring, test). Because no CI runs this suite (IMP-3), the breakage is invisible until an operator hits it.
- **Recommendation:** Commit the seeded `scripts/drift/sweep-ignore.json` the test describes (bootstrap-stack `id` rows + the ASG `tagKey` rule, every rule with a `reason`), or — if the intent changed — make an *absent* ignore file an explicit, loud-but-legal state (e.g. require `--ignore none`) and update the docstring and test together. Do not silently default to "no rules": the current fail-closed refusal is the right shape once the file exists.

### IMP-3 — No CI executes any importer test suite; two shipped regressions prove the gap

- **Severity:** high
- **Location:** `.github/workflows/` (absence — the eight workflows cover catalogctl/api/app/data/onboard/smoke/publish-gate/release-images only); `.gitlab/ci/` likewise; acknowledged in `importer/kit-azure/README.md:206` ("a developer check, not (yet) a CI gate")
- **Description:** The kits ship 106 AWS tests + 48 Azure tests plus stub binaries specifically built to run with zero cloud access — and nothing runs them. `grep` over `.github/workflows/*.yml` and `.gitlab/ci/*` finds no `unittest`/`pytest`/importer job; the only importer mention in CI is a comment in `ccp-onboard.yml:72`. The schemadump Go tests are likewise unwired. IMP-1 (six failing tests) and IMP-2 (one failing test) are regressions that this missing gate would have caught at introduction time.
- **Impact:** The suite's excellent design (offline, hermetic, credential-stripped) is exactly the kind CI can run cheaply; without it, the kit's correctness decays silently between rare operator uses — the worst possible failure mode for break-glass tooling that is only exercised during high-stakes environment adoptions.
- **Recommendation:** Add a small workflow (or a job in an existing one) that installs `python-hcl2==5.1.1` (read the pin from `gen-project-data.sh --print-pins` to avoid a second pin copy) and runs `python3 -m unittest discover -s importer/kit/tests` and `-s importer/kit-azure/tests`, plus `go test ./tools/schemadump/...`. Gate merges on it.

### IMP-4 — Azure capability ledger family classification is systematically wrong: multi-token `familyMap` keys are unreachable

- **Severity:** high
- **Location:** `tools/schemadump/gen-azure-ledger.mjs:132-139` (`getFamily`), map at `:18-130`; committed evidence `catalog/azure-capability-ledger.json`, `catalog/azure-capability-ledger-summary.md:36`
- **Description:** `getFamily()` classifies a type by its **second underscore token only** (`resourceType.split('_')[1]`), but `familyMap` is keyed by multi-token names (`virtual_machine`, `key_vault`, `managed_disk`, `resource_group`, `user_assigned`, `managed_identity`, `app_service`, `application_gateway`, `log_analytics`, `application_insights`, `express_route`, `private_dns`, `data_factory`, `machine_learning`, `management_group`, …). A second token can never contain an underscore, so **every multi-token key is dead code** and those types fall to `'other'`. Verified against the committed ledger: 662/1141 types are family `other`, including `azurerm_key_vault`, `azurerm_linux_virtual_machine`, `azurerm_virtual_network`, `azurerm_resource_group`, `azurerm_managed_disk`, `azurerm_user_assigned_identity`, `azurerm_windows_web_app`, `azurerm_application_gateway`. Knock-on effects: (a) the `resize` safe-op class requires `family === 'compute'` (`gen-azure-ledger.mjs:175`) — **zero of 1141 types carry `resize`** (summary md: "resize | 0 | 0.0%"); (b) the `engineer_only` family gate (`:195-196`, security/identity/governance) never fires for the map's intended identity/governance types — `azurerm_user_assigned_identity` and `azurerm_resource_group` are emitted as `catalog_candidate` instead of `engineer_only`.
- **Impact:** This is corrupted committed data consumed downstream: `ccp/app/scripts/gen-azure-tag-catalog.mjs:163` skips ledger rows whose `bucket === 'engineer_only'` when wiring portal tag ops, so the intended identity/governance exclusions do not exist, and any future catalog wave consuming `catalog_candidate`/`resize` rows starts from a wrong picture of the provider surface. (The substring `engineerOnlyPatterns` list still catches `role_assignment`, `policy`, `firewall`, `key_vault_`, etc., which limits — but does not eliminate — the leakage.)
- **Recommendation:** Match families with the same longest-prefix approach the pattern list uses (e.g. test `resourceType.startsWith('azurerm_' + key + '_')` over keys sorted longest-first, or normalize the map to reachable single tokens deliberately). Then regenerate the ledger + summary + downstream tag catalog, and add a self-check the generator refuses on (e.g. assert known anchors: `azurerm_linux_virtual_machine → compute`, `azurerm_key_vault → keyvault`, `resize` count > 0) so a dead map cannot ship again.

### IMP-5 — kit-azure `discover.sh` never clears stale page files: a re-run can resurrect deleted resources into the manifest

- **Severity:** medium
- **Location:** `importer/kit-azure/discover.sh:143-172` (paging loop; no pre-capture cleanup) with `importer/kit-azure/discover.py:120-153` (`merge_pages` merges every `<capture>.page<N>.json` present)
- **Description:** Each ARG capture writes `page0..pageN` into `--out`, but nothing removes pages from a previous run before capturing (cleanup happens only on capture *failure*, `:163`). If a re-run — the documented recovery path after `PARTIAL_CAPTURE` ("fix RBAC/scope and re-run", `:192-193`), or simply a later refresh into the same work dir — produces fewer pages than the prior run (estate shrank across a 1000-row page boundary), the stale higher-numbered pages persist and `merge_pages` merges them as if current. Deleted resources reappear in the manifest as live; coverage counts are inflated; duplicates across old/new pages are absorbed as "duplicate of …" ignored rows, masking the staleness. `merge_pages` also merges `<capture>.json` *and* `<capture>.page*.json` when both exist (`:128-137`), double-counting a mixed fixture/live dir. The AWS kit is immune (single file per capture, overwritten each run) — an asymmetry introduced by the paging feature, and no test covers the re-run-with-fewer-pages scenario.
- **Impact:** The manifest is the ground truth for `gen-imports.py` and `reconcile.py`; phantom rows generate import blocks for nonexistent resources (caught later, loudly, at `terraform plan`) and pollute reconcile/coverage reporting — a direct violation of the kit's capture-fidelity doctrine, silently.
- **Recommendation:** At the top of each capture's paging loop, `rm -f "$OUT/$capture".page*.json "$OUT/$capture.json"`. In `merge_pages`, refuse (or at least WARN) when both a single-file and paged form of the same capture exist. Add a stub-driven test: run discover.sh twice with a shrinking `STUB_GRAPH_FILE`, assert the manifest contains only current rows.

### IMP-6 — statediff's managed-set match assumes Terraform state `id` equals the discovery id; false-positive findings for id-divergent types (concrete: `aws_volume_attachment`)

- **Severity:** medium
- **Location:** `importer/kit/statediff.py:191-218` (`state_keys_from_plan`, keyed on `values.id`) vs `importer/kit/services.json:269-282` (`aws_volume_attachment` `id_format` `{Device}:{VolumeId}:{InstanceId}`)
- **Description:** A manifest row is "managed" only when its `(type, id)` exactly equals a prior-state resource's `(type, values.id)`. That holds for most of the 43 types (instance ids, ARNs, names…), but not where the provider synthesizes a state id different from both the list-API id and the import id. `aws_volume_attachment` is a confirmed case: the terraform-provider-aws state id is a computed `vai-<hash>`, while the kit's discovery id (and import id) is `device:volume:instance`. Every Terraform-managed volume attachment therefore shows up as an `unmanaged_resource` finding on every sweep, forever, until someone hand-writes ignore rules per attachment.
- **Impact:** Persistent false positives erode trust in the sweep and push operators toward broad ignore rules (the exact silent-suppression failure the counted-ignore design tries to avoid). Other current/future types with synthesized state ids would silently join the false-positive class.
- **Recommendation:** For id-divergent types, match on a declared state attribute instead of `values.id` (prior_state `values` carries `device_name`/`volume_id`/`instance_id` — services.json could grow an optional `state_id_format`/`state_match` field), or exclude such types from the sweep explicitly with a manifest-visible reason. Add a fixture: a managed volume attachment in `plan-sweep-happy.json` asserting it is *not* a finding.

### IMP-7 — Azure template provider pin (4.14.0) contradicts the committed azurerm schemadump tag (v4.81.0) it claims to bind to

> **Status: the divergence is FIXED on `main` as of `661d247`; the recurrence guard is not.**
> Re-verified while re-anchoring these reports. `661d247` (#7, "kit-azure pin matches its audited dump") moved both Azure pins to 4.81.0, which is the first branch of the recommendation below:
> `templates/versions.tf:17` now reads `version = "4.81.0"` and `run-aztfexport.sh:26` now reads `PROVIDER_VERSION="${AZTFEXPORT_PROVIDER_VERSION:-4.81.0}"`.
> All four copies now agree at 4.81.0 (`versions.tf`, `run-aztfexport.sh`, `tools/schemadump/gen.sh:45-46`, `forcenewShared.ts:26`), so the ForceNew-drift **impact described below no longer applies**.
> The second branch of the recommendation — a cheap consistency check so the copies cannot diverge again — was **not** implemented; nothing compares the template pin to the committed dump filename. That part of this finding still stands.
> The description below is preserved as the record of what was found at `3000920`; the line numbers in **Location** are as of that commit.

- **Severity:** medium (downgraded to **low** on `main` — only the missing guard remains)
- **Location:** `importer/kit-azure/templates/versions.tf:17` (`azurerm = 4.14.0`, comment: "bind to the azurerm schemadump/ForceNew truth at this tag"); `importer/kit-azure/run-aztfexport.sh:26` (`PROVIDER_VERSION 4.14.0`, "keep in lockstep with templates/versions.tf"); vs `tools/schemadump/azurerm-v4.81.0-schema.json` and `ccp/app/scripts/lib/forcenewShared.ts:27` (`azure: 'v4.81.0'`)
- **Description:** The AWS side is coherent (templates, dump and gate all at 6.53.0). The Azure side scaffolds new roots and drives aztfexport at azurerm **4.14.0** while the only committed schemadump — and the app-side ForceNew pin — is **v4.81.0**. The versions.tf comment asserts a binding ("bumping it without a matching schemadump must fail closed") that is already broken in the committed state: there is no 4.14.0 dump, and no gate compares the template pin to any dump.
- **Impact:** ForceNew verdicts computed from the 4.81.0 reflection may not describe the 4.14.0 provider an imported Azure root actually runs (67 minor releases of schema churn), and aztfexport generates bodies against 4.14.0 schemas — the exact silent-drift scenario the comment says is designed out.
- **Recommendation:** Pick one tag: either bump the template + `AZTFEXPORT_PROVIDER_VERSION` to 4.81.0, or regenerate the dump at 4.14.0 and update `PROVIDER_TAGS`. Add a cheap consistency check (a kit test can grep the template pin and compare against the committed dump filename / `forcenewShared` pin) so the three copies cannot diverge again.

### IMP-8 — Committed schemadump artifacts are not reproducible via the documented `gen.sh` pipeline; generated-catalog staleness detection is entirely manual

- **Severity:** medium
- **Location:** `tools/schemadump/gen.sh:41-42,50,63,125`; `tools/schemadump/types-azure.txt:1-17`; committed `aws-v6.53.0-schema.json.gz` metadata (`summary.requested = 1677`)
- **Description:** Three mismatches between the pipeline-as-documented and the artifacts-as-committed: (1) `gen.sh` always passes `-types` (`types.txt`, 85 types, whose header still says "the tool takes this file via -types"), but the committed AWS dump was generated with **no** type filter (`requested=1677`, full provider) — re-running `gen.sh` as written produces a differently-scoped artifact; (2) `types-azure.txt` explicitly instructs "regenerate the full dump with an empty -types filter", which `gen.sh` cannot express (`TYPES="${TYPES:-…}"` treats empty as unset and falls back to the file); (3) `gen.sh` writes `aws-v6.53.0-schema.json` while the repo commits only the `.gz` — the gzip step is undocumented and manual. Separately, nothing in CI regenerates and diffs the `.mjs`-derived catalog outputs (`catalog/azure-capability-ledger.json` etc.), and `gen-azure-ledger.mjs:332` stamps a wall-clock `Generated:` timestamp into the committed summary md, guaranteeing diff noise for any future regen-and-compare check. (The *dump-to-gate* version pin is checked — `forcenewShared.ts` — but dump-to-*ledger* freshness is not.)
- **Impact:** A stale or wrongly-scoped regeneration is undetectable mechanically; IMP-4 shows what an unchecked generated catalog can quietly carry. The reproducibility promise (`PROVIDER=aws reproduces the pre-0039 run byte-identically`, `gen.sh:22-23`) is not true of the committed artifact.
- **Recommendation:** Make full-provider mode a first-class `gen.sh` option (e.g. `TYPES=all` → omit `-types`), gzip in-script for AWS, update `types.txt`'s header to match reality (mirroring the honest supersession note `types-azure.txt` already has), drop the timestamp from the summary md (the dump's `generated_at` is provenance enough), and add a CI job that reruns the deterministic `.mjs` generators against the committed dumps and fails on diff.

### IMP-9 — Azure `discover.py list-subscriptions` crashes on a bare-list capture at the truncation-warning check

- **Severity:** low
- **Location:** `importer/kit-azure/discover.py:342`
- **Description:** `cmd_list_subscriptions` accepts either an ARG envelope dict or a bare list (`data = doc if isinstance(doc, list) else (doc.get("data") or [])`, `:313`), but the page-truncation warning then calls `doc.get("skip_token")` unconditionally — an `AttributeError` traceback when `doc` is a bare list of ≥1000 rows. The mainline `next-token` subcommand guards this correctly (`:294`).
- **Impact:** An unhandled traceback (exit 1, not the documented `REFUSE`/exit-2 contract) in exactly the large-tenant case the warning exists for; small blast radius since `discover.sh` always produces envelopes.
- **Recommendation:** Guard with `isinstance(doc, dict)` as `cmd_next_token` does.

### IMP-10 — `gen-imports.py --id-region-suffix` appends `@region` to global-service ids too

- **Severity:** low
- **Location:** `importer/kit/gen-imports.py:115-117`
- **Description:** The `@<region>` import-id suffix (AWS provider v6 cross-region import convention) is applied to *every* non-ARN id, including region-less resources the same manifest carries: IAM user/group/role/instance-profile names, S3 bucket names, KMS aliases. `terraform plan` over an `aws_iam_role` import id `my-role@ap-southeast-1` will error.
- **Impact:** The flag is unusable for any manifest containing global-service rows (i.e. most real manifests), forcing manual post-editing of exactly the file the tool exists to generate deterministically.
- **Recommendation:** Drive the suffix from services.json (e.g. a per-type `regional: true/false` flag, or reuse `arnHint` families known to be global) and skip global types; refuse if the suffix would apply to none.

### IMP-11 — `payloads.py` block scanner: a column-0 `}` inside a heredoc body truncates the skeleton and ships it

- **Severity:** low
- **Location:** `importer/kit/payloads.py:140-156` (`split_generated`), guard at `:219-224`
- **Description:** The line-scanner ends a resource block at the first line that is exactly `}` at column 0. Generated config can carry verbatim multi-line content (the kit's own fixture uses a `<<-EOT` heredoc); if that content itself contains a line `}` at column 0 (e.g. a captured user_data script emitting JSON), the block is cut short there. The truncated skeleton still "ends with `}`", so `apply_stateful_guard`'s defensive check passes and a syntactically broken `skeletonHcl` is attached as an import payload; the remainder of the real block is then re-scanned as top-level text. The docstring's threat model ("decoy braces inside quoted heredoc content") covers the *opening*-brace case but not the closing one.
- **Impact:** An invalid payload surfaces later as a loud `terraform plan` failure on the adoption PR, not corruption — but the scanner's promise ("structurally suspect — withheld, never guessed") is violated for this shape.
- **Recommendation:** Track heredoc open/close markers in the scanner (line-oriented, cheap: on `<<[-~]?LABEL` suspend end-of-block detection until `LABEL`), or post-validate each extracted skeleton (`ends with }` *and* re-scan finds exactly one header) and withhold on mismatch.

### IMP-12 — `normalize.py split` silently drops non-`resource` top-level blocks

- **Severity:** low
- **Location:** `importer/kit/normalize.py:109-119` (`doc.get("resource", [])` only) and `:170-228`; identical in `importer/kit-azure/normalize.py:106-116`
- **Description:** `split` copies only `resource` block extents into the per-service files; `data`, `moved`, `import`, `locals`, `terraform` blocks and free-standing comments in the input file are dropped without any warning — the only guard is the zero-resources refusal. For pure `-generate-config-out` output this is fine (resource blocks only), but `split` is also documented for aztfexport `--hcl-only` output (kit-azure docstring), and operators may point it at lightly-edited files.
- **Impact:** Contradicts the kits' "never silently dropped" doctrine on an input class the tool plausibly receives; a dropped `moved`/`import` block would change plan semantics invisibly.
- **Recommendation:** After extracting resource extents, diff the covered line set against the file's non-blank/non-attached-comment lines and refuse (or loudly warn + copy to `unclassified.tf`) on uncovered top-level content.

### IMP-13 — Shell scripts: minor robustness gaps around the deliberate no-`set -e` style

- **Severity:** low
- **Location:** `importer/kit/discover.sh:39,109-143`; `importer/kit-azure/discover.sh:42,143-184`; `importer/kit/verify.sh:24,71-77`
- **Description:** Both drivers use `set -uo pipefail` without `-e`, compensating with explicit `||` checks — mostly consistently, but: (a) `mkdir -p "$OUT"`, the `printf … > "$OUT/.capture-plan.tsv"` plan write, and the `cat > capture-meta.json` heredoc are unchecked (a failed meta write surfaces later as a confusing `BAD_CAPTURE`/`ACCOUNT_MISMATCH` from `build`, not as the real cause); (b) `capture-meta.json` interpolates `--region`/`--location` unvalidated into JSON — a stray `"` yields corrupt meta detected only downstream; (c) `verify.sh` steady phase reports any nonzero `-detailed-exitcode` as "plan is not a no-op (exit N)", conflating a plan *error* (exit 1) with genuine drift (exit 2); (d) Azure paging swallows `next-token` refusals (`2>/dev/null`, substitution exit ignored, `discover.sh:167`) — a corrupt page ends paging early and relies on `build` to refuse later (it does, but the stderr evidence is discarded). Quoting elsewhere is careful, `bash -n` is tested, and the single intentional word-split (`$rest`) is documented.
- **Impact:** Failure attribution and edge diagnostics, not correctness of the happy path.
- **Recommendation:** Check the meta/plan writes explicitly; validate `--region`/`--location` shape; distinguish exit 1 vs 2 in verify.sh's steady message; drop the `2>/dev/null` on the next-token call.

### IMP-14 — Stale numbers and dangling references in kit/schemadump docs and comments

- **Severity:** low
- **Location:** `importer/kit/discover.sh:28` ("44-type allowlist" — services.json has 43); `importer/kit/statediff.py:101` (`SWEEP_METHOD` hard-codes "43 per-type listers", correct today but a second copy of the count); `importer/kit-azure/normalize.py:101` and `importer/kit-azure/README.md:195` reference a pin in "terraform.yml", which does not exist (the pin lives in `scripts/gen-project-data.sh` / `.gitlab/ci/ccp-data.gitlab-ci.yml`); `tools/schemadump/README.md` describes the AWS dump as the "85-type case" while the committed artifact reflects 1677 types (see IMP-8).
- **Description/Impact:** Each is harmless alone; together they mean an operator cross-checking the docs against reality finds three contradictions in the first hour — corrosive for break-glass tooling whose docs are the interface.
- **Recommendation:** Fix the counts (or derive them: `SWEEP_METHOD` could interpolate `len(types)`), point the pin references at `gen-project-data.sh`, and update the schemadump README scope description.

### IMP-15 — Coverage-sweep family granularity marks undiscoverable resources as "covered" (documented, but with a concrete silent case)

- **Severity:** low
- **Location:** `importer/kit/services.json:443-455` (`aws_kms_key` discovered only via `kms list-aliases` / `TargetKeyId`) with `importer/kit/discover.py:210-278` (family-level bucketing)
- **Description:** The AWS sweep classifies at ARN *service-family* granularity (deliberately, with the limitation documented in services.json's `$comment` and the README). The sharpest consequence: a KMS key with **no alias** is invisible to discovery (the only KMS lister is `list-aliases`), yet its swept ARN lands in family `kms`, which is "covered" — so the one mechanism built to catch discovery gaps reports this gap as covered. Similar shadows exist for any ec2-family type not among the 16 ec2-backed entries. The Azure kit's full-type classification (`kit-azure/discover.py:239-275`) does not have this problem — parity gap in the AWS direction.
- **Impact:** Unaliased CMKs (common for imported/legacy estates) can be silently absent from an "everything is loud" manifest.
- **Recommendation:** Add a real key lister (`aws kms list-keys`) for `aws_kms_key` (aliases remain the name source), and consider documenting per-family "known undiscoverable types" in `manual[]` so the sweep can at least name the shadow.

---

## Minor observations

- `manifest["errors"]` is always `[]` in both kits' `cmd_build` (`importer/kit/discover.py:345,430`; `kit-azure/discover.py:499`) — a vestigial field that suggests error accumulation that never happens; either populate or drop it.
- `importer/kit/discover.py` and `kit-azure/discover.py` duplicate `to_label`, `match_skip`, `resolve_name`, `refuse`, `_sha256_file` near-verbatim, and `statediff.py` re-implements private copies of `walk_records`/`field` (`statediff.py:264-317`). The kits' README frames kit-azure as a "faithful port"; IMP-1 shows what porting-without-sharing costs. A tiny shared `importer/lib/` (stdlib-only, imported by path) would preserve the offline property while eliminating the drift class.
- `normalize.py check`'s `ATTR_RE` (both kits, `:292`/`:293`) only matches a whole-line `name = "value"`; a trailing comment or an escaped quote in the value defeats the secret scan. Fine for raw generator output, weaker after the manual editing the runbook prescribes between `split` and `check`. The Azure kit at least documents its block-scanning limit (`maskAllValuesInBlocks`); the AWS kit does not state this one.
- `payloads.py` maps candidates to findings by `(tfType, liveId)` with last-wins on duplicates (`payloads.py:250-252`) — harmless today because statediff dedupes upstream, but an assert would be cheap.
- `gen.sh` uses `shasum -a 256` (`:87-88`), which is present on macOS but not guaranteed on minimal Linux images (`sha256sum` is); the hard-coded `PATH` prefix `/opt/homebrew/bin` (`:30`) also marks it as effectively macOS-only tooling. Fine for a manual generator, worth a one-line portability fix.
- Azure `ResourceContainers` in a real tenant includes `microsoft.resources/subscriptions` rows, which land in coverage as `unrecognizedResourceTypes` noise on every build (the happy fixture omits the subscription row, so tests don't show it). Consider adding it to a `manual[].typeHints` or an explicit ignore-in-coverage list.
- `run-aztfexport.sh` has no subscription/tenant identity guard of its own (unlike `discover.sh`); a wrong-context run is only caught later by `reconcile.py`'s id mismatch. Given the wrapper's read-only design this is acceptable, but a one-call `az account show` check would match the kit's guard-early doctrine.
- The schemadump walker ignores SDKv2 `ExactlyOneOf`/`ConflictsWith`/`RequiredWith` and `AtLeastOneOf` constraints — reasonable scope, but worth a "not captured" note in the README since consumers might assume the dump is schema-complete.
- `verify.sh`'s import-phase gate greps `Plan: N to import, 0 to add, 0 to change, 0 to destroy` — correct for current Terraform 1.10 phrasing and covered by stub tests, but silently brittle across future Terraform wording changes; pinning `required_version = "~> 1.10"` in the templates bounds that risk adequately.

---

## Overall grade: C

The design quality here is genuinely high — refuse-loud everywhere, deterministic outputs, hermetic fixture-driven tests, careful identity guards, and schemadump solves a hard reflection problem correctly (lazy schemas, framework fail-closed, provenance). But the audit bar is the shipped state, and the shipped state has four high-severity defects: the AWS kit's `split`/`guard` crash outright under the repo-pinned dependency (IMP-1), the statediff sweep refuses out of the box because its committed ignore file is missing (IMP-2), none of the 154 tests run in CI — which is precisely how the first two shipped (IMP-3) — and the committed Azure capability ledger consumed by catalog wiring is systematically misclassified by a dead lookup table (IMP-4). Two of those are regressions the kits' own excellent test suites detect in under ten seconds. Fixes are small and well-localized; with IMP-1..4 closed and the suites gated in CI, this dimension would sit at a B+/A-.
