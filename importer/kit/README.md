# importer/kit — the reusable new-environment importer

The parameterized machinery for taking a NEW environment (new account, region,
or env like staging/dev) from zero → imported Terraform code → ready for
Cloud Control Plane onboarding. `importer/prod` + `importer/docs` are the *archive* of how
prod was imported; this kit is that procedure made runnable. The human runbook
that drives it end-to-end: [docs/runbooks/new-env-import.md](../../docs/runbooks/new-env-import.md).
Design + limits are documented inline below (the original design record is an internal doc, not published).

```
kit/
├── services.json     resource-type allowlist (DATA): per type, the read-only list
│                     call, record/id/name extraction, service file, phase, stateful
├── discover.sh       LIVE capture driver — the ONLY thing that talks to AWS
│                     (read-only list/describe; account-mismatch guard; --dry-run;
│                     + one account-wide coverage sweep, see below)
├── discover.py       captures -> discovery-manifest.json (offline, stdlib-only)
├── gen-imports.py    manifest -> imports.tf, prod-archive conventions (stdlib-only)
├── normalize.py      scaffold / split / guard / check (needs python-hcl2)
├── verify.sh         acceptance gates: fmt clean, validate clean, plan import-only
│                     or no-op — the same bar the prod import met
├── templates/        versions/providers/variables/main/backend/tfvars — pins
│                     IDENTICAL to environments/prod (TF ~> 1.10, aws = 6.53.0)
├── testdata/         recorded synthetic captures + stub aws/terraform binaries
│                     (fixture account 111111111111 — the kit NEVER needs real AWS to test)
└── tests/            python3 -m unittest discover -s importer/kit/tests
```

## 60-second fixture demo (no AWS, no credentials)

```bash
python3 importer/kit/discover.py build \
  --capture-dir importer/kit/testdata/capture-happy \
  --out /tmp/kit-demo/discovery-manifest.json
python3 importer/kit/gen-imports.py \
  --manifest /tmp/kit-demo/discovery-manifest.json --out /tmp/kit-demo/imports.tf
head -30 /tmp/kit-demo/imports.tf
```

## Pipeline (one line per phase — the runbook has the full procedure)

