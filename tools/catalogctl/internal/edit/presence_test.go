package edit

import "testing"

// presence_test.go pins 0013b M3: target.matchPresence disambiguates repeated
// sibling blocks by WHICH attribute each carries (efs lifecycle_policy: one
// sibling holds transition_to_ia, another transition_to_archive) — there is no
// request value to key a role:"selector" on at all, so this is a wholly separate
// mechanism from U1's value-selector, composed at the descendPath/selectChild seam.

const twoLifecyclePolicies = `resource "aws_efs_file_system" "x" {
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  lifecycle_policy {
    transition_to_archive = "AFTER_90_DAYS"
  }
}
`

// Exactly one sibling carries the presence attr → it is selected, the other left
// untouched (selectByPresence never mutates a non-selected sibling).
func TestSelectByPresencePicksTheCarrier(t *testing.T) {
	parent := parentBlock(t, twoLifecyclePolicies)
	selUsed := false
	got, code, reason := selectChild(parent, "lifecycle_policy", nil, &selUsed, false, "transition_to_archive")
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if v, ok := attrLiteral(got, "transition_to_archive"); !ok || v != "AFTER_90_DAYS" {
		t.Fatalf("selected block transition_to_archive = %q, want AFTER_90_DAYS (ok=%v)", v, ok)
	}
	if _, ok := attrLiteral(got, "transition_to_ia"); ok {
		t.Fatalf("selected the wrong sibling: it carries transition_to_ia")
	}
}

func TestSelectByPresenceOtherCarrierUnaffected(t *testing.T) {
	parent := parentBlock(t, twoLifecyclePolicies)
	selUsed := false
	got, code, _ := selectChild(parent, "lifecycle_policy", nil, &selUsed, false, "transition_to_ia")
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if v, ok := attrLiteral(got, "transition_to_ia"); !ok || v != "AFTER_30_DAYS" {
		t.Fatalf("selected block transition_to_ia = %q, want AFTER_30_DAYS (ok=%v)", v, ok)
	}
}

// Zero siblings carry the presence attr and ensure is NOT set → PATH_NOT_FOUND,
// same fail-closed behavior as an absent block type (pre-0013b unchanged).
func TestSelectByPresenceZeroCarriersNoEnsureRefuses(t *testing.T) {
	const oneIA = `resource "aws_efs_file_system" "x" {
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
}
`
	parent := parentBlock(t, oneIA)
	selUsed := false
	_, code, _ := selectChild(parent, "lifecycle_policy", nil, &selUsed, false, "transition_to_archive")
	if code != "PATH_NOT_FOUND" {
		t.Fatalf("code = %q, want PATH_NOT_FOUND", code)
	}
}

// Zero siblings carry the presence attr but ensure IS set → a NEW sibling is
// appended among the existing repeated blocks (0013b M3's one ensure-creates-a-
// sibling-not-a-singleton case) and descended into.
func TestSelectByPresenceZeroCarriersWithEnsureCreatesSibling(t *testing.T) {
	const oneIA = `resource "aws_efs_file_system" "x" {
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
}
`
	parent := parentBlock(t, oneIA)
	selUsed := false
	got, code, reason := selectChild(parent, "lifecycle_policy", nil, &selUsed, true, "transition_to_archive")
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if got == nil || got.Type() != "lifecycle_policy" {
		t.Fatalf("created block = %v, want a lifecycle_policy", got)
	}
	if got.Body().GetAttribute("transition_to_archive") != nil {
		t.Fatalf("the created sibling should be EMPTY (the caller writes the attr next) — it already carries transition_to_archive")
	}
	// The pre-existing IA sibling must survive untouched, and there are now 2.
	all := childrenOfType(parent, "lifecycle_policy")
	if len(all) != 2 {
		t.Fatalf("lifecycle_policy count after ensure = %d, want 2 (the original IA sibling + the new one)", len(all))
	}
	if v, ok := attrLiteral(all[0], "transition_to_ia"); !ok || v != "AFTER_30_DAYS" {
		t.Fatalf("original IA sibling mutated: transition_to_ia = %q (ok=%v)", v, ok)
	}
}

