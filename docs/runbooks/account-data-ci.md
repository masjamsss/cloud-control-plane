# Runbook: account data CI — regenerate + upload portal data on every merge

> Audience: whoever operates an onboarded account/estate repo. Covers the recurring CI job
> that keeps that account's inventory and block sources fresh in the portal. Companion:
> [`ccp/docs/onboarding-runbook.md`](../../ccp/docs/onboarding-runbook.md) (first onboarding).

## What this job does

When a change merges to an onboarded repo's main branch, a small CI job re-reads
that repo's Terraform and sends the control plane a fresh copy of its portal
data — the resource inventory and the block sources the portal shows. Nothing
runs on a laptop, and the portal app is never rebuilt for it.

The moving parts:

| Piece | Where | Role |
|---|---|---|
| `scripts/gen-project-data.sh` | control-plane repo | The one shared script: checks the toolchain pins, runs both generators, builds one upload bundle, PUTs it to the control plane. **Every version pin lives here** (python 3.12, node 20, `python-hcl2==5.1.1`). |
| `.github/workflows/ccp-data.yml` | GitHub repos | Thin wrapper: pinned checkout/setup steps, then the script. Runs on every push to `main` + manual dispatch. |
| `.gitlab/ci/ccp-data.gitlab-ci.yml` | GitLab repos | The same job for GitLab: one pinned python+node image, then the script. Runs on the default branch. |

What the control plane receives is **staged, not live**: an admin still reviews
and activates it in the portal (Admin → Projects). Uploading grants nothing by
itself.

> **Contract note.** The upload endpoint — `PUT <control-plane>/projects/<id>/data`
> with an `Authorization: Bearer <upload key>` header, body = the bundle
> described below — is owned by the control-plane api. Until that endpoint is deployed
> for your instance, runs without a configured URL still generate the bundle and keep
> it as a build artifact, so nothing here blocks on it.

## The bundle (schema `ccp.project-data.v1`)

One JSON document, assembled deterministically from the two generators' output:

```
{
  "schema":    "ccp.project-data.v1",
  "projectId": "<id>",
  "summary":   { generatedAt, sourceCommit, sourceRepo, sourceRef,
                 ci{host,runId,runUrl,commit},
                 counts{resources, blockChunks, blockAddresses},
                 providerPins, toolchain, inventoryRun{...full generator summary} },
  "inventory": { ...inventory.json exactly as build-inventory.py wrote it },
  "blocks":    { "index": {address → chunk}, "chunks": {chunk → blocks} }
}
```

`sourceCommit`/`generatedAt` come from git (deterministic), not the wall clock.
Block sources are redacted at generation time by the same redactor the app
uses — secrets never enter the bundle. The out dir also carries
`bundle.sha256` (quote it when asking an admin to cross-check a staged upload)
and `upload-status.json` (what the upload attempt concluded).

## Setting it up on a GitHub repo

1. Copy `.github/workflows/ccp-data.yml` into the estate repo. If the estate repo is not
   the control-plane repo, also uncomment the second checkout step in it so the tools
   land in `.ccp-tools/` (needs a read-only PAT as `CCP_TOOLS_READ_TOKEN`).
2. Settings → Secrets and variables → Actions:
   - **Secret `CCP_UPLOAD_TOKEN`** — the project's upload key (minting: below).
   - **Variable `CCP_CONTROL_PLANE_URL`** — the api's base URL, e.g.
     `https://ccp.<your-domain>/api`. Leave unset to run in generate-only mode.
   - **Variable `CCP_PROJECT_ID`** — the project id from Admin → Projects.
   - **Variable `CCP_SCAN_ROOT`** — only if the Terraform root is not
     `environments/prod`.
3. Merge something (or run the workflow manually) and watch the job.

## Setting it up on a GitLab repo

1. Copy `.gitlab/ci/ccp-data.gitlab-ci.yml` into the estate repo (or
   `include:` it if the control-plane repo is mirrored on the same GitLab) and
   wire it into `.gitlab-ci.yml`.
2. Settings → CI/CD → Variables — same four names as GitHub. Mark
   `CCP_UPLOAD_TOKEN` **masked and protected**. Protected variables only
   reach protected refs, so make sure the default branch is protected — on the
   Free tier that protection is the only gate in front of this token, so treat
   branch-protection settings as part of the security posture.
3. Self-hosted/air-gapped runners: mirror the job's image
   (`nikolaik/python-nodejs:python3.12-nodejs20`) into your registry. The
   script re-checks the real python/node/python-hcl2 versions at runtime and
   refuses to generate on a drifted image, so a stale mirror fails loudly, not
   silently.

## Minting the upload key

In the portal: **Admin → Projects → (the project) → upload key**. The key is
per-project — it can only stage data for that one project, and staging is all
it can do (no reads, no approvals, no applies). Paste it into the host's
secret store (step 2 above), never into the repo. Re-mint it there too if it
ever leaks; re-minting invalidates the old key.

## Manual fallback (air-gapped estates, or the endpoint not deployed yet)

If the control plane can't be reached, the job stays green, says so, and keeps
the bundle as a build artifact (`ccp-project-data`, 14 days). To finish by
hand from any machine that can reach the control plane:

```bash
# download + unzip the artifact first
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $CCP_UPLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @ccp-data-out/bundle.json \
  "$CONTROL_PLANE_URL/projects/<project-id>/data"
```

Then have an admin activate it in the portal as usual.

## When it fails

| Symptom | Meaning | Fix |
|---|---|---|
| `toolchain does not match the pins` | CI image/setup drifted from python 3.12 / node 20 / python-hcl2 5.1.1 | Fix the image or setup step; never skip the check for a real upload |
| `CCP_UPLOAD_TOKEN is empty` | Secret not set, or (GitLab) protected variable on an unprotected branch | Set the secret; protect the default branch |
| HTTP 401/403 in the response body | Wrong or revoked upload key | Re-mint in Admin → Projects, update the secret |
| HTTP 404/422 | Wrong project id, or the control plane doesn't have the upload endpoint yet | Check `CCP_PROJECT_ID`; check the api version |
| `control plane unreachable`, job green | Air-gap/DNS/timeout — the designed fallback | Use the artifact + manual upload above |
| Wrong resources in the bundle | Job scanned the wrong root | Set `CCP_SCAN_ROOT` |
| One-line message, job green, nothing generated | The scan root doesn't exist yet on this checkout | Set `CCP_SCAN_ROOT` (or `--root`) once your Terraform exists there |

**On the "no committed default estate" design.** Nothing about this job assumes a
pre-loaded sample: a fresh Cloud Control Plane install ships with no estate at all, and
`inventory.json`/`blocks/` bundled with the app are a labeled **sample** fixture, never a
privileged default that real account data could be confused with — see
[ADR-0029](../adr/0029-ccp-data-birth-blank-install-public-summary.md). This job (and its
GitLab twin) is the **only** freshness contract for a project's data: what an admin
activates in the portal is exactly what this job just generated and uploaded, on the pins
it printed via `--print-pins`. There is no committed copy to go stale against.
