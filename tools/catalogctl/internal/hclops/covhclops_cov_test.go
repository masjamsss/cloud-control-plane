package hclops

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// covhclopsWriteTF writes name under dir and fails the test on error.
func covhclopsWriteTF(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// covhclopsLines joins ls with "\n" and appends a trailing newline (the shape
// hclwrite always emits).
func covhclopsLines(ls ...string) string {
	return strings.Join(ls, "\n") + "\n"
}

// TestCovhclopsUnifiedDiffNoNewlineMarkers pins the git/difflib
// "\ No newline at end of file" convention on all three line kinds (context,
// deletion, insertion) — the marker is what makes a diff artifact replayable
// with `git apply`, so an unmarked missing-EOF-newline is a real defect.
func TestCovhclopsUnifiedDiffNoNewlineMarkers(t *testing.T) {
	const marker = "\\ No newline at end of file\n"
	cases := []struct {
		name string
		a, b string
		want string
	}{
		{
			// Trailing CONTEXT line is the last line of a, and a has no EOF newline.
			name: "context line at eof without newline",
			a:    "one\ntwo\nlast",
			b:    "ONE\ntwo\nlast",
			want: "--- a/f.tf\n+++ b/f.tf\n" +
				"@@ -1,3 +1,3 @@\n" +
				"-one\n+ONE\n two\n last\n" + marker,
		},
		{
			// DELETED last line of a, a has no EOF newline. The `+1` side also pins
			// the ",1"-omitted range convention.
			name: "deleted line at eof without newline",
			a:    "x\nold",
			b:    "x\n",
			want: "--- a/f.tf\n+++ b/f.tf\n" +
				"@@ -1,2 +1 @@\n" +
				" x\n-old\n" + marker,
		},
		{
			// INSERTED last line of b, b has no EOF newline.
			name: "inserted line at eof without newline",
			a:    "x\n",
			b:    "x\nnew",
			want: "--- a/f.tf\n+++ b/f.tf\n" +
				"@@ -1 +1,2 @@\n" +
				" x\n+new\n" + marker,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := string(UnifiedDiff("f.tf", "f.tf", []byte(c.a), []byte(c.b)))
			if got != c.want {
				t.Fatalf("UnifiedDiff mismatch\n--- want ---\n%s\n--- got ---\n%s", c.want, got)
			}
		})
	}
}

