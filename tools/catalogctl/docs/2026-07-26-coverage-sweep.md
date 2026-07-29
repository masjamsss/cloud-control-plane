# catalogctl coverage sweep — 2026-07-26

An exhaustive pass over every package in `tools/catalogctl`: raise statement
coverage, and fix what writing the tests uncovered.

**Result: 81.57% → 93.51% of statements** (924 → 328 uncovered of ~5 050),
252 new test functions, **11 source defects fixed**, one lint rule added, and a
CI gate so none of it silently erodes.

Baseline measured at commit `3000920`.

---

## 1. Coverage

### Per package

| Package | Before | After | |
|---|---:|---:|---|
| `internal/cli` | 27.3% | **100.0%** | the single entrypoint — was the worst in the module |
| `internal/scanworker` | 59.7% | **99.4%** | |
| `internal/onboard` | 70.1% | **98.8%** | biggest single file gap (`onboard.go`, 95 uncovered) |
| `internal/prprep` | 72.5% | **96.1%** | |
| `internal/prescan` | 79.1% | **98.3%** | |
| `internal/driftpropose` | 80.3% | **91.2%** | |
| `internal/edit` | 82.4% | **88.0%** | largest package (1 577 statements) |
| `internal/plancheck` | 87.6% | **94.5%** | |
| `internal/manifests` | 88.5% | **100.0%** | |
| `internal/request` | 91.1% | **100.0%** | |
| `internal/idioms` | 91.3% | **100.0%** | |
| `internal/hclops` | 92.0% | **97.6%** | |
| `internal/windowcheck` | 96.1% | **100.0%** | |
| `internal/estatecfg` | 100.0% | **100.0%** | already full; behavioural cases added |
| **TOTAL** | **81.57%** | **93.51%** | |

Six packages are now at 100%.

### What the tests aim at

The bias is the **refusal contract**, not happy paths — the guards are the
product. Tests assert the exit code (`0` ok · `2` refusal · `3`
resolution/schema · `1` internal), the exact `REFUSE <CODE>: <reason>` line, and
that a refusal writes nothing rather than a partial file.

Properties now pinned that previously had no test at all:

- `terraform init` never runs for an untrusted or rejected repo.
- The scan clone's hardening argv — `clone.go` itself says *"a test can assert
  the hardening flags are present without running git — the flags ARE the
  security property"*, and that function was uncovered, so the property was
  unpinned.
- The grow-only `SHRINK` guard, reading the current value from file bytes.
- The security watchlist failing closed when the file is absent.
- Every `internal/cli` dispatch arm, including each "not wired" branch and
  `expected-diff`'s `--dry-run` prepend.

### Measuring it yourself

```bash
cd tools/catalogctl
go clean -testcache      # REQUIRED — see the note below
go test -count=1 -coverprofile=cover.out -coverpkg=./... ./...
go tool cover -func=cover.out | tail -1
```

> **Stale-cache trap.** Without `-count=1` (or a clean test cache) Go reuses
> cached results whose coverage profiles carry *pre-edit line numbers*. Merged
> against fresh profiles they inflate the statement total and understate
> coverage — a run during this work reported 79.34% over 5 957 statements when
> the real figure was 93.51% over 5 054. If the statement total moves by
> hundreds between runs, the cache is the reason, not your change.

### What is deliberately still uncovered

`internal/edit` is the floor at 88.0%. Five of the fifteen writer agents did not
finish (see §4), so `edit.go` (56), `idiomrender.go` (28), `schemablocks.go`
(18), `removeblock.go` (17) and `driftedit.go` (33) retain most of their
original gaps. That is the obvious next increment.

Separately, a handful of blocks are genuinely unreachable and were left alone
rather than contorted into coverage — for example `onboard.go`'s
`VERSION_UNPARSEABLE` refusal *was* dead code (nothing could make
`versionSatisfies` return an error) until defect **B1** below made it live.

---

## 2. Defects found and fixed

Every one was found by writing a test for an uncovered branch. Each fix carries
a regression test.

### Fail-open — the serious ones

