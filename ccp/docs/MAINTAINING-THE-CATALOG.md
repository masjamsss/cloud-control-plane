# Maintaining the catalog at scale

**Why this file exists.** Cloud Control Plane is one control plane serving **many
onboarded projects** — many AWS accounts and Azure subscriptions. The thing that makes that
maintainable is a deliberate shape, and the thing that makes it *fragile* is a handful of
hand-synced lists. This file states both, so nothing drifts as the catalog and the project
count grow.

## The scaling shape (why many projects stays cheap)

- **One shared catalog, provider-filtered.** All operations live in
  `ccp/app/src/data/manifests/*.json`, loaded once via `import.meta.glob('./*.json')`.
  `deriveServiceCatalog` filters them to the **active project's provider** (`providerOfType`
  vs `project.provider ?? 'aws'`). Adding a project adds **no** catalog code — the catalog is
  O(1) in the number of projects.
- **Projects are thin.** A project is a `src/data/projects/<id>/project.json` (identity: provider,
  scope, repo, region/location, seed teams) plus its own `inventory.json` (its estate). A project
  MAY vendor its own `manifests/` but the default is the shared catalog — **do not vendor
  per-project manifests unless a project genuinely needs a private op**, or the catalog stops
  being shared.
- **Onboarding is import + config**, never code: `catalogctl onboard` (scan/trust) →
  register in Admin → drop `project.json` + `inventory.json`. See
  `ccp/docs/onboarding-runbook.md` (generic) and, for an Azure subscription,
  `importer/kit-azure/README.md` for the tooling — your deployment keeps its own
  import runbook for the operational steps.

**Consequence:** the maintenance surface is the *shared catalog's internal consistency*, not
the projects. Keep the catalog consistent and every project inherits it.

## The invariants (what must always hold) and the gate that enforces each

Every catalog change must keep ALL of these true. Each is machine-checked — never rely on eyeballing:

| Invariant | Enforced by |
|---|---|
| Every manifest parses; op ids globally unique; one service slug per file | `src/test/manifests.test.ts` |
| Every manifest's `service` has a `serviceMeta` entry (display/category/icon) | `src/test/coverage.test.ts` |
| Every manifest's `service` is owned by a team (`project.json` teams) | `src/test/coverage.test.ts` |
| Every `inventory://<type>/…` enum type is in inventory OR declared legitimately-empty | `src/test/inventoryEnums.test.ts` (`EMPTY_TYPES`) |
| Every `forcesReplace:false` write attribute resolves `in_place` at the pinned provider version | `npm run verify:safety` (ForceNew gate) |
| A manifest's `resourceTypes` are all one provider (no mixed aws/azurerm) | `verify:safety` (single-provider gate) |
| No estate-branding / company terms in prose | `verify:safety` (genericity) + `verify-source-genericity` |
| Azure tag-key case-collisions refused; azurerm ops write correct HCL | `tools/catalogctl` golden fixtures (`go test ./...`) |
| The 3 `redaction-rules.json` copies are byte-identical | `redact` sync test (both engines) |

Run the whole set with `./scripts/gate.sh` from the repo root. **Green gate = consistent catalog.**

## Recipes

### Add a service (a new manifest file)
1. Author `src/data/manifests/<service>.json` — verify every `target.resourceType` + written
   attribute exists in `tools/schemadump/<provider>-<tag>-schema.json`; `forcesReplace` matches
   the dump; every param has `help`; prose is estate-generic; `summary` ≤ 140 chars.
2. Register the slug: `src/lib/serviceMeta.ts` (displayName/category/monogram — and an icon glyph
   in `src/lib/serviceIcons.ts`, or it falls back to the monogram) and add it to a team in
   `src/data/project.json`.
3. Declare any new `inventory://` types in `src/test/inventoryEnums.test.ts` `EMPTY_TYPES` (until
   a project's inventory carries them).
4. Regenerate the provider ForceNew map: `cd ccp/app && npx vite-node scripts/build-forcenew-map.ts --provider <aws|azure>`.
5. `./scripts/gate.sh` green.

### Generated catalog data — regenerate, never hand-edit
These are produced by scripts and committed; if you change the inputs, **re-run the script**,
don't hand-patch the output:
- `catalog/azure-capability-ledger.json` ← `tools/schemadump/gen-azure-ledger.mjs`
- `docs/operations/terraform-capability-reference-azure/` ← `tools/schemadump/gen-azure-capability-reference.mjs`
- `src/data/manifests/azure-*.json` tag ops ← `ccp/app/scripts/gen-azure-tag-catalog.mjs`
- `src/data/forcenew-map*.json` ← `ccp/app/scripts/build-forcenew-map.ts`
- `tools/schemadump/<provider>-<tag>-schema.json` ← `tools/schemadump/gen.sh PROVIDER=<…>`

### Onboard a project (AWS account or Azure subscription)
Config + import only — see the runbooks. Register in Admin → scan/trust → drop `project.json`
+ `inventory.json`. No catalog code.

## Deliberate checkpoints vs. real debt

Two things *look* like hand-sync debt but are **intentional checkpoints** — do NOT "automate"
them away; deriving them would make the test vacuous and let real errors through:

- The manifest **count** in `manifests.test.ts` (`toBe(N)`). Manifests load through Zod
  `.parse()`, which **throws** on a malformed file — a bad manifest already fails loudly at
  import, so there is no "silent drop" to catch. The count is a separate human checkpoint: *the
  catalog changed size — confirm that was intended.* Deriving it from the glob would make it
  always-true and worthless. Bump it consciously when you add/remove a service.
- **`EMPTY_TYPES`** in `inventoryEnums.test.ts`. Adding a type here is a conscious *"yes, this
  picker points at a type no imported estate carries yet."* Auto-deriving "every referenced type
  not in inventory is fine" would let a **typo'd `inventory://` reference pass silently** — the
  exact bug the test exists to catch. Declare each one by hand.

The genuine ergonomic aid is already here: the **Recipe** + the **invariant table** list every
registry a new service must touch, so it's one deliberate pass instead of whack-a-mole across
five files. Resist adding a second test that re-asserts serviceMeta/team/enum coverage — that
duplicates the existing gates and creates a new drift surface. If scattered failure messages ever
become the bottleneck, make the *existing* checks report better, don't add a parallel one.

**Actual debt (worth paying down):** `azure-other.json` is a genuine grab-bag — the auto-wired
long tail with no natural family. Keep new *curated* ops in a named family service, and if it
keeps growing, split it by azurerm service prefix. It's provider-scoped, so it never dilutes AWS.