// TestCovhclopsUnifiedDiffSingleLineRangeOmitsCount pins the `,1`-omitted hunk
// header (git/difflib convention): a one-line file whose only line changed
// renders `@@ -1 +1 @@`, not `@@ -1,1 +1,1 @@`.
func TestCovhclopsUnifiedDiffSingleLineRangeOmitsCount(t *testing.T) {
	got := string(UnifiedDiff("one.tf", "one.tf", []byte("old\n"), []byte("new\n")))
	want := "--- a/one.tf\n+++ b/one.tf\n@@ -1 +1 @@\n-old\n+new\n"
	if got != want {
		t.Fatalf("UnifiedDiff mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

// TestCovhclopsUnifiedDiffSplitsDistantChangesIntoTwoHunks: two edits further
// apart than 2*context+1 lines must render as SEPARATE hunks, so the untouched
// middle of the file never appears in the evidence diff.
func TestCovhclopsUnifiedDiffSplitsDistantChangesIntoTwoHunks(t *testing.T) {
	before := covhclopsLines("l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11", "l12", "l13", "l14")
	after := covhclopsLines("l1", "L2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11", "L12", "l13", "l14")

	got := string(UnifiedDiff("m.tf", "m.tf", []byte(before), []byte(after)))
	if n := strings.Count(got, "@@ -"); n != 2 {
		t.Fatalf("want 2 hunks, got %d:\n%s", n, got)
	}
	for _, want := range []string{
		"@@ -1,5 +1,5 @@\n",
		"@@ -9,6 +9,6 @@\n",
		"-l2\n", "+L2\n", "-l12\n", "+L12\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("diff missing %q:\n%s", want, got)
		}
	}
	// The untouched middle (outside both context windows) is excluded — this is
	// what makes the two-hunk split observable rather than a formatting detail.
	for _, absent := range []string{" l7\n", " l8\n"} {
		if strings.Contains(got, absent) {
			t.Fatalf("diff should not carry untouched middle line %q:\n%s", absent, got)
		}
	}
	// Both hunks still keep exactly 3 lines of context on the inner side.
	if !strings.Contains(got, " l5\n") || !strings.Contains(got, " l9\n") {
		t.Fatalf("diff lost 3-line context around the changes:\n%s", got)
	}
}

// TestCovhclopsUnifiedDiffAdjacentChangesShareOneHunk is the counterpart: edits
// close enough for their context windows to touch coalesce into ONE hunk.
func TestCovhclopsUnifiedDiffAdjacentChangesShareOneHunk(t *testing.T) {
	before := covhclopsLines("l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8")
	after := covhclopsLines("l1", "L2", "l3", "l4", "l5", "L6", "l7", "l8")

	got := string(UnifiedDiff("m.tf", "m.tf", []byte(before), []byte(after)))
	if n := strings.Count(got, "@@ -"); n != 1 {
		t.Fatalf("want 1 coalesced hunk, got %d:\n%s", n, got)
	}
	for _, want := range []string{"-l2\n", "+L2\n", "-l6\n", "+L6\n", " l4\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("diff missing %q:\n%s", want, got)
		}
	}
}

// TestCovhclopsComputeEditsIdenticalLineLists: with nothing to diff, the
// prefix/suffix trim consumes both sides and the LCS core is asked for an empty
// range — the result must be a pure equal-run mapping i→i, never a spurious
// delete/insert pair.
func TestCovhclopsComputeEditsIdenticalLineLists(t *testing.T) {
	lines := []string{"resource \"x\" \"y\" {", "  a = 1", "}"}
	edits := computeEdits(lines, lines)
	if len(edits) != len(lines) {
		t.Fatalf("computeEdits returned %d edits, want %d", len(edits), len(lines))
	}
	for i, e := range edits {
		if e.tag != eqTag || e.ai != i || e.bi != i {
			t.Fatalf("edits[%d] = %+v, want {eqTag %d %d}", i, e, i, i)
		}
	}
}

// TestCovhclopsComputeEditsEmptyInputs: both sides empty is the degenerate LCS
// range and must yield no edits at all.
func TestCovhclopsComputeEditsEmptyInputs(t *testing.T) {
	if edits := computeEdits(nil, nil); len(edits) != 0 {
		t.Fatalf("computeEdits(nil, nil) = %+v, want no edits", edits)
	}
}

// TestCovhclopsGroupHunks pins the hunk grouper directly: no change tags means
// no hunks (and therefore an empty diff), and clamping never runs off either end
// of the edit script.
func TestCovhclopsGroupHunks(t *testing.T) {
	t.Run("all equal yields no hunks", func(t *testing.T) {
		edits := []edit{{eqTag, 0, 0}, {eqTag, 1, 1}, {eqTag, 2, 2}}
		if h := groupHunks(edits, diffContext); h != nil {
			t.Fatalf("groupHunks(all-equal) = %v, want nil", h)
		}
	})
	t.Run("clamps context to the edit script bounds", func(t *testing.T) {
		edits := []edit{{delTag, 0, -1}, {insTag, -1, 0}}
		h := groupHunks(edits, diffContext)
		want := [][2]int{{0, 2}}
		if len(h) != 1 || h[0] != want[0] {
			t.Fatalf("groupHunks = %v, want %v", h, want)
		}
	})
	t.Run("distant changes split, adjacent changes merge", func(t *testing.T) {
		eq := func(i int) edit { return edit{eqTag, i, i} }
		// change at 0, change at 20 (gap > 2*ctx+1) -> two hunks.
		edits := []edit{{delTag, 0, -1}}
		for i := 1; i < 20; i++ {
			edits = append(edits, eq(i))
		}
		edits = append(edits, edit{delTag, 20, -1})
		h := groupHunks(edits, diffContext)
		if len(h) != 2 {
			t.Fatalf("groupHunks = %v, want 2 hunks", h)
		}
		if h[0] != [2]int{0, 4} {
			t.Fatalf("first hunk = %v, want [0 4]", h[0])
		}
		if h[1] != [2]int{17, 21} {
			t.Fatalf("second hunk = %v, want [17 21]", h[1])
		}
	})
}

// TestCovhclopsSplitLines pins the line splitter's EOF-newline bookkeeping, the
// input to every "\ No newline at end of file" decision.
func TestCovhclopsSplitLines(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantLines []string
		wantNL    bool
	}{
		{"empty is treated as newline-terminated", "", nil, true},
		{"trailing newline", "a\nb\n", []string{"a", "b"}, true},
		{"no trailing newline", "a\nb", []string{"a", "b"}, false},
		{"lone newline is one empty line", "\n", []string{""}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lines, nl := splitLines([]byte(c.in))
			if nl != c.wantNL {
				t.Fatalf("eofNL = %v, want %v", nl, c.wantNL)
			}
			if len(lines) != len(c.wantLines) {
				t.Fatalf("lines = %q, want %q", lines, c.wantLines)
			}
			for i := range lines {
				if lines[i] != c.wantLines[i] {
					t.Fatalf("lines = %q, want %q", lines, c.wantLines)
				}
			}
		})
	}
}

