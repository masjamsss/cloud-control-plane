package main_test

// catalogsmoke_test.go — CTL-11(a): a smoke lane that runs a representative
// request per (codemodOp, service) FAMILY against the SHIPPED catalog
// (ccp/app/src/data/manifests), not a forked fixture manifest. Every golden case
// in this package proves a verb's mechanics against testdata/manifests* — none of
// them prove the PRODUCTION DATA itself still executes. That gap is exactly how
// CTL-1 (a comment-parsing regression with zero comment-bearing fixtures) and
// CTL-3 (waf-add-ip-set-entry declaring a codemodOp whose own arity check made it
// dead on arrival — exit 1 "internal error" on every real invocation) survived a
// fully green suite.
//
// Scope: the foreach/list families — append_foreach_entry, remove_foreach_entry,
// append_list_entry, remove_list_entry. These are the exact families CTL-1 and
// CTL-3 broke in, and the ones CTL-11's own recommendation (b) names for
// comment-rich fixture coverage (testdata/golden/comment-fixtures/ carries those
// — full-line/trailing comments in a map, and a commented list's clean refusal).
// set_attribute / set_attributes / append_block / create_resource /
// instantiate_module / remove_block / moved_block / set_association_attribute /
// swap_child_block carry far more per-op relational shape — selectors,
// discriminators, cross-resource references, nested block paths, schema-aware
// guards — that a generic synthesizer cannot respect without real per-op
// knowledge. Faking values for those risks a synthesis bug reading as a product
// bug (or worse, the reverse). Those verbs stay covered by internal/edit's own
// fixture-manifest suite and this package's golden cases; this lane does not
// claim them.
//
// For each op meeting the (documented, narrow) eligibility bar below, this
// dry-runs `edit` against a synthesized before/ tree — one resource of the op's
// target.resourceType, carrying the target map/list attribute pre-populated —
// and asserts the thing CTL-3 exposed missing: exit code is never 1 (an
// INTERNAL fault). Either the edit succeeds (0, and produces a non-empty diff —
// the append/remove element is synthesized to be a genuine change, never a
// vacuous no-op) or it refuses cleanly with a REFUSE line (2). A shipped
// manifest whose param shape is broken must surface as a routed refusal, never
// as catalogctl silently "crashing" on an L1 operator.

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// smokeFamilies is the codemodOp set this lane knows how to synthesize a
// before/ tree and request for.
var smokeFamilies = map[string]bool{
	"append_foreach_entry": true,
	"remove_foreach_entry": true,
	"append_list_entry":    true,
	"remove_list_entry":    true,
}

// smokeIdent matches a bare HCL attribute identifier — target.block must be one
// (rules out e.g. vpc-add-nacl-rule's "ingress/egress", which is not a literal
// attribute name at all but a hint the real shape differs from this family).
var smokeIdent = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// smokeStringCandidates is tried, in order, against every string-typed
// non-inventory param's bounds until one satisfies them (via the REAL
// manifests.Validate, never a reimplementation of bounds semantics — see
// smokeValues). Deliberately varied shapes so the bound families this catalog
// actually uses — identifier-ish tag keys/values, CIDR host routes, DNS names,
// AWS resource-id shapes — each have a satisfying entry, without hand-modeling
// every op's exact regex.
var smokeStringCandidates = []any{
	"SmokeValue1",
	"smoke-value",
	"smoke_value",
	"10.0.0.1/32",
	"169.254.1.0/30",
	"smoke.example.com",
	"subnet-0123456789abcdef",
	"a",
	"smoke",
}

// smokeReqID is a fixed, schema-valid ccp.request/v1 id (request.go's
// `^REQ-[0-9A-HJKMNP-TV-Z]{26}$`, Crockford base32 — no I/L/O/U). Each subtest
// gets its own throwaway --env tree, so reusing one id across them is safe: the
// id only has to parse, never to be globally unique.
const smokeReqID = "REQ-00000000000000000000TEST01"

// smokeEligible reports whether op fits this lane's synthesizable shape: no
// nested target.path, a bare target.block identifier, and every non-inventory
// param typed string/number/boolean with no selector/discriminator/reference
// role (those need relational data — a real sibling block, a real
// cross-resource address — this generic synthesizer does not have).
//
// Deliberately NOT gated on how many non-inventory params the op carries. An
// op declaring, say, append_foreach_entry with only ONE non-inventory param
// (key, no value) is exactly CTL-3's shape — the manifest's own param list
// disagrees with what its codemodOp needs. Excluding such an op from this
// lane would silently drop the one case the lane exists to catch; running it
// and asserting "never exit 1" (below) is the actual test.
func smokeEligible(op manifests.Op) bool {
	if !smokeFamilies[op.CodemodOp] {
		return false
	}
	if len(op.Target.Path) > 0 || !smokeIdent.MatchString(op.Target.Block) {
		return false
	}
	for _, p := range op.Params {
		if p.Source == "inventory" || p.Role == "const" {
			continue
		}
		if p.Role == "selector" || p.Role == "discriminator" || p.Role == "reference" {
			return false
		}
		switch p.Type {
		case "string", "number", "boolean":
		default:
			return false
		}
	}
	return true
}