**B1 · `onboard`: the `required_version` gate failed open.**
`parseVer` coerced a non-numeric segment to `0`, so `">= v2.0.0"` parsed as
`[0,0,0]` and an installed terraform **1.15.7 compared greater and was
accepted** for a repo demanding 2.x. `parseVer` now tolerates a leading `v`
(HashiCorp's own parser does) and errors on anything else non-numeric — which
also makes the `VERSION_UNPARSEABLE` refusal reachable for the first time.
*Also fixed a new unit test that had cemented the old zero-coercion.*

**B2 · `manifests`: `LoadDir` silently dropped duplicate op ids.**
`ops[op.ID] = op`, last glob-order write wins. The surviving definition can
carry a laxer `riskFloor` or `forcesReplace` than the one it replaced, so a
request resolving to that id gets the wrong guard. Now a load error, matching
the loader's existing fail-visible stance on a mere field typo.

**B3 · `hclops`: `UnifiedDiff` returned an EMPTY diff for a real change.**
`splitLines` strips the EOF newline into a bool `computeEdits` never sees, so a
change that only adds or removes the trailing newline compared as all-equal.
Reachable from `edit`: `Locate` leaves `End == len(src)` when a closing brace is
the last byte with no trailing newline, and the spliced `hclwrite` block always
ends in `\n` — **the file was written while stdout and `--diff-out` got zero
bytes.** A change with no evidence. Now renders as git does, with the
`\ No newline at end of file` marker.

**B4 · `manifests`: `maxLength` bypassed `elementsOf`.**
The only per-value bound not iterating elements — it measured
`fmt.Sprint` of the whole value, so on a list/map param it bounded the Go repr
(`[a b c]`, brackets included) rather than each element. No real per-element
cap, and collections of short elements wrongly refused. Identical for scalars.

### Correctness

**B5 · `edit`: an omitted param with a declared default exited 1.**
`manifests.Validate` deliberately skips an absent non-required param, so a
request omitting one carrying a `default` passed validation and then hit
`anyToCty(nil)` → `unsupported value type <nil>`, an *internal error* for a
request the catalogue calls valid. This is the shipped `ebs-gp2-to-gp3` shape
(`target_type`, `required:false`, `default:"gp3"`), which no golden case
covered. New `edit.paramValue` falls back to the manifest default, as the
`create_resource` / `idiomrender` lanes already did.

**B6 · `plancheck`: a map-typed value param produced a spurious
`interior-escape`.** Only `wrap:"list"` and `[]any` earned a subtree cover, but
`anyToCty` legitimately renders a `map[string]any` as an HCL object literal; the
plan then diffs per key, so `tags.Env` sat one level below the exact-leaf cover
`{tags}` and **a correct edit was reported as a violation**. The same failure
mode the function's own doc comment described for lists, never fixed for maps.
`writesListValue` → `writesCollectionValue`.

**B7 · `prprep`: a bad `--env` tree exited 1 instead of 3.**
Reading the caller-supplied tree is *resolution*, like the `--request` read
twenty lines above which returns 3. Exit 1 means catalogctl itself
malfunctioned, so a script dispatching on exit code alone misclassified an
operator typo as an internal fault.

**B8 · `hclops`: a redaction scope was never closed.**
`rhsOpensBlockRe` pushes a scope for `secret_string = jsonencode({`, whose
closer is `})` — which `^\s*\}\s*$` cannot match. Every later line stayed inside
the secret-bearing block and was masked. Over-masking is the safe direction, but
it blinds a reviewer to unrelated attributes further down the file, which is
exactly the *no over-blinding* property this package promises. The closer stays
anchored on a leading `}` so a stray `)` cannot pop a scope it never opened.

**B9 · `driftpropose`: an interior comment was relocated.**
`parseObjectLiteral` hoisted *any* comment out of the value, so
`Inline = /* mid */ "keep-me"` was re-emitted as `Inline = "keep-me" /* mid */`
— rewriting an entry the merge never touched and adding a second added/removed
line pair to what the file promises will be a one-line diff.

**B10 · `plancheck`: a self-contradictory diagnostic.**
For `wrap:"list"` the request supplies one *member*, so rendering the whole
planned value against it produced
`arns planned "arn:new" but the request asked for "arn:new"`. The verdict was
right; the sentence now explains the shape problem.

**B11 · `scanworker`: a data race in a pre-existing test.**
`TestOneBadRepositoryDoesNotStopTheWorker`'s watchdog goroutine read
`fakeControl.claims` while `Run` incremented it. **Live on `main` and green for
as long as the suite has existed, because CI never ran `-race`.** The fake's
mutable state now sits behind a mutex.

### Surfaced, deliberately not fixed

**`set_attribute` silently drops every value provider after the first.**
Measured: an op with `noncurrent_days` + `storage_class` writes only
`noncurrent_days`, so an operator-selected storage class never reaches the file
— **exit 0, with a diff that looks complete**.

New `multi-value-provider` lint rule names it at load time. The executor's
output is deliberately unchanged, per the `surface-don't-fix` policy documented
in `manifest_lint_test.go`. The five real-catalog offenders (of 1 267
`set_attribute` ops) are grandfathered in `arityBaseline`.

**These are worse than "a dropped param."** Each op's write target was resolved
and checked against the reflected provider schema
(`tools/schemadump/aws-v6.53.0-schema.json.gz`, aws provider 6.53.0). **All five
write an attribute that does not exist on the resource**, so the emitted
Terraform fails `terraform validate` with *Unsupported argument*:

| Op | Resolves to → writes | Provider actually has |
|---|---|---|
| `dynamodb-set-warm-throughput` | `read_units_per_second` | only `warm_throughput` (the units are nested inside it) |
| `sns-set-delivery-retry-policy` | `delivery_policy_num_retries` | only `delivery_policy` — a **JSON document string** |
| `routing-change-route-target` | `target_type` | `gateway_id`, `nat_gateway_id`, `transit_gateway_id`, … |
| `vpn-rotate-tunnel-psk` | `tunnel_number` | `tunnel1_preshared_key`, `tunnel2_preshared_key` |
| `vpn-set-tunnel-inside-cidr` | `tunnel_number` | `tunnel1_inside_cidr`, `tunnel2_inside_cidr` |

Reproduce with `manifests.ProseAttrToken` / `manifests.AttrFor` over the real
catalog, then look the attribute up in the schema dump.

None of these is a mechanical verb swap, which is why none was fixed here:

- **dynamodb** needs `set_attributes` **plus** `target.path: ["warm_throughput"]`
  (`set_attributes` does support a nested path).
- **sns** cannot be expressed as attribute writes at all — `delivery_policy` is a
  JSON document, and catalogctl has no verb that edits inside one.
- **routing** could work as a dynamic target, `target.attr: "{param:new_target_type}"`
  with the param retagged `role:"discriminator"`, but only if its allowlist values
  become real attribute names (`gateway_id`, …) — a UI-visible change.
- **vpn ×2** cannot use the dynamic target: `ResolveTarget` requires a token to be
  a **whole** path segment and explicitly refuses infix templates, so
  `tunnel{param:tunnel_number}_inside_cidr` is rejected by design. These need
  either per-tunnel ops with explicit `target.attr`, or a deliberate extension of
  the token grammar.

> **Fixing these five is a follow-up for the catalog's owners** — it is a
> manifest/product change, not a catalogctl change, and three of the five have
> UI or grammar consequences that should not be decided by a mechanical repair.
>
> Worth considering separately: a lint that checks every op's resolved write
> target against the reflected provider schema would have caught all five at
> load time. The schema dump and the `forcenew` gate already establish the
> pattern.

---

## 3. CI

`.github/workflows/catalogctl.yml` ran `build` / `vet` / `test` with no
coverage gate, no race detector and no format check. Added:

- **`gofmt -l`** — fails on non-canonical formatting.
- **`go test -race`** — a separate step, because it catches a class the plain
  run cannot. B11 proves it: racy and green for years.
- **coverage floor**, `COVERAGE_FLOOR: '93.0'`, just under the achieved 93.51%
  so ordinary churn does not trip it but real erosion fails the build.

> Raise `COVERAGE_FLOOR` when the number rises. **Never lower it to make a red
> build green.**

The gate was verified in both directions: it passes at 93.0 and trips at 99.9.

---

## 4. How this was produced, and its limits

Fifteen agents fanned out, one per file group, sequenced within each package to
avoid write conflicts, then an integration gate and three adversarial reviewers
(vacuous assertions / wrong-contract assertions / non-hermetic tests).

**The run did not finish.** It hit a session limit with 13 of 23 agents
complete. Casualties:

- Five writers (`internal/edit`'s `edit.go`/`create.go`, `idiomrender.go`,
  the block codemods, `plancheck`'s command layer, `driftpropose`'s
  `driftedit.go`) — hence the remaining gaps in §1.
- **The integration gate and all three adversarial reviewers.**

The gate work was done by hand instead: full `build` / `vet` / `test`, plus
`-race`, `-count=2` (state leaks) and `-shuffle=on` (order dependence), all
green, `gofmt` clean. The adversarial review was **not** replaced — the new
tests have not been swept for vacuous assertions or for cases that cement
current behaviour rather than the contract. One such case was caught by hand
(the `parseVer` test asserting the buggy zero-coercion) which suggests others
may exist. That review is the other obvious next increment.
