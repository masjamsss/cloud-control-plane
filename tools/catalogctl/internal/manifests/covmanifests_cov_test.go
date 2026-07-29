package manifests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// covmanifests_cov_test.go closes the coverage holes in manifests.go, dependson.go
// and lint.go. Every case asserts an observable contract: the refusal CODE, the
// reason substring, the resolved HCL identifier, or the returned value — never a
// bare call for the line counter.

// ── helpers (all covmanifests-prefixed; this package dir is shared) ───────────

func covmanifestsf64(v float64) *float64 { return &v }
func covmanifestsint(v int) *int         { return &v }

// covmanifestsdiscOp builds a one-discriminator op whose dynamic token lives in the
// caller-chosen field, so a single builder drives the Path / Block / param-Attr
// resolution paths.
func covmanifestsdiscOp() Op {
	op := Op{ID: "cov-disc", Service: "svc", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_x"
	op.Params = []Param{
		{Name: "target", Source: "inventory", Required: true},
		{Name: "kind", Type: "string", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds:   &Bounds{Allowlist: []any{"ingress", "egress"}},
			Segments: map[string]string{"ingress": "ingress_rule", "egress": "egress_rule"}},
		{Name: "new_v", Source: "user_input", Required: true},
	}
	return op
}

// ── LoadDir error paths ──────────────────────────────────────────────────────

// TestCovmanifestsLoadDirErrorPaths pins LoadDir's three failure modes: a directory
// name that makes the *.json glob itself malformed, a matched entry that cannot be
// read, and a syntactically broken manifest (which must name the offending file so
// the exit-3 schema error is actionable).
func TestCovmanifestsLoadDirErrorPaths(t *testing.T) {
	t.Run("bad glob pattern in dir name", func(t *testing.T) {
		// filepath.Join("a[b", "*.json") is an unterminated character class, so Glob
		// fails before any file is read. LoadDir must surface that error, not nil ops.
		ops, err := LoadDir("a[b")
		if err == nil {
			t.Fatalf("LoadDir on a malformed glob dir = %v, nil err; want an error", ops)
		}
		if ops != nil {
			t.Fatalf("ops = %v, want nil on error", ops)
		}
		if !strings.Contains(err.Error(), "syntax error in pattern") {
			t.Fatalf("err = %v, want a pattern-syntax error", err)
		}
	})

	t.Run("matched entry unreadable", func(t *testing.T) {
		dir := t.TempDir()
		// A DIRECTORY named x.json is matched by the glob but cannot be read.
		if err := os.Mkdir(filepath.Join(dir, "x.json"), 0o755); err != nil {
			t.Fatal(err)
		}
		ops, err := LoadDir(dir)
		if err == nil {
			t.Fatalf("LoadDir = %v, nil err; want a read error", ops)
		}
		if ops != nil {
			t.Fatalf("ops = %v, want nil on error", ops)
		}
		if !strings.Contains(err.Error(), "x.json") {
			t.Fatalf("err = %v, want it to name x.json", err)
		}
	})

	t.Run("malformed JSON names the file", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte(`{"service":`), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := LoadDir(dir)
		if err == nil {
			t.Fatal("LoadDir accepted truncated JSON; want an error")
		}
		if !strings.Contains(err.Error(), "broken.json") {
			t.Fatalf("err = %v, want it to name broken.json", err)
		}
	})

	t.Run("empty dir loads clean", func(t *testing.T) {
		ops, err := LoadDir(t.TempDir())
		if err != nil {
			t.Fatalf("LoadDir(empty) err = %v, want nil", err)
		}
		if len(ops) != 0 {
			t.Fatalf("ops = %v, want empty index", ops)
		}
	})
}

// TestCovmanifestsLoadDirCarriesSafetyData pins that the safety-bearing manifest DATA
// the guards read — forcesReplace, exposure and riskFloor — survives the strict decode
// with the exact values authored. A false zero here would silently disable a guard, so
// the values are asserted in both polarities.
func TestCovmanifestsLoadDirCarriesSafetyData(t *testing.T) {
	dir := t.TempDir()
	a := `{"service":"x","scope":"estate","resourceTypes":["aws_x"],"summary":"s",
	 "operations":[
	   {"id":"x-replace","service":"x","codemodOp":"set_attribute","forcesReplace":true,
	    "exposure":"l3_expert","riskFloor":"HIGH","target":{"resourceType":"aws_x","attr":"encrypted"}},
	   {"id":"x-inplace","service":"x","codemodOp":"set_attribute","forcesReplace":false,
	    "exposure":"l1_self_service","riskFloor":"LOW","target":{"resourceType":"aws_x","attr":"size"}}]}`
	if err := os.WriteFile(filepath.Join(dir, "a.json"), []byte(a), 0o644); err != nil {
		t.Fatal(err)
	}
	ops, err := LoadDir(dir)
	if err != nil {
		t.Fatalf("LoadDir err = %v", err)
	}
	rep, ok := ops["x-replace"]
	if !ok {
		t.Fatal("x-replace missing from index")
	}
	if !rep.ForcesReplace {
		t.Error("ForcesReplace = false, want true (the destructive-op guard reads this)")
	}
	if rep.Exposure != "l3_expert" {
		t.Errorf("Exposure = %q, want l3_expert", rep.Exposure)
	}
	if rep.RiskFloor != "HIGH" {
		t.Errorf("RiskFloor = %q, want HIGH", rep.RiskFloor)
	}
	inp := ops["x-inplace"]
	if inp.ForcesReplace {
		t.Error("in-place op ForcesReplace = true, want false")
	}
	if inp.Exposure != "l1_self_service" {
		t.Errorf("Exposure = %q, want l1_self_service", inp.Exposure)
	}
}

// ── ResolveTarget: Block token, param-Attr refusal, degenerate tokens ────────

