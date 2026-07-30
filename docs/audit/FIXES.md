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

## CONC-6

*The bundle claim has no crash/exception/race recovery: `bundle.state:'running'` can stick
forever, and a raced outcome write loses the record of a fired deploy.*

Three gaps, all of them on the far side of the external effects — the commit is pushed and
the deploy gate is satisfied *before* any of this runs, so every one of them loses the
record of something that really happened.

**1. No exception path.** `runBundle` was awaited bare. A throw — `mkdtempSync` against a
vanished `TMPDIR`, `writeFileSync` ENOSPC on the request-evidence file, anything unexpected
inside a step — produced a bare 500 and left the row at `bundle.state:'running'`. ERR-2's
lease has since made that self-clearing rather than permanent, which is a real improvement
and still leaves an hour in which a fully approved request answers `BUNDLE_RUNNING` for a
bundle that is not running. The call is now wrapped, and a throw becomes a **failed
outcome** rather than a special case: it takes the ordinary terminal path, so the row
reaches `failed`, the audit entry records the error text, and the caller gets the same 502
any other failed bundle gets.

**2. The finding's second gap had MOVED, not closed.** As written it says the outcome write
is guarded `ifEquals status=<observed>`, so a cancel-during-bundle refuses it, retries,
refuses again and throws `CHAIN_CONTENTION` with nothing written. ERR-11 changed that guard
to `eventSeq` — and cancel guards on `status` and advances no `eventSeq`, so the write now
*succeeds*. That closes the finding as literally stated and opens a quieter version of it:
`set` **replaces** the whole `events` attribute, and the array being written was built from
the pre-bundle snapshot. A cancel that landed during a bundle that can legitimately run for
half an hour was silently erased from the timeline — a `CANCELLED` request whose history
never mentions the cancellation. The outcome write now re-reads the row inside the retry
loop and appends to the **fresh** timeline, and reports `after.status` as the status the row
actually settled to rather than the pre-bundle one.

**3. A row that moved past the claim.** A lease takeover by a second apply *does* advance
`eventSeq`, so the guard refuses — correctly; the claim is no longer ours. But refusing the
state transition is not a reason to discard the evidence. The two writes are different kinds
of thing and no longer share a fate: the row update may lose its race, while the audit entry
records what happened and no race makes that untrue. When the row refuses, the entry lands
anyway carrying `requestRowMoved: true` and the landed SHA, and the caller gets a specific
`409 BUNDLE_ROW_MOVED` — not `CHAIN_CONTENTION` with nothing written.

- [x] **Negative test** — run three times, once per gap, each reversal failing exactly the
      tests that target it and no others: removing the try/catch fails all three gap-1 tests
      (500 instead of 502, and no audit entry at all); rebuilding `events` from the
      pre-bundle snapshot fails the erasure test; restoring the `CHAIN_CONTENTION` throw
      fails the 409 and the chain-continuity test.
- [x] **Regression tests** — 9 in `test/bundleCrashRecovery.test.ts`. **The interleaving is
      real, not simulated**: the gate command blocks on a sentinel file, so the cancel is
      issued while the bundle is provably mid-run, and every test asserts the setup fired
      (`bundle.state === 'running'` before the cancel, the cancel returning 200, the trigger
      step green) before asserting the property (L-1). The exception is a genuine throw from
      `mkdtempSync`, not an injected one.
- [x] **Evidence in the status line** — 1,395 api tests pass, 99 files.

**Residue:** the timeline merge is a re-read rather than a store-level append, which is
empty-window on the in-process stores and not on a future DynamoDB backend. See **R-43**.

## API-4

*The bundle "claim" is not a mutual-exclusion, and a crashed bundle wedges the request at
`running`.*

**Verified closed by earlier work; no code changed.** Both halves were fixed while closing
adjacent findings, and this entry exists so the next reader does not re-derive that.

Defect 1 (not mutual exclusion) is closed by **ERR-11**: the claim CAS guarded on `status`,
an attribute the claim does not change, so two near-simultaneous applies both passed the
read-then-act pre-check *and* both satisfied the guard. It now guards
`ifEquals: {attr:'eventSeq'}` and **sets** `eventSeq: claimSeq` — it guards the attribute it
itself advances, which is what makes a claim a claim.

Defect 2 (a crashed bundle wedges at `running`) is closed by **ERR-2**: `BUNDLE_LEASE_MS`
plus `bundleClaimExpired`, settled lazily on the next apply, with a `bundle-claim-expired`
event so the takeover is visible rather than silent.

- [x] **Regression tests** — already pinned, no new ones needed: `test/bundleClaimLease.test.ts`
      covers both directly — *"a second apply against the pre-image row is refused, not run
      twice"*, *"the claim advances eventSeq, so it can be guarded on at all"*, and *"THE
      DEFECT: an EXPIRED claim is taken over instead of wedging the request forever"*.
- [x] **Evidence in the status line** — those 7 tests pass; verified against the current
      code rather than against the commits that wrote them.

## API-5

*Cancel can race an in-flight bundle: the change applies but the request reads CANCELLED.*

`CANCELLABLE_STATUSES` includes `AWAITING_DEPLOY_APPROVAL` and the bundle claim
deliberately leaves `status` alone, so cancel's `ifEquals status=…` guard held while a
bundle was mid-flight. The bundle went on to land its CAS commit on `main` and satisfy the
CI apply gate. The durable record said `CANCELLED`. The lead who clicked cancel was told it
had worked — on exactly the class of request this system exists to govern.

**Cancel now refuses, and that is not a smaller cancel; it is the only honest one.** The
choice was never "stop the bundle or don't" — nothing in this process could ever stop a
commit that has already been pushed. It was "refuse, or claim to have stopped it". Two
durable facts gate it rather than a guess:

- `bundle.state === 'running'` **with a live claim** → `409 BUNDLE_RUNNING`. ERR-2's lease
  bounds it, so a run that died never wedges cancel; an expired claim is not a bundle. That
  matters more than it looks: cancel is the documented exit from a halted request, so a
  refusal that could not expire would close the only door out.
- `bundle.state === 'triggered'` → `409 BUNDLE_TRIGGERED`, permanently. Not a race, just
  over. `POST /:id/apply` already refuses this row for the same reason, and the message
  names the landed sha so the operator can go find it.

**What is deliberately not claimed:** this closes the window, it does not make the check
atomic — between the read and the write a claim can still be taken. That sliver is covered
from the other end by **CONC-6**, which makes the bundle merge into the timeline instead of
replacing it, so a cancel that does slip through is recorded *alongside* the outcome rather
than erasing it or being erased. The two findings are one fix from two directions: refuse at
the front door, record truthfully if one gets past.

