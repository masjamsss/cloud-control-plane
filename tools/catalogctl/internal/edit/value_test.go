package edit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// listRefEnv writes the referenced resources to a throwaway env dir and returns a
// Located for the target block whose File sits in that dir (so filepath.Dir(loc.File)
// is the env the reference resolves against). Only the REFERENCED resources need to
// be on disk — setAttribute edits loc.Bytes directly, it never re-reads the target.
func listRefEnv(t *testing.T, refs, targetSrc string) *hclops.Located {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "refs.tf"), []byte(refs), 0o644); err != nil {
		t.Fatal(err)
	}
	b := []byte(targetSrc)
	return &hclops.Located{File: filepath.Join(dir, "target.tf"), Bytes: b, Start: 0, End: len(b)}
}

// subnetListOp mirrors the fixed rds-change-subnet-group-subnets manifest shape: a
// set_attribute whose value param is a type:list role:"reference" onto aws_subnet,
// read via refAttr "id".
func subnetListOp() manifests.Op {
	op := manifests.Op{ID: "rds-change-subnet-group-subnets", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_db_subnet_group"
	op.Target.Attr = "subnet_ids"
	op.Params = []manifests.Param{
		{Name: "subnet_group", Source: "inventory"},
		{Name: "subnet_ids", Type: "list", Source: "inventory", Role: "reference",
			RefAttr: "id", EnumSource: "inventory://aws_subnet/address"},
	}
	return op
}

// TestSetAttributeListReference is the driving test (0036): a set_attribute op with a
// type:list role:"reference" value param must emit a TUPLE of per-element traversals —
// `subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]` — not error on the []any value.
func TestSetAttributeListReference(t *testing.T) {
	loc := listRefEnv(t,
		"resource \"aws_subnet\" \"a\" {}\nresource \"aws_subnet\" \"b\" {}\n",
		"resource \"aws_db_subnet_group\" \"g\" {\n  subnet_ids = [\"subnet-old\"]\n}\n")
	req := &request.Request{Params: map[string]any{
		"subnet_group": "aws_db_subnet_group.g",
		"subnet_ids":   []any{"aws_subnet.a", "aws_subnet.b"},
	}}
	out, code, reason, err := setAttribute(subnetListOp(), req, loc)
	if err != nil || code != "" {
		t.Fatalf("unexpected refuse/err: code=%q reason=%q err=%v", code, reason, err)
	}
	if want := "subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]"; !strings.Contains(string(out), want) {
		t.Fatalf("want %q in output, got:\n%s", want, out)
	}
}

// TestSetAttributeListReferenceTypeMismatch: the per-element type check (0031 M2) must
// apply to EACH element — a cross-type address in the list is an engineer-actionable
// REFUSE (exit 2), never a silently written wrong-type reference.
func TestSetAttributeListReferenceTypeMismatch(t *testing.T) {
	loc := listRefEnv(t,
		"resource \"aws_subnet\" \"a\" {}\nresource \"aws_vpc\" \"v\" {}\n",
		"resource \"aws_db_subnet_group\" \"g\" {\n  subnet_ids = [\"subnet-old\"]\n}\n")
	req := &request.Request{Params: map[string]any{
		"subnet_group": "aws_db_subnet_group.g",
		"subnet_ids":   []any{"aws_subnet.a", "aws_vpc.v"},
	}}
	_, code, _, err := setAttribute(subnetListOp(), req, loc)
	if err != nil {
		t.Fatalf("want REFUSE not err, got err=%v", err)
	}
	if code != "REFERENCE_TYPE_MISMATCH" {
		t.Fatalf("code = %q, want REFERENCE_TYPE_MISMATCH", code)
	}
}

// TestSetAttributeListReferenceMissingElement: a list element that resolves to zero
// blocks is a resolution failure (exit 3), same as the single-reference existence
// check — an unresolvable subnet must not be written.
func TestSetAttributeListReferenceMissingElement(t *testing.T) {
	loc := listRefEnv(t,
		"resource \"aws_subnet\" \"a\" {}\n",
		"resource \"aws_db_subnet_group\" \"g\" {\n  subnet_ids = [\"subnet-old\"]\n}\n")
	req := &request.Request{Params: map[string]any{
		"subnet_group": "aws_db_subnet_group.g",
		"subnet_ids":   []any{"aws_subnet.a", "aws_subnet.ghost"},
	}}
	_, code, _, err := setAttribute(subnetListOp(), req, loc)
	if err == nil {
		t.Fatal("want resolution error for a non-existent subnet element, got nil")
	}
	if code != "" {
		t.Fatalf("want plain resolution error (exit 3), got refuse code %q", code)
	}
}