// TestCovmanifestsResolveTargetBlockToken covers the Target.Block resolution arm
// (the map-merge / block-name shape): a dynamic block name resolves through the
// segments map, and a token that does not name a discriminator fails closed with the
// input op untouched.
func TestCovmanifestsResolveTargetBlockToken(t *testing.T) {
	t.Run("resolves to the segments value", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Block = "{param:kind}"
		got, code, reason := ResolveTarget(op, map[string]any{"kind": "egress"})
		if code != "" {
			t.Fatalf("unexpected refusal %s: %s", code, reason)
		}
		if got.Target.Block != "egress_rule" {
			t.Fatalf("Target.Block = %q, want egress_rule", got.Target.Block)
		}
		if op.Target.Block != "{param:kind}" {
			t.Fatalf("input op mutated: Target.Block = %q", op.Target.Block)
		}
	})

	t.Run("unknown param in block refuses", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Block = "{param:nope}"
		got, code, reason := ResolveTarget(op, map[string]any{"kind": "egress"})
		if code != RefuseMalformedDynamicTarget {
			t.Fatalf("code = %q (%s), want %s", code, reason, RefuseMalformedDynamicTarget)
		}
		if !strings.Contains(reason, "{param:nope}") || !strings.Contains(reason, "discriminator") {
			t.Fatalf("reason = %q, want it to name the token and the discriminator requirement", reason)
		}
		if got.Target.Block != "{param:nope}" {
			t.Fatalf("refusal must return the op unresolved, got Block = %q", got.Target.Block)
		}
	})

	t.Run("value outside segments map in block refuses", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Block = "{param:kind}"
		_, code, reason := ResolveTarget(op, map[string]any{"kind": "sideways"})
		if code != RefuseUnresolvedDynamicSegment {
			t.Fatalf("code = %q (%s), want %s", code, reason, RefuseUnresolvedDynamicSegment)
		}
		if !strings.Contains(reason, "sideways") {
			t.Fatalf("reason = %q, want it to quote the unmapped value", reason)
		}
	})
}

// TestCovmanifestsResolveTargetParamAttrRefusal covers the Params[i].Attr resolution
// arm's refusal: the ONLY dynamic token is on a value param's attr, so nothing else
// can fail first, and the malformed token must abort the whole resolution.
func TestCovmanifestsResolveTargetParamAttrRefusal(t *testing.T) {
	cases := []struct {
		name     string
		attr     string
		wantCode string
		wantIn   string
	}{
		{"names a missing param", "{param:nope}", RefuseMalformedDynamicTarget, "does not name a role"},
		{"names a non-discriminator param", "{param:new_v}", RefuseMalformedDynamicTarget, "does not name a role"},
		{"empty token name", "{param:}", RefuseMalformedDynamicTarget, "not a whole"},
		{"nested brace in token", "{param:a{b}", RefuseMalformedDynamicTarget, "not a whole"},
		{"infix template", "pre{param:kind}post", RefuseMalformedDynamicTarget, "not a whole"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := covmanifestsdiscOp()
			op.Params[2].Attr = tc.attr
			got, code, reason := ResolveTarget(op, map[string]any{"kind": "ingress", "new_v": "v"})
			if code != tc.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tc.wantCode)
			}
			if !strings.Contains(reason, tc.wantIn) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantIn)
			}
			if got.Params[2].Attr != tc.attr {
				t.Fatalf("refusal must return the op unresolved, got Attr = %q", got.Params[2].Attr)
			}
		})
	}
}

// TestCovmanifestsWholeParamToken pins the whole-segment-only substitution rule
// directly: only an EXACT "{param:NAME}" yields a name, so no request fragment can
// be smuggled into a name's interior.
func TestCovmanifestsWholeParamToken(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		wantOk bool
	}{
		{"{param:kind}", "kind", true},
		{"{param:tunnel_number}", "tunnel_number", true},
		{"{param:}", "", false},       // empty inner name
		{"{param:a{b}", "", false},    // nested opening brace
		{"{param:a}b}", "", false},    // nested closing brace
		{"x{param:kind}", "", false},  // leading text
		{"{param:kind}y", "", false},  // trailing text
		{"{param:kind}{", "", false},  // stray brace, bad suffix
		{"{param:kind", "", false},    // no suffix
		{"param:kind}", "", false},    // no prefix
		{"{param:}}", "", false},      // inner "}"
		{"", "", false},               // empty
		{"{param:", "", false},        // prefix only, len == len(pre)
		{"static_segment", "", false}, // no token at all
	}
	for _, c := range cases {
		got, ok := wholeParamToken(c.in)
		if got != c.want || ok != c.wantOk {
			t.Errorf("wholeParamToken(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.wantOk)
		}
	}
}

// TestCovmanifestsHasDynamicToken pins the cheap pre-check: a "{" in ANY resolvable
// field (block, path segment, param attr) must be seen, and a fully static op must
// not be.
func TestCovmanifestsHasDynamicToken(t *testing.T) {
	t.Run("block", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Block = "{param:kind}"
		if !hasDynamicToken(op) {
			t.Error("hasDynamicToken = false for a dynamic Target.Block")
		}
	})
	t.Run("path", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Path = []string{"outer", "{param:kind}"}
		if !hasDynamicToken(op) {
			t.Error("hasDynamicToken = false for a dynamic path segment")
		}
	})
	t.Run("param attr", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Params[2].Attr = "{param:kind}"
		if !hasDynamicToken(op) {
			t.Error("hasDynamicToken = false for a dynamic param attr")
		}
	})
	t.Run("fully static", func(t *testing.T) {
		op := covmanifestsdiscOp()
		op.Target.Block = "tags"
		op.Target.Path = []string{"metadata_options"}
		op.Params[2].Attr = "http_tokens"
		if hasDynamicToken(op) {
			t.Error("hasDynamicToken = true for a fully static op")
		}
	})
}

// ── ResolveDiscriminator ─────────────────────────────────────────────────────