// smokeValues builds a params map for op — the inventory param stamped to addr,
// every other (non-const) param assigned a candidate value — that passes the
// REAL manifests.Validate. It never reimplements bounds semantics: it proposes
// a candidate, asks Validate, and on a violation advances ONLY the param
// Validate's reason names. ok=false means no combination in the generic
// candidate pool satisfied this op's bounds (a bespoke pattern beyond what a
// generic smoke value can guess) — the caller skips the op rather than force a
// value that could spuriously fail for a reason having nothing to do with the
// op's actual manifest shape.
func smokeValues(op manifests.Op, addr string) (map[string]any, bool) {
	params := map[string]any{}
	type slot struct {
		name  string
		cands []any
		idx   int
	}
	var slots []slot
	for _, p := range op.Params {
		if p.Role == "const" {
			continue
		}
		if p.Source == "inventory" {
			params[p.Name] = addr
			continue
		}
		var cands []any
		switch {
		case p.Bounds != nil && len(p.Bounds.Allowlist) > 0:
			cands = p.Bounds.Allowlist
		case p.Type == "boolean":
			cands = []any{true, false}
		case p.Type == "number":
			cands = smokeNumberCandidates(p.Bounds)
		default:
			cands = smokeStringCandidates
		}
		if len(cands) == 0 {
			return nil, false
		}
		params[p.Name] = cands[0]
		slots = append(slots, slot{name: p.Name, cands: cands})
	}
	for attempt := 0; attempt < 40; attempt++ {
		code, reason := manifests.Validate(op, params)
		if code == "" {
			return params, true
		}
		advanced := false
		for i := range slots {
			s := &slots[i]
			if !strings.Contains(reason, s.name) {
				continue
			}
			if s.idx+1 >= len(s.cands) {
				continue
			}
			s.idx++
			params[s.name] = s.cands[s.idx]
			advanced = true
			break
		}
		if !advanced {
			return nil, false
		}
	}
	return nil, false
}

func smokeNumberCandidates(b *manifests.Bounds) []any {
	if b == nil {
		return []any{float64(1), float64(10), float64(100)}
	}
	var out []any
	if b.Min != nil {
		out = append(out, *b.Min, *b.Min+1)
	}
	if b.Max != nil {
		out = append(out, *b.Max)
	}
	return append(out, float64(1), float64(10), float64(100))
}

// smokeNonInvOrder returns op.Params filtered to the executor's own
// nonInvParams predicate (source != inventory, role not selector/discriminator)
// — INCLUDING const, matching edit.nonInvParams exactly, so index 0 below is
// whatever appendForeachEntry/removeForeachEntry/listEntry itself would read as
// the key (map family) or the sole value (list family). May be shorter than
// the verb wants (CTL-3's own shape) — every reference to it below is guarded
// for that.
func smokeNonInvOrder(op manifests.Op) []manifests.Param {
	var out []manifests.Param
	for _, p := range op.Params {
		if p.Source == "inventory" || p.Role == "selector" || p.Role == "discriminator" {
			continue
		}
		out = append(out, p)
	}
	return out
}