1. **Discover** (read-only creds): `discover.sh --region R --account A --out work/<env>/` → captures + `discovery-manifest.json`. Everything undiscoverable is IN the manifest (`missing_captures`, `unmapped_captures`, `manual_followup`, `coverage`) — gaps are loud, never silent.
2. **Curate**: edit labels/dispositions in the manifest (mechanical labels are HCL-safe; prod's were hand-polished).
3. **Generate**: `gen-imports.py` → `imports.tf`; `normalize.py scaffold` → root files; copy both into `environments/<env>/`; `terraform plan -generate-config-out=generated.tf`.
4. **Normalize**: `normalize.py split` (per-service files) → `guard` (prevent_destroy on stateful) → `check` (secret-literal refusal battery, canonical `catalog/redaction-rules.json`).
5. **Verify + apply**: `verify.sh --phase import` (plan must be *N to import, 0/0/0*), PR, apply with the state-writer credential, archive `imports.tf` to `importer/<env>/`, `verify.sh --phase steady`.
6. **Hand off to Cloud Control Plane**: `catalogctl onboard environments/<env> ...` — the kit's output boundary is a clean, committed Terraform root; catalogs/inventory are onboard's job (0022 §G4).

## From imported root to onboarded estate — the portal bridge

The kit's job ends at step 6 above: a clean, plannable Terraform root and the
first `catalogctl onboard` scan. Everything downstream is the SAME
register → trust → CI-generate/upload → activate ladder every account rides —
including the very first one onboarded onto a fresh install (data-birth,
the data-birth onboarding design (internal design doc, not published)
§6 — there is no first-account shortcut, no separate path for "the estate that
came with the install"):

1. **Register** the project in Admin → Projects (a draft; grants nothing yet).
2. **Scan locally, credential-free** (step 6 above): `catalogctl onboard
   environments/<env> --project-id <id> --out out/` writes
   `trust-request.json` + `prescan-report.json`; upload both in the wizard.
3. **Trust** (two admins): a Lead reviews the verdict and proposes trust; a
   second, different admin acknowledges it under Admin → Pending changes.
   Only a clean verdict can be trusted.
4. **Generate and upload the estate's data**: install
   `.github/workflows/ccp-data.yml` (or the GitLab twin) in the estate
   repo that now holds `environments/<env>/` — full setup in
   [docs/runbooks/account-data-ci.md](../../docs/runbooks/account-data-ci.md).
   Every merge to its default branch re-scans that Terraform root and PUTs a
   staged data bundle (inventory + block sources) to the control plane.
   Generation is deterministic CI tooling, never portal-triggered and never
   AI-assisted (ADR-0007) — the portal only stages what CI uploads.
5. **Activate** (two admins): a second admin activates the staged version —
   the project flips ready, appears in the project switcher, and is served
   at runtime. No app rebuild, no redeploy.

The full operator walkthrough — wizard steps, the status ladder, and the
failure-mode table — is
[ccp/docs/onboarding-runbook.md](../../ccp/docs/onboarding-runbook.md).
Nothing in this bridge grants an apply path: onboarding a data plane and
applying Terraform changes are separate lanes end to end (the manual PR lane's
gated apply, [docs/cicd.md](../../docs/cicd.md), is untouched by any of this).

## Extending coverage

Add an entry to `services.json` (`types`, schema documented in the file), author
a fixture capture under `testdata/capture-happy/`, extend the tests. Types that
need more than ONE list call belong under `manual` — they surface in every
manifest as `manual_followup` instead of silently missing.

## Coverage sweep (account-wide, best-effort)

The 44-type allowlist above only enumerates what `services.json` names. Before
this section existed, a resource of ANY other type in the account was
invisible to the kit — not even counted, a silent gap in a tool whose whole
design point is "gaps are loud, never silent." `discover.sh` closes that by
running one extra, non-allowlisted capture — `aws resourcegroupstaggingapi
get-resources` — alongside the normal per-type calls (same `AWS_BIN` seam,
`--dry-run` preview, and account-mismatch/`FAILED` handling as every
allowlisted capture; it is appended to the capture plan, not a parallel code
path). `discover.py build` then diffs every swept ARN's *family* — the ARN
service-namespace segment (`arn:partition:FAMILY:region:account:resource`,
e.g. `ec2`, `s3`, `sagemaker`) — against `services.json`'s `types[*].arnHint`
(auto-discoverable) and `manual[*].arnHints` (documented long-tail gaps), and
writes the result into every manifest:

```json
"coverage": {
  "method": "resourcegroupstaggingapi (taggable resources only)",
  "captured": true,
  "totalSwept": 128,
  "coveredTypes": [{"family": "ec2", "count": 94}],
  "manualTypes": [{"family": "sagemaker", "count": 3}],
  "unrecognizedArnFamilies": [
    {"family": "kinesis", "count": 2, "sampleArn": "arn:aws:kinesis:ap-southeast-5:REDACTED:stream/..."}
  ]
}
```

A non-empty `unrecognizedArnFamilies` prints a loud, impossible-to-miss
`WARN: N resource(s) in M unrecognized ARN families — NOT imported, extend
services.json` on stderr — but it never fails discovery. This is a report,
not a gate: a resource type the kit does not know about yet must not block
importing the ones it does.

**Stated limits, honestly:**

- **Taggable resources only.** `resourcegroupstaggingapi` only sees resources
  that support resource-level tags; a handful of AWS resource types are not
  taggable (or not exposed through this API) at all and stay just as
  invisible to the sweep as they were before it existed. `coverage.method`
  says so on every manifest — this is a wide net, not an exhaustive one.
- **Family is the ARN service namespace, not the Terraform type.** One AWS
  service backs many Terraform types (`ec2` alone covers `aws_vpc`,
  `aws_subnet`, `aws_security_group`, `aws_instance`, `aws_ebs_volume`, ...),
  so the sweep reliably catches a wholly NEW service appearing in the
  account, but NOT a new resource type inside a service that is already
  covered by something else. This was the deliberate half of a two-way
  choice: `services.json` carries a hand-verified `arnHint` per type (data,
  matching how every other extension point in this file works) rather than
  mechanically parsing a finer per-resource-type token out of each ARN —
  AWS's ARN resource-type token uses inconsistent delimiters across services
  (`/` for most, `:` for e.g. Lambda/RDS) and is sometimes absent entirely
  (bare S3 bucket / SNS topic ARNs), so a finer parser would trade one
  simple, always-correct rule for many fragile, service-specific ones. A
  coarser net that never claims false precision beat a finer one that could
  be quietly wrong; extending precision later is a data change (add a
  narrower `arnHint`), not a redesign.
- **A few long-tail `manual` types have no verified `arnHint` yet** (e.g.
  License Manager, EC2 Instance Connect Endpoint, AWS Config's recorder/
  delivery channel) — left unmapped ON PURPOSE rather than guessed, so they
  would surface as an unrecognized family instead of a silently-assumed
  (and possibly wrong) match. See `services.json` `manual[*].arnHints`.

## Testing

```bash
python3 -m unittest discover -s importer/kit/tests -v
```

Fixture-driven, subprocess-style (mirrors `ccp/app/scripts/test_build_inventory.py`);
stub `aws`/`terraform` binaries under `testdata/stub-bin/` let the SHELL scripts'
logic run in tests with zero network and zero real toolchain.

## Hard rules

- Tests and fixtures NEVER touch AWS or `environments/**`. The live path is
  `discover.sh` only, with read-only credentials, run by a human.
- Capture dirs contain real resource IDs → keep them under `work/` (gitignored)
  or outside the repo.
- Nothing here applies Terraform. The import apply is a human, PR-reviewed step
  with the scoped state-writer credential (`importer/state-writer-policy.json`).