// TestCovmanifestsResolveDiscriminator pins the direct discriminator resolver
// swap_child_block uses. The role re-check is defense in depth: a param that is not
// role:"discriminator" must refuse MALFORMED_DYNAMIC_TARGET rather than resolve.
func TestCovmanifestsResolveDiscriminator(t *testing.T) {
	disc := Param{Name: "kind", Role: "discriminator",
		Segments: map[string]string{"ingress": "ingress_rule", "egress": "egress_rule"}}

	t.Run("resolves through the segments map", func(t *testing.T) {
		seg, code, reason := ResolveDiscriminator(disc, map[string]any{"kind": "ingress"})
		if code != "" {
			t.Fatalf("unexpected refusal %s: %s", code, reason)
		}
		if seg != "ingress_rule" {
			t.Fatalf("segment = %q, want ingress_rule", seg)
		}
	})

	t.Run("non-discriminator role refuses", func(t *testing.T) {
		for _, role := range []string{"", "value", "selector", "reference", "const"} {
			p := disc
			p.Role = role
			seg, code, reason := ResolveDiscriminator(p, map[string]any{"kind": "ingress"})
			if code != RefuseMalformedDynamicTarget {
				t.Fatalf("role %q: code = %q (%s), want %s", role, code, reason, RefuseMalformedDynamicTarget)
			}
			if seg != "" {
				t.Fatalf("role %q: segment = %q, want empty on refusal", role, seg)
			}
			if !strings.Contains(reason, "discriminator") || !strings.Contains(reason, "kind") {
				t.Fatalf("role %q: reason = %q, want it to name the param and the role", role, reason)
			}
		}
	})

	t.Run("no segments map refuses", func(t *testing.T) {
		p := disc
		p.Segments = nil
		_, code, reason := ResolveDiscriminator(p, map[string]any{"kind": "ingress"})
		if code != RefuseMalformedDynamicTarget {
			t.Fatalf("code = %q (%s), want %s", code, reason, RefuseMalformedDynamicTarget)
		}
		if !strings.Contains(reason, "no segments map") {
			t.Fatalf("reason = %q, want it to name the missing segments map", reason)
		}
	})

	t.Run("unmapped value refuses", func(t *testing.T) {
		_, code, reason := ResolveDiscriminator(disc, map[string]any{"kind": "sideways"})
		if code != RefuseUnresolvedDynamicSegment {
			t.Fatalf("code = %q (%s), want %s", code, reason, RefuseUnresolvedDynamicSegment)
		}
	})

	t.Run("segments value is not an HCL ident refuses", func(t *testing.T) {
		p := disc
		p.Segments = map[string]string{"ingress": "ingress rule"}
		_, code, reason := ResolveDiscriminator(p, map[string]any{"kind": "ingress"})
		if code != RefuseMalformedDynamicTarget {
			t.Fatalf("code = %q (%s), want %s", code, reason, RefuseMalformedDynamicTarget)
		}
		if !strings.Contains(reason, "not a valid HCL identifier") {
			t.Fatalf("reason = %q, want the ident rejection", reason)
		}
	})
}

// ── Validate: bounds arms ────────────────────────────────────────────────────

// TestCovmanifestsValidateNumericBounds pins the non-string min/max arm: a
// non-numeric value fails closed, and both the min and max edges are enforced on
// magnitude (not length).
func TestCovmanifestsValidateNumericBounds(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "n",
		Type:   "number",
		Source: "user_input",
		Bounds: &Bounds{Min: covmanifestsf64(10), Max: covmanifestsf64(100)},
	}}}

	cases := []struct {
		name     string
		v        any
		wantCode string
		wantIn   string
	}{
		{"in range int", 42, "", ""},
		{"in range float64", 42.5, "", ""},
		{"at min", 10, "", ""},
		{"at max", 100, "", ""},
		{"below min", 9, "OUT_OF_BOUNDS", "below min"},
		{"below min float", 9.5, "OUT_OF_BOUNDS", "below min"},
		{"above max", 101, "OUT_OF_BOUNDS", "above max"},
		{"numeric string in range", "42", "", ""},
		{"numeric string below min", "9", "OUT_OF_BOUNDS", "below min"},
		{"bool is not numeric", true, "OUT_OF_BOUNDS", "is not numeric"},
		{"non-numeric string", "many", "OUT_OF_BOUNDS", "is not numeric"},
		{"list is not numeric", []any{1}, "OUT_OF_BOUNDS", "is not numeric"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, reason := Validate(op, map[string]any{"n": tc.v})
			if code != tc.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tc.wantCode)
			}
			if tc.wantIn != "" && !strings.Contains(reason, tc.wantIn) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantIn)
			}
			if tc.wantCode == "" && reason != "" {
				t.Fatalf("clean case carried reason %q", reason)
			}
		})
	}
}