- [x] **The defect was reproduced first**, end to end through the real routes with a real
      git push: with the guard removed the cancel returns 200 and the row settles at
      `CANCELLED` while `bundle.state` reads `triggered`. That is the finding's exact
      sentence, observed rather than reasoned about.
- [x] **Negative test** — removing both refusals fails exactly the two tests that assert
      them, and leaves the CONC-6 suite green (they cover different halves on purpose).
- [x] **Regression tests** — 6 in `test/cancelBundleRace.test.ts`. The race one drives both
      real routes with the bundle provably blocked inside its gate command, and every
      refusal has its complement: an expired claim, a failed bundle and a bundle-less
      request must all still cancel, so the guard cannot quietly widen into "cancel is
      broken". The last test pins the property `bundleCrashRecovery.test.ts`'s store-level
      fixture depends on — that cancel advances no `eventSeq` — so that fixture cannot drift
      into testing nothing.
- [x] **Evidence in the status line** — 1,401 api tests pass (100 files), 2,745 app tests.

## ERR-12

*Trigger failure after a landed commit: honest-but-dead-end half state, and spawn timeouts
are indistinguishable from exit-1.*

Two halves. One was already closed by other work; the other was the dead end.

**The half state — the real work.** If `commit` succeeds the change **is on the deploy
branch**. If `trigger` then fails, the run reported `ok:false` → `bundle.state:'failed'` →
502, and the landed sha survived only inside the audit `steps`. The obvious next move —
click Apply again — re-cloned a branch that now *contained* the commit, re-ran the gate,
found nothing left to change, and died with *"commit failed (gate left no change?)"*: true,
and actively misleading, because the operator's actual remediation was "the change already
landed; fire the CI gate approval for sha X" and nothing anywhere said so.

`landed-untriggered` is now its own state rather than a shade of `failed`, and the
discriminator was already there — `runBundle` returns `sha` whenever `commit` succeeded,
trigger outcome aside. Four things follow from recording it:

- The sha lives on the **request row**, not only in an audit payload no retry path reads.
- A retry **resumes at the trigger** (`runTriggerOnly`) instead of re-running from the top.
  Deliberately *not* re-gating: the gate already ran on this exact sha and passed — that is
  why the commit exists — and a `false` from a second opinion would leave the operator with
  a change on `main` and a tool refusing to finish it. The skipped steps are reported as
  skips with reasons, so an audit reader comparing two runs can see why the second is
  shorter.
- The **response carries the remediation** (`BUNDLE_LANDED_UNTRIGGERED`), because "bundle
  failed" plus a 502 is precisely what sent people to git archaeology.
- **Cancel refuses it**, with the same code and for the same reason it refuses `triggered`.
  This is the trap the state exists to prevent: read as "the bundle failed, so cancelling is
  safe", it would cancel a change that is on the branch. Apply treats the state as
  resumable, so cancel must not simultaneously treat it as nothing having happened.

**The timeout half was already closed** by the async-exec work (CONC-5 / ERR-1 / PERF-2).
The finding describes the `spawnSync` shape that mapped a timeout, a spawn error and a
signal kill all onto a bare `status:1`. `execCapture` now resolves a timeout as **124** with
`timed out after Nms` appended, a spawn failure as `spawn failed: …`, and a signal as 128 —
and `sh()`/`gate()` pass both the status and the text through verbatim. Verified against the
current code rather than assumed (L-29); "already fixed elsewhere" needs the same evidence
as any other claim.

- [x] **Negative test** — three reversals. Collapsing the state back into `failed` fails 5
      tests; removing the resume fails 2. The second reversal also showed the unfixed
      behaviour is *worse* than the finding says when the gate is not idempotent: rather
      than dying at "gate left no change?", the retry **lands a second commit for the same
      change**. Both shapes are now pinned — one test uses a timestamp gate, one an
      idempotent gate that reproduces the finding's literal quoted message.
- [x] **Regression tests** — 12 in `test/bundleLandedUntriggered.test.ts`, driving the real
      route against a real bare repo. The ground truth is `git rev-list --count main` on the
      origin, not the API's own report: every test asserts what actually reached the branch,
      including that a resume lands *nothing new* and that a genuinely failed run (red gate,
      nothing committed) is still plain `failed` with no remediation offered.
- [x] **Evidence in the status line** — 1,413 api tests pass (101 files), 2,745 app tests.

## ERR-5

*`TerraformExecutor.init()` caches a rejected promise: one transient init failure bricks
the executor until restart.*

```ts
this.initDone ??= this.tf(['init', …]).then(() => undefined);
```

`??=` caches whatever the promise settles to. A first `terraform init` that failed for any
transient reason — a registry blip, a momentary state lock, DNS not up yet on a cold boot —
was cached as a **rejection**, and every later `plan`/`replan`/`apply` re-awaited that same
stale rejection. The executor is constructed once at loop start, so the whole auto-apply
lane stayed dead until someone restarted the process, and the only symptom was the
identical boot-time error repeating every tick (through ERR-6's silent path, which is why
these two were batched together).

Memoize the SUCCESS, never the failure: the field is cleared in a rejection handler
registered at creation, so the next caller starts a fresh init. Concurrent callers still
share the one in-flight attempt — one blip stays one failure rather than becoming N
simultaneous `terraform init` runs fighting over the same root, which would be a new defect
introduced by fixing this one.

Retrying without limit is correct *here* — `init` is idempotent and only runs when
something asks for work — and deliberately not the whole answer. Making a persistently
failing init visible instead of a silent loop is ERR-6's job, at the scheduler, where the
request that keeps failing actually lives.

- [x] **Negative test** — reverting to `??=` fails 4 of the 5 tests. The one that survives
      is the over-fix guard (a successful init must still be memoized), which is the point
      of having it.
- [x] **Regression tests** — 5 in `test/executorInitRetry.test.ts`, driving the REAL
      executor with a stub `terraform` binary rather than mocking `init`. That matters: the
      defect is in the caching, so a mock of the thing being cached could not tell a re-run
      from a replayed rejection. The stub counts its own invocations on disk, so "did init
      actually run again?" is answered by evidence, and one test asserts the ORDER of
      subcommands — a fix that cleared the memo but skipped straight to `plan` would
      otherwise pass by accident. No real terraform, no network, no estate.
- [x] **Evidence in the status line** — 1,428 api tests pass (103 files).

## ERR-6

*`executor.replan()` failures are an unmodeled halt: unbounded silent retry, and they abort
the rest of the project's due list.*

`processOne` wrapped `executor.apply` in `tryApply` and called `executor.replan(req)` bare.
`TerraformExecutor.replan` throws on any plan failure — backend unreachable, bad
credentials, a config error, ERR-5's cached init rejection — and the exception propagated
out of `processOne`, out of `runDueApplies`, and into a per-project `console.error` in
`loop.ts`. Two consequences, and the second is the one nobody would ever trace back:

