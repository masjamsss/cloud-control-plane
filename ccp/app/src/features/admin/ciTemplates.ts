/**
 * Ready-to-commit CI files for step 4 of the onboarding wizard ("Connect the
 * repo's CI") — one per host tab. The job they describe: on every merge to
 * the repository's default branch, regenerate the project data
 * (scripts/gen-project-data.sh — inventory + block sources, bundled and
 * digest-stamped) and PUT it to the control plane with the minted upload key,
 * where it waits STAGED until an admin reviews and activates it (step 5). The
 * control plane never checks out the repository; the repo's own CI runs next
 * to the code and only sends the generated files.
 *
 * THE CONTENT IS THE REAL LANE'S, VERBATIM: these strings mirror
 * `.github/workflows/ccp-data.yml` and
 * `.gitlab/ci/ccp-data.gitlab-ci.yml` in the control-plane repository
 * (spec: docs/runbooks/account-data-ci.md), byte-for-byte —
 * test/projectsLifecycle.test.ts reads those files and fails on any drift.
 * The project id is NOT baked into the file: it rides the repo-side
 * {@link PROJECT_ID_VAR} variable, so one file text serves every project.
 *
 * The names are deliberate and pinned by tests: the key is read from the
 * environment as a CI secret, never interpolated into a command line where a
 * CI log would print it.
 */

/** Where the GitHub workflow file goes in the estate repository. */
export const GITHUB_CI_PATH = '.github/workflows/ccp-data.yml';
/** The GitLab job file — copy it in (or `include:` it) from the repo root. */
export const GITLAB_CI_PATH = '.gitlab/ci/ccp-data.gitlab-ci.yml';
/** The CI secret the minted upload key is pasted into (both hosts). */
export const UPLOAD_KEY_SECRET = 'CCP_UPLOAD_TOKEN';
/** The CI variable naming the control plane's address (both hosts). */
export const SERVER_URL_VAR = 'CCP_CONTROL_PLANE_URL';
/** The CI variable naming the project id (both hosts). */
export const PROJECT_ID_VAR = 'CCP_PROJECT_ID';
/** Optional: the Terraform root to scan (default environments/prod). */
export const SCAN_ROOT_VAR = 'CCP_SCAN_ROOT';

/* ── the onboarding lane (wizard step 2, "Run in the repo's CI" tab) ─────────
 *
 * The FIRST-scan workflow (design: docs/superpowers/specs/2026-07-24-easy-first-import.md,
 * option A) — dispatch-only, prescan-only: no terraform, no `--trusted-commit`, no cloud
 * secret. Unlike the data lane above, this one PUTs straight to
 * `PUT /projects/:id/trust-request` over a narrow, pre-trust-only onboarding
 * token — never {@link UPLOAD_KEY_SECRET}; the two credentials' lifetimes
 * never overlap (I10). The wizard mints that token (one-time reveal, same UX
 * as the upload key) and links straight to the host's dispatch page. Running
 * this workflow is optional and reversible: an operator who prefers a laptop
 * keeps the "Run locally" tab (projectsFlow.ts's `onboardCommand`), unchanged.
 *
 * THE CONTENT IS THE REAL LANE'S, VERBATIM: these strings mirror
 * `.github/workflows/ccp-onboard.yml` and
 * `.gitlab/ci/ccp-onboard.gitlab-ci.yml` in the control-plane repository,
 * byte-for-byte — test/projectsLifecycle.test.ts reads those files and fails
 * on any drift. {@link SERVER_URL_VAR} and {@link PROJECT_ID_VAR} are the
 * SAME repo-side variables the data lane already reads — one project only
 * ever needs one control-plane address and one id, whichever lane is asking.
 */

