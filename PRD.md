# Cloud Control Plane — Product Requirements (PRD)

> **Naming (2026-07-16).** Display name: **Cloud Control Plane**; identifier slug: **ccp**
> (replacing the original codename "gerbang", Indonesian for "gate"). Historical ADRs/proposals
> keep the old name — they are dated records.
>
> **Display name is instance-configurable (2026-07-22, [ADR-0023](docs/adr/0023-ccp-instance-identity.md)).**
> "Cloud Control Plane" here and below names *this codebase's own product identity* — the repo,
> its docs, and the `ccp` slug/prefix never rename. A DEPLOYED instance's displayed name and
> tagline are a separate, operator-set fact: generic by default ("Cloud Control Plane"), set at
> first install, changeable anytime after in Settings with no rebuild. Code identifiers
> (`ccp/` paths, `CCP_*` env vars, css/package names) are permanently out of scope for that
> rename — see the ADR for the full design.

**Current as of 2026-07-16.** This document is the single source of truth for what Cloud
Control Plane is. If any other document in this repository disagrees with it, this one wins —
the older document is history, not instructions. Documents written before this direction carry
a "SUPERSEDED" banner at the top.

> Day-to-day build status and internal planning records are deliberately **not** in this
> file (they live in the maintainers' private planning archive and are not published).
> Architecture decisions live in the [ADR ledger](docs/adr/README.md).

**Scope.** This repository hosts **Cloud Control Plane, the product this PRD covers** — the
web portal, its API, the Go catalog/gate tooling, and the importer kit. It contains no
cloud estate of its own: an estate (a real account's Terraform repository) is always a
separate, private repository that gets onboarded to the product.

## What Cloud Control Plane is

Cloud Control Plane is a self-service web portal where an operations team changes cloud
infrastructure by filling in forms instead of writing code. Every request is signed off by a
person, and then the change is carried out automatically: the tool writes the infrastructure
code (Terraform), opens a change proposal, runs it through automated safety checks, and
applies it to the right cloud account — an AWS account or an Azure subscription — with no
manual steps. One control plane serves many accounts and many teams; the estate's account it
started with is simply the first account on board. A fresh install of the product starts with
none: every account, including the very first, arrives by the same onboarding steps as the
rest — there is no pre-loaded sample estate ([ADR-0029, public summary](docs/adr/0029-ccp-data-birth-blank-install-public-summary.md)).

## Who uses it

Three roles, plus one capability:

| Who | What they can do |
|---|---|
| **Requester** | Files change requests, limited to the services their team owns. |
| **Approver** | Reviews requests and signs off. |
| **Lead** | Approves too, and sees the full picture: the audit trail, activity, who changed what. |
| **Admin** (a capability, not a role) | Manages users, teams, and settings. Works across all accounts. |

Role and team are set **per account**: the same person can be a lead on one account and
only a requester on another. Admin is the one exception — it is global. Riskier sign-offs
also require a second factor (a one-time code from the approver's phone), and an admin
controls who must use one.

## What it does — one change, start to finish

1. **Ask.** An operator opens the portal, picks the account and the service, and fills in
   a form describing the change. The forms are generated from a catalog of known, safe
   changes, so the portal only offers values that make sense — a request cannot be
   malformed.
2. **Approve.** The request goes to the right people. Small, safe changes need one
   sign-off; riskier changes need more, in a set order. Nobody can approve their own
   request.
3. **Write.** Once approved, the tool writes the exact infrastructure-code change itself.
   No AI, no guesswork: the same request always produces the same change, character for
   character.
4. **Propose.** The change is opened as a change proposal — a pull request on GitHub, a
   merge request on GitLab — so there is a permanent, reviewable record of exactly what is
   about to happen.
5. **Check.** Automated gates inspect the proposal: is the change about to run exactly the
   one that was reviewed? Does it stay within its limits?
6. **Apply.** If every gate passes, the change is applied to that account automatically.
   Nobody runs anything by hand.
7. **Track.** The requester follows progress in the portal; leads can audit everything
   afterward.

## How it stays safe while applying automatically

Hands-off apply is only acceptable because of guardrails, and the guardrails are the deal:

- **A person still says yes first.** Nothing is written or applied until the request is
  approved. What is automated is the work *after* the yes — never the yes itself.
- **What was reviewed is exactly what runs.** Before applying, the system re-checks that
  the change about to run matches the reviewed change precisely. Any difference at all,
  and it stops.
- **One small key per account.** The apply step uses a write credential scoped to that one
  account, with only the permissions it needs. Browsing and reading stay on read-only
  credentials. There is no master key.
- **Apply windows.** Changes can be held to agreed time windows (maintenance hours)
  instead of landing whenever they are ready.
- **Stop when reality has drifted.** If the live account no longer matches what the code
  expects, the apply halts and a person looks — it never ploughs ahead.
- **Limits on how much one change can touch.** A single change may only affect so much.
  Anything bigger stops and goes to an engineer.

## What it runs on

- **GitHub or GitLab.** The tool works the same on both; each account's code repository
  can live on either host.
- **Many cloud accounts, one portal.** An account here is an AWS account or an Azure
  subscription; each is onboarded with its own scoped credentials, catalog, and state.
  Adding a new account is designed to be routine: connect it and it shows up, with no
  rebuild of the app. (Register, connect its CI, and activate — live end to end, for the
  first account onboarded as much as the tenth. A fully zero-setup "connect and it just
  shows up" flow, with no CI to install, remains direction, not built.)
- **A generic change catalog.** The shared list of "changes you can ask for" describes
  services in general terms — never one company's, one workload's, or one account's
  specifics. A build check enforces this.
- **One cloud provider per account.** Each onboarded account is served by exactly one
  Terraform provider (AWS or Azure today); safety data — what replaces, what disrupts — is
  verified per provider version before any change is offered
  ([ADR-0015](docs/adr/0015-ccp-azure-second-provider.md), proposal 0039).

## What it deliberately does not do

- **No AI in the path of a change.** Forms, validation, code-writing, and checks are all
  deterministic. An AI assistant may exist only as an optional, clearly separate advisory
  add-on: it can suggest, it can never act, and removing it changes nothing.
- **Not tied to one company or workload.** Nothing in the core knows or cares what runs in
  the first account. Anything account-specific lives in that account's own configuration,
  never in the shared product.
- **No bypass lane.** Every change takes the same road — request, approval, proposal,
  checks, apply. The tool has no emergency side door.
- **No hand-written code from operators.** Operators never write or paste infrastructure
  code; the tool is the only thing that writes it.
- **It does not pretend to cover everything.** A change the forms cannot safely express is
  handed to an engineer as a tracked request — never forced through, never silently
  dropped.
## Look & feel

Clean, neutral, professional — light, calm, approachable for a mixed team. Built on
design tokens so a company brand can be swapped in later without a rewrite. The binding
visual language is now **Ledger** ([ADR-0014](docs/adr/0014-ccp-ledger-redesign.md)):
light stays canonical, with five per-user selectable palettes.
