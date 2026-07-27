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