1. The failing request was retried **every tick forever** with no halt, no timeline event
   and no alert. Stdout was the only trace, so in the portal it looked exactly as though
   the scheduler had never run.
2. Every **later** due request in the same project was skipped for that tick, every tick. A
   perfectly healthy change silently missed its maintenance window because a *different*
   request was broken.

**Not "halt on the first failure".** Failing to PRODUCE a plan is not the same as producing
one that drifted — nothing about the change is known to be wrong, only unverified — and the
sole exit from a halt is cancel + resubmit through the approval ladder. Paying that human
cost for a thirty-second network fault would be its own defect. So the retry is kept, and
made bounded and visible instead:

- **Counted** on the row (`replanFailures`), which is the only durable trace between ticks;
  without it the scheduler cannot tell the first failure from the four-hundredth.
- **Reported once per episode** — timeline event, audit entry, notifier — and silent
  afterwards. Appending to a request's timeline once a minute forever is the shape
  `holdNoPlan` already refuses, and an alert that repeats identically every minute is one
  people filter.
- **Halted at `REPLAN_FAILURE_LIMIT`** (5 ticks) with its own `REPLAN_FAILED` reason, so
  "we could not check this change" eventually reaches a human.
- **Cleared on recovery**, so a fault weeks later is a new episode that alerts again rather
  than arriving one tick from a halt.

Plus a per-request catch in the due loop. That one is deliberately a BACKSTOP, not the
handler — the modelled failures are handled where they happen — and it guarantees only that
the blast radius of an unhandled throw is a single request.

- [x] **The defect was reproduced first.** With both parts reverted, 9 of the 10 tests fail
      with the raw `terraform plan failed: Error: backend unreachable` escaping
      `runDueApplies` — the finding's behaviour, observed.
- [x] **Negative test** — run twice, separately. Reverting only the replan guard fails 7
      (the backstop catches the throw, so the outcomes become `error` instead of the
      modelled `replan-error`, and nothing is counted or halted); reverting the backstop as
      well produces the escape above. The one test green under both is the healthy-project
      guard against a fix that taxes the normal path.
- [x] **A test found a bug in the fix.** Reaching the backstop needs a throw from a path
      neither `tryApply` nor the replan guard wraps, and `processOne` AWAITS
      `notifier.notify` — so a failing alert channel is exactly such a path. The backstop
      then reported *through the same channel*, rethrowing out of its own handler and
      re-opening the starvation it exists to close. Its notify is now best-effort, and the
      test that found it (a notifier that throws on every request) is kept.
- [x] **Regression tests** — 10 in `test/schedulerReplanFailure.test.ts`, including that
      the halt lands on neither the tick before nor the tick after the limit.
- [x] **Evidence in the status line** — 1,428 api tests pass, 2,745 app tests.

**Residue:** the halt threshold is a constant, not per-project policy. See **R-44**.

## CONC-10

*Stuck `APPLYING` after a worker crash has no reclaim or operator path.*

**Verified closed by API-2; no code changed.** The finding's own recommendation — "stamp a
claim timestamp and either let the scheduler transition `APPLYING` rows older than a
generous lease to `HALTED_APPLY_FAILED` (never re-apply — halt for a human), or add an
admin verb" — is exactly what API-2 built, and it took the first branch deliberately: a
recovery verb an operator has to know to run is not a recovery path.

Confirmed against the current code, end to end rather than by reading the fix:

- `applyClaimedAt` is stamped by the claim; `applyClaimExpired` ages from it, falls back to
  `updatedAt` for rows claimed before the stamp existed, and treats an unparseable
  timestamp as expired — a row that cannot be aged is one nothing can ever release, which
  is the wedge itself.
- The claimed-row sweep runs **before** the due-list early return and is **not**
  window-filtered, so a row stranded days after its window shut is still found. It is also
  ahead of the freeze check, so a frozen deployment still un-wedges.
- The sweep HALTS, never re-applies — the dead worker may have applied some, all or none of
  the change, and re-running over a half-applied change is the one outcome worse than
  stopping.
- `HALTED_APPLY_FAILED` is in `CANCELLABLE_STATUSES`, so the operator's exit exists in the
  product rather than in a text editor.

- [x] **Regression tests** — already pinned, none added: `test/schedulerStuckState.test.ts`
      (12) covers each link, including one named for exactly this finding's shape —
      *"an end-to-end wedge clears: crash → lease expiry → cancel, with no store surgery"* —
      and its complement, *"APPLYING itself is still NOT cancellable — the lease is the only
      way out"*, which is what keeps API-5's guarantee intact.
- [x] **Evidence in the status line** — those 12 tests pass against the current code.

**Residue:** the sweep only runs while the scheduler loop is armed. See **R-45**.

## API-8

*Freeze-held `kind:'now'` requests dead-end in `AWAITING_DEPLOY_APPROVAL` after the freeze
lifts.*

At quorum-met the approve handler stamps `APPLIED` for a `kind:'now'` schedule — unless a
change freeze is on, in which case the row is parked in `AWAITING_DEPLOY_APPROVAL` with a
`held_frozen` event, because no request may RECORD an apply during a freeze. That park had
no exit. `settleWindow` returns immediately for `kind:'now'`, the scheduler's due filter
needs an open maintenance window (a `now` row has none), and the apply bundle is disarmed
by default. "Fully approved — held" was forever, with cancel as the only way out.

What makes it a defect rather than a policy is the arbitrariness: the same request approved
one minute after the unfreeze is stamped `APPLIED` instantly. Its terminal fate depended on
which side of the freeze the last signature happened to land on.

`settleFrozenHold` is the missing sibling of `settleCooling`/`settleWindow` and follows
their doctrine exactly — lazy, on read, guarded, audited, idempotent-safe. Three decisions
worth naming:

- **The `held_frozen` marker is the discriminator**, not the status/schedule pair. Today
  they are equivalent, but only the marker says *why* the row is parked, and a future branch
  that parks a `now` row for another reason must not be swept into `APPLIED` by this.
- **Fail-closed on quorum.** The ladder can be tightened after the row was approved, so the
  release re-checks `currentRequirement` — the same tighten-only helper approve and apply
  use — and leaves the row held if the bar moved above its signatures. Still stranded, but
  now stranded in a state a human can act on: it needs another approval, and the ladder
  will ask for one.
- **The freeze is read at most once per page.** `isFrozenHold` is pure and store-free so it
  can screen first; a list with no held rows costs exactly what it did before.

- [x] **Negative test** — removing the wiring from the route fails the three route-level
      tests and leaves the settler-level ones green, which is the honest split: the defect
      was never that the logic was wrong, it was that no route ran it.
