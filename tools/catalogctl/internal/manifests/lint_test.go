package manifests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProseAttrToken(t *testing.T) {
	cases := []struct{ tc, want string }{
		{"~ update (disable_api_termination)", "disable_api_termination"},
		{"~ update (metadata_options.http_tokens)", "metadata_options.http_tokens"},
		{"~ update (grow-only)", ""},                      // hyphen → not a bare token
		{"~ update (rule priority, in-place)", ""},        // spaces/commas → prose
		{"~ update (backup_policy.status → ENABLED)", ""}, // arrow + space
		{"-/+ replace (encrypted)", "encrypted"},
		{"no parens here", ""},
		{"(unterminated", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := ProseAttrToken(c.tc); got != c.want {
			t.Errorf("ProseAttrToken(%q) = %q, want %q", c.tc, got, c.want)
		}
	}
}

func TestIsValueProvider(t *testing.T) {
	cases := []struct {
		p    Param
		want bool
	}{
		{Param{Source: "user_input"}, true},
		{Param{Source: "allowlist"}, true},
		{Param{Source: "inventory"}, false},                    // plain inventory target
		{Param{Source: "inventory", Role: "reference"}, true},  // reference writes a value
		{Param{Source: "user_input", Role: "selector"}, false}, // selector picks a block
		{Param{Source: "user_input", Role: "discriminator"}, false},
	}
	for i, c := range cases {
		if got := IsValueProvider(c.p); got != c.want {
			t.Errorf("case %d IsValueProvider(%+v) = %v, want %v", i, c.p, got, c.want)
		}
	}
}

// setAttr builds a flat scalar set_attribute op for lint tests.
func setAttrOp(id, tc, targetAttr string, params ...Param) Op {
	op := Op{ID: id, Service: "svc", CodemodOp: "set_attribute", TerraformCapability: tc, Params: params}
	op.Target.ResourceType = "aws_x"
	op.Target.Attr = targetAttr
	return op
}

func findRule(fs []Finding, rule string) bool {
	for _, f := range fs {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

func TestLintProseAttrDemotion(t *testing.T) {
	locator := Param{Name: "target", Source: "inventory"}
	value := Param{Name: "new_v", Source: "user_input"}

	// Prose-dependent (paren token, no target.attr) → flagged.
	op := setAttrOp("prose-op", "~ update (some_attr)", "", locator, value)
	if !findRule(lintOp(op), RuleProseAttr) {
		t.Error("expected RuleProseAttr for a prose-dependent flat set_attribute op")
	}

	// Migrated (explicit target.attr) → NOT flagged, even with a paren token present.
	op = setAttrOp("migrated-op", "~ update (some_attr)", "some_attr", locator, value)
	if findRule(lintOp(op), RuleProseAttr) {
		t.Error("target.attr set → must not be flagged as prose-dependent")
	}

	// No bare paren token (prose) → NOT prose-dependent (attr comes from the param).
	op = setAttrOp("param-op", "~ update (grow-only)", "", locator, value)
	if findRule(lintOp(op), RuleProseAttr) {
		t.Error("non-bare paren (prose) → not prose-dependent")
	}

	// Nested (target.path) and map-merge (target.block) never reach attrName's prose
	// path, so they are not prose-attr findings.
	nested := setAttrOp("nested-op", "~ update (some_attr)", "", locator, value)
	nested.Target.Path = []string{"metadata_options"}
	if findRule(lintOp(nested), RuleProseAttr) {
		t.Error("nested set_attribute must not be prose-attr flagged")
	}
	mapMerge := setAttrOp("map-op", "~ update (tags)", "", locator, Param{Name: "tags", Source: "user_input", Type: "map"})
	mapMerge.Target.Block = "tags"
	if findRule(lintOp(mapMerge), RuleProseAttr) {
		t.Error("map-merge set_attribute must not be prose-attr flagged")
	}
}

func TestLintArity(t *testing.T) {
	// no-value-provider: set_attribute with only an inventory locator.
	op := setAttrOp("no-val", "~ update (x)", "x", Param{Name: "target", Source: "inventory"})
	if !findRule(lintOp(op), RuleNoValueProvider) {
		t.Error("expected RuleNoValueProvider when no value param exists")
	}

	// value present → no no-value finding.
	op = setAttrOp("has-val", "~ update (x)", "x",
		Param{Name: "target", Source: "inventory"}, Param{Name: "new_v", Source: "user_input"})
	if findRule(lintOp(op), RuleNoValueProvider) {
		t.Error("value param present → must not flag no-value-provider")
	}

	// foreach-arity: append_foreach_entry needs two non-inventory params.
	fe := Op{ID: "fe", Service: "svc", CodemodOp: "append_foreach_entry",
		Params: []Param{{Name: "target", Source: "inventory"}, {Name: "only_one", Source: "user_input"}}}
	fe.Target.ResourceType = "aws_x"
	if !findRule(lintOp(fe), RuleForeachArity) {
		t.Error("expected RuleForeachArity with only one non-inventory param")
	}

	// target-arity: two inventory non-reference locators.
	two := setAttrOp("two-loc", "~ update (x)", "x",
		Param{Name: "a", Source: "inventory"}, Param{Name: "b", Source: "inventory"},
		Param{Name: "new_v", Source: "user_input"})
	if !findRule(lintOp(two), RuleTargetArity) {
		t.Error("expected RuleTargetArity with two inventory locators")
	}

	// exactly one locator → no target-arity finding.
	one := setAttrOp("one-loc", "~ update (x)", "x",
		Param{Name: "a", Source: "inventory"}, Param{Name: "new_v", Source: "user_input"})
	if findRule(lintOp(one), RuleTargetArity) {
		t.Error("exactly one locator → must not flag target-arity")
	}

	// instantiate_module never locates a target, so it is exempt from target-arity.
	inst := Op{ID: "inst", Service: "svc", CodemodOp: "instantiate_module"}
	inst.Target.ResourceType = "aws_x"
	if findRule(lintOp(inst), RuleTargetArity) {
		t.Error("instantiate_module must be exempt from target-arity")
	}
}

func TestLoadDirStrictDecode(t *testing.T) {
	dir := t.TempDir()
	// A manifest with a TYPO'd op field (forceReplace vs forcesReplace) must be an
	// error, not a silent drop to false (0028 #2).
	bad := `{"service":"x","scope":"estate","resourceTypes":["aws_x"],"summary":"s",
	 "operations":[{"id":"x-1","service":"x","codemodOp":"set_attribute","forceReplace":true}]}`
	if err := os.WriteFile(filepath.Join(dir, "bad.json"), []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadDir(dir)
	if err == nil {
		t.Fatal("expected LoadDir to reject an unknown/typo'd field")
	}
	if !strings.Contains(err.Error(), "forceReplace") && !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("error should name the offending field, got: %v", err)
	}

	// A manifest carrying every legitimate executor + SPA field (including the new
	// target.attr and the UI passthrough fields) must load clean.
	good := `{"service":"x","scope":"estate","resourceTypes":["aws_x"],"summary":"s",
	 "operations":[{"id":"x-1","service":"x","macd":"Change","codemodOp":"set_attribute",
	   "title":"t","description":"d","reversible":true,"downtime":"none","autoEligible":false,
	   "exposure":"l1_self_service","forcesReplace":false,"terraformCapability":"~ update (x)",
	   "group":"scale-performance","pinned":1,"keywords":["k"],
	   "target":{"resourceType":"aws_x","attr":"x"},
	   "riskFloor":"LOW",
	   "params":[{"name":"target","label":"L","type":"string","source":"inventory","required":true,
	     "help":"h","default":null,"sensitive":false,"group":"g","tier":"primary","uiWidget":"w",
	     "bounds":{"pattern":".*","semantic":"prose"}}]}]}`
	if err := os.WriteFile(filepath.Join(dir, "bad.json"), []byte(good), 0o644); err != nil {
		t.Fatal(err)
	}
	ops, err := LoadDir(dir)
	if err != nil {
		t.Fatalf("valid full-field manifest failed strict decode: %v", err)
	}
	if got := ops["x-1"].Target.Attr; got != "x" {
		t.Fatalf("target.attr = %q, want x", got)
	}
}
