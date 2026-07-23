# Cloud Control Plane — control panel (frontend)

Cloud Control Plane is a **console + no-code editor + request/approval portal, fused**. The whole ops team uses
it to change AWS infrastructure through **forms, not Terraform** — and a human reviews every change
as a diff before anything applies. It is **deterministic and LLM-independent**: no model runs on any
path, at build time or runtime. The forms, dropdowns, validation, diff, and approval math are all
lookups over bundled JSON, not inference.

```bash
cd ccp/app
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit
npm test           # vitest — interpreter, permissions, diff, accounts & auth guarantees
npm run build      # production build
```

## The journey

```
Home (services by category)
  └─► Service page — a light console: its resources + current settings
        └─► pick a resource ─► Change / Delete          ─┐
        └─► "+ Add new"      ─► provision                 ├─► Form
                                                          │     └─► Review — plain summary + Terraform diff
                                                          │            + apply now OR schedule a window
                                                          └────────────► Submit ─► request enters its lane
```

Every request needs human approval before anything runs — the reviewer sees a **GitHub-style
colored diff**. After approval the change becomes a Terraform change proposal (PR/MR), automated
gates verify the plan matches what was reviewed, and it **applies automatically** (see
the [PRD](../../PRD.md) for the guardrails).

## Sign in & local accounts

Cloud Control Plane has its own **local accounts** — no personal GitHub needed (a
control-plane bot does the git). You sign in on `/login` with a username + password; the role comes
from the account and the app routes you to what that role can see. In standalone (mock) mode
passwords are stored **only** as salted PBKDF2 hashes (WebCrypto) in a browser-persisted store
([`lib/accounts.ts`](src/lib/accounts.ts), [`lib/auth.ts`](src/lib/auth.ts)); in api-mode the real
`ccp-api` owns accounts and sessions (argon2id, httpOnly cookies — see
[`../api/README.md`](../api/README.md)).

On first run **one bootstrap Lead is seeded**:

| username | password | role |
|---|---|---|
| `putra` | `ccp-lead` | Lead (change it from Users → Reset password) |

Sign in as the Lead, open **Users**, and enrol everyone else (name, username, role, team, starting
password). Enrolment is **Lead-only**; there is no open sign-up. Guardrails live in the store: unique
usernames, and the last active Lead cannot be disabled.

## Roles & permissions

| Role | Can request | Can approve | Extra |
|---|---|---|---|
| **Requester** (`dewi`) | only their **team's** services | — | — |
| **Approver** (`rizky`) | any service | yes (not their own) | — |
| **Lead** (`putra`) | any service | yes (not their own) | audit **Dashboard** · **Admin** hub |

Rules live in [`src/lib/permissions.ts`](src/lib/permissions.ts) and are unit-tested:

- **`canRequest`** — a requester is scoped to their team's services; seniors are unscoped.
- **`canApprove`** — approvers/leads only, **never your own request, never twice** (separation of duties).
- **`approvalsRequiredFor`** — **risk-based**, read from the editable approval policy (below).

## Admin (governance, Lead-only)

Everything a Lead governs lives under **`/admin`**, three tabs, each a persisted store behind a
swappable interface (so a real `ccp-api` slots in 1:1):

- **Users** ([`accounts.ts`](src/lib/accounts.ts)) — enrol, **reassign role & team**, reset password,
  enable/disable. Guard: the **last active Lead** can't be demoted or disabled.
- **Teams** ([`teams.ts`](src/lib/teams.ts)) — create/rename/delete teams and assign the **services**
  each owns (single-ownership — a service belongs to one team). Guards: unique name; a team with
  members or services can't be deleted. This is the lever that scopes what requesters can request.
- **Approval policy** ([`policy.ts`](src/lib/policy.ts)) — the **level of risk**: how many approvals
  LOW / MEDIUM / HIGH changes need, plus a delete floor. Every tier is ≥ 1 (every change needs at
  least one human approval before anything runs; the apply itself is automated after approval).
- **History** ([`audit.ts`](src/lib/audit.ts)) — an append-only **governance audit trail**: every
  enrolment, role/team change, team edit, and policy change, with who did it and when, newest first.

Long lists (accounts, the 30-service picker, the audit trail) use a shared **debounced** search
([`SearchBar`](src/components/SearchBar.tsx) + [`useDebouncedValue`](src/lib/useDebouncedValue.ts)) —
the input stays instant while filtering lags 200 ms.

## Service icons