- [x] **Regression tests** — 10 in `test/frozenHoldRelease.test.ts`, driving the real
      routes (single GET and the list, which is where a requester actually looks). Both
      complements are covered: a windowed freeze-held row is left to the scheduler rather
      than applied outside its window, and a `now` row with no marker is left alone.
- [x] **A wrong test taught me something.** The race test originally issued three
      concurrent HTTP reads and got `200, 409, 409` — which turned out to have nothing to
      do with this seam. It reproduces on unmodified `main` with an already-`APPLIED` row,
      and the stack points at the one-time legacy settlement racing itself. Raised as
      **API-20**; the race test now drives the settlers directly, where the contention it
      claims to measure actually is.
- [x] **Evidence in the status line** — 1,445 api tests pass (105 files), 2,745 app tests.

## API-19

*`settleCooling` stamps `APPLIED` during a change freeze, bypassing the freeze veto.*

**Found while fixing API-8, and raised as a new finding rather than folded in silently.**
The approve handler treats "no request may RECORD an apply during a freeze" as binding and
parks a `kind:'now'` request instead of applying it. `settleCooling` makes the *same*
decision at a different moment — when an interim-profile request's 24h cooling-off elapses
— through `coolingTargetStatus`, which read only `schedule.kind`. It never consulted the
freeze, so the next read that touched such a row stamped it `APPLIED` on a frozen
deployment, from any endpoint.

The sharp edge is which requests were affected: whether a request takes the cooling path at
all is decided by its risk profile attaching a cooling-off period, so it was precisely the
**higher-risk** requests that bypassed the freeze.

Fixed with API-8 because they are one rule seen twice. A frozen cooling settlement now
writes the same `held_frozen` marker the approve handler writes, and `settleFrozenHold`
releases it when the freeze lifts — one freeze rule, one marker, one exit, instead of two
decisions that disagreed. Refusing without that exit would have traded a fail-open for a
dead end, which is why the two land together.

`coolingTargetStatus` takes `frozen` as a **required** parameter rather than an optional
one: an optional would have let every existing call site keep the old behaviour silently,
and the whole defect is a call site that never asked the question. The compiler made all
six of them decide.

- [x] **The defect was reproduced first**, before any code changed: seeding an
      `APPROVED_COOLING` / `kind:'now'` row with an elapsed `earliestApplyAt` under
      `freeze.global = true` and calling `settleCooling` returned `APPLIED`.
- [x] **Negative test** — reverting `coolingTargetStatus` to ignore the freeze fails 5 of
      the 7 tests. The two that survive are the over-fix guards: an unfrozen `now` row must
      still settle straight to `APPLIED`, and a windowed row must NOT gain a `held_frozen`
      marker (which would let API-8's release apply it outside its maintenance window).
- [x] **Regression tests** — 7 in `test/coolingFreezeVeto.test.ts`, including the end-to-end
      shape that neither half proves alone: cooling elapses under a freeze → held, freeze
      lifts → one read completes it.
- [x] **Evidence in the status line** — 1,445 api tests pass, 2,745 app tests.

## PERF-14

*Scheduler tick re-scans every project's full request collection every minute.*

**Measured before deciding, and the measurement changed the decision.** The finding is
filed `low` on the reasoning that this is "not a latency problem, but permanent
allocation/GC churn". Part of its premise is also stale: it describes "a full store scan …
~200k map iterations" across a 10k-item table, and the store has since been partitioned, so
`queryGSI1` already reads one project's partition rather than the whole table.

What survived is the part that actually costs. The seam deep-copies every row it returns —
isolation, so a caller can never hold a reference to live state — and the scheduler then
discarded nearly all of them. One scan of a project holding 5,000 historical requests:

| project history | before | after |
| --- | --- | --- |
| 100 rows | 4.09 ms | 0.08 ms |
| 1,000 rows | 16.32 ms | 0.16 ms |
| 5,000 rows | 90.84 ms | 0.57 ms |

91 ms is not GC churn. It is 91 ms of **blocked single-threaded event loop**, once a minute,
per project, growing with history forever — at twenty projects, seconds of blocked loop per
minute, to find a due set that is almost always empty. That is why this was worth doing now
rather than deferring, and it is a good argument for the repo's own habit of measuring
before agreeing with a severity.

The finding's recommendation is conditional — "*once a status index exists (or the
PK-indexed store of PERF-10)*, query only AWAITING/APPLYING rows; alternatively maintain a
small side list". Neither was taken. PERF-10 is still open, so building against its index
means designing against something that does not exist; and a write-path-maintained side
list is derived state that can silently drift out of agreement with the rows it summarises,
which is a correctness risk taken on for a performance win.

Instead the seam gained a `where` filter — DynamoDB's `FilterExpression`, reduced to the
one shape callers need — applied **before** the isolation copy. The cost becomes
proportional to the ANSWER rather than to the history, with no derived state to drift, and
an index later makes it cheaper still without changing a call site.

Two decisions inside that:

- **Declarative (`{attr, in}`), not a predicate callback.** A callback would have to be
  handed the store's own item to be worth anything — copying it first is precisely the cost
  being avoided — which means handing every future call site a mutable reference to live
  state. A test pins that the filter did not become a way to skip the copy.
- **The scanned status list is DERIVED, not duplicated.** `SCHEDULER_SCANNED_STATUSES` is
  exported and a test holds it against `isDue`, so teaching `isDue` a third status without
  widening the scan fails the build. Without that, the failure mode would be changes
  quietly never applying, with no error anywhere.

- [x] **Negative test** — run twice. Reverting the scheduler's filter fails exactly one
      test, the cost property (401 copies instead of 1) — correct, because a pure
      performance fix changes no behaviour and every behavioural test passes either way.
      Reverting `matchesWhere` in the store fails four.
- [x] **The regression test pins the COST, not a behaviour.** A counting store wrapper
      records how many rows the scheduler is handed: one actionable row among 400 terminal
      ones must cost one copy. This is the only honest way to pin a perf fix, and it is why
      the "reverting it fails a test" requirement is satisfiable here at all.
- [x] **Regression tests** — 9 in `test/schedulerScanScope.test.ts`, including the two
      properties a narrowing fix is most likely to break by accident: a due request buried
      in 400 terminal rows is still applied, and a stranded `APPLYING` row is still swept
      (the lease sweep runs outside the due path, so it is the half most easily dropped).
- [x] **Evidence in the status line** — 1,454 api tests pass (106 files).

**Residue:** the `where`/`limit` interaction diverges from DynamoDB. See **R-46**.

## API-17

*Store-seam divergences from the DynamoDB semantics it mirrors.*

The seam's promise is that a test passing against `MemoryStore` is a true statement about
the deployed backend. Two traps broke that quietly - both would have passed every local
test and failed only in production, which is the worst place to find them.