// TestCovmanifestsValidateItemCountBounds pins the minItems/maxItems arm: a
// non-list value fails closed, and both count edges are inclusive.
func TestCovmanifestsValidateItemCountBounds(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "items",
		Type:   "array",
		Source: "user_input",
		Bounds: &Bounds{MinItems: covmanifestsint(2), MaxItems: covmanifestsint(3)},
	}}}

	cases := []struct {
		name     string
		v        any
		wantCode string
		wantIn   string
	}{
		{"at minItems", []any{"a", "b"}, "", ""},
		{"at maxItems", []any{"a", "b", "c"}, "", ""},
		{"below minItems", []any{"a"}, "OUT_OF_BOUNDS", "below minItems 2"},
		{"empty below minItems", []any{}, "OUT_OF_BOUNDS", "below minItems 2"},
		{"above maxItems", []any{"a", "b", "c", "d"}, "OUT_OF_BOUNDS", "above maxItems 3"},
		{"scalar is not a list", "a", "OUT_OF_BOUNDS", "is not a list"},
		{"map is not a list", map[string]any{"a": 1}, "OUT_OF_BOUNDS", "is not a list"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, reason := Validate(op, map[string]any{"items": tc.v})
			if code != tc.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tc.wantCode)
			}
			if tc.wantIn != "" && !strings.Contains(reason, tc.wantIn) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantIn)
			}
		})
	}

	// minItems only / maxItems only each still enforce their own edge.
	minOnly := Op{Params: []Param{{Name: "items", Type: "array", Source: "user_input",
		Bounds: &Bounds{MinItems: covmanifestsint(1)}}}}
	if code, _ := Validate(minOnly, map[string]any{"items": []any{}}); code != "OUT_OF_BOUNDS" {
		t.Errorf("minItems-only empty list code = %q, want OUT_OF_BOUNDS", code)
	}
	maxOnly := Op{Params: []Param{{Name: "items", Type: "array", Source: "user_input",
		Bounds: &Bounds{MaxItems: covmanifestsint(1)}}}}
	if code, _ := Validate(maxOnly, map[string]any{"items": []any{"a", "b"}}); code != "OUT_OF_BOUNDS" {
		t.Errorf("maxItems-only 2-element list code = %q, want OUT_OF_BOUNDS", code)
	}
	if code, _ := Validate(maxOnly, map[string]any{"items": []any{"a"}}); code != "" {
		t.Errorf("maxItems-only 1-element list code = %q, want clean", code)
	}
}

// TestCovmanifestsValidateMaxLength pins the maxLength arm against the fmt.Sprint
// canonical form of the value, with the limit itself inclusive.
func TestCovmanifestsValidateMaxLength(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "name",
		Type:   "string",
		Source: "user_input",
		Bounds: &Bounds{MaxLength: covmanifestsint(5)},
	}}}
	if code, reason := Validate(op, map[string]any{"name": "abcde"}); code != "" {
		t.Fatalf("at-limit code = %q (%s), want clean", code, reason)
	}
	code, reason := Validate(op, map[string]any{"name": "abcdef"})
	if code != "OUT_OF_BOUNDS" {
		t.Fatalf("over-limit code = %q, want OUT_OF_BOUNDS", code)
	}
	if !strings.Contains(reason, "length 6 above maxLength 5") {
		t.Fatalf("reason = %q, want it to state the measured and allowed lengths", reason)
	}
}

// TestCovmanifestsValidateInvalidBoundPattern pins the fail-closed behaviour for an
// UNCOMPILABLE bound regex: a manifest typo must be refused OUT_OF_BOUNDS, never
// treated as "no pattern" (which would silently disable the guard).
func TestCovmanifestsValidateInvalidBoundPattern(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "x",
		Type:   "string",
		Source: "user_input",
		Bounds: &Bounds{Pattern: "([a-z"},
	}}}
	code, reason := Validate(op, map[string]any{"x": "abc"})
	if code != "OUT_OF_BOUNDS" {
		t.Fatalf("code = %q, want OUT_OF_BOUNDS for an uncompilable bound pattern", code)
	}
	if !strings.Contains(reason, "invalid bound pattern") || !strings.Contains(reason, "([a-z") {
		t.Fatalf("reason = %q, want it to name the invalid pattern", reason)
	}
}

// TestCovmanifestsValidateSkipsInactiveParam pins the dependsOn gate inside Validate:
// an INACTIVE param is never required AND its bounds are not applied, while the same
// param under a satisfied condition is fully enforced. Without this a required param
// hidden behind an unsatisfied dependsOn would be spuriously refused.
func TestCovmanifestsValidateSkipsInactiveParam(t *testing.T) {
	op := Op{Params: []Param{
		{Name: "throughput_mode", Type: "string", Source: "allowlist", Required: true,
			Bounds: &Bounds{Allowlist: []any{"bursting", "provisioned"}}},
		{Name: "provisioned_mibps", Type: "number", Source: "user_input", Required: true,
			DependsOn: json.RawMessage(`{"param":"throughput_mode","equals":"provisioned"}`),
			Bounds:    &Bounds{Min: covmanifestsf64(1), Max: covmanifestsf64(1024)}},
	}}

	cases := []struct {
		name     string
		params   map[string]any
		wantCode string
		wantIn   string
	}{
		{"inactive and absent is clean",
			map[string]any{"throughput_mode": "bursting"}, "", ""},
		{"inactive bounds are not applied",
			map[string]any{"throughput_mode": "bursting", "provisioned_mibps": 99999}, "", ""},
		{"active and absent is refused",
			map[string]any{"throughput_mode": "provisioned"}, "OUT_OF_BOUNDS", "required param missing"},
		{"active bounds are applied",
			map[string]any{"throughput_mode": "provisioned", "provisioned_mibps": 99999}, "OUT_OF_BOUNDS", "above max"},
		{"active and in bounds is clean",
			map[string]any{"throughput_mode": "provisioned", "provisioned_mibps": 512}, "", ""},
		{"controller absent deactivates the dependent",
			map[string]any{}, "OUT_OF_BOUNDS", "throughput_mode: required param missing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, reason := Validate(op, tc.params)
			if code != tc.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tc.wantCode)
			}
			if tc.wantIn != "" && !strings.Contains(reason, tc.wantIn) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantIn)
			}
		})
	}
}

