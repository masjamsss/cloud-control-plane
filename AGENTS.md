# AGENTS.md

Orientation and operating contract for AI coding agents working in this repository.
**Read this file completely before acting.** It identifies where authority lives, which
documents to load for a task, which commands prove a change, and which rules are hard
refusals rather than preferences.

**Authority order.** [`PRD.md`](PRD.md) is the single source of truth for what this product
is; if any other document disagrees with it, the PRD wins. Settled decisions live in the
[ADR ledger](docs/adr/README.md). [`docs/FUNDAMENTALS.md`](docs/FUNDAMENTALS.md) is the map
of which document owns which topic — **read it before writing any documentation.**

The PRD and ADRs describe product intent and accepted decisions; they do not prove that a
feature is shipped. For current behavior, inspect the implementation, its tests, and the
code-derived docs together. If they disagree, report the discrepancy instead of silently
choosing the most convenient source.

## Start every session here

Do this once at the start of a new session, before editing:

1. Run `git status --short --branch`. Existing changes belong to the user; preserve them
   and do not rewrite, discard, stage, or commit them unless the task explicitly includes
   that work.
2. Read [`README.md`](README.md), [`PRD.md`](PRD.md),
   [`CONTRIBUTING.md`](CONTRIBUTING.md), and
   [`docs/FUNDAMENTALS.md`](docs/FUNDAMENTALS.md). These are the minimum orientation set,
   not optional background.
3. Use `FUNDAMENTALS.md` and the repository map below to open only the documents, ADRs,
   schemas, and component READMEs relevant to the task. Do **not** read every Markdown file
   indiscriminately; the audit reports and historical ADRs are large and often describe
   superseded or deliberately unresolved states.
4. Inspect the affected code and tests before proposing a change. Search first (`rg`,
   `rg --files`); do not infer current behavior from filenames, an old line citation, or a
   planning statement.
5. If the task touches an area named in [`docs/audit/FINDINGS.md`](docs/audit/FINDINGS.md),
   read the applicable finding, its triage batch, and any fix/residue entry before editing.
   The audit ledger may contain known constraints that are not obvious from the code.
6. Decide the smallest relevant validation set before editing, then run it after editing.
   For cross-layer or safety-sensitive work, run the full applicable gate rather than only
   the nearest unit test.

For a read-only question, the same authority and routing rules apply, but do not install
dependencies, generate artifacts, or mutate external systems merely to produce an answer.

## What this repository is

A self-service change-management control plane for Terraform-managed cloud estates (AWS
and Azure today; GCP proposed). An operator fills in a form → people approve it →
the tool deterministically writes the Terraform → it becomes a pull/merge request →
automated gates verify the plan matches exactly what was reviewed → it applies to that one
account.

The repository holds **the product, never an estate**. A real cloud estate is always a
separate private repository that gets onboarded. A fresh install ships blank: organisation,
accounts, teams, and catalog data all arrive through first-run setup and onboarding.

## Repository map

| Path | What it is | Toolchain |
|---|---|---|
| [`ccp/app`](ccp/app) | The SPA — Vite + React 19, TypeScript-strict. Manifests → interpreter → form → review/diff → submit. Runs standalone against a bundled in-memory mock. | Node ≥ 20 |
| [`ccp/api`](ccp/api) | The authoritative backend — Node + Hono. Sessions (argon2id, httpOnly cookies, TOTP), server-enforced authz, hash-chained audit, durable `FileStore`. | Node ≥ 22 |
| [`tools/catalogctl`](tools/catalogctl) | Go HCL codemod — **the only thing that writes Terraform**. Also `onboard`, `pr-prepare`, `plan-check`. | Go 1.25 |
| [`tools/schemadump`](tools/schemadump) | Provider-schema reflector — the `ForceNew` ground truth provider docs get wrong. | Go |
| [`importer/kit`](importer/kit), [`importer/kit-azure`](importer/kit-azure) | Import-first onboarding kits for adopting an existing environment. | Python 3.11+ |
| [`catalog/`](catalog) | Redaction rules + provider capability ledgers that manifests are checked against. | — |
| [`scripts/`](scripts) | [`gate.sh`](scripts/gate.sh) (local CI mirror), [`publish-gate.sh`](scripts/publish-gate.sh) (estate-literal scanner), findings and docs gates. | Bash / Python |
| [`docs/`](docs) | [ADRs](docs/adr/README.md), [`FUNDAMENTALS.md`](docs/FUNDAMENTALS.md), the [functional test plan](docs/FUNCTIONAL-TEST-PLAN.md), the [engineering audit ledger](docs/audit/README.md). | — |
| [`ccp/docs/`](ccp/docs) | Code-derived product docs: API spec, domain model, permissions, settings, error states. | — |

