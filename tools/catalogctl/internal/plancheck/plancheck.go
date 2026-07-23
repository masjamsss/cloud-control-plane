// Package plancheck is the mechanical L2 verifier (spec): it
// parses `terraform show -json` and enforces that the planned diff is a subset of
// what the request asked for. catalogctl only proposes, but a plancheck VIOLATION
// is a hard block — the machine half of L2 has veto power even though the tool
// does not. Check is pure: no file access, no bounds re-validation.
package plancheck

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/idioms"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// Plan is the subset of `terraform show -json` we verify (spec). Extra fields
// in the real JSON are ignored by encoding/json.
type Plan struct {
	FormatVersion   string           `json:"format_version"`
	ResourceChanges []ResourceChange `json:"resource_changes"`
}

// ResourceChange mirrors one entry of the plan's resource_changes[].
type ResourceChange struct {
	Address         string   `json:"address"`
	PreviousAddress string   `json:"previous_address"`
	ActionReasons   []string `json:"action_reasons"`
	Change          Change   `json:"change"`
}

// Change is the nested change object (actions + before/after + replace_paths).
// AfterUnknown (R6) is the plan's structural mask of values "known only after
// apply": true (or a nested tree of trues) at every computed leaf. R6 uses it to
// exclude provider-computed noise from the interior deep-diff. Importing
// (R10, spec 2026-07-20-ccp-oob-provisioning-import.md §7.2) is Terraform's
// own `terraform show -json` field marking a planned change as satisfying an
// `import` block — additive, nil on every plan that predates import blocks.
type Change struct {
	Actions      []string       `json:"actions"`
	Before       map[string]any `json:"before"`
	After        map[string]any `json:"after"`
	AfterUnknown map[string]any `json:"after_unknown"`
	ReplacePaths []any          `json:"replace_paths"`
	Importing    *Importing     `json:"importing,omitempty"`
}

// Importing is the plan JSON's `resource_changes[].change.importing` object
// — present only on a change that will satisfy an `import` block. ID is the
// import id Terraform resolved (informational only; R10 never compares it to
// anything — the pinned id already round-tripped through the import{} block
// itself, which R7-style freshness re-verification covers structurally).
type Importing struct {
	ID string `json:"id"`
}

// Violation is one breached rule. String() renders the spec line exactly:
// `VIOLATION <rule>: <address> — <reason>`.
type Violation struct {
	Rule    string
	Address string
	Reason  string
}

func (v Violation) String() string {
	return fmt.Sprintf("VIOLATION %s: %s — %s", v.Rule, v.Address, v.Reason)
}

