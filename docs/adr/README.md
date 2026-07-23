# ADR ledger

Architecture Decision Records for the estate and for Cloud Control Plane (files 0005–0011 keep the old "gerbang" codename — dated records). ADRs are immutable history:
never rewrite one — write a new ADR that supersedes it and update the status line of the
old one. New decision = copy [template.md](template.md), take the next number, add a row
here.

| ADR | Title | Date | Status |
|---|---|---|---|
| [0005](0005-gerbang-approval-authority.md) | Gerbang approval authority is in-app | 2026-07-10 | Accepted (banner: pre-direction framing; the in-app authority decision stands) |
| [0006](0006-gerbang-local-identity.md) | Gerbang local identity (no personal GitHub) | 2026-07-10 | Accepted (banner: pre-direction framing; the decision stands) |
| [0007](0007-gerbang-no-ai.md) | No AI in the request path | 2026-07-10 | Accepted |
| [0008](0008-gerbang-no-auto-apply.md) | No auto-apply; retire the standard-change lane | 2026-07-10 | **Superseded by [0012](0012-ccp-auto-apply.md)** |
| [0009](0009-gerbang-approver-quorum.md) | Risk-based approver quorum + interim profile | 2026-07-10 | **Superseded by [0013](0013-ccp-approval-ladder-2fa.md)** |
| [0010](0010-gerbang-look-and-feel.md) | Look and feel (light system, one accent) | 2026-07-10 | Accepted |
| [0011](0011-gerbang-admin-capability.md) | Admin is a capability, not a role | 2026-07-11 | Accepted — its Consequences-"Interim" single-admin fallback (action item 4) is **superseded in part by [0017](0017-ccp-bootstrap-lifecycle.md)** (proposed; effective when the founding build ships) |
| [0012](0012-ccp-auto-apply.md) | Approved control-plane changes apply automatically | 2026-07-17 | Accepted (bridge not built yet — see [0018](../proposals/0018-enablement-deployment-unresolved.md)) |
| [0013](0013-ccp-approval-ladder-2fa.md) | Static two-level ladder + per-user 2FA | 2026-07-17 | Accepted — clause 4's dormant-secret sentence **partially superseded by [0024](0024-ccp-multi-device-totp.md)** (2026-07-22, enacted); the ladder and the rest of per-user 2FA stand |
| [0014](0014-ccp-ledger-redesign.md) | Ledger visual identity + per-user selectable palettes | 2026-07-17 | Accepted — supersedes the aesthetic clauses of [0010](0010-gerbang-look-and-feel.md) |
| [0015](0015-ccp-azure-second-provider.md) | Azure as the second cloud provider — provider is a property of a project | 2026-07-17 | Accepted (staged build per proposal 0039; apply arms last) |
| [0016](0016-ccp-approval-to-apply-bundle.md) | Approval-to-apply bundle: portal-gated direct-to-`main` + one-click gated apply (first buildable increment of 0012) | 2026-07-20 | Accepted (off-by-default; rollout tracked in [0018](../proposals/0018-enablement-deployment-unresolved.md)) |
| [0017](0017-ccp-bootstrap-lifecycle.md) | Bootstrap is a lifecycle: PROVISION → FOUND (sealed) → GOVERN — the founding seal replaces `grant-admin.ts` | 2026-07-22 | Proposed (build pending; supersedes in part 0011's interim single-admin fallback; spec: [2026-07-21 bootstrap lifecycle](../superpowers/specs/2026-07-21-ccp-bootstrap-lifecycle.md)) |
| [0018](0018-ccp-founding-quorum.md) | The founding quorum: ≥2 founding-complete admins ∧ ≥2 founding-complete seniors | 2026-07-22 | Proposed (build pending; the seal condition for 0017) |
| [0019](0019-ccp-day-zero-threat-model.md) | Day-zero threat model: the pre-governance window and its closure by seal + quorum | 2026-07-22 | Proposed (binds the founding build via named contract tests) |
| [0022](0022-ccp-teams-per-estate-onboarding.md) | Teams are kept and completed — per-estate teams born at onboarding; `ChangeRequest.teamId` is display-only by contract | 2026-07-22 | Accepted — enacted |
| [0023](0023-ccp-instance-identity.md) | Instance identity (display name + tagline): hybrid baked-generic default + runtime override, set at first setup | 2026-07-22 | Proposed (design lane; build gated on owner sign-off — spec: [generic branding](../superpowers/specs/2026-07-22-ccp-generic-branding.md)) |
| [0024](0024-ccp-multi-device-totp.md) | 2FA becomes a named TOTP device list (shimmed migration from the single secret; an enrolled factor is always challenged) | 2026-07-22 | Proposed (build landed on `claude/account-security-build` — spec: [account & security center](../superpowers/specs/2026-07-22-ccp-account-security-center.md); owner greenlit the always-challenged rule + 5-device cap as defaults; supersedes in part 0013's dormant-secret clause; status flips to Accepted on the owner's formal word) |
| [0025](0025-ccp-recovery-codes.md) | One-time recovery codes: hashed at rest, shown once, a login path of last resort | 2026-07-22 | Proposed (build landed, same lane as 0024; owner greenlit codes-at-enrolment + 10×80-bit format + the forced-first-login ceremony as defaults; status flips to Accepted on the owner's formal word) |
| [0026](0026-ccp-reauth-gate.md) | Session-stamped re-authentication gate (10-minute window) for sensitive self-service | 2026-07-22 | Proposed (build landed, same lane as 0024; owner greenlit the 10-minute window + either-factor rule as defaults; status flips to Accepted on the owner's formal word) |
| [0028](0028-ccp-estate-settings-at-setup.md) | Estate settings are two-tier runtime config — born at first setup, changeable forever, projected (never compiled) into out-of-band tools; catalogctl's window-tz expectation becomes `--estate-tz`/`CCP_ESTATE_TZ`/default `UTC` | 2026-07-22 | Proposed (design lane; build gated on owner decisions — spec: [estate config at setup](../superpowers/specs/2026-07-22-ccp-estate-config-at-setup.md)). **0027 is not skipped by accident** — it stays reserved for the repo-split ADR (FUNDAMENTALS, REPO_SPLIT row) |
| [0029](0029-ccp-data-birth-blank-install-public-summary.md) | Estate data is per-account runtime data, not a product bundle — the blank-generic install (public summary) | 2026-07-22 | Accepted — enacted (generic public restatement of [0020](0020-ccp-data-birth-blank-install.md); decision substance unchanged) |
| [0030](0030-ccp-control-scope-and-settlement-public-summary.md) | Retire the hardcoded default project id; reserve a dedicated scope for the control plane's own routing and audit (public summary) | 2026-07-22 | Accepted — enacted (generic public restatement of [0021](0021-ccp-control-scope-and-settlement.md); decision substance unchanged) |

Direction context for 0005–0013: [PRD.md](../../PRD.md) ·
[ccp/DECISIONS.md](../../ccp/DECISIONS.md). Proposal-level history:
[the proposals index](../proposals/README.md).

**Publication note (2026-07-22, owner ruling):** this ledger and
0005–0026/0028+ ship in the public split. 0001–0004 and 0020–0021 stay private
(`scripts/split/public-excludes.txt`) — the first four predate the current product
direction, and 0020/0021 each have the real customer project code-name as their decision's
own subject, so redacting it in place would falsify the historical record rather than
generalize it. 0020/0021 get a generic public face instead: [0029](0029-ccp-data-birth-blank-install-public-summary.md)
and [0030](0030-ccp-control-scope-and-settlement-public-summary.md). Every other
estate-identifying detail in this ledger and in 0005/0006/0008 (a private repo URL, in
both cases pure location metadata rather than decision substance) is generalized in place
with a dated banner on the affected ADR — see those files' own top-of-document notes.
