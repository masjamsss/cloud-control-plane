# Audit: catalogctl Go codemod correctness

- **Dimension key:** `catalogctl`
- **Audit date:** 2026-07-26
- **Component:** `tools/catalogctl` — the Go HCL codemod, the only component that writes Terraform on the control plane's behalf
- **Auditor verdict at a glance:** a genuinely careful, guard-dense codebase with strong tests — undermined by one confirmed exit-0 mis-edit class in the shared literal-object parser, plus several latent guard gaps in the less-travelled verbs.

---

## Scope & method

Read in full (all paths relative to `tools/catalogctl/` unless rooted):

- Entry/dispatch: `cmd/catalogctl/main.go`, `internal/cli/cli.go`
- Edit pipeline: `internal/edit/` — `edit.go`, `setattr.go`, `setattrs.go`, `nested.go`, `guards.go`, `value.go`, `listentry.go`, `foreach.go`, `appendblock.go`, `removeblock.go`, `moved.go`, `swapblock.go`, `assoc.go`, `instantiate.go`, `create.go`, `schemablocks.go` (plus skimming `createsupport.go`, `idiomrender.go`, `providershape.go`)
- HCL primitives: `internal/hclops/` — `locate.go`, `splice.go`, `fmtgate.go`, `diff.go`, `redact.go`
- Manifest layer: `internal/manifests/manifests.go` (Validate / ResolveTarget / CIDR policies), `manifest_lint_test.go`
- Verifier: `internal/plancheck/` — `plancheck.go`, `interior.go`, `command.go`, `publicingress.go`
- Drift: `internal/driftpropose/` — `driftedit.go`, `adopt.go` (plus command/digest skim)
- Scheduling: `internal/windowcheck/windowcheck.go`, `internal/estatecfg/estatecfg.go`
- PR prep: `internal/prprep/prprep.go`, `prbody.go`
- Harnesses: `golden_test.go`, `plancheck_test.go`, `plancheck_gate_test.go`, `windowgate_test.go`, `forcesreplace_confirm_test.go`, `driftedit_seam_test.go`, `manifest_lint_test.go`; `sandbox/README.md`; `testdata/` fixture census
- Cross-checked the **shipped production catalog** (`ccp/app/src/data/manifests/*.json`, 1617 operations) against the executor's dispatch tables and the plancheck target-resolution mirror.

Ran (Go 1.24.7 toolchain, module auto-downloads go1.25.0):

- `go build ./...` — **clean** (exit 0)
- `go vet ./...` — **clean** (exit 0)
- `go test ./...` — **all 15 packages pass** (main pkg 5.7s, edit 2.1s, prprep 1.8s, rest sub-second)
- `gofmt -l .` — **clean**
- **Live reproduction experiments** against a built `catalogctl` binary in a scratch area (never touching the repo tree): comment-in-map merge, foreach add/remove with comments, plan-check on a local-keyed foreach, the production `waf-add-ip-set-entry` op, moved_block collision / invalid-identifier renames, dangling-ref prefix false positive, post-edit file permissions. Every finding below marked **[verified by execution]** was reproduced with the real binary; everything else was verified by close reading of the cited lines.

---

## Strengths (concrete)

