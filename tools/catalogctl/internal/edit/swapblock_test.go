package edit

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// wafActionOp mirrors the golden manifest's waf-set-rule-action shape: target.path
// addresses the PARENT (rule.action) via a role:"selector" rule_name param, and the
// desired choice comes from a role:"discriminator" action param whose Segments
// co-domain IS the closed choice set (allow/block/count/captcha/challenge).
func wafActionOp() manifests.Op {
	op := manifests.Op{ID: "waf-set-rule-action", CodemodOp: "swap_child_block"}
	op.Target.ResourceType = "aws_wafv2_web_acl"
	op.Target.Path = []string{"rule", "action"}
	op.Params = []manifests.Param{
		{Name: "web_acl", Source: "inventory", Required: true},
		{Name: "rule_name", Source: "user_input", Required: true, Role: "selector", MatchAttr: "name"},
		{Name: "action", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds: &manifests.Bounds{Allowlist: []any{"ALLOW", "BLOCK", "COUNT", "CAPTCHA", "CHALLENGE"}},
			Segments: map[string]string{
				"ALLOW": "allow", "BLOCK": "block", "COUNT": "count",
				"CAPTCHA": "captcha", "CHALLENGE": "challenge",
			}},
	}
	return op
}

const oneActionRule = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {}
    }
  }
}
`

func TestSwapChildBlockSwapsDifferentEmptyChoice(t *testing.T) {
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "BLOCK"}}
	out, code, reason, err := swapChildBlock(op, req, locFor(oneActionRule))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	// A freshly AppendNewBlock'd empty block is multi-line (the block token
	// skeleton always carries an OBrace+Newline — see appendblock.go's
	// EmptyBlocks/ensureChildChain, which produces the identical shape), not the
	// compact `block {}` a hand-authored or already-existing empty block keeps.
	want := `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      block {
      }
    }
  }
}
`
	if string(out) != want {
		t.Fatalf("swap output =\n%s\nwant\n%s", out, want)
	}
}

// Idempotence (A11): the requested choice is already present and empty → the
// EXACT original bytes come back (no HCL round-trip), never a refusal.
func TestSwapChildBlockNoopWhenAlreadyDesired(t *testing.T) {
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "COUNT"}}
	loc := locFor(oneActionRule)
	out, code, reason, err := swapChildBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if string(out) != string(origBlock(loc)) {
		t.Fatalf("no-op output does not equal the original bytes:\n%s", out)
	}
}

// A non-empty existing choice child (carries a sub-block) refuses CHOICE_NOT_EMPTY
// rather than silently discard it — even though the request asks for a DIFFERENT
// choice than the one present.
func TestSwapChildBlockRefusesNonEmptyChoice(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {
        custom_request_handling {
          insert_header {
            name  = "x-waf-mode"
            value = "count"
          }
        }
      }
    }
  }
}
`
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "BLOCK"}}
	out, code, _, err := swapChildBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "CHOICE_NOT_EMPTY" {
		t.Fatalf("code = %q, want CHOICE_NOT_EMPTY", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// A non-empty existing choice child that ALREADY equals the requested choice also
// refuses CHOICE_NOT_EMPTY (spec §3.3 step 4 requires BOTH want-type AND empty for
// the no-op fast path) — never silently claim success over unverified content.
func TestSwapChildBlockRefusesNonEmptyEvenWhenAlreadyDesired(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {
        custom_request_handling {
          insert_header {
            name  = "x-waf-mode"
            value = "count"
          }
        }
      }
    }
  }
}
`
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "COUNT"}}
	_, code, _, err := swapChildBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "CHOICE_NOT_EMPTY" {
		t.Fatalf("code = %q, want CHOICE_NOT_EMPTY", code)
	}
}

// Zero choice-set children present under the parent → CHOICE_AMBIGUOUS (malformed
// config; never invent a choice from nothing).
func TestSwapChildBlockRefusesZeroChoice(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
    }
  }
}
`
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "BLOCK"}}
	out, code, _, err := swapChildBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "CHOICE_AMBIGUOUS" {
		t.Fatalf("code = %q, want CHOICE_AMBIGUOUS", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// More than one choice-set child present → CHOICE_AMBIGUOUS (never guess which
// one the request meant).
func TestSwapChildBlockRefusesMultipleChoice(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {}
      block {}
    }
  }
}
`
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "ALLOW"}}
	_, code, _, err := swapChildBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "CHOICE_AMBIGUOUS" {
		t.Fatalf("code = %q, want CHOICE_AMBIGUOUS", code)
	}
}

// A block outside the declared choice set under the parent means the manifest
// target is mis-addressed — refuse CHOICE_AMBIGUOUS rather than ignore it.
func TestSwapChildBlockRefusesForeignSibling(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {}
      bogus_marker {}
    }
  }
}
`
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "BLOCK"}}
	_, code, _, err := swapChildBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "CHOICE_AMBIGUOUS" {
		t.Fatalf("code = %q, want CHOICE_AMBIGUOUS", code)
	}
}

// An unmapped request value propagates the M0 code unchanged (0013b M2 reuses
// ResolveDiscriminator, not a bespoke check).
func TestSwapChildBlockUnresolvedSegmentPropagatesM0Code(t *testing.T) {
	op := wafActionOp()
	op.Params[2].Segments = map[string]string{"ALLOW": "allow"} // BLOCK dropped
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": "BLOCK"}}
	_, code, _, err := swapChildBlock(op, req, locFor(oneActionRule))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != manifests.RefuseUnresolvedDynamicSegment {
		t.Fatalf("code = %q, want %q", code, manifests.RefuseUnresolvedDynamicSegment)
	}
}

// PATH_NOT_FOUND / SELECTOR_AMBIGUOUS propagate unchanged from descendPath — the
// parent-addressing half of this verb is exactly the U1/M1 machinery.
func TestSwapChildBlockPropagatesDescendRefusals(t *testing.T) {
	op := wafActionOp()
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "nope", "action": "BLOCK"}}
	_, code, _, err := swapChildBlock(op, req, locFor(oneActionRule))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "SELECTOR_AMBIGUOUS" {
		t.Fatalf("code = %q, want SELECTOR_AMBIGUOUS", code)
	}
}

func TestDiscriminatorParam(t *testing.T) {
	op := wafActionOp()
	dp := discriminatorParam(op)
	if dp == nil || dp.Name != "action" {
		t.Fatalf("discriminatorParam = %v, want the %q param", dp, "action")
	}
	noDisc := manifests.Op{Params: []manifests.Param{{Name: "x", Role: "selector"}}}
	if discriminatorParam(noDisc) != nil {
		t.Fatalf("discriminatorParam on an op with no discriminator should be nil")
	}
}
