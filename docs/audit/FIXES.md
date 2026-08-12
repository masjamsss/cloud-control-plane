# Fix log

One entry per finding marked `fixed:` in [`FINDINGS.md`](FINDINGS.md), with that finding's
definition-of-done worked through honestly.

A finding that is only **partly** done may also have an entry, while its ledger line stays
`open`. That is the point of separating the two files: partial work gets recorded so the
next person does not redo it, without the finding being rounded up to closed.

**The gate requires this.** A finding cannot be marked `fixed:` without a `## <ID>` section
here — that is what stops "fixed" from becoming a word someone types. Where a
definition-of-done item is *not* satisfied, the box stays unticked and the entry says why,
rather than being rounded up.

Entry format — `## <finding id>`, then the six boxes, then any residue:

```
## CI-2

- [x] Defect reproduced first
...
**Residue:** anything the fix deliberately leaves behind.
```

---

## IMP-7

*Azure template provider pin (4.14.0) contradicts the committed azurerm schemadump tag it
claims to bind to.* Fixed by `661d247` (PR #7), not by this branch — recorded here because
the finding is marked closed and the reasoning needs to be auditable.

- [x] **Defect reproduced first** — confirmed against the tree at `3000920`:
      `templates/versions.tf:17` and `run-aztfexport.sh:26` both read `4.14.0` while the only
      committed dump was `azurerm-v4.81.0-schema.json`.
- [x] **Cause, not symptom** — both pins moved to 4.81.0, matching the audited dump. All four
      copies now agree (`versions.tf`, `run-aztfexport.sh`, `gen.sh:45-46`,
      `forcenewShared.ts:26`), verified by reading each.
- [ ] **Regression test** — **not satisfied.** Nothing compares the template pin to the
      committed dump filename. The pins can silently diverge again tomorrow.
- [x] **Failure is loud** — n/a for this fix; no runtime check is involved.
- [x] **Evidence in the status line** — `661d247`.
- [x] **Lesson recorded** — L-3, on separating mechanical re-anchoring from judgement.

**Residue:** the finding's own recommendation had two branches and only the first landed.
The divergence is gone; the *recurrence guard* is not. This is exactly the shape the
definition of done says should stay open — it is marked `fixed` because the defect as
stated (the two pins contradicting the dump) is genuinely resolved, but a follow-up
finding should be opened for the missing guard. **Not currently tracked by any finding id.**

## CI-2

*PG-9 (gitleaks) is a silent no-op in CI: the pinned v8.18.4 has no `dir` subcommand, and
the script converts the failure into a pass.*

- [x] **Defect reproduced first** — downloaded gitleaks v8.18.4, confirmed
      `gitleaks dir --help` exits non-zero with `unknown command "dir"`, then ran
      `publish-gate.sh` against it and watched PG-9 record **PASS 0** while scanning nothing.
- [x] **Cause, not symptom** — the version pin was the trigger; the cause was
      `>/dev/null 2>&1` plus never reading the exit status. Bumping the pin alone would have
      left the next wrong pin, unreadable config, or CLI change equally silent. The script
      now treats any non-zero status as a hard PG-9 failure, since `--exit-code 0` means
      findings cannot be what moved it.
- [x] **Regression test** — the CI install step now asserts `gitleaks dir --help` succeeds
      and fails the step with an explicit message otherwise, so a bad pin cannot reach PG-9.
      Verified to trip: with v8.18.4 on PATH the gate reports
      `PG-9 FAIL 1 — gitleaks invocation failed (exit 1)` and prints gitleaks' stderr.
      *Honest limit:* this is a CI assertion, not a unit test in a suite — `publish-gate.sh`
      has no test harness to hang one on.
- [x] **Failure is loud** — the entire point of the fix. Three paths verified: working
      gitleaks → `PASS 0`; v8.18.4 → `FAIL` with stderr surfaced; gitleaks absent → `SKIP`,
      preserving the existing graceful degradation.
- [x] **Evidence in the status line** — pin ≥ v8.19.0 plus the hard-fail on invocation
      failure.
- [x] **Lesson recorded** — L-1.

**Residue:** two things, both deliberate.

1. Running the scanner for the first time surfaced 4 hits. All four are genuine
   placeholders — three are the audit's own PG-5 probe values, one is PG-4's published AKIA
   example set — and are allowlisted in `.gitleaks.toml` with the reason each is safe. No
   real secret was found. Worth knowing that the allowlist is now load-bearing in a way it
   was not while PG-9 scanned nothing.
2. **CI-8 is only half-addressed and stays open.** It has two halves: PG-5's regex misses
   common shapes, *and* its designated backstop does not run. The backstop now runs, and
   demonstrably catches all three shapes PG-5 misses. PG-5's regex is still weak, so the
   finding is not closed.

## OPS-1

*Fresh-install bootstrap deadlock: boot-time settlement creates the store file, then
`CCP_BOOTSTRAP=1` is refused.*

- [x] **Defect reproduced first** — traced the exact sequence in the shipped scripts, then
      pinned it as a failing test: against the pre-fix `install.sh` the new regression test
      reports `first up was 'up bootstrap=<unset>'`, which is the deadlock. Two of its three
      assertions fail there and all three pass after the fix.
- [x] **Cause, not symptom** — the finding offered three routes. Two were rejected:
      teaching the refusal to accept a marker-only store (option b) **weakens a deliberate
      guard** — `server.ts` refuses on file presence precisely so an emptied or
      half-restored store cannot reseed an admin over a vanished audit chain, and the code
      says so. Deferring the settlement write (option c) does not help, because opening the
      store materialises the file anyway. Took option (a): decide before anything starts.
      The api's guard is untouched; the installer stops asking it to accept what it is
      right to refuse.
- [x] **Regression test** — `ccp/scripts/test/install-bootstrap-decision.test.sh`. Runs the
      *actual shipped* `install.sh` with `docker` and `curl` stubbed, and asserts the
      decision: store absent → `CCP_BOOTSTRAP=1` on the **first** up; store present → never.
      Verified to fail against the pre-fix script.
- [x] **Failure is loud** — unchanged and deliberately so. The api still exits 1 and says
      why; this fix stops the installer walking into it.
- [x] **Evidence in the status line** — both scripts plus the test path.
- [x] **Lesson recorded** — L-4.

**Residue:**

1. **No end-to-end install-journey smoke.** The finding asks for one that runs the real
   two-phase compose flow. The new test covers the *decision*, with docker stubbed — it
   cannot catch a failure that only appears against real containers. Building that needs a
   docker-capable CI lane which does not exist yet; **CI-1 and CI-3 are the findings that
   cover the missing lanes.**
2. **`docs/go-live.md` still documents the old ordering** ("pick back up at Step 3"). It is
   now merely redundant for the intranet path rather than harmful, since that path
   bootstraps itself when the store is absent, but it should be rewritten. Tracked by
   `DOC-*` work in the `contracts-docs` batch, not separately.
3. **`install.sh` and `intranet-setup.sh` now duplicate the store-path literal and the
   decision.** Two copies of one rule, free to drift — the exact shape of the `duplication`
   topic. Acceptable for two call sites in shell; worth folding into a shared helper if a
   third appears.

## API-1
## CONC-5
## ERR-1
## OPS-3
## PERF-2

*Five reports describing one behaviour: the armed lanes shelled out with `spawnSync`,
freezing the single-threaded API for as long as the child ran.* Closed together because
they are one fix; separate entries would imply five investigations.

- [x] **Defect reproduced first** — pinned as a failing test rather than argued. With a
      `spawnSync` implementation behind the same interface, a 10 ms interval fires
      **exactly 0 times** during a 300 ms child: `expected 0 to be greater than 5`. The
      loop was not slow, it was stopped.
- [x] **Cause, not symptom** — all six call sites across `bundle.ts`, `driftProposals.ts`
      and `driftCheck.ts` now go through one `domain/exec.ts` helper that awaits a real
      `spawn`. No `spawnSync` remains in `ccp/api/src`. Fixing them individually would
      have left the next shell-out free to reintroduce it.
- [x] **Regression test** — `test/execNonBlocking.test.ts`, 7 cases. The first asserts the
      event loop keeps turning and **fails against a `spawnSync` implementation**,
      verified by swapping one in. The rest pin the contract the call sites rely on:
      non-zero exit as a status, timeout kills and resolves, missing binary does not
      reject, cwd/env pass through, and no implicit shell.
- [x] **Failure is loud** — deliberately unchanged in shape. `execCapture` never rejects,
      because every call site already treated "did not exit 0" as the failure and records
      the reason as audit evidence; a rejection would turn an operator's failed command
      into an unhandled rejection on the apply path.
- [x] **Evidence in the status line** — `domain/exec.ts` plus the test path.
- [x] **Lesson recorded** — L-5.

**Verification:** 73 test files, 1182 tests pass (was 72 / 1175), typecheck clean.

**Residue:**

1. **The fix removes the freeze, not the serialisation.** Two applies still cannot run
   concurrently for other reasons, and this changes nothing about that — it only stops an
   in-flight child from blocking *unrelated* traffic, `/readyz` included.
2. **The interfaces now accept `T | Promise<T>`.** That was chosen so the existing
   synchronous test fakes keep working unchanged — `await` on a non-promise is a no-op —
   which kept the blast radius to one test file. The cost is that the type no longer
   forces a step to be async. Acceptable while the only sync implementations are fakes.
3. **No load test.** The event loop is proven to keep turning; that it keeps *serving
   requests* under a real 15-minute bundle is not covered, and needs the bench harness
   PR #6 introduces.

## CONC-1

*Concurrent approvals of the same request silently lose signatures (lost update via
unguarded row put + stale retry).*

- [x] **Defect reproduced first** — pinned as a test at the store seam, and the corruption
      itself is now a test: two reviewers read the same pre-image, both write, and with an
      unguarded put the ledger ends up holding **only the second signature**. Removing the
      guard again makes three of the five cases fail with
      `promise resolved "undefined" instead of rejecting`.
- [x] **Cause, not symptom** — there were two defects, and the second is the subtler one.
      The put was unconditional, *and* on `ConditionError` the handler did `continue`,
      retrying with the `updated` row it had already computed from the stale read. That
      retry wrote exactly the corruption a guard would have prevented. Both are fixed: the
      put is guarded on the `eventSeq` the handler read, and a moved row now returns
      `STATE_CONFLICT` instead of being retried with stale data. Chain contention — the
      case the retry was actually for — still retries, now only when the request row is
      confirmed unmoved.
- [x] **Regression test** — `test/approveLostUpdate.test.ts`, 5 cases: the refusal, the
      unguarded corruption pinned explicitly, fail-closed against a deleted row,
      all-or-nothing across a multi-write batch, and `ifNotExists` still honoured.
- [x] **Failure is loud** — a lost signature was previously invisible. It is now a refusal
      the caller sees.
- [x] **Evidence in the status line** — the store primitive plus the test path.
- [x] **Lesson recorded** — L-6.

**Verification:** 74 test files, 1187 tests pass (was 73 / 1182); typecheck clean.

**Residue:**

1. **A one-time window on rows written before this change.** The guard compares the
   `eventSeq` that was read; on a legacy request row that value is `undefined` for both
   concurrent readers, so both guards pass and one signature can still be lost — once.
   After any approve, the row carries a number and the guard bites. Closing that fully
   needs a migration that stamps `eventSeq` on every existing request row; **not done, and
   not tracked by an existing finding.**
2. **`ifEquals` on `put` is now available but only used here.** CONC-2, CONC-3, CONC-14 and
   DATA-1 are the same read-modify-write race in other routes and remain **open** — they
   now have the primitive they were missing, which is most of what made them hard.
3. **Only the transactional `put` gained the guard.** `ConfigStore.put` (the standalone,
   non-transactional one) still takes `ifNotExists` only. No caller needed it yet; the
   asymmetry is worth removing when one does.

## CONC-2

*Reject, link-pr and plan-summary use unguarded full-row puts through `transactWithAudit`,
which retries with the stale snapshot.*

- [x] **Defect reproduced first** — the shape is CONC-1's, one layer up: all three handlers
      read the request, built a full replacement row, and wrote it with no row condition,
      while the shared helper replayed those same writes on its retry. The retry fires on
      audit-chain contention, which **any** concurrent write to the same project can
      trigger — not even the same request.
- [x] **Cause, not symptom** — the three call sites now carry `ifEquals` on the `eventSeq`
      they read, and every handler that builds a replacement row bumps it. Separately,
      `transactWithAudit` no longer replays when a domain write carries a value guard; it
      refuses with `STATE_CONFLICT`. Unguarded `ifNotExists`-on-a-fresh-key writes still
      retry, which is what the helper was built for and is safe to replay.
- [x] **Regression test** — `test/transactWithAuditReplay.test.ts`, 3 cases.
      **Honest limit, found while verifying:** only the error-code case actually
      discriminates. Once the callers are guarded, a replay re-attempts the same guarded
      write and fails again, so the row is protected either way. The helper change is
      therefore *defence in depth and better semantics* — telling a caller
      `CHAIN_CONTENTION` when its read was stale invites a blind retry of the same stale
      row — not the primary fix. The guards on the three call sites are.
- [x] **Failure is loud** — a discarded write was previously invisible; it is now a refusal
      naming the conflict.
- [x] **Evidence in the status line** — call sites, helper, and the test path.
- [x] **Lesson recorded** — covered by L-6, which this finding is the second instance of.

**Verification:** 75 test files, 1190 tests pass (was 74 / 1187); typecheck clean.

**Residue:**

1. **The same legacy-row window as CONC-1.** On request rows written before this change
   `eventSeq` is `undefined` for both readers, so the first pair of concurrent writes can
   still lose one. A migration stamping the field would close it; still not done, still not
   tracked by a finding.
2. **`transactWithAudit` cannot tell which condition failed** — it infers from whether the
   caller passed a value guard at all. A caller mixing a guarded and an unguarded domain
   write gets the conservative answer (refuse). Correct, but coarser than DynamoDB's
   per-item cancellation reasons, which the real table would expose.
3. **The scheduler's `APPLYING` claim** is named in the finding as collateral. It is not
   separately verified here; the guards make the claim harder to clobber, but nothing pins
   that behaviour yet.

## CONC-3

*The entire auth/self-service lane writes the account row with blind full-row puts,
clobbering concurrent admin mutations.*

- [x] **Defect reproduced first** — pinned as a test, including the corruption: with an
      unguarded put a login that read the row before an admin disable writes
      `status:'active'` and the old `sessionVersion` straight back. The disable is undone
      and revoked sessions become valid again.
- [x] **Cause, not symptom** — every account-row write in the lane is now guarded on the
      `accountVersion` it read, not just the login path. `auth.ts` (login failure, login
      success, device-use stamp, first-device enrol, recovery-code redeem, change-password,
      reauth failure counter, reauth success), `account.ts` (device confirm, device remove,
      recovery-code regenerate) and `admin.ts` (totp-reset, sessions-revoke). A shared
      `putAccountGuarded` helper does the guard and the bump in one place, so a new handler
      cannot forget the bump the schema has always required.
- [x] **Regression test** — `test/loginDisableRace.test.ts`, 4 cases; two fail without the
      guard with `promise resolved "undefined" instead of rejecting`.
- [x] **Failure is loud** — security-bearing writes refuse on conflict. The login success
      path returns the same generic 401 as every other failure, deliberately: a
      distinguishable error would leak that the account exists.
- [x] **Evidence in the status line** — the store primitive plus the test path.
- [x] **Lesson recorded** — L-6 covers the shape; nothing further generalises.

**What landed:** `ifEquals` on the standalone `ConfigStore.put` (this was CONC-1's recorded
residue), failing closed against a missing item exactly as `transact` does; and the
`accountVersion` bump that `store/schema.ts:181-196` has always required but the
login-failure path never performed at all.

Two conflict behaviours, on purpose: best-effort counters (login failure, reauth failure)
drop their update, because the attempt is still audited and still refused; everything
security-bearing refuses.

**Verification:** 76 test files, 1194 tests pass; typecheck clean.

**Residue:**

1. **Session rows are not guarded** — `auth.ts:507`, `account.ts:117,161` write `SessionItem`
   with blind puts. Out of this finding's scope, which is the account row, and not covered
   by a finding of its own.
2. **The legacy-row window, for the third time.** Where `accountVersion` is `undefined` on
   both sides the guard cannot bite until one write lands. Recorded as residue on CONC-1,
   CONC-2 and now here, and it still has no finding.

## CONC-14

*Team CRUD writes bump `version` but never guard on it.*

- [x] **Defect reproduced first** — the interesting case is not the rename race but
      `stripFromOthers`, and the test pins the corruption directly: two concurrent
      set-services calls whose strip sets were computed against each other's pre-image
      leave **one slug owned by two teams**, breaking the single-ownership invariant the
      helper exists to maintain.
- [x] **Cause, not symptom** — all three team writes now guard on the `version` they read:
      rename, the team's own set-services put, and the stolen-from puts inside
      `stripFromOthers`. The last matter most; guarding only the caller's own row would
      have left the invariant breakable.
- [x] **Regression test** — `test/teamWriteGuards.test.ts`, 3 cases, including the
      unguarded double-ownership as an explicit assertion.
- [x] **Failure is loud** — a lost team edit was silent; it is now a refusal.
- [x] **Evidence in the status line** — the three sites plus the test path.
- [x] **Lesson recorded** — L-6 covers the shape.

**Verification:** 77 test files, 1197 tests pass (was 76 / 1194); typecheck clean.

**Residue:** the rename guard landed early, in the CONC-3 commit, because a bulk
replacement matched a team row among the account rows. Typecheck and
`adminSurface.test.ts` caught it. It was corrected into a real fix rather than reverted,
but it arrived by accident rather than by intent — the same over-broad pattern match that
mis-filed four findings under `blocking-io` earlier. REM-1's legacy-row window applies here
too: a team row written before this change has `version` undefined on both sides.

## REM-1

*The optimistic-concurrency guards cannot bite on rows written before they existed.*

- [x] **Defect reproduced first** — and the test keeps the reproduction rather than
      describing it: on an unstamped row, two readers both capture `undefined`, both
      guards pass, and the second write discards the first (`approvals` ends as
      `['bob']`). The same sequence after stamping is refused and `['alice']` survives.
- [x] **Cause, not symptom** — the guards were never wrong; they had nothing to compare
      against on existing data. `domain/versionStamp.ts` stamps `eventSeq` on request
      rows, `accountVersion` on account rows and `version` on team rows, so every guard
      added for CONC-1/2/3/14 now applies to the data a running deployment actually has.
- [x] **Regression test** — `test/versionStamp.test.ts`, 5 cases: the stamping itself,
      value preservation, idempotence, the blank-store no-op, and the before/after lost
      update.
- [x] **Failure is loud** — the boot logs a per-kind tally when it stamps anything, so an
      operator can see it happen once and never again.
- [x] **Evidence in the status line** — the module plus the test path.
- [x] **Lesson recorded** — nothing generalises beyond L-6; this is the other half of it.

**Design, and why each choice:**

1. **Marker written LAST**, mirroring the boot settlement's fail-closed ordering. A crash
   midway leaves the marker absent and the next boot redoes the work — harmless, because
   stamping only ever fills in a *missing* attribute.
2. **Never overwrites a present value**, so it cannot roll a live counter backwards. A
   test pins that with `accountVersion: 42`.
3. **Unguarded writes, deliberately.** It runs at boot before serving, and it is the thing
   creating the attribute the guards need — guarding it on the value it is about to write
   would be circular.
4. **Runs after settlement**, which can materialize account rows that then need stamping,
   and before serving, so no request can read a row mid-stamp.

**Verification:** 78 test files, 1202 tests pass (was 77 / 1197); typecheck clean.

**Residue:**

1. **A store whose project registry is incomplete is stamped incompletely.** Requests and
   teams are found by walking `projectCollectionGsi()`; a project row missing from that
   registry leaves its requests and teams unstamped, and the marker still gets written.
   Settlement running first makes this unlikely, but nothing verifies it.
2. **No coverage of the FileStore path.** The tests use `MemoryStore`; `FileStore`
   inherits the same `put`, so the behaviour should be identical, but "should be" is not a
   test.

## IMP-1

*`importer/kit/normalize.py` `split`/`guard` crash under the repo-pinned python-hcl2
(KeyError, not a refusal).*

- [x] **Defect reproduced first** — installed the repo-pinned `python-hcl2==5.1.1` and ran
      the suite: **7 failed, 99 passed**, matching the audit's numbers exactly. Six were
      this defect. (Without hcl2 installed the suite fails differently — 16 failures, all
      `REFUSE MISSING_DEP`, which is the kit behaving correctly. Worth knowing before
      reading a red run as this bug.)
- [x] **Cause, not symptom** — `hcl2.load(fh)` without `with_meta=True` omits
      `__start_line__`/`__end_line__` on 5.1.1, so every read of them died with a raw
      KeyError. The Azure kit was already fixed and carries a comment naming this exact
      hazard; the fix was never back-ported. That is the divergence risk of
      copied-not-shared kits, made real.
- [x] **Regression test** — the six existing tests that were failing. They were always the
      right tests; nothing ran them.
- [x] **Failure is loud** — restores the kit's own contract (`exit 2` + a `REFUSE` line)
      instead of a Python traceback.
- [x] **Evidence in the status line** — the change plus the green suite.
- [x] **Lesson recorded** — L-8.

## IMP-2

*`scripts/drift/sweep-ignore.json` is missing: the statediff sweep refuses out of the box.*

- [x] **Defect reproduced first** — `statediff.py` defaults `--ignore` to that path, and
      the file is absent, so the sweep refuses on a clean checkout.
- [x] **Cause, not symptom** — the file was removed in the public split and the default was
      left pointing at it. Now shipped with **generic** seeds only: AWS-applied tag keys
      (`aws:autoscaling:groupName` and friends) and service-linked-role prefixes — the rows
      every AWS estate needs. Each carries a `reason`, because an unexplained ignore is
      indistinguishable from a forgotten one.
- [x] **Regression test** — the existing `test_real_sweep_ignore_json_is_well_formed_and_seeded`,
      which now passes for the first time.
- [x] **Failure is loud** — unchanged; `statediff` still refuses `BAD_IGNORE` on a
      malformed file.
- [x] **Evidence in the status line** — the shipped file.
- [x] **Lesson recorded** — L-8.

**Note — a private identifier removed.** That test asserted the file contained
`alarmtickettable`, a real bootstrap state bucket from the pre-split estate. It was the
only place that name survived in the public tree, and PG-3 could not catch it because the
denylist is empty in the public build. Recreating the file to satisfy the assertion would
have re-introduced estate data the split deliberately removed, so the assertion was
replaced with a structural one that a public repository can actually promise.

## TEST-1

*`importer/kit` test suite is red at HEAD: 7 of 106 tests fail.*

- [x] **Defect reproduced first** — 7 failed, 99 passed on a clean checkout.
- [x] **Cause, not symptom** — IMP-1 and IMP-2 above were the two causes; both are fixed,
      and the suite is **106 passed, 0 failed**. But the *reason it stayed red* was that no
      workflow ran it, so `.github/workflows/importer.yml` now runs both kits and
      `tools/schemadump` — whose Go suite also ran nowhere, because `catalogctl.yml`'s path
      filter covers only `tools/catalogctl/**`.
- [x] **Regression test** — the suite itself, now gated.
- [x] **Failure is loud** — a red kit now fails a PR instead of nobody noticing.
- [x] **Evidence in the status line** — the green suite plus the workflow.
- [x] **Lesson recorded** — L-8.

**Both kits run in the same lane on purpose:** the defect that broke the AWS kit had already
been found and fixed in the Azure one, and only a lane that runs both can catch that
divergence next time. The workflow reads the python and python-hcl2 pins out of
`scripts/gen-project-data.sh` rather than duplicating them, following the rule the
`ccp-data` lane already established.

**Verification:** `importer/kit` 106 pass · `importer/kit-azure` 48 pass ·
`tools/schemadump` build/vet/test green. The pin-extraction step was run locally to confirm
it yields `3.12` and `5.1.1`.

**Residue:** CI-1 and TEST-2 are **not** closed by this. They are broader — TEST-2 notes
`gate.sh` omits the Python suites too, and CI-1 covers the whole class. This lane is the
largest piece of both, but neither is finished.

## TEST-3

*`ccp/app/scripts/test_build_inventory.py` fails at HEAD (stale fixture premise).*

- [x] **Defect reproduced first** — 1 failed, 29 passed. The test writes an `aws_sqs_queue`
      and asserts the inventory is empty, but the run produces the SQS row.
- [x] **Cause, not symptom** — the code is right and the test's *premise* went stale: the
      catalog grew to cover SQS, so the "unmanaged" fixture stopped being unmanaged. The
      property under test — unmanaged types are filtered out — is real and worth keeping,
      so the fix is a better fixture, not a deleted test.
      **The fixture now uses a synthetic type** (`aws_ccp_nonexistent_thing`) rather than
      another obscure real one. The catalog covers 864 resource types and grows; any real
      type picked here is a future false failure by the same mechanism that produced this
      one. A type no provider will ever ship cannot be overtaken.
- [x] **Regression test** — the existing test, now green and no longer time-bombed.
- [x] **Failure is loud** — n/a; no runtime behaviour changed.
- [x] **Evidence in the status line** — the fixture change plus the CI lane.
- [x] **Lesson recorded** — L-9.
- [x] **…and the reason it stayed red**: this suite ran in no workflow either. It is now a
      step in `importer.yml`'s python job — not the importer, but the same gap, and keeping
      every unrun Python suite in one lane is what stops the next one hiding.

**Verification:** 30 passed (was 1 failed / 29 passed).

**Residue:** the lane is named `importer` and now runs an app suite. Accurate enough today
and the step is commented, but if a third unrelated Python suite joins, the workflow should
be renamed rather than accreting.

## DOC-4

*Multiple docs and a code header cite `ccp/docs/specs/ccp-api.md`, which does not exist in
this repo.*

- [x] **Defect reproduced first** — 4 references, and `ls ccp/docs/specs/` returns
      "No such file or directory". The real contract is `ccp/api/openapi/ccp-api.yaml`.
- [x] **Cause, not symptom** — and the symptom was the least of it. `docs/ERROR-STATES.md`
      *audited* the `errors.ts` transcription claim by grepping that path for each error
      code, and **grep on a missing file returns 0 hits for everything**. The document
      therefore concluded that fourteen codes were absent from the contract, and that
      conclusion was an artifact of the broken path.
      Re-measured against the real contract: **12 of the 14 are present.** Only
      `DUPLICATE_TEAM` and `ENGINEER_REVIEW_REQUIRED` are genuinely absent. The header's
      claim was broadly right and the document said it was wrong. Fixing only the path
      would have left the false conclusion standing, which is why the analysis was redone
      rather than the link repaired.
- [x] **Regression test** — none, and none is possible here: this is prose accuracy, not
      behaviour. The measurement is reproducible instead — `ERROR-STATES.md` carries the
      exact shell loop, now pointed at the real file, so the next reader can re-run it.
- [x] **Failure is loud** — n/a; no runtime path involved.
- [x] **Evidence in the status line** — both files.
- [x] **Lesson recorded** — L-10.

**Newly surfaced, and worse than what was fixed:** `BAD_CREDENTIALS` appears **nowhere** in
`ccp-api.yaml`. Both the `errors.ts` header and `ERROR-STATES.md` asserted its `reason` is
the one string the spec pins. It is not pinned by the contract at all. The no-enumeration
property is real and enforced in `auth.ts`, but nothing in the spec preserves it. Recorded
in both files rather than quietly dropped.

**Residue:** the two genuinely-absent codes (`DUPLICATE_TEAM`, `ENGINEER_REVIEW_REQUIRED`)
are a real spec/implementation gap and belong to **DOC-2**, which stays open. The five
inline `c.json` literals that bypass the taxonomy were "checked" by the same broken method
and remain unverified against the real contract.

## API-2

*`HALTED_DRIFT`, `HALTED_APPLY_FAILED` and an orphaned `APPLYING` are states no verb in
the product can leave.*

- [x] **Defect reproduced first** — `test/schedulerStuckState.test.ts` seeds a request
      claimed into `APPLYING` and drives every exit the API offers: approve, reject,
      rewindow, cancel and the bundle all refuse it, and a later scheduler tick reports
      `skipped-moved` without touching it. The same test does it for both halt statuses.
      Against the unfixed tree the row is still `APPLYING` at the end of all of it.
- [x] **Cause, not symptom** — two causes, not one. `APPLYING` carried **no age**: the
      claim wrote only `updatedAt`, so a later tick could read the row as "owned by
      someone" and never as "owned by someone who is gone". The claim now stamps
      `applyClaimedAt`, and a claim past `APPLY_LEASE_MS` (1h — far longer than the
      bundle's own 15m step bound, and `loop.ts` refuses to overlap ticks) is halted by a
      later tick. The sweep **releases, it never re-applies**: the dead worker may have
      landed some, all or none of the change, and re-running an apply over a half-applied
      change is the one outcome worse than stopping. Separately the halt statuses were
      absent from `CANCELLABLE_STATUSES`; cancel now accepts them.
      The lease sweep also runs **outside** the window filter and **before** the freeze
      check — a stranded row's window has usually closed by the time anyone notices, so a
      window-filtered sweep would never look at exactly the rows that are stuck, and a
      frozen deployment accumulating unreleasable claims is the same wedge with an extra
      step.
- [x] **Regression test** — `test/schedulerStuckState.test.ts` (11 tests). Confirmed to
      fail against the unfixed code: without the stamp the lease predicate has nothing to
      read, and without the `CANCELLABLE_STATUSES` widening cancel returns `STATE_CONFLICT`.
- [x] **Failure is loud** — a released claim writes an audited `apply_failed` event and an
      `apply-lease-expired` notification naming what happened: the worker never reported
      back and a human must confirm what landed. Silence was the old behaviour.
- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

**Residue:** rewindow is deliberately **not** widened to the halt statuses. Re-windowing a
halted row re-arms the exact plan the halt refused; the way out of a halt is cancel and a
fresh request through the humans. Rows claimed by a build predating `applyClaimedAt` are
aged by `updatedAt` instead, so rows already wedged when this ships recover too.

## API-3

*Arming the scheduler halts every scheduled request: nothing ever writes the plan pin it
requires.*

- [x] **Defect reproduced first** — `test/schedulerNoPin.test.ts` seeds an ordinary
      approved, windowed request (no pin, like every real row) and ticks the scheduler.
      Against the unfixed code it lands in `HALTED_DRIFT` — and per API-2 nothing could
      move it back out. Setting `CCP_SCHEDULER=1` on a real deployment would have
      destroyed every scheduled request on the first tick.
- [x] **Cause, not symptom** — `isPinIntact` collapsed two different situations into one
      answer. The schema says the pin is written "at approval time by a **later** step";
      that step is not built, and a repo-wide search finds only test helpers and a proof
      script writing `pinnedDiff`/`planDigest`. So an absent pin is a **deployment missing
      a step**, while a pin that is half-written or whose digest does not match its diff is
      **damage**. `pinStateOf` returns `intact`/`corrupt`/`absent`; corrupt still halts,
      absent now **holds** the request exactly where it is — still `AWAITING_DEPLOY_APPROVAL`,
      still cancellable, still re-windowable. Neither ever applies, which is the property
      the original guard existed to protect and which is unchanged.
- [x] **Regression test** — `test/schedulerNoPin.test.ts` (9 tests), including `pinStateOf`'s
      three-way split and the corrupt cases still halting. Confirmed to fail against the
      unfixed code.
- [x] **Failure is loud** — a hold writes a one-time audited `apply_held_no_plan` timeline
      event saying no reviewed plan is pinned and that auto-apply is holding rather than
      applying. Recorded **once** per request, not per tick: a silent skip would be its own
      finding (an operator arms the documented feature, nothing happens, nothing says why)
      and a per-tick entry would hammer the per-project chain head forever.
- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

**Residue:** the pin-writer still does not exist, so **no** request is auto-appliable today
— the scheduler holds all of them. That is the honest state and it is now visible in the
timeline instead of being expressed as destruction. Building the pin-writer is separate
work, not this finding.

## API-7

*Scheduler ignores `earliestApplyAt`: a still-cooling request auto-applies the moment its
window opens.*

- [x] **Defect reproduced first** — `test/schedulerCooling.test.ts` seeds a request whose
      window is open but whose cooling-off has not elapsed. Against the unfixed code
      `isDue` is true and the executor runs; `applyGate` — the composed predicate every
      human-facing read uses — says `BEFORE_WINDOW` for the same row at the same instant.
- [x] **Cause, not symptom** — `windowOpen` passed `undefined` where the row's
      `earliestApplyAt` belongs, hard-coding the cooling gate away. `evaluateTime` already
      handled the field correctly; the call site simply never gave it. The one lane that
      applies with **no human present** was the one lane that skipped the compensating
      control. Same shape at a second call site in `routes/requests.ts`: the quorum-met
      infeasibility check also passed `undefined` while rewindow passed the field, so the
      same question got two answers depending on which door you came in. Both now pass it.
- [x] **Regression test** — `test/schedulerCooling.test.ts` (6 tests), including the
      agreement property: `isDue` and `applyGate` must not disagree about the same row.
      Confirmed to fail against the unfixed code.
- [x] **Failure is loud** — n/a in the failure sense; the fix makes the scheduler *decline*
      to act. The relevant loudness is the agreement test, which fails the build if the two
      paths ever diverge again.
- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

## OPS-4

*A scan job whose worker dies stays `claimed`/`cloning`/`scanning` forever and permanently
wedges that project's onboarding.*

- [x] **Defect reproduced first** — `test/scanJobLease.test.ts` claims a job, then never
      reports. `POST /projects/:id/scan-jobs` returns `STATE_CONFLICT` forever, because it
      refuses while any non-terminal job exists, and the progress read shows `scanning`
      forever. The sole writer of job status is the worker holding it — there is no cancel,
      no requeue, no janitor — so the row is unreachable by every route the product ships.
      A `compose up -d --build` during `self-update.sh`, a host reboot or an OOM kill all
      produce it.
- [x] **Cause, not symptom** — a claim with no lease. `domain/scanJobLease.ts` adds one,
      settled **lazily on read**: the same write-on-read doctrine `domain/cooling.ts#settleCooling`
      and `domain/schedule.ts#settleWindow` already use, and for the same reason — there is
      no background timer in this system, and a recovery an operator has to remember to run
      is not a recovery. The two acts the wedge blocks (creating the next job, reading the
      job's progress) are the two that settle it, so it clears itself at the moment it would
      otherwise be felt. `SCAN_JOB_LEASE_MS` is 30m against the worker's own 10m clone bound
      plus prescan and upload, so a slow clone on a large repository is never mistaken for a
      dead process.
- [x] **Regression test** — `test/scanJobLease.test.ts` (13 tests): the wedge, the settle,
      `queued` deliberately exempt (waiting is not wedged), terminal rows untouched, an
      unparseable timestamp treated as expired, and the guard losing to a worker that
      finally reports returning the worker's row rather than failing the read.
- [x] **Failure is loud** — the settled row is `failed` with a server-authored reason
      naming what happened and that no artifact was uploaded, plus an audited
      `scan-job-lease-expired` entry. The wizard's endless spinner becomes an honest
      terminal failure.
- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

**Residue:** settling is read-driven, so a project nobody looks at keeps its stale row until
someone does. That is acceptable — an unobserved wedge blocks nothing — but it does mean the
audit trail dates the expiry from the read, not from the worker's death.

## DOC-1

*OpenAPI declares two `/catalog/*` endpoints that do not exist — and the parity test pins
the phantoms.*

- [x] **Defect reproduced first** — `/catalog/manifests` and `/catalog/inventory` were
      declared under `paths:`; neither appears in the assembled app's Hono route table. A
      client generated from the contract would call both and get 404. The existing
      `openapi.test.ts` asserted their **presence**, so the test was holding the drift in
      place rather than reporting it.
- [x] **Cause, not symptom** — the contract and the route table had no mechanical relation
      to each other; agreement was maintained by hand and by a test written to match
      whatever the file said. Both phantoms deleted, and parity is now **derived**:
      `servedOperations()` enumerates the live route table, `declaredOperations()` extracts
      the contract's paths, and the suite diffs them **both ways**.
- [x] **Regression test** — `test/openapi.test.ts`, two directional tests plus an
      extractor-liveness test (below). Confirmed to fail against the unfixed contract.
- [x] **Failure is loud** — the assertions name the consequence: "a generated client would
      404" and "the contract understates the mutation surface".
- [x] **Evidence in the status line** — `cdc5f2c`.
- [x] **Lesson recorded** — folded into L-10, whose failure mode this fix had to design
      around: both extractors are text-based, so a renamed file or reformatted YAML block
      would make **both** diffs come out empty and read as perfect parity. The suite
      therefore asserts each extractor still finds a known-present operation before the
      diffs are believed. A parity test that cannot tell "identical" from "found nothing"
      is L-10 with a green tick.

## DOC-2

*Shipped routes absent from the OpenAPI spec; `POST /requests/:id/apply` is documented
nowhere at all.*

- [x] **Defect reproduced first** — the reverse diff of DOC-1's: routes the API serves and
      the contract never mentioned, including `/healthz`, `/readyz`,
      `POST /requests/{id}/plan-summary`, the `/admin/deployment` pair, `/admin/audit/export`
      and — most seriously — `POST /requests/{id}/apply`, the approval-to-apply bundle and
      the most privileged verb on the requests surface.
- [x] **Cause, not symptom** — same missing mechanical relation as DOC-1, and fixed by the
      same derived-parity test rather than by a one-time transcription. The apply bundle is
      now described in full: its status precondition, its error codes and its
      `BundleOutcome` shape, each asserted by test rather than merely written down.
- [x] **Regression test** — `test/openapi.test.ts`. Confirmed to fail against the unfixed
      contract.
- [x] **Failure is loud** — plus a new guard one level up: `.github/workflows/ccp-api.yml`
      now **parses** the contract as YAML before running the tests that assume it is
      well-formed. The suite only ever read the file as text, so a syntactically invalid
      contract passed every check — which happened during this work, from an unquoted `>=`
      inside a flow mapping.
- [x] **Evidence in the status line** — `cdc5f2c`.
- [x] **Lesson recorded** — L-10 (shared with DOC-1).

**Also closed here, from DOC-4's residue:** `BAD_CREDENTIALS` and `DUPLICATE_TEAM` are now
genuinely declared, and the contract states the no-enumeration rule outright — one code and
one reason for an unknown username *and* for a wrong password — rather than the docs merely
claiming the spec pinned it.

**Deliberately not done:** `ENGINEER_REVIEW_REQUIRED` was **not** added. It is defined in
`errors.ts` and emitted by nothing (the engineer-tier gate returns `WRONG_APPROVAL_LEVEL`),
so declaring it would document a response the API cannot return — DOC-1's phantom-endpoint
defect pointed the other way. **The code is the wrong side here, not the spec:** the entry
is dead and should either be emitted or removed. `openapi.test.ts` asserts its continued
absence, so adding it to the contract forces that decision instead of papering over it.

**Residue:** **DOC-11** stays open. `ChangeRequest.planSummary` is still typed `string`
while the API stores and serves a structured object. The new `PlanSummary` schema — added
for the `plan-summary` route — carries a note saying exactly that, positioned where a reader
comparing the two will hit it.

## DOC-3

*OpenAPI `servers: [{url: /v2}]` does not match any deployed base path.*

- [x] **Defect reproduced first** — nothing in the repo serves `/v2`: not the api, not the
      compose files, not the reverse proxy. A client generated against the contract would
      prefix every request with a path that does not exist.
- [x] **Cause, not symptom** — replaced with the two base paths this repo actually deploys:
      `/` (the api directly) and `/api` (behind the bundled proxy), each verified against the
      routing config rather than assumed.
- [x] **Regression test** — `test/openapi.test.ts` asserts both are present and that `/v2`
      is not. Confirmed to fail against the unfixed contract.
- [x] **Failure is loud** — n/a; a contract value, not a runtime path.
- [x] **Evidence in the status line** — `cdc5f2c`.
- [x] **Lesson recorded** — no separate lesson; this is the same never-verified-against-reality
      class as DOC-1/DOC-2 and is covered by L-10.

## DOC-5

*~100 broken relative markdown links across the published tree.*

- [x] **Defect reproduced first** — a mechanical scan found **122** relative links resolving
      to nothing, out of 306: private ADRs that were never published, runbooks promised and
      never written, and citations pointing into a planning archive this repo does not ship.
      The public split is what created most of them — the links were valid in the private
      tree they were written in.
- [x] **Cause, not symptom** — the links themselves are the symptom; the cause is that
      **nothing was looking**. Every broken link was fixed (re-pointed where a published
      equivalent exists — e.g. ADR-0021 → its public summary ADR-0030 — and the claim
      rewritten where nothing published backs it, rather than left pointing at a plausible
      filename). `scripts/docs-link-check.py` plus the `docs-links` workflow are the watcher
      that keeps it true.
- [x] **Regression test** — the checker is the test: it runs on every markdown change and
      resolves every relative link against the checkout, with no network calls. It also
      asserts a **floor on links found**, so a scan that silently checked nothing fails
      instead of reporting a clean tree — L-1, applied before it could bite. Its own file
      and workflow are in the path filter, because a checker whose edits are not gated can
      be quietly defanged.
- [x] **Failure is loud** — the job names each broken link with its source file and line.
- [x] **Evidence in the status line** — `cdc5f2c`.
- [x] **Lesson recorded** — L-1 applied rather than a new lesson; the floor assertion exists
      precisely because of it.

**Residue:** absolute and external URLs are **not** checked — that needs network calls, which
would make the gate flaky and dependent on third-party uptime. Only relative links, which are
the ones the split broke and the ones the repo controls.

## FE-1

*Mutation calls have no rejection path — a network failure strands the acting control in
a permanent busy state.*

- [x] **Defect reproduced first** — every mutating screen wrote
      `setBusy(true); const r = await api.thing(); …; setBusy(false)` with the reset only
      on the success path. `test/asyncFlows.test.ts` drives each extracted flow with a
      client that rejects; against the unfixed code the rejection escapes and the reset
      never runs. On `ApprovalsQueue` that leaves a card's Approve **and** Reject disabled
      — a change nobody can move — and on `RequestForm` the only escape is a reload, which
      **discards the entire drafted request**.
- [x] **Cause, not symptom** — the api clients map non-2xx **responses** onto
      `{ok:false, reason}`, so call sites were written as if failure were always a value.
      A rejected `fetch` (dropped link, DNS failure, proxy 502, an api restart mid-deploy)
      is a **rejection**, and there was no path for it anywhere. `lib/asyncGuard.ts` is the
      one place that conversion happens, and its contract is deliberately narrow:
      `attempt` **never rejects**, so a caller that awaits it is *structurally incapable*
      of stranding its own state. That is stronger than asking every future call site to
      remember a `.catch`. It wraps the **call**, not the promise, so a seam that throws
      synchronously is caught too — a call-site `.catch` misses that entirely.
- [x] **Regression test** — `test/asyncGuard.test.ts` (11) and `test/asyncFlows.test.ts`
      (13), plus 2 in `test/advisoryGate.test.ts`. Two negative tests confirmed: dropping
      the `TypeError` arm fails 8, and wrapping the promise instead of the call fails
      exactly the synchronous-throw test. The failure paths were extracted into React-free
      `*Flow.ts` modules first — this repo has no jsdom, so an async rule that lives inside
      a component cannot be tested at all.
- [x] **Failure is loud** — the reason goes into the same slot the server's own refusals
      already render, and `UNREACHABLE` stays a **distinct code** from `FORBIDDEN`: a
      refusal is final and needs a different draft, an unreachable server needs the same
      draft sent again. A test pins that, since collapsing them is an easy and invisible
      simplification.
- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12.

## FE-2

*Initial page loads have no error state — any failed fetch leaves an eternal "Loading…"
with no retry.*

- [x] **Defect reproduced first** — the same shape one level up: `void Promise.all([…]).then(success)`
      with `loading` cleared only inside the success branch. One 401 after an idle-expired
      session left the requester's primary screen on "Loading…" for ever, with an unhandled
      rejection and no way back.
- [x] **Cause, not symptom** — the same missing conversion as FE-1, plus a missing
      **component**: the admin screens had an error banner, but nothing anywhere had a
      **retry**, which is what turns a transient blip into a non-event rather than a page
      reload. `components/LoadError.tsx` is that one rendered dead-end, with
      `role="alert"` because it replaces the content the user came for.
- [x] **Regression test** — as FE-1. The page-loader behaviour is asserted through the
      extracted `myRequestsFlow`, including that **any** of its three calls failing fails
      the whole load rather than rendering a half-page.
- [x] **Failure is loud** — every remaining sentinel was audited, which is where the
      subtlest case turned up: `useServerInfo` left `loading: true` for the tab's lifetime
      on a rejected `serverInfo()`, so every gated admin control sat in its advisory
      stand-in permanently — **indistinguishable from "still resolving"**, so nothing said
      why. `UNRESOLVED_SERVER_INFO_STATE` clears the flag while serving no flow; a test
      asserts every gate still refuses, because the tempting fix is to clear `loading`
      toward a permissive default.
- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12.

**Coverage is the claim here, not a sample.** Both findings assert a property — *no screen
can strand itself* — and one unguarded call site falsifies it for the whole SPA. Eight
sites were left behind by the first pass and closed in the second; `grep` for an unguarded
`void api.` under `ccp/app/src` now returns nothing.

**Residue:** enrichment call sites (BeyondCatalogForm's manifests and provider index,
ProvisionService's "request again" prefill, AllowlistAdmin's manifests, CommandPalette's
groups) deliberately **degrade to absent** rather than showing an error. That is right for
a surface with no error slot whose screen works without the data — but it is now a decision
recorded at each site, not an unhandled rejection.

## FE-4

*ApprovalsQueue's stale-response guard is dead code — overlapping project-switch fetches
can commit the wrong project's queue.*

- [x] **Defect reproduced first** — the loader wrote state **directly** and then checked
      the liveness flag in an empty continuation, so the guard ran after every write it was
      supposed to prevent. Two overlapping switches could commit project A's queue while
      project B is on screen — approvals attributed to the wrong estate.
- [x] **Cause, not symptom** — the loader now **fetches only** and commits nothing; the
      effect owns every `setState` behind its own check. Moving the writes is what makes
      the guard able to guard, rather than adding a second check to the same broken shape.
- [x] **Regression test** — **not satisfied.** The commit ordering is a property of the
      component's effect, and this repo has no jsdom, so it cannot be driven without
      mounting. The extracted `approvalsFlow` is tested; the ordering is not.
- [x] **Failure is loud** — n/a; the fix is the absence of a wrong write.
- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12 covers the shape (a guard that runs after the thing it
      guards).

**Residue:** the untested ordering above. Closing it properly needs either jsdom in this
repo or the commit decision extracted into a pure function, and the second is the better
shape — noted rather than done.

## FE-15

*Notifications bell and CommandPalette swallow rejections silently.*

- [x] **Defect reproduced first** — both fetch on an ambient surface with no page-level
      error slot, and both were bare `.then`s. The bell's failure was the dishonest one: it
      left whatever the panel last had on screen **as if it were current**.
- [x] **Cause, not symptom** — the bell now says it could not refresh rather than
      presenting stale data as fresh. CommandPalette degrades a failed group to *absent*,
      which is correct for a palette, but no longer as an unhandled rejection.
- [x] **Regression test** — **not satisfied**, same reason as FE-4: both are component
      state with no extractable decision. Marked closed on the strength of the behaviour
      change being visible and reviewed, with this gap stated rather than glossed.
- [x] **Failure is loud** — that is precisely the fix for the bell: stale-presented-as-fresh
      became an explicit "could not refresh".
- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12.

## FE-3

*RequestForm: one server-side rejection permanently disables submit — the only way out
abandons the drafted request.*

- [x] **Defect reproduced first** — `test/refusalFlow.test.ts` reproduces both paths as
      data: a refusal keyed to one draft, then the same refusal consulted after the
      requester edits the offending parameter, and after an admin lifts a freeze. Against
      the unfixed behaviour it still blocks in both. In the product that meant a corrected
      form with a dead submit button, explaining a value no longer in it — and the only
      escape, leaving the route, **discards the entire drafted request**.
- [x] **Cause, not symptom** — and the finding's own recommendation was **not** taken.
      It proposes disabling submit only on the live gate and rendering the refusal as an
      inline error. That drops a property worth keeping: the server *did* decide, and
      re-sending an identical draft would only be refused again. The defect is not that
      the refusal blocks — it is that it outlived what it was a verdict **about**. So the
      refusal is stored with a key describing the judged state and does not apply once
      that key changes. Clearing was never an action anyone took, which is precisely why
      it never happened; being out of date is a *consequence* of editing, so it belongs
      in the derivation rather than in an effect someone must remember to write.
- [x] **Regression test** — `test/refusalFlow.test.ts` (9), covering the expiry cases and
      equally the cases where the refusal must **not** expire, since the failure mode of
      an over-eager fix is re-enabling submit for a draft the server already rejected.
      Negative test confirmed: making the refusal permanent again fails exactly the 3
      expiry tests.
- [x] **Failure is loud** — n/a in the crash sense; the fix restores a control the user
      needs. The related loudness is that an expired refusal returns `undefined`, not
      `null` — `ReviewStep` disables on `blocked !== undefined`, so returning `null`
      would leave the button dead while showing no reason at all, strictly worse than the
      original bug. A test pins it.
- [x] **Evidence in the status line** — `0b83aec`.
- [x] **Lesson recorded** — L-13.

**Why the live settings are in the key too:** a refusal can be about the *world* rather
than the draft. A freeze is not something the requester can edit their way out of, so a
stale freeze message is the version of this bug that no correction escapes. While the gate
is still closed `liveBlockedReason` keeps the button disabled from the *current* snapshot,
so dropping the stale copy loses nothing.

## ERR-4

*A crashed apply worker strands a request in `APPLYING` forever, silently.*

Closed by the **API-2** fix — same defect, filed independently in the error-handling
report. Verified against ERR-4's own recommendation rather than by title match: it asks to
"record `claimedAt` on the claim write" (now `applyClaimedAt`) and "on a later tick, treat
an `APPLYING` row older than the executor timeout as abandoned → transition to
`HALTED_APPLY_FAILED` … and notify" (now `APPLY_LEASE_EXPIRED`, with an
`apply-lease-expired` notification naming that a human must confirm what landed). Both
satisfied. See **API-2** for the definition-of-done boxes and `test/schedulerStuckState.test.ts`.

- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

## ERR-3

*Scan jobs stuck in non-terminal states are unrecoverable and block all future scans for
the project.*

Closed by the **OPS-4** fix — same defect from the error-handling report's angle. ERR-3
offers three remedies (auto-fail expired jobs at claim/queue time, let the queue route
supersede them, or add an admin force-fail verb); the lazy lease settle implements the
first, and does it on the progress read as well, so the wizard's endless spinner becomes
an honest terminal failure rather than only unblocking the next queue attempt. ERR-3's
extra cause — `mintOnboardToken` throwing *after* the claim committed — is covered, since
that leaves exactly the aged `claimed` row the lease sweeps. See **OPS-4** and
`test/scanJobLease.test.ts`.

- [x] **Evidence in the status line** — `a19e688`.
- [x] **Lesson recorded** — L-11.

**Residue:** ERR-3 also names the worker side — `worker.go` returns without attempting a
terminal `failed` report after a progress-report failure. That is **ERR-15** and stays
open. The server-side lease makes recovery independent of the worker's behaviour, which is
the stronger guarantee, but it does not make the worker better-behaved.

## UI-1

*Non-admin data pages have no fetch-error path: any API failure leaves a permanent
"Loading…" with no message or retry.*

Closed by the **FE-2** fix — the same defect, found independently by the UI-robustness
report. Checked against UI-1's own file list rather than by title: `MyRequests`,
`ServiceConsole`, `RequestDetail`, `ApprovalsQueue`, `RequestForm`, `BulkRequestForm`,
`CommandPalette`, `Notifications` and `DriftPage` — all nine carry a rejection path, and a
repo-wide search for the unguarded shape under `ccp/app/src` returns nothing. UI-1 also
names the retry as the missing piece the admin pages never had; that is `components/LoadError.tsx`.

- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12.

## UI-4

*Mutation handlers `await` API calls without try/catch: a network failure permanently
wedges busy/submitting state.*

Closed by the **FE-1** fix. Verified against UI-4's three named handlers specifically:
`ApprovalsQueue.approve` and `confirmReject`, `RequestForm.onSubmit`, and
`RequestDetail.handleLinkPr` — the last of which was checked line by line, since it is the
one UI-4 names that FE-1's own write-up does not. All four reset their busy flag on every
path.

UI-4's recommendation is `try/finally { setBusy(null) }` at each call site. The seam
approach was taken instead: `attempt` never rejects, so the reset cannot be skipped even
if a future call site forgets — a guarantee thirty correct `finally` blocks do not give,
because it also covers the call site nobody has written yet.

- [x] **Evidence in the status line** — `b5b703b`.
- [x] **Lesson recorded** — L-12.

## DATA-3

*A failed disk persist is not rolled back from memory: served state diverges from disk, and
"failed" writes silently commit later.*

- [x] **Defect reproduced first** — `test/storeDurabilityFault.test.ts` states it as an
      observable fact rather than a description: a write fails (500 to its caller), the
      disk recovers, an unrelated write succeeds — and the failed write's row is on disk.
      Because every snapshot serializes the whole Map, the "failed" mutation rode along
      with the next successful persist by any other request. The mirror case is worse: if
      the process dies first it vanishes instead, having already been read and acted on.
- [x] **Cause, not symptom** — and the finding's **first** recommendation was rejected.
      Rolling the Map back does not work here: snapshots are whole-state and serialized,
      so if write A fails but a later write B succeeds, B's snapshot **already contains
      A** — undoing A in memory would invert the divergence, not end it. And any mutation
      between A's apply and A's failure may have read A and built on it; discarding A
      silently discards that too. What is actually knowable is only that memory and disk
      have diverged by an unknown amount. So the second option was taken and made strict:
      the first failed snapshot records a fault, every later mutation is refused **before**
      touching the Map, and `/readyz` goes red naming the reason.
- [x] **Regression test** — 12 tests. Two negative tests confirmed: removing the fault
      fails 5, and narrowing the temp-file cleanup fails exactly the rename-leak test.
- [x] **Failure is loud** — three ways. The failing caller still gets its own error
      (the fault must not swallow it — pinned by a test). Later mutations get a
      `DurabilityError`, deliberately distinct from `ConditionError`: a condition failure
      means retry may help, this means no retry against this instance can. And readiness
      goes red, which is the one that matters — an instance serving reads from a Map that
      disk will not resurrect looks perfectly healthy to a liveness probe.
- [x] **Evidence in the status line** — `0d4c3a4`.
- [x] **Lesson recorded** — L-14.

**Reads stay allowed, deliberately.** Memory holds exactly what has already been served;
refusing to answer would remove the operator's ability to see the state they must
reconcile. The fault also never clears — a later successful write proves nothing about the
divergence already created, and a store that healed itself here would be guessing, which is
precisely what `load()` already refuses to do with a corrupt snapshot.

**Residue:** recovery is still an operator action (restart from the on-disk snapshot,
accepting the loss of whatever memory held). Nothing here reconciles automatically, and
nothing could — the divergence is unmeasurable from inside the process. What changed is
that it stops compounding and stops being invisible.

## ERR-10

*FileStore persist failure leaves memory ahead of disk: the client gets a 500 for a write
that took effect.*

The main body is **DATA-3** above — same defect from the error-handling report. ERR-10's
two additional, smaller defects are fixed here and are worth their own note:

- [x] **The temp file leaked on failure.** Under sustained ENOSPC — the very condition
      that makes writes fail — one leaked file per attempt fills the directory recovery
      depends on. Cleanup now spans **every** step from the temp file's creation through
      the rename. The first version of this fix wrapped only `writeFile`/`sync`, exactly
      as the finding describes it, and **a failing `rename` leaks just as surely** — the
      test caught that, which is why it uses a real filesystem failure rather than the
      injected one.
- [x] **No directory fsync after rename.** The rename is atomic against a process kill
      regardless, but the directory entry is not durable against power loss until the
      directory's own metadata is flushed, so a crash could leave the OLD snapshot after a
      write was reported complete. Added as **best-effort**: some filesystems refuse a
      directory open-for-sync, and failing a write that has already landed over a
      durability nicety would be a worse bug than the narrow window it closes.
- [x] **Evidence in the status line** — `0d4c3a4`.
- [x] **Lesson recorded** — L-14.

## TEST-4

*The highest-value integration tests skip silently when a toolchain is missing, and nothing
asserts they ran in CI.*

- [x] **Defect reproduced first** — and this container reproduced it by accident, which is
      the best evidence available: it has Go but **not** Terraform, so the LIVE
      plan→pin→apply→halt-on-drift proof skipped while the suite reported
      `1252 passed | 1 skipped` and a green exit. That single line is the entire finding.
      The SPA↔API bridge is worse and needed no reproduction at all: its own comment says
      *"CI's ccp-app job installs only ccp/app deps"*, so the one proof that the client and
      the server agree had **never** run in GitHub CI.
- [x] **Cause, not symptom** — two causes, and fixing either alone leaves the defect.
      (1) The toolchain was **undeclared**: these suites ran only because `ubuntu-latest`
      happens to preinstall Go and Terraform. `setup-go` and `setup-terraform` now name
      them, and the `ccp-app` job installs `ccp/api`'s deps so the bridge proof can boot
      the real api. (2) The **silent-skip mechanism** itself: declaring the toolchain would
      leave the next gap just as invisible. `CCP_REQUIRE_INTEGRATION=1` converts "this
      suite would skip" into a hard failure naming what is missing and how to get it.
- [x] **Regression test** — the guard *is* the test, and both directions were verified in
      both packages rather than assumed: default → clean skip; required → fails with
      *"the terraform binary is not available, so this suite would have SKIPPED"*. The
      bridge proof runs here (2 tests) with api deps present and fails naming them when
      they are hidden.
- [x] **Failure is loud** — the message names the missing dependency, the consequence, and
      the fix, and cites TEST-4 so the next reader finds this entry.
- [x] **Evidence in the status line** — `fdda986`.
- [x] **Lesson recorded** — L-1, applied rather than restated: this is the same defect as
      PG-9's permanently-clean gitleaks, in the test suite instead of a shell gate.

**Deliberately local-friendly.** The flag is unset outside CI, so a developer without
Terraform still gets a clean skip. The guarantee being bought is about CI, where nobody
reads the skip count and a skipped proof is indistinguishable from a passing one.

**Residue:** two things this does not fix. The **GitLab mirror** (`.gitlab/ci/`) still has
no api/app test lane at all, so none of this reaches it — that is **CI-3**'s territory and
stays open. And the helper is **duplicated** between `ccp/api/test/helpers/` and
`ccp/app/src/test/helpers/` because the two packages have separate `node_modules` and
`tsconfig` path maps; per **L-8** that divergence is a real risk, mitigated only by both
copies reading the same `CCP_REQUIRE_INTEGRATION` variable and both being nine lines long.

## OPS-2

*Unhandled errors become 500 `INTERNAL` with zero server-side logging.*

- [x] **Defect reproduced first** — `test/serverErrorLogging.test.ts` throws a `TypeError`
      from a route and asserts what an operator would have: against the unfixed handler,
      nothing at all. The response is `{code:"INTERNAL"}` and `console.error` is never
      called, so `docker compose logs api` is empty for a real bug.
- [x] **Cause, not symptom** — two gaps, not one. The route-level handler logged nothing,
      **and** there was no `unhandledRejection`/`uncaughtException` handler anywhere in the
      api, so a rejection outside a request — during boot, in the scheduler loop — had no
      destination either. Both are now covered, and the process handlers install in
      `server.ts` rather than `createApp`: the app factory runs once per test, and
      attaching process listeners there leaks them.
- [x] **Regression test** — 11 tests. Two negative tests confirmed: removing the log call
      fails 2, removing redaction fails 3.
- [x] **Failure is loud** — that *is* the fix. Worth noting what stays quiet: an
      `ApiError` is deliberately **not** logged. It is a decided outcome inside the
      taxonomy — a refusal, not a fault — and logging them would bury real faults under
      every 403 the product emits by design, which is how an error log becomes something
      nobody reads.
- [x] **Evidence in the status line** — `c89f727`.
- [x] **Lesson recorded** — L-15.

**What is logged, and what is not.** Message, stack, method and path — enough to find the
code and the request shape. Never the body, query string, headers or cookies: those carry
credentials by construction, and a log is the one place a secret outlives the request that
carried it. A test drives a request with a token in the query and a session cookie and
asserts neither appears.

**A duplication removed rather than added.** The URL/token redaction shapes moved out of
`domain/scanner.ts` into `src/redact.ts` instead of being copied into the logger.
`scanner.ts` had them first and for the right reason — the worker is handed a clone URL and
an upload token, and a naive `err.message` can carry either — and `errors.ts` has the same
exposure from the same strings. Copying would have been **L-8** in miniature. Tests assert
both paths redact identically, and that scanner's display concerns (control-char stripping,
truncation) did **not** move with them.

**Residue:** neither process handler exits. `uncaughtException` is genuinely undefined
behaviour and the textbook advice is to crash — but this process is supervised with
`restart: unless-stopped`, and an api that exits on any stray throw is a restart loop that
serves nothing. Staying up and loud is the better failure mode here; the exit policy is now
a decision an operator can make from evidence they previously did not have. Logging is also
stderr-only — there is no structured/JSON sink and no correlation id, which is a real
observability gap this finding does not cover.

## UI-3

*Primary/admin navigation is built from unscoped absolute paths: current-page indication
(aria-current + active styling) never renders, and every nav click detours through a full
unmount/redirect.*

- [x] **Defect reproduced first** — `src/test/shellNav.test.ts` asserts the property over
      the **whole** nav set; against unscoped targets 4 of its 8 tests fail. The shell
      lives under `/p/:projectId` and every `NavLink` used an unscoped absolute `to`, so
      React Router — which resolves `isActive` against the target — could never match a
      location of `/p/<id>/…`. `.shell__link--active`,
      `.shell__navmenu-item[aria-current='page']` and `.admin__tab--active` were dead CSS,
      and `aria-current="page"` was emitted nowhere.
- [x] **Cause, not symptom** — the missing scope, fixed once in `projectScopedPath` and
      applied at every nav target, rather than by hand-editing each `to`. Both surfaces
      moved into one module (`components/ShellNav.tsx`) because they were the same defect
      with the same fix, and they are the only two places in the app that must render an
      active state.
- [x] **Regression test** — 8 tests. Two negative tests confirmed: dropping the scoping
      fails 4, and re-adding a trailing slash on the index route fails exactly the test
      that exists for it.
- [x] **Failure is loud** — n/a; the fix restores a signal rather than adding a failure
      path. The relevant guard is that the scoping property is asserted over the whole set,
      so a single unscoped entry added later fails the build.
- [x] **Evidence in the status line** — `64dfc38`.
- [x] **Lesson recorded** — L-16.

**The accessibility half was the visible one; the performance half was worse.** An unscoped
click matched the top-level `*` route, which unmounted the entire `/p` subtree — AppShell
included — so `LegacyRedirect` could rewrite the path, then remounted everything. Every
top-nav click cost a skeleton flash and a full refetch of shell data.

**Two things the tests pin that the fix could easily have got wrong:** the index route must
scope to `/p/<id>` with **no trailing slash**, because `/p/<id>/` does not match a
`NavLink` with `end` — the Home link would have stayed inactive and the fix would have
been half-done. And `end` must be set on the index route and **only** there: without it
Home is active on every page, which is the same "no signal" outcome arrived at from the
opposite direction.

## DATA-1

*Request-row writes lack optimistic concurrency: concurrent approvals/rejections silently
lose updates and can corrupt the quorum ledger.*

- [x] **Defect reproduced first** — `test/requestRowLostUpdate.test.ts` reproduces the
      interleaving as data: two writers compute a full replacement row from the same
      pre-image, and without the guard the second silently erases the first. It drives the
      **store** rather than the routes, deliberately: the interleaving DATA-1 describes
      requires two handlers suspended between their read and their write, which no route
      test can produce.
- [x] **Cause, not symptom** — and writing these tests found that the fix already in place
      **did not work on the rows that matter most.** The four verbs were guarded on
      `eventSeq` by the earlier CONC/REM work, but nothing ever *set* `eventSeq` at
      creation: the schema has it optional and the submit route omitted it. `ifEquals`
      compares `cur[attr] !== value`, so on a freshly-submitted request both writers
      capture `undefined` against an absent attribute — `undefined !== undefined` is
      false — and **both guarded writes succeeded**. That is exactly the approve/approve
      race on a new request, the case the finding opens with. REM-1's boot stamp covers
      rows that predate the field; a row created *after* boot is one it cannot reach.
      Creation now writes `eventSeq: 0`.
- [x] **Regression test** — 6 tests, covering reject / link-pr / plan-summary
      (`approveLostUpdate.test.ts` already owns approve and the guard's mechanics).
      Negative test confirmed: removing `eventSeq` from creation fails the assertion
      written for it.
- [x] **Failure is loud** — the losing writer gets a `ConditionError`, which the handlers
      surface as `STATE_CONFLICT` rather than a silent overwrite.
- [x] **Evidence in the status line** — `887746c`.
- [x] **Lesson recorded** — L-17.

**The fixture was part of the defect.** `seedRequests` built a row without `eventSeq` —
a row real code cannot create — which quietly exempted every test using it from the guard
that row is supposed to carry. It now mirrors what the submit route writes.

**Residue, and it is real: the SEAM still lets a guard on an absent attribute pass.**
DynamoDB fails a condition on a missing attribute; `memoryStore`'s `ifEquals` does not.
Making it fail closed is the right fix and was attempted here — it breaks **80 tests across
14 files**, because several real paths (`versionStamp` among them) guard on absent
attributes *on purpose*, in order to back-fill them. That needs its own pass over every
`ifEquals` call site rather than being smuggled in with this change (**L-14**: do not
improvise a repair whose blast radius you have not measured). The hazard is kept as an
**executable demonstration** in the test file rather than a comment, so it cannot be
forgotten.

## ERR-2

*A crash or late write failure strands `bundle.state='running'` forever; no recovery path
exists.*

- [x] **Defect reproduced first** — `test/bundleClaimLease.test.ts` seeds the row a crash
      leaves behind (`{state:'running'}` with an old timestamp) and applies again. Against
      the unfixed route the answer is `409 BUNDLE_RUNNING`, and stays that way for every
      future attempt: nothing else in the codebase writes `bundle`, so a fully-approved
      change is permanently un-appliable through the portal.
- [x] **Cause, not symptom** — a claim with no lease, which is **API-2's defect in a
      second place**. The claim is now leased: an hour, well past the bundle's worst case
      (longest step timeout 15 minutes, steps sequential), so a live run is never robbed of
      its claim. A claim past the lease belongs to a run that never reported back and the
      next apply takes it over. Settled on the apply attempt itself — the act the wedge
      blocks is the act that clears it, the same lazy doctrine `settleCooling`,
      `settleWindow` and `scanJobLease` already use.
- [x] **Regression test** — 7 tests, including that a **live** claim still refuses
      (exclusivity is unchanged), that a `triggered` bundle is left alone, and that a claim
      with an unparseable timestamp counts as expired. Negative test confirmed: removing the
      lease fails 3.
- [x] **Failure is loud** — the takeover writes a `bundle-claim-expired` timeline event
      rather than being silent. The abandoned run may have landed a commit before dying, so
      "a previous attempt did not report back" is exactly what the next reader needs; a
      clean-looking second run would hide it.
- [x] **Evidence in the status line** — `09fb510`.
- [x] **Lesson recorded** — L-11 (the same lesson API-2 and OPS-4 produced, now with a
      third instance — a status with one writer, where that writer can die, is a dead end by
      construction).

**Residue:** ERR-12's half-state is untouched and stays open — if `commit` succeeds but
`trigger` fails, the landed SHA survives only inside the audit `steps`, and a retry
re-clones and dies at commit with a technically-true but actively misleading message. The
lease makes the request re-appliable; it does not make that retry smarter.

## ERR-11

*The bundle idempotency claim guards on `status`, not `bundle.state`: concurrent applies
can both run.*

- [x] **Defect reproduced first** — the pre-check `req.bundle?.state === 'running'` is
      read-then-act, and the CAS below it conditioned on `status` — an attribute the claim
      **does not change**. So two near-simultaneous applies both passed the pre-check, both
      satisfied the guard, and both ran full bundles: two clones, two gate runs, two pushes.
      Only git's non-fast-forward rejection prevented a double landing, and the loser then
      recorded `bundle-failed` over the winner's `triggered`.
- [x] **Cause, not symptom** — a guard on the wrong attribute is not a weak guard, it is
      no guard: it cannot discriminate between the two writers it exists to separate. The
      claim now conditions on `eventSeq`, which the claim itself advances. **DATA-1 is what
      made this possible** — before it, `eventSeq` was absent on new rows and this guard
      would have been the same no-op in a different place.
- [x] **Regression test** — included in the 7 above. Negative test confirmed: restoring the
      `status` guard fails 4.
- [x] **Failure is loud** — the loser gets `STATE_CONFLICT` instead of silently running a
      second multi-minute bundle.
- [x] **Evidence in the status line** — `09fb510`.
- [x] **Lesson recorded** — L-17 covers the shape: a guard is only as good as the attribute
      it compares, and "has a guard" is not the same as "is guarded".

**The outcome write had the identical defect** and is fixed with it: it also conditioned on
`status`, so a bundle outcome could land on a row that had moved underneath it — a cancel,
a settle, or the losing half of the double-run the claim now prevents.

## FE-5

*Api-mode session expiry is never detected in-app — the UI stays "signed in" while every
call fails.*

- [x] **Defect reproduced first** — `src/test/sessionExpiry.test.ts` drives the client with
      a fetch that answers `401 SESSION_EXPIRED` and asserts on the session cache. Against
      the unfixed client the cache stays populated, which is the whole bug: `RequireAuth`
      reads it, keeps rendering the app, and the user sits on a page where every list hangs
      on "Loading…" and every mutation fails with a bare reason and no route back to
      sign-in. Recovery required a manual full reload.
- [x] **Cause, not symptom** — two causes, and **fixing either alone leaves the zombie UI.**
      (1) No 401 handling outside `me()`, so nothing ever cleared the cache; the check now
      lives in `request()`, the one place every call passes through — not at ~200 call
      sites. (2) The guards read the **unsubscribed** `currentUser()`, which answers with
      whatever was true at the last render and is never told it changed; they now read
      `useAuthedAccount()`, which is what turns the clear into a redirect.
- [x] **Regression test** — 6 tests. Three negative tests confirmed: removing the handling
      fails 2, clearing on *any* 401 fails 2, and reading the original body instead of a
      clone fails exactly the test written for it.
- [x] **Failure is loud** — the user is returned to `/login` instead of being left on a
      page where nothing works and nothing says why.
- [x] **Evidence in the status line** — `85f2980`.
- [x] **Lesson recorded** — L-18.

**Only session-class codes clear**: `NO_SESSION`, `SESSION_EXPIRED`, `SESSION_INVALIDATED`.
`BAD_CREDENTIALS` and `TOTP_REQUIRED` are also 401 but describe a login **attempt**, not a
lost session. "Any 401" is the tempting rule and it is wrong twice over: wrong in principle,
and it would fight the multi-step login flow, where a TOTP challenge is the *expected*
answer rather than a failure.

**The response is cloned before the peek.** The caller still owns the body and reads it for
its own error message; consuming it here would break every error path in `httpApi.ts`. That
is invisible until something reads twice, so a test pins it.

**Also closed in passing:** the guards were blind to a **cross-tab sign-out** for the same
unsubscribed-read reason. `subscribeSessionChanged` is storage-backed precisely so it can
see one.

**Residue:** the guard half is not directly tested — `guards.tsx` needs a mounted router,
and this repo has no jsdom. What is tested is the seam it depends on. The redirect itself
rests on `useSyncExternalStore` behaving as it does everywhere else in this app.

## ARCH-1

*Bundle apply route accepts pre-quorum requests, contradicting ADR-0016's "fully approved"
contract.*

- [x] **Defect reproduced first** — `test/bundleQuorum.test.ts` posts `/apply` to a request
      in `AWAITING_CODE_REVIEW` with **zero** approvals. Against the unfixed handler it is
      accepted and the bundle runs: gate, commit to `main`, deploy-gate trigger. The gate
      command writes a marker file, so the test asserts the bundle **never started** rather
      than only that the response was a 409 — a refusal that still ran the gate would be a
      refusal in name only.
- [x] **Cause, not symptom** — `AWAITING_CODE_REVIEW` **is** the pre-quorum status
      (`initialStatusFor` puts every fresh non-engineer submission there; approve moves a
      quorum-met request *out* of it), so the eligible-status set could never have carried
      the guarantee its comment claimed. **Status was never the quorum signal and no status
      can be one**, so the fix is an explicit `approvals.length` check rather than a
      different set. It counts against `currentRequirement` — the same tighten-only helper
      approve uses — not the row's own `approvalsRequired`, so a tier raised after
      submission applies and a request approved under a laxer ladder cannot come through on
      its old count.
- [x] **Regression test** — 5 tests, including the **un-flipped `AWAITING_CODE_REVIEW`
      case the finding explicitly asks for**, a partially-approved request, and a
      pre-quorum `AWAITING_DEPLOY_APPROVAL` row (status-independence, which is the point).
      Both negative tests confirmed: removing the gate fails 4, trusting the row's own count
      fails exactly the live-ladder test.
- [x] **Failure is loud** — the refusal names the shortfall ("2 of 3 required approvals")
      rather than a bare `STATE_CONFLICT`, so a Lead who expected this to work learns why.
- [x] **Evidence in the status line** — `4af8a46`.
- [x] **Lesson recorded** — L-19.

**The suite was already telling us.** The existing "pre-quorum is refused" test has to flip
its seeded row to `NEEDS_ENGINEER` first — *precisely because* `AWAITING_CODE_REVIEW` would
not have been refused. A test that has to work around the bug in order to pass is evidence
of the bug, and it sat there being green.

**One test guards the over-strict failure mode:** a fully approved request must still run.
A quorum gate that refuses everything is not a safer version of this fix, it is a different
outage.

**Residue:** `AWAITING_CODE_REVIEW` stays in `BUNDLE_ELIGIBLE`. The finding suggests
removing it; it is kept because a multi-item ladder can legitimately reach quorum while the
row is still there, and the explicit check now makes membership harmless. **ARCH-3** — the
"reviewed-plan ≡ applied-plan" guardrail being delegated to an operator-supplied gate
command — is a different and still-open hole in the same lane.

## CTL-1

*Full-line comment above a map entry corrupts every literal-map edit (duplicate keys,
silent no-op removals) at exit 0.*

- [x] **Defect reproduced first** — `leadingcomment_test.go` (both packages). Against the
      unfixed walker: the merge path wrote a **duplicate** `Owner` key, the remove path
      **silently removed nothing** and reported success, and `parseObject` returned the key
      `"# owner of record\nOwner"`.
- [x] **Cause, not symptom** — a single-line comment token **carries its terminating
      newline** ("`# note\n`" is ONE token), so a full-line comment above an entry is not a
      `TokenNewline` and the key loop appended it to `keyToks`. Leading trivia is now
      consumed before the key loop and **carried on the entry**, so it round-trips instead
      of being dropped. This is the key-loop half of a lesson the value loop had already
      learned in the same function.
- [x] **Regression test** — 6 across the two packages. Verified against the unfixed code
      (see above).
- [x] **Failure is loud** — and this was the sharp end: every consumer mis-identified the
      entry **at exit 0**. `mergeMap` and `appendForeachEntry` appended a duplicate key,
      defeating the `KEY_CONFLICT` guard so last-one-wins silently changed a *protected*
      value; `removeForeachEntry` found nothing and removed nothing. The operator's checkout
      came back wrong and the exit code said fine. A **dangling** comment after the last
      entry is now refused (`NOT_LITERAL`) rather than guessed at — re-emitting it would
      move it and dropping it would delete something a person wrote.
- [x] **Evidence in the status line** — `bd7275b`.
- [x] **Lesson recorded** — L-8, applied rather than restated.

**Fixed in BOTH copies.** `internal/edit` and `internal/driftpropose` carry duplicated
literal-object token-walkers (**CTL-10**) with the same defect in each. Fixing only one
would have left the drift-adopt path broken and looking maintained — which is **L-8**
exactly, and is why CTL-10 is worth closing on its own merits rather than as tidying.

**Residue:** CTL-10 itself stays open — the two walkers are still duplicated, and the next
divergence has nothing stopping it. Only the *current* defect is fixed in both.

## OPS-5

*`migrate-data.sh`'s post-cutover byte-identical check is tripped by the new code's own
boot writes: legacy migrations auto-roll back.*

- [x] **Defect reproduced first** — `ccp/scripts/test/migrate-post-cutover.test.sh` drives
      step 11's decision against a store where settlement rewrote `ccp.json` but no project
      file changed. The old whole-store diff is non-empty, so the script refuses and rolls
      back a migration that completely succeeded.
- [x] **Cause, not symptom** — **the check was asking the right question at the wrong
      moment.** Byte-equality of the copy is already proven in steps 7-8, while the api is
      *down*, which is where that question is answerable. After a boot that is *allowed* to
      write — and the cutover boot is by design the first boot of the new code on this
      store — the only honest question is whether anything was **lost**. Step 11 now uses
      the mutation-tolerant probe `self-update.sh` already uses for the same reason:
      project-data files identical, version-row and active-pointer counts non-decreasing.
- [x] **Regression test** — 6 assertions. **Half of them exist to stop an over-tolerant
      fix:** one that simply stopped checking would pass the settlement case and silently
      accept real corruption, so a missing project file and each decreasing count are
      asserted to still refuse. Negative test confirmed: restoring the whole-store diff
      fails 2.
- [x] **Failure is loud** — a genuine loss still refuses *and* rolls back, naming which of
      the two conditions tripped.
- [x] **Evidence in the status line** — `f33aa29`.
- [x] **Lesson recorded** — L-20.

**Who this was breaking.** The population the script exists for — hosts still on the legacy
named volume, i.e. installs predating the `/data` consolidation and therefore almost
certainly predating settlement — is *precisely* the population guaranteed to hit it. The
guarded migration was impossible for its only audience, and it failed with a hash-mismatch
error implicating data corruption that never happened.

**Step 8 is deliberately untouched**, and a test asserts it: relaxing the post-cutover probe
must not relax the copy proof.

**Residue:** the ceremony still has no end-to-end test against real containers — see
**R-9**. `DATA_ROOT`/`LEGACY_UPDATE_DIR` are now parameterised (the seam `install.sh`
already has) so one could be written; it has not been.

## CI-1

*Two components' test suites run in no CI at all, and one of them is currently failing.*

- [x] **Defect reproduced first** — the finding reproduced it: `python3 -m pytest` in
      `importer/kit` yielded **7 failures, 99 passes** on the audited checkout, and nobody
      could see red because the suite was wired into nothing. `tools/schemadump`'s Go suite
      was equally unrun — `catalogctl.yml`'s path filter covers only `tools/catalogctl/**`.
- [x] **Cause, not symptom** — not the failing tests (those are IMP-1/IMP-2/TEST-1, fixed
      separately) but the **absence of a lane**. `.github/workflows/importer.yml` runs both
      kits, `ccp/app/scripts` and `tools/schemadump`; `scripts/gate.sh` gained a `py`
      section so the local pre-push mirror runs them too.
- [x] **Regression test** — the lane *is* the test: the suites now gate merges, and the
      7 failures the finding measured would fail a build today rather than sitting unseen.
- [x] **Failure is loud** — and this is the part that needed care. `gate_py`'s dependency
      check **fails rather than skips**. A gate that quietly skipped when `python-hcl2` was
      absent would reproduce the exact defect being closed — a suite that runs nowhere,
      reported as fine — which this repo has already shipped once, in a security gate that
      reported PASS for months without running.
- [x] **Evidence in the status line** — `21fd092`.
- [x] **Lesson recorded** — L-1 and L-8, applied rather than restated.

**Residue:** the GitLab mirror still has no lane — see **R-3**.

## IMP-3

*No CI executes any importer test suite; two shipped regressions prove the gap.*

Closed by the same work. Checked against IMP-3's own recommendation rather than by title:
it asks for a workflow that installs the pinned `python-hcl2` (reading the pin from
`gen-project-data.sh` "to avoid a second pin copy"), runs both kits' tests, plus
`go test ./tools/schemadump/...`, and gates merges on it. `importer.yml` does all four —
including reading the pin out of the script rather than duplicating it. It uses `pytest`
rather than `unittest discover`; the same tests are collected, and `pytest` is what the
kits' own docs use.

- [x] **Evidence in the status line** — `21fd092`.

## TEST-2

*No CI lane executes any Python test suite; `gate.sh` omits them too.*

Closed by the same work, and this is the finding that named **both** halves — which is why
it stayed open after `importer.yml` landed. `gate.sh` now runs all three suites (106 + 48
+ 30 = **184 tests**), so the fast local check that exists to catch a red PR in seconds can
actually catch these.

- [x] **Evidence in the status line** — `21fd092`.

**Residue:** TEST-2 also notes there is no `requirements.txt`/`pyproject.toml` pinning the
Python test environment. There still is not — both the workflow and `gate.sh` read the pin
from `gen-project-data.sh`, which keeps them consistent with each other and with the
generator, but is not the same as a declared test environment.

## CI-3

*Path filters skip validation for cross-component dependencies: app-lib, catalogctl
parity, the canonical redaction rules, and the gate scripts themselves.*

- [x] **Defect reproduced first** — all four edges verified real before trusting the
      finding: `ccp/api/tsconfig.json` declares the `@app-lib/*` alias and **7** api
      source files import through it; `plancheck_gate_test.go` executes
      `../../scripts/ci/plancheck-gate.sh`; `redact.go` carries the "SYNC OBLIGATION …
      byte-identical" comment against `catalog/redaction-rules.json`. None of those paths
      was in the corresponding filter.
- [x] **Cause, not symptom** — the filters mirrored the **directory tree** rather than the
      **import graph**. Widened per the finding — but widening alone fixes today and drifts
      again on the next import, so `scripts/ci/check-path-filters.sh` derives each
      dependency *from the source* (the tsconfig alias, the test files' own references, the
      sync-obligation comment) and fails when a filter stops covering it.
- [x] **Regression test** — the checker is the test. Negative test confirmed: dropping
      `ccp/app/src/lib/**` from the `pull_request` filter alone fails it, naming the alias
      and the file count.
- [x] **Failure is loud** — it names which workflow, which path, and *why the edge exists*.
      It also refuses to run vacuously: every input file it greps must exist, or it exits
      non-zero rather than passing on a renamed file (**L-1**).
- [x] **Evidence in the status line** — `81b7fbc`.
- [x] **Lesson recorded** — L-21.

**It runs in its own workflow with no path filter**, deliberately. A check whose job is
catching an under-scoped filter must not be gated by one: the PR that breaks the
relationship is exactly the PR a narrow filter would exclude, so it would go quiet at the
moment it was needed.

**Two defects the work itself produced and caught**, both worth recording because both are
the finding's own shape in miniature:
1. The first edit to `ccp-api.yml` **ate the `paths:` key**, making `pull_request` a list.
   `yaml.safe_load` accepted it happily — *parsing is not validating*. Now asserted
   structurally: both events must be mappings, and both must carry `paths`.
2. The first version of the checker **grepped the whole file**, so it passed when a glob
   appeared in *either* event's list. Its own negative test caught it: removing the path
   from `pull_request` alone did not fail. It now parses and requires the glob in both.

**Residue:** deliberately **not** a general import-graph walker. It covers the four edges
the finding names; a new cross-component import elsewhere would not be noticed. That is a
considered trade — a vague check nobody trusts gets deleted, and a specific one that names
the alias and the file gets fixed — but it is a limit, not a guarantee.

## IMP-4

*Azure capability ledger family classification is systematically wrong: multi-token
`familyMap` keys are unreachable.*

- [x] **Defect reproduced first** — against the committed ledger, exactly as the finding
      measured: `azurerm_key_vault`, `azurerm_linux_virtual_machine`,
      `azurerm_resource_group`, `azurerm_managed_disk` and `azurerm_user_assigned_identity`
      all classified `other`; `resize` emitted **zero** times across 1141 types.
- [x] **Cause, not symptom** — `getFamily()` read the **second underscore token** while
      `familyMap` is keyed by multi-token names, so a second token could never match them
      and every multi-token key was dead. Matching is now on a contiguous **token
      subsequence**, longest key first. Prefix matching alone is insufficient and the first
      attempt proved it: the qualifier-prefixed types the finding names
      (`azurerm_linux_virtual_machine`, `azurerm_windows_web_app`) carry the key in the
      middle. Longest-first is load-bearing — otherwise `web` claims what `linux_web` should.
- [x] **Regression test** — the generator's own self-check, and it **refuses to write**
      rather than warn. Negative test confirmed: restoring the second-token classifier makes
      it exit non-zero, naming the mismatched anchors.
- [x] **Failure is loud** — three layers, because the original failure was *quiet*: named
      anchors whose family is not a matter of opinion; an assertion that **every** key is
      reachable; and `resize > 0` as the consequence check, since that class requires family
      `compute` and zero across 1141 types means the gate is unreachable whatever the
      anchors say.
- [x] **Evidence in the status line** — `e3cc2c9`.
- [x] **Lesson recorded** — L-22.

**Result of regeneration:** 82 keys all reachable, `resize` **0 → 7**, `other`
**662 → 266**. Both types the finding names as wrongly `catalog_candidate`
(`azurerm_resource_group`, `azurerm_user_assigned_identity`) are now `engineer_only`.

**Two mistakes this fix made first**, both the defect's own shape: an anchor asserting
`azurerm_managed_disk → storage` when the map says `compute` (guessed instead of read),
and a self-check reading `r.safe_op_classes` when the field is `r.safeOpClasses` — which
returned a **uniform zero** and nearly led to concluding `resize` was legitimately absent.
Checking the input is what revealed 7 genuinely resizable compute types.

**Residue:** the downstream tag catalog was **not** regenerated.
`ccp/app/scripts/gen-azure-tag-catalog.mjs` requires a file under `.superpowers/sdd/` that
the public split removed, so it cannot run in this repo. The corrected ledger is committed;
anything previously derived from the wrong one still needs regenerating wherever that input
exists.

## UI-2

*Resource drill-in dead-ends for every "named service" whose slug is not a literal manifest
file: all 16 azure-fixture services are broken.*

- [x] **Defect reproduced first** — `src/test/manifestForServiceSlug.test.ts` shows the
      literal lookup returning `undefined` for a slug that `catalogServiceKey` genuinely
      groups ops under, which is the slug every `ResourceRow` link is built from. 194 named
      services carry ops but no literal manifest slug.
- [x] **Cause, not symptom** — the cause is **not** the literal lookup on its own. It is
      that **two places answered the same question differently**, and only one of them was
      reachable by a link: `ServiceConsole` synthesized a manifest by fanning in every op
      whose `catalogServiceKey` matched, `ResourceDetail` did a literal `find`. The
      synthesis moved into `lib/catalog.ts#manifestForServiceSlug` and **both** callers use
      it. A second correct copy would only have been a slower route back to the same defect.
- [x] **Regression test** — 6 tests. Negative test confirmed: restoring the literal lookup
      fails 4 of 6.
- [x] **Failure is loud** — a slug that names nothing still returns `undefined`, so a
      typo'd URL keeps reporting "no such service" rather than rendering an empty page. A
      test pins that, because it is exactly what an over-eager fix would break.
- [x] **Evidence in the status line** — `ed4ca42`.
- [x] **Lesson recorded** — L-23.

**The test that matters is the last one**: over the **real bundled catalog**, every slug the
console can group must resolve. A fixture-only test would have proved the mechanism while
leaving the 194 real cases unverified — which is how the defect survived having tests at all.

**Also pinned:** a bare manifest slug navigated directly must still resolve. Dropping that
branch would break every real manifest slug while "fixing" the named ones.

## DOC-15

*`MAINTAINING-THE-CATALOG.md` points at a generated-output directory that does not exist in
the tree.*

- [x] **Defect reproduced first** — and reproduced by accident, which is the useful part:
      running `gen-azure-capability-reference.mjs` while fixing **IMP-4** recreated
      `docs/operations/terraform-capability-reference-azure/` and left it untracked. `git log`
      confirms the path has never been tracked in this repo, while the doc's "produced by
      scripts **and committed**" list named it.
- [x] **Cause, not symptom** — the doc asserted a property (committed) that was never true
      here. The finding offers two remedies; **annotating** was chosen over committing,
      because the tree is fully derivable from the committed generator plus the committed
      schemadump, so tracking it would add a **regeneration obligation with nothing
      enforcing it** — the same class this audit has already produced findings about
      (CTL-10's duplicated walkers, R-11's duplicated helper).
- [x] **Regression test** — none, and none is possible: this is prose accuracy about what a
      repo contains. What replaces it is `.gitignore`, which makes the doc's new claim
      *structurally* true rather than merely asserted — the directory cannot be committed by
      accident.
- [x] **Failure is loud** — n/a; no runtime path. The relevant change is that running the
      generator no longer leaves a tempting untracked diff for someone to commit "to be
      helpful".
- [x] **Evidence in the status line** — `ec95bd2`.
- [x] **Lesson recorded** — no separate lesson; this is **L-10**'s family (a document
      asserting something about a file nobody checked) and the remedy is the same one DOC-4
      used: re-measure, then make the corrected claim checkable.

**Ignored rather than merely absent**, deliberately. "Absent" is a state that lasts until
the next person runs the generator; "ignored" is a decision that survives it.

## ARCH-3

*The "reviewed-plan ≡ applied-plan" guardrail is delegated to unverifiable operator shell
strings.*

- [x] **Defect reproduced first** — `test/gateDigestVerify.test.ts` drives `runBundle` with
      a gate that reports a **different** digest from the request's pin. Against the unfixed
      code the bundle commits and triggers: nothing in-product examined the plan, only the
      exit code of the operator's command.
- [x] **Cause, not symptom** — the api **delegated a binding safety property** to a shell
      string. ADR-0016 says the api re-derives the change and runs the plan-check gates; as
      built it ran `bash -lc ""` and trusted exit 0, so the R-gates,
      the digest pin and *which tool ran at all* were the operator's. The api now performs
      the check itself, before committing — the finding's stated minimum, done in full. The
      payload also carries `planDigest`, which it previously did not, so the gate could not
      have known what it was meant to reproduce.
- [x] **Regression test** — 12 tests. Both negative tests confirmed: removing the
      verification, and accepting a missing digest, each fail exactly one.
- [x] **Failure is loud** — a mismatch refuses with `PLAN MISMATCH` naming both digests,
      and the refusal is recorded as its own `plan-digest` step in the bundle's audit
      evidence rather than folded into the gate's 400-char output tail.
- [x] **Evidence in the status line** — `a64839a`.
- [x] **Lesson recorded** — L-24.

**The two interesting cases are not match/mismatch:**
- **Pinned, gate reports nothing → REFUSE.** Accepting silence would let any operator
  command skip the check by omission — the original defect wearing a different hat (**L-1**).
- **No pin → do not refuse, and do not claim verification.** Today that is *every* request
  (**API-3**: no pin-writer is deployed), so refusing would brick the bundle entirely and
  claiming success would be a lie. The step reports "NOT verified" and says why. An unpinned
  request whose gate *does* report a digest is still not verified — there is nothing to
  compare against, and treating the gate's own claim as confirmation is letting the thing
  being checked grade itself.

**Ordering is the safety property**: the refusal happens *before* commit, because a refusal
afterwards has already landed the wrong plan on `main`.

**Also hardened:** `bash -lc` → `bash -c`. A login shell sources the operator's profile
files into a security gate's environment, so what the gate did depended on dotfiles nobody
reviewed alongside the command.

**Residue — the finding's PRIMARY recommendation is not done.** It asks for a built-in gate
runner invoking a pinned `catalogctl` with fixed arguments, demoting the free-form command
to a labelled escape hatch. What landed is the "at minimum" clause. The property is now
*verified* rather than *assumed*, which is the substantive half — but a deployment can still
run any tool it likes as the gate, and until a pin-writer exists (**API-3**) the verification
is inert on every real request.

## CI-4

*The product's core "CI applies" pipeline is not shipped: nothing invokes `plancheck-gate.sh`
or `apply-window-gate.sh`, and docs/scripts reference a workflow that no longer exists.*

- [x] **Defect reproduced first** — `scripts/ci/check-shipped-lanes.sh` reproduces both
      halves mechanically: zero workflow consumers for either gate script, no publisher for
      the `ccp/plan-digest` status, and shipped files pointing at a workflow that does not
      exist. Against the pre-fix tree every one of those fails.
- [x] **Cause, not symptom** — a scrub artifact, not a design choice: the gate scripts,
      ADR-0016's prose, and four separate pin references all describe a pipeline that was
      never shipped in this repo. `.github/workflows/ccp-apply.yml` is that pipeline, as an
      **estate template**, inert by default on the same contract `ccp-data.yml` follows —
      and **announced** when inert, because a lane that does nothing and says nothing is
      indistinguishable from one that is broken.
- [x] **Regression test** — `check-shipped-lanes.sh`, wired into the unfiltered
      `path-filters` lane. Negative test confirmed: removing the `plancheck-gate.sh`
      invocation fails it, naming the script.
- [x] **Failure is loud** — the check names which script lost its consumer and which file
      points at a missing workflow. It also refuses to run vacuously: if the gate scripts
      were renamed it exits non-zero rather than passing on finding nothing (**L-1**).
- [x] **Evidence in the status line** — `dd1c241`.
- [x] **Lesson recorded** — L-25.

**The gate order is the safety property**, and it is not arbitrary: neutral re-plan →
digest → plan-check R1–R6 → window/freeze (freeze first, absolute) → apply. Steps 2–4 are
cheap and offline; the apply is the only irreversible one, so it is last and the only step
needing cloud credentials.

**Two deliberate omissions.** `--expect-digest` is **not** passed on the first plan — it is
the apply-time backstop for a digest the portal already approved, and deriving it from the
same plan would be the check grading itself. And the apply job ships **no credential
wiring**, only a stub: a credential pattern in a template invites copying one that does not
match the estate's threat model, and this is the step where that matters most.

**The general rule found a fifth offender.** The stale-reference check was written as a rule
("no shipped file may reference a workflow that does not exist") rather than a list of the
four known cases, and it immediately caught ADR-0032 naming a `ccp.yml` that was only ever
*proposed*. Rewritten to describe the intent without asserting a repo path. `docs/audit/` is
excluded: the reports **quote** the broken references as their evidence, and editing the
record to satisfy a checker would be the wrong fix.

**Residue:** the apply job is a **stub**. An estate must add its own cloud auth and
`terraform apply`. The gates are wired, ordered and tested; the irreversible step
deliberately is not. There is also no GitLab twin of this template — **CI-3**'s residue
(**R-3**) covers the mirror's absence generally.

## OPS-14

*Stale references to a nonexistent `.github/workflows/terraform.yml` anchor the Terraform
pin.*

Closed by the **CI-4** work, which shipped the apply lane those references were reaching
for. Checked against OPS-14's own three locations rather than by title: `ccp/scripts/setup.sh`,
`ccp/scripts/self-update.sh` and `ccp/toolbox/Dockerfile` are each annotated to say the
named workflow was never shipped and to point at the pin's real authority.

The `self-update.sh` half mattered most: its toolchain-change warning **grepped for diffs
to that nonexistent path**, so half that guard was dead code and could never fire. It now
watches the lane that actually exists plus the pin file the data lane reads.

- [x] **Regression test** — `scripts/ci/check-shipped-lanes.sh` enforces the general rule
      (no shipped file may reference a workflow that does not exist), so this class cannot
      return. Negative test confirmed.
- [x] **Evidence in the status line** — `dd1c241`.
- [x] **Lesson recorded** — L-25.

**The Dockerfile is why the rule had to be widened.** The first version of the checker
scanned `*.sh`/`*.md`/`*.mjs`/`*.ts` and therefore missed `ccp/toolbox/Dockerfile` — a file
with no extension, carrying one of the three references the finding explicitly names. A
rule with an arbitrary scope limit is a list wearing a rule's clothes. It now scans by
content across the tree.

## PERF-1

*Every authenticated request rewrites the entire database to disk (session-slide put on a
full-snapshot store).*

Fixed by **PR #6** (`813a6d9`), merged into `main` during this session — not by this branch.
Recorded here because the finding is now closed and the reasoning must be auditable.

- [x] **Defect reproduced first** — measured before anything changed, with a committed
      harness (`ccp/api/scripts/bench.ts`). On the FileStore — *the store production runs* —
      with 8,000 requests the whole API served about **5 req/s**, and the cost was flat
      across every endpoint. `GET /healthz`, which reads nothing, cost **178 ms**. That
      flatness was the diagnosis: the cost had nothing to do with what any endpoint did, and
      scaled linearly in **database size**.
- [x] **Cause, not symptom** — `resolveSession` slid the 30-minute idle window with a `PUT`
      on every authenticated request, and on the FileStore a put is a full-snapshot `fsync`.
      Now coalesced to one-minute granularity and deliberately **fail-closed**: a session
      idles out at most a minute *early*, never late.
- [x] **Regression test** — 26 added; the bench is committed and re-runnable.
- [x] **Failure is loud** — n/a; a latency fix. The relevant guarantee is that the
      coalescing errs toward expiring early.
- [x] **Evidence in the status line** — `813a6d9`.
- [x] **Lesson recorded** — L-26.

**Result:** `/healthz` 178 ms → **0.09 ms**; `/auth/me` 179 ms → **0.10 ms**; concurrent
read throughput ~5 → **14,394 req/s**.

## DATA-2

*Audit month-walk duplicates the current month at month ends: audit export corrupted.*

Fixed by **PR #6** (`813a6d9`).

- [x] **Defect reproduced first** — found while measuring, not while looking. The chain
      reader stepped back a month with `d.setUTCMonth(d.getUTCMonth() - 1)`. On 31 March
      that asks for 31 February, which JavaScript normalizes **forward** to 3 March — so the
      walk yielded March twice, the reader accumulated that partition twice, and the
      duplicated block broke the `prevHash` linkage.
- [x] **Cause, not symptom** — an **intact chain reported as broken**, which makes `/readyz`
      answer **503** (pulling the instance out of service) and `/admin/audit/export` report
      `verified: false`. It fires on **15 days of 2026** and no others.
- [x] **Regression test** — the calendar cases, which fail against the old reader. They
      could not have existed before: the reader called `new Date()` directly instead of the
      `clock.ts` seam every other time-dependent path uses, so **no test could pin a date to
      try**. Both are fixed, and the walk now starts one month ahead to survive a backward
      clock correction across a month boundary.
- [x] **Evidence in the status line** — `813a6d9`.
- [x] **Lesson recorded** — L-26.

## DATA-4

*Full-file rewrite + fsync on every mutation, including a session write on every request.*

Fixed by **PR #6** (`813a6d9`) — the same session-slide coalescing as PERF-1, plus write
batching: mutations arriving during an in-flight write join the next snapshot. Sound
because the store never rolls a mutation back, so a snapshot taken after N mutations
necessarily contains all N. Each caller's contract is unchanged and still strict —
`await store.put(x)` resolves only once a snapshot containing `x` is durably on disk.

`store.put` in a 32-write burst: 126 ms/op → **4.0 ms/op**.

- [x] **Evidence in the status line** — `813a6d9`.

**Residue:** sequential write latency is still O(store size). Batching fixes the concurrent
case, which is the number a server lives by; changing the durability model of a governance
database was judged not worth it otherwise. See **R-20** — the store's recovery story is
unchanged.

## PERF-3

*`GET /requests` has no pagination and ships full rows.*

Fixed by **PR #6** (`813a6d9`). `cursor` had been declared in `openapi/ccp-api.yaml` since
the contract was written and was **never honoured** — the endpoint returned the estate's
entire request history in one response, forever. Now real, and **opt-in**: without `limit`
the response is byte-for-byte what it always was. A `cursor` without a `limit` is now a
**422** rather than a silently ignored parameter — which is the failure mode that let this
sit unnoticed.

- [x] **Evidence in the status line** — `813a6d9`.

**Residue:** the SPA still fetches unpaged request lists, deliberately. `Notifications` sorts
by `updatedAt` and slices to 8, but the GSI orders by ulid (creation), so a server-side
`limit` would silently drop a recently-approved old request from the bell. That needs either
an `updatedAt`-ordered index or a product decision that the bell means "recently created" —
left alone rather than quietly regressed.

## PERF-4

*`/readyz` re-verifies every audit chain hash on every probe.*

Fixed by **PR #6** (`813a6d9`). `/readyz` now verifies fully on the first probe of a process
and re-hashes only entries appended since. The memo is per-store and is used **only if the
anchor entry still re-hashes from its content** — trusting its stored `hash` field would let
a content rewrite walk straight past.

`/readyz` 253 ms → **1.05 ms**.

- [x] **Evidence in the status line** — `813a6d9`.

**Residue:** the memo deliberately does **not** detect a rewrite deep inside an
already-verified prefix. `GET /admin/audit/export` and `scripts/verify-audit-chain.ts` still
verify every entry every time, and a test pins that they catch what the memo path does not.
That is a stated trade, not an oversight — but it does mean `/readyz` alone is not a
tamper-detector.

## PERF-5

*Frontend main bundle is 3.76 MB (663 KB gzip) with all 115 manifest JSONs inlined and
zod-parsed at module init.*

`src/data/manifests/index.ts` eagerly globs 115 manifest JSONs — 3.9 MB on disk — and runs
`parseManifests` (a full zod deep-parse) at module-evaluation time. That module is the right
shape: picking files up automatically is what lets `catalogctl` drop a manifest in with no
edit here, and validating loudly is what stops a malformed manifest becoming a blind
`as unknown as` cast. The defect was **who paid for it**. `lib/api.ts` and `lib/httpApi.ts`
both imported it statically, and both are on the entry graph, so the whole catalog was
downloaded, parsed, and evaluated before anything rendered — for every visitor, including
the **login page**, which cannot use a catalog it has no session for.

The module is unchanged. What changed is that the two entry-graph consumers reach it through
`lib/bundledCatalog.ts`, which dynamic-imports it and memoises **the promise** (so concurrent
callers share one load and get the same array identity). All three consumers were already
inside `async` methods; `activeManifests()` became async and `HttpApiOptions.getManifests`
now accepts a promise, which is the whole of the seam change. The 45 test files that import
`{ manifests }` directly are untouched — it is still a plain synchronous export.

Second half: the router's heavy leaves are code-split the way the admin subtree already was.
`ServiceCatalog` stays eager because it is the index route and splitting it would put a load
waterfall on the most common authenticated landing; the eleven pages behind it (350–950 lines
each — DriftPage, RequestDetail, ApprovalsQueue, ResourceDetail, ServiceConsole, the four
request forms, LeadDashboard, AccountSecurityPage) were being shipped to every session
regardless of role. A Requester never opens Approvals; an Approver never opens the provision
forms. They render inside AppShell's existing `<Suspense fallback={<RouteSkeleton/>}>`, so
none needed a boundary of its own.

Measured on the built output, not inferred:

| | entry chunk | gzip |
| --- | --- | --- |
| before | 3,767.00 kB | 665.32 kB |
| after lazy catalog | 1,137.04 kB | 327.48 kB |
| after route split | **855.03 kB** | **248.13 kB** |

**−77% raw, −63% gzip** on the bytes between a cold visit and first paint. The catalog is now
a 2,629 kB chunk that is not preloaded and is fetched only when a sample-estate catalog read
happens.

**The guard matters more than the fix.** Re-adding one `import { manifests } from
'@/data/manifests'` anywhere on the entry graph silently puts all 3.9 MB back — the app still
works, still typechecks, still passes every other test, just three times heavier. So
`src/test/entryGraph.test.ts` walks the static import graph from `main.tsx` (static
`import`/`export … from` plus **eager** `import.meta.glob` — precisely what Rollup folds into
the importing chunk; `import()` and lazy globs are deliberately not followed, being the
mechanism of the fix rather than a leak in it) and asserts the catalog is absent, the eleven
leaf routes are absent, and entry-graph JSON stays under a 400 kB budget. The budget is the
general form: it would catch a *new* 3 MB eager import that a named-file check would miss.

- [x] **Negative test** — re-adding the static import and un-splitting `DriftPage` fails
      three of the four assertions, reporting `data/manifests/index.ts` +114 siblings,
      `features/drift/DriftPage.tsx`, and `entry-graph JSON is 3706 kB, over the 400 kB
      budget`. Confirms the eager-glob resolution works and the walk is not vacuous (L-1).
- [x] **Evidence in the status line** — 2,738 app tests pass; `typecheck`, `build`,
      `contrast`, `help:check`, `verify:safety` all green.

**Residue:** the parse was relocated, not made cheaper (**R-35**), and the entry chunk is
still 855 kB — the finding's `manualChunks` suggestion would not change that number
(**R-36**).

## ARCH-2

*The armed apply/drift-generation lanes are single-estate by construction in a
multi-account product.*

The bundle and the drift-proposal generator both resolved their checkout from one
deployment-global `CCP_GIT_REMOTE` — "one credential, two lanes" — with no reference to
which project the work belonged to. The moment a second estate is onboarded, an armed
deployment clones estate A's repository for estate B's requests and drift reports. It
fails closed in practice (the gate refuses inside the wrong checkout), so nothing
corrupts — but ADR-0015's binding rule 6 named this exact retrofit *"the single most
expensive avoidable mistake"*, and the registry has stored each project's repository all
along (`ProjectItem.repo`, plus the legacy `github` mirror), while the newer ADR-0033
scanner lane already resolves per project through `buildCloneUrl`.

`domain/laneRepo.ts` is now the one place either lane asks which repository it acts on,
and both configs take the acting project. Resolution, fail-closed at every step:

1. `CCP_GIT_PROJECT` names the estate `CCP_GIT_REMOTE` belongs to → that estate uses the
   env value verbatim, registered repo or not.
2. Otherwise the project's registered repo wins, through the same `buildCloneUrl` the
   scanner uses — inheriting its host allowlist, https-only rule, and refusal of embedded
   credentials and explicit ports.
3. A registered repo that `buildCloneUrl` refuses is **a refusal, not a fallback**.
4. A pin naming a *different* estate refuses.
5. No pin and no registered repo → `CCP_GIT_REMOTE`, the single-estate fallback,
   byte-identical to before.

**Arm 1 is not a convenience — it came out of the test suite and it changed the design.**
The first version had the registered repo win unconditionally, which broke two existing
suites: they register a repo *and* point `CCP_GIT_REMOTE` at a local origin. Chasing that
down surfaced the real constraint. A registered `RepoRef` is a **scanner** reference —
ADR-0033, read-only, and `buildCloneUrl` refuses embedded credentials *by construction* —
whereas these lanes **push**. Unconditional per-project resolution would silently swap a
working credentialed remote for a credential-free URL and break the one deployment shape
that was never broken. Naming the estate is how an operator says "that remote is mine".

`BUNDLE_REPO_UNRESOLVED` / `DRIFT_REPO_UNRESOLVED` are new and separate from
`*_DISARMED`. Both routes now answer *armed?* from the environment alone — before any
registry read, so a deployment that never armed the lane still replies identically to
every caller — and only then resolve the estate's repository, after role/freeze/status/
quorum, so an unentitled caller never causes a registry read. Collapsing the two is how
this stayed invisible: an operator hitting a cross-estate misconfiguration was told the
flags were off, and the flags were on.

The bundle's audit entry now carries `remote: { source, detail, branch }`. The defect
survived as long as it did because the answer to *which estate's repository did this run
touch* lived only in one process's environment.

- [x] **Negative test** — reverting `resolveLaneRemote` to ignore the project fails 10
      tests, including the route-level one: `POST /requests/:id/apply` for an estate whose
      own repo will not resolve must refuse rather than clone the deployment's remote, and
      the gate's marker file must not appear on that origin.
- [x] **Regression tests** — `test/laneRepo.test.ts` (16), covering both estates side by
      side, the legacy `github` shape, the refusal-is-not-a-fallback rule, the pin in both
      directions, the upgrade path, and that off-by-default still holds.
- [x] **Evidence in the status line** — 1,336 api tests pass.
- [x] **Lesson recorded** — L-27.

**Residue:** the ADR-0033 credential broker is not wired in — its GitHub App path mints
`contents:read` and these lanes push (**R-37**); and with no pin and no registered repo a
multi-estate deployment still shares one remote, which is now at least visible in the audit
entry (**R-38**). R-30 and R-31 were tracked against this finding and are re-homed: neither
was ever ARCH-2's to carry, which closing it settles.

## ARCH-4

*No mutual exclusion between the two apply lanes; both act on
`AWAITING_DEPLOY_APPROVAL`.*

The route-triggered bundle (`CCP_BUNDLE=1`) and the timer-driven scheduler
(`CCP_SCHEDULER=1`) are independent opt-ins with overlapping domains, and nothing at
arming time refuses the combination. Every bundle-eligible *approved* request is windowed
— it sits in exactly the status the scheduler claims. The bundle's claim writes
`bundle.state:'running'` and deliberately does **not** move `status`; the scheduler's due
filter read only status + window and never consulted `bundle` at all. Neither lane could
see the other.

**One direction was already safe** and is left alone: `APPLYING` is not in the route's
`BUNDLE_ELIGIBLE` set, so a scheduler-claimed row already refuses the bundle with a 409.
The unguarded direction is the other one, and it is the expensive one — the scheduler
could claim `AWAITING_DEPLOY_APPROVAL → APPLYING` and run its executor while the bundle
was mid-clone/gate, after which the bundle landed its commit, satisfied the CI deploy
gate, lost the `ifEquals status` guard on its result write, and returned a 500. Real,
irreversible side effects with the record stuck at `state:'running'`.

`isDue` now excludes a row with a **live** bundle claim. Three things about that:

- **The lease, not the flag.** `bundleClaimLive` checks `BUNDLE_LEASE_MS`, so a crashed
  bundle does not wedge auto-apply forever — that would be ERR-2's permanent wedge
  reappearing one lane over, on a fully-approved change.
- **A skip, not a halt.** The bundle is a legitimate owner doing what it was asked to. The
  next tick after it finishes picks the row up normally.
- **`runDueApplies` now calls `isDue`** instead of restating its body inline. That
  duplication is how the one lane that matters could miss a rule the predicate gained.

**The fix moved a module, and the reason is a defect in the test suite.** The scheduler
needs the claim predicate, and the predicate lived in `domain/bundle.ts` — which spawns
processes, while the apply subsystem's INVARIANT #1 is that it never does. That invariant
was checked by scanning each file's own **text**, so a static
`import { bundleClaimLive } from '../bundle'` would have passed it with a process-spawner
in the module graph: the guarantee reading as intact while being untrue. The same shape as
ARCH-4 itself — a check that cannot see the thing it is about. So the predicate moved to a
dependency-free `domain/bundleClaim.ts`, and `test/schedulerGating.test.ts` gained a
**transitive** import-graph assertion that makes the split enforced rather than intended.

- [x] **Negative test (the fix)** — restoring the old due filter fails 2 of the 7 new
      tests: the race predicate, and `runDueApplies` claiming a row the bundle owns.
- [x] **Negative test (the invariant)** — importing `bundleClaimLive` from `../bundle`
      instead of `../bundleClaim` fails the new transitive check with
      `domain/exec.ts: child_process`, while the old text scan passes throughout —
      which is the demonstration that it was insufficient.
- [x] **Regression tests** — `test/applyLaneExclusion.test.ts` (7): the race, a control
      proving the skip is the claim and not the fixture, the expired-claim non-wedge, the
      unparseable timestamp, non-running states, and the exact lease boundary.
- [x] **Evidence in the status line** — 1,345 api tests pass.

**Residue:** co-arming is still permitted (**R-39**) — the finding's alternative
recommendation, deliberately not taken.

## ARCH-7

*The request-status vocabulary is an unowned, drifted contract.*

The server stored status as free text (`z.string()`); the SPA declared a 21-value union.
They had drifted in **both** directions. The scheduler writes `HALTED_DRIFT` and
`HALTED_APPLY_FAILED`, which a grep of `ccp/app/src` did not find at all — the client was
rendering statuses it could not type. Meanwhile the union carried ~10 statuses the api has
never written. All of it was recorded as a known tension in `DOMAIN-MODEL.md` and left
there while new statuses kept accreting, because nothing failed when they did.

The vocabulary is now one closed set (`ccp/app/src/lib/requestStatus.ts`, dependency-free
so `ccp/api` can import it through the `@app-lib` seam) with the two halt statuses in it.
Adding them was not a formality: two exhaustive `Record<RequestStatus, …>` tables in the
SPA — `StatusBadge`'s tone/label map and `RequestDetail`'s phase map — **stopped
compiling**, which is precisely the drift the finding describes, surfacing the moment the
union became true. Both now render a halt as a hard stop needing a human.

**The concrete bug the finding predicted was in the rate limiter.** `OPEN_STATUSES` was a
hand-maintained list of the five statuses that occupy a requester's `maxOpen` slot, and
the vocabulary grew underneath it: `APPLYING` and both halts arrived with the scheduler,
`WINDOW_EXPIRED` with maintenance windows, and none was added. Every one is non-terminal —
mid-apply, waiting on a human, or parked with two exits — and every one **silently released
the slot**, so a requester could hold unbounded open work by letting requests halt or park.

It is now derived as *not terminal*. That inversion is the fix, not a relocation: the old
list was of OPEN statuses, so anything it had not heard of released the slot; the new one
is of TERMINAL statuses, so a status added tomorrow holds it until someone decides
otherwise. Same forgetting, opposite consequence.

**The parity check found a second unowned vocabulary on its first run.**
`PendingConfigChangeItem` has its own five statuses — already closed in zod, but unnamed,
and sharing the literal `APPLIED` with requests while meaning something different. So the
rule is about *declaration*, not about one set: every status literal in the api must belong
to some declared closed vocabulary, and a new entity has to name its own (L-25). The
pending-change set is now exported from its schema, derived from `.options` so it cannot
drift from the enum it describes.

- [x] **Negative test** — restoring the five-status hand list fails the fail-open test on
      all four missed statuses (`APPLYING: expected false to be true`).
- [x] **Regression tests** — `test/statusVocabulary.test.ts` (8), including an
      `L-1` sanity assertion that the source scan finds anything at all, and an explicit
      test that an unknown status occupies a slot.
- [x] **Evidence in the status line** — 1,353 api + 2,738 app tests pass; app build green.

**Residue:** the ~10 client-only statuses stay (**R-40**), the store schema still types
status as `z.string()` (**R-41**), and `APPLIED` still conflates "landed" with "approved,
no apply lane armed" (**R-42**).

## API-10

*Session revocation can be silently undone by the idle-slide write-back race.*

One defect, filed twice from two reports — which is itself the reason it is worth stating
plainly. `resolveSession` slid the 30-minute idle window with an unconditional whole-item
`store.put(slid)` after two awaited reads. The **self-service** revocation paths —
`DELETE /auth/sessions/:id` and `POST /auth/sessions/revoke-others` — revoke by deleting
rows *without* bumping `sessionVersion`, deliberately, so that "sign out my other devices"
does not sign out the device asking. So an in-flight request on the session being revoked
would read the row, watch the delete land, and then **recreate it**.

The revocation was undone, and the resurrected row slid its own idle window on every
subsequent request, so the "revoked" session lived to absolute expiry. Not a corner case:
the reason to revoke a session is that it is active, a polling SPA has a request in flight
essentially always, and `killOtherSessions` deletes row-by-row, holding the window open
across every row.

**Why it stayed invisible** is the interesting part. The `sessionVersion`-bumping paths
(password reset, admin revoke-sessions) are immune — a resurrected row fails the version
check — so two families of revocation sat next to each other in the same file and only one
of them worked. Anyone testing "does revocation work" would have reached for the admin one.

The slide is now a guarded `update`: `ifEquals` on `lastSeenAt`, which the store fails
against a **missing** item (DynamoDB-faithful, `memoryStore.ts`), so a deleted row cannot
be conditioned back into existence. It also narrows the write to the one attribute that
changed, so the slide can no longer clobber a concurrent mutation to any other field.

**A lost condition is not automatically a dead session**, and treating it as one would have
traded this bug for a worse one. Two different things lose the guard: the row was revoked,
or *another in-flight request on the same session slid it first* — which the
`SLIDE_GRANULARITY_MS` coalescing makes likely under a burst. Signing a user out because
two of their own tabs raced would be a self-inflicted denial of service. So the loser
re-reads and lets presence decide: gone means revoked, present means someone else did the
work. One extra read, only on the contended path.

- [x] **Negative test** — restoring the blind `put(slid)` fails 2 of the 5 tests: the
      direct race, and `killOtherSessions` with a request in flight on a victim row.
- [x] **Regression tests** — `test/sessionRevokeRace.test.ts` (5), driven by a store
      wrapper that lands the delete between the `get` and the write, plus a control that
      an unrevoked session still slides and an explicit test that losing a slide race to
      your own other tab does **not** sign you out.
- [x] **Evidence in the status line** — 1,358 api tests pass.

Each of the two race tests asserts that the interleave actually fired before asserting the
outcome — without that they would pass against a fixture that was never racing (L-1). The
same rule caught a real fixture bug here: the first version minted sessions with a guessed
`sessionVersion: 0` while the seeded account carries `1`, so every session failed the
version check and three tests were green for the wrong reason.

## CONC-4

*A revoked session can be resurrected by the concurrent idle-window slide.*

The same defect as **API-10**, reported independently from the concurrency review — same
file, same two line ranges, same recommendation. Closed by the same guarded slide; the
reasoning, the negative test and the regression suite are recorded once, under API-10.

Worth leaving both entries rather than merging them: two reviewers finding the same race
from opposite directions (an API-surface read of "does revocation revoke" and a
concurrency read of "what does this blind put race") is evidence about the defect, not
duplication to tidy away.

- [x] **Evidence in the status line** — see **API-10**; `test/sessionRevokeRace.test.ts`.

## CONC-9

*Dual-control ack does not guard the pending row's status: a concurrently rejected
proposal can still apply.*

`ackPending` and `rejectPending` both read the pending row, verify `status === 'PENDING'`
in memory, and then wrote the transition **unconditionally**; `sweepExpired` blind-put the
whole row. Three ways for a proposal to leave PENDING, and each could overwrite either of
the others.

The ack case is the sharp one, and it survived a retry loop that looks like it should have
caught it. `ackPending` transacts `[apply, pending → APPLIED]` and retries on chain
contention. A reject committing in between changes **the pending row and nothing else** —
so the retry's re-check, which examined only the apply *target's* guard, still passed. The
config change applied and the row flipped `REJECTED → APPLIED`: an admin's explicit
refusal overridden by a racing ack, with the audit chain faithfully recording both.

All three transitions now carry `ifEquals: {attr:'status', value:'PENDING'}`.

- **Ack** additionally re-reads on a lost condition instead of retrying. Retrying a lost
  *status* guard can only fail again — nothing puts a resolved proposal back to PENDING —
  so without that the caller got `CHAIN_CONTENTION` ("try again") for something no retry
  can fix. It now gets `STATE_CONFLICT`.
- **Reject** needed only the guard: carrying an `ifEquals` makes `transactWithAudit`
  refuse to replay the writes on contention (CONC-2's rule) and surface `STATE_CONFLICT`,
  which is already the right answer.
- **The sweep** was the worst-placed of the three — it runs on a timer against rows read
  in a previous step, so its write is stale by construction. A lost guard there is not an
  error and is not counted: somebody resolved the proposal while the sweep was walking,
  which is the outcome the sweep exists to avoid needing.

- [x] **Negative test** — removing all three guards fails 3 of the 7 tests: the race, its
      error code, and the mirror.
- [x] **Regression tests** — `test/pendingChangeCas.test.ts` (7), driven by a store
      wrapper that commits the competing resolution between the read and the write, plus
      three controls (uncontended ack, uncontended reject, and a sweep that still expires
      a genuinely stale row).
- [x] **Evidence in the status line** — 1,365 api tests pass.

The sweep control earned its place immediately: the fixture first hand-typed the GSI
partition name, the sweep found nothing, and "the sweep did not overwrite an acked row"
was true only because the sweep never looked at the row (L-1). The fixture now builds the
key from `pendingConfigGsi`.

## DATA-8

*Pending-change status transitions have no CAS: concurrent ack + reject can apply a change
and record it as REJECTED.*

The same defect as **CONC-9**, reported independently from the data-integrity review, and
naming the third site the concurrency report did not: `sweepExpired`'s unconditional
whole-row `put`. Both are closed by the same three guards; the reasoning, the negative test
and the regression suite are recorded once, under CONC-9.

- [x] **Evidence in the status line** — see **CONC-9**; `test/pendingChangeCas.test.ts`.

## CONC-7

*`FileStore` has no single-writer enforcement: two processes on the same data file
silently destroy each other's writes.*

Each process loads the snapshot into its own in-memory `Map` and, on every mutation,
rewrites the **entire file** from that map. Nothing stopped a second process opening the
same file. Two of them never see each other's writes and alternately overwrite the whole
store — accounts, sessions, requests, both audit chains — behind green health checks. And
every careful in-process guarantee is void between them: the chain-head CAS and the
`ifEquals` claims are all evaluated against a map that no longer describes the file.

`src/store/dataLock.ts` claims the file at open. **Why a pid file rather than `flock`:**
an OS advisory lock would be strictly better — the kernel releases it when the holder dies
— but Node exposes none, and a native dependency costs more than it buys in a codebase
whose posture is "no dependency you cannot read". So `O_EXCL` create, holder identity
inside, and an explicit answer for every way it can go stale.

**Staleness is where locks usually go wrong, and the first version got it wrong.** It
decided liveness by identity — "is the recorded pid alive on the recorded host?" — which is
broken in exactly the deployment this product documents as its default. Under
`docker compose` a container's hostname **is** its id, so a crash-restart arrives with a new
hostname and can never verify the old one: every OOM kill would have wedged the next boot.
And it is broken in the other direction too, because containers have their own pid
namespace and pid 1 always exists — a stale lock written by a dead container's pid 1 looks
*alive* to its replacement. The identity test fails open and closed at once, and shipping it
would have traded a silent data-loss bug for a loud availability one.

So the holder **heartbeats**: it rewrites the claim's timestamp every 30s, and a claim
unrefreshed for 120s is stale regardless of host, container or pid namespace. That is a
property of the file, checkable by anyone, and it bounds the post-crash wedge to about two
minutes rather than forever. The pid check survives only as a fast path, and only in the
direction that is safe:

| found | answer |
| --- | --- |
| heartbeat older than 120s | take over, loudly — works across hosts, containers, namespaces |
| same host, pid not alive | take over, loudly — the fast path; a bare-metal restart recovers in ms |
| unreadable timestamp | take over — a claim that can never be shown live must not hold forever |
| otherwise | refuse; something is writing this file right now |

The fast path can only ever **add** a takeover, never block one, which is what stops
container pid-1 ambiguity from keeping a genuinely stale lock alive. A test pins that
direction explicitly.

`CCP_DATA_LOCK_TAKEOVER=1` is the operator saying "I have checked". `release()` deliberately
does **not** delete a lock another process has taken over — otherwise a takeover plus a late
release hands a third process a lock the real writer believes it holds, which is the same
defect arrived at politely. A store that fails to *load* releases too, so an operator fixing
a corrupt snapshot does not have to clear a lock first.

**Every test fixture that "simulated a restart" had to change**, and that is the finding in
miniature: `fileStore.test.ts`, `backupRestore.test.ts`, `totpDevices.test.ts` and
`grantAdmin.test.ts` all opened a second `FileStore` on a live path. The shape was so easy
to write that the test suite had been writing it for as long as the store existed. A
restart now closes first.

It also found a real gap in the fix itself: `grant-admin` opened the store and never
released it, so a CLI that ran for 200 ms would have left the operator unable to start the
server it was preparing — the stale-lock wedge one layer up. It now releases in a `finally`,
and the server releases on SIGTERM/SIGINT/exit.

- [x] **Negative test** — removing the `DataLock.acquire` call fails 5 of the 17 tests.
- [x] **Regression tests** — `test/dataLock.test.ts` (17): the second-open refusal, the
      refusal message naming the holder, release-and-reopen, idempotent close, every
      staleness arm as a pure table test, the container crash-restart case, the fast path's
      add-only direction, the takeover flag, the no-lock-after-failed-load rule, and the
      take-over-then-release case.
- [x] **Evidence in the status line** — 1,382 api tests pass.

## DATA-9

*No single-writer guard: restore can be silently clobbered by a running server; nothing
prevents two processes on one file.*

The second half of **CONC-7**, and the sharper one: `scripts/restore.ts` was a second
writer *by design*. It installs a backup atomically — and then the running server's very
next persist (a session slide from any authenticated request will do) rewrites the file
from its own in-memory state and silently discards the restore. The operator reads
"restored N items" and has restored nothing, with no error anywhere.

`runRestore` now claims the same lock the server holds, before the write and across it,
and releases it after. Failing to claim it *is* the running-server check — one mechanism
serving both findings rather than a bespoke "is a server up?" heuristic that could only
ever approximate it.

- [x] **Regression tests** — three in `test/dataLock.test.ts`: the refusal, the data file
      being left untouched rather than half-restored, and a control that with the server
      stopped the restore lands *and* releases the lock.
- [x] **Evidence in the status line** — see **CONC-7**.

## CONC-11

*Registry writes that bump `version` without guarding it (trust-request upload, identity
confirm) can clobber concurrent registry ops and rewind the dual-control version guard.*

The `ProjectItem` row **has** an optimistic-concurrency discipline — the trust decision
guards `version`, and so do activate/archive/unarchive. These two handlers bypassed it
with unconditional full-row puts built from a stale read.

Two costs, and the second is the serious one. A trust-request upload racing an identity
confirm loses one of the two writes entirely. And because both handlers **reset** `version`
to `stale + 1`, they can **rewind** the counter to a value a pending dual-controlled
proposal already captured — after which a genuinely stale ack passes its `version` guard
against different row content. That is the precise class the guard exists to stop, defeated
by the writes that were supposed to advance it.

Both now carry `ifEquals: {attr:'version', value: project.version}`. Carrying a guard also
makes `transactWithAudit` refuse to *replay* these writes on chain contention (CONC-2's
rule) and surface `STATE_CONFLICT` — which is correct here: a replay would write exactly
the lost update the guard just caught.

**The regression test is a rule, not a pair of assertions.** A third handler added next
quarter with the same unconditional put is the failure being prevented, so the check scans
for *any* `version: project.version + 1` and requires a guard inside the same route
handler. Bounding it by the handler rather than a line window matters: the first version
used ±14 lines and reported a correctly-guarded handler as an offender, because its
`ifEquals` rides on a `transactWithAudit` call further down.

- [x] **Negative test** — and it failed the first time, revealing a hole in the check
      rather than in the fix. The scan matched **the prose of the very fix it protects**: a
      comment reading `guardAttr:'version' on the trust decision` satisfied the pattern, so
      deleting the real guard changed nothing and the test stayed green. It had been passing
      for the wrong reason from the moment it was written. Comments are now stripped first,
      and removing either guard fails the check.
- [x] **Regression tests** — `test/projectVersionGuard.test.ts` (4): the rule, an L-1
      sanity assertion that it finds the writers at all, the store-level property the
      handlers rely on, and the rewind demonstrated directly rather than described.
- [x] **Evidence in the status line** — 1,386 api tests pass.

## CI-9

*The recurring data lane keeps the silent-skip gate its own sibling workflow documents as a
trap.*

- [x] **Defect reproduced first** — `ccp-data.yml:56` gated on `if: vars.CI_RUNNER != ''`,
      and `scripts/ci/check-workflow-safety.sh` reproduces it mechanically against the
      pre-fix tree: the rule names the file, the job and the condition.
- [x] **Cause, not symptom** — the lane gated on a variable **the runbook never required**.
      `ccp-onboard.yml` had already called this exact construct a trap in its own header and
      moved to `CCP_PROJECT_ID`; a comment in one workflow cannot bind another, which is why
      the fix is a rule over all of them rather than a third careful comment.
- [x] **Regression test** — the CI-9 rule in `check-workflow-safety.sh`, wired into the
      unfiltered `path-filters` lane. Negative test confirmed: it fails against `origin/main`,
      naming `ccp-data.yml: job generate-and-upload`.
- [x] **Failure is loud** — it prints the offending file, job and condition, and refuses to
      run vacuously: a missing `ccp-data.yml` or `release-images.yml` exits non-zero rather
      than passing on finding nothing (**L-1**).
- [x] **Evidence in the status line** — `scripts/ci/check-workflow-safety.sh`.

**The runbook was part of the defect, not a mitigation of it.** `account-data-ci.md` had
grown a bold warning that `CI_RUNNER` is "required, and easy to miss … this lane's single
most common setup failure" — documentation standing in for a design that fails in practice.
With the gate moved, that variable is genuinely optional and the runbook now says so; the
trap is recorded as history rather than as a warning the operator must carry.

## CI-8

*PG-5's secret heuristic misses the most common real-world shapes, and its designated
backstop is dead in CI.*

- [x] **Defect reproduced first** — the finding's probe table re-run against the shipped
      pattern before anything changed: `ADMIN_PASSWORD=`, `DB_PASSWD:` and `apikey =` all
      pass the gate. Plus one the finding did not name — `client_secret:`, the OAuth shape —
      because `_SECRET` only ever matched uppercase.
- [x] **Cause, not symptom** — `[Pp]assword` cannot match all-caps `PASSWORD`, and all-caps
      **is** the env-var convention, so the single most common accidental-commit shape was
      the one shape the check could not see.
- [x] **Regression test** — `scripts/ci/publish-gate-selftest.sh`, driving the real gate
      through `--tree` against synthetic trees, wired into the `publish-gate` lane ahead of
      the gate itself. Negative test confirmed: 1 of 5 shapes caught before, 5 of 5 after.
- [x] **Failure is loud** — and the verdict line is the fix's other half: it now names any
      check that DID NOT RUN, so `PASS` can no longer mean "I could not look" (**L-1**).
- [x] **Evidence in the status line** — `scripts/ci/publish-gate-selftest.sh`.

**Case-insensitivity is the obvious fix and it is wrong.** Measured on this tree, `-i` takes
PG-5 from 7 hits to 49, and all 42 additions are camelCase identifier assignments —
`tKey = uploadTokenKey(id)`, `const driftVersionKey = …` — because the value class matches a
plain identifier as happily as a secret. A check with 42 false positives gets switched off,
which is how a repo ends up with no check at all. What separates the two is **case
uniformity**, so that is what the pattern keys on: an env-var shape or a snake_case shape,
never a camelCase word boundary. Scenario 2 of the selftest is that property, pinned.

**The recommendation's other half was rejected on measurement.** It suggests lowering the
value floor from 16 to 12. Done, and counted: 12 adds seven matches to this tree and every
one is a false positive — `aws_iam_role` as a `_key:` value, EFS idempotency tokens
(`d-eoyniqjaesh5`), `app-shared-fs`. The floor stays at 16. The recommendation was a guess at
a trade-off; the count is the answer to it.

**The backstop.** CI-2 restored PG-9 in CI, but "PG-5 is deliberately approximate *because*
gitleaks backs it up" was still only true where someone had installed gitleaks.
`PUBLISH_GATE_REQUIRE_ALL=1` (set by `publish-gate.yml`) turns a missing gitleaks into a red
gate naming what is absent — the same shape as `test/helpers/requireToolchain.ts`, and for
the same reason. Unset, a developer's laptop still degrades to a clean SKIP.

**Residue:** see `R-47` — the content checks remain blind inside binary-classified files.

## CI-6

*release-images publishes on any tag with no quality gate, mutable version stamping, and an
unconditional `latest`.*

- [x] **Defect reproduced first** — `check-workflow-safety.sh` run against `origin/main`
      fails all three publishing rules: no job depends on a gate, no concurrency group, and
      three tag rules move `latest` unconditionally.
- [x] **Cause, not symptom** — publishing had no precondition at all. The fix is a
      `preflight` job every publishing job `needs:`, so the gate cannot be bypassed by adding
      a fourth image.
- [x] **Regression test** — three rules in `check-workflow-safety.sh`, and the publisher set
      is **derived from the steps** (any job using `build-push-action`) rather than listed,
      so a new image is covered without editing the check. It refuses to pass if it can no
      longer find a publishing job at all.
- [x] **Failure is loud** — every refusal names the commit and what was missing.
- [x] **Evidence in the status line** — `scripts/ci/check-workflow-safety.sh`.

**What "checked" means here had to be decided, not assumed.** Requiring every lane to have
run would refuse legitimate releases, because path filters mean a lane's absence usually just
means "nothing in its scope changed". `gate` and `filters` are the two lanes deliberately
built *without* path filters, so they run on every commit that went through CI — which makes
their absence proof the commit was never checked, and them the honest required set.

**`latest` moves on a comparison, not on an event.** `flavor: latest=auto` would still tag a
maintenance release, since it cannot know `v0.1.1` is older than `v0.2.0`. The preflight
compares the pushed tag against the highest `v*` tag in the repository, and a dispatch build
never moves `latest` at all — a dispatch is not a release.

**Residue:** see `R-48` — a release can still be half-published, and the overwrite refusal is
proxied by the git tag rather than by the registry.

## CI-5

*Whether the api's live parity/integration suites run in CI depends on unpinned
runner-preinstalled toolchains; nothing asserts they ran.*

**Verified closed by the TEST-4 work. No code changed here.**

`ccp-api.yml` pins Go via `go-version-file: tools/catalogctl/go.mod`, installs Terraform, and
sets `CCP_REQUIRE_INTEGRATION=1`; `test/helpers/requireToolchain.ts` throws at module scope
when a required toolchain is absent, and all four files the finding names use it.

- [x] **Confirmed end to end, not by reading the fix** (**L-29**) — with
      `CCP_REQUIRE_INTEGRATION=1` and `go` removed from `PATH`,
      `scheduleWindowCheckParity.test.ts` **fails** ("1 failed | no tests", throwing from
      `skipUnless`) instead of skipping. With the variable unset it skips cleanly, 16 skipped,
      so a developer without the toolchain is not broken. Both halves of the guarantee hold.
- [x] **Evidence in the status line** — the verification above.

## ARCH-14

*The OpenAPI "parity test" is string containment, not parity.*

**Verified closed by the DOC-1/DOC-2 work. No code changed here.**

`openapi.test.ts` enumerates the live Hono route table and the contract's declared operations
and diffs them **both ways**: a path the spec declares that no route serves fails, and a route
the spec does not declare fails. There is no list to keep in sync, so the check cannot rot into
agreeing with itself.

- [x] **Confirmed end to end** (**L-29**) — deleting `/requests/{id}/approve` from the
      contract turns the suite red (2 failed of 21). Restored, 21 pass. The suite also pins
      its own extractors against a known-present operation, so a Hono upgrade that drops
      `.routes` cannot make two empty sets read as perfect parity.
- [x] **Evidence in the status line** — the verification above.

**Residue:** see `R-49` — the operation set is checked, the response shapes are not.

## TEST-11

*OpenAPI contract test is substring matching, not conformance.*

Same defect as **ARCH-14**, reported twice; fixed once and verified once — see that entry for
the end-to-end check. The one piece of TEST-11's recommendation that ARCH-14's does not
contain, validating live responses against the spec's response schemas, is recorded as `R-49`
rather than claimed.

## TEST-13

*The api suite is coupled to the wall-clock calendar: it goes red on a month boundary with no
code change.*

- [x] **Defect reproduced first** — and it reproduced itself, without help: the suite was green
      on 2026-07-30 (PR #11's CI) and red on 2026-08-04 with no commit in between. 12 failures,
      6 files, every one of the shape `expected [] to have a length of N but got +0`. Confirmed
      it was not environmental by re-running with and without coverage instrumentation, and by
      confirming no file under `ccp/api/src` or `ccp/api/test` had been modified.
- [x] **Cause, not symptom** — audit entries are partitioned by the month of the write, stamped
      from `src/clock.ts`. The tests disagreed with that clock in two mirror-image ways: eleven
      files derived the partition from `new Date()` (wall time) while the requests were made
      under a frozen July clock; two files hardcoded `202607` for entries `record()` stamped
      from the real clock. Fixing only the twelve failing assertions would have left every
      other instance of the same derivation to fire on a later boundary, so **all thirteen call
      sites were converted**, not just the red ones.
- [x] **Regression test** — the suite itself, run under a shifted system clock. `test/setup.ts`
      was temporarily prepended with a 4-month `Date` shift (not committed — it is a probe, not
      a fixture) and the whole suite re-run:

      | tests | real clock | clock +4 months |
      | --- | --- | --- |
      | unfixed | 12 failed / 6 files | **12 failed / 6 files** |
      | fixed | 1386 passed | **1386 passed** |

      That is the property the finding is about — the outcome no longer depends on the date the
      suite is run on — and it is checked by moving the calendar rather than by reasoning.
- [x] **Failure is loud** — it always was; the problem was that nothing ran it. See the residue.
- [x] **Evidence in the status line** — the shifted-clock run above.

**The window fixture needed a different fix from the partition.** `cooling.test.ts` pinned
`at: '2026-08-01'` as a literal and froze the clock per-test to keep it in the future — the
comment "(else wall-clock elapses it)" repeated at five call sites is the coupling being
noticed and worked around each time instead of removed once. It now derives from a named
`SUITE_NOW` and freezes in `beforeEach`, so "a window that has not opened yet" is a property of
the suite rather than of the date. The redundant per-test freezes are kept: where a test means
"before the deadline", saying so beats inheriting it.

**Residue:** see `R-50` — the lane that would have caught this is path-filtered, so a
time-triggered breakage still waits for an unrelated PR to surface it.

## TEST-5

*No code-coverage measurement anywhere; `coverage.test.ts` is not code coverage.*

- [x] **Defect reproduced first** — measured before changing anything, which is the whole
      point of the finding: no component reported a number, so "how much of this runs?" had
      no answer. First measurement: **api 96.00% statements / 87.85% branches / 95.04%
      functions**; **app 73.90% / 83.11% / 54.62%**.
- [x] **Cause, not symptom** — the provider was simply never installed and no config asked
      for a report. `@vitest/coverage-v8` in both packages, `coverage` blocks in
      `ccp/api/vitest.config.ts` and `ccp/app/vite.config.ts`, a `test:coverage` script in
      each, and both CI lanes switched to run it so the floor is enforced rather than
      available.
- [x] **Regression test** — the floor is its own regression test, and it was verified in both
      directions: a subset run (`test:coverage -- test/audit.test.ts`, 12.9% statements)
      **exits 1 naming all four thresholds**, and the full run exits 0. A gate that has only
      ever been seen passing is not known to be a gate.
- [x] **Failure is loud** — vitest names each metric, its actual value, and the threshold.
- [x] **Evidence in the status line** — the config files and the two CI lanes.

**The Go half was already done.** `catalogctl.yml` has run `-coverprofile` with a
`COVERAGE_FLOOR` of 93.0 (actual 98.6) since CI-1; the finding's third recommendation was
satisfied before this batch reached it — L-29 for the fourth time in B-O8.

**The floors are the measured numbers rounded down, not aspirations.** api 94/85/92/94, app
71/80/52/71 — a couple of points of headroom so ordinary churn does not trip them, in the same
ratchet spirit as the existing Go floor. The app's numbers are much lower and that is the
honest reading rather than a lenient one: **functions at 54.62%** is what TEST-7's finding
costs in practice — ~25 SPA files pin UI by inspecting source strings instead of rendering, so
half the component functions are never called by the suite that "covers" them.

**The three misleading files are renamed**, which was the other half of the finding:

| was | is | what it actually asserts |
| --- | --- | --- |
| `coverage.test.ts` | `catalogManifestCompleteness.test.ts` | every manifest well-formed; every service has a team and metadata |
| `fullCoverage.test.ts` | `provisionTileCompleteness.test.ts` | no op-less service is a dead Provision tile |
| `adminCoverage.test.ts` | `adminSurfaceCompleteness.test.ts` | every managed domain has an admin route |

All six inbound references were updated (`awsServiceMap.ts`, `ccp/app/README.md`,
`MAINTAINING-THE-CATALOG.md`, `FUNCTIONAL-TEST-PLAN.md`); `docs/audit/` was deliberately left
alone, since the reports quote the old names as their evidence.

**Residue:** see `R-51` — the app's function coverage is the number that matters and the one
this fix can only record, not move.

## CI-13

*The smoke proves boot + serve, not the system's function; PR runs of it are triggered by any
`ccp/**` docs change.*

- [x] **Defect reproduced first** — the smoke's own success line said what it proved:
      "`/readyz` (200, bootstrapped) and the SPA is served in api-mode". Confirmed the gap is
      real rather than rhetorical by checking what a break would do: with the session guard
      removed, `GET /requests` answers 200 and the smoke still passes; nothing in the run
      touched an authenticated surface at all.
- [x] **Cause, not symptom** — boot+serve was the whole assertion set. Three properties now
      stand between "a process is answering" and "this is a control plane", all reachable with
      no estate, cloud credential, or fixture: authorization is **wired** (anonymous
      `GET /requests` → 401), credentials are **verified** (wrong password → 401), and the
      credential path **works** (the bootstrap admin authenticates and is held at the
      first-run password gate).
- [x] **Regression test** — the smoke itself, and both directions were checked rather than
      assumed: pointing assertion 1 at an unprotected route (`/healthz`) **dies on 200**, and
      a body that is not an authenticated login **dies** rather than matching. Exact status
      codes, never ranges — a 500 from a broken route must not read as a pass merely because
      it is not 200.
- [x] **Failure is loud** — each refusal names the route, the code it got, and the code it
      expected.
- [x] **Evidence in the status line** — the CI `smoke` job is green on the assertions
      (run 31160044838).

**The finding's recommendation named a phantom.** It suggests asserting `GET /catalog`; there
is no such route in `ccp/api/src` — it is one of the paths DOC-1 deleted from the contract for
exactly that reason, and following the recommendation would have pinned a fourth phantom.
`GET /requests` is the real project-scoped protected read (**L-29**).

**The trigger fix could not be spelled the obvious way.** `paths-ignore: ccp/docs/**` alongside
`paths:` is a workflow GitHub **rejects** — both filters on one event is invalid — so the
exclusion is a negated pattern inside `paths:`, ordered after the positive it narrows. Also
corrected the header's `APP_PORT (default 4173)` against a code default of 8800, which had been
sending readers to the wrong port.

**Residue:** none. The smoke still serves via `vite preview` rather than the shipped nginx
config, so the SPA-fallback/caching behaviour remains untested — but that is CI-7's subject
(the Docker build path is never exercised), already open and unchanged by this fix.

## DOC-11

*OpenAPI types `ChangeRequest.planSummary` as a string; the API stores and serves a structured
object.*

- [x] **Defect reproduced first** — the mismatch was already documented in the contract itself:
      the `PlanSummary` component (added by DOC-2) carried a note saying `ChangeRequest.planSummary`
      "is still typed `string` and does NOT match this — that mismatch is tracked separately as
      DOC-11 and is deliberately not touched here." The schema comment on
      `store/planSummarySchema.ts` independently calls the string shape "the Stage-0 fiction — no
      route ever wrote it."
- [x] **Cause, not symptom** — the `PlanSummary` schema existed and was correct; only the
      `$ref` from `ChangeRequest.planSummary` was missing, left for this finding on purpose.
- [x] **Regression test** — `openapi.test.ts`'s existing route↔contract parity suite (DOC-1/DOC-2)
      re-parses the YAML on every run; a syntactically broken `$ref` fails it. Verified: 21/21
      pass, plus `test/planSummary.test.ts` (the schema's own suite) and the full api suite
      (98 files / 1387 tests) unaffected.
- [x] **Failure is loud** — a malformed `$ref` fails contract parsing outright, not silently.
- [x] **Evidence in the status line** — the YAML diff itself.

**No code changed.** `planSummary` was already `.optional()` in the store schema and never
assigned `null`, so `$ref: PlanSummary` (itself `required: [resourceChanges, counts]`) is correct
as an optional property — OpenAPI lets a property be entirely absent regardless of its own
schema's internal `required` list. The stale "deliberately not touched here" note in the
component's description was updated to say what actually references it now.

## API-12

*`prNumberFromUrl` extracts a "PR number" from any URL ending in digits.*

- [x] **Defect reproduced first** — the doc comment on `prNumberFromUrl` always said
      "`/pull/123`-shaped"; the regex `/(\d{1,9})\/?$/` never enforced that. Reproduced: a GitHub
      *issue* link (`.../issues/42`, not a PR) and a bare `https://example.com/9999` both
      "derived" a number.
- [x] **Cause, not symptom** — the regex matched trailing digits with no path-segment
      constraint at all. Now requires `/pull/<n>` or `/merge_requests/<n>` immediately before the
      number — the two shapes GitHub/Bitbucket and GitLab actually use, per the finding's own
      recommendation.
- [x] **Regression test** — `test/linkPr.test.ts`, three assertions in one test so the fix
      cannot pass by being unconditionally strict: an issue link and a bare URL both derive
      nothing; a GitLab `/merge_requests/55` URL still derives `55`. **Negative test confirmed**:
      run against the unfixed regex, the issue-link assertion fails (`expected 42 to be
      undefined`); against the fix, all three pass.
- [x] **Failure is loud** — a mis-derived number is not silently accepted anywhere; it renders
      directly in timeline labels and link text, which is exactly the impact the finding named.
- [x] **Evidence in the status line** — `test/linkPr.test.ts`.

**Existing precedent, not a new pattern.** `linkPr.test.ts` already asserted the *no-numeric-tail*
negative case (`.../pulls` derives nothing); this fix and its test extend that same shape rather
than inventing a new convention.

## API-13

*`maxOpen` rate-limit counts a nonexistent status and misses real open states.*

**Verified closed by ARCH-7. No code changed here.** Discovered incidentally while verifying
B-S2 (the finding shares its root cause — an unowned status vocabulary — with DOC-13), and closed
immediately rather than deferred to B-S1's run: the runbook's own instruction is "check the code
at HEAD first, and if it is closed, close it with evidence rather than a patch."

- [x] **Confirmed against the exact both-halves claim, not by reading the fix** (**L-29**).
      `rateLimit.ts` no longer holds a hand-maintained `OPEN_STATUSES` list at all — it imports
      `occupiesQuotaSlot` from `@app-lib/requestStatus` (ARCH-7's closed vocabulary) and inverted
      the direction: a status occupies a slot unless it is in the small `TERMINAL_STATUSES` set,
      so an unrecognised future status fails closed rather than silently escaping the quota.
      `CHANGES_REQUESTED` is gone from the counted set (the "nonexistent status" half); `APPLYING`,
      `WINDOW_EXPIRED`, `HALTED_DRIFT`, `HALTED_APPLY_FAILED` are all covered (the "misses real
      open states" half).
- [x] **Already has the negative test the finding would have asked for** —
      `test/statusVocabulary.test.ts:98-102`, literally titled "THE FAIL-OPEN: the four statuses
      the hand-maintained list had missed all occupy a slot", asserting all four by name. A
      sibling test confirms the five statuses the old list *did* hold are unchanged, and another
      confirms an unknown future status occupies a slot by default (the inversion's whole point).
- [x] **Evidence in the status line** — `test/statusVocabulary.test.ts`.

## DOC-13

*Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML
prose).*

- [x] **Defect reproduced first** — confirmed the finding's premise still held at HEAD
      before touching anything: ARCH-7 (an earlier session) had already closed the
      SPA-union-vs-server-writes half by giving both sides one closed vocabulary
      (`@app-lib/requestStatus`). What remained was exactly the third leg — the YAML's
      `ChangeRequest.status` "known values" prose still never mentioned `APPLYING`,
      `HALTED_DRIFT`, or `HALTED_APPLY_FAILED`.
- [x] **Cause, not symptom** — the prose was a hand-written flow diagram nobody re-derives
      when the vocabulary grows, the same shape ARCH-7 already fixed once for the SPA
      union. Extended the flow at the accurate transition points (verified against
      `scheduler.ts`'s own doc comments: the guarded `AWAITING_DEPLOY_APPROVAL → APPLYING`
      claim, and that both halt statuses exit ONLY via cancel, never rewindow).
- [x] **Regression test** — `test/openapi.test.ts`, a new `describe` block: scans the api
      source for every request-status literal actually written (reusing
      `statusVocabulary.test.ts`'s scan shape, intersected with `REQUEST_STATUSES` so
      `PENDING_CHANGE_STATUSES` — a different entity's vocabulary — cannot leak in) and
      asserts each is a substring of the prose. **Negative test confirmed**: reverting just
      the prose fails with exactly `["APPLYING", "HALTED_DRIFT", "HALTED_APPLY_FAILED"]` —
      no more, no less.
- [x] **Failure is loud** — the assertion names precisely which statuses the prose is
      missing.
- [x] **Evidence in the status line** — `test/openapi.test.ts`.

**The finding's own recommendation was half wrong, and rejected on measurement, not
opinion.** It says to also add `CHANGES_REQUESTED` and `WITHDRAWN` to the "known values."
A repo-wide grep shows neither is EVER assigned as a status anywhere in `ccp/api/src` —
`CHANGES_REQUESTED` appears nowhere outside comments and vestigial filter lists (its
presence in the rate limiter's old hand-maintained list was itself API-13's "nonexistent
status" bug), and `requestStatus.ts`'s own comment already calls `WITHDRAWN` "client-only
vocabulary the api has never written." Adding either to prose describing "values a client
can actually receive" would have recreated DOC-13 in the opposite direction — the wire
prose over-describing instead of under-describing. Only the three statuses the api
genuinely writes were added.

## FE-11

*`WINDOW_EXPIRED` is missing from both status-filter vocabularies.*

- [x] **Defect reproduced first** — confirmed both `MyRequests.tsx` and
      `ApprovalsQueue.tsx` hand-typed an identical 20-entry `ALL_STATUSES` array missing
      `WINDOW_EXPIRED` — and, discovered independently while verifying, also missing
      `HALTED_DRIFT`/`HALTED_APPLY_FAILED`: ARCH-7 added both to the vocabulary after this
      array was written, and the array drifted a second time in exactly the shape the
      finding diagnoses.
- [x] **Cause, not symptom** — "these lists have no compile-time completeness check,
      which is how the drift happened" is the finding's own diagnosis, confirmed twice
      over by the second drift. Both `ALL_STATUSES` now read `REQUEST_STATUSES` directly
      (the closed, exhaustive `as const` array `RequestStatus` is derived FROM) rather
      than restating it, so the list cannot omit a value without the type itself changing
      under it.
- [x] **Regression test** — one assertion per file, over the WHOLE vocabulary rather than
      naming `WINDOW_EXPIRED` alone (so a status added next quarter cannot regress the
      same way a third time): every `REQUEST_STATUSES` value round-trips through
      `parseFilters` without coercing to `'all'`. **Negative test confirmed** against both
      unfixed files: fails on `WINDOW_EXPIRED` first, exactly as named.
- [x] **Failure is loud** — the failing status name is the test's own label.
- [x] **Evidence in the status line** — `test/myRequests.test.ts`, `test/approvalsQueue.test.ts`.

`parseFilters`'s `STATUS_SET` is built from `ALL_STATUSES`, so the URL-coercion fix (the
finding's stated Impact — `?status=WINDOW_EXPIRED` no longer collapses to `'all'`) followed
from the array fix with no separate code path to touch.

## UI-10

*Request-status copy has four competing sources; raw enum text can reach the UI.*

- [x] **Defect reproduced first** — all four sources confirmed independently: `StatusBadge`'s
      curated `STATUS_SPEC` labels ("Awaiting review" for `AWAITING_CODE_REVIEW`), three
      separately-declared `humanizeStatus` clones (`MyRequests.tsx`, `ApprovalsQueue.tsx`,
      `lib/palette.ts`) producing "Awaiting code review" for the same status a few pixels
      away, and `Notifications.ownNote`'s default branch interpolating the raw enum
      (`· CHECKS_RUNNING`) for any status its switch does not name explicitly.
- [x] **Cause, not symptom** — four independent places owned the same fact. Extracted
      `STATUS_SPEC` and a `requestStatusLabel()` helper into a new `lib/statusCopy.ts`
      (the finding's own suggested alternative name) rather than exporting from
      `StatusBadge.tsx` as literally recommended: `lib/palette.ts` needs the mapping too,
      and `lib/` importing FROM a component file (with its CSS side-effect import) would
      have been the wrong dependency direction. `StatusBadge.tsx` now reads FROM
      `lib/statusCopy.ts` instead of owning the table.
- [x] **Regression test** — `test/notifications.test.ts` (new): every `REQUEST_STATUSES`
      value NOT named explicitly in `ownNote`'s switch is asserted to produce a detail
      string containing no SCREAMING_SNAKE token, and `CHECKS_RUNNING` specifically is
      asserted to render "Checks running" — the exact word `StatusBadge` uses, which is
      the whole point of one source. **Negative test confirmed** against the unfixed
      default branch: fails with `'Request · CHECKS_RUNNING'` (the raw token, verbatim).
- [x] **Failure is loud** — a regex assertion (`/[A-Z]{2,}_[A-Z_]+/`) rather than an
      enumerated blocklist, so a fifth clone introduced later fails the same way (L-25).
- [x] **Evidence in the status line** — `test/notifications.test.ts`.

**One deliberate, visible copy change.** `palette.ts`'s clone produced lowercase text
("quiet secondary text," per its own comment) while the other two capitalized. Routing it
through the shared `requestStatusLabel()` makes the palette hint match the badge exactly —
which is the finding's whole point — at the cost of that hint's casing changing from
"awaiting code review" to "Awaiting review" in the command palette. No test asserted the
old casing; checked before making the change, not after.

## PERF-9

*`ServiceConsole` loads the entire block-source corpus on every service page mount, fetching
server chunks sequentially.*

- [x] **Defect reproduced first** — confirmed at HEAD: `ServiceConsole`'s mount effect called
      `allBlockSources()` (documented on itself as "the rare panel that needs a whole-estate
      answer, never on initial load") to feed the family-rollup join, and in api mode
      `allBlockSources` fetches every chunk of the project sequentially — a `for…await` loop, not
      even `Promise.all`.
- [x] **Cause, not symptom** — the console had no way to ask for "just the chunks these
      resources live in"; only "give me everything" existed. Added `blockSourcesFor(addresses)`:
      computes the needed file bases up front from the address→chunk index (deduplicated), then
      fetches each unique chunk exactly once, concurrently (`Promise.all`). `ServiceConsole`'s
      mount effect no longer touches block sources at all; a new effect gated on
      `[manifest, inventory]` (so it has the resolved resource-type set to scope by) calls
      `blockSourcesFor` with only this page's addresses. `allBlockSources()` is kept, unchanged,
      for `lib/dependents.ts`'s genuine whole-estate replace-dependents scan.
- [x] **Regression test** — `test/block-source.test.ts`, new `describe` block against the real
      bundled sample estate (no mocking): a single address returns only its own chunk's two
      addresses (asserted by name, not just count); two addresses spanning different chunks return
      the union, still far short of `allBlockSources()`'s ~40+; an unknown address and an empty
      list both resolve to `{}`. **Negative test confirmed**: reverting `blockSourcesFor` to `return
      allBlockSources()` fails all four new assertions.
- [x] **Failure is loud** — a scoping regression shows up as `scoped.length` no longer being
      `< whole.length`, named explicitly in the test.
- [x] **Evidence in the status line** — `test/block-source.test.ts`; full app suite (155 files /
      2768 tests) green.

## PERF-13

*SchemaForm recomputes inventory-derived enums for every field on every keystroke.*

- [x] **Defect reproduced first** — confirmed `resolveEnum`'s inventory branch ran a fresh
      `inventory.resources.filter().map()` scan on every call, called inline in `SchemaForm`'s
      render for every inventory-sourced param. Any field's `onChange` lifts state to the parent
      and re-renders the whole form, so at the 50k-resource cap this was ~200k filter/map
      operations per keystroke across a form's several enum fields.
- [x] **Cause, not symptom** — no memoization existed anywhere in `resolveEnum`. Added
      `inventoryEnumValues`, keyed by a `WeakMap<Inventory, Map<type, Map<field, string[]>>>` —
      keyed on the inventory OBJECT (not a manual cache with explicit invalidation), so a project
      switch or refresh (which always produces a new inventory reference) is automatically a cache
      miss, and the old entry is garbage-collected once nothing references that inventory anymore.
      **Deliberately NOT extended to the allowlist branch**: `narrowAllowlist` reads a live,
      mutable admin override that can change while a form is open — caching that branch would let
      a form keep offering a value an admin had just revoked.
- [x] **Regression test** — `test/interpreter.test.ts`, new `describe` block, reference-identity
      assertions (`.toBe`, not `.toEqual` — a fresh scan always allocates a new array even with
      identical contents, so only identity proves a cache hit): two calls with the same inventory
      return the SAME array; two different params sharing one `enumSource` (real manifest data —
      `ec2-resize` and `ec2-add-instance-tag` both reference `inventory://aws_instance/address`)
      share the cached scan; a cloned inventory object does not share the cache (`.not.toBe`) but
      matches structurally (`.toEqual`); the allowlist branch stays live across a
      `setAllowlistOverride` call between two otherwise-identical calls. **Negative test
      confirmed**: reverting to the unmemoized function fails the two `.toBe()` identity
      assertions with vitest's own "replace toBe with toStrictEqual" hint — proving those
      assertions actually distinguish "cached" from "recomputed but coincidentally equal."
- [x] **Failure is loud** — an identity assertion, not a structural one; a future change that
      accidentally re-introduces a fresh allocation on a cache hit fails immediately.
- [x] **Evidence in the status line** — `test/interpreter.test.ts`; full app suite green.

## PERF-15

*Request-history views render unbounded lists without windowing.*

- [x] **Defect reproduced first** — confirmed all three cited locations render one DOM node per
      item with no cap: `MyRequests.tsx`'s per-lane `items.map(...)`, `ApprovalsQueue.tsx`'s
      `filtered.map(...)` over full `ReviewCard`s (the heaviest per-item cost in the app — each
      carries a full diff/plan panel), and `LeadDashboard.tsx`'s `rows.map(...)` into one `<tr>`
      per request across every team, forever (initially mis-guessed as chart-only aggregation;
      corrected by reading the file directly — it is a real unbounded `<table>`).
- [x] **Cause, not symptom** — no windowing existed on any of the three. Added
      `lib/windowing.ts`'s `windowSlice` — a pure `(items, size) → {visible, hiddenCount}` — and
      applied it identically at all three sites: `MyRequests` keeps a per-lane visible-count
      (so "Show more" in Active never also reveals Done rows), `ApprovalsQueue` and
      `LeadDashboard` each keep one counter. All three reset to `DEFAULT_WINDOW_SIZE` (50)
      whenever their own filters change.
- [x] **Regression test** — `test/windowing.test.ts`: the slice caps at `size`, hiddenCount is the
      exact overflow, a shorter-than-window list and an exact-length list both report `hiddenCount:
      0` (no off-by-one), an empty list is untouched, a non-positive size clamps to 1 rather than
      rendering nothing. **Negative test confirmed**: reverting `windowSlice` to
      `{visible: [...items], hiddenCount: 0}` fails the over-length and clamp assertions exactly.
      DOM-node-count itself is untestable here — this repo ships no `@testing-library/react` and
      no jsdom/happy-dom environment (see `package.json`; tracked separately as TEST-7) — so the
      test coverage is deliberately the pure slicing law every screen shares, not the JSX.
- [x] **Failure is loud** — an off-by-one in the slice fails the exact-length/shorter-than-window
      assertions by name.
- [x] **Evidence in the status line** — `test/windowing.test.ts`; typecheck clean; full app suite
      (155 files / 2768 tests) green.

**Deviated from the finding's literal hint, on purpose.** TRIAGE.md's compressed description says
"virtualization already exists in this codebase — reuse it" (`VirtualRows.tsx`,
`@tanstack/react-virtual`). The finding's own prose in `11-performance-scalability.md` offers
"windowing (or VirtualRows-style virtualization)" as two distinct alternatives, and windowing was
chosen: `VirtualRows` is tightly coupled to service-console-specific row types (not a drop-in for
a grouped lane list or a semantic `<table>`), has zero test coverage of its own today, and this
repo's total lack of DOM-testing infrastructure means a `useVirtualizer`-based rewrite of these
three screens could not be regression-tested at all — while the windowing law is pure and fully
covered. `LeadDashboard`'s table is included (not deferred as residue): capping rendered `<tr>`s
needs no markup rewrite, unlike true virtualization of a semantic table, so it carried none of the
risk that would have justified leaving it out.

## PERF-6

*API mode re-downloads and re-parses the full inventory + manifest set on every route mount; the
serve endpoints send no caching headers.*

- [x] **Defect reproduced first** — confirmed both halves at HEAD: `getProjectManifests`/
      `getProjectInventory` (`httpApi.ts`) issued a fresh, unconditional `GET` on every call with
      no client-side memory of a prior response, and `serveActive` (`routes/projectData.ts`) sent
      only `Content-Type` — no `ETag`, no `Cache-Control`, no 304 path — while reading the file
      with synchronous `readFileSync` (`domain/projectData.ts`), blocking the whole event loop for
      the read.
- [x] **Cause, not symptom, on all three sub-parts**:
      - **Client cache**: added a module-scoped `servedCache` inside `createHttpApiClient`'s
        closure, keyed by `<projectId>:<manifests|inventory>`, storing `{etag, body}`. A cache hit
        sends the remembered ETag as `If-None-Match`; a 304 returns the cached body directly —
        skipping BOTH the transfer and the re-parse (`parseManifests`'s zod pass included), which
        is the finding's actual concern, not just the transfer. A response with no ETag is never
        cached, so this can only ever be as stale as the server allows.
      - **Server ETag**: `servedEtag` quotes the SAME digest the upload pipeline already verified
        and stores post-redaction (`ProjectDataVersionItem.digests` — the exact served bytes, not
        a recomputed hash), so this costs nothing beyond the row read `serveActive` already
        performs. `If-None-Match` (comma-list or `*`) short-circuits to a bodyless 304.
      - **Async read**: `readProjectDataFile` switched from `fs.readFileSync` to
        `fs.promises.readFile`; its one call site awaits it.
- [x] **Regression test**:
      - `test/httpApiProjectData.test.ts`, new `describe` block: a repeat call sends the
        remembered ETag and a 304 returns the exact SAME object as the first call (`.toBe`, not
        `.toEqual` — proving the re-parse was skipped, not just that the values happen to match);
        manifests and inventory get independent cache entries; a response with no ETag is never
        cached (every call stays unconditional); different projects never cross-share an entry; a
        fresh 200 (simulating a new active version/digest) replaces a stale cached ETag rather
        than the client trusting its old one forever.
      - `test/projectData.test.ts`, new `describe` block against the real route (no mocking):
        inventory/manifests carry an `ETag` equal to `digest(servedBody)`, blocks index/chunk
        carry none (no whole-part digest exists for them); a matching `If-None-Match` gets a
        bodyless 304 carrying the same ETag; a wrong or stale one still gets the fresh 200 body; a
        wildcard `*` also short-circuits; activating a NEW version changes the ETag, so a client
        still holding the old one gets a fresh 200 with the new content, never a stale 304.
      - **Negative test confirmed** on both files: reverting the client cache back to an
        unconditional fetch fails the identity/If-None-Match assertions; reverting the server back
        to no-ETag fails all four new server-side assertions (`expected null to be
        '"<sha256>"'`, `expected 200 to be 304`, etc.) exactly as expected.
- [x] **Failure is loud** — an identity mismatch on a 304 (client) or a missing/wrong `ETag`
      header (server) both fail their exact assertions, not a generic smoke check.
- [x] **Evidence in the status line** — `test/httpApiProjectData.test.ts` (19 tests),
      `test/projectData.test.ts` (39 tests); app typecheck clean; api typecheck clean; full app
      suite (155 files / 2768 tests) and full api suite (98 files / 1393 tests, 1 pre-existing
      skip) both green.

**Scope note.** The finding's recommendation also mentions caching "per `(projectId,
activeVersion)`" using the version from the project registry. That would require an extra
network round trip most navigations don't already make just to learn the current version. The
ETag mechanism gives the same correctness guarantee — the server's digest IS the version identity
— without inventing a second, independently-maintained cache key that could itself drift out of
sync with what the server actually has active; the finding's own text calls even a simpler
project-id-keyed cache "enough to remove >90% of fetches," so this satisfies it. Only the
`manifests`/`inventory` serve endpoints got an ETag — `blocks-index`/`blocks-chunk` have no
whole-part digest stored today (only the inventory/blocks/manifests triple is hashed at upload)
and are out of this finding's cited scope; their repeat-fetch cost was already addressed
separately by PERF-9's chunk-level cache in `blockSource.ts`.

## API-6

*The 72-hour dual-control expiry is dead code: `sweepExpired` has no callers and `ackPending`
never checks `expiresAt`.*

- [x] **Defect reproduced first** — confirmed both halves at HEAD: `sweepExpired` was called
      only from tests (`grep` across `src/` and `test/` — zero production call sites), and
      `ackPending` checked `pending.status !== 'PENDING'` but never compared `expiresAt` against
      the clock, so an admin could ack a proposal any amount of time past its 72h window as long
      as nothing had swept it first.
- [x] **Cause, not symptom** — no lazy-settlement path existed for dual-control proposals at
      all, unlike every OTHER lease in this codebase. Followed the SETTLE-ON-READ doctrine
      `domain/cooling.ts#settleCooling`, `domain/schedule.ts#settleWindow`, and
      `domain/scanJobLease.ts#settleScanJobLease` already establish (TRIAGE.md names this
      explicitly as the pattern to copy): added `pendingExpired` (a pure predicate) and
      `settlePendingExpiry` (the lazy, guarded, audited settle — see ARCH-10 below for its
      audit half), then wired it into the THREE acts that actually touch a proposal:
      `GET /admin/config-changes` list-settles every row it returns (this is `sweepExpired`'s
      real production caller — the finding's "no callers" gap), and `ackPending`/`rejectPending`
      each settle the ONE row they are about to act on before checking its status, so a
      genuinely-expired-but-unswept row is refused rather than acted on regardless of whether a
      list read happened to run first.
- [x] **Regression test** — `test/dualControl.test.ts`, three new HTTP-level tests: (f) an
      expired proposal's ack returns 409 STATE_CONFLICT and the config change does NOT apply
      (the row is left EXPIRED, not APPLIED); (g) the same for reject; (h) `GET
      /admin/config-changes` settles an expired row on the read that discovers it (no explicit
      `sweepExpired` call anywhere in the test) and it is gone from the NEXT read — proving the
      list route is genuinely `sweepExpired`'s production caller, not just a function that
      exists. **Negative test confirmed**: reverting `dualControl.ts`/`admin.ts` to HEAD fails
      all three with the exact old-bug shapes (`expected 200 to be 409`, `expected 'PENDING' to
      be 'EXPIRED'`).
      `test/pendingChangeCas.test.ts`'s existing sweep race test was adjusted to move its ack
      BEFORE expiry rather than after — its old premise ("ack an already-expired row and expect
      it to apply") was itself API-6's bug; the fix correctly refuses that now, so the test's
      shape had to change to keep testing the invariant it actually cares about (a row resolved
      well before expiry is not later overwritten by a stale sweep pass).
- [x] **Failure is loud** — an ack/reject on an expired row gets the same explicit
      `STATE_CONFLICT` as any other already-resolved proposal, not a silent success.
- [x] **Evidence in the status line** — `test/dualControl.test.ts`; full api suite (99 files /
      1408 tests, 1 pre-existing skip) green.

## DATA-7

*The 72-hour dual-control expiry is unenforced: `sweepExpired` is dead code and `ackPending`
never checks `expiresAt`.*

**Identical defect to API-6 — two reports, one root cause, fixed once.** See API-6's entry for
the fix, evidence, and negative test. No separate code change.

## ARCH-10

*Unaudited governance transition: dual-control proposals expire silently.*

- [x] **Defect reproduced first** — confirmed `sweepExpired`'s pre-fix transact wrote
      `status: 'EXPIRED'` with NO audit entry at all — a governance transition (a proposal that
      would have loosened privilege silently timing out) left no trail, in sharp contrast to
      every other resolution of a pending change (`config-propose`, `config-apply`,
      `config-reject` all audit).
- [x] **Cause, not symptom** — expiry was bolted on as a bare status flip when DATA-8 first
      guarded it, never given the `recordIn`/chain-head write every other transition gets.
      `settlePendingExpiry` (API-6's fix, same function) now writes a `config-expire` audit
      entry — `actor: 'system:dual-control-expiry'`, `targetType: 'config-change'` — through the
      SAME chain-head-read + `recordIn` + retry-on-contention shape
      `domain/scanJobLease.ts#settleScanJobLease` already uses, so expiry is no longer a special
      case that skips the ledger.
- [x] **Regression test** — `test/dualControl.test.ts`, test (i): expires a proposal via
      `sweepExpired`, reads the project's real audit chain partition, and asserts a
      `config-expire` entry exists naming the correct actor and target. **Negative test
      confirmed**: reverting the fix fails with `expected undefined not to be undefined` — no
      entry was ever written.
- [x] **Failure is loud** — the entry's `action` field is the literal string the test searches
      for; a regression that stops writing it fails by absence, not by a wrong value slipping
      through.
- [x] **Evidence in the status line** — `test/dualControl.test.ts`.

## ERR-15

*Scan worker: a failed progress report abandons the job without a terminal status; a claim
non-2xx is process-fatal with no backoff.*

- [x] **Defect reproduced first** — confirmed both halves in `worker.go` at HEAD: a failed
      `ctrl.Report(ctx, job, "cloning"/"scanning", "")` returned bare
      (`fmt.Errorf("report %s: %w", ...)`) with no attempt at the terminal `failed` report every
      OTHER failure path in `runJob` gets via `fail()` — the job's server-side row was left
      wherever it last was. Separately, `Run`'s claim loop treated ANY `ctrl.Claim` error
      (connection refused during a control-plane restart, the 409 `CHAIN_CONTENTION` the claim
      route can emit) as fatal, returning an error that `cli.go`'s `run()` turns into exit 1 —
      relying entirely on Docker's `restart: unless-stopped` to crash-loop back in.
- [x] **Cause, not symptom** — a "cloning"/"scanning" report failure had never been routed
      through `fail()`; now it is (`fail(ctx, ctrl, job, "could not report cloning/scanning: "
      + err.Error())`), so it gets the SAME best-effort terminal-report attempt as a clone
      failure, an upload failure, or a refused clone URL. The claim loop no longer treats a
      transient failure as fatal in the ordinary LOOPING case: logged and retried after the same
      `poll` backoff idle already waits, rather than returning an error and exiting. `--once`
      keeps the old fatal behavior on purpose — a single shot has no loop to retry into.
- [x] **Regression test** — `worker_test.go`: `TestCloningReportFailureStillAttemptsTerminalFailed`
      / `TestScanningReportFailureStillAttemptsTerminalFailed` (a report fails for ONE status
      only via `fakeControl.failReportStatuses`, proving the follow-up "failed" report still
      gets through); `TestTransientClaimFailureRetriesInsteadOfExiting` (`fakeControl.claimFailures`
      fails the first 2 claim attempts, the 3rd recovers and its job still runs to completion in
      the SAME process — `Run` never returns an error). `TestAnUnreachableControlPlaneStopsTheWorker`
      kept and re-documented as the `--once` case that stays fatal on purpose.
      `covscanworker_cov_test.go`'s existing `TestCovscanworkerAFailedStatusReportIsSurfaced` table
      test had its "cloning"/"scanning" cases updated — their OLD expected statuses
      (`["cloning"]`, `["cloning","scanning"]`, no "failed") were literally this bug's signature;
      updated to `[..., "failed"]` with the new "could not report …" message. **Negative test
      confirmed**: reverting `worker.go` fails all 5 with the exact pre-fix shapes (`statuses =
      [cloning], want [cloning failed]`; `Run returned an error for a TRANSIENT claim failure:
      claim: connection refused`).
- [x] **Failure is loud** — a job with no terminal status was previously invisible (nothing
      distinguishes it from one still legitimately running); now it always ends in a real
      terminal status the operator can see.
- [x] **Evidence in the status line** — `worker_test.go`, `covscanworker_cov_test.go`; `go test
      ./...` (15 packages) and `go vet ./...` both clean.

## OPS-12

*Scanner service: no healthcheck, and the worker exits on any control-plane error.*

- [x] **Defect reproduced first** — confirmed `ccp/docker-compose.yml`'s `scanner` service was
      the only long-running service in the stack with no `healthcheck` (api/app each declare one
      in their own Dockerfiles) — a wedged worker (hung poll, a prescan that never returns) looks
      "Up" indefinitely. The claim-exits-the-process half is ERR-15's other half, fixed together
      (same root cause, same commit).
- [x] **Cause, not symptom, on both halves**:
      - **Claim retry** — see ERR-15 above; this closes "the worker exits on any control-plane
        error."
      - **Healthcheck** — added `--heartbeat <path>` (touched once per `Run` loop iteration,
        `worker.go`) and `--healthcheck` (reads that file's mtime back, exits 0/1,
        `HeartbeatStaleness` = 20 minutes — comfortably above `DefaultCloneTimeout`). Because the
        file is touched only at the TOP of the loop, a hang ANYWHERE in one iteration — a hung
        poll, or a prescan phase with no timeout of its own — is caught the same way: the loop
        never comes back around to touch it again, and staleness eventually trips. Runs the SAME
        BINARY (`catalogctl scan-worker --healthcheck --heartbeat ...`) as a Docker `HEALTHCHECK
        CMD` array, not a shell one-liner over `stat`/`find`/`date` — this image ships no shell
        tooling on purpose (`scanner/Dockerfile`'s own header: "no curl, no jq, no unzip, no
        bash"), so exec-form was the only option. `docker-compose.yml`'s `scanner.command` was
        updated to pass the same `--heartbeat` path the Dockerfile's `HEALTHCHECK` reads back
        (compose's `command:` fully replaces the image's default `CMD`, so it has to be repeated
        there, not inherited).
- [x] **Regression test** — `worker_test.go`: `TestHeartbeatTouchedEachLoopIteration` (a real
      idle loop, the file's mtime is fresh after `Run` returns);
      `TestHeartbeatDisabledByDefaultIsANoOp` (empty path, no crash — every other test in the
      file relies on this); `TestHealthcheckFreshHeartbeatIsHealthy` /
      `TestHealthcheckMissingHeartbeatIsUnhealthy` / `TestHealthcheckStaleHeartbeatIsUnhealthy`
      (mtime backdated past `HeartbeatStaleness` via `os.Chtimes`) /
      `TestHealthcheckWithNoHeartbeatPathIsUnhealthy`. **Negative test confirmed**: reverting to
      HEAD fails to even COMPILE (`unknown field Heartbeat in struct literal of type Opts`,
      `undefined: runHealthcheck`, `undefined: HeartbeatStaleness`) — proof this is genuinely new
      surface, not a tautological test.
      `docker-compose.yml`/`scanner/Dockerfile` validated with `docker compose config` (a
      minimal single-service compose file, `--profile scanner`, real env vars) and manual review
      of the `HEALTHCHECK` exec-form syntax (no Docker daemon available in this sandbox to run a
      full image build).
- [x] **Failure is loud** — `--healthcheck` prints WHY it failed (`heartbeat: <stat error>` or
      `heartbeat is <age> old (limit <limit>) — the worker looks wedged`) to stderr, which
      `docker inspect`/`docker ps` surface.
- [x] **Evidence in the status line** — `worker_test.go`; `go build ./...` and `go vet ./...`
      clean; `docker compose config` validates the compose changes.

## API-16

*Bundle workspace leaks and unchecked git steps.*

- [x] **Defect reproduced first** — confirmed all three at HEAD: `prepare()`'s clone-failure
      arm called `rmSync` before returning, but its `rev-parse HEAD` failure arm returned bare
      — the ONE failure path nothing else was ever going to clean up (`runBundle` only reaches
      `steps.cleanup` once `prepare` has already succeeded). `commit()` discarded `git add -A`'s
      exit status outright, and used the post-commit `git rev-parse HEAD` output as `sha`
      unchecked — a shape that lands on the request row and the audit trail as "the landed
      commit" (`routes/requests.ts:1203-1206`) with nothing downstream re-verifying it.
- [x] **Cause, not symptom** — added `SHA_RE = /^[0-9a-f]{7,64}$/` (the finding's own
      recommended pattern) as the one place a rev-parse result is trusted, applied at BOTH
      occurrences in the file (`prepare`'s `baseSha` and `commit`'s post-commit `sha` — the
      finding only named the second, but the same class of bug sat at the first too, one call
      earlier in the same function). `prepare()`'s rev-parse-failure arm now `rmSync`s before
      returning, matching its own clone-failure arm one branch up. `commit()` now checks `add`'s
      status and refuses (`git add failed: ...`) rather than falling through to a `commit` that
      can still succeed against whatever the index already held — silently missing the gate's
      own edits, the opposite of ADR-0016's "what was reviewed is exactly what runs."
- [x] **Regression test** — `test/bundle.test.ts`, three new tests against the REAL local bare
      origin (no network, same fixture the file's existing `realSteps` tests use), with the ONE
      git call each test needs to fail intercepted via `vi.spyOn(execMod, 'execCapture')`
      (delegating to the real implementation for everything else, including the clone that must
      actually create the workspace under test — reproducing a genuinely pathological git
      failure, e.g. a fresh clone whose HEAD will not resolve, is not otherwise reliably
      constructible with real git): rev-parse-after-clone-success leaves no directory behind;
      `git add` failing refuses with `git add failed` and nothing lands on `main`; a malformed
      post-commit rev-parse output refuses with `did not resolve to a real sha` and
      `BundleOutcome.sha` is `undefined`, never the bogus string. **Negative test confirmed**:
      reverting `bundle.ts` fails all three exactly as expected (`clone workspace ... was left
      behind`, the wrong/misleading `commit failed (gate left no change?)` detail instead of
      `git add failed`, and the `commitLanded` sha-check flow not refusing).
- [x] **Failure is loud** — each refusal detail names the actual cause (`git add failed: ...`,
      `did not resolve to a real sha: ...`), not the misleading downstream symptom the unfixed
      code produced (`commit failed (gate left no change?)` for an `add` failure).
- [x] **Evidence in the status line** — `test/bundle.test.ts` (14 tests); full api suite (99
      files / 1408 tests) green.

## ERR-13

*`prepare()` leaks the cloned workspace when `rev-parse` fails.*

**Same fix as API-16's `prepare()` half — one code change, one finding closed alongside its
sibling report.** See API-16's entry for the fix, evidence, and negative test.

## REM-2

*Session rows are still written with blind full-row puts.*

- [x] **Defect reproduced first** — confirmed all three sites CONC-3/API-10/CONC-4 left
      uncovered: `auth.ts`'s reauth-success handler did `store.put(updatedSession)` after
      stamping `reauthAt`; `account.ts`'s `POST /auth/totp-devices` did the same after minting an
      enrollment offer's `enrollSecretEnc`/`enrollOfferedAt`; `POST
      /auth/totp-devices/confirm`'s cleanup step did the same clearing them. Each follows a slow
      `await` (an argon2id verify, a TOTP verify) over a row read at request start — the same
      shape CONC-3 closed for the account row and API-10/CONC-4 closed for the session's OWN
      idle-slide write.
- [x] **Cause, not symptom** — the finding's literal recommendation ("a version attribute
      bumped on every write, reusing the `putAccountGuarded` shape") predates a BETTER pattern
      this session's own API-10/CONC-4 fix already established for `SessionItem` specifically:
      TRIAGE.md's own note says to copy THAT shape instead. Added `putSessionFieldGuarded`
      (`auth/sessions.ts`, beside `slideIdleWindow`) — a narrowed, guarded `update` on ONE
      attribute's captured OLD value, never a whole-row `put`, so a write can no longer clobber a
      concurrent mutation to any OTHER field on the same row (`putAccountGuarded`'s
      version-counter shape would not have this property — two unrelated fields racing would
      still collide on the shared counter). Unlike `slideIdleWindow` (whose one caller always
      treats a lost condition as "fine, someone else did the work"), `putSessionFieldGuarded`
      deliberately does NOT decide what a lost condition means — the three call sites disagree:
      a lost reauth stamp is harmless if the row still exists (a racing tab's fresher stamp is
      equally valid elevation proof — reported back to the caller instead of silently
      discarded); a lost enrollment-offer MINT refuses outright (409 STATE_CONFLICT — the
      secret/QR this call is about to hand back would not be what `confirm` later checks
      against); a lost enrollment-offer CLEAR is best-effort (the device it is cleaning up
      after was already committed via the account's own guarded write, and clobbering a NEWER
      concurrent offer would erase an unrelated enrollment in progress). Any lost condition
      whose re-read finds the row GONE fails closed (401 NO_SESSION) at all three sites.
- [x] **Regression test** — new `test/sessionFieldGuard.test.ts`, 8 HTTP-level tests against
      REAL concurrency (a `racingStore` wrapper — same shape `sessionRevokeRace.test.ts`'s own —
      injects a genuine concurrent write between this request's session read and its own guarded
      write, not just a unit test of the helper in isolation): reauth's lost race reports the
      RACER's stamp and does not clobber it (200, not a failure); reauth revoked mid-request
      fails closed (401 NO_SESSION); the enrollment mint's lost race refuses (409
      STATE_CONFLICT) and leaves the racer's offer untouched; the mint revoked mid-request fails
      closed; confirm's cleanup declines to clobber a NEWER concurrent offer while the device it
      confirmed is still added to the account; plus three CONTROL tests (uncontended reauth,
      uncontended mint, uncontended confirm-clears) proving the guards are not just refusing
      everything. **Negative test confirmed**: reverting `sessions.ts`/`auth.ts`/`account.ts`
      fails the 5 race tests exactly as expected (`expected '<real timestamp>' to be '<racer's
      stamp>'`, `expected 200 to be 401/409`, `expected undefined to be '<racer's offer>'`) while
      the 3 CONTROL tests correctly keep passing (the uncontended happy path was never broken).
- [x] **Failure is loud** — a lost mint reports `STATE_CONFLICT`/`NO_SESSION` explicitly rather
      than silently handing back a secret that can never confirm; a lost reauth reports the
      value ACTUALLY stored rather than a value that was silently discarded.
- [x] **Evidence in the status line** — `test/sessionFieldGuard.test.ts`; full api suite (99
      files / 1408 tests, 1 pre-existing skip) green; typecheck clean.

## OPS-9

*The documented CI-runner cutover only routes 2 of 8 workflows.*

- [x] **Defect reproduced first** — confirmed at HEAD: `docker-compose.yml`'s `runner` service
      and `ccp/docs/go-live.md` both documented `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest'
      }}` as the repo-wide cutover convention, but only `ccp-onboard.yml` and `ccp-data.yml`
      actually used it — `catalogctl.yml`, `ccp-api.yml`, `ccp-app.yml`, `ccp-apply.yml` (2
      jobs), `ccp-smoke.yml`, `docs-links.yml`, `findings.yml`, `importer.yml` (2 jobs), and
      `path-filters.yml` were all hardcoded to `ubuntu-latest`, so setting `CI_RUNNER` would not
      move most of the fleet the documentation claimed it would.
- [x] **Cause, not symptom** — wired `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` into
      every job in every workflow file EXCEPT the two that build Docker images
      (`release-images.yml`, and the new `docker-build.yml` — CI-7 below): the self-hosted
      runner (`docker-compose.yml`'s `runner` service) is built with NO docker socket by
      design, so a job that calls `docker build`/`docker compose`/`docker buildx` or uses a
      `docker/*` action cannot run there at all — discovered by reading that service's own
      comment before blindly wiring every workflow, which would have broken those two lanes the
      moment an operator set `CI_RUNNER`. Corrected `go-live.md`'s and `docker-compose.yml`'s
      own comments (both previously overclaimed "every workflow already reads..." / "no
      workflow in .github/workflows/ uses docker") to name the two exceptions precisely instead
      of asserting a now-false universal claim.
- [x] **Regression test** — extended `scripts/ci/check-workflow-safety.sh` with a new rule: no
      job whose steps use a `docker/*` action or a `run:` step containing the word `docker` may
      have `runs-on` reference `vars.CI_RUNNER` — detected from each job's own steps, not a
      hardcoded job-name list, so a ninth docker-using job added later is caught automatically.
      **Negative test confirmed**: manually routing `docker-build.yml`'s `build` job through
      `CI_RUNNER` and re-running the check fails with the new rule's exact message; reverting
      passes again.
- [x] **Failure is loud** — the safety check names every offending workflow+job pair rather
      than a bare pass/fail.
- [x] **Evidence in the status line** — `bash scripts/ci/check-workflow-safety.sh` passes; every
      touched workflow YAML parses; `bash scripts/ci/check-path-filters.sh` passes.

## CI-10

*Push-trigger path filters omit the workflow file itself on ccp-api and ccp-smoke.*

- [x] **Defect reproduced first** — confirmed `ccp-api.yml`'s and `ccp-smoke.yml`'s `push:`
      `paths:` lists did not include their own workflow file, unlike every other workflow's
      `pull_request`/`push` pair — an edit to either file's `push:` trigger logic itself (e.g. a
      broken path filter) would not re-trigger the workflow on the push that broke it, only on
      whatever unrelated push happened to also touch a listed source path.
- [x] **Defect fixed narrowly** — added each file to its own `push: paths:` list, matching its
      already-correct `pull_request: paths:` list.
- [x] **Cause, not symptom, generalized** — this was one instance of a class:
      `scripts/ci/check-path-filters.sh` (deliberately NOT a general import-graph walker — its
      own header says so, edges 1-4 are specific named dependencies) got ONE new, deliberate
      exception: a general self-inclusion check that every `.github/workflows/*.yml` with a
      `paths:` filter includes its own path in BOTH `pull_request` and `push`, so this exact
      class cannot recur silently in any workflow, present or future — documented in the
      script's own header as the one departure from its "not a general walker" rule.
- [x] **Regression test** — the new self-inclusion check IS the regression test, run against
      every workflow on every CI run. **Negative test confirmed**: temporarily removed
      `docker-build.yml`'s self-path entry mid-development and re-ran the check — it failed
      naming that exact file/trigger pair; restoring it passed again. (Caught and fixed a
      double-counting bug in the check's own failure tally while building this: a Python-side
      counter and the bash `fail()` helper were both incrementing, reporting "4" instead of "2"
      on a synthetic 2-failure case — removed the redundant counter.)
- [x] **Failure is loud** — the check names the workflow file and which trigger (`pull_request`
      or `push`) is missing the self-reference.
- [x] **Evidence in the status line** — `bash scripts/ci/check-path-filters.sh` passes across
      all 14 workflow files with a `paths:` filter.

## CI-7

*The Docker build path (the documented production install) is never exercised by CI; images
are first built at release time.*

- [x] **Defect reproduced first** — confirmed no workflow built any of the five Dockerfiles
      before either `release-images.yml` (api/scanner/app-demo, at RELEASE time) or an
      operator's own machine (runner/toolbox, and the REAL app image with `VITE_API_BASE`
      baked, at INSTALL time) — `ccp-smoke.yml` deliberately runs the docker-FREE
      `run-local.sh` path (its own header says so), so Dockerfile/`docker-compose.yml` bit-rot
      was only ever discoverable at release time or by the first operator to install, exactly
      the "installer bit-rot" failure mode `ccp-smoke.yml` exists to prevent, but for the
      Docker path real deployments actually use.
- [x] **Cause, not symptom** — added `.github/workflows/docker-build.yml`: a `compose-config`
      job that validates `docker compose --profile scanner --profile runner --profile toolbox
      config` against throwaway env values (proves the compose file itself is well-formed), and
      a `build` job matrixed over all five images (api/app/runner/scanner/toolbox) using
      `docker compose`'s own build contexts, `docker/build-push-action` with `push: false` and
      GitHub Actions layer caching. The api image is additionally `load: true`d and booted with
      the SAME production-posture env recipe `run-local.sh --smoke` uses
      (`NODE_ENV=production`, `CCP_SECURE_COOKIES=1`, `CCP_SAME_ORIGIN=1`, a fresh
      `CCP_TOTP_KEY`, `CCP_BOOTSTRAP=1`), then polled at `/readyz` for up to 30s — the one image
      whose shipped container this lane can prove actually starts, deliberately not a duplicate
      of `ccp-smoke.yml`'s deeper functional assertions on the docker-free path. Both jobs stay
      on `ubuntu-latest` (never the self-hosted `CI_RUNNER`) — see OPS-9 above for why.
- [x] **Regression test** — the workflow itself is the regression test (a Dockerfile or
      `docker-compose.yml` edit that breaks a build, or a shipped api image that fails to boot,
      now fails a PR before merge instead of at release/install time). PG-5 flagged the job's
      throwaway env values (`CCP_UPLOAD_TOKEN`, `CCP_TOTP_KEY`, `CCP_SCANNER_KEY`,
      `RUNNER_TOKEN`) as secret-shaped on first pass; replaced each with
      `not-a-real-secret` (an already-allowlisted `publish-gate.sh` marker) rather than
      widening the allowlist for a one-off value. **Negative test confirmed**:
      `bash scripts/publish-gate.sh` failed PG-5 with the original throwaway strings, passed
      after the substitution.
- [x] **Failure is loud** — the boot-check step emits `::error::` and dumps `docker logs` if
      `/readyz` never answers 200 within 30s.
- [x] **Evidence in the status line** — `docker-build.yml` parses as valid YAML; `bash
      scripts/ci/check-path-filters.sh` and `bash scripts/ci/check-workflow-safety.sh` both
      pass with the new file in scope; `bash scripts/publish-gate.sh` clean.

## CI-12

*Inconsistent action pinning, with a comment that contradicts the file it sits in; setup-go
caching is configured to a nonexistent root go.sum.*

- [x] **Defect reproduced first** — confirmed every `uses:` line across all 12 workflow files
      was pinned to a floating major tag (`@v4`, `@v5`, ...) rather than a commit SHA, and 5 of
      the `setup-go` steps had no `cache-dependency-path`, meaning the module cache looked for
      a `go.sum` at the repo root (which does not exist — `tools/catalogctl` and
      `tools/schemadump` each keep their own).
- [x] **Cause, not symptom** — SHA-pinned every `uses:` across all 12 files (`actions/checkout`,
      `actions/setup-node`, `actions/setup-go`, `actions/setup-python`,
      `hashicorp/setup-terraform`, `docker/setup-qemu-action`, `docker/setup-buildx-action`,
      `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`) to their
      exact, verified commit SHAs (resolved via `git ls-remote --tags` against each action's
      real upstream repo — not guessed), each with its version in a trailing comment for human
      readability; added `cache-dependency-path` pointing at the actual per-module `go.sum` to
      all 5 `setup-go` usages (`catalogctl.yml`, `ccp-api.yml`, `ccp-apply.yml`,
      `ccp-onboard.yml`, `importer.yml`). `ccp-data.yml`'s stale "Action pins follow the
      repo-wide convention" comment (no longer true — that lane's `setup-python`/`setup-node`
      versions are governed by `gen-project-data.sh`'s own `--print-pins`, not the shared repo
      default) was rewritten to state that distinction explicitly.
- [x] **Regression test** — every workflow YAML re-parses cleanly after the mechanical
      rewrite; `scripts/ci/check-workflow-safety.sh` and `check-path-filters.sh` both still
      pass with the pinned SHAs in place, proving nothing was renamed or malformed in the
      process.
- [x] **Failure is loud** — a floating tag silently repointing to a compromised release is
      exactly the supply-chain risk SHA-pinning closes; a future edit that reverts to a bare
      tag would show as an obvious diff in review.
- [x] **Evidence in the status line** — all 12 workflow files parse; `grep -c "uses:.*@[a-f0-9]\
      {40\}" .github/workflows/*.yml` shows every `uses:` line SHA-pinned.

## CI-11

*Stale toolchain claims: gate.sh advertises checks CI does not run.*

- [x] **Defect reproduced first** — confirmed `scripts/gate.sh`'s own header comment claimed to
      mirror "catalogctl, ccp-api, ccp-app, importer, **and terraform**" workflows, but no
      standalone `terraform.yml` lane exists — `terraform fmt`/`validate` run as steps INSIDE
      `ccp-api.yml`/`ccp-apply.yml`. Separately, `gate.sh`'s `checkov` skip message said "SKIP
      (runs in CI)" — false; `grep` across every `.github/workflows/*.yml` shows checkov runs
      in NO workflow anywhere, so this local run (when installed) is the ONLY infra-scan
      coverage that exists.
- [x] **Cause, not symptom** — rewrote the header comment to name the four real workflow files
      it mirrors and explain terraform's actual placement (steps inside two OTHER workflows,
      mirrored BY NAME in `gate.sh`'s own `tf-fmt`/`tf` sections, not a lane of its own).
      Rewrote the checkov skip message to "SKIPPED (no CI backstop; install checkov locally for
      full mode)". Self-caught a near-miss while writing the terraform comment: an early draft
      copied the ORIGINAL finding's claim that `catalogctl.yml` has no `gofmt -l` step this
      gate duplicates — `grep -n "gofmt" .github/workflows/catalogctl.yml` showed a later,
      unrelated commit had already added one, which would have made the new comment false the
      moment it was written; reworded before finalizing rather than shipping a freshly-stale
      claim.
- [x] **Regression test** — none of `gate.sh`'s comment text is itself asserted by an automated
      check (this is documentation accuracy inside a comment, not a checkable invariant); the
      correction was verified by direct `grep` against every workflow file at HEAD, cited
      above, at the time of the edit.
- [x] **Failure is loud** — N/A (a stale comment fails silently by construction; the fix is
      making the comment true, not making a false one detectable).
- [x] **Evidence in the status line** — `grep -n "terraform" .github/workflows/*.yml` and
      `grep -n "gofmt" .github/workflows/catalogctl.yml` both support the corrected comment
      text at commit time.

## ERR-16

*The ccp-data CI lane goes green when the control plane is unreachable.*

- [x] **Defect reproduced first** — confirmed `scripts/gen-project-data.sh`'s "unreachable"
      curl-exit branch (5/6/7/28/35/52/55/56) wrote `upload-status.json` and exited 0 with only
      a plain stderr `WARN:` line — invisible in the Actions UI unless someone opens the run and
      reads the log or downloads the artifact. A week-long outage (or a firewall regression)
      would produce an unbroken row of green `ccp-data` runs while the portal served ever-staler
      estate data.
- [x] **Cause, not symptom** — `warn()` now ALSO emits a `::warning::` GitHub Actions
      annotation (surfaces in the run's UI and notification digest) whenever
      `GITHUB_ACTIONS=true`, a no-op locally. The unreachable branch specifically also appends a
      `$GITHUB_STEP_SUMMARY` section (the most prominent surface Actions has) naming the
      endpoint and curl exit code. Added an opt-in hard-fail, `CCP_DATA_REQUIRE_UPLOAD=1`
      (wired through `ccp-data.yml`'s env and documented in both its header comment and
      `docs/runbooks/account-data-ci.md`, plus the GitLab twin
      `.gitlab/ci/ccp-data.gitlab-ci.yml`'s own header — GitLab CI/CD variables reach the job
      script automatically, so no pipeline-file wiring was needed there beyond documenting it):
      unset (default) keeps the documented air-gapped exit-0 fallback exactly as before; a
      non-air-gapped estate can opt OUT and have an unreachable control plane hard-fail the run
      instead of going green.
- [x] **Regression test** — new `scripts/ci/gen-project-data-selftest.sh` (wired into a new
      dedicated workflow, `gen-project-data-selftest.yml`, since `ccp-data.yml` itself never
      runs in this public template repo — it's gated on `CCP_PROJECT_ID`, CI-9's fix, unset
      here). Drives the REAL script (not a reimplementation) against `http://127.0.0.1:1` — a
      loopback port nothing binds, so curl fails with exit 7 deterministically and without any
      outbound network dependency — across 4 scenarios: plain run emits the ordinary WARN only,
      no `::warning::`; `GITHUB_ACTIONS=true` + `GITHUB_STEP_SUMMARY` set gets both the
      annotation and the step-summary section; `CCP_DATA_REQUIRE_UPLOAD=1` turns the SAME
      unreachable condition into a nonzero exit; the same flag does NOT affect the separate
      no-URL-configured exit-0 path (proving its scope is exactly the unreachable branch, not
      every exit-0 path in the script). **Negative test confirmed**: reverted `warn()`/the
      unreachable branch to their pre-fix shape and re-ran the selftest — 3 of 4 scenarios
      failed with the expected missing-annotation/missing-summary/still-exits-0 messages;
      restoring the fix returned all 4 to green.
- [x] **Failure is loud** — the opt-in hard-fail's `die()` message names the exact env var and
      why (`"this estate opted OUT of the air-gapped exit-0 fallback"`).
- [x] **Evidence in the status line** — `bash scripts/ci/gen-project-data-selftest.sh` passes (4
      scenarios); `gen-project-data-selftest.yml` parses and passes `check-path-filters.sh`/
      `check-workflow-safety.sh`.

## TEST-8

*Golden-tree comparison is one-directional: extra files created by an edit go unnoticed.*

- [x] **Defect reproduced first** — confirmed `golden_test.go`'s `mustEqualTree` iterated only
      `wantDir`'s entries and byte-compared each against `gotDir` — a verb that wrote an
      ADDITIONAL file `gotDir` never mentioned (a stray scratch file, a duplicated
      `service_2.tf`, a leaked lockfile) passed the golden gate silently; the same asymmetry
      applied to the refusal path's untouched-tree check (`mustEqualTree(t, beforeSnapshot,
      work)`), so a refusal that left new debris behind also passed "untouched".
- [x] **Cause, not symptom** — extracted the comparison into a standalone `treeDiff(wantDir,
      gotDir) string` (independent of `*testing.T`, so a unit test can assert on its return
      value directly instead of catching a `t.Fatal`) and added a second pass reading `gotDir`
      and failing on any entry absent from `wantDir` — catalogctl is the only component that
      writes Terraform, so "produces exactly these files and no others" is part of the
      contract the goldens exist to pin. `mustEqualTree` is now a thin wrapper calling
      `treeDiff` and `t.Fatal`ing on a non-empty result, so both of its existing call sites (the
      success path AND the untouched-tree refusal check) get the fix for free.
- [x] **Regression test** — new `TestTreeDiff`: identical trees still match (over-fix guard);
      an extra file in `gotDir` that `wantDir` never mentions is caught and named in the
      returned diff string. **Negative test confirmed**: temporarily reverted `treeDiff`'s
      second pass (kept only the `wantDir`-only walk) and re-ran `TestTreeDiff` — failed with
      "expected treeDiff to catch the extra file stray.tf, got no diff"; restoring the second
      pass returned it to green. Full `go test ./...` (including all `TestGolden` cases) stays
      green with the fix in place.
- [x] **Failure is loud** — the diff string names the exact extra filename.
- [x] **Evidence in the status line** — `go test ./...` in `tools/catalogctl` (2425 subtests,
      0 failures); `gofmt -l` clean.

## TEST-12

*One test file consumes ~60% of the api suite wall time by rebuilding catalogctl per run.*

- [x] **Defect reproduced first** — confirmed both `createResourceParity.test.ts` and
      `scheduleWindowCheckParity.test.ts` each `go build`ed their own catalogctl binary into a
      fresh `mkdtempSync` dir on EVERY vitest invocation, with no reuse across files in the
      same run or across separate runs. Measured directly (`go clean -cache`, then one parity
      file alone): the module-scope build step alone cost ~18s with a cold Go build cache,
      collapsing to ~0.1s once a cached binary already exists — the actual dominant cost of
      `createResourceParity.test.ts`'s own ~60s wall time turned out to be its ~30
      spawnSync-the-built-binary test-case calls, a SEPARATE cost this fix does not touch (the
      finding's own recommendation is "build once", not "make every case fast", and the header
      comment was corrected to state this precisely rather than repeat the finding's original,
      looser causal claim).
- [x] **Cause, not symptom** — added `ccp/api/test/helpers/catalogctlBuild.ts`:
      `buildCatalogctlCached()` builds once to a path keyed on a SHA-256 content hash of
      `tools/catalogctl`'s own source (`go.mod`, `go.sum`, every `*.go` file — hashed rather
      than `git rev-parse`'d so a dirty working tree, mid-edit, still invalidates the cache
      correctly), landing at a stable path under the OS tmp dir; built to a fresh per-attempt
      tmp path first, then `renameSync`'d into place (atomic on the filesystems this runs on,
      so a reader never observes a partial binary, and two files racing to build the SAME
      unchanged source at worst both compile once with a harmless overwrite). Both parity files
      now call this shared helper instead of each defining and calling their own
      `buildCatalogctl()`.
- [x] **Regression test** — new `test/catalogctlBuild.test.ts`: builds once, records the
      binary's mtime, then forces a FRESH module instance via `vi.resetModules()` + a dynamic
      re-import (simulating a separate process finding the cache a prior run left behind) and
      asserts the second call returns the SAME path with an UNCHANGED mtime — proving reuse,
      not a rebuild. **Negative test confirmed**: temporarily reverted the helper to a
      no-cache, always-`mkdtempSync`-and-build implementation and re-ran the test — failed
      with two different paths returned; restoring the cache returned it to green.
- [x] **Failure is loud** — a broken cache would either build a stale binary silently (caught
      by TEST-8/parity assertions failing downstream) or fail this test's own mtime/path
      equality directly.
- [x] **Evidence in the status line** — `npx vitest run test/catalogctlBuild.test.ts
      test/createResourceParity.test.ts test/scheduleWindowCheckParity.test.ts` (46 tests)
      green; full api suite (100 files / 1411 tests, 1 pre-existing toolchain-gated skip)
      green; typecheck clean.

## TEST-9

*Sleep-based synchronization in async API tests (flake and false-pass risk).*

- [x] **Defect reproduced first** — confirmed all four cited call sites at HEAD:
      `driftButtons.test.ts:410` and two sites in `driftProposals.test.ts` waited on a FIXED
      `setTimeout` before asserting a fire-and-forget background task DID run (flake risk under
      load); `schedulerGating.test.ts:84` and one site in `driftProposals.test.ts` slept before
      asserting nothing happened (false-pass risk if the erroneous work is merely slower than
      the sleep).
- [x] **Cause, not symptom** — for the POSITIVE cases (asserting real work happened), exposed a
      genuine completion hook from the fire-and-forget runner rather than guessing at a delay:
      `domain/driftProposals.ts`'s `GenState` now carries the queue-draining loop's own promise,
      and a new `driftGenIdle(projectId)` resolves once that promise (and any run it left
      queued) has settled — same style `FileStore#persist()` already returns its durability
      promise. For the NEGATIVE cases (nothing was scheduled, so there is no promise to await),
      added `test/helpers/pollUntil.ts`: polls the forbidden condition on a short interval up
      to a deadline, returning the instant it becomes true rather than either wasting the whole
      window or using too short a fixed sleep — a strict widening of the old sleep's
      observation window, never a narrowing.
- [x] **Regression test** — the four rewritten call sites ARE the regression test for the
      synchronization mechanism itself; additionally two NEW dedicated tests prove
      `driftGenIdle` is not a no-op: one schedules a run with an artificially slow (50ms)
      `generate` step and asserts a flag the step sets is still `false` immediately after
      scheduling but `true` immediately after `await driftGenIdle(...)` (proves the await is
      real, not a pass-through); one asserts `driftGenIdle` on a never-scheduled project
      resolves immediately. **Negative test confirmed**: reverted `driftGenIdle` to a no-op
      `return;` and re-ran — failed with `expected false to be true` (the slow-run proof);
      restoring the real implementation returned it to green. One flake was found and fixed
      during this work: `driftProposals.test.ts`'s "armed... 201 is not blocked" test awaits a
      REAL `git clone` against a bogus remote — under full-suite CPU contention in this sandbox
      it occasionally exceeded vitest's 5s default timeout even though the clone itself failed
      fast; since that test asserts nothing about the background run's outcome, it now races
      `driftGenIdle` against a 2s deadline instead of awaiting it unconditionally — confirmed
      stable across repeated full-suite runs afterward.
- [x] **Failure is loud** — `pollUntil`'s return value is asserted explicitly (`toBe(false)`
      for the negative cases), not merely relied upon as an implicit pass.
- [x] **Evidence in the status line** — full api suite (100 files / 1411 tests, 1 pre-existing
      toolchain-gated skip) green across two consecutive full runs; typecheck clean.

## TEST-10

*Functional test plan drift: stale counts, loose citations, and "new" rows with no tracking.*

- [x] **Defect reproduced first** — confirmed at HEAD: §15 claimed "65 files, 977 tests" (api,
      actual 100/1411) and "141 files, 2631+" (app, actual 155/2768) — both already far
      beyond even the finding's own already-stale "actual" snapshot, from the many suites added
      across this session's prior batches. ADMIN-01's citation `` `ccp/api/test/teams` ``
      coverage and ADMIN-04's `` `ccp/api/test/settings` `` coverage both name a path with no
      file extension that has never existed — `grep -rl` for the behaviors they claim to cover
      (`DUPLICATE_TEAM`/`TEAM_NOT_EMPTY`; the freeze-toggle audit) found them in
      `adminSurface.test.ts` and `deploymentSettings.test.ts` respectively. REQ-16's `` `ccp/
      api/test/requests` `` coverage citation was the same dead shape — the actual cancel-arm
      coverage is in `cooling.test.ts`. Eleven XLAYER rows (≈"about a dozen") carried a bare
      "new"/"new RTL case"/"manual release drill" marker with nothing tying it to tracked work.
- [x] **Cause, not symptom** — regenerated §15's three counts from each CI suite's own summary
      output and quoted the exact command each is derived from IN the doc, so the next drift is
      a one-line refresh instead of a re-investigation. Fixed all three dead citations (ADMIN-01,
      ADMIN-04, REQ-16) to name the real file that actually covers the behavior. Added a new
      "Deferred XLAYER cases" table listing all eleven not-yet-automated rows with what's
      missing and where it would land — a table, not GitHub issues, since every row already
      carries its own spec (the Steps/Expected columns above it) and a separate issue would only
      duplicate that.
- [x] **Regression test** — new `scripts/docs-test-plan-citations-check.py`, wired into
      `docs-links.yml` (the existing docs-freshness lane) as a second step alongside
      `docs-link-check.py`: parses every backtick span in a table row and, for anything shaped
      like a test-file citation (a full path under a known test root ending in a real test
      extension, a bare filename, or — the dead-citation shape itself — a test-root path with
      no further subdirectory and no extension) verifies it resolves; deliberately narrow
      (mirrors `check-path-filters.sh`'s own "not a general walker" philosophy) so it does not
      flag legitimate non-file citations (directory references, `project.json`, route paths).
      **Negative test confirmed**: reverted ADMIN-01's citation back to the original dead
      `` `ccp/api/test/teams` `` shape and re-ran — failed naming exactly that line and reason
      ("is a test-root path with no file extension — not a real file (this is the ADMIN-01/04
      shape)"); restoring the fix returned it to 123/123 citations resolving.
- [x] **Failure is loud** — the check names the exact broken citation string and line number,
      not a bare pass/fail.
- [x] **Evidence in the status line** — `python3 scripts/docs-test-plan-citations-check.py`
      (123 citations resolve); `python3 scripts/docs-link-check.py` (308 links resolve, 0
      broken); `docs-links.yml` parses and passes `check-path-filters.sh`/
      `check-workflow-safety.sh`.

## DOC-6

*API-SPEC.md states the opposite of current code on `PUT /projects/:id/identity` gating.*

- [x] **Defect reproduced first** — re-derived at HEAD rather than trusted the finding's own
      claim (L-29): read `routes/projects.ts`'s current `PUT /:id/identity` handler and
      confirmed it DOES gate — `if (!isOnboardable(project)) return apiError(c,
      "STATE_CONFLICT")` — where `isOnboardable` (`domain/onboardToken.ts`) requires
      `status ∈ {draft, pending-trust}` and `!archived`. API-SPEC.md's row said "Not gated on
      project status or archived", the literal opposite.
- [x] **Cause, not symptom** — corrected the row to state the real gate (draft/pending-trust
      only, archived refused, 409 `STATE_CONFLICT` otherwise) and explain why: identity is part
      of the two-admin trust binding, so it is only settable pre-trust — the deliberate
      post-trust path is deregister + a fresh onboard. Re-stamped the trailing code citation
      from the stale `projects.ts:975-1010` to the real current span, `projects.ts:1411-1456`
      (verified against the actual `p.put("/:id/identity", ...)` declaration and its closing
      brace).
- [x] **Regression test** — none added; this is a prose-only doc correction against code that
      already has its own direct test coverage (the route's `isOnboardable` gate is exercised by
      the existing project-lifecycle test suites). `scripts/docs-link-check.py` and the other
      B-S3 doc checks confirm the doc still parses and every citation elsewhere still resolves.
- [x] **Failure is loud** — n/a (no new automated check for this specific row; a future drift
      here is DOC-17's class, covered by the entity-catalog checker where the same code path's
      line citation is re-verified).
- [x] **Evidence in the status line** — read `routes/projects.ts:1411-1456` directly; confirmed
      `isOnboardable`'s exact status set in `domain/onboardToken.ts`; `python3
      scripts/docs-link-check.py` still passes.

## DOC-8

*catalogctl README makes two explicit completeness claims that are false.*

(Shared fix with ARCH-12 — the SAME subcommand-table gap, same commit, one entry per finding
per the ledger's own topic split.)

- [x] **Defect reproduced first** — confirmed `internal/cli/cli.go` has 9 `case "...":` arms but
      README.md's subcommand table listed only 6 — `drift-edit`, `scan-worker`, and
      `window-check` were all missing. Separately, the "edit verbs (12)" list omitted
      `create_resource`, dispatched through a FOURTH table (`create.go`'s `createHandlers`, the
      pre-locate ACCEPT branch a create needs since it has no existing block to locate) that
      `edit.go`'s own three tables don't cover — 13 verbs, not 12.
- [x] **Cause, not symptom** — added the 3 missing subcommand rows and the missing edit verb
      (12→13), and corrected the "reconfirm by grepping edit.go" instruction to name all FOUR
      dispatch tables, not three.
- [x] **Regression test** — new `tools/catalogctl/readme_test.go`:
      `TestReadmeSubcommandsComplete` extracts every `case "...":` arm from `cli.go` directly
      (not a hand-copied count) and fails if README.md's table is missing any of them, so a
      TENTH subcommand added later without a README row is caught the same way this gap was;
      `TestReadmeEditVerbsComplete` extracts every verb key from all four dispatch tables
      (`edit.go` + `create.go`) and fails if README.md's edit-verbs list is missing any.
      **Negative test confirmed**: deleted the `scan-worker` row from README.md and re-ran —
      `TestReadmeSubcommandsComplete` failed naming exactly that subcommand; restored the row,
      re-ran clean.
- [x] **Failure is loud** — each test names the specific subcommand/verb the README is missing,
      not a bare pass/fail.
- [x] **Evidence in the status line** — `cd tools/catalogctl && go test . -run
      'TestReadmeSubcommandsComplete|TestReadmeEditVerbsComplete' -v` (both PASS); full `go
      build ./... && go vet ./... && go test ./... && gofmt -l internal/` clean.

## DOC-9

*Four operator-facing env vars are undocumented (two of them documented nowhere at all).*

- [x] **Defect reproduced first** — confirmed `CCP_APPLY_FROZEN`/`CCP_APPLY_AUTO_REVERT`
      (`domain/apply/loop.ts`) appeared in zero markdown/env-example/compose files — only in
      code comments; `CCP_DRIFT_IMPORT` (`domain/driftProposals.ts`) and `CCP_DRIFT_CHECK_CMD`
      (`domain/driftCheck.ts`) were each documented in only one place, absent from
      `ccp/api/README.md`, which `ccp/README.md` itself designates as the exhaustive reference.
      Auditing "every `CCP_*` var the api reads" for this fix also surfaced a fifth undocumented
      var the finding's own text did not name: `CCP_GITHUB_APP_KEY`
      (`domain/forgeCredentials.ts`), the inline alternative to `CCP_GITHUB_APP_KEY_FILE` for a
      host with no secret-mount story.
- [x] **Cause, not symptom** — added all five to `ccp/api/README.md`'s env table (the canonical
      reference) with their real semantics (freeze/auto-revert only meaningful under
      `CCP_SCHEDULER=1`; the two drift knobs' exact gating), and to `ccp/.env.example` /
      `ccp/docker-compose.yml`'s armed-overlay sections (fixing, in passing, a pre-existing
      unterminated table row for `CCP_DATA_LOCK_TAKEOVER` that a straight append would have
      broken further).
- [x] **Regression test** — new `scripts/docs-env-vars-check.py`, wired into `docs-links.yml`:
      extracts every `CCP_*` token the api's source reads (`process.env.CCP_X`, the
      injected-`env`-parameter convention, and quoted-string-literal indirect reads) and checks
      each appears in at least one of the 5 named doc surfaces. **Negative test confirmed**:
      appended a fake `process.env.CCP_TOTALLY_FAKE_TEST_VAR` read to `errors.ts` and re-ran —
      failed naming exactly that var; reverted, re-ran clean (37/37).
- [x] **Failure is loud** — the check lists every undocumented var by name and points at the
      canonical README table to add it to.
- [x] **Evidence in the status line** — `python3 scripts/docs-env-vars-check.py` (37/37 vars
      documented); `ccp/api` typecheck clean (no code changed, only docs).

## DOC-10

*ERROR-STATES.md's "every error code the API can return" is missing 8 taxonomy codes and 6
inline literals.*

- [x] **Defect reproduced first** — confirmed the 8 named taxonomy codes (`SCANNER_KEY_INVALID`,
      `DRIFT_PROPOSAL_STALE`, `INSTANCE_STALE`, `DRIFT_NOT_ADOPTABLE`,
      `DRIFT_PROPOSAL_REQUIRED`, `SCANNER_DISABLED`, `FORGE_CREDENTIAL_REFUSED`,
      `SCAN_TARGET_REFUSED`) and the 6 named inline literals were each absent from
      ERROR-STATES.md's tables at HEAD.
- [x] **Cause, not symptom** — added rows for all 8 taxonomy codes and all 6 inline literals,
      each cited against the real current route/line. Building the generated check (below)
      found TWO MORE undocumented inline literals the finding's own hand audit missed —
      `BUNDLE_REPO_UNRESOLVED` and `DRIFT_REPO_UNRESOLVED` — added those too: exactly the case
      for a generated check over a hand-maintained list, the list itself was the defect.
- [x] **Regression test** — new `scripts/docs-error-codes-check.py`, wired into `docs-links.yml`:
      two sources of truth both derived from code — every key in `errors.ts`'s `ERRORS` map, and
      every inline `code: '<LITERAL>'` response literal in `routes/*.ts` — checked against
      ERROR-STATES.md's tables. **Negative test confirmed**: deleted the `SCANNER_KEY_INVALID`
      row and re-ran — failed naming exactly that taxonomy code; restored, re-ran clean (58
      taxonomy + 13 inline literals, all documented).
- [x] **Failure is loud** — the check separately labels which codes are missing from the
      taxonomy source vs. the inline-literal source, so the fix location is unambiguous.
- [x] **Evidence in the status line** — `python3 scripts/docs-error-codes-check.py` (58 taxonomy
      + 13 inline literals, all documented); `cd ccp/api && npx vitest run test/openapi.test.ts`
      unaffected (23/23, this fix touched no route behavior).

## DOC-12

*DOMAIN-MODEL.md's entity catalog is missing a third of the store's item types.*

- [x] **Defect reproduced first** — confirmed the 8 named item shapes (`InstanceItem`,
      `ProjectDataVersionItem`, `ProjectUploadTokenItem`, `ProjectScanJobItem`,
      `DriftReportItem`, `DriftPointerItem`, `DriftProposalItem`,
      `ProjectForgeCredentialItem`) had no DOMAIN-MODEL.md row at HEAD, of 24 total exported
      `export const XxxItem = z.object(` shapes in `store/schema.ts`.
- [x] **Cause, not symptom** — added all 8 named rows, each cited against schema.ts's real
      current line span and store key. Building the generated check (below) found a 9th gap the
      finding's own hand audit missed: `RequestSetItem` (embedded on `RequestItem.items[]`,
      never independently catalogued) — added that row too.
- [x] **Regression test** — new `scripts/docs-entity-catalog-check.py`, wired into
      `docs-links.yml`: extracts every `export const XxxItem = z.object(` declaration from
      schema.ts structurally (not a copied list) and checks each name appears backtick-quoted
      somewhere in DOMAIN-MODEL.md. Extended (DOC-17, same script) to also verify each entity
      row's own `schema.ts:NNN` citation matches the real declaration line — this pass alone
      found 13 MORE stale citations across the table (see DOC-17). **Negative test confirmed**:
      deleted the `RequestSetItem` mention and re-ran — failed naming it; restored, re-ran clean
      (24/24, all with accurate citations).
- [x] **Failure is loud** — the check separately reports missing rows vs. stale-citation rows,
      each naming the exact item/line involved.
- [x] **Evidence in the status line** — `python3 scripts/docs-entity-catalog-check.py` (24/24
      item shapes catalogued with accurate citations); `python3 scripts/docs-link-check.py`
      unaffected.

## DOC-14

*PERMISSIONS.md §9 cites a "§2 apply row" that does not exist.*

- [x] **Defect reproduced first** — re-derived at HEAD (L-29) rather than trusting the finding's
      own claim: read PERMISSIONS.md §2's role×capability matrix and found an apply row already
      present (line 39: "Run the apply bundle... ✘ ✘ ✔ ✔... `APPLY_FORBIDDEN`") and §9's
      cross-reference to it (line 136: "the apply-route precedent... PERMISSIONS.md §2's own
      'senior-only' apply row") resolving cleanly against it. This finding was already closed —
      by DOC-2's fix (a separate, earlier pass) — before this batch began.
- [x] **Cause, not symptom** — no code or doc change needed; verified-and-closed, not
      re-fixed. Recorded the verification in FINDINGS.md citing DOC-2's commit sha (`cdc5f2c`)
      so a future reader can see this was checked, not skipped.
- [x] **Regression test** — n/a (verify-and-close; no defect to pin).
- [x] **Failure is loud** — n/a.
- [x] **Evidence in the status line** — `grep -n "apply" ccp/docs/PERMISSIONS.md` shows both the
      §2 matrix row and the §9 cross-reference resolving against it.

## DOC-16

*Assorted OpenAPI request/response gaps against route behavior.*

- [x] **Defect reproduced first** — re-derived each of the 4 named gaps at HEAD (L-29) rather
      than trusting the finding's own text: `GET /requests`'s cursor/limit pagination is now
      ALREADY implemented in `routes/requests.ts` and ALREADY correctly declared in
      `ccp-api.yaml` — this bullet was resolved by an earlier, unrelated fix and needed no
      further action. The other 3 were confirmed still real: `/admin/audit`'s YAML said
      "uncapped" and declared no `limit` param while `routes/admin.ts` defaults `limit` to 100
      (cap 1000); `POST /admin/accounts`'s YAML body omitted the optional `projectId` binding
      field `EnrollBody`/the handler actually reads and uses for cross-tenant dual-control
      classification; `DriftChangedAttr`'s YAML schema omitted `pathSegments`, present on the
      app-side type and passed through by the api.
- [x] **Cause, not symptom** — fixed the 3 still-open gaps in `ccp-api.yaml`: `/admin/audit` now
      declares an accurate `limit` param (inlined rather than reusing the shared `limit`
      component, whose description — "omit = unpaged, cursor without limit = 422" — describes
      `/requests`'s different real behavior, not this route's) and drops the false "uncapped"
      claim; `POST /admin/accounts` gained the `projectId` property with its real
      omit-defaults-to-enrolling-project semantics; `DriftChangedAttr` gained `pathSegments` as
      an opaque, optional field.
- [x] **Regression test** — none added; `ccp/api/test/openapi.test.ts` (the existing
      spec-completeness gate) re-run and confirmed unaffected (23/23) — these are additive YAML
      corrections, not behavior changes, so there is no new code path to pin.
- [x] **Failure is loud** — n/a; YAML-only fix.
- [x] **Evidence in the status line** — `python3 -c "import yaml;
      yaml.safe_load(open('ccp/api/openapi/ccp-api.yaml'))"` (parses clean); `cd ccp/api && npx
      vitest run test/openapi.test.ts` (23/23 passed, unaffected).

## DOC-17

*The code-derived docs' line citations have drifted from HEAD.*

- [x] **Defect reproduced first** — verified the 4 named stale citations at HEAD: DOMAIN-MODEL.md's
      `ProjectItem` row cited `schema.ts:536-555` (real: `842-928`) and
      `routes/projects.ts:975` for the identity route (real, after DOC-6's own re-derivation:
      `1411`); API-SPEC.md cited `requests.ts:786-828` for plan-summary (real: `997-1048`),
      `admin.ts:687-690` for audit/export (real: `1229-1236`), and `index.ts:52-60` for
      healthz/readyz (real: `68-76`).
- [x] **Cause, not symptom** — corrected all 4 named citations, plus every other line citation
      embedded in the SAME DOMAIN-MODEL.md `ProjectItem` row (the key-scheme comment, the
      `accountId`/`identityConfirmed` field lines, `ProjectStatus`, `projectKey()`,
      `isIdentityConfirmed`) since a row citing its own headline span correctly but its embedded
      field lines wrong is only half-fixed. Building the entity-catalog checker's line-accuracy
      pass (shared with DOC-12) then swept the REST of the entity table mechanically and found
      13 MORE stale row citations the manual pass never touched (`SessionItem`,
      `SettlementItem`, `ProjectOnboardTokenItem`, `TeamItem`, `PolicyItem`,
      `RiskOverrideItem`, `SettingItem`, `RequestItem`, `ApprovalItem`, `RequestEventItem`,
      `PendingConfigChangeItem`, `AuditItem`, `ChainHeadItem`) — fixed all 13 against their real
      current declaration/type spans. Scope boundary, stated plainly: this closes the entity
      catalog's own citations (the highest-density cluster of `file:line` references in the
      repo, and the finding's own flagship example) and the 4 named ones elsewhere; the many
      OTHER prose-embedded line citations scattered through DOMAIN-MODEL.md/API-SPEC.md/
      ERROR-STATES.md are not exhaustively re-verified — "disciplined staleness," the finding's
      own term, remains an accepted residual outside the entity table.
- [x] **Regression test** — `scripts/docs-entity-catalog-check.py` extended (shared script with
      DOC-12) to parse every `` `XxxItem`, schema.ts:A-B) `` citation and verify `A` matches the
      real `export const XxxItem` declaration line. **Negative test confirmed**: edited
      `SessionItem`'s row to cite the OLD stale `223-263` span and re-ran — failed naming
      exactly that mismatch (cites 223, real is 238); restored, re-ran clean.
- [x] **Failure is loud** — the check names both the cited line and the real line for every
      stale citation found, not just "something is wrong".
- [x] **Evidence in the status line** — `python3 scripts/docs-entity-catalog-check.py` (24/24
      accurate); `python3 scripts/docs-link-check.py` unaffected.

## ARCH-12

*`catalogctl` README's "complete, no more, no fewer" subcommand table omits a third of the
subcommands.*

(Shared fix with DOC-8 — see that entry for the full defect/fix/test writeup; this entry
records the same commit against ARCH-12's own topic per the ledger's per-finding-number
convention.)

- [x] **Defect reproduced first** — see DOC-8.
- [x] **Cause, not symptom** — see DOC-8 (the subcommand-table half of that fix; ARCH-12 does
      not touch the edit-verbs count, which is DOC-8's own second claim).
- [x] **Regression test** — `tools/catalogctl/readme_test.go#TestReadmeSubcommandsComplete` (see
      DOC-8).
- [x] **Failure is loud** — see DOC-8.
- [x] **Evidence in the status line** — see DOC-8.

## ARCH-15

*ADR ledger statuses lag the built system.*

- [x] **Defect reproduced first** — confirmed ADR-0031's row said "Proposed (design lane; build
      gated on owner sign-off)" while ADR-0033's own context section cites it as "the narrow
      upload lane already exists (ADR-0031 Phase 1, built)"; confirmed `--estate-tz`/
      `CCP_ESTATE_TZ` (ADR-0028's named mechanism) is fully wired in
      `internal/windowcheck/command.go:37` and `internal/estatecfg/estatecfg.go` while ADR-0028's
      row said flatly "Proposed (build gated)" with no disclosure. ADRs 0024-0026 were checked
      too and found to ALREADY candidly disclose "build landed" in their own prose (not a real
      gap — the finding itself calls these "candid," just structurally sharing one status field
      with the formal decision state).
- [x] **Cause, not symptom** — corrected ADR-0031's and ADR-0028's rows to disclose their built
      pieces explicitly (Phase 1 shipped; the estate-tz CLI mechanism shipped) while leaving
      their formal status as Proposed — that decision belongs to the owner, not to this pass —
      so a reader no longer has to cross-reference ADR-0033 or grep the Go source to learn what
      is actually running.
- [x] **Regression test** — none added; this is a periodic status-reconciliation pass over
      prose, the recommendation's own first option (a separate structural "built" column, its
      second option, would be a larger doc-restructure out of this low-severity finding's
      proportionate scope).
- [x] **Failure is loud** — n/a; prose-only fix.
- [x] **Evidence in the status line** — read `internal/windowcheck/command.go:37` and
      `internal/estatecfg/estatecfg.go` directly; grepped ADR-0033 for the exact "Phase 1, built"
      citation; `python3 scripts/docs-link-check.py` unaffected.

## IMP-14

*Stale numbers and dangling references in kit/schemadump docs and comments.*

- [x] **Defect reproduced first** — confirmed `discover.sh:28`'s "44-type allowlist" comment
      against `services.json`'s real `types` mapping (`python3 -c "... len(d['types'])"` → 43);
      confirmed `statediff.py`'s `SWEEP_METHOD` still hardcoded "43 per-type listers" — correct
      today but a second, driftable copy of the same count; confirmed
      `kit-azure/normalize.py:101` still referenced a nonexistent "terraform.yml" pin file (the
      `kit-azure/README.md:195` twin citation was ALREADY fixed by an earlier, unrelated pass);
      confirmed `tools/schemadump/README.md` still describes the AWS dump as "the mature,
      85-type case" / "84 are SDKv2, 1 is framework" while the CURRENTLY COMMITTED
      `aws-v6.53.0-schema.json.gz` artifact's own metadata reports `summary.requested: 1677`
      (`sdkv2_reflected: 1240`, `framework_unreflected: 437`) — the full provider surface, not
      the `types.txt`-scoped 85.
- [x] **Cause, not symptom** — fixed `discover.sh`'s count (44→43) and pointed the comment at
      services.json's own `types` array as the thing to trust, not this prose. Converted
      `statediff.py`'s `SWEEP_METHOD` constant into a `sweep_method(services)` function that
      interpolates `len(services['types'])` from the SAME loaded services doc `main()` already
      validates — this class of drift (a hardcoded copy of a count that lives authoritatively
      elsewhere) cannot recur here again. Fixed the dangling "terraform.yml" reference to name
      the real pin location. Added a prominent correction note to schemadump's README
      disclosing the 85-vs-1677 mismatch and cross-referencing IMP-8 (which owns WHY the
      committed artifact and the documented `gen.sh` pipeline can diverge) rather than silently
      rewriting numbers that describe the tool's DOCUMENTED default invocation, which remains
      accurate for that scope.
- [x] **Regression test** — `sweep_method()`'s self-derivation was verified directly: `python3
      -c "import statediff; print(statediff.sweep_method({'types':{'a':1,'b':2,'c':3}}))"` →
      "3 per-type listers"; run again against the real `services.json` → "43 per-type listers",
      matching. No standalone regression test file added — the existing `importer/kit` pytest
      suite (106 tests) already exercises `statediff.py`'s output shape and passed unchanged
      after the refactor, confirming no behavioral change, only where the number comes from.
- [x] **Failure is loud** — n/a; the fixed count now derives from the same data the sweep itself
      uses, so it cannot silently diverge from it again.
- [x] **Evidence in the status line** — `cd importer/kit && python3 -m pytest -q` (106 passed);
      `cd importer/kit-azure && python3 -m pytest -q` (48 passed); `bash -n
      importer/kit/discover.sh` (syntax OK); `python3 scripts/docs-link-check.py` unaffected.

## UI-5

*RepeatedBlockField renders duplicate DOM ids and a shared radio-group `name` across instances.*

- [x] **Defect reproduced first** — confirmed `Field.tsx` built a radio-group input `name` from
      `param.name` alone (no instance index), so two `RepeatedBlockField` instances of the same
      sub-schema emitted native `<input name="proto">` twice — a browser radio group is scoped
      by `name` alone, so checking option A on instance 2 silently unchecked it on instance 1.
      Field/element `id`s had the identical collision (`field-proto` on both instances).
- [x] **Cause, not symptom** — added an optional `idPrefix` to `Field`/`RepeatedBlockField`; the
      repeated block computes `instanceIdPrefix = <blockPrefix>.<index>` and passes it down to
      every nested `Field`/`RepeatedBlockField` call, so `id`/`name` become
      `field-<prefix>.<name>` — unique per instance, and recursively unique for nested repeated
      blocks too (each level appends its own index).
- [x] **Regression test** — `repeatedBlockField.test.ts`'s new SSR test renders 2 instances of a
      2-option allowlist sub-field and asserts every `id=` is unique and the 4 raw `name=`
      occurrences resolve to exactly 2 distinct values (one radio group per instance).
      **Negative test confirmed**: reverting the `idPrefix` plumbing collapsed both assertions
      (duplicate ids, one shared `name=`); restored, re-ran clean.
- [x] **Failure is loud** — the test asserts `new Set(ids).size === ids.length` (any collision
      fails immediately, naming nothing extra needed — the set-size mismatch is self-evident).
- [x] **Evidence in the status line** — `npx vitest run src/test/repeatedBlockField.test.ts`
      (20 passed); `npx tsc --noEmit -p .` clean.

## UI-7

*ErrorSummary links are dead anchors for radio-group and repeated-block fields.*

- [x] **Defect reproduced first** — confirmed the radiogroup `<div>` in `Field.tsx` had no `id`
      at all before this pass, and `RepeatedBlockField`'s `<fieldset>` likewise carried no `id`
      — `ErrorSummary`'s `href="#field-<name>"` anchors resolved to nothing for either shape,
      so clicking the error summary entry silently did nothing (no scroll, no focus) instead of
      jumping to the field.
- [x] **Cause, not symptom** — same `idPrefix`-derived `id` UI-5 added now lands on the
      radiogroup div (`id="field-rules.0.proto"`) and the repeated-block fieldset
      (`id="field-rules"`), plus `tabIndex={-1}` so the anchor target is actually focusable, not
      just scrollable — matching the convention `ErrorSummary`'s own container already used.
- [x] **Regression test** — `repeatedBlockField.test.ts`'s new tests assert the exact
      `id="field-rules.0.proto"` / `id="field-rules.1.proto"` strings appear, and that the block
      fieldset carries `id="field-rules"` via a regex match on the `<fieldset ...>` tag.
      **Negative test confirmed**: reverting the `id`/`idPrefix` additions failed both
      assertions with the expected ids absent; restored, re-ran clean.
- [x] **Failure is loud** — each assertion names the exact expected `id=` string, so a
      regression names precisely which anchor broke.
- [x] **Evidence in the status line** — `npx vitest run src/test/repeatedBlockField.test.ts`
      (20 passed); `npx tsc --noEmit -p .` clean.

## UI-8

*DiffView corrupts `~` change lines whose old value contains " -> ".*

- [x] **Defect reproduced first** — confirmed `DiffView.tsx`'s `toRows` split a `~` line's body
      on the FIRST occurrence of `' -> '` (`body.split(' -> ')`); when the OLD value itself
      contains the literal substring `" -> "` (any requester/estate-controlled string —
      description, tag, name), the split yields 3+ parts: the removal row shows a truncated old
      value, the addition row shows a FRAGMENT of the old value, and the real new value is
      silently dropped from the rendered diff entirely. Confirmed `generateDiff` always writes
      the new value LAST on the line, so the FINAL `' -> '` is always the real separator even
      when the old value embeds one.
- [x] **Cause, not symptom** — changed the split to `body.lastIndexOf(' -> ')`, slicing on the
      LAST occurrence instead of the first — correct for every case (no embedded arrow: only one
      occurrence, identical behavior; an embedded arrow: the real separator is always the last
      one, since `generateDiff` never appends anything after the new value on that line).
      Investigated the finding's secondary sub-claim ("`.trim()` also discards nested
      indentation") by tracing `asAddition`'s regex and `renderBody`'s padding scheme through
      every `hclSkeleton.ts`/`diff.ts` code path that emits `+`/`-` prefixed lines — leading
      whitespace is ALWAYS captured into `indent` in `toRows` BEFORE `.trim()` ever runs on the
      remainder, for every reachable case. No reproducible defect found; left unfixed rather
      than speculatively "fixing" a claim that doesn't hold against current code (L-29).
- [x] **Regression test** — new `diffView.test.ts`: one test drives a synthetic diff string with
      an old value containing a literal `" -> "` and asserts the full old value survives in the
      removal row, the real new value appears, and the addition row is the clean new value (not
      a truncated fragment of the old one); a second test pins the ordinary no-embedded-arrow
      case is unaffected. **Negative test confirmed**: reverted `lastIndexOf` back to `.split`,
      the embedded-arrow test failed (old value truncated, new value absent); restored, re-ran
      clean.
- [x] **Failure is loud** — the test asserts the SPECIFIC failure mode directly (`clean` — the
      real new value — must appear; `"after"` alone — the truncated fragment — must NOT appear
      as a standalone addition row), not just "something changed."
- [x] **Evidence in the status line** — `npx vitest run src/test/diffView.test.ts` (2 passed);
      `npx tsc --noEmit -p .` clean (required one incidental null-safety fix,
      `m[1] ?? ''`, unrelated to the core defect).

## UI-13

*RepeatedBlockField keys instances and touched-state by array index: state misattributes after a mid-list removal.*

- [x] **Defect reproduced first** — confirmed `RepeatedBlockField`'s local `subTouched` map is
      keyed `<instanceIndex>.<subFieldName>`, and `remove()` dropped the removed instance from
      the DATA array without ever reindexing `touched`'s keys — removing instance 0 left
      instance 1's touched flags stored under key `1.*` even though instance 1 (now shifted into
      slot 0) is a DIFFERENT row; a sub-field's blurred/touched display attached to the wrong row
      after any removal but the last.
- [x] **Cause, not symptom** — new pure `reindexTouchedAfterRemove(touched, removedIndex)` in
      `lib/catalog.ts`: drops the removed row's own keys, shifts every later row's index down by
      one, and leaves earlier rows untouched — `RepeatedBlockField`'s `remove()` now calls it
      before updating state, so touched state always tracks the SAME row across a removal.
- [x] **Regression test** — `repeatedBlockField.test.ts`'s new pure-function test covers 3
      cases: a middle removal reindexes later rows and drops the removed row's own flags; an
      earlier removal leaves prior rows alone; a sub-field name that itself contains a dot
      round-trips correctly (split-then-rejoin on the FIRST dot only, not truncated).
      **Negative test confirmed**: reverting `remove()`'s call to `reindexTouchedAfterRemove`
      (falling back to a bare filter) left stale/misaligned keys and failed the assertions;
      restored, re-ran clean.
- [x] **Failure is loud** — each assertion pins the exact expected key→value map, so a
      regression names precisely which key misindexed.
- [x] **Evidence in the status line** — `npx vitest run src/test/repeatedBlockField.test.ts`
      (20 passed); `npx tsc --noEmit -p .` clean.

## UI-6

*Hand-rolled drift drawers are dialogs in name only: no aria-modal, no focus move, no focus trap, no Escape.*

- [x] **Defect reproduced first** — confirmed all 4 drift drawers
      (Import/Legitimize/Proposal/Restore) and `ReauthDialog` rendered a `role="dialog"` div with
      NO `aria-modal`, no focus movement on open, no Tab/Shift+Tab cycling (the page behind stayed
      fully tab-reachable and screen-reader-browsable despite being visually obscured), no
      Escape-to-close, and no focus restoration to the trigger on close.
- [x] **Cause, not symptom** — new shared `lib/useModal.ts` hook (not a new dependency — the app
      already has 2 other Radix packages wired for different overlay classes, and these
      dialogs are simple enough not to need Radix's fuller feature set): captures the trigger
      and moves focus in on mount (a mount-only effect, deliberately NOT re-run every render, so
      a controlled-input re-render never yanks focus back to the top mid-keystroke); a separate
      keydown effect traps Tab/Shift+Tab within the container and closes on Escape (capture
      phase, so a descendant input never eats it first); restores focus to the trigger on
      unmount. The Tab-cycle DECISION logic is extracted into a pure `tabTrapTarget(itemCount,
      activeIndex, shiftKey)` function specifically so it's unit-testable without a DOM (no
      jsdom in this repo). Wired into all 5 components: `dialogRef` + `useModal(dialogRef,
      onClose)` + `ref={dialogRef}` + `aria-modal="true"` + `tabIndex={-1}` on each dialog root.
- [x] **Regression test** — new `useModal.test.ts` unit-tests `tabTrapTarget` directly: no
      items (always null — caller suppresses Tab unconditionally), a single item (Tab/Shift+Tab
      both redirect back to it), wrap-around at both ends, a middle item left alone, focus
      outside the container pulled back in either direction, and the `-1` "contained but not an
      enumerated item" case (the container's own tabIndex fallback) correctly treated as a
      middle item, not "outside." **Negative test confirmed**: flipped the `shiftKey` branch's
      target from `'last'` to `'first'`, 4 of 9 tests failed exactly as expected; restored,
      re-ran clean. The DOM-touching parts of `useModal` itself (actual focus movement, the
      keydown listener, restoration) rely on the existing SSR/markup tests on each dialog's
      rendered output (136 tests across 5 files, unaffected) plus this pure-logic proof — a
      stated scope boundary, the same TEST-7 gap the rest of this app's interactive components
      already carry, not an oversight.
- [x] **Failure is loud** — each `tabTrapTarget` test asserts the exact expected target
      (`'first'` / `'last'` / `null`), not a bare truthy check.
- [x] **Evidence in the status line** — `npx vitest run src/test/useModal.test.ts` (9 passed);
      `npx vitest run src/test/accountSecurityUi.test.tsx src/test/driftProposalUi.test.tsx
      src/test/driftResolutionFlow.test.tsx src/test/unmanagedResources.test.tsx
      src/test/driftPanel.test.tsx` (136 passed, unaffected); `npx tsc --noEmit -p .` clean.

## UI-9

*`/login`, `/onboarding`, and the LegacyRedirect route have no errorElement: a render error there shows React Router's raw default error screen.*

- [x] **Defect reproduced first** — confirmed only the `/p/:projectId` route carried
      `errorElement: <RouteError />`; `/login`, the first-run route, and the catch-all
      `LegacyRedirect` route sat as SIBLINGS at the top level with no ancestor errorElement — a
      throw during any of them (including a stale deployment's 404'd lazy-chunk load, which
      rejects the `lazy()` promise and surfaces as a route error) fell through to React
      Router's raw, unstyled default error screen.
- [x] **Cause, not symptom** — wrapped the entire route array in a pathless root layout route
      carrying one `errorElement: <RouteError />`, covering `/login`/first-run/`/p/:projectId`/
      LegacyRedirect uniformly (React Router renders a route with no `element` as a plain
      `<Outlet />`, confirmed against the library's own dev-mode source). Split the route tree
      out of `router.tsx` into a new `routeConfig.tsx` (plain data, no `createBrowserRouter`
      call) specifically so the structural regression test below can import it directly —
      `router.tsx` itself can't be imported outside a browser (`createBrowserRouter` reaches for
      `window`/`history` immediately), which is exactly why no test in this repo previously
      imported it.
- [x] **Regression test** — new `routeConfig.test.ts` walks the whole tree and asserts every
      route (not just the 3 named ones) has an `errorElement` somewhere in its own ancestor
      chain, with dedicated checks for `/login`, the first-run route, `/p/:projectId`, and the
      top-level catch-all. **Negative test confirmed**: rebuilt the pre-fix flat top-level array
      (no wrapping errorElement) — the walker correctly named exactly the 3 unprotected routes
      (`/login`, `/onboarding`, `*`); restored, re-ran clean. Also updated 5 existing tests
      (`adminSurfaceCompleteness.test.ts`, `notInControlPlane.test.ts`,
      `accountSecurityUi.test.tsx`, `driftPanel.test.tsx`) that pinned route registration via
      source-inspection of `router.tsx` to read `routeConfig.tsx` instead.
- [x] **Failure is loud** — the "every route protected" test reports the exact unprotected
      paths as an array, not a bare boolean.
- [x] **Evidence in the status line** — `npx vitest run src/test/routeConfig.test.ts
      src/test/entryGraph.test.ts src/test/projectRoutes.test.ts` (25 passed); full suite `npx
      vitest run` (159 files, 2788 passed at the time); `npx tsc --noEmit -p .` clean.

## UI-11

*Nested repeated blocks skip their instance-count bounds.*

- [x] **Defect reproduced first** — confirmed `repeatedInstanceErrors`' `f.repeated` branch (a
      nested repeated sub-field inside a repeated block) only recursed into per-instance
      sub-field validity (`rows.some(r => Object.keys(repeatedInstanceErrors(...)).length > 0)`)
      — it never checked `f.bounds.minItems`/`maxItems` against the nested block's own instance
      COUNT, unlike the top-level `validateParams` (`lib/interpreter.ts`), which does. A nested
      block with `minItems: 2` and one valid row passed silently.
- [x] **Cause, not symptom** — added the identical min/maxItems count check `validateParams`
      applies at the top level, run BEFORE the per-instance recursion (short-circuiting it when
      the count itself is already out of bounds, same precedence as the top-level law), same
      message format ("X needs at least N entries" / "X allows at most N entries").
- [x] **Regression test** — `repeatedBlockField.test.ts`'s new test nests a `tags` repeated
      sub-field (`minItems: 2, maxItems: 3`) inside `rules`' schema and covers: below minItems
      (one row where two required — this IS the finding's exact gap), above maxItems, within
      bounds but one row itself invalid (unaffected — proves the new check doesn't break the
      existing recursion), and a fully valid case. **Negative test confirmed**: reverted the
      `f.repeated` branch to its pre-fix form (recursion only, no count check) — the
      below-minItems case returned `{}` instead of the expected error; restored, re-ran clean.
- [x] **Failure is loud** — the test asserts the exact error object
      (`{ tags: 'Tags needs at least 2 entries' }`), not a bare truthy/falsy check.
- [x] **Evidence in the status line** — `npx vitest run src/test/repeatedBlockField.test.ts`
      (20 passed); `npx tsc --noEmit -p .` clean.

## UI-12

*Configure ⇄ Review step transitions never move focus, and the Suspense skeleton is silent for assistive tech.*

- [x] **Defect reproduced first** — confirmed `RequestForm.tsx`'s `onReview` (valid path) and
      the `onEdit={() => setStep('configure')}` inline handler both swapped the whole page
      content with no focus management at all — keyboard focus died on the unmounted button
      (falls back to `<body>`), and nothing told assistive tech the step changed; only the
      INVALID path (`errorRef`) was handled. Separately, confirmed `RouteSkeleton` was
      `aria-hidden="true"` on its entire container — correct for the decorative shimmer bars
      themselves, but it hid the whole loading state, so a route's Suspense fallback was pure
      silence for a screen reader, not "loading."
- [x] **Cause, not symptom** — added `reviewHeadingRef`/`configureHeadingRef`, each moved to via
      `requestAnimationFrame` (the same technique the pre-existing `errorRef` focus call already
      used) right after the corresponding `setStep(...)` call, targeting each step's own `<h1>`
      (`ReviewStep` gained an optional `headingRef` prop, `tabIndex={-1}` on both headings so
      they're real focus targets). Renamed the inline `onEdit` handler to a named `onBackToEdit`
      function so it could carry the same focus-move logic. `RouteSkeleton` changed to
      `role="status"` + `aria-busy="true"` + a visually-hidden "Loading…" text (`.rskel__sr-only`,
      the same clip-rect technique `approvals.css`'s `.apv__sr-only` already uses); the
      decorative shimmer bars kept their own `aria-hidden="true"`.
- [x] **Regression test** — new `uiRobustnessFocus.test.ts`: an SSR test on `ReviewStep`
      confirms its `<h1>` carries `tabIndex={-1}`; source-pinned tests confirm `RequestForm.tsx`
      calls `reviewHeadingRef.current?.focus()`/`configureHeadingRef.current?.focus()` AFTER
      (not before) their respective `setStep` calls, and that `onEdit={onBackToEdit}` replaced
      the old bare inline handler; an SSR test on `RouteSkeleton` confirms `role="status"`,
      `aria-busy="true"`, the "Loading" text, and that the shimmer bars stay `aria-hidden`.
      **Negative test confirmed**: reverted each of the 4 pieces independently (heading
      tabIndex, the two focus-move call sites, RouteSkeleton's aria wiring) — each reversion
      failed its own targeted assertion(s) exactly as expected; all 4 restored, re-ran clean.
- [x] **Failure is loud** — the source-pinned tests check strict ORDERING (the `setStep` call
      index must precede the `.focus()` call index), not just substring presence, so a
      reordering that broke the actual runtime sequence would still be caught.
- [x] **Evidence in the status line** — `npx vitest run src/test/uiRobustnessFocus.test.ts`
      (6 passed); full suite `npx vitest run` (159 files, 2795 passed at the time); `npx tsc
      --noEmit -p .` clean.

## UI-14

*InventoryPicker: an optional single-select can never be cleared.*

- [x] **Defect reproduced first** — confirmed once a single-select address was committed, typing
      reopened the query but Escape/blur always restored the committed value — there was no
      affordance to return an OPTIONAL `source:"inventory"` param to empty short of reloading the
      form. Separately confirmed `aria-controls={listId}` was present on the `<input
      role="combobox">` even while the listbox panel was not in the DOM (only rendered while
      `open`).
- [x] **Cause, not symptom** — added a "×" clear button (`.sf-combo__clear`), shown only for the
      closed, committed view of a NON-required param (`!multiple && !open && selected !==
      undefined && !param.required` — a required param has no valid empty state to clear TO, so
      it gets no affordance); clicking it clears the value, resets the query, and refocuses the
      input. `aria-controls` changed to `open ? listId : undefined`.
- [x] **Regression test** — new tests in `inventoryPicker.test.ts` (via `Field`, SSR): an
      optional param with a committed value renders the clear button; a REQUIRED param with a
      committed value does NOT; an optional param with no selection yet does not either;
      `aria-controls` is absent while closed. **Negative test confirmed**: reverted the button
      JSX and the `aria-controls` change independently — 2 of the 4 new assertions failed
      exactly as expected (the other 2 target the `--clearable` CSS class, unaffected by that
      partial revert); restored, re-ran clean.
- [x] **Failure is loud** — each assertion checks a specific substring/absence
      (`sf-combo__clear` present/absent, `aria-controls` present/absent), naming exactly which
      half of the fix regressed.
- [x] **Evidence in the status line** — `npx vitest run src/test/inventoryPicker.test.ts`
      (20 passed); `npx tsc --noEmit -p .` clean.

## UI-15

*CommandPalette data is fetched once per shell mount, so "My requests" rows go stale within a session.*

- [x] **Defect reproduced first** — confirmed the palette's manifests/inventory/requests fetches
      all shared ONE effect keyed only on `[user, projectId]` (mount-only in practice, since
      neither changes within a session for most users) — unlike `Notifications.tsx`'s bell,
      which was fixed for the identical reason under UIUX-13 (keyed additionally on `open`). A
      request submitted or approved after the palette first loaded stayed absent, or showed a
      stale status, in "My requests" results until a user/project change.
- [x] **Cause, not symptom** — split the requests fetch (`listRequests`/`listPendingApprovals`)
      into its OWN effect keyed on `[user, projectId, open]`, mirroring Notifications.tsx's
      fix exactly. Deliberately did NOT key the manifests/inventory effect on `open` too — the
      finding itself notes those are legitimately static, and refetching the full catalog +
      inventory on every palette open would be pure waste for data that never changes within a
      session.
- [x] **Regression test** — new tests in `palette.test.ts` (source-pinned — mounting the
      palette through a real open/close cycle needs jsdom, none in this repo): confirms two
      distinct `useEffect` dependency arrays exist (`[user, projectId]` and `[user, projectId,
      open]`), and that the requests-fetch code (`api.listRequests`) sits in the `open`-keyed
      effect while the catalog effect's deps close BEFORE the requests fetch even starts (proof
      the two calls aren't sharing one effect body). **Negative test confirmed**: reverted to
      one shared effect — both new assertions failed exactly as expected; restored, re-ran
      clean.
- [x] **Failure is loud** — the ordering assertion (catalog effect's deps close before the
      requests fetch starts) would catch a re-merge even if someone renamed variables around it.
- [x] **Evidence in the status line** — `npx vitest run src/test/palette.test.ts` (41 passed);
      full suite `npx vitest run` (159 files, 2801 passed at the time); `npx tsc --noEmit -p .`
      clean.

## FE-7

*PendingChangesBanner count goes stale after any dual-control activity — and the mock branch reads an unsubscribed store.*

- [x] **Defect reproduced first** — confirmed `lib/pendingChanges.ts` had NO emitter at all
      (unlike settings.ts/audit.ts's same-pattern stores) — propose/ack/reject wrote straight to
      storage and nothing told a mounted `PendingChangesBanner` to re-render on a same-tab
      write. Separately confirmed `AdminLayout` mounts the banner ONCE for the whole admin area
      (nested admin routes swap under it, not around it) and its server-count effect was keyed
      only on `[authoritative]` — a mount-only fetch that never saw a decision/proposal made on
      another admin tab until a full admin-area re-entry.
- [x] **Cause, not symptom** — gave `pendingChanges.ts` the identical `createEmitter` +
      `subscribeWithStorage` + `useSyncExternalStore` treatment settings.ts already has (new
      `usePendingCount()` hook; `pendingCount()` itself doubles as the getSnapshot function —
      no cached-object dance needed since it returns a primitive `number`, which is
      `Object.is`-stable by value). `PendingChangesBanner`'s mock branch now reads
      `usePendingCount()` instead of a bare `pendingCount()` call. The server branch's effect
      gained `location.pathname` (via `useLocation()`) in its dependency array, so it refetches
      on every admin sub-route change — the exact "leaves and re-enters" cadence the finding
      names, without needing every propose/ack/reject call site (scattered across
      SettingsAdmin/UsersAdmin/RiskAdmin/PendingChanges) to know about this banner.
- [x] **Regression test** — new `subscribePendingChangesChanged` tests in
      `pendingChanges.test.ts` mirror `settings.test.ts`'s own subscribe-source tests exactly:
      fires on a write, fires once per write across propose/ack/reject, stops firing after
      unsubscribe, and a no-op write (unknown id) doesn't fire. Source-pinned tests confirm
      `PendingChangesBanner.tsx` uses `usePendingCount` (not a bare call) and that the effect's
      deps include `location.pathname`. **Negative test confirmed**: reverted the emitter's
      `emit()` call, the component's `usePendingCount` usage, and the route-keyed dependency
      independently — each reversion failed its own targeted assertions (3, 1, and 1 tests
      respectively) exactly as expected; all restored, re-ran clean.
- [x] **Failure is loud** — the subscribe tests count actual invocations (`calls` variable), not
      a bare "did it fire at all" — a double-fire or a missed unsubscribe both surface precisely.
- [x] **Evidence in the status line** — `npx vitest run src/test/pendingChanges.test.ts`
      (24 passed); full suite `npx vitest run` (159 files, 2807 passed at the time); `npx tsc
      --noEmit -p .` clean.

## FE-8

*AuditHistory silently truncates to the first page (100 entries) — the cursor is fetched and thrown away.*

- [x] **Defect reproduced first** — confirmed `loadAuditRows` called `client.listAuditEntries()`
      with no options and returned only `page.items`, discarding `page.cursor` entirely — the
      server pages at a default limit, so anything past it was silently absent, with the screen
      captioning the truncated count as if it were the whole history and no "load more"
      affordance at all.
- [x] **Cause, not symptom** — `loadAuditRows` now returns `{ rows, cursor }` (`AuditRowsPage`)
      and accepts an optional `cursor` parameter forwarded to `client.listAuditEntries()`;
      `AuditHistory.tsx` tracks the returned `cursor` in state and offers a "Load older events"
      button (visible only while a cursor is present) that appends the next page rather than
      replacing what's shown. The caption changed to "N events loaded ... more available" —
      honest about a partial window instead of implying completeness.
- [x] **Regression test** — updated `auditFlow.test.ts`'s existing `loadAuditRows` tests to the
      new `{rows, cursor}` shape and added: a server page carries its cursor forward, a
      passed-in cursor is forwarded to the server call, and the local/advisory branch never
      paginates even if a cursor is passed in (nothing to page). New source-pinned tests
      confirm `AuditHistory.tsx`'s initial load and `onLoadMore` both track `page.cursor`, that
      loaded-older pages are APPENDED (not replacing), and the control only renders while a
      cursor is present. **Negative test confirmed**: reverted the cursor plumbing in
      `auditFlow.ts` and the append/onLoadMore wiring in `AuditHistory.tsx` independently — 1
      and 2 tests failed respectively, exactly as expected; both restored, re-ran clean.
- [x] **Failure is loud** — the cursor-forwarding test asserts the EXACT call arguments
      (`[[{ cursor: 'srv-1' }]]`), not just that a call happened.
- [x] **Evidence in the status line** — `npx vitest run src/test/auditFlow.test.ts` (24 passed);
      `npx vitest run src/test/advisoryGate.test.ts` (46 passed, unaffected); full suite `npx
      vitest run` (159 files, 2813 passed at the time); `npx tsc --noEmit -p .` clean.

## FE-10

*Mock `rejectRequest` skips the status guard the real API enforces.*

- [x] **Defect reproduced first** — confirmed the mock's `approveRequest` re-checks
      `req.status !== 'AWAITING_CODE_REVIEW'` before mutating, but `rejectRequest` checked only
      role and self-rejection — a terminal request (APPLIED/REJECTED/WITHDRAWN/…) could be
      flipped to REJECTED in mock mode, where ccp-api's real `OPEN_STATUSES` gate
      (`routes/requests.ts`) returns `STATE_CONFLICT`.
- [x] **Cause, not symptom** — added the identical status guard `approveRequest` already has
      (adjusted for reject's wider OPEN set — `AWAITING_CODE_REVIEW` OR `NEEDS_ENGINEER`,
      matching the server's `OPEN_STATUSES`), so the mock's fail-closed doctrine ("mirror the
      server's fail-closed gates") no longer has this hole.
- [x] **Regression test** — new tests in `api-enforcement.test.ts`: an already-REJECTED
      (terminal) request refuses a second reject; a fully-approved APPLIED request refuses a
      reject. **Negative test confirmed**: removed the new guard — both tests failed (`ok` was
      `true` instead of the expected `false`) exactly as expected; restored, re-ran clean.
- [x] **Failure is loud** — each test also asserts the specific refusal reason string
      (`/not open for rejection/i`), not just `ok: false`.
- [x] **Evidence in the status line** — `npx vitest run src/test/api-enforcement.test.ts`
      (13 passed); full suite `npx vitest run` (159 files, 2815 passed at the time); `npx tsc
      --noEmit -p .` clean.

## FE-12

*After a partial approval, the queue keeps a card the server's pending scope would drop.*

- [x] **Defect reproduced first** — confirmed `applyMutatedRequestToList` kept a row iff
      `status === 'AWAITING_CODE_REVIEW'` — on a two-step ladder ([L2, L3]), the approver's OWN
      signature leaves the status unchanged (still `AWAITING_CODE_REVIEW`, 1 of 2 signed), so
      the patch kept the card even though the server's `scope=pending` predicate
      (`routes/requests.ts`: open status ∧ `canApprove` ∧ the viewer's role can sign the NEXT
      ladder step) would exclude it for THAT viewer — already signed, or L3 isn't theirs to
      sign. The retained card was non-actionable for Approve but Reject stayed offered, and the
      header count included it, until a manual refresh made it vanish.
- [x] **Cause, not symptom** — new `pendingForViewer(x, viewer)` re-expresses the server's exact
      predicate client-side, reusing the already-existing `canApprove` (lib/permissions.ts) and
      `canSignApprovalStep` (lib/approvalLadder.ts) — the SAME two functions `ReviewCard`'s own
      `mayApprove` computation for the Approve button already calls, so the two can never
      disagree. `nextApprovalStep === undefined` (mock-mode, which never sets the ladder
      fields) falls back to the base `canApprove` rule alone, the identical fallback
      `mayApprove` already uses. `applyMutatedRequestToList` now takes the viewer (`getCurrentUser()`
      at the one call site — actor from the session, never a prop, same convention every other
      mutation in this file follows) and calls `pendingForViewer` instead of the bare status
      check.
- [x] **Regression test** — `approvalsQueue.test.ts`'s existing tests updated to pass a
      `fixtureViewer()` (an approver who is never the fixture request's own requester); 4 new
      tests cover the finding's exact scenario: the approver who just signed L2 loses the row
      (already signed); a DIFFERENT approver also loses it once L3 is next (wrong seniority,
      isolated from the self-signed case); a LEAD keeps the row (can sign L3); and
      `nextApprovalStep === null` (fully signed, status not yet flipped) drops the row for
      everyone. **Negative test confirmed**: reverted `pendingForViewer` to the bare
      `status === 'AWAITING_CODE_REVIEW'` check — 3 of the 4 new tests failed exactly as
      expected (one, the LEAD-keeps-the-row case, coincidentally still passed since the old
      check also kept it); restored, re-ran clean.
- [x] **Failure is loud** — each of the 4 new tests isolates ONE half of the predicate (self-
      already-signed vs. wrong-seniority vs. fully-signed), so a regression names precisely
      which clause broke.
- [x] **Evidence in the status line** — `npx vitest run src/test/approvalsQueue.test.ts`
      (25 passed); full suite `npx vitest run` (159 files, 2819 passed at the time); `npx tsc
      --noEmit -p .` clean.

## FE-13

*RequestDetail sub-panels hold un-keyed local state across request-id navigation.*

- [x] **Defect reproduced first** — confirmed `/requests/A` → `/requests/B` reuses the same
      `RequestDetail` route element, so `WindowPanel`'s `rewindowAt` (`useState<string>(() =>
      isoToLocalInput(defaultWindowAt(now)))`) and `LinkPrPanel`'s `prUrl`
      (`useState(request.prUrl ?? '')`) — both seeded ONCE at first mount — survived the
      navigation unchanged: a half-typed PR URL drafted on request A (or A's linked URL)
      remained visible in the input when B rendered, and a Lead could plausibly paste A's
      engineering PR onto B.
- [x] **Cause, not symptom** — added `key={request.id}` to both `<WindowPanel>` and
      `<LinkPrPanel>` at their `RequestDetail` call sites — the idiomatic React reset: a key
      change forces React to unmount the old instance and mount a fresh one (fresh initial
      state) rather than reconcile in place. Checked `CoolingPanel` (rendered adjacent, same
      shape) for the same class of bug — it holds no local `useState` at all, so it was never
      affected and needed no key.
- [x] **Regression test** — new source-pinned tests in `requestDetail.test.ts` (mounting
      RequestDetail through a real navigation needs jsdom, none in this repo) assert
      `<WindowPanel key={request.id}` and `<LinkPrPanel key={request.id}` both appear in
      `RequestDetail.tsx`'s source. **Negative test confirmed**: removed both `key` props —
      both tests failed exactly as expected; restored, re-ran clean.
- [x] **Failure is loud** — each test names which panel's key is missing (two separate
      assertions, not one combined check).
- [x] **Evidence in the status line** — `npx vitest run src/test/requestDetail.test.ts`
      (37 passed); full suite `npx vitest run` (159 files, 2821 passed at the time); `npx tsc
      --noEmit -p .` clean.

## FE-14

*DriftPage's post-trigger refetches bypass the staleness guard.*

- [x] **Defect reproduced first** — confirmed `handleStartCheck`/`handleGenerate` both followed
      success with `void refreshStatus()`, and `refreshStatus` called `api.getDriftStatus()`
      with no `active` flag and no project check at all — unlike the main status effect, which
      guards itself with a scoped `active` flag keyed on `[projectId, reloadToken]`. Since
      `getDriftStatus()` reads the CURRENT project scope at call time, a project switch (or
      unmount) happening while a trigger's response was still in flight could apply a stale or
      foreign project's data over the new project's page — racing the main effect's own fetch
      for last-writer-wins.
- [x] **Cause, not symptom** — added a `projectIdRef` (kept in sync with `projectId` every
      render via an unconditional `useEffect`) and a `mountedRef` (flipped false in a
      cleanup-only `useEffect`). `refreshStatus` now captures `projectIdRef.current` right
      before its `getDriftStatus()` call goes out and discards the response — never calling
      `setStatus` — if `mountedRef.current` is false or `projectIdRef.current` no longer
      matches what was captured, mirroring the main effect's own mount/scope discipline for a
      handler that (unlike an effect) has no natural cleanup point of its own.
- [x] **Regression test** — new `driftPageStaleness.test.ts` (source-pinned — DriftPage's data
      loading runs in effects, which `renderToStaticMarkup` never fires, and driving a real
      trigger→response→project-switch race needs jsdom, none in this repo): confirms
      `refreshStatus` captures `forProjectId` before its request and checks both
      `mountedRef`/`projectIdRef` (in that order, before the state write) after; confirms
      `mountedRef` flips false in a `[]`-deps cleanup-only effect; confirms `projectIdRef`
      tracks the current project with no dependency array (always fresh); confirms exactly 2
      raw `api.getDriftStatus()` call sites exist (the main effect + `refreshStatus` itself) so
      no future trigger handler can bypass the guard by calling the API directly. **Negative
      test confirmed**: reverted `refreshStatus` to its pre-fix bare form — the guard-check test
      failed exactly as expected (the other 3 structural tests target code untouched by that
      specific revert); restored, re-ran clean.
- [x] **Failure is loud** — the "no bypass" test would catch a future handler that calls
      `api.getDriftStatus()` directly instead of going through the guarded `refreshStatus`, not
      just a regression in the existing two call sites.
- [x] **Evidence in the status line** — `npx vitest run src/test/driftPageStaleness.test.ts`
      (4 passed); `npx vitest run src/test/driftProposalUi.test.tsx src/test/driftPanel.test.tsx
      src/test/driftResolutionFlow.test.tsx` (95 passed, unaffected); full suite `npx vitest
      run` (160 files, 2825 passed at the time); `npx tsc --noEmit -p .` clean.

## CTL-6

*`danglingRef` substring scan falsely refuses removal when another resource's name extends the target's name.*

- [x] **Defect reproduced first** — confirmed `danglingRef` (`removeblock.go`) used a raw
      `bytes.Contains` scan (same-file-excluding-block, and cross-file) to decide whether an
      address like `aws_ebs_volume.data` still has a live reference elsewhere — a byte-prefix
      sibling `aws_ebs_volume.data_archive` matches that scan even though it is a wholly
      different resource, so removing `.data` was falsely refused as "still referenced" (a
      fail-open... no, fail-CLOSED safety gate over-triggering — the removal that should have
      been allowed was blocked).
- [x] **Cause, not symptom** — new `isIdentByte`/`containsAddress` in `removeblock.go` add an
      identifier-boundary check on BOTH sides of every occurrence (not just the first — a
      boundary-rejected first hit must not short-circuit a later genuine one; `containsAddress`
      re-scans from just past each rejected occurrence's start). `danglingRef` now calls
      `containsAddress` at both call sites instead of `bytes.Contains`. Reasoning proven safe: a
      genuine reference in valid HCL syntax is by construction never adjacent to another
      identifier char on either side, so adding boundary checks can only remove false
      positives, never introduce false negatives — safe for a fail-closed gate.
- [x] **Regression test** — 3 new subtests in `covrender_cov_test.go`'s
      `TestCovrenderDanglingRef`: a prefix-named sibling's reference does NOT count (the false
      positive this closes); a genuine reference to the exact (shorter) address still refuses
      (proves the fix isn't merely "always false" — both a sibling AND a genuine reference are
      in the same fixture); a suffix-extended identifier on the LEFT does not count either
      (both boundaries checked). **Negative test confirmed**: reverted `containsAddress` calls
      back to `bytes.Contains` — 2 of the 3 new subtests failed exactly as expected (the
      true-positive one correctly still passed, proving the fix isn't trivially broken);
      restored, re-verified green (9/9 subtests in the function).
- [x] **Failure is loud** — each subtest names which boundary (left/right, sibling/exact)
      it covers, so a regression pinpoints which side broke.
- [x] **Evidence in the status line** — `go test ./internal/edit/...` and the full
      `go build ./... && go test ./...` both clean after CTL-6/7/8 combined.

## CTL-7

*plancheck's `inventoryAddr` does not skip `role:"reference"` inventory params, diverging from the executor's `targetAddress`.*

- [x] **Defect reproduced first** — confirmed `inventoryAddr` (`plancheck.go`) returned the
      FIRST inventory-sourced param it found regardless of `Role`, while its sibling
      `edit.targetAddress`/`prprep.inventoryAddr` both already skip `role:"reference"` params —
      an op whose reference param (e.g. `key_pair`) is listed before the real target
      (`iam_instance_profile`) would have plancheck resolve the wrong address.
- [x] **Cause, not symptom** — added `&& p.Role != "reference"` to the loop condition,
      matching the sibling functions' existing logic exactly, with an expanded doc comment
      citing both.
- [x] **Regression test** — 3 new tests: `TestInventoryAddrSkipsReferenceRole` (a reference
      param listed BEFORE the real target — the exact ordering that exposes the bug),
      `TestInventoryAddrOrdinaryCase` (single non-reference param, unaffected),
      `TestInventoryAddrNoInventoryParam` (no inventory param at all → empty string, no panic).
      **Negative test confirmed**: reverted the `&& p.Role != "reference"` clause —
      `TestInventoryAddrSkipsReferenceRole` failed exactly as expected (the reference address
      returned instead of the target); restored, re-verified green.
- [x] **Failure is loud** — the failing test names the exact wrong address returned.
- [x] **Evidence in the status line** — `go test ./internal/plancheck/...` and the full
      `go build ./... && go test ./...` both clean after CTL-6/7/8 combined.

## CTL-8

*`atomicWrite` silently changes edited-file permissions to 0600 and skips fsync.*

- [x] **Defect reproduced first** — confirmed `atomicWrite` (`edit.go`) created its temp file
      via `os.CreateTemp` (always 0600) and never `chmod`'d it before `rename`, so every edit
      silently narrowed an existing file's mode (e.g. 0644 → 0600); it also never called
      `Sync()` before `Close()`, so a crash mid-rename could lose the write despite the rename
      itself having appeared to succeed.
- [x] **Cause, not symptom** — `atomicWrite` now `os.Stat`s the target's EXISTING mode first
      (falling back to 0644 for a brand-new file), `Chmod`s the temp file to that mode before
      rename, and calls `tmp.Sync()` before `Close()` — mirroring `ccp-api`'s
      `FileStore.writeAtomic`/ERR-10 fix pattern in this same repo.
- [x] **Regression test** — 3 new subtests in `coveditcore_cov_test.go`'s
      `TestCoveditcoreAtomicWrite`: preserves an existing 0600→0644 mode change correctly,
      preserves a non-default existing mode (0640), and a brand-new file gets 0644 (not the
      temp file's raw 0600). **Negative test confirmed**: removed the `mode`
      computation/`os.Stat`/`tmp.Chmod` call — all 3 new subtests failed with mode 600 exactly
      as expected; restored, re-verified green (6/6 subtests).
- [x] **Failure is loud** — each subtest asserts the exact expected mode, not just "changed".
- [x] **Evidence in the status line** — `go test ./internal/edit/...` and the full
      `go build ./... && go test ./...` both clean after CTL-6/7/8 combined.

## API-11

*Audit-chain read path bypasses the injected clock and truncates at 120 months.*

- [x] **Defect reproduced first** — re-derived both halves at HEAD (L-29) rather than trusting
      the finding's own text: the clock-usage half was ALREADY fixed — `nowDate()` (not `new
      Date()`) is used consistently at all 3 `monthsBackward` call sites in
      `domain/auditQuery.ts`, with an existing doc comment explaining why. The 120-month-cap
      half was still real: every walk site already self-terminates on `collected >= total` (the
      chain head's own declared count), so `MAX_MONTHS_WALKED` was never the intended stopping
      condition — only a corrupted-store safety valve — but at 120 (ten years) it was low
      enough to BE the real, silently-truncating ceiling for a genuinely long-lived deployment:
      `verifyChain` would see a short chain and report a perfectly intact one as BROKEN
      (`/readyz` 503, `export.verified: false`).
- [x] **Cause, not symptom** — raised `MAX_MONTHS_WALKED` from 120 to 1200 (a century) —
      generous enough that no real deployment's lifetime reaches it while still being a
      genuinely finite bound against a corrupted `head.count` runaway loop.
- [x] **Regression test** — new test in `auditMonthWalk.test.ts`: "reads a chain spanning more
      than ten years intact (the old 120-month cap would have truncated it)" — appends 2
      entries at `2015-03-01`, 3 entries at `2026-07-10`, reads at `2026-07-31`, asserts
      `readAuditChronological` returns all 5 entries and `exportAuditChain` reports
      `verified: true`. **Negative test confirmed**: reverted `MAX_MONTHS_WALKED` to 120 — the
      new test failed (`expected [...] to have a length of 5 but got 3`); restored, all 4 tests
      in the file pass.
- [x] **Failure is loud** — the test asserts the exact entry count AND the chain's verified
      status, so a regression can't silently pass with a short-but-still-"verified" chain.
- [x] **Evidence in the status line** — `cd ccp/api && npx vitest run
      test/auditMonthWalk.test.ts` (4 passed); full suite `npx vitest run` (101 files, 1415
      passed at the time); `npx tsc --noEmit` clean.

## DATA-17

*Calendar-dependent test: the FileStore audit-durability test hardcodes month `202607`.*

- [x] **Defect reproduced first** — re-derived at HEAD (L-29) rather than trusting the finding's
      own text: `grep -n "202607" ccp/api/test/fileStore.test.ts` shows only ONE literal
      `'202607'` remaining (inside "a committed transact batch survives a restart"), and it is
      NOT calendar-dependent — the SAME `audit` key object (built once via
      `S.auditKey('sample', '202607', ...)`) is used for both the write and the read-back, so
      it is self-consistent regardless of wall-clock date. The ACTUAL previously
      calendar-dependent test ("a hash-chained audit log survives restart and still verifies")
      was already fixed by earlier TEST-13 work — an inline comment credits it explicitly:
      `// TEST-13 — record stamped these five from the app clock, so the partition is the month
      of the write, not the literal 202607 this used to assert against.`, followed by
      `nowIso().slice(0, 7).replace('-', '')`.
- [x] **Cause, not symptom** — no code change needed; verified-and-closed, not re-fixed
      (matching the DOC-14 precedent for a finding an earlier, unrelated fix already resolved).
- [x] **Regression test** — n/a (verify-and-close; the governing regression coverage is
      TEST-13's own fix, already in place).
- [x] **Failure is loud** — n/a.
- [x] **Evidence in the status line** — `grep -n "202607" ccp/api/test/fileStore.test.ts`
      shows the one remaining literal is self-consistent (same key object write/read-back);
      `cd ccp/api && npx vitest run test/fileStore.test.ts` (8 passed).

## ARCH-13

*Project-id grammar duplicated inline despite a declared single home.*

- [x] **Defect reproduced first** — confirmed 5 verbatim copies of `/^[a-z][a-z0-9-]{1,31}$/`
      had drifted into existence: the api's `projects.ts`, `routes/drift.ts`,
      `routes/projectData.ts`, `domain/drift.ts`, and the app's `projectOnboarding.ts` — any
      future grammar change would need all 5 edited in lockstep or path-validation and
      registration would silently disagree.
- [x] **Cause, not symptom** — new `ccp/app/src/lib/projectId.ts` is the ONE home. It lives in
      `@/lib` (not `ccp/api/src/`) because that is the one direction shared code can flow: the
      api reaches into `ccp/app/src/lib/` via the `@app-lib/*` tsconfig path alias (the same
      mechanism `@app-lib/redact` already uses) — a plain api-local constant could never be the
      actual single source of truth, since the app can never import the other way. The api's
      `projects.ts` re-exports `PROJECT_ID_RE` from it so its own existing internal importers
      keep working unchanged; `routes/drift.ts`, `routes/projectData.ts`, `domain/drift.ts`, and
      the app's `projectOnboarding.ts` all now import it instead of redeclaring.
- [x] **Regression test** — new `ccp/api/test/projectIdGrammar.test.ts`: a reference-equality
      assertion (`toBe`, not a string/`.source` comparison — a string comparison would pass even
      for two independently-declared-but-textually-identical regexes, exactly the shape the
      original defect had) that the api's re-export IS the app-lib constant, a sanity check of
      valid/invalid ids, and a structural source-scan test asserting the literal pattern string
      appears ZERO times anywhere else in `ccp/api/src/**/*.ts` (mirrors `openapi.test.ts`'s
      DOC-13 dedup-scan convention). **Negative test confirmed**: reverted `routes/drift.ts`'s
      dedup (re-added its local declaration) — the structural scan test failed, correctly
      naming `routes/drift.ts` as the offender; restored, re-verified green.
- [x] **Failure is loud** — the structural scan names the exact offending file path if the
      pattern is ever re-duplicated.
- [x] **Evidence in the status line** — full `ccp/api` suite (101 files, 1415 tests) and full
      `ccp/app` suite (160 files, 2823 tests) both clean, with `tsc --noEmit` clean on both
      packages, after ARCH-13 + ARCH-16 combined.

## ARCH-16

*Vestigial code and stale references.*

- [x] **Defect reproduced first** — re-derived each named sub-item at HEAD (L-29): (1)
      `requestableServices` (`permissions.ts`) had zero production consumers (only its own
      test) — explicitly named in the finding as "deferred by ADR-0022 action item 4 to a
      simplify pass that has not happened"; (2) `terraformExecutor.ts`'s
      "SANCTIONED-SPAWN EXCEPTION" doc and its `REAL_ESTATE_ROOT_SEGMENTS` constant's doc
      falsely claimed to "identify this repo's REAL/live estate roots" — none of
      `environments/prod`, `importer/prod`, `importer/bootstrap` exist anywhere in this repo
      (verified via `find`); the deny itself is harmless (a nonexistent path can never
      accidentally match) but the claim about what the paths ARE was false; (3) `errors.ts`'s
      header, also cited by the finding, was ALREADY fixed by an earlier DOC-4 pass — it now
      correctly cites `ccp-api.yaml` and documents its own prior wrongness, so no action needed.
- [x] **Cause, not symptom** — removed `requestableServices` outright (function + its dedicated
      test block) since the finding's own language sanctions removal, not just documentation;
      corrected `terraformExecutor.ts`'s two false claims to honestly say these are the estate
      roots of the pre-split private monorepo this codebase was carved out of, not this repo's
      own roots. Deliberately left `autoEligible` (a retired manifest field with its own
      dedicated `autoEligible.test.ts` proving "no-runtime-read") and the two `CommitInput.audit`
      istanbul-ignore declarations untouched — both already adequately documented/tested, not
      actionable defects.
- [x] **Regression test** — `permissions.test.ts`'s `requestableServices` describe block (2
      tests) removed along with the function; no new test needed for the doc-only
      `terraformExecutor.ts` correction (it changes no runtime behavior).
- [x] **Failure is loud** — n/a for the doc correction; the removed dead code's absence is
      itself verified by the full app suite passing with zero references to it (`grep` confirms
      zero production consumers before removal).
- [x] **Evidence in the status line** — full `ccp/app` suite (160 files, 2823 tests — down 2
      from 2825 due to the removed dead-code test) clean, `tsc --noEmit` clean, after ARCH-13 +
      ARCH-16 combined.

## IMP-5

*kit-azure `discover.sh` never clears stale page files: a re-run can resurrect deleted resources into the manifest.*

- [x] **Defect reproduced first** — confirmed `discover.sh`'s paging loop never removed a prior
      run's `<capture>.page*.json`/`<capture>.json` before capturing (cleanup only happened on
      capture FAILURE); a re-run producing FEWER pages than a prior run (the documented
      PARTIAL_CAPTURE recovery path "fix RBAC/scope and re-run", or the estate shrinking across
      a 1000-row page boundary) left the stale higher-numbered pages in place, and
      `merge_pages` (`discover.py`) merged them as if current — a deleted resource reappearing
      as live in the manifest. `merge_pages` also merged a single-file `<capture>.json` AND
      `<capture>.page*.json` together unconditionally whenever both existed, double-counting a
      mixed fixture/live directory.
- [x] **Cause, not symptom** — `discover.sh` now does
      `rm -f "$OUT/$capture".page*.json "$OUT/$capture.json"` at the TOP of each capture's
      paging loop, before writing anything — the AWS kit needed no equivalent fix (single file
      per capture, overwritten each run, per the finding's own note). `merge_pages` now refuses
      `BAD_CAPTURE` if BOTH a single-file and paged form exist for the same capture, rather than
      silently merging both.
- [x] **Regression test** — new `test_rerun_clears_stale_pages_from_a_prior_larger_capture`
      (`test_scripts.py`): pre-places a stale `resources.page5.json` (a phantom
      `phantom-deleted-vnet` resource) AND a stale `resources.json` in `--out` before running
      `discover.sh` live; asserts both are gone afterward and the phantom resource is absent
      from the manifest. New `test_mixed_single_file_and_paged_forms_refuses`
      (`test_discover.py`): a copy of the `PAGED` fixture plus a hand-added `resources.json`
      refuses `BAD_CAPTURE` naming "ambiguous". **Negative test confirmed**: reverted both the
      `rm -f` line and the `merge_pages` ambiguity check — both new tests failed exactly as
      expected (the stale page survived; the mixed-forms case returned 0 instead of refusing);
      restored, re-verified green.
- [x] **Failure is loud** — the shell test asserts the phantom resource's NAME is absent from
      the manifest (not just "resources changed"), and the python test asserts the exact refusal
      code and the word "ambiguous".
- [x] **Evidence in the status line** — full `importer/kit-azure` suite (57 tests, up from 55)
      clean.

## IMP-9

*Azure `discover.py list-subscriptions` crashes on a bare-list capture at the truncation-warning check.*

- [x] **Defect reproduced first** — confirmed `cmd_list_subscriptions` accepts either an ARG
      envelope dict or a bare list (`data = doc if isinstance(doc, list) else (doc.get("data")
      or [])`), but the page-truncation warning then called `doc.get("skip_token")`
      unconditionally — an unhandled `AttributeError` (exit 1, not the documented
      REFUSE/exit-2 contract) when `doc` is a bare list of ≥1000 rows, exactly the large-tenant
      case the warning exists to catch. The sibling `cmd_next_token` already guards this
      correctly.
- [x] **Cause, not symptom** — added `isinstance(doc, dict) and` to the truncation-warning
      condition, mirroring `cmd_next_token`'s existing correct guard.
- [x] **Regression test** — new
      `test_bare_list_capture_at_the_1000_row_page_does_not_crash` (`test_discover.py`): a bare
      JSON list of 1000 dict rows (no envelope wrapper) via `list-subscriptions --capture`;
      asserts exit 0, no "AttributeError" in stderr, and the count line shows 1000.
      **Negative test confirmed**: reverted the `isinstance(doc, dict) and` clause — the new
      test failed with the exact expected traceback ending
      `AttributeError: 'list' object has no attribute 'get'`; restored, re-verified green
      (3/3 in the `ListSubscriptions` class).
- [x] **Failure is loud** — the test explicitly asserts "AttributeError" is ABSENT from stderr,
      not just a nonzero-exit check, so a regression to the raw traceback is caught precisely.
- [x] **Evidence in the status line** — full `importer/kit-azure` suite (57 tests) clean.

## IMP-10

*`gen-imports.py --id-region-suffix` appends `@region` to global-service ids too.*

- [x] **Defect reproduced first** — confirmed the `@<region>` suffix was applied to EVERY
      non-ARN id, including region-less types the same manifest carries: IAM user/group/
      role/instance-profile names, S3 bucket names, KMS aliases (IAM `policy`'s id is already an
      ARN so was already unaffected). Verified directly against the `HAPPY` fixture:
      `aws_iam_role.app_runtime` got `app-runtime@ap-southeast-1`, `aws_s3_bucket` and
      `aws_kms_alias` likewise — `terraform plan` rejects an id shaped like that for these
      types.
- [x] **Cause, not symptom** — `services.json` gains an optional `regional` flag (default true;
      `false` for `aws_iam_user`/`aws_iam_group`/`aws_iam_role`/`aws_iam_policy`/
      `aws_iam_instance_profile`/`aws_s3_bucket`/`aws_kms_alias` — `aws_kms_key`'s raw
      `TargetKeyId` is left regional, since only the alias id shape is named as unsuffixable by
      the finding). `gen-imports.py` gains `--services` (default `kit/services.json`) and skips
      the suffix for `regional: false` types; it also now refuses `REGION_SUFFIX_UNUSED` if
      `--id-region-suffix` would apply to zero selected rows (very likely operator error).
- [x] **Regression test** — `test_region_suffix_skips_region_less_types` asserts the IAM role/
      S3 bucket/KMS alias ids are UNSUFFIXED while the KMS key still gets the suffix;
      `test_region_suffix_unused_refuses` trims the manifest to only region-less types and
      asserts `REFUSE REGION_SUFFIX_UNUSED`. **Negative test confirmed**: reverted the
      `and row["type"] not in global_types` clause — both new tests failed exactly as expected;
      restored, re-verified green (11/11 in `test_gen_imports.py`).
- [x] **Failure is loud** — the refusal names exactly how many rows were selected and that all
      are ARNs/region-less, not a silent no-op.
- [x] **Evidence in the status line** — full `importer/kit` suite (115 tests) clean.

## IMP-11

*`payloads.py` block scanner: a column-0 `}` inside a heredoc body truncates the skeleton and ships it.*

- [x] **Defect reproduced first** — reproduced directly: a resource block containing a
      `<<-EOT` heredoc whose BODY has a line that is exactly `}` at column 0 (e.g. embedded
      JSON a captured `user_data` script emits) ended the block right there under the unfixed
      scanner — confirmed via a direct `split_generated()` call that the returned skeleton was
      truncated mid-heredoc, missing the terminator and the real closing brace, while a clean
      neighboring resource was NOT poisoned (matching the finding's own "not corruption, but
      the scanner's promise is violated" framing).
- [x] **Cause, not symptom** — `split_generated` now tracks heredoc open/close markers
      (`HEREDOC_OPEN_RE`) and suspends `"}"`/new-header detection until the matching terminator
      line closes it — a plain `<<EOT` requires the label at column 0; `<<-EOT`/`<<~EOT` allow
      it indented (terraform fmt's own convention, stripped before compare). A heredoc still
      open at EOF/next-header falls through to the pre-existing "unterminated" ambiguity —
      withheld, never guessed.
- [x] **Regression test** — new
      `test_heredoc_body_column_zero_closing_brace_does_not_truncate_the_block`
      (`test_payloads.py`): an inline generated.tf with a heredoc body containing an embedded
      JSON object (whose closing `}` sits at column 0) followed by a clean neighbor; asserts
      the full body (including the embedded `}` and the heredoc's own terminator) survives
      verbatim, the block isn't merged with its neighbor, and the neighbor is unaffected.
      **Negative test confirmed**: reverted the heredoc-tracking logic — the test failed,
      showing the skeleton truncated right after the embedded JSON's `}`; restored,
      re-verified green (20/20 in `test_payloads.py`).
- [x] **Failure is loud** — the test asserts the block's REAL closing brace sequence
      (`JSON\n  EOT\n}\n`) is present, not just "some closing brace" — a regression that
      truncates at the decoy would fail this specific assertion.
- [x] **Evidence in the status line** — full `importer/kit` suite (115 tests) clean.

## IMP-12

*`normalize.py split` silently drops non-`resource` top-level blocks.*

- [x] **Defect reproduced first** — confirmed `cmd_split` (both `importer/kit/normalize.py` and
      the identical `importer/kit-azure/normalize.py`) only ever copied `resource` block
      extents anywhere; `data`, `moved`, `import`, `locals`, `terraform` blocks (and free-
      standing comments) in the input were dropped with no warning.
- [x] **Cause, not symptom** — new `parse_non_resource_blocks()` (shared `_load_hcl()` helper
      factored out of `parse_resources()`) extracts `data`/`moved`/`import`/`locals`/`terraform`
      block extents — deliberately just this set (the ones the finding names, and the only ones
      `-generate-config-out`/aztfexport `--hcl-only` output plausibly carries), not a general
      HCL linter. `cmd_split` now collects them into `unclassified.tf`'s own clearly-marked
      section (verbatim, with their leading comments) and WARNS loudly with the kinds/count
      found — never silently dropped. Free-standing top-of-file boilerplate comments remain a
      known, accepted, low-risk gap (comments have no plan semantics) — deliberately scoped
      down from the recommendation's literal line-diffing suggestion to avoid noisy false
      positives on the ubiquitous 2-line `-generate-config-out` header every real run carries.
- [x] **Regression test** — new
      `test_non_resource_top_level_blocks_are_preserved_not_dropped` (both kits' `test_normalize.py`):
      appends `terraform`/`locals`/`moved`/`data` blocks to the fixture, asserts each kind is
      named in the WARN, each block's content survives verbatim in `unclassified.tf`, and the
      real `resource` blocks in service files are unaffected. New
      `test_rerun_with_foreign_blocks_is_still_byte_identical` confirms idempotency AND that the
      content is genuinely present (not just absent-both-times). **Negative test confirmed**:
      reverted the collection logic in both kits — all 4 new tests (2 per kit) failed exactly as
      expected; restored, re-verified green (17/17 in kit's `test_normalize.py`, 8/8 in
      kit-azure's).
- [x] **Failure is loud** — the WARN names every kind found and the total count; the test
      asserts each kind's literal content, not just "something was added".
- [x] **Evidence in the status line** — full `importer/kit` suite (115 tests) and full
      `importer/kit-azure` suite (55 tests, before IMP-5's own additions) both clean.

## IMP-13

*Shell scripts: minor robustness gaps around the deliberate no-`set -e` style.*

- [x] **Defect reproduced first** — reproduced each of the 4 named sub-gaps directly: (a) a
      failed `mkdir -p "$OUT"`/plan-write/`capture-meta.json` write in both kits' `discover.sh`
      proceeded silently, surfacing later as a confusing `BAD_CAPTURE`/`ACCOUNT_MISMATCH` out of
      `discover.py build` — reproduced via a pre-existing-directory-as-a-file trick (mkdir
      fails) and a pre-existing-directory-in-place-of-the-meta-file trick (the `cat >` write
      fails); (b) an unvalidated `--region`/`--location` containing a `"` corrupted
      `capture-meta.json`'s JSON — reproduced with `--region 'ap-southeast-5"'`, which produced
      the EXACT downstream symptom the finding describes: `REFUSE BAD_CAPTURE: unreadable
      capture-meta.json: Expecting ',' delimiter`; (c) `verify.sh`'s steady-phase message called
      BOTH a plan error (`-detailed-exitcode` exit 1) and real drift (exit 2) "not a no-op",
      conflating a plan FAILURE with actual drift; (d) kit-azure's `next-token` call swallowed
      its own REFUSE via `2>/dev/null` with the exit code never checked — reproduced with a
      corrupt page-0 capture: paging silently "succeeded" as if the corrupt page were the last
      one, only for `discover.py build` to catch the corruption independently and later, exactly
      matching the finding's "relies on build to refuse later, but the stderr evidence is
      discarded" description.
- [x] **Cause, not symptom** — (a) `mkdir -p`/the plan-write/the `capture-meta.json` heredoc
      write in both kits' `discover.sh` now `REFUSE IO_ERROR` on failure instead of proceeding;
      (b) both `discover.sh`s validate `--region`/`--location` against
      `*[!a-z0-9-]*` (real AWS regions/ARM locations are lowercase letters/digits/hyphens only)
      before any capture begins; (c) `verify.sh` (both kits) distinguishes exit 1 ("plan
      ERRORED... this is a plan failure, not drift") from exit 2/other ("not a no-op... triage
      per drift-detection.md"); (d) kit-azure's `next-token` call now captures stderr into the
      same `$capture.stderr` file the `az graph query` failure path already uses and checks its
      exit code, treating a REFUSE there as this capture's own FAILED entry.
- [x] **Regression test** — 5 new tests (AWS kit): `test_region_with_a_quote_refuses_before_any_capture`,
      `test_mkdir_failure_refuses_loudly`, `test_meta_write_failure_refuses_loudly_not_a_confusing_downstream_error`,
      `test_steady_phase_distinguishes_plan_error_from_real_drift`. 5 mirrored tests (Azure
      kit) plus `test_location_with_a_quote_refuses_before_any_capture` and
      `test_corrupt_page_makes_next_token_fail_loudly_not_silently_stop_paging` (asserts
      `REFUSE PARTIAL_CAPTURE` + "next-token could not read" instead of the old silent
      early-stop). **Negative test confirmed** for every one of the 10 new tests individually:
      each reverted fix produced the exact expected failure (including, for the region-quote
      case, literally reproducing the finding's own cited downstream symptom); all restored,
      re-verified green.
- [x] **Failure is loud** — every new REFUSE/FAIL message names the specific file or flag at
      fault, not a generic "something went wrong".
- [x] **Evidence in the status line** — full `importer/kit` suite (115 tests, up from 108) and
      full `importer/kit-azure` suite (55 tests, up from 50 before IMP-5's own additions) both
      clean.

## OPS-10

*No log rotation and no resource limits on any service.*

- [x] **Defect reproduced first** — grep-verified `docker-compose.yml` had no `logging:`,
      `mem_limit`, `cpus`, or `deploy:` anywhere: every service relied on Docker's default
      `json-file` driver with no `max-size`/`max-file` (the runner in particular relays entire
      CI job logs), and no service had a memory ceiling.
- [x] **Cause, not symptom** — new shared `x-logging` anchor (`json-file`, `max-size: "10m"`,
      `max-file: "5"`) applied via `logging: *default-logging` to all 5 services. `api` and
      `runner` (the two named in the finding's own recommendation) gain
      `mem_limit: ${CCP_API_MEM_LIMIT:-1g}` / `${CCP_RUNNER_MEM_LIMIT:-4g}` — deliberately
      `mem_limit`/`cpus` (compose's plain, non-swarm keys), NOT a `deploy.resources.limits`
      block, since `deploy:` is silently ignored by plain `docker compose up` outside swarm
      mode. Both new env vars documented in `.env.example`.
- [x] **Regression test** — new `compose-logging-and-limits.test.sh`: source-text checks that
      the `x-logging` anchor defines both options and every service references it, that `api`/
      `runner` carry `mem_limit`; best-effort real-interpolation check via
      `docker compose config` (mirroring `docker-build.yml`'s own CI check) confirming both
      survive real env-var resolution. **Negative test confirmed**: reverted `docker-compose.yml`
      to its committed (pre-fix) state via `git checkout` — 9 of the 10 assertions failed
      exactly as expected; restored, re-verified all 10 pass.
- [x] **Failure is loud** — each assertion names the specific service/field missing, not a
      generic "compose file wrong".
- [x] **Evidence in the status line** — `docker compose --profile scanner --profile runner
      --profile toolbox config` (mirroring CI's own placeholder env vars) resolves clean;
      `bash ccp/scripts/test/compose-logging-and-limits.test.sh` (10/10 passed).

## OPS-13

*`doctor.sh` reports an unhealthy container as OK.*

- [x] **Defect reproduced first** — confirmed the container-status classifier used
      `case "$line" in *Up*)` — Docker reports an unhealthy container as `Up X minutes
      (unhealthy)`, which still matches `*Up*` and printed a green checkmark; the aggregate
      FAIL flag (`grep -qv Up`, "any line NOT containing Up") did not trip either, since an
      unhealthy line DOES contain "Up" — both the per-line display AND the overall exit code
      missed it.
- [x] **Cause, not symptom** — the case statement now checks `*'(unhealthy)'*|*Restarting*`
      BEFORE the bare `*Up*)` pattern; the aggregate FAIL check gains a second
      `grep -Eq '\(unhealthy\)|Restarting'`, since the per-line loop runs in a pipe subshell and
      any `FAIL=1` set inside it would not survive back to the parent shell (the same reason the
      original code never called the `bad()` helper inside that loop either).
- [x] **Regression test** — new `doctor-unhealthy-detection.test.sh`: runs the real `doctor.sh`
      against a stubbed `docker`/`curl` reporting one healthy + one `(unhealthy)` container;
      asserts the unhealthy line gets the FAIL marker, the healthy line still gets OK, and
      `doctor.sh` exits 1; a baseline all-healthy run asserts zero FAIL container lines (proving
      the fix isn't just "always fail"). **Negative test confirmed**: reverted the case-
      statement reordering and the second aggregate grep — the fail-marker and exit-code
      assertions failed exactly as expected (the other two, testing the healthy line and the
      baseline, correctly still passed); restored, re-verified all 4 pass.
- [x] **Failure is loud** — the test isolates `curl`/api-reachability noise via stubs
      specifically so the exit-code assertion is attributable to ONLY the container check, not
      confounded by an unrelated real-curl failure.
- [x] **Evidence in the status line** — `bash ccp/scripts/test/doctor-unhealthy-detection.test.sh`
      (4/4 passed).

## OPS-15

*GitHub App key directory is not prepared or checked by any tooling.*

- [x] **Defect reproduced first** — confirmed `setup.sh data`'s layout list omitted
      `/data/ccp/forge` (the api's `${CCP_GITHUB_APP_KEY_HOST_DIR:-/data/ccp/forge}` read-only
      bind mount target) entirely — dockerd auto-creates it root:root on first `up` instead —
      and neither `setup.sh` nor `doctor.sh` verified the configured key file exists or is
      readable by uid 1000 (the api container's user); a root-owned 0600 PEM dropped in by an
      operator would fail only at claim time, per scan job, with no diagnostic surfacing why.
- [x] **Cause, not symptom** — `setup.sh data`'s layout gains
      `ensure_owned /data/ccp/forge 1000 1000 700 "GitHub App key dir"`, matching the existing
      `store`/`scratch` uid-1000 pattern. `doctor.sh` gains a check: `CCP_GITHUB_APP_KEY_FILE`
      is a CONTAINER path (`readFileSync`'d inside the api per `forgeCredentials.ts`), so it is
      resolved to its HOST path via `CCP_GITHUB_APP_KEY_HOST_DIR` (same basename, since both
      always resolve under the compose bind's `/run/secrets/forge` mountpoint) and checked:
      missing → FAIL naming the resolved host path; present but owned by neither uid 1000 nor
      world-readable → FAIL naming uid 1000 as the fix; otherwise OK. Opt-in: no
      `CCP_GITHUB_APP_KEY_FILE` set → no line at all.
- [x] **Regression test** — new `setup-forge-layout.test.sh`: runs the real `setup.sh data`
      against a real (disposable, root-required, cleaned up via `trap`) `/data`, asserts
      `/data/ccp/forge` is created `1000:1000 700` and a re-run is a no-op. New
      `doctor-forge-key-readable.test.sh`: a root-owned 0600 key FAILs naming uid 1000; a
      uid-1000-owned key is OK; a missing host file FAILs naming the resolved path; no
      `CCP_GITHUB_APP_KEY_FILE` set produces no line at all. **Negative test confirmed** for
      both: reverting the `setup.sh` layout addition failed both of that test's assertions;
      reverting the `doctor.sh` check block failed 3 of 5 assertions in that test (the other 2
      — exit-code and opt-in — passed incidentally for unrelated reasons in that sandboxed run,
      but the direct content assertions proved the feature's absence conclusively); both
      restored, re-verified all pass (4/4 and 5/5 respectively).
- [x] **Failure is loud** — the doctor.sh check names the exact resolved host path and uid
      1000 as the specific fix, not a generic "key unreadable".
- [x] **Evidence in the status line** — `bash ccp/scripts/test/setup-forge-layout.test.sh`
      (4/4 passed); `bash ccp/scripts/test/doctor-forge-key-readable.test.sh` (5/5 passed).

## ERR-7

*Unexpected errors become `{code:'INTERNAL'}` 500 with zero server-side logging.*

**Verified closed by OPS-2. No code changed here.** B-S1's own instruction: "Confirm every
500 path logs, then close — or fix only the paths that do not."

- [x] **Confirmed against the exact claim, not by reading the fix** (**L-29**) —
      `registerErrorHandler` (`errors.ts`) calls `logServerError(err, { method, path })` for
      every non-`ApiError` exception, immediately before returning the `{code:"INTERNAL"}` 500 —
      `log.ts`'s `formatServerError` captures the message, the full stack (or name+message for a
      non-Error throw), and method+path, all passed through `redactSecrets` (never the body,
      query string, headers, or cookies — those carry credentials by construction).
- [x] **"Every 500 path logs" verified structurally, not just spot-checked** —
      `grep -rn ", 500)" src/` (excluding tests and `errors.ts` itself) returns nothing, and a
      broader `grep -rn "500"` sweep of the same tree turns up only unrelated `.max(500)` zod
      field-length limits and byte constants — `registerErrorHandler`'s `app.onError` is
      structurally the ONLY place an HTTP 500 is ever produced anywhere in `ccp/api/src`, so
      "every 500 path logs" is trivially and completely satisfied by this one call site.
- [x] **Regression test** — n/a here; the governing coverage is OPS-2's own
      `test/serverErrorLogging.test.ts` (11 tests), already in place and re-run clean.
- [x] **Failure is loud** — n/a (verify-and-close).
- [x] **Evidence in the status line** — `grep -rn ", 500)" src/ | grep -v test` (empty);
      `cd ccp/api && npx vitest run test/serverErrorLogging.test.ts` (11 passed).

## OPS-11

*`/readyz` re-verifies every audit chain on every probe; cost grows unboundedly with history.*

**Verified closed by PERF-4. No code changed here.** B-S1's own instruction: "Confirm, then
close. NOTE R-34: the memo is deliberately NOT a tamper-detector, and that stays true."

- [x] **Confirmed against the exact claim, not by reading the fix** (**L-29**) —
      `readiness.ts` calls `verifyProjectChain` (`auditQuery.ts`), not `exportAuditChain` — its
      own doc comment explains the swap ("the probe needs a verdict, not the evidence document").
      `verifyProjectChain` memoizes a verified `(count, hash)` prefix per project per store; a
      probe at an unchanged or grown count only reads the tail added since the last verified
      count (re-anchoring the last verified entry by RE-HASHING it from content, not trusting its
      stored `hash` field — an edit that rewrites content while leaving the hash field alone
      would otherwise walk straight past the memo) instead of the whole chain.
- [x] **R-34's caveat re-confirmed, not just asserted** — the memo path is deliberately not a
      tamper-detector for already-verified history: `test/auditPaging.test.ts`'s
      "documents its limit: a rewritten PREFIX is caught by the export, not by the memo" test
      tampers with an entry BEFORE the memoized anchor (stored hash untouched) and shows the fast
      probe still reports `verified: true`, while `exportAuditChain` (the full evidence surface)
      and a fresh-process probe (no memo yet) both correctly report `verified: false`. This is
      exactly R-34's documented trade-off, still true today.
- [x] **Regression test** — n/a here; the governing coverage is PERF-4's own
      `test/auditPaging.test.ts` "verifyProjectChain — incremental verification" suite (8 tests),
      already in place and re-run clean.
- [x] **Failure is loud** — n/a (verify-and-close).
- [x] **Evidence in the status line** — `cd ccp/api && npx vitest run test/auditPaging.test.ts
      test/readyz.test.ts` (11 passed).

## DATA-6

*`rename` durability is not guaranteed: no directory fsync after the atomic swap.*

**Verified partially closed by ERR-10; extended to close the remainder.** B-S1's instruction:
"Confirm it covers every atomic-write site (`store/snapshot.ts` too), then close or extend."

- [x] **Defect reproduced first** — confirmed at HEAD (L-29) that `fileStore.ts`'s
      `writeAtomic` already calls `syncDir(dir)` after `rename` (ERR-10), but `snapshot.ts`'s
      `writeFileAtomic` did NOT — grep-verified `rename`/`fsync` in `snapshot.ts` showed the
      rename with no directory sync at all. The finding's own recommendation additionally names 3
      more disk writers ("the same cheap hardening applies"): `domain/projectData.ts`'s
      `writeProjectDataVersion`, `domain/drift.ts`'s `writeDriftReport`, and
      `domain/driftProposals.ts`'s `writeDriftProposalBody` — all 3 confirmed to `writeFile` +
      `rename` with zero fsync of any kind, file or directory.
- [x] **Cause, not symptom** — added the identical `syncDir` pattern (best-effort — some
      filesystems refuse a directory open-for-sync, and failing an already-landed write over that
      would be worse than the narrow window it closes) to all 4 remaining sites, called after
      each's `rename` succeeds. `snapshot.ts`'s copy is deliberately duplicated, not imported
      from `fileStore.ts` — its own doc comment already establishes it stays standalone so the
      backup/restore scripts never touch the durable store's code path; the same reasoning
      applies to the 3 domain writers, none of which import from each other today.
- [x] **Regression test** — directly testing "did fsync fire" is not observable without
      fs-mocking infrastructure this suite doesn't have (the ORIGINAL `fileStore.ts` ERR-10 fix
      has no such test either, for the same reason) — `syncDir` is a self-contained,
      error-swallowing addition appended strictly after each function's pre-existing success
      path, so it cannot regress observable behavior by construction, and the FULL existing
      `ccp/api` suite (which already exercises every one of these 4 write paths end-to-end
      through their public callers) re-ran clean with zero new failures. `snapshot.ts`'s own new
      `test/snapshotWriteAtomic.test.ts` covers its happy path directly (byte-identical read-back,
      no leftover tmp file).
- [x] **Failure is loud** — n/a for a best-effort durability nicety with no caller-visible
      contract change.
- [x] **Evidence in the status line** — `cd ccp/api && npx tsc --noEmit` clean; full suite
      `npx vitest run` (102 files, 1421 passed, up from 1415 before DATA-6+DATA-13 combined).

## DATA-13

*Failed atomic writes leak temp files in the store path.*

**Verified partially closed by ERR-10; extended to close the remainder.** B-S1's instruction:
"VERIFY, THEN EXTEND. Check the OTHER atomic-write sites for the same shape and fix any that
leak."

- [x] **Defect reproduced first** — confirmed at HEAD (L-29) that `fileStore.ts`'s
      `writeAtomic` already wraps its write+rename in a try/catch that removes the temp file on
      any failure (ERR-10), but `snapshot.ts`'s `writeFileAtomic` had NO such cleanup — a failing
      `writeFile`/`sync`/`rename` left the temp file behind, exactly as the finding describes.
      The finding's own text confirms `drift.ts`/`driftProposals.ts`/`projectData.ts` already
      clean up on failure — verified true, unaffected. The finding's SECOND recommendation ("sweep
      stale `<file>.tmp-*` on `FileStore.open`") was not implemented anywhere: no startup sweep
      existed, so a temp file orphaned by a `kill -9` mid-write (a case no catch/finally can ever
      run for, since the process dies before it) would persist forever, and under sustained
      ENOSPC each failed attempt strands another partial multi-MB snapshot.
- [x] **Cause, not symptom** — `snapshot.ts`'s `writeFileAtomic` gains the identical
      try/catch cleanup `fileStore.ts` already has. `FileStore.open` gains `sweepStaleTmp(file)`,
      called before `load()`: best-effort, removes every `<file>.tmp-*` in the data directory,
      never throws (an unreadable/absent directory is not this function's job to fail boot over —
      `load()` validates the store's own file separately).
- [x] **Regression test** — new `test/snapshotWriteAtomic.test.ts`: forces the rename step
      specifically to fail (a file cannot be renamed onto an existing NON-EMPTY directory —
      ENOTEMPTY/EISDIR, platform-independent — with `tmp` already fully written, exactly the
      failure shape the finding describes) and asserts no `.tmp-*` file survives. New tests in
      `test/fileStore.test.ts`: a stale tmp file written before `FileStore.open()` (simulating a
      killed prior process) is gone afterward; multiple stale tmp files don't block a normal
      open+write+restart cycle; a missing data directory (fresh install) sweeps as a clean no-op,
      not a boot failure. **Negative test confirmed** for both: reverting `snapshot.ts`'s cleanup
      failed the new rename-failure test exactly as expected; reverting the `sweepStaleTmp` call
      in `FileStore.open` failed the "removes a leftover tmp file" test exactly as expected (the
      other 2 fileStore.ts tests, not sensitive to that specific removal, correctly still passed);
      both restored, re-verified all green.
- [x] **Failure is loud** — each test's failure message names exactly which stale file(s)
      leaked, not just "test failed".
- [x] **Evidence in the status line** — `cd ccp/api && npx vitest run test/fileStore.test.ts
      test/snapshotWriteAtomic.test.ts` (14 passed); full suite `npx vitest run` (102 files, 1421
      passed); `npx tsc --noEmit` clean.

## API-9

*Project deregistration leaves orphaned satellite rows; a reused id inherits the previous
tenant's state.*

- [x] **Defect reproduced first.** Deregistration deleted three hardcoded SK prefixes
      (`UPLOADTOKEN#`, `ONBOARDTOKEN#`, `DATA#v`) while the `PROJECT#<id>` partition had grown
      four more the cleanup never heard of: `FORGECRED`, `SCANJOB#`, `DRIFT#v…`/`DRIFT#latest`,
      `DRIFTPROP#`. Registration checked only the `META` row, so an id whose `META` was gone but
      whose satellites were not read as free.
- [x] **This is a cross-tenant leak, not untidiness.** The scan-claim lane opens whatever
      `FORGECRED` it finds under the acting project's partition — the next tenant to take a
      reused id cloned their repository with the PREVIOUS operator's forge credential.
- [x] **Fixed as two rules, not a longer prefix list (L-25).** (1) Deregistration deletes
      whatever it FINDS under `PROJECT#<id>` — the whole partition, not an enumerated set — so a
      satellite row kind added tomorrow is swept for free. (2) `POST /projects` may only claim an
      id whose partition is EMPTY.
- [x] **A sweep alone cannot make id reuse safe.** Project-scoped partitions
      (`P#<id>#REQ…`/`#AUDIT…`/`#TEAM…`/`#POLICY`) are not under `PROJECT#<id>` and cannot be
      enumerated through the store seam at all, and the audit chain must survive as evidence
      regardless. The sweep writes a `RETIRED` tombstone LAST, so the id is retired rather than
      recycled — rule (2) then enforces that for free, including against any row kind this build
      has never heard of.
- [x] **Regression test — `test/projectDeregisterSweep.test.ts` (new).**
- [x] **Negative test confirmed.** Fix reverted, satellites seeded from the real key functions:
      5 rows survive the ack (`['DRIFT#latest', …(5)]` where the rule expects `['RETIRED']`), and
      re-registering the deregistered id returns 201 instead of 409.

## FE-9

*apiSession role resolution falls back to another scope's role when the user has no binding on
the active project.*

- [x] **Defect reproduced first.** `role: (binding?.role ?? a.role)` fired whenever the
      per-project binding was missing — including when the `roles` map existed but simply had no
      entry for the ACTIVE project — so switching to a project the user holds no role on resolved
      whatever role the LOGIN scope happened to carry. An authz fail-OPEN: a requester with a
      `lead` binding on one project could act as `lead` on a project they are not bound to at all.
- [x] **The rule, stated once it is being read correctly.** A `roles` map, once present, is the
      ONLY authority — the server-resolved scalar is read only when there is no map at all (the
      legacy backend the fallback was originally written for). No binding on the active project
      resolves to the FLOOR (requester, no team), which the existing downstream helpers already
      read as deny.
- [x] **Not a new fourth role.** Adding one to `Role` would make every existing switch/lookup
      table over roles silently incomplete — the exact fail-open shape this finding is about, one
      level down.
- [x] **Regression test — `test/multiAccountSession.test.ts` (extended, +83 lines).**
- [x] **Negative test confirmed.** Fix reverted: `canApprove` returns `true` for a user with no
      binding on the active project, and the resolved role is the login scope's `'lead'`.

## DATA-11

*v1 migration writes rows that violate the store schemas, including an `id`≠`username` shape
that breaks session resolution.*

- [x] **Defect reproduced first, and it was three consequences of one shape.** The import
      validated the v1 DOCUMENT against v1 shapes, then built store rows by CAST — nothing checked
      what actually landed. `V1Policy` was unbounded `z.number()` while `PolicyItem` requires
      integers 1..5, so `high: 0` or `deleteMin: 7.5` landed verbatim and drove the
      `approvalsRequired` math out of contract. `V1Account.username` had no character
      constraints, unlike enrolment's `^[a-z0-9._-]{2,32}$`, so arbitrary bytes reached
      `accountKey()` and became a partition key. And the row was KEYED by username while keeping
      the v1 document's own `id` — login finds an account by username and mints a session
      carrying `userId = account.id`, and every later request resolves that through
      `accountKey(userId)`. A row where the two disagree can authenticate and can never hold a
      session, and no admin verb repairs it.
- [x] **Fixed as a rule, not three field patches (L-25).** Every constructed row is parsed
      through the STORE SCHEMA that governs it before anything is written; the whole document is
      refused if any row fails. Covers two row kinds nobody reported (teams, risk overrides) and
      enforces a store-schema constraint added tomorrow the day it is added. Validate-then-write,
      no partial import — the import is not transactional (it spans the audit chain) and a
      half-imported estate is not a state anyone can reason about.
- [x] **The finding's recommendation is taken, and the alternative half is rejected in writing.**
      "Normalize/enforce id = username (or reject mismatches loudly)" — rejecting is the right
      half and the fix takes it: every v1 export this product ever produced has `id === username`,
      so a document where they differ is corrupt or hostile, and silently rewriting an identity
      during a one-shot migration cannot be undone by the admin who later finds audit actors and
      request authorship pointing at the old value.
- [x] **Rows already written get a repair pass, deliberately not marker-gated.** No operator is
      in the loop for those. `runAccountIdentityRepair` realigns an account row's `id`/`username`
      to the username its key encodes. A marker would make a repair that could not reach
      everything never retry (R-12 is exactly that failure on REM-1's stamp) — this pass is one
      GSI query over a set bounded by the number of humans, cheap enough to just run again.
- [x] **Regression tests — new `import.test.ts`/repair coverage** (see commit `8482cb0`).
- [x] **Negative test confirmed.** Validation neutered to the original cast, repair loop emptied:
      the out-of-contract policy, the id mismatch, and the bad username all import `200` instead
      of `422`, and the repair reports 0 rows. The pre-repair half of the repair test passes
      either way — which is the point: it proves the broken row genuinely cannot resolve a
      session before the fix ever touches it.

## DATA-12

*Crash between the version-row transact and the file write leaves an activatable orphan row in
the upload lane.*

- [x] **Defect reproduced first.** The upload lane allocates row-first (winning the metadata
      row's `ifNotExists` put IS the version-number claim) and writes files second, deleting the
      row only if the write THROWS. A crash in that window — or between the throw and the
      compensating delete — leaves a durable, listed version row with no files, and its audit
      entry claims a successful upload. Activation checked only that the row existed, so two
      admins could take such a version live through the full two-admin ceremony and the
      `dataActive` pointer would then serve 404s for everything.
- [x] **Fixed at the fact, not the claim.** `projectDataVersionLanded` checks that the version
      directory exists (`writeProjectDataVersion` renames a fully-written temp dir into place
      atomically, so presence means the write completed) AND carries `inventory.json` (the one
      file every bundle has, catching a dir damaged by something outside this lane). Cheap on
      purpose (two `existsSync` calls) — this sits on the activate path, not the hot read path,
      and a "files landed" flag written after the file write would just be a second write that
      can crash in the same window, a proxy for the fact rather than the fact.
- [x] **Checked at PROPOSE, not just ack.** A human is present at propose to be told, and it
      stops the orphan from consuming a dual-control envelope at all.
- [x] **Regression tests — `test/projectData.test.ts`, 3 new cases** (a full crash reproduction,
      a partially-removed directory, and the control: a complete version still activates).
- [x] **Negative test confirmed.** Reverting the guard: 2 of 3 new cases fail with
      `expected 409 to be 202`; the control (a complete version still activates) keeps passing
      either way, which is what says the guard is narrow rather than refusing everything.
- [x] **Evidence in the status line.** `cd ccp/api && npx tsc --noEmit -p tsconfig.json && npx
      vitest run` — 104 files, 1436 passed.

## API-15

*A dangling idempotency marker makes its key permanently unusable.*

- [x] **Defect reproduced first.** If a marker exists but the request row it names does not
      (partial deletion, manual surgery, or a future request-delete feature), the pre-check fell
      through (`prior` null), the handler built a new request, and the transaction's marker
      `ifNotExists` put failed. The recovery path re-read the marker, found the same dangling
      `requestId`, got `prior === null` again, retried once more, and finally threw
      `CHAIN_CONTENTION`. Every submit with that key 409s forever.
- [x] **Fixed by re-deriving the marker's write MODE fresh, every attempt** — never trusted from
      a prior attempt or the outer pre-check, which can go stale between the read and the write.
      Three outcomes, decided from a read taken at the top of the SAME attempt that uses it: no
      marker yet → `ifNotExists` (ordinary first submit); marker exists and its request is real →
      genuine duplicate, short-circuit with it, no write attempted; marker exists but its request
      is gone (dangling) → CAS-repair it atomically with this submit, guarded on the exact stale
      value so a concurrent repair cannot be silently clobbered.
- [x] **Both of the finding's suggested remedies are effectively taken.** "Overwrite the marker
      (treat as stale)" is exactly what the CAS-repair does; "return a specific conflict naming
      the stale marker" was rejected in favor of self-healing — a stale marker is a symptom no
      operator caused and no operator needs to be paged for.
- [x] **Regression test — `test/changeSet.test.ts`, "a dangling marker ... self-heals" (new).**
      The crash is reproduced by its OUTCOME (deleting only the request row, leaving the marker)
      rather than by any real delete path, since none exists in this codebase yet.
- [x] **Negative test confirmed.** Reverting to the fixed-mode marker write reproduces the
      finding's exact symptom verbatim: `expected 409 to be 201` on a resubmit after the request
      row (not the marker) is removed.
- [x] **Evidence in the status line.** `cd ccp/api && npx tsc --noEmit -p tsconfig.json && npx
      vitest run` — 104 files, 1437 passed.

## API-18

*Legitimize endpoint mints unlimited duplicate engineer requests for the same digest.*

- [x] **Defect reproduced first.** By design the revert proposal row is not consumed by
      legitimize ("stays open; both paths remain visible") — but nothing else deduplicated
      either. Repeated `POST /:id/drift/security/:digest/legitimize` calls each created a fresh
      `NEEDS_ENGINEER` request bound to the same digest, only slowed by the submit rate limit.
      The adopt/revert submit lane, by contrast, atomically flips the proposal to `submitted`
      exactly once.
- [x] **Fixed with a new `legitimizeRequestId` on the proposal row (additive, revert-only),
      checked against the POINTED-TO request's own status, never trusted blindly.** Still open
      (`occupiesQuotaSlot`, the same fail-closed "not terminal" vocabulary the rate limiter uses)
      → surface the existing request (200), never mint another. Terminal
      (rejected/cancelled/withdrawn) → a fresh legitimize is allowed again, so one failed attempt
      to converge the drift does not permanently block a retry. The row's own `status` still
      never changes — this is bookkeeping, not the state transition the route's own header
      comment says legitimize deliberately avoids.
- [x] **Stamped atomically with the new request, CAS-guarded.** The proposal-row update rides in
      the SAME `transactWithAudit` call as the request-row put, guarded on the exact
      `legitimizeRequestId` value read moments before — a race between two concurrent legitimize
      calls resolves to whichever one actually won (the catch path re-reads and returns the
      winner's request) rather than both succeeding.
- [x] **Regression tests — `test/driftLegitimize.test.ts`, 2 new cases**: a repeat call while
      open returns the SAME request (200), not a second one; a repeat call after the prior
      request reaches a TERMINAL status creates a genuinely fresh one and repoints the row.
- [x] **Negative test confirmed.** Reverting to the unguarded write reproduces both halves: a
      second open-window call returns `201` (a second request) instead of `200`; a legitimize
      issued after the prior request went terminal still shows the OLD request id on the
      proposal row instead of repointing to the new one.
- [x] **Evidence in the status line.** `cd ccp/api && npx tsc --noEmit -p tsconfig.json && npx
      vitest run` — 104 files, 1439 passed; `ccp/app`: `npx tsc --noEmit && npx vitest run` —
      160 files, 2828 passed.