**(a) `ifEquals` compared with `!==`, i.e. reference identity for objects.** The store hands
out CLONES, so the first caller to guard on an object or array gets a condition that can
**never** pass: it compares its own copy against the store's original. Nothing is broken
today because every shipped guard is a scalar or `undefined` - but `domain/settlement.ts`
already writes exactly that shape (`ifEquals: {attr:'roles', value: account.roles}`), and it
works only because the legacy rows it targets have no `roles` map yet. The day one does, the
settlement fails every attempt with a condition that *looks* like contention and no amount
of retrying helps. `deepEquals` (beside `cloneValue`, over the same JSON-value domain) is
what the seam always promised: DynamoDB compares attribute VALUES.

Key order is deliberately insignificant - a `JSON.parse` of a FileStore snapshot need not
preserve insertion order, and comparing serialized forms would make equality depend on how
a caller happened to build its object literal. An explicit-`undefined` key is NOT equal to
an absent one, matching DynamoDB, where a null attribute and a missing one differ.

**(b) `transact` accepted two actions on the same item**, applying them last-wins. DynamoDB
`TransactWriteItems` rejects that outright, and last-wins is not merely "different": it
silently discards one of two writes the caller believed both landed - a lost update
produced by the very mechanism that exists to prevent them. Also unbounded, where DynamoDB
caps a transaction at 100 actions.

Both now throw a plain `Error`, **not** a `ConditionError`, and that distinction is
load-bearing: every retry loop in this codebase treats `ConditionError` as "somebody got
there first", so dressing a programming error as contention would bury it in a retry loop
forever.

- [x] **Negative test** - reverting `deepEquals` fails the object-guard test; making
      `assertTransactShape` a no-op fails 5.
- [x] **Regression tests** - in `test/storeSeamFidelity.test.ts`, with the complements that
      stop a fix from over-reaching: a genuinely different value must still be REFUSED, and
      an ordinary multi-key batch must still succeed.
- [x] **Evidence in the status line** - 1,468 api tests pass (107 files).

## DATA-14

*Seam-fidelity gaps between MemoryStore and the promised DynamoDB semantics.*

Same list as **API-17** from the other report; the two traps it shares are closed there.
What is left is three CONVENTIONS this codebase actively depends on which are not
expressible as plain DynamoDB operations. The finding offers a choice - "encode these
conventions explicitly in the contract so a DynamoDB adapter must implement them, or tighten
MemoryStore to reject what DynamoDB rejects" - and they take the first branch, because each
one is load-bearing behaviour rather than an accident:

1. **`ifEquals: {value: undefined}` means "the attribute is ABSENT"** - the adapter must
   emit `attribute_not_exists(attr)`, not `attr = :v`. `settlement.ts` binds a legacy
   account row only while it still has no `roles` map; the guard *must* fail once somebody
   else has written one.
2. **`undefined` inside `set` means REMOVE** - routed into a `REMOVE` clause, not a `SET` of
   null. `dualControl.ts` takes a terminal proposal out of the pending index this way; as a
   `SET`, the row would stay indexed and every sweep would keep finding it forever.
3. **`GSI1SK` falls back to the item's own `SK`** - a real composite-key GSI OMITS items
   lacking the sort key, so an adapter must PROJECT a `GSI1SK` for every indexed row rather
   than rely on a read-time fallback. Otherwise rows silently vanish from every list that
   reads the index.

They are documented on `ConfigStore` - the interface an adapter author reads - rather than
in `MemoryStore`, which is the one file such an author will never open.

- [x] **Regression tests** - one per convention, pinning the BEHAVIOUR rather than the
      prose, so an adapter can be held to them: the absent-guard passing and then failing
      once the attribute exists, a row actually leaving the GSI partition, and an
      unlabelled row being returned and ordered by its SK fallback.
- [x] **Evidence in the status line** - see **API-17**.

## DATA-15

*Map key concatenation with a space separator is aliasable in principle; client-controlled
bytes reach PKs unconstrained.*

**The first half was already closed** and is recorded here so the next reader does not
re-derive it: the composite key was `pk + ' ' + sk` and is now NUL, with a comment explaining both
why (it cannot appear in a legitimate key, so two distinct key pairs can no longer collide
on one composite string) and why it is written as an escape rather than a literal byte.

**The second half was live.** `idempotencyKey` accepted any 1-200 characters and is
concatenated into a store PK, so a caller chose part of a primary key: NUL, `#` (the
namespace delimiter), newlines, or a whole forged key path. "No collision is constructible
today" was true and is a property of the current SK vocabulary rather than an enforced
invariant - and the place to enforce it is where the untrusted bytes enter.

A safe charset (`A-Za-z0-9._:-`) rather than escaping, because an idempotency key is an
opaque token the CLIENT invents: there is nothing expressive to preserve, and a rejected key
is a clear 422 at submit time instead of a key that works until the day it aliases.

- [x] **Negative test - and the FIRST version of it passed against the unfixed code.** The
      submit body it posted was invalid for an unrelated reason, so every request returned
      422 and both assertions were satisfied by an error that had nothing to do with the
      key. Exactly L-1, caught only because the fix was reverted and the test stayed green.
      There is now a CONTROL test asserting a clean key really does yield 201, and with the
      charset removed the defect reproduces honestly: `a#b` is accepted into a PK as a 201.
- [x] **Regression tests** - the refusals (delimiters, whitespace, NUL, newline, a forged
      key path) alongside the tokens that must keep working (uuid, ulid, a dotted nonce).
- [x] **Evidence in the status line** - see **API-17**.

## CONC-8

*Every authenticated request triggers a full-store snapshot write; snapshot serialization is
synchronous O(store) on the event loop.*

**Both halves of the finding's own recommendation were already done**, and this entry says
so rather than leaving the next reader to re-derive it. "Don't persist the idle slide on
every request" is closed by `SLIDE_GRANULARITY_MS`: the slid value is still what the request
sees, but the WRITE happens at most once a minute per session. "Move snapshot serialization
off the hot path" was half-done by PR #6's write coalescing, and `serializeItems` had
already dropped the deep copy `exportItems` used to make.

What remained is the part the triage flags: **the serialize step itself still blocks**.
Measured before deciding, at ~5 microseconds per row:

| store | snapshot | `JSON.stringify` |
| --- | --- | --- |
| 1,000 rows | 1.1 MB | 7.9 ms |
| 5,000 rows | 5.4 MB | 30.8 ms |
| 20,000 rows | 21.5 MB | 107.0 ms |
| 50,000 rows | 53.7 MB | 263.3 ms |

