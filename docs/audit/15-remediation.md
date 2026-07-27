# Remediation-surfaced findings

Audit date: 2026-07-27
Dimension: `remediation` — defects found while FIXING the original 210, not by the review
Scope note: same charter as the rest of the set — engineering robustness, not security
assessment.

---

## Why this file exists

The 14 dimension reports are the record of what the review found, at `3000920`. They should
stay that. But fixing a finding sometimes exposes a *different* defect, and the honest place
for it is a finding of its own — not a footnote in the fix log of the thing that revealed it.

The trigger for creating this file was watching the same residue get written down three
times. `CONC-1`, `CONC-2` and `CONC-3` each closed with "…and there is a window on rows
written before this change", each recorded it as residue, and none of them owned it. Three
mentions with no owner is how a defect becomes permanent: everyone has noted it, so everyone
assumes it is handled.

Findings here follow the same format as the rest of the set, and are tracked in
[`FINDINGS.md`](FINDINGS.md) on equal terms — the gate does not distinguish them.

---

## Findings

### REM-1 — The optimistic-concurrency guards cannot bite on rows written before they existed

- **Severity:** medium
- **Location:** `ccp/api/src/routes/requests.ts` (the `eventSeq` guards on approve, reject,
  link-pr, plan-summary); `ccp/api/src/routes/auth.ts` and `account.ts`
  (`putAccountGuarded`); `ccp/api/src/routes/admin.ts` (totp-reset, sessions-revoke)
- **Description:** The guards added for CONC-1, CONC-2 and CONC-3 compare the attribute
  value the handler read — `eventSeq` on request rows, `accountVersion` on account rows.
  On a row written *before* those fields were maintained, the value is `undefined`. Two
  concurrent readers therefore both capture `undefined`, both guards compare
  `undefined !== undefined` → false, and both writes are allowed. The lost update the guard
  exists to prevent can still happen exactly once per row, after which the row carries a
  number and the guard works normally.
- **Impact:** Every request and account row that predates this work has one unguarded
  window. For a request row that is a lost approval signature; for an account row it is the
  restored-disable scenario CONC-3 describes. The exposure is bounded (once per row, and
  only under genuine concurrency) but it is precisely the case the guards were added for,
  and it is silent.
- **Recommendation:** A one-shot migration stamping `eventSeq: 0` on every request row and
  `accountVersion: 0` on every account row that lacks one — the store already has a
  migration path (`scripts/migrate-data.sh`, `test/migrate.test.ts`). Alternatively, treat a
  missing guard attribute as a hard refusal and let the first write per row fail once, which
  is safer but visibly worse for the operator. The migration is preferable; the point is
  that "undefined compares equal to undefined" must stop being load-bearing.

### REM-2 — Session rows are still written with blind full-row puts

- **Severity:** low
- **Location:** `ccp/api/src/routes/auth.ts:507` (reauth stamp);
  `ccp/api/src/routes/account.ts:117` (enrolment secret), `:161` (cleared session)
- **Description:** CONC-3 covered the *account* row and every write to it is now guarded.
  The `SessionItem` rows in the same handlers were left as unconditional puts — the finding
  scoped itself to the account row, and nothing else covers them. Each does the same
  read-modify-write over an `await`, so two concurrent writes to one session row lose one.
- **Impact:** Materially smaller than CONC-3: a session row carries `reauthAt`, an enrolment
  secret and its clearing. The plausible harm is a lost `reauthAt` stamp (a re-auth the user
  performed not being recorded, so they are challenged again) or an enrolment secret
  overwritten by a concurrent enrolment start. Neither crosses a trust boundary, which is
  why this is low rather than a sibling of CONC-3.
- **Recommendation:** Give `SessionItem` the same treatment: a version attribute bumped on
  every write and an `ifEquals` guard, reusing the `putAccountGuarded` shape. The store
  primitive already exists — `ifEquals` on the standalone put was added for CONC-3.