func TestCatalogSmokeForeachAndListOps(t *testing.T) {
	ops := loadRealCatalogOrSkip(t)

	byPair := map[string]manifests.Op{} // "<codemodOp>\t<service>" -> first (sorted) eligible op
	var ids []string
	for id := range ops {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		op := ops[id]
		if !smokeEligible(op) {
			continue
		}
		key := op.CodemodOp + "\t" + op.Service
		if _, seen := byPair[key]; seen {
			continue
		}
		byPair[key] = op
	}

	var pairs []string
	for k := range byPair {
		pairs = append(pairs, k)
	}
	sort.Strings(pairs)
	if len(pairs) < 20 {
		t.Fatalf("only %d eligible (codemodOp,service) pairs found — the eligibility filter or the catalog shape changed enough that this lane is no longer testing a meaningful slice; investigate before trusting a green run", len(pairs))
	}
	t.Logf("catalog smoke: %d representative ops across %d (codemodOp,service) pairs", len(byPair), len(pairs))

	for _, key := range pairs {
		op := byPair[key]
		t.Run(op.ID, func(t *testing.T) {
			nonInv := smokeNonInvOrder(op)

			addr := op.Target.ResourceType + ".smoke"
			params, ok := smokeValues(op, addr)
			if !ok {
				t.Skipf("no generic candidate value satisfies %q's bounds — outside this lane's generic synthesis (not a product finding)", op.ID)
			}

			isMap := op.CodemodOp == "append_foreach_entry" || op.CodemodOp == "remove_foreach_entry"
			isAdd := op.CodemodOp == "append_foreach_entry" || op.CodemodOp == "append_list_entry"

			// expectChange is true when the before/ tree is built so a CORRECTLY
			// shaped verb is guaranteed to produce a real diff: add always (starts
			// empty), remove only when nonInv actually names something to plant
			// and then remove. When nonInv is too short for the family (CTL-3's
			// own shape — e.g. a remove verb with zero non-inventory params), there
			// is nothing to plant; that's fine, the point of running it at all is
			// the exit-code assertion below, not the diff.
			expectChange := isAdd || len(nonInv) > 0

			var literal string
			switch {
			case isMap && isAdd:
				literal = "{}"
			case isMap && !isAdd && len(nonInv) > 0:
				key := fmt.Sprint(params[nonInv[0].Name])
				literal = fmt.Sprintf("{\n    %s = \"existing\"\n  }", hclStringLit(key))
			case !isMap && isAdd:
				literal = "[]"
			case !isMap && !isAdd && len(nonInv) > 0:
				val := fmt.Sprint(params[nonInv[0].Name])
				literal = fmt.Sprintf("[%s]", hclStringLit(val))
			default: // remove verb with nothing to plant (CTL-3's shape)
				literal = "{}"
				if !isMap {
					literal = "[]"
				}
			}

			work := t.TempDir()
			before := []byte(fmt.Sprintf("resource %s \"smoke\" {\n  %s = %s\n}\n",
				hclStringLit(op.Target.ResourceType), op.Target.Block, literal))
			before = hclwrite.Format(before)
			mainTF := work + "/main.tf"
			if err := writeSmokeFile(mainTF, before); err != nil {
				t.Fatalf("writing synthesized before/ tree: %v", err)
			}

			reqPath := work + "/request.yaml"
			if err := writeSmokeFile(reqPath, []byte(smokeRequestYAML(op, params))); err != nil {
				t.Fatalf("writing synthesized request: %v", err)
			}

			var out, errb bytes.Buffer
			code := cli.Run([]string{
				"edit",
				"--request", reqPath,
				"--manifests", realManifestsDir,
				"--env", work,
				"--dry-run",
			}, &out, &errb)

			if code == 1 {
				t.Fatalf("exit 1 (INTERNAL FAULT) for a shipped op — this is exactly the CTL-3 class: a manifest-shape problem must refuse (exit 2), never crash. stderr:\n%s", errb.String())
			}
			if code == 3 {
				t.Fatalf("exit 3 (resolution/schema error) — either this op's real manifest shape is broken, or (more likely) this lane's synthesized before/request is invalid; investigate before trusting other results. stderr:\n%s", errb.String())
			}
			if code != 0 && code != 2 {
				t.Fatalf("exit %d — want 0 (edit) or 2 (clean refusal). stderr:\n%s", code, errb.String())
			}
			if code == 2 && !strings.Contains(errb.String(), "REFUSE ") {
				t.Fatalf("exit 2 but stderr is not a REFUSE line: %q", errb.String())
			}
			if code == 0 && expectChange && out.Len() == 0 {
				t.Fatalf("exit 0 with an EMPTY diff — the synthesized request always changes something real (a fresh key into an empty map/list, or removing an entry planted for exactly this run); an empty diff here means the edit silently did nothing")
			}
		})
	}
}

func hclStringLit(s string) string { return fmt.Sprintf("%q", s) }

func writeSmokeFile(path string, b []byte) error { return os.WriteFile(path, b, 0o644) }

func smokeRequestYAML(op manifests.Op, params map[string]any) string {
	var keys []string
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("schema: ccp.request/v1\n")
	b.WriteString("id: " + smokeReqID + "\n")
	b.WriteString("item: " + op.ID + "\n")
	b.WriteString("requester_login: catalog-smoke\n")
	b.WriteString("justification: \"CTL-11 catalog smoke against the shipped catalog\"\n")
	b.WriteString("params:\n")
	for _, k := range keys {
		switch v := params[k].(type) {
		case string:
			fmt.Fprintf(&b, "  %s: %s\n", k, hclStringLit(v))
		default:
			fmt.Fprintf(&b, "  %s: %v\n", k, v)
		}
	}
	return b.String()
}
