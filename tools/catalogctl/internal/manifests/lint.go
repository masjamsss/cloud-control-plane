package manifests

import (
	"fmt"
	"sort"
)

// lint.go implements the manifest lints: the
// prose-attr demotion/visibility lint and the positional-param / arity asserts.
// Detection is PURE and lives here so it is unit-testable and reusable; the
// RATCHET POLICY (which findings block CI, which are grandfathered tech debt) lives
// in the CI gate at tools/catalogctl/manifest_lint_test.go. Keeping detection and
// policy apart is what lets the same detector be "visible now, red on regression":
// the gate decides severity, the detector only reports the truth.

// Finding is one manifest-lint observation. It is advisory data — a Finding is only
// a build failure when the CI gate's policy says so.
type Finding struct {
	Rule    string // one of the Rule* constants below
	OpID    string
	Service string
	Detail  string
}

func (f Finding) String() string {
	return fmt.Sprintf("[%s] %s (%s): %s", f.Rule, f.OpID, f.Service, f.Detail)
}

const (
	// RuleProseAttr — a flat scalar set_attribute op with NO explicit
	// target.attr whose write target is parsed from the terraformCapability prose
	// paren token. This is the retired hazard path still in use: the executor
	// derives the attribute it WRITES from free-text prose. Migrate the op to an
	// explicit target.attr to clear it. Enumerated so the remaining latent ops are
	// visible and tracked instead of silently dangerous.
	RuleProseAttr = "prose-attr"

	// RuleNoValueProvider — a set_attribute / set_attributes op with no
	// value-provider param, so the executor has no value to write and exits 1
	// internally (setAttribute: "op %q has no value param"). A named load-time
	// finding instead of an opaque runtime error.
	RuleNoValueProvider = "no-value-provider"

	// RuleForeachArity — an append_foreach_entry op without the
	// key-then-value param pair the executor reads POSITIONALLY (nonInvParams[0]=key,
	// [1]=value). A reordered / short param list silently binds the wrong field or
	// exit-1s; this names it.
	RuleForeachArity = "foreach-arity"

	// RuleTargetArity — an in-place / removal op (everything except
	// instantiate_module) without exactly one source:"inventory" non-reference
	// locator param. edit.targetAddress reads the FIRST such param and exit-3s on
	// zero; two is an ambiguous positional bind. Exactly one is the contract.
	RuleTargetArity = "target-arity"
)

// IsValueProvider reports whether p supplies a value a codemod WRITES (as opposed to
// the inventory locator, a role:"selector", or a role:"discriminator"). A
// role:"reference" param is source:"inventory" (it names another resource) yet still
// provides a value, so it is included; a plain source:"inventory" target is not.
//
// This is the ONE canonical definition; edit.isValueProvider and
// plancheck.isValueProviderP delegate here so the executor, the verifier, and this
// lint can never disagree on which param fills a value (the same one-resolver-many-
// consumers discipline ProseAttrToken/AttrFor already follow).
func IsValueProvider(p Param) bool {
	if p.Role == "selector" || p.Role == "discriminator" {
		return false
	}
	return p.Role == "reference" || p.Source != "inventory"
}

// isNonInventoryValue mirrors edit.nonInvParams' membership test: a param that is
// neither the inventory target nor a pure block-picker (selector/discriminator). It
// is the set the foreach verb reads key/value from positionally.
func isNonInventoryValue(p Param) bool {
	return p.Source != "inventory" && p.Role != "selector" && p.Role != "discriminator"
}

// isInventoryLocator mirrors edit.targetAddress' pick: a source:"inventory" param
// that is not a role:"reference" (a reference is source:inventory but names a
// DIFFERENT resource to read a value from, not the block being edited).
func isInventoryLocator(p Param) bool {
	return p.Source == "inventory" && p.Role != "reference"
}

// Lint runs every manifest lint over the whole op catalogue and returns all findings
// in a deterministic order (by op id, then rule). Detection only — no severity.
func Lint(ops map[string]Op) []Finding {
	ids := make([]string, 0, len(ops))
	for id := range ops {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var out []Finding
	for _, id := range ids {
		op := ops[id]
		out = append(out, lintOp(op)...)
	}
	return out
}

// lintOp returns every finding for a single op.
func lintOp(op Op) []Finding {
	var out []Finding
	add := func(rule, detail string) {
		out = append(out, Finding{Rule: rule, OpID: op.ID, Service: op.Service, Detail: detail})
	}

	// prose-attr demotion: a flat scalar set_attribute op resolving its write
	// target from the prose paren token, with no explicit target.attr to supersede it.
	if op.CodemodOp == "set_attribute" &&
		op.Target.Attr == "" &&
		len(op.Target.Path) == 0 &&
		op.Target.Block == "" {
		if tok := ProseAttrToken(op.TerraformCapability); tok != "" {
			add(RuleProseAttr, fmt.Sprintf("writes attribute %q parsed from terraformCapability prose %q — declare target.attr instead", tok, op.TerraformCapability))
		}
	}

	// value provider present for the value-writing set verbs.
	if op.CodemodOp == "set_attribute" || op.CodemodOp == "set_attributes" {
		if !anyParam(op, IsValueProvider) {
			add(RuleNoValueProvider, fmt.Sprintf("%s has no value-provider param — the executor cannot resolve a value to write", op.CodemodOp))
		}
	}

	// foreach key-then-value arity.
	if op.CodemodOp == "append_foreach_entry" {
		if countParam(op, isNonInventoryValue) < 2 {
			add(RuleForeachArity, "append_foreach_entry needs a key param then a value param (two non-inventory params, read positionally)")
		}
	}

	// exactly one inventory locator for every op that resolves a target address.
	// instantiate_module and create_resource are the verbs that never locate an
	// existing block — a create authors a NET-NEW top-level resource, so it has no
	// inventory locator param (its key is user_input; its references are role:reference).
	if op.CodemodOp != "instantiate_module" && op.CodemodOp != "create_resource" {
		if n := countParam(op, isInventoryLocator); n != 1 {
			add(RuleTargetArity, fmt.Sprintf("has %d inventory non-reference locator params, want exactly 1 (edit.targetAddress binds the first)", n))
		}
	}

	return out
}

func anyParam(op Op, pred func(Param) bool) bool {
	for _, p := range op.Params {
		if pred(p) {
			return true
		}
	}
	return false
}

func countParam(op Op, pred func(Param) bool) int {
	n := 0
	for _, p := range op.Params {
		if pred(p) {
			n++
		}
	}
	return n
}