// More than one sibling carries the SAME presence attr → malformed EFS config,
// refuse SELECTOR_AMBIGUOUS (never guess which one the request meant) — the same
// code token U1's value-selector uses for "can't pick one sibling".
func TestSelectByPresenceMultipleCarriersRefusesAmbiguous(t *testing.T) {
	const dupIA = `resource "aws_efs_file_system" "x" {
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  lifecycle_policy {
    transition_to_ia = "AFTER_60_DAYS"
  }
}
`
	parent := parentBlock(t, dupIA)
	selUsed := false
	_, code, _ := selectChild(parent, "lifecycle_policy", nil, &selUsed, false, "transition_to_ia")
	if code != "SELECTOR_AMBIGUOUS" {
		t.Fatalf("code = %q, want SELECTOR_AMBIGUOUS", code)
	}
}

// A pending value-selector AND matchPresence applicable at the SAME level is an
// unspecified combination (spec: "though no current op needs both") — refuse
// rather than silently prefer one mechanism.
func TestSelectChildRefusesSelectorPresenceConflictAtSameLevel(t *testing.T) {
	const src = `resource "aws_efs_file_system" "x" {
  lifecycle_policy {
    name              = "a"
    transition_to_ia  = "AFTER_30_DAYS"
  }

  lifecycle_policy {
    name                   = "b"
    transition_to_archive  = "AFTER_90_DAYS"
  }
}
`
	parent := parentBlock(t, src)
	selUsed := false
	sel := &selector{matchAttr: "name", value: "a"}
	_, code, reason := selectChild(parent, "lifecycle_policy", sel, &selUsed, false, "transition_to_ia")
	if code != "SELECTOR_PRESENCE_CONFLICT" {
		t.Fatalf("code = %q (%s), want SELECTOR_PRESENCE_CONFLICT", code, reason)
	}
}

// A value-selector pending for a LATER path segment is unaffected by matchPresence
// applying to an EARLIER segment — the two mechanisms compose across orthogonal
// levels (spec §3.4), which is the case every catalogued M3 op actually needs.
func TestDescendPathComposesPresenceThenSelectorAcrossLevels(t *testing.T) {
	const src = `resource "aws_backup_plan" "x" {
  rule {
    rule_name = "primary"

    lifecycle {
      transition_to_ia = "AFTER_30_DAYS"
    }

    lifecycle {
      transition_to_archive = "AFTER_90_DAYS"
    }
  }

  rule {
    rule_name = "secondary"

    lifecycle {
      transition_to_ia = "AFTER_7_DAYS"
    }
  }
}
`
	top := parentBlock(t, src)
	matchPresence := map[string]string{"lifecycle": "transition_to_archive"}
	target, code, reason := descendPath(top, []string{"rule", "lifecycle"}, &selector{matchAttr: "rule_name", value: "primary"}, false, matchPresence)
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if v, ok := attrLiteral(target, "transition_to_archive"); !ok || v != "AFTER_90_DAYS" {
		t.Fatalf("descended into the wrong lifecycle (transition_to_archive=%q, ok=%v)", v, ok)
	}
}

// A segment absent from matchPresence keeps the pre-0013b descent semantics
// exactly (a nil map must never panic on the map[seg] lookup).
func TestDescendPathNilMatchPresenceUnaffected(t *testing.T) {
	top := parentBlock(t, "resource \"aws_sagemaker_domain\" \"x\" {\n  default_user_settings {\n  }\n}\n")
	target, code, reason := descendPath(top, []string{"default_user_settings"}, nil, false, nil)
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if target.Type() != "default_user_settings" {
		t.Fatalf("descended to %q, want default_user_settings", target.Type())
	}
}
