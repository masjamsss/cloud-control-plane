package edit

import (
	"fmt"
	"regexp"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// isValidBlockIdent reports whether s is a single valid HCL identifier usable as
// a block type or map-attribute name. It delegates to manifests.IsValidBlockIdent
// (one canonical name-safety predicate shared with ResolveTarget's co-domain
// check, so the two can never drift). It REJECTS path-like ("a/b", "x.tf"), dotted,
// whitespace, and alternation ("ingress/egress") values.
//
// A mis-shaped target.block is a manifest data error that, left unchecked, makes
// a verb emit invalid or wrong-located HCL at exit 0 — the worst failure mode,
// because plan-check can't catch it (the resource address is right; only the
// location within is wrong) and a reviewer may miss it. Refusing here converts
// that silent corruption into an explicit route-to-an-engineer.
func isValidBlockIdent(s string) bool {
	return manifests.IsValidBlockIdent(s)
}

// guardBlockTarget refuses a NON-EMPTY target.block that is not a valid HCL
// identifier. An empty block (meaning "the resource's top level") is left to the
// caller. Returns (code, reason); ("","") when the block is safe to use.
func guardBlockTarget(block string) (string, string) {
	if block == "" {
		return "", ""
	}
	if !isValidBlockIdent(block) {
		return "MALFORMED_BLOCK_TARGET", fmt.Sprintf(
			"target block %q is not a valid HCL identifier (path-like or ambiguous) — refusing rather than emit wrong HCL; routed to an engineer",
			block,
		)
	}
	// A block named like a RESOURCE TYPE (aws_*/azurerm_*) is a manifest authoring
	// error — no provider nested block is ever named aws_*/azurerm_*. Left
	// unguarded this emits a schema-invalid nested resource at exit 0 (found live on
	// sns-add-subscription): a new resource must be created as
	// a top-level block (a different capability), never nested inside another.
	if IsProviderResourceType(block) {
		return "RESOURCE_TYPE_AS_BLOCK", fmt.Sprintf(
			"target block %q names a resource type, not a nested block — creating a resource needs a top-level block; routed to an engineer",
			block,
		)
	}
	return "", ""
}

// createResourceTypeShape is the top-level create label a create emits: an
// aws_*/azurerm_* provider resource type. It is the INVERSION of
// guardBlockTarget's provider-prefix refusal — a nested block named aws_*/azurerm_*
// is a manifest error, but a create's TOP-LEVEL block MUST be an aws_*/azurerm_*
// resource type — that is the whole capability.
var createResourceTypeShape = regexp.MustCompile(`^(?:aws|azurerm)_[a-z0-9_]+$`)

// guardCreateLabels validates the labels of every block a create emits (
// the invert-sense of RESOURCE_TYPE_AS_BLOCK). For a create the two
// labels of `resource "<type>" "<name>"` must be: <type> a well-formed aws_*/azurerm_*
// resource type (aws_*/azurerm_* is REQUIRED here, not refused), and <name> a valid
// HCL identifier. The local name always arrives from idioms.TfLocalName (which
// guarantees the ident shape) and the type from the closed idiom table, so this is
// defense-in-depth: it converts any future malformed emission into an explicit
// route-to-an-engineer rather than schema-invalid HCL at exit 0. Schema-reality of
// the type is guard #1's job (guardCreateBlocks), which fails open for a
// real-but-unreflected type.
func guardCreateLabels(blocks []hclBlock) (string, string) {
	for _, b := range blocks {
		if !createResourceTypeShape.MatchString(b.blockType) {
			return "MALFORMED_CREATE_LABEL", fmt.Sprintf(
				"create would emit resource type %q, not a well-formed provider resource type (aws_*/azurerm_*) — refusing rather than author invalid HCL; routed to an engineer",
				b.blockType,
			)
		}
		if !isValidBlockIdent(b.name) {
			return "MALFORMED_CREATE_LABEL", fmt.Sprintf(
				"create would emit local name %q for %s, not a valid HCL identifier — refusing rather than author invalid HCL; routed to an engineer",
				b.name, b.blockType,
			)
		}
	}
	return "", ""
}

// guardAppendTarget is the append_block flavor of the block-target guard.
// append_block's block type is MANDATORY (unlike set_attribute, where an
// empty block means "top level"), and append_block lets it descend target.path and
// synthesize sub-blocks — so every structural identifier the executor will write
// or walk (target.block, target.path, each Param.Path, each EmptyBlocks chain)
// must be a valid HCL ident. Refusing a mis-shaped one here converts silent
// invalid-HCL-at-exit-0 into an explicit route-to-an-engineer. Returns (code,
// reason); ("","") when the whole shape is safe.
func guardAppendTarget(op manifests.Op) (string, string) {
	if code, reason := guardBlockTarget(op.Target.Block); code != "" {
		return code, reason
	}
	if op.Target.Block == "" {
		return "MISSING_BLOCK_TARGET", "append_block requires a nested block name — refusing rather than emit invalid HCL; routed to an engineer"
	}
	for _, seg := range op.Target.Path {
		if !isValidBlockIdent(seg) {
			return "MALFORMED_BLOCK_TARGET", fmt.Sprintf("target path segment %q is not a valid HCL identifier — refusing rather than emit wrong HCL; routed to an engineer", seg)
		}
	}
	for _, p := range op.Params {
		for _, seg := range p.Path {
			if !isValidBlockIdent(seg) {
				return "MALFORMED_BLOCK_TARGET", fmt.Sprintf("param %q sub-block segment %q is not a valid HCL identifier — routed to an engineer", p.Name, seg)
			}
		}
	}
	for _, chain := range op.Target.EmptyBlocks {
		for _, seg := range chain {
			if !isValidBlockIdent(seg) {
				return "MALFORMED_BLOCK_TARGET", fmt.Sprintf("emptyBlocks segment %q is not a valid HCL identifier — routed to an engineer", seg)
			}
		}
	}
	return "", ""
}
