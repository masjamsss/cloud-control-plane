package edit

import (
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"
)

// parentBlock parses src (a single top-level block) into its editable hclwrite form.
func parentBlock(t *testing.T, src string) *hclwrite.Block {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("parse: %s", diags.Error())
	}
	return f.Body().Blocks()[0]
}

const twoRules = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"
  }

  rule {
    name = "r2"
  }
}
`

// selectChild must resolve exactly one keyed sibling, and fail closed on 0 or >1
// matches, on a repeated block with no selector, and on an absent block type.
func TestSelectChildSelectorSemantics(t *testing.T) {
	cases := []struct {
		name      string
		blockType string
		sel       *selector
		wantCode  string
	}{
		{"unique key", "rule", &selector{matchAttr: "name", value: "r1"}, ""},
		{"zero match", "rule", &selector{matchAttr: "name", value: "nope"}, "SELECTOR_AMBIGUOUS"},
		{"repeated no selector", "rule", nil, "SELECTOR_AMBIGUOUS"},
		{"absent block type", "lifecycle", &selector{matchAttr: "name", value: "r1"}, "PATH_NOT_FOUND"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent := parentBlock(t, twoRules)
			selUsed := false
			got, code, _ := selectChild(parent, tc.blockType, tc.sel, &selUsed, false, "")
			if code != tc.wantCode {
				t.Fatalf("code = %q, want %q", code, tc.wantCode)
			}
			if tc.wantCode == "" {
				if got == nil {
					t.Fatalf("expected a block, got nil")
				}
				if v, _ := attrLiteral(got, "name"); v != tc.sel.value {
					t.Fatalf("selected name = %q, want %q", v, tc.sel.value)
				}
				if !selUsed {
					t.Fatalf("selUsed not marked after a keyed match")
				}
			}
		})
	}
}

// dupKey pins the ambiguity refusal: two siblings sharing the selector key.
func TestSelectChildDuplicateKey(t *testing.T) {
	const dup = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "same"
  }

  rule {
    name = "same"
  }
}
`
	parent := parentBlock(t, dup)
	selUsed := false
	_, code, _ := selectChild(parent, "rule", &selector{matchAttr: "name", value: "same"}, &selUsed, false, "")
	if code != "SELECTOR_AMBIGUOUS" {
		t.Fatalf("code = %q, want SELECTOR_AMBIGUOUS", code)
	}
}

// descendPath consumes the selector once (at the keyed level) and then descends
// single intermediate blocks without re-firing it.
func TestDescendPathSelectorConsumedOnce(t *testing.T) {
	const src = `resource "aws_backup_plan" "x" {
  rule {
    rule_name = "primary"

    lifecycle {
      delete_after = 30
    }
  }

  rule {
    rule_name = "secondary"

    lifecycle {
      delete_after = 90
    }
  }
}
`
	top := parentBlock(t, src)
	target, code, reason := descendPath(top, []string{"rule", "lifecycle"}, &selector{matchAttr: "rule_name", value: "primary"}, false, nil)
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if v, _ := attrLiteral(target, "delete_after"); v != "30" {
		t.Fatalf("descended into the wrong lifecycle (delete_after=%q, want 30)", v)
	}
}
