# Fix log

One entry per finding marked `fixed:` in [`FINDINGS.md`](FINDINGS.md), with that finding's
definition-of-done worked through honestly.

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
