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
