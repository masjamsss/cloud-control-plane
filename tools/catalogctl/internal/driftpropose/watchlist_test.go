package driftpropose

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoadWatchlistFixture pins the fixture checkout's watchlist file parses
// and hits exactly the shapes the other tests in this file rely on.
func TestLoadWatchlistFixture(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	if _, ok := w.ResourceTypes["aws_security_group"]; !ok {
		t.Fatal("fixture watchlist carries no aws_security_group entry")
	}
}

// TestLoadWatchlistMissingFile pins the fail-closed contract: a checkout with
// no scripts/drift/security-watchlist.json at all is an error, never a silent
// empty watchlist.
func TestLoadWatchlistMissingFile(t *testing.T) {
	if _, err := LoadWatchlist(t.TempDir()); err == nil {
		t.Fatal("LoadWatchlist succeeded against a checkout with no watchlist file")
	}
}

// TestLoadWatchlistUnparseable pins the same fail-closed contract for a
// present-but-broken file.
func TestLoadWatchlistUnparseable(t *testing.T) {
	dir := t.TempDir()
	wlDir := filepath.Join(dir, "scripts", "drift")
	if err := os.MkdirAll(wlDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wlDir, "security-watchlist.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadWatchlist(dir); err == nil {
		t.Fatal("LoadWatchlist succeeded against unparseable JSON")
	}
}

// TestWatchlistHitWildcardResourceType pins the resource_types[type].attributes
// == ["*"] short-circuit (mirrors classify.py's `pat == "*"`): any changed path
// on a wildcarded type hits, regardless of the specific attribute.
func TestWatchlistHitWildcardResourceType(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	why, hit := w.Hit("aws_security_group", []any{"ingress", 0, "cidr_blocks"})
	if !hit {
		t.Fatal("wildcarded aws_security_group did not hit")
	}
	if why == "" {
		t.Fatal("hit carries no why")
	}
}

// TestWatchlistHitAttributePattern pins the global attribute_patterns fallback,
// tried when the resource type is unlisted (or listed but didn't match).
func TestWatchlistHitAttributePattern(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	if _, hit := w.Hit("aws_db_instance", []any{"publicly_accessible"}); !hit {
		t.Fatal("global attribute_patterns entry 'publicly_accessible' did not hit on an unlisted resource type")
	}
}

// TestWatchlistMiss pins the negative: an ordinary tag path on an unlisted type
// misses entirely — the fixture watchlist deliberately does not flag tags (real
// watchlist doctrine: "Tags are deliberately NOT watchlisted").
func TestWatchlistMiss(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	if _, hit := w.Hit("aws_instance", []any{"tags", "Owner"}); hit {
		t.Fatal("tags.Owner on aws_instance hit the watchlist — every existing adopt fixture depends on this NOT hitting")
	}
	if _, hit := w.Hit("aws_instance", []any{"root_block_device", 0, "volume_size"}); hit {
		t.Fatal("root_block_device[0].volume_size on aws_instance hit the watchlist — W1's own capability-unlock example depends on this NOT hitting")
	}
}

// TestFourthScreenForgedEnvelope is the audit's "g1-forged" reproduction (spec
// addendum A1): a forged envelope with securityHits stripped and class
// relabeled benign_inplace, on a security_posture-watchlisted path
// (ingress[0].cidr_blocks) that IS shape-expressible post-W1 — so
// ClassifyByFields alone would call it BucketAdopt. Generate must still land it
// ungenerable via the checkout's own watchlist (fourth screen), never emit it as
// a proposal.
func TestFourthScreenForgedEnvelope(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/forged-watchlist.json")
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	// Sanity: the field-level partitioner alone (no checkout) is fooled by the
	// forgery — this is exactly why the fourth screen exists.
	if bucket, reason := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("fixture precondition failed: field-level bucket = %q (reason=%q), want %q (the forgery should fool the field-only partitioner)", bucket, reason, BucketAdopt)
	}

	doc, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(doc.Proposals) != 0 {
		t.Fatalf("forged envelope produced %d proposals, want 0: %+v", len(doc.Proposals), doc.Proposals)
	}
	if len(doc.Ungenerable) != 1 {
		t.Fatalf("ungenerable = %d, want 1: %+v", len(doc.Ungenerable), doc.Ungenerable)
	}
	reason := doc.Ungenerable[0].Reason
	if !containsAll(reason, "ingress[0].cidr_blocks", "checkout security watchlist", "fourth screen") {
		t.Fatalf("reason = %q, want it to name the path, the watchlist, and the fourth screen", reason)
	}
}

// TestFourthScreenUnreadableWatchlistRefusesWholeAdoptBucket pins the
// fail-closed doctrine: a checkout with no watchlist file makes the ENTIRE
// adopt bucket ungenerable — never guessed verdict-by-verdict — while a
// revert-eligible verdict in the SAME envelope is entirely unaffected (the
// fourth screen only ever narrows adopt, never revert).
func TestFourthScreenUnreadableWatchlistRefusesWholeAdoptBucket(t *testing.T) {
	checkout := copyCheckoutFixtureWithoutWatchlist(t)
	env := loadCombinedEnvelope(t)

	doc, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(doc.Proposals) != 1 || doc.Proposals[0].Flavor != "revert" {
		t.Fatalf("proposals = %+v, want exactly the 1 revert proposal (adopt refused, revert unaffected)", doc.Proposals)
	}
	found := false
	for _, u := range doc.Ungenerable {
		if u.Address == "aws_instance.sample01" {
			found = true
			if !containsAll(u.Reason, "security watchlist unreadable") {
				t.Fatalf("reason = %q, want it to name the unreadable watchlist", u.Reason)
			}
		}
	}
	if !found {
		t.Fatal("the would-be-adopt verdict (aws_instance.sample01) is missing from ungenerable")
	}
}