That is a hard stall of the entire single-threaded server, on the durable-write path.
Nothing is served during it — `/readyz` included, which is precisely how a slow snapshot
turns into an orchestrator restart in the middle of a write, the interaction ERR-1 and
CONC-5 are about arriving through a third door.

The snapshot is now rendered in chunks that yield between them. Max contiguous block, at
2,000 rows per chunk:

| store | before | after |
| --- | --- | --- |
| 5,000 rows | 31.7 ms | 11.7 ms |
| 20,000 rows | 122.7 ms | 20.3 ms |

The point is not the ratio, it is the SHAPE: the block used to grow with the database and
now grows with the chunk size, which is a constant.

**The safety argument rests on one property, and it is worth stating because the whole
optimisation collapses without it: stored items are REPLACED, never mutated in place.**
Every write path builds a new object and swaps the map's reference, so an array of
references captured synchronously is an immutable point-in-time view — a mutation landing
mid-serialize changes the map, not the objects being read. There is no torn snapshot
possible, only a snapshot of time T, which is what a snapshot is. A test lands an update, an
insert and a delete DURING a serialize and asserts the output is exactly the state at
capture.

`FileStore.flush`'s "claim the waiters and fix the state in one synchronous step" guarantee
is unchanged: `serializeItemsChunked` captures its rows before its first `await`, so the
capture is still inside flush's synchronous prefix. Mutations arriving during the awaits
queue the next flush, as they always did.

- [x] **Negative test, run twice, and the SECOND run is the valuable one.** Removing the
      yield fails the "the loop turns between chunks" test. Replacing it with
      `await Promise.resolve()` — a microtask, the subtly wrong version, which chunks the
      work and yields nothing because microtasks drain before the loop turns — fails the
      SAME test. A fix that looked right would not have passed.
- [x] **Regression tests** — 10 in `test/snapshotChunking.test.ts`. The first four assert
      the chunked output is BYTE-IDENTICAL to the synchronous one, including at every
      awkward boundary (empty, one row, exactly one chunk, one over): that is the entire
      correctness argument, asserted rather than reasoned about. There is a CONTROL
      asserting the synchronous serializer yields nothing, without which the yield test
      would prove nothing (L-1). And three FileStore tests cover the property that actually
      matters — a chunk-written snapshot reloads identically, the file is never half-written
      at rest, and a mutation during a flush is covered by the next one rather than lost.
- [x] **Evidence in the status line** — 1,478 api tests pass (108 files).

**Residue:** the row CAPTURE is still one synchronous O(store) step, and the suite has a
timing-flake this work ran into three times. See **R-47** and **R-48**.

## DATA-16

*No format/version marker in the snapshot file; migration rests entirely on convention.*

The on-disk snapshot is a bare JSON array with no producer stamp and no version. The
migration story — additive-optional fields, read-time shims, unknown fields surviving
load-to-export because items are opaque records — is real and well documented, but an older
binary handed a file whose invariants it PREDATES could not detect that. It read it and
rewrote it blind, which is the one failure a version marker exists to prevent. There was
also nowhere to hang a future breaking migration.

`parseSnapshotItems` now accepts the envelope `{ formatVersion, items }` as well as the
legacy bare array, and refuses a `formatVersion` above what the binary knows — with a
message that tells the operator to upgrade rather than leaving them to guess. A nonsense
version (a string, a fraction, zero) is refused too: reading it as "probably 1" is the
guessing the marker exists to stop.

**This release READS both shapes and still WRITES the bare array, deliberately.** Flipping
the writer is the second half of an expand/contract migration, and doing both at once means
a rollback to the previous binary meets a file it cannot parse — turning a routine revert
into a manual recovery. Teaching every reader to detect comes first. A test pins the WRITTEN
shape so the flip cannot happen as a side effect of some later change; the flip itself is
**R-49**.

- [x] **Negative test** — reverting `FileStore.load` to its bare cast fails 8 of the 13
      tests, and the failures are the finding's own symptoms: `items is not iterable`
      instead of a refusal.
- [x] **Regression tests** — in `test/snapshotFormat.test.ts`, including the compatibility
      half (a legacy bare array must still load — breaking that would brick every existing
      deployment on upgrade, far worse than the defect) and the pinned written shape.
- [x] **Evidence in the status line** — 1,491 api tests pass (109 files).

## DATA-5

*Store rows are not validated against the schemas on load: corrupt-but-parseable state is
accepted silently.*

`FileStore.load` was `JSON.parse(raw) as Item[]`. A non-array top level failed only by an
incidental `items.map is not a function` from deep inside the store; any PARSEABLE
corruption — a hand-edit, a bad restore, a partial write by another tool, a row missing
`PK` — loaded clean and flowed through unchecked casts into auth and domain logic.
`snapshot.ts` had the proper array-shape check all along; this loader simply did not use it.

Fixed where it belongs: **one parser for every reader of a snapshot.** `FileStore.load`,
`scripts/backup` and `scripts/restore` all go through `parseSnapshotItems`, so the check
lands in the two scripts without touching them — and the finding's note that `restore.ts`
verifies the audit chain but not item shapes is answered by construction rather than by a
second implementation that could drift.

Two structural checks per row, both naming the ROW INDEX: the row must be an object, and it
must carry a string `PK` and `SK`. The second is not cosmetic. An item without them keys as
`"undefined<NUL>undefined"`, so **every** such row collapses onto a single entry and
silently overwrites the others — a file can lose most of itself and still boot clean. The
message also carries something findable (the key that IS present, or the first few field
names), because an operator staring at a refused boot needs to know which line of a 50 MB
file to open, and "invalid snapshot" would be true and useless.

**Deliberately NOT a full per-row zod pass.** The finding calls that optional, and R-41 is
the standing warning: a legacy-passthrough shim guessed at rather than designed against real
stored shapes fails a BOOT, not a test — and a store that refuses to start is a worse
outcome than the undefined behaviour being prevented. The PK/SK check is the part that
cannot false-positive on any legacy shape, because a row without them was never meaningfully
loadable in the first place. The schema pass is **R-50**, with the conditions under which it
would be safe to do.

- [x] **Negative test** — see **DATA-16**; the same reversion covers both, since both are
      the one loader change.
- [x] **THE CONTROL** — a 200-row ordinary snapshot must still load in full, including
      unknown/future fields surviving load-to-export. Without it the refusal tests prove
      only that something throws, and a tightening that rejected valid stores would be a
      far worse defect than the one being fixed.
- [x] **Evidence in the status line** — see **DATA-16**.

## PERF-11

*Per-project audit chain head serializes all writes and surfaces contention as user-facing
409s after one retry.*