// TestCovhclopsRngRangeRendering pins the hunk-range renderer: `,1` is omitted,
// every other count is spelled out — including the `-N,0` pure-insertion anchor.
func TestCovhclopsRngRangeRendering(t *testing.T) {
	cases := []struct {
		start, count int
		want         string
	}{
		{1, 1, "1"},
		{7, 1, "7"},
		{1, 0, "1,0"},
		{9, 6, "9,6"},
	}
	for _, c := range cases {
		if got := rng(c.start, c.count); got != c.want {
			t.Errorf("rng(%d, %d) = %q, want %q", c.start, c.count, got, c.want)
		}
	}
}

// TestCovhclopsLocateGlobPatternError: a malformed envDir is an internal error
// (exit 1), not a "not found" resolution error (exit 3) — the two exit codes mean
// different things to the caller and must not be conflated.
func TestCovhclopsLocateGlobPatternError(t *testing.T) {
	loc, err, code := Locate("/definitely-not-a-real-dir[", "aws_ebs_volume.demo")
	if code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if err == nil {
		t.Fatal("want a glob error, got nil")
	}
	if !errors.Is(err, filepath.ErrBadPattern) {
		t.Fatalf("err = %v, want ErrBadPattern", err)
	}
	if loc != nil {
		t.Fatalf("loc = %+v, want nil on error", loc)
	}
}

// TestCovhclopsLocateReadError: an unreadable *.tf match aborts with exit 1
// (internal error) rather than being silently skipped — silently skipping a file
// would let Locate report a UNIQUE match it never actually proved.
func TestCovhclopsLocateReadError(t *testing.T) {
	dir := t.TempDir()
	covhclopsWriteTF(t, dir, "a.tf", demoBlock)
	// A directory whose name ends in .tf: the glob matches it, ReadFile cannot.
	if err := os.Mkdir(filepath.Join(dir, "sub.tf"), 0o755); err != nil {
		t.Fatal(err)
	}
	loc, err, code := Locate(dir, "aws_ebs_volume.demo")
	if code != 1 {
		t.Fatalf("code = %d, want 1 (err=%v)", code, err)
	}
	if err == nil {
		t.Fatal("want a read error, got nil")
	}
	if loc != nil {
		t.Fatalf("loc = %+v, want nil on error", loc)
	}
}

// TestCovhclopsLocateParseError: unparseable HCL is exit 1 with the offending
// file named, never a partial result.
func TestCovhclopsLocateParseError(t *testing.T) {
	dir := t.TempDir()
	covhclopsWriteTF(t, dir, "broken.tf", "resource \"aws_ebs_volume\" \"demo\" {\n  size = \n}\n")
	loc, err, code := Locate(dir, "aws_ebs_volume.demo")
	if code != 1 || err == nil {
		t.Fatalf("code = %d err = %v, want 1 and an error", code, err)
	}
	if !strings.Contains(err.Error(), "parse") || !strings.Contains(err.Error(), "broken.tf") {
		t.Fatalf("err = %v, want it to name the parse failure and broken.tf", err)
	}
	if loc != nil {
		t.Fatalf("loc = %+v, want nil on error", loc)
	}
}

