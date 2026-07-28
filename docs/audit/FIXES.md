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
