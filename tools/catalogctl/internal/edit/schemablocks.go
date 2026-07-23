package edit

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// RefuseUnknownBlockType (security-readiness) is emitted when an
// append_block op's target.block names a nested block the resource type's provider
// schema does NOT declare. The structural guards catch an EMPTY block
// (MISSING_BLOCK_TARGET), a path-like/alternation ident (MALFORMED_BLOCK_TARGET) and
// an aws_-prefixed name (RESOURCE_TYPE_AS_BLOCK) — but a plausible bare identifier
// that simply is not a block of that resource slipped straight through. The live case
// was iam-attach-managed-policy, which appended a `policy_attachment {}` into
// aws_iam_role (whose ONLY nested block is inline_policy; a managed-policy attachment
// is the separate top-level resource aws_iam_role_policy_attachment). That emitted
// schema-invalid HCL at exit 0, dying only at `terraform plan` — an L2 security-grant
// op mis-advertised as a working self-service capability. This guard consults the
// reflected schema (tools/schemadump) and refuses at exit 2, closing the whole
// append-a-nonexistent-block class.
const RefuseUnknownBlockType = "UNKNOWN_BLOCK_TYPE"

// schemaFile is the minimal projection of tools/schemadump/aws-*-schema.json this
// guard needs. In the dump a NESTED BLOCK is any attribute carrying a non-empty
// nesting_mode plus a `block` sub-schema (verified stable across every reflected
// resource: nesting_mode ∈ {list,set} and the `block` object is always co-present;
// a scalar/map attribute like `tags` has neither). Recursion via schemaBlock lets us
// walk target.path into sub-blocks (e.g. aws_dlm_lifecycle_policy → policy_details →
// schedule) so a block that is legal only at depth is verified at that depth.
type schemaFile struct {
	Resources map[string]schemaResource `json:"resources"`
}

type schemaResource struct {
	// Framework marks a plugin-framework resource the dump could not reflect
	// (framework=true, e.g. aws_s3_bucket_lifecycle_configuration, which also carries
	// no `attributes`). Its blocks are real but invisible here, so the guard must fail
	// open on it, never refuse a legitimate append into it.
	Framework  bool                  `json:"framework"`
	Attributes map[string]schemaAttr `json:"attributes"`
}

type schemaAttr struct {
	NestingMode string       `json:"nesting_mode"`
	Block       *schemaBlock `json:"block"`
}

type schemaBlock struct {
	Attributes map[string]schemaAttr `json:"attributes"`
}

// nestedBlockIndex wraps a parsed schemadump for nested-block membership queries.
type nestedBlockIndex struct {
	resources map[string]schemaResource
}

// nestedBlocksAt returns the set of nested-block names available at target.path
// inside resource rt, plus ok. ok=false means "the schema cannot answer" — a nil
// index, a resource type absent from the dump, a framework-unreflected type, or a
// target.path segment that does not resolve to a nested block in the schema. The
// CALLER treats ok=false as fail-open (never a refusal), so a legitimate op we merely
// cannot verify is passed through untouched; only a POSITIVE "this block is not among
// the resource's declared blocks" answer refuses.
func (idx *nestedBlockIndex) nestedBlocksAt(rt string, path []string) (map[string]bool, bool) {
	if idx == nil {
		return nil, false
	}
	res, ok := idx.resources[rt]
	if !ok || res.Framework || res.Attributes == nil {
		return nil, false
	}
	attrs := res.Attributes
	for _, seg := range path {
		a, ok := attrs[seg]
		if !ok || a.NestingMode == "" || a.Block == nil || a.Block.Attributes == nil {
			return nil, false // path does not resolve to a nested block in the schema
		}
		attrs = a.Block.Attributes
	}
	names := make(map[string]bool, len(attrs))
	for name, a := range attrs {
		if a.NestingMode != "" && a.Block != nil {
			names[name] = true
		}
	}
	return names, true
}