1. **Fail-closed refusal architecture.** Every unsafe/ambiguous edit is an exit-2 `REFUSE <CODE>` with the tree untouched (`internal/cli/cli.go:90-93`), and the golden harness *asserts* the untouched-tree invariant on every non-zero exit (`golden_test.go:109`). Exit codes (0/2/3/1, plus windowcheck's 5/6) are a real, script-dispatchable contract.
2. **Changed-set invariant proven twice.** `hclops.Splice` re-asserts prefix/suffix byte-identity (`internal/hclops/splice.go:19-24`), and `edit.run` re-proves it independently after the splice (`internal/edit/edit.go:259-263`). `create.go:113` re-proves the EOF-append analog. This is defense-in-depth done right.
3. **Atomic single-file writes.** `edit` writes via temp-file + rename in the target directory (`internal/edit/edit.go:403-420`) — a crash mid-edit never leaves a truncated `.tf`.
4. **The FMT_DIRTY gate** (`internal/hclops/fmtgate.go`) keeps one-attribute edits one-line diffs and blocks edits on non-canonical files rather than reformatting a whole file into an unreviewable diff.
5. **prevent_destroy veto fails closed and is never overridable.** `hasPreventDestroy` treats anything not *provably* false (`var.protect`, `"true"`, unevaluable expressions) as protected (`internal/edit/removeblock.go:143-186`), and `forcesreplace_confirm_test.go:181-198` locks the non-literal encodings. The typed replace-confirmation lane binds confirmation to the exact target address (`edit.go:115-120`, `edit.go:317-322`).
6. **Dynamic-target resolution is a closed map lookup.** `{param:<name>}` tokens resolve only through a discriminator's `Segments` co-domain, whole-token-only, ident-validated at resolve time (`internal/manifests/manifests.go:440-583`) — a request byte can never become HCL syntax. Same doctrine in `idioms.TfLocalName` and `keyTokens`'s escaped-literal fallback (`internal/edit/setattr.go:437-450`).
7. **plan-check is genuinely mechanical and honest.** R1–R7 + create-guard never fail-fast, never guess (ambiguous selectors and unresolvable interiors become INFO, not silent passes — `internal/plancheck/interior.go:79-157`), the `after_unknown` mask is honored recursively, and R6's declared-interior derivation mirrors the executor's attribute resolution through the *same* shared functions (`manifests.AttrFor`, `manifests.ProseAttrToken`, `manifests.IsValueProvider`) so verifier and executor cannot drift on the migrated paths.
8. **Test architecture is unusually strong**: 28 golden scenario groups / 80 cases with byte-exact tree + diff comparison and a second-run idempotency assertion (`golden_test.go:118-129`); the *real* CI gate scripts (`scripts/ci/plancheck-gate.sh`, `apply-window-gate.sh`) are driven offline by `plancheck_gate_test.go` and `windowgate_test.go` including digest binding and freeze-veto cases; `driftedit_seam_test.go` drives the two-command operator sequence end-to-end; `manifest_lint_test.go` lints the *shipped* catalog with a documented ratchet baseline.
9. **Redaction is shared-spec, idempotent and line-count-preserving** (`internal/hclops/redact.go`), with the embedded rules kept in sync with `catalog/redaction-rules.json` by a dedicated test, and both diff sides redacted *before* diffing (`edit.go:289`).
10. **Timezone/scheduling logic is pure and injected** — no wall-clock reads in `windowcheck.Evaluate`, tz data embedded via `time/tzdata` (`cmd/catalogctl/main.go:5`), estate config resolved once (`internal/estatecfg/estatecfg.go:51-64`).

---

## Findings

### CTL-1 — Full-line comment above a map entry corrupts every literal-map edit (duplicate keys, defeated KEY_CONFLICT guard, silent no-op removes) — exit 0

- **Severity:** high (borderline critical — silent config corruption under completely ordinary input)
- **Location:** `tools/catalogctl/internal/edit/setattr.go:375-382` (`parseObject` key-token loop); same bug duplicated in `tools/catalogctl/internal/driftpropose/adopt.go:404-411` (`parseObjectLiteral`)
- **Status:** **[verified by execution]**, three ways, with the real binary against real fixture manifests.

**Description.** `parseObject` walks a literal object's token stream. A single-line comment token *carries its own terminating newline* (`"# note\n"` is one token). The value-loop learned this lesson (the fix at `setattr.go:394-409` is explicitly commented as closing a measured exit-0 corruption on `ec2-add-instance-tag`), but the **key-token loop did not**: a full-line comment sitting on its own line *above* an entry is not a `TokenNewline`, so it is appended into `keyToks`, and `keyString` then yields a key like `"# owner of record\nPIC"` instead of `"PIC"`. Every consumer of `parseObject` then mis-identifies that entry:

1. **`mergeMap` (set_attribute map-merge — every `*-update-tags` / `*-add-tag` op)**: the requested key no longer matches the existing entry, so it is appended as a *new* key. Reproduced on the `s3-update-tags` shape:

   ```
   tags = {
     # owner of record
     PIC        = "user05@example.com"
     CostCenter = "ERP-BASIS"
   +  PIC        = "user09@example.com"     ← exit 0, duplicate key written
   }
   ```

   HCL evaluates duplicate object keys silently last-one-wins (verified with hclsyntax eval), so `terraform plan` shows exactly the requested value — **plan-check R1/R6 pass** — and the corrupted file (stale duplicate line with the old value) lands in the PR and stays in the tree.

2. **`appendForeachEntry` (42 shipped ops)**: the `KEY_CONFLICT` guard ("an add never silently overwrites", `foreach.go:67-74`) compares against the polluted key, never matches, and appends a duplicate. Reproduced: adding `db01 = "disk-low"` to a map whose `db01 = "mem-high"` entry has a comment line above it appends the duplicate at exit 0 — the guard's whole purpose (refusing a value overwrite disguised as an add) is defeated, and last-one-wins means the protected value silently *changes*.

3. **`removeForeachEntry` (25 shipped ops)**: the present key is not found → **exit 0, empty diff, nothing removed**. Reproduced. The pipeline believes the change was applied; downstream, `pr-prepare` dead-ends the request with a misleading `EMPTY_DIFF` refusal, and for a `for_each`-backing map the resource that should be destroyed silently survives.

**Impact.** Comments inside `tags`/config maps are completely normal Terraform. Tag-map operations are the single biggest op families in the shipped catalog (dozens of `append_foreach_entry` / `remove_foreach_entry` / map-merge `set_attribute` ops). Cases (1) and (2) write corrupted-but-valid HCL at exit 0 that passes plan-check; only human diff review can catch it. The same key-loop defect exists in the drift-adopt path (`mergeSingleKey`/`removeSingleKey` via `parseObjectLiteral`), which writes directly into the bundle checkout.

**Recommendation.** In both key-token loops, treat a comment token appearing *before* any key/`=` as entry-terminating trivia: either attach it as leading trivia to the next entry (preserving bytes) or — simpler and consistent with `parseTuple`'s honest posture (`listentry.go:134`, which refuses `NOT_LITERAL` on any comment) — return `ok=false` so the edit refuses instead of corrupting. Add golden cases: map-merge, foreach-add-conflict, and foreach-remove each with a full-line comment above the target entry. Then consolidate `parseObject` and `parseObjectLiteral` into one shared implementation so the next fix cannot miss a copy.

---

### CTL-2 — `moved_block` writes invalid or duplicate-resource HCL at exit 0: no identifier validation, no destination-collision check, no dangling-reference handling

- **Severity:** medium (latent — no `moved_block` op ships in the production catalog today; the verb is live in the executor and golden-tested)
- **Location:** `tools/catalogctl/internal/edit/moved.go:18-61`
- **Status:** **[verified by execution]** for both failure modes.

**Description.** `movedBlock` takes `new_name` from the first non-inventory string param and immediately relabels the block and emits `moved{}`:

1. **No name-safety.** Every other verb funnels structural names through `manifests.IsValidBlockIdent`; `movedBlock` does not. With `new_name: "bad name!"` (the fixture manifest declares no `pattern` bound), the tool wrote at exit 0:

   ```hcl
   resource "aws_instance" "bad name!" { ... }
   moved {
     from = aws_instance.web
     to   = aws_instance.bad name !     ← not even parseable HCL
   }
   ```

2. **No destination-collision check.** Renaming `aws_instance.web` → `app` while `aws_instance.app` already exists produced two `resource "aws_instance" "app"` blocks at exit 0 (verified: `grep -c` = 2). Terraform rejects duplicate resource definitions at plan time, so CI catches it — but the tool's own doctrine (README "Guards are refusals"; `guards.go:16-20` calls invalid-HCL-at-exit-0 "the worst failure mode") says this must be an `ALREADY_EXISTS`-style refusal, exactly as `create_resource` (`create.go:60-64`) and `instantiate_module` (`instantiate.go:18-20`) already do.
3. **No reference rewrite/refusal.** `remove_block` refuses `DANGLING_REF` when the address is still referenced; `movedBlock` neither rewrites references to the old address nor refuses when they exist, so any rename of a referenced resource yields a tree that fails `terraform plan` ("Reference to undeclared resource") at exit 0.

**Impact.** Contained by plan-time CI failure (nothing can auto-apply), but each case is an exit-0 broken tree from a verb whose plancheck rule (R5 moved-zero-delta) can never be reached because the plan itself errors.

**Recommendation.** Validate `new_name` with `IsValidBlockIdent` (exit 2 on failure), refuse when `hclops.Locate` resolves the destination address (mirror `ALREADY_EXISTS`), and either refuse on dangling references to the source address (reuse `danglingRef`) or rewrite them. Add golden refusal cases for all three.

---

### CTL-3 — Shipped catalog op `waf-add-ip-set-entry` can never execute (exit 1 internal error); the corrected manifest exists only in test fixtures

- **Severity:** medium
- **Location:** `ccp/app/src/data/manifests/waf.json:278-281` (declared `append_foreach_entry` on the *list* attribute `addresses`); corrected shape at `tools/catalogctl/testdata/manifests-u5/ops.json` (`append_list_entry`); grandfather entry at `tools/catalogctl/manifest_lint_test.go:86`
- **Status:** **[verified by execution]** against the shipped catalog directory.

**Description.** `aws_wafv2_ip_set.addresses` is a list, and the op carries only one non-inventory param, so `appendForeachEntry` dies at its arity check with a bare **exit 1 "internal error"** (`foreach.go:36-37`: `append_foreach_entry needs key and value params`) — reproduced verbatim. The remove twin (`waf.json:323`) fails differently: `REFUSE NOT_LITERAL: addresses is not a literal map` — a refusal whose message is wrong about the situation. Meanwhile the golden suite proves the *correct* implementation (`append_list_entry` with `maxPrefixLen`/CIDR guards, `testdata/golden/u5-append-list-entry/*`) against a **forked fixture manifest** that was never propagated to the shipped catalog. The lint knows: `foreach-arity\twaf-add-ip-set-entry` sits in `arityBaseline` as grandfathered debt — but the baseline mechanism means a user-facing catalog entry ships in a permanently broken state, surfacing to an L1 operator as an internal error rather than a routed refusal.

**Impact.** One shipped self-service capability is dead on arrival (and its failure mode is the exit-1 class, which the exit-code contract reserves for internal faults, not data problems). More broadly it demonstrates the structural gap in CTL-11 below: goldens validate fixture manifests, not the catalog production actually loads.

**Recommendation.** Flip `waf.json`'s two ip-set ops to `append_list_entry`/`remove_list_entry` (the tested implementation already exists); remove the baseline entry. Also make the foreach arity check a `REFUSE` (exit 2, manifest-shape code) instead of exit 1 — a mis-shaped manifest is bad data, not an internal fault.

---

### CTL-4 — plan-check R1 structurally vetoes every legitimate plan for a `local.`-targeted foreach op

- **Severity:** medium (latent for the shipped catalog — all 67 production foreach ops target resource attributes — but the executor, fixtures and goldens fully support the `local.` shape)
- **Location:** `tools/catalogctl/internal/plancheck/plancheck.go:297-315` (`allowSet` default arm); executor support at `internal/edit/foreach.go:156-168` and `internal/hclops/locate.go:72-79`
- **Status:** **[verified by execution]**.

**Description.** For a foreach op whose inventory target is `local.legacy_host_alarms` (the shape `hclops.Locate` and `foreachMapAttr` explicitly support, and which `testdata/golden/append-foreach/add-key` exercises), the R1 allow set is `{target, target[...}` — i.e. only the `local.` address itself. But editing a `for_each` source map changes the *consuming resources'* instances. Reproduced: a plan creating `aws_cloudwatch_metric_alarm.host["newhost01"]` after an `fx-append-foreach` add is refused:

```
VIOLATION address-subset: aws_cloudwatch_metric_alarm.host["newhost01"] — changed
address is outside the request target set {local.legacy_host_alarms}   (exit 2)
```

So the executor happily authors an edit whose only honest plan can never pass the L2 gate — the op class is unusable end-to-end, and nothing in the test suite catches the contradiction because plan fixtures for foreach ops only use the resource-attribute shape.

**Impact.** Fail-closed (never passes a bad plan), but it makes a supported manifest shape a guaranteed pipeline dead end, discovered only after approval + CI plan.

**Recommendation.** Either teach `allowSet` to model `local.` targets (e.g. resolve the consuming resources, or accept `[<key>]`-suffixed instance changes for the requested key across resource types — conservatively, only `create`/`update` of instances keyed exactly by the added/removed key), or refuse `local.`-targeted foreach ops at manifest lint time so the shape cannot ship. Add a plan fixture either way.

---

### CTL-5 — `drift-edit` writes are neither atomic nor transactional: a mid-batch refusal leaves earlier edits in the checkout

- **Severity:** medium
- **Location:** `tools/catalogctl/internal/driftpropose/adopt.go:147` (`ApplyAdopt` → bare `os.WriteFile`); `internal/driftpropose/driftedit.go:358` (`appendImportBlock` → bare `os.WriteFile`); batch loops at `driftedit.go:141-210` and `driftedit.go:256-333`
- **Status:** verified by reading (write-path and control flow).

**Description.** Two departures from the `edit` pipeline's discipline:

1. **Non-atomic writes.** `edit` goes through `atomicWrite` (temp + rename); `ApplyAdopt` and `appendImportBlock` call `os.WriteFile` directly. A crash/ENOSPC mid-write can leave a truncated `.tf` in the bundle checkout — precisely the "partial edit" the spec comment on `atomicWrite` (`edit.go:402`) promises never to produce.
2. **Refusal-after-write.** The adopt loop interleaves per-verdict gates and writes: if verdict *k* fails eligibility/watchlist/ungenerable (`return 2` at `driftedit.go:175/181/185/196`) after verdicts 1..k-1 already wrote, the process exits 2 **with a modified tree** — breaking the "non-zero exit ⇒ untouched tree" invariant that `golden_test.go:109` enforces for `edit` (the caller's checkout is scratch, but the contract asymmetry is real and undocumented). Same shape in the import loop.

**Impact.** Limited today (the bundle gate discards a failed checkout), but any future caller that treats exit 2 as "nothing happened" — as every `edit` caller correctly does — will mis-handle drift-edit.

**Recommendation.** Route both writes through `atomicWrite` (export it or copy the 15 lines), and either pre-validate all items before the first write (two-phase: gate everything, then apply) or explicitly document that drift-edit's exit 2 does not imply an untouched checkout.

---

### CTL-6 — `danglingRef` substring scan falsely refuses removal when another resource's name extends the target's name

- **Severity:** medium
- **Location:** `tools/catalogctl/internal/edit/removeblock.go:190-213`
- **Status:** **[verified by execution]**.

**Description.** The dangling-reference guard is a raw `bytes.Contains` for the address string. `aws_ebs_volume.data` is a prefix of `aws_ebs_volume.data_archive`, so any *reference to the other resource* (`aws_ebs_volume.data_archive.id`) matches. Reproduced: removing a completely unreferenced `aws_ebs_volume.data` refuses `DANGLING_REF: aws_ebs_volume.data is still referenced elsewhere` (exit 2). The comment admits the scan is "naive" per spec, but prefix-named siblings (`app`/`app_server`, `data`/`data_archive`) are the norm in real estates, and `remove_block` backs 40 shipped ops.

**Impact.** Fail-closed (never deletes something referenced), but it turns legitimate self-service deletions into spurious engineer escalations, eroding the self-service value proposition — and the refusal message asserts something false.

**Recommendation.** Bound the match with an identifier-boundary check (next byte after the match must not be `[A-Za-z0-9_-]`), or scan hclsyntax traversals instead of raw bytes. Add a golden case with a prefix-named sibling.

---

### CTL-7 — plancheck's `inventoryAddr` does not skip `role:"reference"` inventory params, diverging from the executor's `targetAddress`

- **Severity:** low (one shipped op affected today, harmlessly; the drift is a loaded gun for future manifests)
- **Location:** `tools/catalogctl/internal/plancheck/plancheck.go:319-328` vs `tools/catalogctl/internal/edit/edit.go:385-400` (and the third copy, `internal/prprep/prprep.go:213-222`, which *does* skip references)
- **Status:** verified by reading plus a scripted census of the shipped catalog.

**Description.** `edit.targetAddress` and `prprep.inventoryAddr` both take the first `source:"inventory"` param whose role is **not** `"reference"`; `plancheck.inventoryAddr` takes the first inventory param unconditionally. A census of the 1617 shipped ops found one divergent op — `ec2-provision-instance`, where plancheck would bind `key_pair` (a reference) while the executor binds `iam_instance_profile`. Today that op is `create_resource`, whose R1/create-guard path never consults `inventoryAddr` and which has no grow-only params, so R4/R6 are unaffected — but the first non-create op authored with a reference param ahead of its target silently gets a wrong plancheck target: R1 would then veto every legitimate plan (fail-closed but broken), and R4/R6 would look for interiors on the wrong resource.

**Recommendation.** Make `plancheck.inventoryAddr` skip `Role == "reference"` (one-line change) and add a lint asserting the three copies resolve identically per op — or better, share one exported resolver in `internal/manifests`.

---

### CTL-8 — `atomicWrite` silently changes edited-file permissions to 0600 and skips fsync

- **Severity:** low
- **Location:** `tools/catalogctl/internal/edit/edit.go:403-420`
- **Status:** **[verified by execution]** (`stat` after edits: 644 → 600).

**Description.** `os.CreateTemp` creates the temp file 0600; the rename then replaces a (typically 0644) `.tf` with a 0600 file. Git ignores non-executable mode changes so CI is unaffected, but on shared runners/checkouts other users lose read access after any edit, and the tool alters an observable property of files it promises to touch only inside the located block's byte range. Additionally there is no `File.Sync()` before rename, so the atomicity promise is only rename-atomic, not crash-durable.

**Recommendation.** `os.Chmod` the temp file to the original file's mode (or 0644 for new files) before rename; call `tmp.Sync()` before `Close`.

---

### CTL-9 — `pr-prepare`'s UNAPPROVED gate accepts any non-empty approvals list without checking `decision`

- **Severity:** low (defense-in-depth gap; the API is the authoritative quorum keeper)
- **Location:** `tools/catalogctl/internal/prprep/prprep.go:84-86`; `internal/request/request.go:83` (`Decision` field, loaded but never evaluated)
- **Status:** verified by reading.

**Description.** The gate is `len(req.Approvals) == 0`. A request whose only approvals entry carries `decision: "reject"` (or `"changes_requested"`) passes the UNAPPROVED check and is bundled into a PR — the Decision column is rendered in the PR body (`prbody.go:36-39`) but never enforced. The digest split-brain check (`ApprovedDigest`) is likewise decision-blind: a rejection's digest participates in the "quorum agrees" computation.

**Recommendation.** Count only entries whose `Decision` is the approve value (and refuse on any explicit reject in the list); the strict YAML loader already guarantees the field can't be silently missing due to a typo.

---

### CTL-10 — Duplicated literal-object token-walkers (edit vs driftpropose) have already diverged in behavior

- **Severity:** low (process/maintenance defect that directly enabled CTL-1's second copy)
- **Location:** `tools/catalogctl/internal/edit/setattr.go:357-470` vs `tools/catalogctl/internal/driftpropose/adopt.go:386-496`
- **Status:** verified by reading.

**Description.** The drift copy was consciously re-implemented ("unexported there, so re-implemented rather than imported", `adopt.go:305-316`) and has already drifted: the edit copy tolerates a newline inside key tokens by mis-parsing (CTL-1) where the drift copy returns `NOT_LITERAL` for a mid-key newline (`adopt.go:406`), yet both share the comment-in-key bug. `jsonToCty` is a third near-copy of `anyToCty`. Every future fix must now be applied N times.

**Recommendation.** Extract the object-literal parse/build (and the any→cty conversion) into a small shared internal package; keep the op-specific policy (azure case-folding, ensure-create) at the call sites.

---

### CTL-11 — Golden coverage runs against forked fixture manifests, not the shipped catalog; comment-bearing fixtures are absent

- **Severity:** medium (test-coverage gap; this is how CTL-1 and CTL-3 survived a green suite)
- **Location:** `tools/catalogctl/golden_test.go:31` (default `testdata/manifests`); fixture manifests under `testdata/manifests*`; the only shipped-catalog tests are the lints in `manifest_lint_test.go:32`
- **Status:** verified by reading and by the two escapes it permitted.

**Description.** Every golden/plancheck case exercises a fixture manifest (`testdata/manifests`, `-fx`, `-u5`, …). The shipped catalog (`ccp/app/src/data/manifests`, 1617 ops) is only *linted* (strict decode, prose-attr ratchet, arity ratchet) — never *executed*. Consequences observed in this audit: a corrected op shape lives only in fixtures while the shipped op is broken (CTL-3); and no `before/` tree anywhere contains a full-line comment inside a map, so the highest-traffic op families (tag maps) have zero coverage for the single most common real-world formatting feature (CTL-1). The trailing-comment regression *is* unit-tested (`setattr_test.go:238-276`) — the fixture gap is specifically leading/full-line comments.

**Recommendation.** (a) Add a smoke lane that executes a representative request per shipped `codemodOp` × service family against the *real* catalog dir (dry-run is enough — exit-code and diff-shape assertions). (b) Add comment-rich `before/` fixtures (full-line comments above entries, trailing comments, commented lists) for map-merge, foreach add/remove, and list ops.

---

## Minor observations

- **R7 does not model the legacy `aws_security_group_rule` resource** (`internal/plancheck/publicingress.go:43` covers `aws_security_group` inline + `aws_vpc_security_group_ingress_rule` only). No shipped op emits the legacy resource today, and edit-time `cidrPolicy` is the primary guard, so this is a belt-and-braces gap only.
- **R2's Delete-op count includes replace actions** (`plancheck.go:108-121` counts any `changed && contains(delete)`), so a Delete op planning one *replace* and zero pure destroys satisfies "exactly one destroy"; in practice R3 blocks the replace unless `forcesReplace`, so the composite gate holds.
- `moduleName` for `instantiate_module` R1 is best-effort and explicitly untested "by design" (`plancheck.go:332-344`) — fine while instantiate is a frozen always-refuse, worth revisiting when an overlay lands.
- `keyString` (`setattr.go:424-435`) strips quote tokens but not escape sequences, so a quoted map key containing `\"` never byte-matches its request form — merge would append a duplicate. Pathological keys only; folds into the CTL-1/CTL-10 rework.
- `dash` and `dashRaw` in `prbody.go:78-90` are byte-identical functions.
- Grow-only reads (`currentNumber`, `setattr.go:223-242`) exit 1 when the current value is an expression (`var.x`) — fail-closed and acceptable, but a `REFUSE NOT_LITERAL` would be a more honest code than an internal error.
- The `panic` sites are init-time embed invariants only (`hclops/redact.go:37`, `driftpropose/digest.go:69,117`) — acceptable.
- `sandbox/` is documentation-only (Docker not installed here); `run.sh`'s credential-refusal and `-backend=false` claims match the README, but nothing in CI executes the container — it stays paper-verified, as its README admits.
- README's fixture count ("28 scenarios") matches reality (28 groups, 80 case dirs) — rare and appreciated.

---

## Overall grade: **B**

The core discipline is excellent — refusal-first architecture, double-proven splice invariants, atomic writes on the main path, a mechanical plan verifier that never guesses, and a test harness that drives the real CI scripts and asserts untouched-trees and idempotency. `go build` / `go vet` / `go test` / `gofmt` are all clean. What keeps this from an A is that the flagship guarantee — "never a wrong edit at exit 0" — is broken today by CTL-1 for the single most common op family (tag maps with comments), duplicated into the drift path, and invisible to the otherwise-strong test suite because fixtures avoid comments and goldens never execute the shipped catalog (CTL-11, with CTL-3 as the proof it matters). The remaining findings are latent guard gaps (moved_block, local-foreach plancheck, drift-edit write discipline) in the fail-closed direction. Fix CTL-1 + CTL-11 and this is an A-grade component.