/** Where the GitHub onboarding workflow file goes in the estate repository. */
export const GITHUB_ONBOARD_CI_PATH = '.github/workflows/ccp-onboard.yml';
/** The GitLab onboarding job file — copy it in (or `include:` it) from the repo root. */
export const GITLAB_ONBOARD_CI_PATH = '.gitlab/ci/ccp-onboard.gitlab-ci.yml';
/** The CI secret the minted ONBOARDING token is pasted into (both hosts) — a
 * separate name and credential from {@link UPLOAD_KEY_SECRET}: this one only
 * works pre-trust, and only for this one project's trust-request upload. */
export const ONBOARD_KEY_SECRET = 'CCP_ONBOARD_TOKEN';

/** The GitHub Actions workflow, ready to commit at {@link GITHUB_CI_PATH}. */
export function githubDataWorkflow(): string {
  return `# Control-plane per-account portal data, generated in CI and
# uploaded to the control plane. Spec: docs/runbooks/account-data-ci.md.
#
# This is the GitHub half of seamless account onboarding: on every merge to
# the default branch the estate's Terraform is re-scanned (inventory + block
# sources), bundled, and PUT to the control plane, where it is STAGED until an
# admin activates it. No laptop run, no app rebuild.
#
# All logic and every version pin live in scripts/gen-project-data.sh — this
# file only sets up the pinned interpreters (read from the script itself) and
# keeps the bundle as a run artifact for the air-gapped/manual-upload case.
#
# Per-repo setup (details: docs/runbooks/account-data-ci.md):
#   secret   CCP_UPLOAD_TOKEN        per-project upload key (minted in the
#                                       portal under Admin → Projects)
#   variable CCP_CONTROL_PLANE_URL   e.g. https://ccp.example.com/api
#                                       (unset = generate only, keep artifact)
#   variable CCP_PROJECT_ID          the control-plane project id
#   variable CCP_SCAN_ROOT           optional; default environments/prod —
#                                       if that root doesn't exist on disk (this
#                                       repo ships no estate tree of its own),
#                                       gen-project-data.sh prints one line and
#                                       exits 0; the artifact step below is
#                                       already tolerant of finding nothing
#                                       (if-no-files-found: warn)
#
# Action pins follow the repo-wide convention (checkout@v4 / setup-node@v4).

name: ccp-data

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      project_id:
        description: "Project id (default: the CCP_PROJECT_ID repo variable)"
        required: false
        type: string
      tf_root:
        description: "Terraform root to scan (default: CCP_SCAN_ROOT variable, else environments/prod)"
        required: false
        type: string

permissions:
  contents: read

# Never cancel an in-flight upload; a superseding push just runs after it.
concurrency:
  group: ccp-data-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  generate-and-upload:
    name: generate + upload project data
    if: \${{ vars.CI_RUNNER != '' }} # estate-side job: runs only where a deployment configures vars.CI_RUNNER — this public repo ships it as a TEMPLATE and the job stays skipped here (see the header comment)
    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      # Foreign estate repo (Terraform lives here, the generators live in the
      # control-plane repo)? Uncomment this second checkout — the next step
      # finds the script under .ccp-tools/ automatically.
      # - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      #   with:
      #     repository: <owner>/<control-plane-repo>
      #     token: \${{ secrets.CCP_TOOLS_READ_TOKEN }} # read-only PAT
      #     path: .ccp-tools

      - name: Locate gen-project-data.sh and read its version pins
        id: pins
        run: |
          if [ -f scripts/gen-project-data.sh ]; then
            SCRIPT=scripts/gen-project-data.sh
          elif [ -f .ccp-tools/scripts/gen-project-data.sh ]; then
            SCRIPT=.ccp-tools/scripts/gen-project-data.sh
          else
            echo "::error title=ccp-data::gen-project-data.sh not found. Estate repos must also check out the control-plane repo (see the commented step above and docs/runbooks/account-data-ci.md)."
            exit 1
          fi
          echo "script=$SCRIPT" >> "$GITHUB_OUTPUT"
          bash "$SCRIPT" --print-pins >> "$GITHUB_OUTPUT"

      - uses: actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0
        with:
          python-version: "\${{ steps.pins.outputs.python_series }}"

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "\${{ steps.pins.outputs.node_major }}"

      - name: Generate project data and upload to the control plane
        env:
          CCP_CONTROL_PLANE_URL: \${{ vars.CCP_CONTROL_PLANE_URL }}
          CCP_UPLOAD_TOKEN: \${{ secrets.CCP_UPLOAD_TOKEN }}
          CCP_PROJECT_ID: \${{ inputs.project_id || vars.CCP_PROJECT_ID }}
          CCP_SCAN_ROOT: \${{ inputs.tf_root || vars.CCP_SCAN_ROOT || 'environments/prod' }}
        run: bash "\${{ steps.pins.outputs.script }}" --install-deps --out "$RUNNER_TEMP/ccp-data-out"

      # Manual-upload fallback: if the control plane was unreachable (or no URL
      # is configured yet) the job above exits 0 and the bundle lands here —
      # docs/runbooks/account-data-ci.md \u00A7Manual fallback walks the hand upload.
      - name: Keep the bundle as a run artifact
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: ccp-project-data
          path: \${{ runner.temp }}/ccp-data-out
          retention-days: 14
          if-no-files-found: warn
`;
}