// guardKnownBlock refuses an append_block whose target.block is a valid, non-aws_
// identifier that the resource type's schema does not declare as a nested block at
// target.path (UNKNOWN_BLOCK_TYPE). It DEFERS (returns "","") for every shape the
// existing structural guards already own — an empty, malformed, or aws_-prefixed
// block — so their more specific codes still win, and whenever the schema cannot
// answer (nil/absent index, framework-unreflected type, unresolved path) so a
// verifiable op is never refused on a guess. Only append_block synthesizes a nested
// block, so only it is checked: append_foreach_entry targets a MAP attribute (e.g.
// `tags`), never a nested block, and applying this check there would wrongly refuse
// every tag op.
func guardKnownBlock(op manifests.Op, idx *nestedBlockIndex) (string, string) {
	block := op.Target.Block
	if block == "" || !manifests.IsValidBlockIdent(block) || strings.HasPrefix(block, "aws_") {
		return "", "" // owned by guardAppendTarget's MISSING_/MALFORMED_/RESOURCE_TYPE_AS_BLOCK
	}
	names, ok := idx.nestedBlocksAt(op.Target.ResourceType, op.Target.Path)
	if !ok {
		return "", "" // schema cannot verify — fail open
	}
	if names[block] {
		return "", ""
	}
	return RefuseUnknownBlockType, fmt.Sprintf(
		"resource type %q declares no nested block %q%s in the provider schema — creating a new resource (a managed-policy attachment, replication config, …) needs a top-level resource block, not a nested one; refusing rather than emit schema-invalid HCL (routed to an engineer)",
		op.Target.ResourceType, block, pathSuffix(op.Target.Path),
	)
}

// guardCreateBlocks is the create-verb widening of the schema-block guard.
// Where guardKnownBlock gates the ONE nested block an append_block
// synthesizes, a create authors a whole block SET, so this walks EVERY emitted block
// and EVERY nested block at every depth and refuses one the provider schema does not
// declare (UNKNOWN_BLOCK_TYPE). It keeps guardKnownBlock's fail-open posture exactly:
// a resource type absent from the dump (e.g. aws_volume_attachment), a
// framework-unreflected type (e.g. aws_s3_bucket_lifecycle_configuration), or a path
// the schema cannot resolve yields "the schema cannot answer" — never a refusal, so a
// legitimate idiom is never blocked on a gap in the reflected dump. Only a POSITIVE
// "type T declares no nested block N here" refuses. A nil index (no schemadump found)
// fails open for the whole create.
func guardCreateBlocks(blocks []hclBlock, idx *nestedBlockIndex) (string, string) {
	for _, b := range blocks {
		if code, reason := checkBlockSchema(b.blockType, nil, b.body, idx); code != "" {
			return code, reason
		}
	}
	return "", ""
}

// tfMetaBlocks are Terraform CORE meta-argument blocks — valid on ANY resource's top
// level and NOT part of the provider schema (so nestedBlocksAt never lists them). The
// create idioms emit `lifecycle { prevent_destroy = true }`; without this exemption
// the schema guard would falsely refuse it. They appear only at the resource top
// level (path empty); a provider block that merely shares the name at depth (e.g.
// aws_backup_plan → rule → lifecycle) is a real schema block and is checked normally.
var tfMetaBlocks = map[string]bool{"lifecycle": true, "connection": true, "provisioner": true}

// checkBlockSchema recurses the emitted body of resource type rt at nested-block
// path: for each nested block child, if the schema can answer at this path (ok) and
// the child is not among the declared nested blocks → refuse; otherwise descend into
// it. When the schema cannot answer (ok=false) nothing is refused at this level and
// deeper levels stay unanswerable too, so the whole subtree fails open.
func checkBlockSchema(rt string, path []string, body []bodyNode, idx *nestedBlockIndex) (string, string) {
	declared, ok := idx.nestedBlocksAt(rt, path)
	for _, n := range body {
		if n.kind != "block" {
			continue
		}
		if len(path) == 0 && tfMetaBlocks[n.name] {
			continue // Terraform core meta-block, not a provider schema block
		}
		if ok && !declared[n.name] {
			return RefuseUnknownBlockType, fmt.Sprintf(
				"resource type %q declares no nested block %q%s in the provider schema — refusing rather than author schema-invalid HCL (routed to an engineer)",
				rt, n.name, pathSuffix(append(append([]string{}, path...), n.name)),
			)
		}
		if code, reason := checkBlockSchema(rt, append(append([]string{}, path...), n.name), n.body, idx); code != "" {
			return code, reason
		}
	}
	return "", ""
}

// pathSuffix renders a human-readable " (under a/b)" for a non-empty target.path.
func pathSuffix(path []string) string {
	if len(path) == 0 {
		return ""
	}
	return fmt.Sprintf(" (under %s)", strings.Join(path, "/"))
}