Every mutation in a project CASes the same `CHAINHEAD` row. That is the integrity choice and
it is the right one — a hash chain that could fork would not be evidence — but it means
concurrent mutations in one project collide routinely: between the head read and the
transact there are several awaits and, on `FileStore`, a whole snapshot write. Two attempts
is a very small budget against a window that wide. Three ordinary actors were enough for the
third writer to lose twice and be handed a 409 for a normal approve click.

The direction to fail in was never in doubt — the finding says it and the triage repeats it:
the chain is the product's evidence store, so a fix that DROPPED entries under load would be
worse than the 409. Retrying more is the safe direction, because every one of these loops
re-reads the head and rebuilds its writes from scratch; an extra attempt costs one read and
can never produce a duplicate or a stale write.

Budget raised to `CHAIN_RETRY_ATTEMPTS` with **full jitter** backoff —
`random(0, min(cap, base * 2^attempt))`. Full, not fixed, and that is the load-bearing
detail: the losers of a collision are all awake at the same instant by construction, so a
fixed backoff marches them into the next collision together — the retry storm the backoff
exists to prevent, one tick later.

**One refusal is deliberately NOT retried more.** `transactWithAudit` still refuses
immediately when the caller carries its own value guard: replaying a stale `ifEquals` is the
lost update CONC-1 was about, and a bigger budget there would only make it worse. That check
stays above the backoff.

- [x] **A route-level test caught an incomplete fix.** Raising the budget in `record` and
      `transactWithAudit` alone changed nothing a user would notice: the chain-head retry
      loop is HAND-ROLLED at fifteen call sites — every verb that folds its own domain
      writes in beside the audit append — and the approve handler, which is the finding's
      own example of a 409 on an ordinary click, has its own. Five of six concurrent
      approvals still failed. The unit test passed throughout.