/** The GitLab job, ready to copy in at {@link GITLAB_CI_PATH} (and wire into
 * the repository's .gitlab-ci.yml with an \`include:\`). */
export function gitlabDataPipeline(): string {
  return `# Control-plane per-account portal data, generated in CI and
# uploaded to the control plane. GitLab twin of
# .github/workflows/ccp-data.yml; spec: docs/runbooks/account-data-ci.md.
#
# Use from a GitLab-hosted estate repo: copy this file in (or \`include:\` it if
# the control-plane repo is mirrored on the same GitLab), then set under
# Settings → CI/CD → Variables (details: docs/runbooks/account-data-ci.md):
#
#   CCP_UPLOAD_TOKEN        masked + protected — per-project upload key,
#                              minted in the portal under Admin → Projects
#   CCP_CONTROL_PLANE_URL   e.g. https://ccp.example.com/api
#                              (unset = generate only, keep the artifact)
#   CCP_PROJECT_ID          the control-plane project id
#   CCP_SCAN_ROOT             optional; default environments/prod
#
# A protected variable only reaches pipelines on PROTECTED refs — protect the
# default branch or the job dies with "CCP_UPLOAD_TOKEN is empty".
#
# All logic and every version pin (python 3.12, node 20, python-hcl2==5.1.1)
# live in scripts/gen-project-data.sh. The image below is the one host-side
# duplicate of those pins GitLab forces on us (an \`image:\` cannot be computed
# by a script); if it ever drifts, the script's own pin check fails the job
# loudly before anything is generated or uploaded.

ccp-data:
  # python 3.12 + node 20 in one image, matching the script's pins. Self-hosted
  # runners in air-gapped estates should mirror this image (and may pin it by
  # digest) in their own registry.
  image: nikolaik/python-nodejs:python3.12-nodejs20
  rules:
    # Every merge to the default branch, same as the GitHub template. This
    # also covers manually started (Run pipeline) runs on that branch — the
    # workflow_dispatch equivalent.
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
  variables:
    # Shallow clone: build-inventory.py's git-derived sourceCommit/generatedAt
    # then equal the built commit — same behavior as actions/checkout's
    # default fetch-depth 1, so both hosts stamp identical provenance.
    GIT_DEPTH: "1"
    CCP_OUT_DIR: "$CI_PROJECT_DIR/ccp-data-out"
  before_script:
    # No-ops on the image above (it ships git + curl); keeps the job alive on
    # a slimmed self-hosted mirror.
    - command -v curl >/dev/null && command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates)
  script:
    # Same-repo layout (the control-plane repo itself) or a foreign estate
    # that cloned the tools into .ccp-tools/ — same resolution as the
    # GitHub template.
    - |
      if [ -f scripts/gen-project-data.sh ]; then
        SCRIPT=scripts/gen-project-data.sh
      elif [ -f .ccp-tools/scripts/gen-project-data.sh ]; then
        SCRIPT=.ccp-tools/scripts/gen-project-data.sh
      else
        echo "gen-project-data.sh not found — estate repos must also clone the control-plane repo into .ccp-tools/ (see docs/runbooks/account-data-ci.md)" >&2
        exit 1
      fi
      bash "$SCRIPT" --install-deps
  artifacts:
    # Manual-upload fallback: on an unreachable control plane the script exits
    # 0 and the bundle is kept here for a hand upload
    # (docs/runbooks/account-data-ci.md \u00A7Manual fallback).
    when: always
    name: ccp-project-data
    paths:
      - ccp-data-out/
    expire_in: 14 days
`;
}