// Check applies the plan-check rules against a plan for a given op+request and
// returns every violation (never fail-fast) plus any informational notes (e.g. an
// engineer-authored replace that flows through, or an interior R6 could not verify).
// Rules: R1 address-subset, R2 delete-guard, R3 replace-guard, R4 grow-only, R5
// moved-zero-delta, R6 interior confinement + requested-value-at-path (
// see interior.go), R7 no-public-ingress (see publicingress.go). Any violation ⇒
// the caller exits 2 (PLAN_VIOLATION); a clean result prints the info lines and exits 0.
func Check(plan Plan, op manifests.Op, req *request.Request) (violations []Violation, info []string) {
	allow, expected := allowSet(op, req)

	// R1 — address-subset: every changed address must be in the op's expected set.
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		if !allow(c.Address) {
			violations = append(violations, Violation{
				Rule:    "address-subset",
				Address: c.Address,
				Reason:  fmt.Sprintf("changed address is outside the request target set {%s}", expected),
			})
		}
	}

	// R2 — delete-guard: a pure destroy is legal only under a Delete op, at a
	// target address; a Delete op must plan exactly one destroy.
	for _, c := range plan.ResourceChanges {
		if !pureDelete(c.Change.Actions) {
			continue
		}
		switch {
		case op.Macd != "Delete":
			violations = append(violations, Violation{"delete-guard", c.Address, "destroy planned under a non-Delete op"})
		case !allow(c.Address):
			violations = append(violations, Violation{"delete-guard", c.Address, "destroy of an address outside the request target"})
		}
	}
	if op.Macd == "Delete" {
		n := 0
		for _, c := range plan.ResourceChanges {
			if changed(c.Change.Actions) && contains(c.Change.Actions, "delete") {
				n++
			}
		}
		if n != 1 {
			violations = append(violations, Violation{
				Rule:    "delete-guard",
				Address: inventoryAddr(op, req.Params),
				Reason:  fmt.Sprintf("a Delete op must plan exactly one destroy; plan has %d", n),
			})
		}
	}

	// R3 — replace-guard: a create+delete / non-empty replace_paths / replace_*
	// action reason is a VIOLATION unless the op is engineer-authored forcesReplace,
	// in which case it flows through as INFO (never blocks).
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) || !isReplace(c) {
			continue
		}
		if op.ForcesReplace {
			info = append(info, fmt.Sprintf("INFO replace-guard: %s — engineer-authored replace flows through (forcesReplace=true)", c.Address))
		} else {
			violations = append(violations, Violation{"replace-guard", c.Address, "plan forces a destroy+recreate but the op is not marked forcesReplace"})
		}
	}

	// create-guard — the plan is the create's own proof it did not
	// exist. The mirror of the verb's edit-time ALREADY_EXISTS gate: every
	// MANDATORY idiom address must be planned as exactly [create] with before==null
	// (mandatory-presence closes the co-emission hole — a bucket with no PAB, an
	// EBS volume with no attachment — at the plan layer too); a CONDITIONAL
	// companion that appears with a changed action must also be a pure create.
	// R2/R3 already block the delete/replace shapes; this adds the create shape.
	if op.CodemodOp == "create_resource" {
		addrs := idioms.Addresses(op.Target.ResourceType, createName(op, req), req.Params)
		byAddr := make(map[string]ResourceChange, len(plan.ResourceChanges))
		for _, c := range plan.ResourceChanges {
			byAddr[c.Address] = c
		}
		for _, a := range addrs.Mandatory {
			c, ok := byAddr[a]
			if !ok {
				violations = append(violations, Violation{"create-guard", a, "mandatory idiom address is not created by the plan"})
				continue
			}
			violations = append(violations, createShapeViolations(a, c)...)
		}
		for _, a := range addrs.Conditional {
			c, ok := byAddr[a]
			if !ok || !changed(c.Change.Actions) {
				continue // an omitted conditional companion is legal (its param was not chosen)
			}
			violations = append(violations, createShapeViolations(a, c)...)
		}
	}

	// R4 — grow-only: for each growOnly param, before < after AND after == requested.
	// The attr name delegates to manifests.AttrFor (was an inlined copy that
	// could drift from the executor). The before/after values are read at the param's
	// INTERIOR path — target.path descended via the shared R6 walker — so a grow-only
	// attribute inside a nested block is verified too (the old top-level
	// After[attr] lookup was blind to nested blocks).
	target := inventoryAddr(op, req.Params)
	sel := plannedSelectorFor(op, req)
	for _, p := range op.Params {
		if p.Bounds == nil || !p.Bounds.GrowOnly {
			continue
		}
		keyPath := withSeg(op.Target.Path, manifests.AttrFor(op, p))
		reqVal, hasReq := toFloat(req.Params[p.Name])
		for _, c := range plan.ResourceChanges {
			if c.Address != target {
				continue
			}
			before, okB := numAt(c.Change.Before, keyPath, sel)
			after, okA := numAt(c.Change.After, keyPath, sel)
			if !okB || !okA {
				violations = append(violations, Violation{"grow-only", c.Address, fmt.Sprintf("cannot read numeric %q from plan before/after", keyStr(keyPath))})
				continue
			}
			if before >= after {
				violations = append(violations, Violation{"grow-only", c.Address, fmt.Sprintf("%s must grow: before %s not < after %s", keyStr(keyPath), num(before), num(after))})
			}
			if hasReq && after != reqVal {
				violations = append(violations, Violation{"grow-only", c.Address, fmt.Sprintf("%s after %s != requested %s", keyStr(keyPath), num(after), num(reqVal))})
			}
		}
	}

	// R5 — moved zero-delta: no resource may change, and a moved entry must link
	// previous_address (from) → address (to).
	if op.CodemodOp == "moved_block" {
		from := inventoryAddr(op, req.Params)
		to := movedTo(op, req)
		for _, c := range plan.ResourceChanges {
			if changed(c.Change.Actions) {
				violations = append(violations, Violation{"moved-zero-delta", c.Address, "a moved (rename) must be zero-delta: no resource may change"})
			}
		}
		found := false
		for _, c := range plan.ResourceChanges {
			if c.Address == to && c.PreviousAddress == from {
				found = true
				break
			}
		}
		if !found {
			violations = append(violations, Violation{"moved-zero-delta", to, fmt.Sprintf("no moved entry links previous_address %q → address %q", from, to)})
		}
	}

	// R6 — interior confinement + requested-value-at-path (interior.go).
	// Runs only on the target resource's pure in-place update: replaces/deletes/moves
	// are R2/R3/R5 territory and have no interior to confine. checkInterior reports
	// interior-escape / value-mismatch VIOLATIONs and interior-unverifiable INFO.
	if r6Applies(op) {
		for _, c := range plan.ResourceChanges {
			if !isTargetInPlaceUpdate(c, target) {
				continue
			}
			vs, inf := checkInterior(op, req, c)
			violations = append(violations, vs...)
			info = append(info, inf...)
		}
	}

	// R7 — no-public-ingress (publicingress.go): a NON-engineer_only op may never
	// INTRODUCE a world-open ingress CIDR (0.0.0.0/0 or ::/0) on a security group.
	// Belt-and-braces for manifests.Bounds.CidrPolicy — an op that forgot to declare
	// cidrPolicy still cannot silently emit a world-open ingress rule.
	violations = append(violations, checkPublicIngress(op, plan)...)

	// R7-azure — no-public-ingress-azure (publicingress_azure.go): the azurerm twin of
	// R7 for a NON-engineer_only op — never INTRODUCE an inbound-allow rule that
	// exposes a public source on an Azure NSG (standalone azurerm_network_security_rule
	// or an azurerm_network_security_group's inline security_rule blocks). Additive:
	// it runs independently of and does not alter the AWS R7 path above.
	violations = append(violations, checkPublicIngressAzure(op, plan)...)

	return violations, info
}

