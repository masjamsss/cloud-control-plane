package driftpropose

import (
	"os"
	"path/filepath"
	"testing"
)

// copyCheckoutFixture copies testdata/driftpropose/checkout into a fresh t.TempDir()
// (outside this repo's own .git working tree) and returns its path. Two reasons:
//  1. defense in depth — GenerateAdopt/Generate never write back to the checkout
//     they read, but a test fixture is not the place to find that out the hard way.
//  2. determinism — Generate's baseCommit shells `git -C <repo> rev-parse HEAD`
//     (generate.go's gitHead), which would otherwise resolve UPWARD to this very
//     repo's own ever-changing HEAD (testdata/driftpropose/checkout sits inside this
//     git working tree). A plain t.TempDir() copy carries no .git of its own, so
//     gitHead fails closed to "" deterministically — exactly what the committed
//     golden fixture pins.
func copyCheckoutFixture(t *testing.T) string {
	t.Helper()
	src := "../../testdata/driftpropose/checkout"
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if rel == "." {
				return nil
			}
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatalf("copy checkout fixture: %v", err)
	}
	return dst
}

// copyCheckoutFixtureWithoutWatchlist is copyCheckoutFixture's sibling for F4's
// fail-closed test: everything the same, except
// scripts/drift/security-watchlist.json is never copied — so LoadWatchlist
// fails exactly like a real checkout that has never carried the file.
func copyCheckoutFixtureWithoutWatchlist(t *testing.T) string {
	t.Helper()
	dst := copyCheckoutFixture(t)
	wl := filepath.Join(dst, "scripts", "drift", "security-watchlist.json")
	if err := os.Remove(wl); err != nil {
		t.Fatalf("remove fixture watchlist file: %v", err)
	}
	return dst
}

// loadCombinedEnvelope loads every named envelope fixture under
// testdata/driftpropose/envelopes/ and merges their verdicts into one synthetic
// envelope — the six spec-named fixtures (benign tags, watchlisted SG, forceNew,
// sensitive-masked, unknown-class, oob-deletion), combined, exercise every bucket
// (adopt, revert, ungenerable) in one Generate() pass.
func loadCombinedEnvelope(t *testing.T) *Envelope {
	t.Helper()
	names := []string{"benign-tags", "watchlisted-sg", "forcenew", "sensitive-masked", "unknown-class", "oob-deletion"}
	var verdicts []Verdict
	for _, name := range names {
		env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/" + name + ".json")
		if err != nil {
			t.Fatalf("load envelope fixture %s: %v", name, err)
		}
		verdicts = append(verdicts, env.Report.Verdicts...)
	}
	return &Envelope{
		Schema:       EnvelopeSchema,
		ProjectID:    "sample",
		Environment:  "prod",
		CapturedAt:   "2026-07-20T03:17:04Z",
		RunID:        "16234567890",
		Commit:       "1370355aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CadenceHours: 6,
		PlanExitCode: 2,
		Report:       Report{Verdicts: verdicts},
	}
}