/** The GitHub Actions onboarding workflow, ready to commit at {@link GITHUB_ONBOARD_CI_PATH}. */
export function githubOnboardWorkflow(): string {
  return `# The FIRST onboarding scan for a new Cloud Control Plane project, run once
# in the estate repo's own CI instead of on a laptop. Design and full
# background: ccp/docs/onboarding-runbook.md and ccp/docs/onboarding-security.md
# in the control-plane repository. This is a SIBLING of the recurring data
# lane (.github/workflows/ccp-data.yml), not a replacement for it: same
# vars.CI_RUNNER skip-guard, same .ccp-tools/ checkout pattern, same "keep the
# artifact regardless" fallback. Dispatch only — an operator clicks "Run
# workflow" after minting a short-lived onboarding token in Admin → Projects
# (wizard step 2, "Run in the repo's CI" tab).
#
# THE TRUST BOUNDARY THIS WORKFLOW MUST NEVER CROSS
# (ccp/docs/onboarding-security.md is the full contract):
#   - PRESCAN ONLY. catalogctl onboard is invoked with NO --trusted-commit, so
#     the run stops at the trust gate by construction, before any terraform
#     call — nothing from this untrusted repo is ever executed.
#   - NO TERRAFORM. There is no terraform setup step anywhere in this file.
#   - NO CLOUD SECRET. Nothing below references an AWS/GOOGLE/ARM credential —
#     only the narrow, pre-trust-only CCP_ONBOARD_TOKEN.
#   - permissions: contents: read — this workflow only ever reads the repo.
# Do not add a --trusted-commit re-run to this workflow, ever, without first
# shipping the sandboxed container (tools/catalogctl/sandbox/) that invariant
# requires for running any external repo's schema step (I7).
#
# Per-repo setup (details: ccp/docs/onboarding-runbook.md):
#   secret   CCP_ONBOARD_TOKEN       the short-lived, single-purpose onboarding
#                                       token minted in Admin → Projects (shown
#                                       once at mint) — a SEPARATE credential
#                                       from CCP_UPLOAD_TOKEN (the recurring
#                                       data lane's key below); it can only PUT
#                                       this one project's trust-request, and
#                                       only before that project is trusted
#   variable CCP_CONTROL_PLANE_URL   e.g. https://ccp.example.com/api
#                                       (unset = scan only, keep the artifact)
#   variable CCP_PROJECT_ID          the control-plane project id (must still
#                                       be draft or pending-trust — minting the
#                                       token above already checked that)
#
# Action pins: checkout/upload-artifact as ccp-data.yml pins them; go setup as
# .github/workflows/catalogctl.yml pins it.

name: ccp-onboard

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  scan-and-upload:
    name: prescan + upload trust request
    if: \${{ vars.CI_RUNNER != '' }} # estate-side job: runs only where a deployment configures vars.CI_RUNNER — this public repo ships it as a TEMPLATE and the job stays skipped here (see the header comment)
    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    steps:
      # Shallow (default fetch-depth 1) is enough — the scan only ever needs
      # HEAD, never history.
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      # Foreign estate repo (catalogctl's source lives in the control-plane
      # repo, not here)? Uncomment this second checkout — the next step finds
      # it under .ccp-tools/ automatically. The control-plane repo's own
      # self-onboarding (and importer/bootstrap, the self-trusted in-repo root
      # — onboarding-security.md's "in-repo exception") needs no second
      # checkout: tools/catalogctl is already on disk.
      # - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      #   with:
      #     repository: <owner>/<control-plane-repo>
      #     token: \${{ secrets.CCP_TOOLS_READ_TOKEN }} # read-only PAT
      #     path: .ccp-tools

      - name: Locate the catalogctl module
        id: locate
        run: |
          if [ -f tools/catalogctl/go.mod ]; then
            DIR=tools/catalogctl
          elif [ -f .ccp-tools/tools/catalogctl/go.mod ]; then
            DIR=.ccp-tools/tools/catalogctl
          else
            echo "::error title=ccp-onboard::catalogctl module not found. Estate repos must also check out the control-plane repo (see the commented step above and ccp/docs/onboarding-runbook.md)."
            exit 1
          fi
          echo "dir=$DIR" >> "$GITHUB_OUTPUT"

      - uses: actions/setup-go@v5
        with:
          go-version-file: \${{ steps.locate.outputs.dir }}/go.mod

      - name: Build catalogctl
        working-directory: \${{ steps.locate.outputs.dir }}
        run: go build -o "$RUNNER_TEMP/catalogctl" ./cmd/catalogctl

      - name: Prescan the repository and upload the trust request
        env:
          CCP_CONTROL_PLANE_URL: \${{ vars.CCP_CONTROL_PLANE_URL }}
          CCP_ONBOARD_TOKEN: \${{ secrets.CCP_ONBOARD_TOKEN }}
          CCP_PROJECT_ID: \${{ vars.CCP_PROJECT_ID }}
        run: |
          "$RUNNER_TEMP/catalogctl" onboard "$GITHUB_WORKSPACE" --project-id "$CCP_PROJECT_ID" --out "$RUNNER_TEMP/ccp-onboard-out" --server "$CCP_CONTROL_PLANE_URL"

      # Manual-upload fallback: if the control plane was unreachable (or no
      # URL is configured yet) the two scan files still land here — pick them
      # from this artifact in the wizard's "Run locally" tab (Admin → Projects,
      # step 2) exactly as a local run's output.
      - name: Keep the scan artifacts as a run artifact
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: ccp-onboard-out
          path: \${{ runner.temp }}/ccp-onboard-out
          retention-days: 14
          if-no-files-found: warn
`;
}