// TestCovmanifestsValidateSkipArms pins the two params Validate must NOT bound-check:
// a role:"const" param (no request input exists — the executor writes p.Const straight
// from the manifest) and an ABSENT optional param. Both must pass even when the value
// present in the request map would violate the bound, and a present optional param is
// still checked.
func TestCovmanifestsValidateSkipArms(t *testing.T) {
	t.Run("role const is skipped even when violating", func(t *testing.T) {
		op := Op{Params: []Param{{
			Name: "protocol", Type: "string", Source: "user_input", Required: true, Role: "const",
			Const:  "-1",
			Bounds: &Bounds{Allowlist: []any{"tcp", "udp"}},
		}}}
		// Absent from the request (the normal case for a const) — no missing-param refusal.
		if code, reason := Validate(op, map[string]any{}); code != "" {
			t.Fatalf("absent const param code = %q (%s), want clean", code, reason)
		}
		// Even a present, off-allowlist value is not re-validated for a const param.
		if code, reason := Validate(op, map[string]any{"protocol": "zzz"}); code != "" {
			t.Fatalf("present off-allowlist const code = %q (%s), want clean", code, reason)
		}
	})

	t.Run("absent optional param is skipped", func(t *testing.T) {
		op := Op{Params: []Param{
			{Name: "target", Source: "inventory", Required: true},
			{Name: "opt", Type: "number", Source: "user_input", Required: false,
				Bounds: &Bounds{Min: covmanifestsf64(1), Max: covmanifestsf64(10)}},
		}}
		if code, reason := Validate(op, map[string]any{"target": "aws_x.y"}); code != "" {
			t.Fatalf("absent optional param code = %q (%s), want clean", code, reason)
		}
		// Present, it IS bound-checked.
		if code, _ := Validate(op, map[string]any{"target": "aws_x.y", "opt": 99}); code != "OUT_OF_BOUNDS" {
			t.Fatalf("present out-of-range optional code = %q, want OUT_OF_BOUNDS", code)
		}
		if code, reason := Validate(op, map[string]any{"target": "aws_x.y", "opt": 5}); code != "" {
			t.Fatalf("present in-range optional code = %q (%s), want clean", code, reason)
		}
	})

	t.Run("param with nil bounds is accepted", func(t *testing.T) {
		op := Op{Params: []Param{{Name: "free", Type: "string", Source: "user_input", Required: true}}}
		if code, reason := Validate(op, map[string]any{"free": "anything at all"}); code != "" {
			t.Fatalf("unbounded param code = %q (%s), want clean", code, reason)
		}
	})
}

// ── AttrFor ──────────────────────────────────────────────────────────────────

// TestCovmanifestsAttrFor pins the write-target attribute resolution every codemod
// shares: an explicit param-level Attr wins outright, otherwise the frozen fallback is
// TrimPrefix(name, "new_") with the resourceType's rename table applied.
func TestCovmanifestsAttrFor(t *testing.T) {
	cases := []struct {
		name         string
		resourceType string
		param        Param
		want         string
	}{
		{"explicit param attr wins", "aws_ebs_volume",
			Param{Name: "new_size_gib", Attr: "lifecycle_config_arns"}, "lifecycle_config_arns"},
		{"explicit attr wins over the rename table", "aws_ebs_volume",
			Param{Name: "new_size_gib", Attr: "iops"}, "iops"},
		{"new_ prefix trimmed", "aws_instance",
			Param{Name: "new_instance_type"}, "instance_type"},
		{"no new_ prefix is untouched", "aws_instance",
			Param{Name: "http_tokens"}, "http_tokens"},
		{"rename table applied after trim", "aws_ebs_volume",
			Param{Name: "new_size_gib"}, "size"},
		{"rename table applied without a prefix", "aws_ebs_volume",
			Param{Name: "size_gib"}, "size"},
		{"resourceType has a table but the name is absent from it", "aws_ebs_volume",
			Param{Name: "new_iops"}, "iops"},
		{"resourceType has no table", "aws_sagemaker_domain",
			Param{Name: "new_size_gib"}, "size_gib"},
		{"empty name yields empty attr", "aws_instance",
			Param{Name: ""}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := Op{}
			op.Target.ResourceType = tc.resourceType
			if got := AttrFor(op, tc.param); got != tc.want {
				t.Fatalf("AttrFor(%s, %+v) = %q, want %q", tc.resourceType, tc.param, got, tc.want)
			}
		})
	}
}

// ── elementsOf / toFloat ─────────────────────────────────────────────────────

