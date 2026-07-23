package edit

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// attrKV is a resolved attribute name + value tokens. Shared with setattrs.go.
type attrKV struct {
	name string
	toks hclwrite.Tokens
}

// nestedKV is one resolved attribute of a synthesized append_block, plus the
// relative sub-block path (Param.Path) it lands in ([] = the new block's own body).
type nestedKV struct {
	relPath []string
	name    string
	toks    hclwrite.Tokens
}

// appendBlock appends one block (type = target.block) into the target resource
// With an empty target.path it appends at the resource top level (the
// flat behavior, unchanged); with a non-empty path it descends — reusing
// descendPath/selectorFor exactly as the other verbs do — to the PARENT that
// receives the block. The new block's interior is synthesized from the value
// params: each param's attr (manifests.AttrFor) carries its value (valueTokens),
// placed either in the new block's body or, when the param declares Param.Path, in
// a sub-block of it; Target.EmptyBlocks adds attr-less sub-block chains. Idempotence
// and conflict follow (deep-equal sibling → no-op; a role:"key" or singleton
// conflict → BLOCK_EXISTS). Only bytes inside the located block change; the caller's
// splice + changed-set re-proof (edit.go) keeps every sibling byte-identical.
func appendBlock(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	// Guards first — nil-bytes refusals, tree untouched. append_block's block type
	// is mandatory, and every structural ident (path / Param.Path / emptyBlocks)
	// must be valid before we walk or write it.
	if code, reason := guardAppendTarget(op); code != "" {
		return nil, code, reason, nil
	}
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	blockType := op.Target.Block
	envDir := filepath.Dir(loc.File)

	// Descend to the parent that receives the new block. Empty path = the
	// located top-level block. PATH_NOT_FOUND / SELECTOR_AMBIGUOUS propagate. A missing
	// intermediate parent is created on demand only when the manifest opts in via
	// Target.EnsurePath; otherwise it stays PATH_NOT_FOUND as before.
	parent := block
	if len(op.Target.Path) > 0 {
		p, code, reason := descendPath(block, op.Target.Path, selectorFor(op, req), op.Target.EnsurePath, op.Target.MatchPresence)
		if code != "" {
			return nil, code, reason, nil
		}
		parent = p
	}

	// Resolve every value param to (relPath, attr name, value tokens) in manifest
	// order — before any mutation, so a value refusal/error leaves the tree clean.
	// Omit-if-absent: an OPTIONAL param the request did not supply is skipped,
	// so its attribute — and a sub-block that would hold only skipped attrs — simply
	// does not materialize (this is what makes s3's conditional expiration{} work).
	// role:"const" params carry no request input and are never skipped.
	var kvs []nestedKV
	for _, p := range valueProviders(op) {
		raw, present := req.Params[p.Name]
		if !present && !p.Required && p.Role != "const" {
			continue
		}
		toks, code, reason, err := valueTokens(envDir, p, raw)
		if err != nil || code != "" {
			return nil, code, reason, err
		}
		kvs = append(kvs, nestedKV{relPath: p.Path, name: manifests.AttrFor(op, p), toks: toks})
	}

	// Build the candidate in a scratch file so it can compare against existing
	// siblings BEFORE the real parent is touched.
	scratch := hclwrite.NewEmptyFile()
	cand := scratch.Body().AppendNewBlock(blockType, nil)
	materializeBlock(cand, kvs, op.Target.EmptyBlocks)

	siblings := childrenOfType(parent, blockType)
	// Tier 1: a deep-equal sibling already present → idempotent no-op (exit 0).
	for _, sib := range siblings {
		if deepEqualBlock(sib, cand) {
			return origBlock(loc), "", "", nil
		}
	}
	// Tier 2: a role:"key" sibling with the same key but different content → refuse
	// (an add never silently overwrites — the change-in-place case is a set-op).
	if kp := keyParam(op); kp != nil {
		keyAttr := manifests.AttrFor(op, *kp)
		want := fmt.Sprint(req.Params[kp.Name])
		for _, sib := range siblings {
			if v, ok := attrLiteral(sib, keyAttr); ok && v == want {
				return nil, "BLOCK_EXISTS", fmt.Sprintf("a %q block with %s=%q already exists with different content — an add never overwrites; routed to an engineer", blockType, keyAttr, want), nil
			}
		}
	}
	// Tier 3: a singleton target that already has a (non-deep-equal) instance → refuse.
	if op.Target.Singleton && len(siblings) > 0 {
		return nil, "BLOCK_EXISTS", fmt.Sprintf("at most one %q block is allowed and one already exists with different content — routed to an engineer", blockType), nil
	}

	// Clear to append: materialize into the real parent, separated by one blank line
	// from existing content (a first block in an otherwise-empty parent gets none).
	if bodyNonEmpty(parent.Body()) {
		parent.Body().AppendNewline()
	}
	nb := parent.Body().AppendNewBlock(blockType, nil)
	materializeBlock(nb, kvs, op.Target.EmptyBlocks)

	// Same defensive Format+collapse pair as removeNestedBlock, so no double-blank
	// survives; the caller splices the block bytes and re-proves the invariant.
	return collapseBlankLines(hclwrite.Format(f.Bytes())), "", "", nil
}

// materializeBlock writes the synthesized interior of nb: flat attrs into nb's own
// body, Param.Path attrs into (created-on-demand) sub-blocks, then the attr-less
// EmptyBlocks chains. Distinct sub-block paths are emitted in first-appearance
// order, each preceded by a blank line when nb already holds content (prod style:
// attrs, blank, sub-block, blank, sub-block); a lone leading sub-block gets none.
func materializeBlock(nb *hclwrite.Block, kvs []nestedKV, emptyBlocks [][]string) {
	seen := map[string]bool{}
	var order [][]string
	for _, kv := range kvs {
		key := relKey(kv.relPath)
		if !seen[key] {
			seen[key] = true
			order = append(order, kv.relPath)
		}
	}
	for _, rp := range order {
		body := nb.Body()
		if len(rp) > 0 {
			if bodyNonEmpty(nb.Body()) {
				nb.Body().AppendNewline()
			}
			body = ensureChildChain(nb, rp).Body()
		}
		for _, kv := range kvs {
			if relKey(kv.relPath) == relKey(rp) {
				body.SetAttributeRaw(kv.name, kv.toks)
			}
		}
	}
	for _, chain := range emptyBlocks {
		if bodyNonEmpty(nb.Body()) {
			nb.Body().AppendNewline()
		}
		ensureChildChain(nb, chain)
	}
}

// relKey joins a relative sub-block path into a map/order key. NUL can't appear in
// a validated HCL ident, so it is a collision-free separator.
func relKey(path []string) string { return strings.Join(path, "\x00") }

// bodyNonEmpty reports whether a body already holds an attribute or a block (a
// trailing AppendNewline adds neither), so materializeBlock knows to separate the
// next sub-block with a blank line.
func bodyNonEmpty(b *hclwrite.Body) bool {
	return len(b.Attributes()) > 0 || len(b.Blocks()) > 0
}

// keyParam returns the op's role:"key" param (the sibling-identity attribute for
// dedup), or nil. At most one is expected.
func keyParam(op manifests.Op) *manifests.Param {
	for i := range op.Params {
		if op.Params[i].Role == "key" {
			return &op.Params[i]
		}
	}
	return nil
}