// TestCovhclopsLocateModuleAndUnaddressableBlocks: modules address as
// `module.<name>`; blocks with the wrong label arity (and non-resource/module
// types) have no address at all and must never be matched by a bare name.
func TestCovhclopsLocateModuleAndUnaddressableBlocks(t *testing.T) {
	dir := t.TempDir()
	covhclopsWriteTF(t, dir, "m.tf", covhclopsLines(
		`module "vpc" {`,
		`  source = "./mod"`,
		`}`,
		``,
		`terraform {`,
		`  required_version = ">= 1.0"`,
		`}`,
		``,
		`output "id" {`,
		`  value = 1`,
		`}`,
	))
	loc, err, code := Locate(dir, "module.vpc")
	if err != nil || code != 0 {
		t.Fatalf("Locate module.vpc err=%v code=%d", err, code)
	}
	got := string(loc.Bytes[loc.Start:loc.End])
	if !strings.HasPrefix(got, `module "vpc" {`) || !strings.HasSuffix(got, "}\n") {
		t.Fatalf("located slice is not a clean module block: %q", got)
	}
	for _, addr := range []string{"terraform", "output.id", "vpc"} {
		if _, err, code := Locate(dir, addr); code != 3 || err == nil {
			t.Fatalf("Locate(%q) code=%d err=%v, want 3 and an error", addr, code, err)
		}
	}
}

// TestCovhclopsLocateEndWithoutTrailingNewline: when the closing brace is the
// last byte of the file, End stops at the brace instead of running past the
// buffer — the slice must still be exactly the block.
func TestCovhclopsLocateEndWithoutTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	src := "resource \"aws_s3_bucket\" \"b\" {\n  bucket = \"x\"\n}"
	covhclopsWriteTF(t, dir, "s.tf", src)
	loc, err, code := Locate(dir, "aws_s3_bucket.b")
	if err != nil || code != 0 {
		t.Fatalf("Locate err=%v code=%d", err, code)
	}
	if loc.End != len(src) {
		t.Fatalf("End = %d, want %d (file length)", loc.End, len(src))
	}
	if got := string(loc.Bytes[loc.Start:loc.End]); got != src {
		t.Fatalf("located slice = %q, want %q", got, src)
	}
}

// TestCovhclopsSpliceBoundaries pins the range guard's rejections and the two
// degenerate-but-legal ranges (pure insertion, splice through EOF). Every
// accepted splice must leave the bytes outside [start,end) byte-identical —
// the "changed set ⊆ target" invariant.
func TestCovhclopsSpliceBoundaries(t *testing.T) {
	orig := []byte("AA\nBB\nCC\n")
	t.Run("rejected ranges", func(t *testing.T) {
		cases := []struct {
			name       string
			start, end int
		}{
			{"negative start", -1, 3},
			{"end past eof", 3, len(orig) + 1},
			{"start after end", 6, 3},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				out, err := Splice(orig, c.start, c.end, []byte("X\n"))
				if err == nil {
					t.Fatalf("Splice(%d,%d) = %q, want an error", c.start, c.end, out)
				}
				if !strings.Contains(err.Error(), "invalid") {
					t.Fatalf("err = %v, want the range-guard message", err)
				}
				if out != nil {
					t.Fatalf("out = %q, want nil on error", out)
				}
			})
		}
	})
	t.Run("accepted ranges", func(t *testing.T) {
		cases := []struct {
			name       string
			start, end int
			block      string
			want       string
		}{
			{"empty range inserts", 3, 3, "XX\n", "AA\nXX\nBB\nCC\n"},
			{"replace through eof", 6, len(orig), "ZZ\n", "AA\nBB\nZZ\n"},
			{"append at eof", len(orig), len(orig), "DD\n", "AA\nBB\nCC\nDD\n"},
			{"replace whole file", 0, len(orig), "ONLY\n", "ONLY\n"},
			{"delete a line", 3, 6, "", "AA\nCC\n"},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				out, err := Splice(orig, c.start, c.end, []byte(c.block))
				if err != nil {
					t.Fatalf("Splice: %v", err)
				}
				if string(out) != c.want {
					t.Fatalf("Splice = %q, want %q", out, c.want)
				}
				if string(orig) != "AA\nBB\nCC\n" {
					t.Fatalf("Splice mutated its input: %q", orig)
				}
			})
		}
	})
}

