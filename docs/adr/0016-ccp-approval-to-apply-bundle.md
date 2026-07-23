# ADR-0016 — The approval-to-apply bundle: portal-gated direct-to-main + one-click gated apply

- **Status:** Accepted (owner decision, 2026-07-20)
- **Refines:** [ADR-0012](0012-ccp-auto-apply.md) (auto-apply direction — this is its first
  buildable increment) · [ADR-0013](0013-ccp-approval-ladder-2fa.md) (the ladder stays the
  human review)
- **Supersedes (in part):** the PR-lane wording in earlier docs that made a GitHub pull request
  the *only* path for a portal change. The manual hand-written-HCL lane keeps its PR flow
  unchanged.

## Decision

For a **fully approved** portal request, the operator sees **one bundle**: the portal (not a
human) turns the approval into a Terraform change on `main` and offers **Apply** on the
approval page. Mechanics, in order, all server-side:

1. **Local gate** — the api re-derives the change with `catalogctl` into a scratch checkout
   and runs the plan-check gates (R1–R6, digest) there. Red ⇒ the bundle stops; nothing is
   committed; the request is marked needs-attention.
2. **Direct commit to `main`** — the gated TF edit + the request evidence (request YAML +
   plan digest) are committed and pushed to `main` with an operator-provisioned bot
   credential. Fast-forward only; if `main` moved mid-bundle, re-gate and retry; never force.
3. **Gated CI apply, triggered from the approval page** — the push fires the existing
   `terraform.yml` (CI re-plans in a neutral environment); the apply job still waits at the
   **gated `prod` GitHub Environment**. The portal's **Apply** click is what satisfies that
   gate (via the GitHub deployment-approval API using the bot credential registered as an
   environment reviewer). The gate itself is not removed.

## Why this is acceptable (the review duty moves, it does not disappear)

- The **portal approval ladder (ADR-0013)** — risk-based approvers, 2FA on riskier
  sign-offs, server-enforced authz, hash-chained audit — *is* the human review of the change.
- The **plan gates run twice**: locally before anything is committed (step 1) and again in
  CI on `main` (step 3) — reviewed-plan≡applied-plan is enforced by digest both times.
  **Owner requirement, binding:** the plan must contain the approved CCP change and
  *nothing else* — the R-gates scope the plan to the approved addresses, the digest pins its
  exact content, and the commit is a compare-and-swap on the gated SHA, so nothing can slip
  in between the gate and the apply; any interleaving change re-locks the apply.
- The **apply gate remains**: `environment: prod` still holds every apply; the portal click
  is an *audited approval of that gate*, not a bypass of it.
- What is consciously given up: a human reading the raw diff in a GitHub PR for portal-lane
  changes, and branch-protection's require-PR rule for the bot's pushes. The owner accepts
  this for the portal lane only; the manual lane is unchanged.

## Guardrails (binding on the implementation)

- **Off by default.** The whole bundle arms only behind explicit env (`CCP_BUNDLE=1` +
  the git/GitHub credentials); unset ⇒ the endpoint refuses and nothing changes on deploy —
  the same load-bearing invariant as the apply scheduler (loop.ts).
- **The api never runs `terraform apply`** in this lane — apply stays in gated CI.
  (The in-process TerraformExecutor remains a separate, proof-milestone opt-in.)
- Every step lands in the per-project **audit chain** (gate result, commit SHA, gate-approval).
- Change-freeze (`freeze.global`) blocks the bundle like any other mutation.
- The bot credential is operator-provisioned, least-privilege (push to `main` + environment
  review), never committed — registered in the api/README credentials table.

## Consequences

- `SECURITY.md`'s "every change lands via PR" sentence is amended to name the two lanes.
- [Proposal 0018](../proposals/0018-enablement-deployment-unresolved.md) tracks the rollout
  (credentials, environment-reviewer registration, first live bundle).
- The SPA approval page gains the bundle status + Apply control (spec:
  `docs/superpowers/specs/2026-07-20-ccp-approval-to-apply-bundle.md`).
