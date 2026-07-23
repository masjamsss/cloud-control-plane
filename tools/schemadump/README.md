# schemadump — authoritative per-attribute provider schema (with ForceNew)

`tools/schemadump` produces **`aws-v6.53.0-schema.json`**: for every relevant
AWS resource type, every attribute's **ForceNew**, Required/Optional/Computed,
type, Default, sensitivity, and full nested-block structure (nesting mode,
min/max items, recursive block attributes).

This is the G0 artifact of the generative-manifests design (internal design doc, not published):
it (a) feeds `manifest gen` (G2+) and (b) closes limitation **L1** — the
authoritative ForceNew source.

Since 0039 (Azure seam, lanes F1/F2) the tool is **per-provider**: the SAME
compile-and-reflect engine also produces **`azurerm-v4.81.0-schema.json`** for
a bounded 12-type spike scope. Everything below describes the AWS run first
(the mature, 85-type case); see [**azurerm (a second provider)**](#azurerm-a-second-provider-0039-f1f2)
for what differs.

## Why this tool exists (L1)

`terraform providers schema -json` **omits ForceNew entirely** (verified: for the
pinned binary, `aws_instance.instance_type` and `aws_instance.availability_zone`
carry no `force_new` key — a documented, deliberate limitation). Provider
**docs** "in-place" labels also lie (the ForceNew audit finding; `0013d` B7's four
hidden-ForceNew hazards). The provider's **Go source** is the only authoritative
source, and ForceNew lives in the SDKv2 `helper/schema.Schema.ForceNew bool` — a
value only obtainable by compiling the provider and reflecting over its
`ResourcesMap`. That is what this tool does.

## The three pitfalls this tool navigates

1. **Go forbids importing `internal/` from outside the module.** Resource
   schemas live in `internal/provider/...`. The tool is therefore *dropped inside*
   a checkout of the provider source (`cmd/schemadump/`), where
   `internal/provider/sdkv2` and `internal/provider/framework` are importable, and
   built there. Only the generator (`schemadump.go`, `main.go.tmpl` /
   `main-azurerm.go.tmpl`, `gen.sh`), the type lists (`types.txt` /
   `types-azure.txt`), and the OUTPUT dumps are committed here — never the
   400+ MB provider source checkouts.

2. **HashiCorp does not follow Go semantic-import-versioning.** At tag `v6.53.0`
   the module path in `go.mod` is `github.com/hashicorp/terraform-provider-aws`
   with **no `/v6` suffix**. So `go mod download github.com/hashicorp/terraform-provider-aws/v6@v6.53.0`
   fails by design (`go.mod has non-.../v6 module path`). Source acquisition is a
   **git clone of the tag** (`gen.sh` step 1). The commit SHA is the authoritative
   content hash.

3. **Most v6 schemas are lazy (`SchemaFunc`), not eager (`Schema`).** The AWS
   provider defines 82 of the 84 in-scope SDKv2 resources via the SDKv2
   `SchemaFunc` field (a memory optimization); their `Schema` field is nil.
   Reading `r.Schema` directly yields a silently EMPTY dump — the walker must go
   through `r.SchemaMap()`, which resolves `SchemaFunc` and falls back to
   `Schema` (regression-tested in `schemadump_test.go`, `fake_lazy`).

## SDKv2 vs terraform-plugin-framework (the ForceNew caveat)

The AWS provider is a **mux of two frameworks**:

- **SDKv2** resources (`helper/schema.Resource`) carry a per-attribute
  `ForceNew bool`. These are **reflected completely** — ForceNew is authoritative.
- **terraform-plugin-framework** resources express replacement via
  `RequiresReplace` **plan modifiers** (functions), which are **not reliably
  introspectable**. These are emitted as `"framework_unreflected": true` with
  ForceNew **unknown** — consumers must treat them **fail-closed** (engineer-only /
  WARN), per `0013d §6.4` and the `0010 §3` "unresolved ⇒ treat AS ForceNew" rule.

Of the 85 types in scope, **84 are SDKv2** (fully reflected) and **1 is
framework**: `aws_s3_bucket_lifecycle_configuration` (migrated to the framework in
v6). The dump marks it `framework_unreflected` rather than guessing — exactly the
fail-closed behavior that prevents a B7-class hidden-ForceNew incident.

## Artifact structure

```jsonc
{
  "metadata": {
    "provider": "hashicorp/aws", "provider_version": "6.53.0",
    "provider_tag": "v6.53.0",
    "go_version": "...", "terraform_plugin_sdk_version": "v2.40.1",
    "terraform_plugin_framework_version": "v1.19.0",
    "source_provenance": { "acquisition": "git clone ...", "commit_sha": "a0c8167..." },
    "summary": { "requested": 85, "sdkv2_reflected": 84, "framework_unreflected": 1, "missing": 0, ... }
  },
  "resources": {
    "aws_instance": {
      "framework": false,
      "schema_version": 1,
      "has_customize_diff": true,        // ForceNew residual hazard flag (CustomizeDiff is invisible to reflection)
      "attributes": {
        "instance_type":     { "type": "string", "optional": true, "computed": true, "force_new": false },
        "availability_zone": { "type": "string", "optional": true, "computed": true, "force_new": true },
        "root_block_device": {
          "type": "list", "nesting_mode": "list", "single": true, "max_items": 1, "force_new": false,
          "block": { "attributes": { "volume_size": { "type": "int", "force_new": false }, ... } }
        }
      }
    },
    "aws_s3_bucket_lifecycle_configuration": {
      "framework": true, "framework_unreflected": true,
      "note": "... ForceNew is UNKNOWN — treat as fail-closed ..."
    }
  }
}
```

Per-attribute fields: `type` (bool/int/float/string/list/set/map), `required`,
`optional`, `computed`, `force_new`, `sensitive`, `deprecated`, `default` /
`has_default_func`, `has_validate_func` (bound values are opaque to reflection —
an AST pass, out of scope here, would be needed), `element_type` (for scalar
collections), and for nested blocks `nesting_mode` / `single` / `min_items` /
`max_items` / `block` (recursive).

## Scope: the 85 relevant AWS types

(azurerm's scope — 12 spike types, not this union rule yet — is covered in
[azurerm (a second provider)](#azurerm-a-second-provider-0039-f1f2) above.)

`types.txt` is the union of (a) every `operations[].target.resourceType` in
`ccp/app/src/data/manifests/*.json` (70) and (b) every
`resources[].resourceType` in `ccp/app/src/data/inventory.json` (62) = 85.
The tool takes the list via `-types`, so future runs widen by editing `types.txt`.

Regenerating the type list:
```bash
jq -r '.operations[].target.resourceType // empty' ccp/app/src/data/manifests/*.json > /tmp/a
jq -r '.resources[].resourceType' ccp/app/src/data/inventory.json >> /tmp/a
sort -u /tmp/a   # -> the 85
```

## Regenerating the artifact

```bash
# Isolated caches + scratch source; nothing outside tools/schemadump is written.
WORK=/path/to/scratch \
OUT="$PWD/tools/schemadump/aws-v6.53.0-schema.json" \
  ./tools/schemadump/gen.sh
```

`gen.sh` will: clone `terraform-provider-aws@v6.53.0` (if not already present),
drop `cmd/schemadump/{main.go,schemadump.go}` inside it, `go build` (compiles the
whole provider — **expect several minutes**; `GOTOOLCHAIN=auto` fetches the
provider's required Go toolchain if needed), and run the reflection over
`types.txt`. Requires network **once** for the clone + deps; the build and run are
otherwise hermetic (isolated `GOMODCACHE`/`GOCACHE`).

`PROVIDER` (default `aws`) selects which provider to dump — `aws` or
`azurerm` — see the next section. `PROVIDER=aws` with no other overrides
reproduces the run above byte-identically; the default was `aws`-only before
0039 and stays that way so nothing else in the pipeline has to change.

## azurerm (a second provider, 0039 F1/F2)

```bash
WORK=/path/to/scratch \
PROVIDER=azurerm \
OUT="$PWD/tools/schemadump/azurerm-v4.81.0-schema.json" \
  ./tools/schemadump/gen.sh
```

Same pipeline, same engine (`schemadump.go` is provider-agnostic — see
"Offline proof" below), different provider:

- **Template**: `main-azurerm.go.tmpl`, not `main.go.tmpl`. Its import paths
  are LITERAL (`github.com/hashicorp/terraform-provider-azurerm/internal/provider[/framework]`)
  rather than sed-substituted — azurerm's module path is fixed at authoring
  time, so there is nothing to parameterize (see the template's own header
  comment for the sed-collision hazard this creates for future edits).
- **Provider entrypoints differ**: azurerm's SDKv2 provider is
  `sdkv2.AzureProvider()` (no `ctx`/`error`, unlike AWS's
  `sdkv2.NewProvider(ctx)`), and its framework half
  (`framework.NewFrameworkV5Provider()`) is enumerated for type names inside a
  `recover()` — framework construction there is unverified outside the F1
  spike's own run and must never take the whole SDKv2 dump down with it.
- **Scope is a 12-type mechanism-proof spike, not the AWS run's 85-type estate
  scan.** `types-azure.txt` lists exactly the 12 types the F1 spike walked
  (`azurerm_resource_group`, `azurerm_storage_account`,
  `azurerm_linux_virtual_machine`, `azurerm_windows_virtual_machine`,
  `azurerm_managed_disk`, `azurerm_virtual_network`, `azurerm_subnet`,
  `azurerm_network_security_group`, `azurerm_network_security_rule`,
  `azurerm_network_interface`, `azurerm_public_ip`, `azurerm_key_vault`).
  At S4 (0039 §5) this list is replaced by the same union rule `types.txt`
  documents, once an azure manifest/inventory exists to union over. Until
  then every other azurerm type is simply absent from the dump — the
  ForceNew gate treats an absent type as `unresolved`, i.e. fail-closed,
  never a guess (see `ccp/app/scripts/build-forcenew-map.ts` and
  `verify-manifest-safety.ts`, both per-provider since 0039 F2).
- **Verified verdicts** (the F1c gate — the three checks that had to pass
  before F2 could start): `azurerm_storage_account.name` → `force_new: true`,
  `azurerm_linux_virtual_machine.admin_username` → `force_new: true`,
  `azurerm_storage_account.tags` → `force_new: false`. All 12 types were
  SDKv2-reflected (0 `framework_unreflected`, 0 `missing`); 614 attributes
  total, 144 `force_new: true` / 470 `force_new: false`.
- **Filename**: the output prefix is the provider's own short name
  (`azurerm`, matching its `azurerm_*` resource prefix), not the app-level
  `CloudProvider` token (`'aws' | 'azure'`, `ccp/app/src/lib/providerDisplay.ts`)
  — those are different concepts that happen to share a spelling for AWS.

## Offline proof (the walker)

`schemadump.go` depends only on the public `helper/schema` API, so it is
unit-tested standalone without the provider:

```bash
cd tools/schemadump && go test ./...
```

`schemadump_test.go` builds synthetic `*schema.Resource` fixtures that exercise
every reflection path (scalar ForceNew true/false, single/repeated/set nested
blocks, map/list scalar collections, recursion, defaults, sensitivity,
CustomizeDiff) — the "stub provider tree exercising every reflection path" from
`0013d G0`, expressed as fixtures. This is the always-green gate on the walker;
the full provider build is the gate on the internal-import glue.

## Validation & comparison

`validate.py` cross-checks the dump against ground truth and against
`ccp/app/src/data/forcenew-map.json`, writing `COMPARISON.md`:

```bash
python3 tools/schemadump/validate.py \
  tools/schemadump/aws-v6.53.0-schema.json \
  ccp/app/src/data/forcenew-map.json \
  <optional: terraform-providers-schema.json>   # structural cross-check
```

`COMPARISON.md` is advisory input to the wiring step (a separate reviewed PR).
**This tool does not modify `forcenew-map.json` or anything under `ccp/`.**
Where the dump and the map disagree, **the dump is authoritative** (it reflects
the live schema; the map was a grep/AST scan that left ~349 nested attrs
`unresolved`).

## Attribution

The schema JSON artifacts in this directory (`aws-*-schema.json*`, `azurerm-*-schema.json*`)
and the capability ledgers under `catalog/` are **derived from the published provider
schemas** of HashiCorp's [`terraform-provider-aws`](https://github.com/hashicorp/terraform-provider-aws)
and [`terraform-provider-azurerm`](https://github.com/hashicorp/terraform-provider-azurerm)
(both MPL-2.0), at the versions named in each file. They are generated factual output of
`terraform providers schema -json`, not copied provider source.