/** The GitLab onboarding job, ready to copy in at {@link GITLAB_ONBOARD_CI_PATH} (and wire into
 * the repository's .gitlab-ci.yml with an `include:`). */
export function gitlabOnboardPipeline(): string {
  return `# The FIRST onboarding scan for a new Cloud Control Plane project — GitLab
# twin of .github/workflows/ccp-onboard.yml. Design and full background:
# ccp/docs/onboarding-runbook.md and ccp/docs/onboarding-security.md in the
# control-plane repository.
#
# GitLab has no per-workflow "Run workflow" button the way GitHub does, so
# this ships as a \`when: manual\` job on the default branch: from CI/CD →
# Pipelines → "Run pipeline" (on the default branch), this job appears with a
# play button once that pipeline starts — click it to run the scan. Copy this
# file in (or \`include:\` it if the control-plane repo is mirrored on the same
# GitLab), then set under Settings → CI/CD → Variables (details:
# ccp/docs/onboarding-runbook.md):
#
#   CCP_ONBOARD_TOKEN       masked + protected — the short-lived,
#                              single-purpose onboarding token minted in
#                              Admin → Projects (shown once at mint) — a
#                              SEPARATE credential from CCP_UPLOAD_TOKEN (the
#                              recurring data lane's key)
#   CCP_CONTROL_PLANE_URL   e.g. https://ccp.example.com/api
#                              (unset = scan only, keep the artifact)
#   CCP_PROJECT_ID          the control-plane project id (must still be draft
#                              or pending-trust — minting the token above
#                              already checked that)
#
# A protected variable only reaches pipelines on PROTECTED refs — protect the
# default branch or the job dies with "CCP_ONBOARD_TOKEN is empty".
#
# THE TRUST BOUNDARY THIS JOB MUST NEVER CROSS
# (ccp/docs/onboarding-security.md is the full contract):
#   - PRESCAN ONLY. catalogctl onboard is invoked with NO --trusted-commit, so
#     the run stops at the trust gate by construction, before any terraform
#     call — nothing from this untrusted repo is ever executed.
#   - NO TERRAFORM. There is no terraform setup step anywhere in this job.
#   - NO CLOUD SECRET. Nothing below references an AWS/GOOGLE/ARM credential —
#     only the narrow, pre-trust-only CCP_ONBOARD_TOKEN.
# Do not add a --trusted-commit re-run to this job, ever, without first
# shipping the sandboxed container (tools/catalogctl/sandbox/) that invariant
# requires for running any external repo's schema step (I7).

ccp-onboard:
  # Mirrors tools/catalogctl/go.mod's \`go 1.25\` pin (ccp/toolbox/Dockerfile
  # pins the identical tag) — GitLab can't compute an image tag from a script
  # the way the GitHub workflow's setup-go/go-version-file does; a too-old
  # self-hosted mirror fails the build loudly instead of silently, since a
  # go.mod \`go\` directive is a hard minimum. Self-hosted/air-gapped runners
  # should mirror this image (and may pin it by digest) in their own registry.
  image: golang:1.25-bookworm
  rules:
    # Same ref as the recurring data lane's own rule — the default branch —
    # but \`when: manual\` means it never runs on its own; it waits on the play
    # button (see the header comment).
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
      when: manual
  variables:
    # Shallow clone — the scan only ever needs HEAD, never history; same
    # depth actions/checkout defaults to on the GitHub side.
    GIT_DEPTH: "1"
  before_script:
    # No-op on the image above (golang:*-bookworm ships git); keeps the job
    # alive on a slimmed self-hosted mirror, mirroring ccp-data.gitlab-ci.yml's
    # own guard.
    - command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends git ca-certificates)
  script:
    # Same-repo layout (the control-plane repo itself) or a foreign estate
    # that cloned the tools into .ccp-tools/ — same resolution as the GitHub
    # workflow.
    - |
      if [ -f tools/catalogctl/go.mod ]; then
        DIR=tools/catalogctl
      elif [ -f .ccp-tools/tools/catalogctl/go.mod ]; then
        DIR=.ccp-tools/tools/catalogctl
      else
        echo "catalogctl module not found — estate repos must also clone the control-plane repo into .ccp-tools/ (see ccp/docs/onboarding-runbook.md)" >&2
        exit 1
      fi
      go build -C "$DIR" -o /tmp/catalogctl ./cmd/catalogctl
      /tmp/catalogctl onboard "$CI_PROJECT_DIR" --project-id "$CCP_PROJECT_ID" --out "$CI_PROJECT_DIR/ccp-onboard-out" --server "$CCP_CONTROL_PLANE_URL"
  artifacts:
    # Manual-upload fallback: on an unreachable control plane the two scan
    # files are still kept here — pick them from this artifact in the
    # wizard's "Run locally" tab (Admin → Projects, step 2).
    when: always
    name: ccp-onboard-out
    paths:
      - ccp-onboard-out/
    expire_in: 14 days
`;
}
