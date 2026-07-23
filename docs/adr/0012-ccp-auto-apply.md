# ADR-0012: Approved Cloud Control Plane changes apply automatically

**Status:** Accepted
**Date:** 2026-07-17 (records the direction reversal decided 2026-07-15/16)
**Deciders:** repo owner
**Supersedes:** [ADR-0008](0008-gerbang-no-auto-apply.md)

## Context

ADR-0008 (2026-07-10) ruled that no auto-apply path may exist, ever: a person approved
every request in the portal, and a second person clicked the gated GitHub Environment
approval before CI applied. Operating experience showed the second click added queueing
delay but no safety a machine check wasn't already providing — the
reviewed-plan-equals-applied-plan gate, apply windows, and drift halt are all mechanical
checks, and the human clicking the environment gate had nothing left to judge that the
machine hadn't already verified. At multi-account scale a human-per-apply is also a
bottleneck that grows with every onboarded account.

The 2026-07-15/16 concept reconciliation reversed the rule; [PRD.md](../../PRD.md)
("How it stays safe while applying automatically") and
[ccp/DECISIONS.md](../../ccp/DECISIONS.md) #2/#4 record the new direction. This
ADR gives that reversal the decision-ledger entry it was missing.

## Decision

After a request is approved in the portal, the change is carried out **hands-off**: the
tool writes the Terraform change, opens the proposal, and — if every automated gate
passes — applies it to the target account with no further manual step.

The approval itself stays human ([ADR-0013](0013-ccp-approval-ladder-2fa.md)): what is
automated is the work *after* the yes, never the yes.

Guardrails are the condition of the deal (PRD, verbatim intent):
reviewed-plan-equals-applied-plan or halt · one scoped write credential per account
(browsing/reading stay read-only) · apply windows · halt when the live account has
drifted · blast-radius limits.

## Consequences

- Easier: no idle queue between approval and apply; one portal can serve many accounts
  without a human bottleneck per apply.
- Harder: the guardrail set is now load-bearing — every gate must exist and be tested
  before auto-apply is armed anywhere.
- **Not built yet:** the approved-request → PR → merge → apply bridge does not exist as of
  2026-07-17 — see the
  [live register (0018)](../proposals/0018-enablement-deployment-unresolved.md). Until it
  lands, every apply still rides the manual gated lane in [docs/cicd.md](../cicd.md).
- **Scope:** this ADR covers the control-plane request path only. The hand-written-PR lane keeps
  its manual `prod`-environment gate.
- Documents asserting "nothing auto-applies" are superseded on that clause and carry
  banners pointing at [PRD.md](../../PRD.md).