- [x] **Negative test** — `test/audit.test.ts` pins the boundary against the CONSTANT rather
      than a literal, so it states the contract ("all but the last attempt may race and the
      write still lands; one more failure than the budget is a 409") instead of re-encoding
      a number that has now changed once.
- [x] **A test for the SUBTLY wrong fix** — a fixed backoff, or one that ignores its random
      source, fails the jitter test. That is the version that looks right.
- [x] **Regression tests** — 7 in `test/chainContention.test.ts`, including the property a
      retry budget could plausibly break: every write must land EXACTLY once, with the chain
      head's count agreeing with the entries. A duplicate from a replay would be a worse
      defect than the 409.
- [x] **Evidence in the status line** — 1,498 api tests pass (110 files).

**Residue:** the fix does not close **API-20**, and writing the test proved it. See **R-52**.

## DATA-6

`rename` durability is not guaranteed — no directory fsync after the atomic swap.

`FileStore.writeAtomic` fsyncs the containing directory after the rename (added under
ERR-10): the rename itself is atomic against a process kill regardless, but the *directory
entry* pointing at the new inode is not durable against power loss until the directory's
own metadata is flushed — a crash right after a "successful" write could still resurrect
the OLD file on the next boot.

`store/snapshot.ts` has its own standalone `writeFileAtomic` — used by `scripts/backup.ts`
and `scripts/restore.ts`, deliberately kept separate from `FileStore`'s so the scripts never
touch the durable store's code path. It duplicates the temp+fsync+rename shape but was
written before ERR-10 landed and was never given the directory fsync. A backup, or a
restore's install of a new store file, had no better durability guarantee than the very
defect ERR-10 closed everywhere else.

**Fix:** the same `syncDir` helper `FileStore.writeAtomic` uses, called after the rename.
Kept as its own copy in `snapshot.ts` rather than imported, matching that module's existing
"deliberately standalone" doctrine stated in its header comment.

- [x] **Reproduced first** — read at HEAD: `snapshot.ts`'s `writeFileAtomic` had no
      `syncDir` call anywhere, confirmed against `fileStore.ts`'s working copy.
- [x] **Regression test** — `test/snapshotWriteAtomic.test.ts` batches this with DATA-13
      (below); the leaked-temp-file assertion is the one that actually exercises the failure
      path, since a missing `syncDir` has no directly observable effect in a unit test (it
      is a power-loss guarantee, not a behaviour a test can trigger). The doc comment
      states the property explicitly so a reader does not need to re-derive it.
- [x] **Evidence in the status line** — `fixed:685621d`.

**Residue:** the fix duplicates `syncDir` and the temp-cleanup try/catch between
`fileStore.ts` and `snapshot.ts` rather than sharing one implementation. See **R-53**.

## DATA-13

Failed atomic writes leak temp files in the store path.

Same root cause as DATA-6: `store/snapshot.ts`'s standalone `writeFileAtomic` predates
ERR-10 and never got its temp-file cleanup either. ERR-10's fix wraps EVERY step from temp
file creation to the rename in a try/catch that removes the temp file on any failure — not
just a failing `writeFile`/`sync`, which misses the case a failing `rename` itself produces
(a directory sitting where the target belongs, a cross-device target). Under sustained
ENOSPC — the very condition that makes writes fail in the first place — one leaked file per
attempt fills the directory that recovery depends on.

`scripts/backup.ts` and `scripts/restore.ts` are the only two callers, so this was a leak on
every failed backup attempt and every failed restore install, with no cleanup path at all.

**Fix:** the identical try/catch-and-`rm` shape `FileStore.writeAtomic` uses, applied to
`snapshot.ts`'s copy.

- [x] **Reproduced first** — a directory placed at the target path makes a real filesystem
      failure: the temp file is genuinely created and written, and the `rename` onto the
      directory fails with `EISDIR` (root cannot bypass this the way it bypasses permission
      bits, which is why `storeDurabilityFault.test.ts`'s equivalent `FileStore` suite uses
      the same shape rather than `chmod`).
- [x] **Negative test result** — `test/snapshotWriteAtomic.test.ts`'s first case fails
      against the unfixed code with `leaked temp files: backup.json.tmp-<pid>-<hex>:
      expected [ Array(1) ] to deeply equal []`, confirmed by stashing the fix and
      re-running. Passes after restoring it.
- [x] **Assert the setup fired** — the test asserts the write actually failed
      (`rejects.toThrow()`) before checking for the leak, so a silently-succeeding write
      could not make the assertion pass for the wrong reason.
- [x] **Two more cases** pin the non-regressions: a successful write leaves no temp file,
      and missing parent directories are still created (`mkdir -p` semantics preserved).
- [x] **Gates** — `npx tsc --noEmit` clean; full api suite 1501/1502 (the one failure,
      `snapshotChunking.test.ts`'s 5s timeout under full-suite load, reproduces on `main`
      and passes in isolation — pre-existing flake, not caused by this change).
- [x] **Evidence in the status line** — `fixed:685621d`.

## FE-11

*`WINDOW_EXPIRED` is missing from both status-filter vocabularies.*

`MyRequests.tsx` and `ApprovalsQueue.tsx` each hand-maintained an `ALL_STATUSES` array
for the status-filter dropdown, and both independently omitted `WINDOW_EXPIRED` — the one
status that *requires* user action (re-window or cancel) was the one status a requester or
reviewer could not filter to. `parseFilters` silently coerced `?status=WINDOW_EXPIRED` to
`'all'`, so even a hand-typed or bookmarked URL lost the filter. A plain `RequestStatus[]`
array has no compile-time completeness check against the union, which is exactly how the
omission happened invisibly in both files at once.

**Fix:** both arrays are now `[...REQUEST_STATUSES]` — spread from the one closed
vocabulary ARCH-7 established (`ccp/app/src/lib/requestStatus.ts`) — rather than restated
by hand. Any status added to that vocabulary in the future is automatically filterable
everywhere that imports it; there is no second list to remember to update.

- [x] **Reproduced first** — confirmed against the pre-fix source: `?status=WINDOW_EXPIRED`
      through `parseFilters` in both `MyRequests.tsx` and `ApprovalsQueue.tsx` returned
      `{status:'all', q:''}` instead of preserving the value.
- [x] **Negative test** — `test/myRequests.test.ts` and `test/approvalsQueue.test.ts` each
      gained a case asserting `WINDOW_EXPIRED` (and, in `MyRequests.test.ts`, every
      scheduler-written status) survives `parseFilters` unchanged. Confirmed to fail
      against the unfixed arrays: stashing the source fix reproduced exactly the coercion
      above, restoring it passed.
- [x] **Evidence in the status line** — `fixed:b9653bd`.

## UI-10

*Request-status copy has four competing sources; raw enum text can reach the UI.*

`MyRequests.tsx`, `ApprovalsQueue.tsx` and `lib/palette.ts` each carried their own
`humanizeStatus` — a mechanical underscore-to-space transform producing different words
for the same state right next to `StatusBadge`'s curated label ("Awaiting code review" in
the filter dropdowns vs the badge's "Awaiting review" for the same `AWAITING_CODE_REVIEW`
status; "Noop"/"Approved cooling" instead of the badge's "No change"/"Cooling off").
`Notifications.tsx`'s `ownNote` default branch rendered the raw enum outright
(`· CHECKS_RUNNING`) for any status without its own `case`. None of this is catchable by
the copyLint suite — these are all *derived* strings, not literals it can scan for.

**Fix:** `StatusBadge.tsx` now exports `statusLabel(status)` — the exact map the badge
itself renders from — and all four call sites read it instead of re-deriving copy.
`humanizeStatus` in the three feature files is kept as a one-line wrapper around
`statusLabel` (least-diff change to each call site) rather than deleted outright, so the
existing `humanizeStatus(s)` call sites needed no further edits beyond the function body.

- [x] **Reproduced first** — confirmed the divergence by reading all four files side by
      side before changing anything: `StatusBadge`'s `NOOP → "No change"` against
      `humanizeStatus('NOOP') → "Noop"` in the other three.
- [x] **Negative test** — `test/statusBadge.test.ts` gained a `statusLabel` suite: every
      status in `REQUEST_STATUSES` must resolve to a non-empty, non-SCREAMING_SNAKE_CASE
      label that is *exactly* what `StatusBadge` renders, plus two pinned curated cases
      (`NOOP`, `APPROVED_COOLING`) that a mechanical transform would get wrong. Confirmed
      to fail against the unfixed source: `statusLabel is not a function` (not yet
      exported), 7 failures total across the three touched test files.
- [x] **`Notifications.tsx`'s silent fallback is the one behavioural fix here** — every
      other call site was a copy-consistency issue; this one could show a user
      `· CHECKS_RUNNING` verbatim. Its default branch now calls `statusLabel(req.status)`.
- [x] **Evidence in the status line** — `fixed:b9653bd`.

**Residue:** `humanizeStatus` remains as three thin wrappers rather than being deleted and
having every call site updated to call `statusLabel` directly. Acceptable — it is a single
line in each file and the alternative (renaming every JSX call site) is a larger diff for
no behavioural gain — but a fourth wrapper appearing anywhere else would be the same defect
returning in miniature. Not tracked by a finding; low risk given how few call sites exist.

## DOC-13

*Request-status vocabulary is three-way inconsistent (SPA union vs server writes vs YAML prose).*

Three descriptions of the same vocabulary had drifted independently. The SPA union
(`ccp/app/src/lib/requestStatus.ts`) was already closed by ARCH-7 and already includes
`HALTED_DRIFT`/`HALTED_APPLY_FAILED`. What remained was the **contract prose**:
`ccp-api.yaml`'s `ChangeRequest.status` "known values" description named
`AWAITING_CODE_REVIEW | NEEDS_ENGINEER (open) → APPROVED_COOLING → AWAITING_DEPLOY_APPROVAL
→ WINDOW_EXPIRED → APPLIED → CANCELLED | REJECTED` — omitting `APPLYING` (the scheduler's
lease state, `scheduler.ts`'s own exported `APPLYING` constant), `HALTED_DRIFT` and
`HALTED_APPLY_FAILED` (both written by the scheduler since it shipped, per ARCH-7's own
fix notes), and `CHANGES_REQUESTED`/`WITHDRAWN` (written by the review/withdraw routes,
also already present in the SPA union). A reader of the contract alone — the intended
audience for "known values" — could not know the wire carries any of these five.

**Fix:** the prose now names all thirteen statuses the server actually writes, in their
approximate lifecycle order, with a short parenthetical for each new entry explaining when
it is written and how it exits (mirroring the existing entries' style rather than
introducing a new documentation convention).

- [x] **Reproduced first** — grepped the five missing statuses against the YAML at HEAD
      before writing anything; none of the five appeared in the status description.
- [x] **Regression test** — `test/openapi.test.ts` gained a `DOC-13` suite that slices out
      exactly the `ChangeRequest.status` description value (not the whole 900-line file,
      so an unrelated string elsewhere cannot make the test pass for the wrong reason —
      L-1) and asserts all thirteen statuses appear in it by name.
- [x] **Negative test** — confirmed to fail against the unfixed YAML: stashing just
      `ccp-api.yaml` reproduced `CHANGES_REQUESTED: expected '...' to contain
      'CHANGES_REQUESTED'`, restoring it passed.
- [x] **Failure is loud** — n/a; a contract-prose fix, no runtime path changes.
- [x] **Evidence in the status line** — `fixed:b9653bd`.

**Verification (all three findings, one commit):** api suite 1503/1504 (the one failure is
the pre-existing `snapshotChunking.test.ts` timing flake recorded in R-48, unrelated —
passes in isolation); app suite 2752/2752; typecheck clean in both packages; app build
green.
