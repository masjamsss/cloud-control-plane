# Fundamentals map — standard doc names → where they live here

You're looking for a standard project document (PRD, domain model, permissions matrix…).
This table says where it lives in this repo — or why it deliberately does not exist as a
separate file.

**This file is the first stop for every documentation task — read, then write:**

- **Reading / answering a question?** Find the topic here, open its canonical home, and
  answer from that. Don't answer from memory or a scattered older doc without reconciling
  against the home this table names.
- **Have something new to record?** It goes **into** its existing home — extend that file,
  don't spread a new one. Create a new file **only** when no row here covers the topic, and
  then add its row to this table in the same commit (and banner anything it supersedes). A
  doc that isn't reachable from this map is a bug, not a document.

Every fact gets exactly one home; a second copy is how docs rot.

> **Note for public readers.** This project grew inside a private monorepo. Its internal
> planning archive (dated specs, plans, proposals, working-branch names) is not published;
> dated ADRs may cite those records by path — treat such citations as historical footnotes,
> not links. Everything a user or contributor needs lives in the homes below.

| Standard name | Where it lives here | Verdict |
|---|---|---|
| PROJECT_VISION.md | [PRD.md](../PRD.md) §"What Cloud Control Plane is" (repo-wide: [README.md](../README.md) intro) | Folded in — vision and requirements share one owner and one page; splitting invites drift |
| PRD.md | [PRD.md](../PRD.md) | **Exists** (root fundamental) |
| DOMAIN_MODEL.md | [ccp/docs/DOMAIN-MODEL.md](../ccp/docs/DOMAIN-MODEL.md) | **Exists** — generated from code with file:line evidence |
| DATABASE.md | DOMAIN-MODEL.md §Persistence | Folded in — there is no SQL database; the durable store is a keyed FileStore (deliberate) |
| API_SPEC.md | [ccp/api/openapi/ccp-api.yaml](../ccp/api/openapi/ccp-api.yaml) (source of truth) + [ccp/docs/API-SPEC.md](../ccp/docs/API-SPEC.md) (derived summary) | **Exists** — the YAML is authoritative; a parity test keeps code honest |
| UI_UX.md | [ADR-0010](adr/0010-gerbang-look-and-feel.md) (foundations) + [ADR-0014](adr/0014-ccp-ledger-redesign.md) (the binding Ledger visual language) | Exists as decisions — don't add a rival |
| USER_FLOW.md | [PRD.md](../PRD.md) §"one change, start to finish" (screen-level: [ccp/app/README.md](../ccp/app/README.md) §The journey) | Folded in |
| EVENT_CATALOG.md | DOMAIN-MODEL.md §Event catalog | Folded in — audit-event kinds are part of the domain model |
| FEATURE_FLAGS.md | [ccp/docs/SETTINGS-CATALOG.md](../ccp/docs/SETTINGS-CATALOG.md) | Folded in — change-freeze and per-op disable ARE the flags; no separate flag system (deliberate) |
| SETTINGS_CATALOG.md | [ccp/docs/SETTINGS-CATALOG.md](../ccp/docs/SETTINGS-CATALOG.md) | **Exists** — generated from code |
| PERMISSIONS.md | [ccp/docs/PERMISSIONS.md](../ccp/docs/PERMISSIONS.md) (decision: [ADR-0013](adr/0013-ccp-approval-ladder-2fa.md)) | **Exists** — generated from code; says per row who enforces (SPA vs server) |
| ERROR_STATES.md | [ccp/docs/ERROR-STATES.md](../ccp/docs/ERROR-STATES.md) | **Exists** — generated from code |
| DECISIONS.md | [ADR ledger](adr/README.md) | **Exists** — one numbered ADR per decision |
| PROJECT_INIT_CHECKLIST.md | [ccp/docs/onboarding-runbook.md](../ccp/docs/onboarding-runbook.md) + [importer/kit/README.md](../importer/kit/README.md) (AWS) + [importer/kit-azure/README.md](../importer/kit-azure/README.md) (Azure, under [ADR-0015](adr/0015-ccp-azure-second-provider.md)) + [ccp/README.md](../ccp/README.md) §Adopt in a foreign repo + [docs/runbooks/account-data-ci.md](runbooks/account-data-ci.md) (the recurring per-account data CI job) | Exists under its own names — onboarding an account/estate IS project init here |
| BOOTSTRAP_LIFECYCLE.md (day-zero / governance birth) | ADRs [0017](adr/0017-ccp-bootstrap-lifecycle.md) · [0018](adr/0018-ccp-founding-quorum.md) · [0019](adr/0019-ccp-day-zero-threat-model.md) | **Exists** as decisions. Data-birth counterpart: [ADR-0029, public summary](adr/0029-ccp-data-birth-blank-install-public-summary.md) |
| BRANDING.md / WHITE_LABEL.md | [ADR-0023](adr/0023-ccp-instance-identity.md) (the storage/timing decision); display-name vs `ccp`-slug split: [PRD.md](../PRD.md) naming banner; settings/routes: [SETTINGS-CATALOG.md](../ccp/docs/SETTINGS-CATALOG.md) §Global instance identity | **Exists** — instance display identity is operator-set; code identifiers never rebrand |
| ACCOUNT_SECURITY.md (self-service credentials: password change, multi-device 2FA, recovery codes, re-auth, sessions) | ADRs [0024](adr/0024-ccp-multi-device-totp.md) · [0025](adr/0025-ccp-recovery-codes.md) · [0026](adr/0026-ccp-reauth-gate.md); route/field detail: [API-SPEC.md](../ccp/docs/API-SPEC.md) §Account self-service, [PERMISSIONS.md](../ccp/docs/PERMISSIONS.md) §10, [DOMAIN-MODEL.md](../ccp/docs/DOMAIN-MODEL.md), [ERROR-STATES.md](../ccp/docs/ERROR-STATES.md) | **Exists, landed** — standing "Account & security" page, self password change, named multi-device 2FA, recovery codes, re-auth gate, self-service sessions, full mock/standalone parity |
| ESTATE_CONFIG.md / SETUP_SETTINGS.md (first-setup estate settings: id, display name, provider identity/region, operating timezone) | [ADR-0028](adr/0028-ccp-estate-settings-at-setup.md); setting rows: [SETTINGS-CATALOG.md](../ccp/docs/SETTINGS-CATALOG.md) | **Exists** as decision — estate specifics are operator data, never product constants |
| TEST_PLAN.md | [docs/FUNCTIONAL-TEST-PLAN.md](FUNCTIONAL-TEST-PLAN.md) | **Exists** — journey-by-journey functional plan with exact expected results (codes, statuses, ports, exit codes), operator/role/cross-layer perspectives, traceability to the automated suites, and a 10-case smoke subset |
| ROADMAP.md / WORKLOG.md / IDEAS.md | — | Deliberately none in the public tree — live planning happens in the maintainers' private archive; git history is the worklog |

**Adding a new fundamental later:** check this map first; give the fact one home; if it
supersedes something, banner the loser (`> SUPERSEDED YYYY-MM-DD — see <successor>.`);
add a row here and, if repo-wide, to the README Key-documents table. Code-derived docs
(domain model, permissions, settings, errors, API summary) each end with a
"Regenerate / verify" section — re-run those commands instead of trusting the tables
after code changes.
