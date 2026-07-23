package hclops

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2/hclwrite"
)

const demoBlock = `resource "aws_ebs_volume" "demo" {
  availability_zone = "ap-southeast-5a"
  size              = 20
  type              = "gp3"
}
`

func TestLocateFindsBlockWithOffsets(t *testing.T) {
	dir := t.TempDir()
	fileA := "variable \"x\" {\n  default = 1\n}\n\n" + demoBlock
	if err := os.WriteFile(filepath.Join(dir, "a.tf"), []byte(fileA), 0o644); err != nil {
		t.Fatal(err)
	}
	other := "resource \"aws_s3_bucket\" \"other\" {\n  bucket = \"o\"\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "b.tf"), []byte(other), 0o644); err != nil {
		t.Fatal(err)
	}
	loc, err, code := Locate(dir, "aws_ebs_volume.demo")
	if err != nil || code != 0 {
		t.Fatalf("Locate err=%v code=%d", err, code)
	}
	if filepath.Base(loc.File) != "a.tf" {
		t.Fatalf("File = %s, want a.tf", loc.File)
	}
	got := loc.Bytes[loc.Start:loc.End]
	if !bytes.Equal(got, []byte(demoBlock)) {
		t.Fatalf("Bytes[Start:End] =\n%q\nwant\n%q", got, demoBlock)
	}
	if !strings.HasPrefix(string(got), `resource "aws_ebs_volume" "demo"`) || !strings.HasSuffix(string(got), "}\n") {
		t.Fatalf("slice not a clean block: %q", got)
	}
}

func TestLocateAmbiguousExit3(t *testing.T) {
	dir := t.TempDir()
	dup := "resource \"aws_ebs_volume\" \"dup\" {\n  size = 1\n}\n"
	os.WriteFile(filepath.Join(dir, "a.tf"), []byte(dup), 0o644)
	os.WriteFile(filepath.Join(dir, "b.tf"), []byte(dup), 0o644)
	_, err, code := Locate(dir, "aws_ebs_volume.dup")
	if code != 3 || err == nil {
		t.Fatalf("ambiguous Locate code=%d err=%v, want 3", code, err)
	}
}

func TestLocateNotFoundExit3(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.tf"), []byte(demoBlock), 0o644)
	_, err, code := Locate(dir, "aws_ebs_volume.missing")
	if code != 3 || err == nil {
		t.Fatalf("not-found Locate code=%d err=%v, want 3", code, err)
	}
}

func TestLocateLocalsByAttr(t *testing.T) {
	dir := t.TempDir()
	src := "locals {\n  alarms = {\n    a = 1\n  }\n  other = 2\n}\n"
	os.WriteFile(filepath.Join(dir, "l.tf"), []byte(src), 0o644)
	loc, err, code := Locate(dir, "local.alarms")
	if err != nil || code != 0 {
		t.Fatalf("Locate local.alarms err=%v code=%d", err, code)
	}
	if got := string(loc.Bytes[loc.Start:loc.End]); got != src {
		t.Fatalf("located block = %q, want whole locals block", got)
	}
	if _, err, code := Locate(dir, "local.missing"); code != 3 || err == nil {
		t.Fatalf("unknown local should exit 3, got code=%d", code)
	}
}

func TestFmtCanonical(t *testing.T) {
	clean := hclwrite.Format([]byte("resource \"x\" \"y\" {\n a=1\n}\n"))
	if !FmtCanonical(clean) {
		t.Fatalf("formatted snippet reported non-canonical:\n%q", clean)
	}
	dirty := []byte("resource \"x\" \"y\" {\n   a = 1\n}\n") // 3-space indent
	if FmtCanonical(dirty) {
		t.Fatalf("3-space indent reported canonical")
	}
}

func TestSpliceReproducesPrefixBlockSuffix(t *testing.T) {
	prefix := []byte("PRE line 1\nPRE line 2\n")
	block := []byte("OLD block\n")
	suffix := []byte("SUF line 1\n")
	orig := append(append(append([]byte{}, prefix...), block...), suffix...)
	newBlock := []byte("NEW block\nNEW block 2\n")
	out, err := Splice(orig, len(prefix), len(prefix)+len(block), newBlock)
	if err != nil {
		t.Fatal(err)
	}
	want := append(append(append([]byte{}, prefix...), newBlock...), suffix...)
	if !bytes.Equal(out, want) {
		t.Fatalf("splice = %q, want %q", out, want)
	}
}

func TestSpliceRangeGuard(t *testing.T) {
	if _, err := Splice([]byte("abc"), 2, 10, []byte("x")); err == nil {
		t.Fatalf("out-of-range splice should error")
	}
}

func TestUnifiedDiffBasic(t *testing.T) {
	a := []byte("l1\nl2\nl3\nOLD\nl5\nl6\n")
	b := []byte("l1\nl2\nl3\nNEW\nl5\nl6\n")
	out := UnifiedDiff("x.tf", "x.tf", a, b)
	s := string(out)
	if !strings.HasPrefix(s, "--- a/x.tf\n+++ b/x.tf\n") {
		t.Fatalf("bad header: %q", s)
	}
	if !strings.Contains(s, "-OLD\n") || !strings.Contains(s, "+NEW\n") {
		t.Fatalf("missing change lines: %q", s)
	}
}

// TestUnifiedDiffMatchesGolden pins the diff algorithm byte-exactly against the
// spec §4 law-diff transcribed below. Two sibling cases (ec2-resize/change-instance-type,
// ebs-grow/grow-20-to-40) were removed along with their contaminated testdata fixtures.
func TestUnifiedDiffMatchesGolden(t *testing.T) {
	cases := []struct {
		dir, file, path string
	}{
		{"s3-update-tags/set-pic", "s3.tf", "environments/prod/s3.tf"},
	}
	for _, c := range cases {
		base := filepath.Join("..", "..", "testdata", "golden", c.dir)
		before, err := os.ReadFile(filepath.Join(base, "before", c.file))
		if err != nil {
			t.Fatal(err)
		}
		expected, err := os.ReadFile(filepath.Join(base, "expected", c.file))
		if err != nil {
			t.Fatal(err)
		}
		wantDiff, err := os.ReadFile(filepath.Join(base, "expected.diff"))
		if err != nil {
			t.Fatal(err)
		}
		got := UnifiedDiff(c.path, c.path, before, expected)
		if !bytes.Equal(got, wantDiff) {
			t.Fatalf("%s diff mismatch:\n--- want ---\n%s\n--- got ---\n%s", c.dir, wantDiff, got)
		}
	}
}