// TestCovhclopsFmtCanonicalEdgeCases: the FMT_DIRTY gate must accept an empty
// file and a comment-only file, and reject the common non-canonical shapes
// (misaligned `=`, tabs, missing final newline).
func TestCovhclopsFmtCanonicalEdgeCases(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"empty file", "", true},
		{"comment only", "# just a comment\n", true},
		{"canonical block", "resource \"x\" \"y\" {\n  a = 1\n}\n", true},
		// hclwrite aligns the `=` of consecutive attributes; single-spacing both
		// is what a hand edit produces and what the FMT_DIRTY gate must catch.
		{"unaligned equals", "resource \"x\" \"y\" {\n  a = 1\n  bb = 2\n}\n", false},
		{"aligned equals", "resource \"x\" \"y\" {\n  a  = 1\n  bb = 2\n}\n", true},
		{"tab indent", "resource \"x\" \"y\" {\n\ta = 1\n}\n", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FmtCanonical([]byte(c.in)); got != c.want {
				t.Fatalf("FmtCanonical(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

// TestCovhclopsRedactSameLineNestedBlockOpener is the security case for an RHS
// that opens a block on the SAME line (`secret_string = jsonencode({`): the
// opened scope must join the block stack, so every value nested inside a
// secret-bearing block is masked even though the opener is an assignment rather
// than a bare `block {` line.
func TestCovhclopsRedactSameLineNestedBlockOpener(t *testing.T) {
	src := covhclopsLines(
		`resource "aws_secretsmanager_secret_version" "app" {`,
		`  secret_id = "app/db"`,
		`  secret_string = jsonencode({`,
		`    username = "admin"`,
		`    host     = "db.internal"`,
		`  })`,
		`}`,
	)
	out := string(RedactWith([]byte(src), RedactOptions{}))
	for _, leak := range []string{`"admin"`, `"db.internal"`} {
		if strings.Contains(out, leak) {
			t.Fatalf("SECRET LEAK: %s survived inside secret_string = jsonencode({...}):\n%s", leak, out)
		}
	}
	for _, want := range []string{
		`username = "«redacted:`,
		`host     = "«redacted:`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected %q in:\n%s", want, out)
		}
	}
	// Line-count preserving, and structure (keys) still legible for the reviewer.
	if got, wantN := strings.Count(out, "\n"), strings.Count(src, "\n"); got != wantN {
		t.Fatalf("redaction changed the line count: %d vs %d", got, wantN)
	}
	if !strings.Contains(out, "secret_string = jsonencode({") {
		t.Fatalf("the opener line should stay legible:\n%s", out)
	}
}

// TestCovhclopsRedactSameLineOpenerInBenignBlockDoesNotOverMask: the same
// same-line-opener bookkeeping must NOT mask benign values when the opened scope
// is not secret-bearing — the guard tracks nesting, it does not mask everything
// it tracks.
func TestCovhclopsRedactSameLineOpenerInBenignBlockDoesNotOverMask(t *testing.T) {
	src := covhclopsLines(
		`resource "aws_s3_bucket" "b" {`,
		`  tags = merge({`,
		`    Name = "asset-store"`,
		`    Env  = "prod"`,
		`  })`,
		`}`,
	)
	out := string(RedactWith([]byte(src), RedactOptions{}))
	for _, keep := range []string{`"asset-store"`, `"prod"`} {
		if !strings.Contains(out, keep) {
			t.Fatalf("benign tag value %s was wrongly masked:\n%s", keep, out)
		}
	}
}

// TestCovhclopsRedactMasksEveryRuleClass walks one representative of each
// redaction rule class plus the explicit no-match path (nothing in the input is
// secret => output is byte-identical to the input).
func TestCovhclopsRedactMasksEveryRuleClass(t *testing.T) {
	t.Run("secret attribute names from the embedded rules", func(t *testing.T) {
		// One line per canonical secretAttributeNames entry, with a value that is
		// NOT high-entropy — so only the NAME rule can be what masks it.
		names := []string{
			"password", "passwd", "token", "api_token", "secret", "api_key", "apikey",
			"private_key", "privatekey", "psk", "preshared_key", "credential", "credentials",
			"access_key", "secret_key", "client_secret", "auth_token", "session_token",
			"sas_token", "connection_string", "shared_access_key",
		}
		for _, n := range names {
			line := "  " + n + ` = "plainvalue"`
			out := string(Redact([]byte(line)))
			if strings.Contains(out, `"plainvalue"`) {
				t.Errorf("%s: value not masked by the name rule: %s", n, out)
			}
			if !strings.HasPrefix(out, "  "+n+` = "«redacted:`) {
				t.Errorf("%s: unexpected masking shape: %s", n, out)
			}
		}
	})

	t.Run("substring and case insensitive name match", func(t *testing.T) {
		for _, n := range []string{"db_password", "MASTER_USER_PASSWORD", "rotation_api_key_arn"} {
			out := string(Redact([]byte("  " + n + ` = "plainvalue"`)))
			if strings.Contains(out, `"plainvalue"`) {
				t.Errorf("%s: secret-substring name should mask: %s", n, out)
			}
		}
	})

	t.Run("every value inside a mask-all block", func(t *testing.T) {
		for _, blk := range []string{"environment", "variables", "secret_string", "kms"} {
			src := covhclopsLines(blk+" {", `  benign = "plainvalue"`, "}")
			out := string(Redact([]byte(src)))
			if strings.Contains(out, `"plainvalue"`) {
				t.Errorf("%s block: value not masked: %s", blk, out)
			}
			// The stack pops on the closing brace: a value AFTER the block is visible.
			after := string(Redact([]byte(src + `benign = "plainvalue"` + "\n")))
			if !strings.Contains(after, `benign = "plainvalue"`) {
				t.Errorf("%s block: mask scope leaked past the closing brace: %s", blk, after)
			}
		}
	})

	t.Run("labelled block opener joins the stack", func(t *testing.T) {
		src := covhclopsLines(`environment "prod" {`, `  benign = "plainvalue"`, `}`)
		if out := string(Redact([]byte(src))); strings.Contains(out, `"plainvalue"`) {
			t.Fatalf("labelled mask-block opener not tracked: %s", out)
		}
	})

	t.Run("value shape rule on an unremarkable name", func(t *testing.T) {
		for _, v := range []string{
			"deadbeef-0000-4000-8000-000000000000",
			"AKIA1234567890ABCDEFghij",
		} {
			out := string(Redact([]byte(`  whatever = "` + v + `"`)))
			if strings.Contains(out, v) {
				t.Errorf("high-entropy value %q leaked: %s", v, out)
			}
		}
	})

	t.Run("no match leaves the text byte identical", func(t *testing.T) {
		src := covhclopsLines(
			`resource "aws_ebs_volume" "demo" {`,
			`  availability_zone = "ap-southeast-5a"`,
			`  size              = 20`,
			`  type              = "gp3"`,
			`  # a comment mentioning nothing sensitive`,
			`}`,
		)
		if out := string(Redact([]byte(src))); out != src {
			t.Fatalf("Redact altered non-secret text:\n--- want ---\n%s\n--- got ---\n%s", src, out)
		}
	})

	t.Run("diff-marker prefixed lines are masked and keep their marker", func(t *testing.T) {
		out := string(Redact([]byte("+  password = \"plainvalue\"\n-  password = \"othervalue\"\n")))
		if strings.Contains(out, "plainvalue") || strings.Contains(out, "othervalue") {
			t.Fatalf("SECRET LEAK on diff lines:\n%s", out)
		}
		if !strings.HasPrefix(out, "+  password = \"«redacted:") {
			t.Fatalf("diff marker not preserved:\n%s", out)
		}
		if !strings.Contains(out, "\n-  password = \"«redacted:") {
			t.Fatalf("deletion-side marker not preserved:\n%s", out)
		}
	})

	t.Run("unbalanced closing brace does not underflow the stack", func(t *testing.T) {
		out := string(Redact([]byte("}\n}\n  password = \"plainvalue\"\n")))
		if strings.Contains(out, "plainvalue") {
			t.Fatalf("stray closing braces broke the name rule:\n%s", out)
		}
	})
}

// TestCovhclopsMaskRhsMultipleLiteralsAndInterpolation: maskRhs works per quoted
// literal, is idempotent per literal, and masks EVERY literal on the line under
// maskAll (a single unmasked literal on a masked line is a leak).
func TestCovhclopsMaskRhsMultipleLiteralsAndInterpolation(t *testing.T) {
	t.Run("maskAll masks every literal", func(t *testing.T) {
		got := maskRhs(`concat("aa", "bb")`, true, "k")
		if strings.Contains(got, `"aa"`) || strings.Contains(got, `"bb"`) {
			t.Fatalf("maskAll left a literal visible: %s", got)
		}
		if n := strings.Count(got, "«redacted:"); n != 2 {
			t.Fatalf("want 2 masked literals, got %d: %s", n, got)
		}
	})
	t.Run("already masked literal is a fixed point", func(t *testing.T) {
		once := maskRhs(`"plainvalue"`, true, "k")
		if twice := maskRhs(once, true, "k"); twice != once {
			t.Fatalf("maskRhs not idempotent: %q then %q", once, twice)
		}
	})
	t.Run("no maskAll leaves benign literals alone", func(t *testing.T) {
		in := `"gp3"`
		if got := maskRhs(in, false, "type"); got != in {
			t.Fatalf("maskRhs(%q, false) = %q, want unchanged", in, got)
		}
	})
	t.Run("unquoted rhs is untouched", func(t *testing.T) {
		in := `var.size + 1`
		if got := maskRhs(in, true, "size"); got != in {
			t.Fatalf("maskRhs(%q) = %q, want unchanged", in, got)
		}
	})
}

// TestCovhclopsStableTagDeterministic: the mask pointer must be stable across
// calls (same secret => same tag) and distinguish distinct secrets, since the
// SPA display and the Go archive are compared by this tag.
func TestCovhclopsStableTagDeterministic(t *testing.T) {
	const v = "deadbeef-0000-4000-8000-000000000000"
	if a, b := stableTag(v), stableTag(v); a != b {
		t.Fatalf("stableTag not deterministic: %q vs %q", a, b)
	}
	if got := stableTag(v); got != "36e04505" {
		t.Fatalf("stableTag(%q) = %q, want the SPA-verified 36e04505", v, got)
	}
	if stableTag("a") == stableTag("b") {
		t.Fatal("distinct secrets collided")
	}
	if got := masked("x"); !strings.HasPrefix(got, "«redacted:") || !strings.HasSuffix(got, "»") {
		t.Fatalf("masked(%q) = %q, want the «redacted:…» envelope", "x", got)
	}
	if got := len(stableTag("")); got != 8 {
		t.Fatalf("stableTag width = %d, want 8 hex chars", got)
	}
}

// TestCovhclopsIsAllowlistedPrefixes pins the benign-prefix allowlist: an AWS
// resource id or a URL is never treated as a credential, but a value that merely
// CONTAINS such a prefix later in the string is not exempt.
func TestCovhclopsIsAllowlistedPrefixes(t *testing.T) {
	allowed := []string{
		"arn:aws:iam::123456789012:role/x", "ami-0abc", "subnet-0abc", "vpc-0abc",
		"sg-0abc", "i-0abc", "snap-0abc", "vol-0abc", "igw-0abc", "rtb-0abc",
		"acl-0abc", "eni-0abc", "nat-0abc", "eipalloc-0abc", "pcx-0abc", "tgw-0abc",
		"fs-0abc", "/subscriptions/abc", "http://example.test", "https://example.test",
	}
	for _, v := range allowed {
		if !isAllowlisted(v) {
			t.Errorf("isAllowlisted(%q) = false, want true", v)
		}
	}
	for _, v := range []string{"", "notarn:aws", "xami-0abc", "ftp://example.test"} {
		if isAllowlisted(v) {
			t.Errorf("isAllowlisted(%q) = true, want false", v)
		}
	}
	// An allowlisted prefix wins over the long-token shape rule.
	long := "https://example.test/" + strings.Repeat("A1", 20)
	if looksLikeSecret(long, "") {
		t.Errorf("allowlisted URL %q treated as a secret", long)
	}
}

// TestCovhclopsRedactionRulesLoaded proves the embedded rules actually reached
// the package-level tables at init (a silently empty table would disable every
// name-based mask while all shape-based tests still passed).
func TestCovhclopsRedactionRulesLoaded(t *testing.T) {
	if len(secretTerms) == 0 {
		t.Fatal("secretTerms empty — embedded redaction rules did not load")
	}
	for _, term := range secretTerms {
		if term != strings.ToLower(term) {
			t.Errorf("secretTerms entry %q is not lowercased", term)
		}
	}
	for _, b := range []string{"environment", "variables", "secret_string", "kms"} {
		if _, ok := maskBlocks[b]; !ok {
			t.Errorf("maskBlocks missing %q", b)
		}
	}
	if len(allowPrefixes) == 0 {
		t.Fatal("allowPrefixes empty — value allowlist did not load")
	}
}