// r6Applies reports whether interior confinement is meaningful for op. Whole-resource
// and non-interior codemods are handled by R2/R3/R5 and carry no interior to verify.
// create_resource is skipped too: a from-scratch block has no pre-existing
// interior to confine — the create-guard proves it is a pure create instead.
func r6Applies(op manifests.Op) bool {
	switch op.CodemodOp {
	case "moved_block", "remove_block", "instantiate_module", "create_resource":
		return false
	}
	return true
}

// isTargetInPlaceUpdate reports whether c is the op's target resource undergoing a
// pure in-place update (the only shape R6 confines; create/delete/replace are other
// rules' domain, R2/R3). A replace-flagged update (replace_paths / replace_ reason)
// is excluded — the resource is recreated, so interior confinement is meaningless.
// for_each instance keys under the target count too.
func isTargetInPlaceUpdate(c ResourceChange, target string) bool {
	if !(c.Address == target || strings.HasPrefix(c.Address, target+"[")) {
		return false
	}
	a := c.Change.Actions
	return len(a) == 1 && a[0] == "update" && !isReplace(c)
}

// numAt reads the numeric value at keyPath in root (target.path descended + attr),
// resolving repeated-block indices via the shared R6 walker. Used by R4 grow-only so
// it sees values inside nested blocks, not just top-level attributes.
func numAt(root map[string]any, keyPath []string, sel *plannedSelector) (float64, bool) {
	_, v, ok := walkConcrete(root, keyPath, sel)
	if !ok {
		return 0, false
	}
	return toFloat(v)
}

// allowSet returns the R1 membership predicate for changed addresses plus a
// human description of the expected set.
func allowSet(op manifests.Op, req *request.Request) (func(string) bool, string) {
	switch op.CodemodOp {
	case "moved_block":
		return func(string) bool { return false }, "∅"
	case "instantiate_module":
		prefix := "module." + moduleName(op, req)
		return func(a string) bool { return a == prefix || strings.HasPrefix(a, prefix+".") }, prefix + ".*"
	case "create_resource":
		// R1 for a create: the expected set is the idiom's FULL
		// address set (mandatory ∪ conditional) from the SAME idioms.Addresses the
		// verb and the create-guard use — every changed address must be one of them.
		addrs := idioms.Addresses(op.Target.ResourceType, createName(op, req), req.Params)
		return addrs.Contains, addrs.String()
	default:
		target := inventoryAddr(op, req.Params)
		// for_each-modelled ops also change the instance key target["key"].
		return func(a string) bool { return a == target || strings.HasPrefix(a, target+"[") }, target
	}
}

