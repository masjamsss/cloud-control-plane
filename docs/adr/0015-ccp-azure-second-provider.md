# ADR-0015: Azure as the second cloud provider — provider is a property of a project

**Status:** Accepted
**Date:** 2026-07-17
**Deciders:** repo owner
**Evidence:** [proposal 0039](../proposals/0039-azure-second-provider-concept.md) (assessment +
concept; four-census appendix). Numbering note: 0012/0013 are reserved by the pending
docs-restructure branch and 0014 is taken — 0015 chosen per the `bf9fab9` precedent.

## Context

Cloud Control Plane is a generic multi-account portal (DECISIONS #1) whose every account
is, today, an AWS account — the word "account" is AWS-shaped in three load-bearing validators
(12-digit id regex + AWS region enum, required in the project-registration contract). The
estate it manages already exchanges data with a live Azure estate (a tag-sync Lambda holding
a plaintext Azure service-principal credential — a standing P1 — and Azure Arc agent tooling
in the import archive), so "cover Azure" is estate reality, not speculation.

The 0039 censuses established: the governance core (roles, quorum ladder, 2FA, dual-control,
audit) is verified provider-neutral; the pipeline spine (10 of 13 codemod verbs, plan-check
R1–R6, drift classifier code, onboarding trust flow) is provider-neutral; and the AWS
coupling concentrates in five choke points (project identity contract, the
ForceNew/schemadump safety chain, codemod create/reference gates, inventory/redaction display
data, CI credential wiring). Separately: the approved-request→PR bridge and real executor do
not exist yet for AWS either, and even a second AWS account is not config-only today — the
multi-estate execution layer is unbuilt for everyone.

## Decision

**A project declares its cloud provider; everything provider-specific resolves through that
declaration; everything that makes the portal trustworthy — people, approvals, 2FA, audit,
gates — gains zero provider awareness.** Azure (via the `azurerm` provider) becomes the
second supported provider through the staged plan in 0039 §5 (S0 decide → S1 provider seam →
S2 estate import + federation groundwork → S3 read-only presence → S4 fail-closed catalog →
S5 PR lane, apply armed last).

Binding rules (0039 §4.3, summarized):
1. **Fail-closed parity** — no Azure operation exists until its replace/disrupt verdict is
   verified against the azurerm provider schema at the project's pinned version (the
   0020/0007-C1 doctrine, applied per provider).
2. **Federation only** — no client secrets, no storage keys, anywhere; retiring the existing
   plaintext service principal is a prerequisite of estate onboarding, not a follow-up.
3. **One provider per Terraform root; one root per estate; scoped credentials per estate.**
4. **Governance untouched** — approval/2FA/roles/audit files are out of scope for Azure work
   by definition.
5. **AWS must not notice** — every seam change ships with byte-identical AWS golden-fixture
   proof.
6. **The request→PR bridge/executor, whenever built, reads provider/scope from project
   config from day one** (seam-now sequencing, owner-accepted over wait-and-retrofit).
7. **Azure apply arms last** — only after the AWS apply lane has proven the guardrails
   end-to-end, and after an Azure rehearsal against a scratch resource group.

## Options considered

### Option A: provider as a property of a project (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Med — ~28 shape-level seam items concentrated at census choke points |
| Cost | Seam is small; the real lifts (azurerm ForceNew map, catalog content, estate import) are needed under any option |
| Team familiarity | High — reuses the repo's own generic-engine + curated-per-provider-data pattern |

**Pros:** governance/audit stay single; one portal, one catalog discipline, one safety story.
**Cons:** per-provider data tables (create-label, reference shape, redaction allowlist,
drift watchlists) must be curated and kept honest per provider.

### Option B: a parallel Azure portal (fork)
**Pros:** zero risk to the AWS lane. **Cons:** duplicates the governance core — two user
directories, two audit chains, two approval ladders that must never drift; violates
"one control plane serves many accounts." Rejected.

### Option C: wait for the AWS bridge, retrofit Azure later
**Pros:** maximal short-term focus. **Cons:** the bridge/executor would bake in AWS
assumptions at exactly the moment they are cheapest to avoid (it is still a stub); retrofit
is the single most expensive avoidable mistake identified. Rejected knowingly (D3).

### Option D: `azapi`/raw-ARM lane for coverage
Loose schema defeats the bounded-forms philosophy; anything azurerm cannot express routes to
the existing beyond-catalog engineer lane. Rejected as a non-goal (0039 §7).

## Consequences

- **Easier:** onboarding any further provider becomes data + curated tables, not
  architecture (the sandbox already denies `GOOGLE_*`); the multi-estate execution layer
  gets designed once for the second AWS account and Azure alike.
- **Harder:** every safety data set now exists per provider and per pinned version —
  ForceNew maps, drift watchlists, redaction allowlists (×3 vendored copies), risk-floor
  curation; the S4 content lift is real and estate-driven by design.
- **Revisit:** the azurerm schemadump reflection walk ([Likely], proven or stopped at the S4
  stage gate); flexible federated credentials vs environment-scoped subjects (S2); the
  specific first Azure subscription (D5 resolved 2026-07-17 — a different subscription than
  the tag-copier's, defined at onboarding time through the standard admin/importer flow
  rather than named upfront; the tag-sync automation is rebuilt with federated auth under
  Terraform, not retired).

## Action items
1. [ ] S1 provider-seam lane (spec first, per repo practice; AWS byte-identical gate).
2. [ ] S2 Azure bootstrap kit + estate import — prerequisite: rotate/retire the plaintext
       Azure service principal in `environments/prod/lambda.tf` (P1 regardless of Azure).
3. [x] D5 resolved (owner, 2026-07-17): first Azure project = a different subscription than
       the tag-copier's, defined at onboarding via the standard admin/importer flow (no
       upfront naming); the tag-sync automation is rebuilt the safe way (federated auth,
       Terraform-managed).
4. [ ] S3–S5 per 0039 §5, each behind its evidence gate.
