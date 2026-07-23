# Runbook: onboarding a Terraform repository as an Cloud Control Plane project

> Audience: a Lead (with admin capability) bringing a new estate repo under
> Cloud Control Plane. Companion documents: `onboarding-security.md` (the trust boundary and
> WHY each gate exists), `specs/ccp-api.md` §11 (the api contract), and
> Admin → Projects in the app, which walks these same five steps interactively.
>
> Two humans are required end to end: the Lead driving the flow, and a second
> admin who confirms the trust decision (and any deregistration) under
> Admin → Pending changes. There is no single-person path to a trusted project,
> by design.
>
> **The first account onboards exactly this way too.** A fresh install ships with zero
> estates — there is no baked-in "starter" account and no shortcut for "the estate that came
> with the install" ([ADR-0020](../../docs/adr/0020-ccp-data-birth-blank-install.md)). The
> app's first-run screen, shown whenever nothing is onboarded yet, is this same ladder's front
> door, not a second implementation of it. A solo evaluation-mode instance cannot get past
> step 4 (trust) or step 5 (activate) below — both are 2-admin envelopes — until a second admin
> is seated; the first-run screen says so rather than silently offering a demo in its place
> (the sample estate remains available as an explicit, labeled "just exploring" option).
>
> **Naming the instance comes first, ahead of this ladder** ([ADR-0023](../../docs/adr/0023-ccp-instance-identity.md)).
> The same first-run screen opens with an instance-identity card (name + optional tagline) —
> installer-seeded or the generic default, admin-editable in place, and skippable (the generic
> default is a valid identity). The installer also asks at deploy time
> (`setup.sh env --name`, or `intranet-setup.sh`'s wizard); either way it is renameable anytime
> after under Admin → Settings, with no rebuild and no redeploy.

## What you need before starting

- A local checkout of the repository to onboard, and a `terraform` binary that
  satisfies the repo's `required_version`.
- The `catalogctl` binary (`go build ./tools/catalogctl/cmd/catalogctl`).
- A shell **without cloud credentials** — the scan refuses to run if any
  `AWS_*`, `GOOGLE_*`, `ARM_*`, or `TF_TOKEN_*` variable is present. This is the
  sandbox contract, not a nuisance: onboarding must not be able to touch a real
  backend or authenticate anywhere.
- An Cloud Control Plane session as a Lead with admin capability, and a second admin
  available for the dual-control confirmations.

## Step 1 — register the project (Admin → Projects)

Fill in the "Add a project" form: project id (short lowercase slug), display
name, GitHub owner and repository, the 12-digit AWS account id, and the AWS
region. For an Azure estate, the same step asks instead for the tenant id, the
subscription id (both GUIDs), and the location — the subscription is defined
here, at onboarding, not beforehand. This creates a **draft** — a draft grants
nothing: it is not a valid request scope and no account can be bound to it.

## Step 2 — scan the repository locally

Run the command the wizard shows (copy button provided):

```
catalogctl onboard <path-to-your-checkout> --project-id <id> --out out/
```

The scan parses every `*.tf` and `*.tf.json` statically — nothing executes —
and stops at the trust gate, writing two files into `out/`:

- `trust-request.json` — `{repo, commitSha, prescanSha256}`. The sha is the
  fingerprint of the report bytes; the trust decision binds to it.
- `prescan-report.json` — the verdict, every finding, and the census (resource
  blocks, module count, JSON-syntax files, unformatted files, provider pins).
  Written on **both** verdicts, so a rejection's findings are reviewable too.

Upload both files in the wizard (paste each file's full contents exactly as
written). The server recomputes the report's sha256 and refuses the upload if
it does not match the trust request — if you see `PRESCAN_SHA_MISMATCH`, you
pasted edited or truncated bytes; re-copy the whole file.

## Step 3 — review the verdict and findings

The wizard renders the server's stored copy of the report: the verdict badge,
a findings table (rule, file, line), and the census. Read it. This review is a
human decision and stays one — nothing scores, summarizes, or auto-proceeds.

- **Rejected?** Full stop. No trust control renders, and the api refuses a
  trust call regardless (`TRUST_VERDICT_NOT_CLEAN`). Fix the findings in the
  repo (each code is documented in `onboarding-security.md`), commit, and
  return to step 2.
- Note the census warnings: module-sourced resources are not imported, and
  unformatted files should be normalized with a one-time `terraform fmt`
  pull request in the source repo (Cloud Control Plane never reformats imported files).

## Step 4 — trust the commit (two admins)

The trust panel shows the exact commit and report fingerprint being trusted.
Confirming **proposes** the decision; it applies only when a second, different
admin acknowledges it under Admin → Pending changes. If someone re-uploads scan
artifacts while the proposal is pending, the acknowledgment fails with
`STALE_PROPOSAL` — the decision can never silently attach to different bytes.

Once acked, the project is **trusted** and the audit chain carries
`Trusted repo for onboarding` with the commit and fingerprint.

## Step 5 — generate data and finish

1. Re-run the scan with the trusted commit (the wizard shows this command):

   ```
   catalogctl onboard <path-to-your-checkout> --project-id <id> --trusted-commit <sha> --out out/
   ```

   Only now does the sandboxed `terraform init -backend=false` +
   `providers schema` run, writing `providers-schema.json` and printing the
   scaffold checklist.

2. Mint an upload token for this project (the wizard's "Connect the repo's CI" step — a Lead
   with admin capability; the token is shown once, so copy it immediately). Install the
   recurring CI job in the estate repo with that token as a secret —
   `docs/runbooks/account-data-ci.md` has the full setup. Project data (inventory and block
   sources) is regenerated **by CI only** on every merge to the repo's default branch — do not
   generate it on a laptop; local runs are not reproducible (the `python-hcl2` pin is a CI
   contract) — and `PUT` to the control plane as a staged version. Nothing is served yet.

3. Review and activate the staged version (the wizard's "Review & activate data" step). The
   server recomputes and stores its own digests over the uploaded bundle — there is nothing to
   type. A **second**, different admin activating it is what flips the project to **ready**: it
   appears in the project switcher, becomes a valid request scope, and accounts can be bound to
   it.

4. Define this account's teams and their service ownership (Admin → Teams, on the newly-ready
   project's scope). Not required to reach `ready`, but required before a plain requester can
   submit anything: with no teams defined yet, approvers and leads can already request (they
   bypass team scoping), while a requester with no owning team can submit nothing — the correct
   fail-closed default for a brand-new estate, not a bug
   ([ADR-0022](../../docs/adr/0022-ccp-teams-per-estate-onboarding.md)).

## Status ladder (what each state permits)

| Status | Meaning | Grants |
|---|---|---|
| draft | registered, nothing verified | nothing |
| pending-trust | scan artifacts uploaded and sha-verified | nothing |
| trusted | a clean verdict trusted by two admins | the CLI's post-trust run |
| ready | data digests recorded | routable scope; account bindings; switcher entry |

## Undoing things

- **Wrong artifacts uploaded?** Re-upload (allowed while draft/pending-trust);
  the upload is audited each time.
- **Trusted the wrong commit, or the repo must be re-scanned after trust?**
  There is deliberately no in-place re-aim: deregister the project (also a
  two-admin envelope) and onboard afresh. Deregistering removes the registry
  entry and routability — request history and the audit chain are never erased.

## Failure modes and their meanings

| Symptom | Meaning | Fix |
|---|---|---|
| CLI: `REFUSE PRESCAN_REJECT` | the repo contains a construct the scan refuses (see the findings) | fix the repo; findings are in `prescan-report.json` and reviewable in the wizard |
| CLI: `REFUSE UNTRUSTED_COMMIT` | HEAD moved since the trust ack | re-run steps 2–4 for the new commit |
| CLI: refuses with a credential name | cloud credentials in the environment | unset them; the scan must run credential-free |
| Upload: `PRESCAN_SHA_MISMATCH` | pasted report bytes differ from what the CLI hashed | re-copy the full, unmodified file |
| Trust: `TRUST_VERDICT_NOT_CLEAN` | the stored verdict is reject | there is nothing to trust; fix and re-scan |
| Ack: `STALE_PROPOSAL` | artifacts changed between propose and ack | review the new upload, propose again |
| Complete: `STATE_CONFLICT` | project is not in the trusted state | walk the earlier steps first |

## Settling a pre-data-birth instance (the one-time cutover)

This section is for an instance that was already running **before** the blank-install change
([ADR-0020](../../docs/adr/0020-ccp-data-birth-blank-install.md)/[ADR-0021](../../docs/adr/0021-ccp-control-scope-and-settlement.md))
landed — this repository's own deployment included, whose estate has always gone by a fixed
legacy project id. Nothing here is a manual step an operator runs: it happens automatically, once, the
first time the new api code boots against that store.

**What settlement does.** On first boot (and lazily on the first request thereafter, guarded by
an on-disk marker so it only ever runs once — `ccp/api/src/domain/settlement.ts`):

1. **Retro-registers the estate**, iff the store shows a real legacy footprint (team, request,
   or audit-chain rows under the old legacy-project-id partitions) and no registry row exists for it yet: a
   `ProjectItem` for that legacy id (`status:'ready'`) is written — **without** a trust block. That estate
   never passed prescan trust, and settlement records that honestly rather than backfilling a
   trust it never earned. A genuinely blank store (no legacy footprint) is left alone — no
   phantom project is invented.
2. **Materializes every bare account row** (the pre-`roles`-map legacy shape) into an explicit
   `roles` map — exactly what the retired authorization shim used to compute for it live, so
   every already-bound account's effective permissions are unchanged before and after.
3. Both writes audit onto the **`@control`** chain, since this is control-plane bookkeeping —
   the historical legacy-project audit chain is immutable and untouched.

**Cutover ordering**, for standing up this repository's own instance on the new code: deploy the
new api (settlement runs — the legacy project id is retro-registered and reads as `ready`, but with no active
data version yet) → mint an upload token for it → run this repository's own
`ccp-data.yml`/CI data lane (this repo *is* the legacy project's own data repo; the lane already exists —
`docs/runbooks/account-data-ci.md`) → a second admin activates the staged version → deploy the
blank app build. Until activation, the app's "ready, no activated data yet" state (visible on
the first-run/projects screen) renders honestly instead of showing an empty or stale estate.

**What settlement does not do.** It does not run the trust ceremony retroactively — the legacy
project settles as trust-less-with-a-marker, by design (spec O5's recommended minimum). Running the
full `catalogctl onboard` + 2-admin trust ceremony over this repository as a stronger follow-up
is an open owner decision, not required for the cutover above.

**A note on the sample estate's id.** Before the sample estate's own id was split out
([ADR-0020](../../docs/adr/0020-ccp-data-birth-blank-install.md)), the legacy project id and
the labeled **sample estate** the SPA carries as a demo fixture were the same value, so
activating a fresh `ccp-data.yml` upload for the legacy project id had no visible effect: the
app resolved that id's catalog/inventory from the frozen bundled capture regardless of api mode.
That is no longer the case — the sample estate now has its own distinct id
(`ccp/app/src/lib/httpApi.ts`'s `SAMPLE_ESTATE_ID` resolution), so the legacy project id
activates and resolves through the normal server-backed data plane like any other onboarded
project. Still, verify against the current code before relying on this operationally.