// inventoryAddr returns the value of the single source:"inventory" param — the
// resource address the op targets (spec).
func inventoryAddr(op manifests.Op, params map[string]any) string {
	for _, p := range op.Params {
		if p.Source == "inventory" {
			if s, ok := params[p.Name].(string); ok {
				return s
			}
		}
	}
	return ""
}

// moduleName derives the module label for an instantiate_module op (best-effort;
// no fixture exercises it — R1 for instantiate is untested by design).
func moduleName(op manifests.Op, req *request.Request) string {
	for _, p := range op.Params {
		if p.Source == "inventory" {
			continue
		}
		if p.Name == "proposed_name" || p.Name == "name" {
			if s, ok := req.Params[p.Name].(string); ok {
				return s
			}
		}
	}
	return ""
}

// createName derives a create's Terraform local name from its single role:"key"
// param via the SAME sanitizer the verb uses (idioms.TfLocalName) — so the R1
// address set and the create-guard address set match the verb's emitted labels.
func createName(op manifests.Op, req *request.Request) string {
	for _, p := range op.Params {
		if p.Role == "key" {
			return idioms.TfLocalName(req.Params[p.Name])
		}
	}
	return idioms.TfLocalName(nil)
}

// createShapeViolations asserts a planned idiom address is a PURE create: exactly
// [create] with before==null. Both checks are independent (a plan can
// breach one without the other), so both may fire — Check never fails fast.
func createShapeViolations(a string, c ResourceChange) []Violation {
	var vs []Violation
	if !(len(c.Change.Actions) == 1 && c.Change.Actions[0] == "create") {
		vs = append(vs, Violation{"create-guard", a, fmt.Sprintf("a create must plan exactly [create]; got %v", c.Change.Actions)})
	}
	if c.Change.Before != nil {
		vs = append(vs, Violation{"create-guard", a, "before != null: the resource already exists"})
	}
	return vs
}

// movedTo computes the moved op's destination address = <type of from>.<new_name>.
func movedTo(op manifests.Op, req *request.Request) string {
	from := inventoryAddr(op, req.Params)
	rtype := from
	if i := strings.Index(from, "."); i >= 0 {
		rtype = from[:i]
	}
	newName := ""
	if s, ok := req.Params["new_name"].(string); ok {
		newName = s
	} else {
		for _, p := range op.Params {
			if p.Source != "inventory" {
				if s, ok := req.Params[p.Name].(string); ok {
					newName = s
					break
				}
			}
		}
	}
	return rtype + "." + newName
}

// changed reports whether an actions slice denotes a real change (not the no-op,
// read, or empty forms).
func changed(actions []string) bool {
	if len(actions) == 0 {
		return false
	}
	if len(actions) == 1 && (actions[0] == "no-op" || actions[0] == "read") {
		return false
	}
	return true
}

// pureDelete is exactly ["delete"] (a whole-resource destroy, not a replace).
func pureDelete(actions []string) bool {
	return len(actions) == 1 && actions[0] == "delete"
}

// isReplace reports a destroy+recreate: create+delete, non-empty replace_paths,
// or any action_reason beginning "replace_".
func isReplace(c ResourceChange) bool {
	if contains(c.Change.Actions, "create") && contains(c.Change.Actions, "delete") {
		return true
	}
	if len(c.Change.ReplacePaths) > 0 {
		return true
	}
	for _, r := range c.ActionReasons {
		if strings.HasPrefix(r, "replace_") {
			return true
		}
	}
	return false
}

func contains(s []string, want string) bool {
	for _, x := range s {
		if x == want {
			return true
		}
	}
	return false
}

// toFloat coerces plan (float64) and request (yaml int/string) numerics uniformly.
func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

// num formats a float without a trailing ".0" for whole numbers (readable reasons).
func num(f float64) string {
	return strconv.FormatFloat(f, 'g', -1, 64)
}
