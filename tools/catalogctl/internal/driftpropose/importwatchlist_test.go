package driftpropose

import "testing"

// TestScreenCreationSecurityHit pins the ordinary matching contract against
// the fixture checkout's watchlist ("aws_iam_role", "aws_iam_access_key").
func TestScreenCreationSecurityHit(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	if reason, hit := w.ScreenCreationSecurity("aws_iam_role"); !hit || reason == "" {
		t.Fatalf("ScreenCreationSecurity(aws_iam_role) = (%q, %v), want a hit", reason, hit)
	}
	if _, hit := w.ScreenCreationSecurity("aws_instance"); hit {
		t.Fatal("ScreenCreationSecurity(aws_instance) hit — the fixture deliberately does not list it")
	}
}

// TestScreenCreationSecurityKeyAbsentFailsClosed pins the pointer-nil
// distinction directly (import{gen,watchlist}_test.go already prove this
// through the full Generate/drift-edit pipeline; this is the unit-level
// proof of the underlying parse behavior): a watchlist JSON that never
// mentions creation_security_types decodes CreationSecurityTypes as a nil
// pointer, and every tfType hits (fail-closed).
func TestScreenCreationSecurityKeyAbsentFailsClosed(t *testing.T) {
	w := Watchlist{}
	if w.CreationSecurityTypes != nil {
		t.Fatal("zero-value Watchlist.CreationSecurityTypes is not nil")
	}
	reason, hit := w.ScreenCreationSecurity("aws_instance")
	if !hit {
		t.Fatal("ScreenCreationSecurity with the key absent did not hit — must fail closed for EVERY tfType")
	}
	if !containsAll(reason, "creation_security_types", "fail-closed") {
		t.Fatalf("reason = %q, want it to name the absent key and fail-closed", reason)
	}
}

// TestScreenCreationSecurityKeyPresentEmptyIsNotFailClosed pins the OTHER
// half of the same distinction (spec §5.3: "Missing/unparseable watchlist
// OR key absent" — present-and-empty is neither): a curated, deliberately
// empty list screens clean for every tfType, never treated as "absent."
func TestScreenCreationSecurityKeyPresentEmptyIsNotFailClosed(t *testing.T) {
	empty := []string{}
	w := Watchlist{CreationSecurityTypes: &empty}
	if reason, hit := w.ScreenCreationSecurity("aws_iam_role"); hit {
		t.Fatalf("ScreenCreationSecurity with an empty-but-present list hit (%q) — must not be treated as fail-closed", reason)
	}
}