// schemaIndexCache memoizes parsed indexes by absolute path — the dump is ~18 MB and
// a `go test` process drives many edits; production is one edit per process, so the
// first parse is the only cost either way.
var (
	schemaIndexMu    sync.Mutex
	schemaIndexCache = map[string]*nestedBlockIndex{}
)

// loadNestedBlockIndex parses the schemadump JSON at path into a nestedBlockIndex,
// memoized by absolute path.
func loadNestedBlockIndex(path string) (*nestedBlockIndex, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	schemaIndexMu.Lock()
	defer schemaIndexMu.Unlock()
	if idx, ok := schemaIndexCache[abs]; ok {
		return idx, nil
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	// The large AWS dump is committed gzipped (the 93 MB raw file is gitignored to
	// fit git), so a discovered ".gz" must be inflated before parsing — otherwise the
	// schema guard would silently fail open wherever only the committed .gz is present
	// (CI, a fresh clone). Mirrors the gunzip fallback the TS consumers already carry.
	if strings.HasSuffix(abs, ".gz") {
		zr, zerr := gzip.NewReader(bytes.NewReader(b))
		if zerr != nil {
			return nil, fmt.Errorf("open gzip schemadump %s: %w", path, zerr)
		}
		defer zr.Close()
		if b, err = io.ReadAll(zr); err != nil {
			return nil, fmt.Errorf("gunzip schemadump %s: %w", path, err)
		}
	}
	var sf schemaFile
	if err := json.Unmarshal(b, &sf); err != nil {
		return nil, fmt.Errorf("parse schemadump %s: %w", path, err)
	}
	idx := &nestedBlockIndex{resources: sf.Resources}
	schemaIndexCache[abs] = idx
	return idx, nil
}

// discoverSchemaPath walks up from each start dir until it finds a tools/schemadump
// directory holding a <prefix>-*-schema.json for resourceType's provider (SchemaDumpPrefix),
// returning that JSON path ("" if none). Globbing the version-suffixed filename keeps
// discovery working across a provider-version bump with no code edit.
func discoverSchemaPath(resourceType string, startDirs ...string) string {
	prefix := SchemaDumpPrefix(resourceType)
	seen := map[string]bool{}
	for _, start := range startDirs {
		if start == "" {
			continue
		}
		dir, err := filepath.Abs(start)
		if err != nil {
			continue
		}
		for !seen[dir] {
			seen[dir] = true
			if cand, _ := filepath.Glob(filepath.Join(dir, "tools", "schemadump", prefix+"-*-schema.json")); len(cand) > 0 {
				return cand[0]
			}
			// Fall back to the committed gzipped dump (the raw AWS json is gitignored),
			// so the guard is armed in CI / a fresh clone, not only where the raw dump
			// happens to sit. loadNestedBlockIndex inflates a ".gz" path.
			if cand, _ := filepath.Glob(filepath.Join(dir, "tools", "schemadump", prefix+"-*-schema.json.gz")); len(cand) > 0 {
				return cand[0]
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// resolveSchemaIndex loads the nested-block schema index for the block-append guard.
// An explicit --schema path that cannot be read is a HARD error (returned to the
// caller as exit 3, matching the drift classifier's fail-closed on an explicit but
// unreadable --schema); with no flag it auto-discovers tools/schemadump from the env
// dir and CWD, using resourceType's provider (SchemaDumpPrefix) to pick the right
// dump family (aws-*-schema.json / azurerm-*-schema.json). When nothing is found —
// or a discovered dump fails to parse (a corrupt committed dump is caught by
// schemadump's own tests, not an operator's edit) — it returns a nil index with no
// error, and guardKnownBlock fails open. The executor still ships its existing
// structural guards; it simply cannot add the schema layer. This is the correct
// posture for azurerm today (no azurerm schemadump exists yet — Lane F): every
// azurerm append/create fails open here, unguarded by the schema layer, until F1's
// dump lands; ForceNew (a separate Lane F gate) is the fail-closed layer that
// actually blocks unsafe azurerm ops in the meantime.
func resolveSchemaIndex(flagPath, envDir, resourceType string) (*nestedBlockIndex, error) {
	if flagPath != "" {
		return loadNestedBlockIndex(flagPath)
	}
	cwd, _ := os.Getwd()
	if p := discoverSchemaPath(resourceType, envDir, cwd); p != "" {
		if idx, err := loadNestedBlockIndex(p); err == nil {
			return idx, nil
		}
	}
	return nil, nil
}