Component-level detail lives in each component's own README — [`ccp/README.md`](ccp/README.md)
(how the three fit together, mock vs api mode, adopting a foreign repo),
[`ccp/api/README.md`](ccp/api/README.md) (the deploy reference: env vars, preflight,
backup/restore), [`tools/catalogctl/README.md`](tools/catalogctl/README.md) (subcommands,
refusal codes, exit-code contract). Don't restate them; link to them.

### Task-specific reading

After the minimum orientation set, use this table rather than guessing what to load:

| If the task concerns… | Read before editing |
|---|---|
| Frontend navigation, forms, or visual behavior | [`ccp/app/README.md`](ccp/app/README.md), the relevant feature/component and tests, [ADR-0014](docs/adr/0014-ccp-ledger-redesign.md); add [`PERMISSIONS.md`](ccp/docs/PERMISSIONS.md) for anything role-gated |
| API routes, authentication, or authorization | [`ccp/api/README.md`](ccp/api/README.md), [`ccp/api/openapi/ccp-api.yaml`](ccp/api/openapi/ccp-api.yaml), [`PERMISSIONS.md`](ccp/docs/PERMISSIONS.md), [`ERROR-STATES.md`](ccp/docs/ERROR-STATES.md), and the route/middleware tests |
| Persistence, concurrency, audit, backup, or restore | [`DOMAIN-MODEL.md`](ccp/docs/DOMAIN-MODEL.md), [`ccp/api/docs/PERFORMANCE.md`](ccp/api/docs/PERFORMANCE.md), and the matching topics in [`docs/audit/`](docs/audit/README.md) |
| Catalog manifests or Terraform edits | [`MAINTAINING-THE-CATALOG.md`](ccp/docs/MAINTAINING-THE-CATALOG.md), [`tools/catalogctl/README.md`](tools/catalogctl/README.md), provider safety data, and the nearest golden/manifest tests |
| Provider schema or `forcesReplace` behavior | [`tools/schemadump/README.md`](tools/schemadump/README.md), [`tools/schemadump/COMPARISON.md`](tools/schemadump/COMPARISON.md), and the provider-version pins consumed by the target |
| Onboarding, scanner, or importer flows | [`ccp/docs/onboarding-runbook.md`](ccp/docs/onboarding-runbook.md), [`ccp/docs/onboarding-security.md`](ccp/docs/onboarding-security.md), ADRs [0031](docs/adr/0031-ccp-first-scan-in-estate-ci.md)–[0033](docs/adr/0033-ccp-zero-touch-first-scan.md), and the applicable importer README |
| Deployment, environment variables, or operations | [`ccp/docs/go-live.md`](ccp/docs/go-live.md), [`ccp/api/README.md`](ccp/api/README.md), [`SECURITY.md`](SECURITY.md), and the compose/setup script being changed |
| A product or architectural decision | The relevant PRD section, [`docs/FUNDAMENTALS.md`](docs/FUNDAMENTALS.md), the ADR ledger, and every ADR being superseded |

## Prove your change

`scripts/gate.sh` is the local mirror of CI. **Run the section that covers what you touched
before you push**, and the whole thing for anything cross-cutting:

```bash
./scripts/gate.sh          # go + api + app + python + tf-fmt   (default)
./scripts/gate.sh go       # tools/catalogctl: build, vet, test, gofmt
./scripts/gate.sh api      # ccp/api: typecheck, test
./scripts/gate.sh app      # ccp/app: typecheck, test, build, contrast, help:check, verify:safety
./scripts/gate.sh py       # importer/kit, importer/kit-azure, ccp/app/scripts (pytest)
./scripts/gate.sh full     # + terraform validate/checkov + the install smoke
```

Component commands, when you want a tighter loop:

```bash
cd ccp/app && npm ci && npm run dev      # :5173, bundled mock — no backend needed
                 npm test                # vitest
                 npm run typecheck       # tsc --noEmit
                 npm run help:check      # every op needs a help string (CI-blocking)
                 npm run verify:safety   # ForceNew, single-provider, genericity gates

cd ccp/api && npm ci && npm run dev      # tsx watch, dev posture
                 npm test && npm run typecheck

cd tools/catalogctl && go build ./... && go vet ./... && go test ./...
```