Each service renders a [`ServiceIcon`](src/components/ServiceIcon.tsx) — a category-tinted tile with
its own line glyph ([`serviceIcons.ts`](src/lib/serviceIcons.ts)), monogram as fallback. These are a
cohesive, **license-safe AWS-style** set (the official AWS Architecture Icons are copyrighted and
can't be bundled); the component is the seam to drop the licensed SVGs in 1:1 later. The category tint
is a **service-identity** axis, deliberately separate from the risk colours.

Approval count is a property of the change's **risk**, not of who asks — any role may request any
severity on any service; the review requirement is what scales.

## How it works (no LLM)

The "interpreter" is a set of pure functions over bundled JSON manifests — not an inference:

```
module manifests (src/data/manifests/*.json)  ─┐
inventory (src/data/inventory.json)            ─┤─► interpreter.ts ─► forms + validation ─► request
                                                │      (availableOperations, resolveEnum,
  no model anywhere on this path ───────────────┘       validateParams, buildRequestDraft)
```

- `availableOperations(resourceType)` — what can I do to this resource? A lookup over the manifests.
- `resolveEnum(param)` — dropdown values, from inventory or an allowlist.
- `validateParams(op, values)` — deterministic bounds: allowlist, min/max, regex, grow-only, and a
  semantic CIDR check (public ranges and `0.0.0.0/0` are rejected).
- `generateDiff(op, values, inventory)` / `plainSummary(...)` — the mock Terraform diff and the
  one-line summary a reviewer reads. [`DiffView`](src/components/DiffView.tsx) renders it GitHub-style:
  an in-place `~ attr = OLD -> NEW` becomes a red removal row + a green addition row.

The early specs planned CI-generated manifests (`catalogctl manifest`); that subcommand never
shipped — manifests are maintained in-repo and held safe by gates (`npm run verify:safety`,
`npm run help:check`, coverage tests). The real CLI surface is documented in
`tools/catalogctl/README.md`. There is deliberately **no AI layer**.

### Real inventory

`src/data/inventory.json` is **not mock data** — it is extracted deterministically from the real
estate baseline extracted from a reference estate repository (account 123456789012, ~1,320 resources across the
managed types). Every instance type, volume size, CIDR, and name comes straight from the HCL, so the
service cards show real counts (EBS 352, security groups 319, EC2 200, IAM 116, VPC 98 …) and the
console shows the actual ERP hosts with their live settings. Re-generate it by re-running the
extractor when the baseline changes; live-AWS reads come later (see the concept). Resource
**attribute keys** match what the manifests/operations expect (e.g. EBS `size` is surfaced as
`size_gib` for grow-only validation).

A service surfaces every estate resource type its manifest lists in `resourceTypes`. Types with a
change/delete **operation** are actionable; the rest render **read-only** (a light console of what
exists). Pure join records (volume attachments, policy/membership links) are intentionally excluded.

## Adding a new service (no new pages)

The pages are **generic and manifest-driven** — one catalog, one console, one form render *every*
service. Onboarding a service is declarative, not a new screen:

1. **Manifest** — add `src/data/manifests/<service>.json` (its operations catalog) and register it in
   `manifests/index.ts`. In production these are generated in CI (`catalogctl`) from the module's
   `variables.tf`, not hand-written.
2. **Team** — add the slug to a team in `config.ts` `TEAMS` so requesters can request it (seniors
   already can).
3. **Metadata** — add a `serviceMeta.ts` entry (name, category, monogram). *Optional* — a slug with
   no entry renders via a title-case fallback; several future services are pre-seeded.

Its card, console, resources, filter, forms, diff, and approvals then all appear automatically. The
[`coverage.test.ts`](src/test/coverage.test.ts) guardrail fails CI if these drift — an orphaned
manifest (no team → requesters locked out), a dangling team slug (no manifest → empty console), or a
service missing polished metadata. That's how the catalog stays coherent from 30 services to 90.

## Structure

```
src/
  config.ts               # GitHub owner/repo, region, TEAMS, SEED_LEAD (bootstrap)
  types/                  # shared types (manifest, inventory, request, user) — the contract
  lib/                    # interpreter, validation, permissions, diff, api (mock),
                          #   accounts (local store + PBKDF2), auth (session), session (shim)
  data/                   # module manifests + inventory.json (synthetic sample-estate fixture)
  components/             # AppShell, AccountMenu, guards (RequireAuth/RoleGate), DiffView, ui/ (…)
  features/
    auth/                 # the sign-in page
    admin/                # Users — Lead-only enrolment + account management
    catalog/              # Home — services grouped by category
    services/             # Service console — resources + current settings + actions + "Add new"
    request/              # the request form, review step, impact panel, schedule picker
    requests/             # my requests + request detail (approvals block, colored diff, timeline)
    approvals/            # the approver's queue
    dashboard/            # the lead's audit dashboard
  test/                   # vitest — interpreter, permissions, diff, accounts, auth
```

## Backend / API

The UI talks to an `ApiClient` ([`src/lib/api.ts`](src/lib/api.ts)). By default a
`createMockApiClient()` fulfils it **in-memory** so the app runs standalone (state resets on
reload); setting `VITE_API_BASE` swaps in the real HTTP client talking to `ccp-api` behind the
same interface (see [`../README.md`](../README.md) "Mock mode vs. api mode"). `submitRequest` computes
`approvalsRequired` from risk/MACD and is where a real backend commits the request YAML and opens the
PR; `approveRequest` / `rejectRequest` drive the approval lane.

## Personal GitHub

This build targets a **personal** GitHub account, not an org. `src/config.ts` holds
`github: { owner, repo, mode: 'personal' }`. GitHub **Environment** protection rules with required
reviewers are limited on personal private repos — the second (deploy) gate may need to be enforced
backend-side or on a public repo. The frontend itself is identity-light: Cloud Control Plane has
its own local accounts (roles above), and one `ccp[bot]` identity does the git — no requester
needs a personal GitHub login.