// TestCovmanifestsElementsOf pins the per-element expansion a bound is checked
// against, including the map[any]any shape a YAML request can produce: BOTH keys and
// values are yielded, in sorted-key order so the first-violation reason is stable.
func TestCovmanifestsElementsOf(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want []any
	}{
		{"scalar yields itself", "a", []any{"a"}},
		{"nil yields itself", nil, []any{nil}},
		{"list yields members", []any{"a", "b"}, []any{"a", "b"}},
		{"string map yields sorted key,value pairs",
			map[string]any{"b": 2, "a": 1}, []any{"a", 1, "b", 2}},
		{"any-keyed map yields sorted key,value pairs",
			map[any]any{"b": 2, "a": 1}, []any{"a", 1, "b", 2}},
		{"any-keyed map stringifies non-string keys",
			map[any]any{2: "two", 10: "ten"}, []any{"10", "ten", "2", "two"}},
		{"empty any-keyed map yields nothing", map[any]any{}, []any{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := elementsOf(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("elementsOf(%#v) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

// TestCovmanifestsValidateAnyKeyedMapBounds pins the same map[any]any expansion
// through the real Validate entry point: a bound on a YAML-shaped map param must see
// the KEYS, so a crafted key cannot bypass validation.
func TestCovmanifestsValidateAnyKeyedMapBounds(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "tags",
		Type:   "map",
		Source: "user_input",
		Bounds: &Bounds{Pattern: `^[A-Za-z][A-Za-z0-9_-]{0,64}$`},
	}}}
	if code, reason := Validate(op, map[string]any{"tags": map[any]any{"Owner": "platform-team"}}); code != "" {
		t.Fatalf("clean any-keyed map code = %q (%s), want clean", code, reason)
	}
	// Every member of the confirmed HCL-injection alphabet is refused when it arrives
	// as a KEY of a YAML-shaped map — pre-fix the map collapsed to one fmt.Sprint
	// element and the keys were never bound-checked at all.
	for _, badKey := range []string{`a"b`, `a=b`, `a b`, "a\nb", `a/b`} {
		if code, _ := Validate(op, map[string]any{"tags": map[any]any{badKey: "prod"}}); code != "OUT_OF_BOUNDS" {
			t.Fatalf("injection-alphabet KEY %q code = %q, want OUT_OF_BOUNDS", badKey, code)
		}
	}
	// The reason names the param and quotes the offending element.
	_, reason := Validate(op, map[string]any{"tags": map[any]any{`a=b`: "prod"}})
	if !strings.Contains(reason, `tags "a=b"`) || !strings.Contains(reason, "does not match pattern") {
		t.Fatalf("reason = %q, want it to name the param and quote the offending key", reason)
	}
	if code, _ := Validate(op, map[string]any{"tags": map[any]any{"Owner": "bad value"}}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("dirty VALUE in any-keyed map code = %q, want OUT_OF_BOUNDS", code)
	}
}

// TestCovmanifestsToFloat pins the numeric coercion every non-string min/max bound
// runs through: each accepted Go/JSON numeric shape converts, and everything else
// fails closed so the bound refuses rather than silently comparing against zero.
func TestCovmanifestsToFloat(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want float64
		ok   bool
	}{
		{"float64", float64(1.5), 1.5, true},
		{"float32", float32(2.5), 2.5, true},
		{"int", int(3), 3, true},
		{"int64", int64(4), 4, true},
		{"json.Number integral", json.Number("5"), 5, true},
		{"json.Number fractional", json.Number("5.25"), 5.25, true},
		{"json.Number malformed", json.Number("5x"), 0, false},
		{"numeric string", "6.5", 6.5, true},
		{"numeric string negative", "-7", -7, true},
		{"non-numeric string", "seven", 0, false},
		{"empty string", "", 0, false},
		{"bool", true, 0, false},
		{"nil", nil, 0, false},
		{"list", []any{1}, 0, false},
		{"map", map[string]any{"a": 1}, 0, false},
		{"uint (unmodeled)", uint(8), 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toFloat(tc.in)
			if ok != tc.ok {
				t.Fatalf("toFloat(%#v) ok = %v, want %v", tc.in, ok, tc.ok)
			}
			if got != tc.want {
				t.Fatalf("toFloat(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// ── dependson.go ─────────────────────────────────────────────────────────────

// TestCovmanifestsIsParamActive pins the Go twin of dependsOn.ts#isParamActive. Every
// non-satisfied shape must fail CLOSED (inactive/hidden), including a malformed
// condition and a condition with no operator.
func TestCovmanifestsIsParamActive(t *testing.T) {
	cases := []struct {
		name      string
		dependsOn string
		values    map[string]any
		want      bool
	}{
		{"no dependsOn is always active", "", map[string]any{}, true},
		{"explicit JSON null is always active", `null`, map[string]any{}, true},
		{"equals satisfied", `{"param":"mode","equals":"provisioned"}`,
			map[string]any{"mode": "provisioned"}, true},
		{"equals unsatisfied", `{"param":"mode","equals":"provisioned"}`,
			map[string]any{"mode": "bursting"}, false},
		{"notEquals satisfied", `{"param":"mode","notEquals":"bursting"}`,
			map[string]any{"mode": "provisioned"}, true},
		{"notEquals unsatisfied", `{"param":"mode","notEquals":"bursting"}`,
			map[string]any{"mode": "bursting"}, false},
		{"controller absent is inactive", `{"param":"mode","equals":"provisioned"}`,
			map[string]any{}, false},
		{"controller nil is inactive", `{"param":"mode","equals":"provisioned"}`,
			map[string]any{"mode": nil}, false},
		{"controller empty string is inactive", `{"param":"mode","equals":""}`,
			map[string]any{"mode": ""}, false},
		{"controller absent is inactive under notEquals too",
			`{"param":"mode","notEquals":"bursting"}`, map[string]any{}, false},
		{"controller nil is inactive under notEquals too",
			`{"param":"mode","notEquals":"bursting"}`, map[string]any{"mode": nil}, false},
		{"malformed condition (array) is inactive", `[1]`,
			map[string]any{"mode": "provisioned"}, false},
		{"malformed condition (scalar) is inactive", `"nope"`,
			map[string]any{"mode": "provisioned"}, false},
		{"no operator is inactive", `{"param":"mode"}`,
			map[string]any{"mode": "provisioned"}, false},
		{"null operator is inactive", `{"param":"mode","equals":null}`,
			map[string]any{"mode": "provisioned"}, false},
		// Canonicalization: comparison is fmt.Sprint on both sides, so a JSON number
		// and an int/float request value agree (same rule Validate's allowlist uses).
		{"int controller vs JSON number equals", `{"param":"n","equals":1}`,
			map[string]any{"n": 1}, true},
		{"float controller vs JSON number equals", `{"param":"n","equals":1}`,
			map[string]any{"n": 1.0}, true},
		{"string controller vs JSON number equals", `{"param":"n","equals":1}`,
			map[string]any{"n": "1"}, true},
		{"bool controller vs JSON bool equals", `{"param":"b","equals":true}`,
			map[string]any{"b": true}, true},
		{"zero controller is NOT empty", `{"param":"n","equals":0}`,
			map[string]any{"n": 0}, true},
		{"false controller is NOT empty", `{"param":"b","equals":false}`,
			map[string]any{"b": false}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := Param{Name: "dependent"}
			if tc.dependsOn != "" {
				p.DependsOn = json.RawMessage(tc.dependsOn)
			}
			if got := IsParamActive(p, tc.values); got != tc.want {
				t.Fatalf("IsParamActive(dependsOn=%s, %v) = %v, want %v",
					tc.dependsOn, tc.values, got, tc.want)
			}
		})
	}
}

// TestCovmanifestsIsEmptyController pins isEmptyController's mirror of
// dependsOn.ts#isEmpty: ONLY nil and "" are empty — 0, false and an empty
// list/map are real values that keep a dependent active.
func TestCovmanifestsIsEmptyController(t *testing.T) {
	empty := []any{nil, ""}
	for _, v := range empty {
		if !isEmptyController(v) {
			t.Errorf("isEmptyController(%#v) = false, want true", v)
		}
	}
	notEmpty := []any{"x", 0, 0.0, false, true, []any{}, map[string]any{}}
	for _, v := range notEmpty {
		if isEmptyController(v) {
			t.Errorf("isEmptyController(%#v) = true, want false", v)
		}
	}
}

// TestCovmanifestsRawPresentAndRawToAny pins the two RawMessage helpers that decide
// "was this operator authored at all": absent and explicit-null both read as absent,
// and an unparseable payload decodes to nil rather than panicking.
func TestCovmanifestsRawPresentAndRawToAny(t *testing.T) {
	t.Run("rawPresent", func(t *testing.T) {
		cases := []struct {
			raw  string
			want bool
		}{
			{"", false},
			{"null", false},
			{`"x"`, true},
			{"0", true},
			{"false", true},
			{`{"a":1}`, true},
		}
		for _, c := range cases {
			if got := rawPresent(json.RawMessage(c.raw)); got != c.want {
				t.Errorf("rawPresent(%q) = %v, want %v", c.raw, got, c.want)
			}
		}
	})

	t.Run("rawToAny", func(t *testing.T) {
		if got := rawToAny(json.RawMessage(`"x"`)); got != "x" {
			t.Errorf("rawToAny(\"x\") = %#v, want \"x\"", got)
		}
		if got := rawToAny(json.RawMessage(`1`)); got != 1.0 {
			t.Errorf("rawToAny(1) = %#v, want float64(1)", got)
		}
		if got := rawToAny(json.RawMessage(`true`)); got != true {
			t.Errorf("rawToAny(true) = %#v, want true", got)
		}
		// Unparseable bytes fail closed to nil (the caller then compares against
		// fmt.Sprint(nil) = "<nil>", which no controller value matches).
		for _, bad := range []string{`{`, `@`, ``, `"unterminated`} {
			if got := rawToAny(json.RawMessage(bad)); got != nil {
				t.Errorf("rawToAny(%q) = %#v, want nil", bad, got)
			}
		}
	})
}

// ── lint.go ──────────────────────────────────────────────────────────────────

// TestCovmanifestsFindingString pins the Finding render the CI gate prints, so a
// finding is always attributable to a rule, an op, and a service.
func TestCovmanifestsFindingString(t *testing.T) {
	f := Finding{Rule: RuleProseAttr, OpID: "ec2-resize", Service: "ec2", Detail: "writes attribute \"x\""}
	want := `[prose-attr] ec2-resize (ec2): writes attribute "x"`
	if got := f.String(); got != want {
		t.Fatalf("Finding.String() = %q, want %q", got, want)
	}

	// A zero Finding still renders every field position (no panic, no dropped field).
	if got := (Finding{}).String(); got != "[]  (): " {
		t.Fatalf("zero Finding.String() = %q, want %q", got, "[]  (): ")
	}
}

// TestCovmanifestsLintDeterministicOrder pins that Lint walks the catalogue in op-id
// order regardless of Go's randomized map iteration, so the CI gate's output is
// stable run to run.
func TestCovmanifestsLintDeterministicOrder(t *testing.T) {
	// Three ops each carrying exactly one target-arity finding (zero locators).
	mk := func(id string) Op {
		op := Op{ID: id, Service: "svc", CodemodOp: "remove_list_entry"}
		op.Target.ResourceType = "aws_x"
		return op
	}
	ops := map[string]Op{"c-op": mk("c-op"), "a-op": mk("a-op"), "b-op": mk("b-op")}
	for i := 0; i < 5; i++ {
		fs := Lint(ops)
		got := make([]string, 0, len(fs))
		for _, f := range fs {
			if f.Rule != RuleTargetArity {
				t.Fatalf("unexpected rule %q for %s", f.Rule, f.OpID)
			}
			got = append(got, f.OpID)
		}
		want := []string{"a-op", "b-op", "c-op"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("run %d order = %v, want %v", i, got, want)
		}
	}

	// create_resource is exempt from target-arity alongside instantiate_module: a
	// create authors a net-new resource, so it has no inventory locator to bind.
	cr := Op{ID: "cr", Service: "svc", CodemodOp: "create_resource"}
	cr.Target.ResourceType = "aws_x"
	if fs := Lint(map[string]Op{"cr": cr}); len(fs) != 0 {
		t.Fatalf("create_resource findings = %v, want none", fs)
	}

	// An empty catalogue yields no findings (and no nil-deref).
	if fs := Lint(map[string]Op{}); len(fs) != 0 {
		t.Fatalf("empty catalogue findings = %v, want none", fs)
	}
}

// ── regressions for two fail-open holes found during the coverage sweep ──────

// A duplicate operation id used to overwrite silently (last glob-order write
// wins), dropping one definition from the catalogue with no error — so a
// laxer duplicate could quietly replace a forcesReplace/riskFloor-bearing op.
// LoadDir's stated contract is to fail VISIBLY on manifest drift.
func TestCovmanifestsLoadDirRefusesDuplicateOpIDs(t *testing.T) {
	const dupInOneFile = `{"service":"s3","operations":[
		{"id":"dup-op","service":"s3","macd":"change","codemodOp":"set_attribute","title":"A"},
		{"id":"dup-op","service":"s3","macd":"change","codemodOp":"set_attribute","title":"B"}
	]}`
	t.Run("within a single file", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "s3.json"), []byte(dupInOneFile), 0o644); err != nil {
			t.Fatal(err)
		}
		ops, err := LoadDir(dir)
		if err == nil {
			t.Fatalf("LoadDir accepted a duplicate op id, returning %d ops", len(ops))
		}
		if !strings.Contains(err.Error(), "duplicate operation id") || !strings.Contains(err.Error(), "dup-op") {
			t.Errorf("error should name the duplicate id, got %q", err)
		}
	})
	t.Run("across two files", func(t *testing.T) {
		dir := t.TempDir()
		one := `{"service":"s3","operations":[{"id":"shared","service":"s3","macd":"change","codemodOp":"set_attribute","title":"A"}]}`
		two := `{"service":"ec2","operations":[{"id":"shared","service":"ec2","macd":"change","codemodOp":"set_attribute","title":"B"}]}`
		for name, body := range map[string]string{"a-s3.json": one, "b-ec2.json": two} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := LoadDir(dir); err == nil {
			t.Fatal("LoadDir accepted the same op id defined by two services")
		}
	})
	t.Run("distinct ids still load", func(t *testing.T) {
		dir := t.TempDir()
		body := `{"service":"s3","operations":[
			{"id":"op-a","service":"s3","macd":"change","codemodOp":"set_attribute","title":"A"},
			{"id":"op-b","service":"s3","macd":"change","codemodOp":"set_attribute","title":"B"}
		]}`
		if err := os.WriteFile(filepath.Join(dir, "s3.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		ops, err := LoadDir(dir)
		if err != nil {
			t.Fatalf("LoadDir on distinct ids: %v", err)
		}
		if len(ops) != 2 {
			t.Fatalf("loaded %d ops, want 2", len(ops))
		}
	})
}

// maxLength used to measure fmt.Sprint of the WHOLE value, so on a collection
// param it bounded the Go repr (brackets and separators included) rather than
// each element — no real per-element cap, and short elements wrongly refused.
func TestCovmanifestsMaxLengthIsPerElement(t *testing.T) {
	maxLen := 5
	op := Op{ID: "o", Service: "s", Macd: "change", CodemodOp: "set_attribute"}
	op.Params = []Param{{Name: "tags", Type: "list", Bounds: &Bounds{MaxLength: &maxLen}}}

	t.Run("a list of short elements is accepted despite a long repr", func(t *testing.T) {
		// repr is "[aaa bbb ccc]" = 13 chars; every ELEMENT is 3.
		code, reason := Validate(op, map[string]any{"tags": []any{"aaa", "bbb", "ccc"}})
		if code != "" {
			t.Fatalf("refused a list of 3-char elements against maxLength 5: %s %s", code, reason)
		}
	})
	t.Run("a single over-long element is refused", func(t *testing.T) {
		code, reason := Validate(op, map[string]any{"tags": []any{"ok", "waytoolong"}})
		if code != "OUT_OF_BOUNDS" {
			t.Fatalf("code = %q, want OUT_OF_BOUNDS (an element exceeds maxLength)", code)
		}
		if !strings.Contains(reason, "10") {
			t.Errorf("reason should report the offending element's length, got %q", reason)
		}
	})
	t.Run("scalar behaviour is unchanged", func(t *testing.T) {
		sop := Op{ID: "o", Service: "s", Macd: "change", CodemodOp: "set_attribute"}
		sop.Params = []Param{{Name: "name", Type: "string", Bounds: &Bounds{MaxLength: &maxLen}}}
		if code, _ := Validate(sop, map[string]any{"name": "abcd"}); code != "" {
			t.Fatalf("a 4-char scalar was refused against maxLength 5: %s", code)
		}
		if code, _ := Validate(sop, map[string]any{"name": "abcdef"}); code != "OUT_OF_BOUNDS" {
			t.Fatalf("a 6-char scalar was accepted against maxLength 5: %q", code)
		}
	})
}

// set_attribute writes exactly ONE attribute (edit.valueParam takes the first
// provider), so a second value provider is silently dropped at exit 0 with a
// diff that looks complete. The lint names that shape at load time.
func TestCovmanifestsMultiValueProviderRule(t *testing.T) {
	mk := func(codemod string, params ...Param) Op {
		op := Op{ID: "o", Service: "s", Macd: "change", CodemodOp: codemod, Params: params}
		op.Target.ResourceType = "aws_thing"
		op.Target.Attr = "a"
		return op
	}
	locator := Param{Name: "target", Source: "inventory"}
	v1 := Param{Name: "noncurrent_days", Source: "user_input"}
	v2 := Param{Name: "storage_class", Source: "user_input"}

	find := func(op Op) *Finding {
		for _, f := range Lint(map[string]Op{op.ID: op}) {
			if f.Rule == RuleMultiValueProvider {
				return &f
			}
		}
		return nil
	}

	t.Run("two value providers is a finding naming both and the survivor", func(t *testing.T) {
		f := find(mk("set_attribute", locator, v1, v2))
		if f == nil {
			t.Fatal("no multi-value-provider finding for a 2-provider set_attribute")
		}
		for _, want := range []string{"noncurrent_days", "storage_class", "set_attributes"} {
			if !strings.Contains(f.Detail, want) {
				t.Errorf("detail should mention %q, got %q", want, f.Detail)
			}
		}
	})
	t.Run("one value provider is clean", func(t *testing.T) {
		if f := find(mk("set_attribute", locator, v1)); f != nil {
			t.Fatalf("a single-provider set_attribute was flagged: %s", f.Detail)
		}
	})
	t.Run("set_attributes is the verb for that shape and is not flagged", func(t *testing.T) {
		if f := find(mk("set_attributes", locator, v1, v2)); f != nil {
			t.Fatalf("set_attributes was flagged: %s", f.Detail)
		}
	})
	t.Run("tagging the picker as a selector clears it", func(t *testing.T) {
		picker := Param{Name: "tunnel_number", Source: "user_input", Role: "selector"}
		if f := find(mk("set_attribute", locator, picker, v1)); f != nil {
			t.Fatalf("a role:selector picker still counted as a value provider: %s", f.Detail)
		}
	})
}