Doc-only changes still have gates: `python3 scripts/docs-link-check.py` (every relative
markdown link must resolve) and, for anything under `docs/audit/`,
`bash scripts/findings-gate.sh`.

**Toolchain traps.** Node ≥ 22 satisfies both packages' `engines` ranges, but it does not
reproduce every CI lane: `gate.sh` deliberately **skips** the app's `lint`/`format:check`
unless local Node is exactly 20 (the app CI version), while the API and install smoke require
Node ≥ 22. A skip is not a pass. The Python gate requires `python-hcl2` and `pytest` and
fails rather than skipping when they're missing — install with the pin read out of
`scripts/gen-project-data.sh`. The scanner-worker security suite expects a scanner-image-like
environment with no Terraform binary or cloud credentials available; do not weaken that
preflight merely to make a developer machine green.

## Hard rules

These are refusals, not style preferences. Many are machine-enforced; the rest are reviewed
governance constraints. Working around an enforcement or omitting the test that proves it is
never the fix.

1. **Keep it estate-agnostic.** No organisation name, account id, region, person, hostname,
   or workload belongs in shared code, tests, docs, or the catalog. Real values are operator
   configuration and first-run input. Placeholders are `Sample`/`Example`, account
   `123456789012`, `example.com`. Enforced by `npm run verify:safety`
   (`ccp/app/scripts/verify-source-genericity.ts`) and by `scripts/publish-gate.sh`, which
   scans tracked *and* untracked-not-ignored files — so a leak is caught before you
   `git add`. In app source under `src/` the same gate also bans the section sign `§` and
   `ADR-0NNN` references (internal notation) and any hardcoded brand literal.
2. **`catalogctl` is the only thing that writes Terraform.** Neither `app` nor `api` may
   edit `.tf` files; both go through `catalogctl edit` / `pr-prepare`. Its edits are
   golden-tested and its exit codes are the contract (`0` ok · `2` refusal · `3`
   resolution/schema error · `1` internal). Guards exit 2 with a greppable
   `REFUSE <CODE>: <reason>` rather than writing a half-safe change.
3. **Fixtures and golden files are the law.** Regenerate outputs from inputs through the
   test harness; never hand-edit a golden to make a test pass. If an oracle looks wrong,
   stop and say so instead of adjusting it.
4. **`forcesReplace` is verified against reflected schema, not prose.** Provider docs have
   been measured wrong about in-place updates. `tools/schemadump`'s dump is the ground
   truth; regenerate the ForceNew map (`npx vite-node scripts/build-forcenew-map.ts
   --provider <aws|azure>`) rather than trusting documentation.
5. **No AI on the path of a change.** Forms, validation, code-writing, and gates are pure
   deterministic lookups — no model, no network, at build time or runtime
   ([ADR-0007](docs/adr/0007-gerbang-no-ai.md)). You may write code here; your code may not
   call a model. An advisory add-on may suggest, never act.
6. **A person approves every request, and there is no bypass lane.** Don't add one — not a
   debug flag, not an admin shortcut, not a test-only escape that ships.
7. **One fact, one home.** Extend the document that already owns a topic. Create a new doc
   only when no row in [`docs/FUNDAMENTALS.md`](docs/FUNDAMENTALS.md) covers it, and add its
   row in the same commit. A doc unreachable from that map is a bug.
8. **ADRs are immutable history.** Never rewrite one. Copy
   [`docs/adr/template.md`](docs/adr/template.md), take the next number, add a ledger row,
   and update the superseded ADR's status line.
9. **The three AWS `redaction-rules.json` copies are byte-identical** — `catalog/`,
   `ccp/app/src/data/`, `tools/catalogctl/internal/hclops/`. Change one, change all three;
   a sync test in both engines checks it. (`catalog/azure-redaction-rules.json` is its own
   separate file.)
10. **Never operate a live estate from a development or agent session.** Do not run
    `terraform apply`, `terraform destroy`, or `terraform import` against a real estate; do
    not issue cloud-provider write commands; and do not approve a deployment, arm an apply
    lane, or invoke a production bundle as part of repository validation. The supported
    apply path is reviewed and gated CI. Local work stops at static analysis, isolated
    fixtures, build/test, and explicitly scoped read-only inspection.
