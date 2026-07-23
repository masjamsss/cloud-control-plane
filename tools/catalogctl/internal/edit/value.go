package edit

import (
	"fmt"
	"slices"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// value.go is the shared value layer: it turns a param + its request
// value into the exact HCL value tokens the executor writes, across three kinds —
// const, reference, and literal — plus an optional 1-tuple wrap. Every scalar,
// list, reference and const codemod (set_attribute, set_attributes, append_block,
// append/remove_list_entry) resolves its value through valueTokens so the rules
// live in one place.

// valueTokens builds the value tokens param p writes for request value raw:
//   - role:"const"     → the manifest's fixed p.Const (no request input at all).
//   - role:"reference" → a traversal <addr>.<refAttr> onto another resource, after
//     verifying <addr> resolves to exactly one block under envDir. A type:"list"
//     reference value (a []any of addresses) emits a tuple of per-element traversals
//     `[a.<refAttr>, b.<refAttr>, …]` (e.g. subnet_ids on a DB subnet group);
//     each element runs the same type + existence guards as a scalar reference.
//   - otherwise         → the literal request value via anyToCty (scalar/list/map).
//
// Wrap:"list" wraps the result in a 1-element tuple (`[…]`) — e.g. a single
// subnet-id reference written as `[aws_subnet.x.id]`.
//
// Reference/schema failures (address 0/N matches, or a reference with no refAttr)
// are returned as errResolution-wrapped errors so the pipeline maps them to exit 3
// (resolution/schema error) — the request simply cannot be resolved. The ONE exit-2
// refusal here is REFERENCE_TYPE_MISMATCH: a role:"reference" whose enumSource
// declares an allowed target type, pointed at a resource of a DIFFERENT type, is an
// engineer-actionable REFUSE returned via (code, reason).
func valueTokens(envDir string, p manifests.Param, raw any) (hclwrite.Tokens, string, string, error) {
	var toks hclwrite.Tokens
	switch p.Role {
	case "const":
		v, err := anyToCty(p.Const)
		if err != nil {
			return nil, "", "", err
		}
		toks = hclwrite.TokensForValue(v)
	case "reference":
		// A reference param's value is EITHER a single address string (scalar
		// reference, e.g. vpc_id = aws_vpc.x.id) OR a list of addresses (
		// type:"list" role:"reference", e.g. subnet_ids = [aws_subnet.a.id,
		// aws_subnet.b.id]). Each element resolves through the SAME per-address
		// pipeline (type check + existence + traversal); a list just emits a tuple.
		switch v := raw.(type) {
		case string:
			t, code, reason, err := refTokens(envDir, p, v)
			if err != nil || code != "" {
				return nil, code, reason, err
			}
			toks = t
		case []any:
			// Per-element resolution: a cross-type or unresolvable element refuses /
			// errors exactly as its scalar counterpart would — no list element is ever
			// a weaker check than a single reference.
			entries := make([]tupleEntry, 0, len(v))
			for _, e := range v {
				addr, ok := e.(string)
				if !ok {
					return nil, "", "", fmt.Errorf("%w: reference param %q list element is not a string", errResolution, p.Name)
				}
				t, code, reason, err := refTokens(envDir, p, addr)
				if err != nil || code != "" {
					return nil, code, reason, err
				}
				entries = append(entries, tupleEntry{toks: t})
			}
			toks = buildTuple(entries)
		default:
			return nil, "", "", fmt.Errorf("%w: reference param %q value is not a string or list", errResolution, p.Name)
		}
	default:
		v, err := anyToCty(raw)
		if err != nil {
			return nil, "", "", err
		}
		toks = hclwrite.TokensForValue(v)
	}
	if p.Wrap == "list" {
		toks = wrapListTokens(toks)
	}
	return toks, "", "", nil
}

// refTokens resolves ONE reference address into its value tokens — the traversal
// <addr>.<refAttr> onto another resource — after (a) the cross-type refuse
// when the enumSource declares an allowed target type, and (b) the existence +
// uniqueness check. valueTokens calls it once for a scalar reference and once per
// element for a type:"list" reference, so a list element is never a weaker check
// than a single reference: the same guard set runs for every address.
func refTokens(envDir string, p manifests.Param, addr string) (hclwrite.Tokens, string, string, error) {
	// Type check: the SPA picker constrains WHICH resource type this
	// reference may point at via enumSource (inventory://<type>/<attr>), but the
	// executor never enforced it — a hand-authored request pointed a KMS-key
	// reference at an IAM role and `kms_key_id = aws_iam_role.x.arn` was written at
	// exit 0. Refuse a cross-type reference here, BEFORE the
	// existence check, as an engineer-actionable REFUSE (exit 2 — the request, not
	// the tree, is wrong). An absent or unparseable enumSource yields no allowed set
	// ⇒ existence-only, so a reference that never declared a type is never newly
	// broken. Multi-type enumSources admit any of the set (AllowedRefTypes).
	if allowed := p.AllowedRefTypes(); len(allowed) > 0 {
		got, _, _ := strings.Cut(addr, ".")
		if !slices.Contains(allowed, got) {
			return nil, "REFERENCE_TYPE_MISMATCH", fmt.Sprintf(
				"reference param %q points at %s (type %q) but must be one of %v — enumSource %q",
				p.Name, addr, got, allowed, p.EnumSource), nil
		}
	}
	// Existence + uniqueness check: the reference must resolve to exactly one
	// block (Locate returns code 3 on 0-or-N matches, code 1 on I/O/parse).
	if _, err, code := hclops.Locate(envDir, addr); err != nil {
		if code == 3 {
			return nil, "", "", fmt.Errorf("%w: %v", errResolution, err)
		}
		return nil, "", "", err // I/O or parse error → exit 1
	}
	if p.RefAttr == "" {
		return nil, "", "", fmt.Errorf("%w: reference param %q has no refAttr to read", errResolution, p.Name)
	}
	trav, diags := hclsyntax.ParseTraversalAbs([]byte(addr+"."+p.RefAttr), "ref", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return nil, "", "", fmt.Errorf("%w: parse reference %q: %s", errResolution, addr+"."+p.RefAttr, diags.Error())
	}
	return hclwrite.TokensForTraversal(trav), "", "", nil
}

// wrapListTokens wraps inner in a single-element tuple: `[` inner `]`. hclwrite.Format
// on the enclosing block re-aligns it to a canonical `[inner]`.
func wrapListTokens(inner hclwrite.Tokens) hclwrite.Tokens {
	out := hclwrite.Tokens{{Type: hclsyntax.TokenOBrack, Bytes: []byte("[")}}
	out = append(out, inner...)
	return append(out, &hclwrite.Token{Type: hclsyntax.TokenCBrack, Bytes: []byte("]")})
}

// isValueProvider reports whether p supplies the value(s) a codemod writes (as
// opposed to the inventory target, a role:"selector", or a role:"discriminator"). A
// role:"reference" param is source:"inventory" (it names another resource) yet still
// provides a value, so it is included; a plain source:"inventory" target is not.
//
// a role:"discriminator" is excluded — it only picks WHICH block/attr is
// edited (via Segments/ResolveTarget), never a written value. This is the structural
// fix that stops the discriminator leaking as the first value param: with
// it gone from the provider set, valueParam/valueProviders resolve the TRUE value.
func isValueProvider(p manifests.Param) bool {
	return manifests.IsValueProvider(p)
}

// valueProviders returns every value-providing param in manifest order (references,
// consts, and ordinary user_input values) — the params a value/list codemod emits.
func valueProviders(op manifests.Op) []manifests.Param {
	var out []manifests.Param
	for _, p := range op.Params {
		if isValueProvider(p) {
			out = append(out, p)
		}
	}
	return out
}