11. **Treat secrets and runtime state as out of scope for source changes.** Never commit,
    print, or copy real `.env` values, credentials, onboarding/upload tokens, TOTP material,
    Terraform state/plans, `.ccp-data`, or `/data/ccp` contents. Do not bootstrap an instance
    or generate deployment configuration unless the user explicitly asks for deployment
    work and provides the target context. Examples and fixtures must use the neutral
    placeholders from rule 1.
12. **Do not turn aspirational behavior into a shipped claim.** ADRs can be Proposed,
    Accepted-but-unbuilt, partially built, or off by default. Preserve those distinctions in
    code, docs, reviews, and summaries; verify status from the current tree and tests.

## Common changes, and what each one drags with it

- **Add a catalog op or service.** Follow the recipes in
  [`ccp/docs/MAINTAINING-THE-CATALOG.md`](ccp/docs/MAINTAINING-THE-CATALOG.md) — it lists
  every invariant and the gate that enforces it. A new manifest needs `serviceMeta` +
  icon registration, team ownership, `help` on every param, prose that is estate-generic,
  new `inventory://` types declared, and a regenerated ForceNew map. Keep ops in the shared
  catalog; per-project manifests are the exception, not the default.
- **Change an API route.** `ccp/api/openapi/ccp-api.yaml` is authoritative and a parity test
  keeps the contract honest; [`ccp/docs/API-SPEC.md`](ccp/docs/API-SPEC.md) is the derived
  summary, while route code is the runtime behavior. A disagreement among them is a defect
  to reconcile, not permission to pick one silently. Authz belongs on the server — the
  SPA's checks are UX, never the enforcement point
  ([`ccp/docs/PERMISSIONS.md`](ccp/docs/PERMISSIONS.md) says per row who enforces).
- **Add or change a setting.** [`ccp/docs/SETTINGS-CATALOG.md`](ccp/docs/SETTINGS-CATALOG.md)
  is generated from code. There is no separate feature-flag system — change-freeze and
  per-op disable *are* the flags.
- **Touch the domain or an error state.** [`DOMAIN-MODEL.md`](ccp/docs/DOMAIN-MODEL.md) and
  [`ERROR-STATES.md`](ccp/docs/ERROR-STATES.md) are code-derived with file:line evidence and
  each ends with a "Regenerate / verify" section — re-run it instead of editing the table.
- **Work an audit finding.** The ledger under [`docs/audit/`](docs/audit/README.md) is
  binding: `FINDINGS.md` (status per finding), `FIXES.md` (required before anything is marked
  `fixed`), `LESSONS.md` (must cite a real finding). `scripts/findings-gate.sh` ratchets the
  open count downward — it can never rise.
- **Make a decision.** If it changes architecture, write the ADR. Don't bury a decision in a
  commit message.

## Pull requests

- One focused change per PR; say what and why.
- Green gates for every component you touched — paste the failure if something legitimately
  cannot pass locally, and name what you skipped and why. Never report a skipped gate as a
  pass.
- Update the doc that owns the behaviour you changed, in the same PR.
- Everything needs review ([`CODEOWNERS`](CODEOWNERS)); vulnerabilities go through
  [`SECURITY.md`](SECURITY.md), never a public issue.
- Naming: the display name is **Cloud Control Plane**, the identifier slug is **ccp**. A
  deployed instance's displayed name is operator-set and changeable
  ([ADR-0023](docs/adr/0023-ccp-instance-identity.md)); code identifiers (`ccp/` paths,
  `CCP_*` env vars, package and css names) never rebrand. ADRs numbered 0005–0011 keep the
  old "gerbang" codename — they are dated records, not a rename to finish.

## Before you finish

1. Review `git diff --check`, `git diff`, and `git status --short`. Confirm the diff contains
   only intended work and no generated runtime state, secrets, or unrelated user changes.
2. Run the applicable gates named above. If a gate cannot run, say exactly why and identify
   the CI lane or environment that remains authoritative; never translate “not run,”
   “skipped,” or “timed out” into “passed.”
3. Reconcile every behavior change with its canonical documentation, OpenAPI/schema surface,
   and tests. Do not update a generated/code-derived table without running its own verify
   recipe.
4. Report the outcome first: what changed, what was verified, and what remains risky or
   unverified. Do not claim the repository is clean or the task complete while required work
   remains.
