package driftpropose

import "testing"

// cleanImportBlock / cleanSkeleton are a minimal, legitimately-shaped
// import-payload pair (mirrors -generate-config-out's own machine-formatted
// output and gen-imports.py's import{} block shape) — the baseline every
// refusal test below mutates exactly one construct away from.
const (
	cleanImportBlock = "import {\n  to = aws_instance.oob_bastion01\n  id = \"i-0abc123def456789a\"\n}\n"
	cleanSkeleton    = "resource \"aws_instance\" \"oob_bastion01\" {\n  ami           = \"ami-0123456789abcdef0\"\n  instance_type = \"m5.large\"\n}\n"
)

// TestPayloadPrescanCleanPasses pins the happy path — and, implicitly, that
// the import block's OWN `to = aws_instance.oob_bastion01` traversal (a
// resource address reference, not a literal, by Terraform's own grammar) is
// correctly exempted: if it were not, EVERY clean payload would fail this
// prescan, since every import block carries exactly this shape.
func TestPayloadPrescanCleanPasses(t *testing.T) {
	reason, ok := PrescanImportPayload(cleanImportBlock, cleanSkeleton)
	if !ok {
		t.Fatalf("clean payload refused: %s", reason)
	}
	if reason != "" {
		t.Fatalf("ok payload carries a reason: %q", reason)
	}
}

// TestPayloadPrescanRefusesProvisioner pins spec §5.3a's "no
// provisioner/connection blocks anywhere (nested included)" rule — the exact
// no-execution gate internal/onboard runs before trusting a repo, applied
// here to generated HCL.
func TestPayloadPrescanRefusesProvisioner(t *testing.T) {
	skeleton := "resource \"aws_instance\" \"oob_bastion01\" {\n" +
		"  ami = \"ami-0123456789abcdef0\"\n\n" +
		"  provisioner \"local-exec\" {\n" +
		"    command = \"echo pwned\"\n" +
		"  }\n" +
		"}\n"
	reason, ok := PrescanImportPayload(cleanImportBlock, skeleton)
	if ok {
		t.Fatal("payload carrying a provisioner block was accepted")
	}
	if !containsAll(reason, "PROVISIONER") {
		t.Fatalf("reason = %q, want it to name PROVISIONER", reason)
	}
}

// TestPayloadPrescanRefusesNestedProvisioner pins the "nested included" half:
// a provisioner hidden inside a dynamic/connection wrapper is caught too
// (scanForProvisioners' own recursive walk, verbatim-reused from Scan).
func TestPayloadPrescanRefusesNestedProvisioner(t *testing.T) {
	skeleton := "resource \"aws_instance\" \"oob_bastion01\" {\n" +
		"  ami = \"ami-0123456789abcdef0\"\n\n" +
		"  dynamic \"provisioner\" {\n" +
		"    for_each = []\n" +
		"    content {}\n" +
		"  }\n" +
		"}\n"
	reason, ok := PrescanImportPayload(cleanImportBlock, skeleton)
	if ok {
		t.Fatal("payload carrying a dynamic-wrapped provisioner was accepted")
	}
	if !containsAll(reason, "PROVISIONER") {
		t.Fatalf("reason = %q, want it to name PROVISIONER", reason)
	}
}

// TestPayloadPrescanRefusesDisallowedBlock pins "top-level blocks may be
// ONLY import and resource": a data source appended alongside the resource
// skeleton is refused, never silently accepted as inert.
func TestPayloadPrescanRefusesDisallowedBlock(t *testing.T) {
	skeleton := cleanSkeleton + "\ndata \"aws_ami\" \"x\" {\n  most_recent = true\n}\n"
	reason, ok := PrescanImportPayload(cleanImportBlock, skeleton)
	if ok {
		t.Fatal("payload carrying a data block was accepted")
	}
	if !containsAll(reason, "DISALLOWED_BLOCK") {
		t.Fatalf("reason = %q, want it to name DISALLOWED_BLOCK", reason)
	}
}

// TestPayloadPrescanRefusesNonLiteralExpr pins "no traversal/reference
// expressions (literals and pure constructor syntax only)": a var.
// reference — something -generate-config-out never emits, but a
// hand-tampered payload might carry — is refused.
func TestPayloadPrescanRefusesNonLiteralExpr(t *testing.T) {
	skeleton := "resource \"aws_instance\" \"oob_bastion01\" {\n" +
		"  ami = var.ami_id\n" +
		"}\n"
	reason, ok := PrescanImportPayload(cleanImportBlock, skeleton)
	if ok {
		t.Fatal("payload carrying a var.* traversal was accepted")
	}
	if !containsAll(reason, "NONLITERAL_EXPR") {
		t.Fatalf("reason = %q, want it to name NONLITERAL_EXPR", reason)
	}
}

// TestPayloadPrescanRefusesUnparseable pins "parse must succeed".
func TestPayloadPrescanRefusesUnparseable(t *testing.T) {
	reason, ok := PrescanImportPayload(cleanImportBlock, "resource \"aws_instance\" \"broken\" {\n  ami = \n")
	if ok {
		t.Fatal("unparseable skeleton was accepted")
	}
	if reason == "" {
		t.Fatal("unparseable skeleton refused with no reason")
	}
}

// TestPayloadPrescanRefusesSecretShapedValue pins §2.6's secret battery,
// re-run here (spec §5.3a: "plus the secret battery") — the same rule
// importer/kit/payloads.py already enforces publisher-side, re-checked
// because catalogctl trusts no producer.
func TestPayloadPrescanRefusesSecretShapedValue(t *testing.T) {
	skeleton := "resource \"aws_db_instance\" \"oob_db01\" {\n" +
		"  identifier      = \"oob-db01\"\n" +
		"  master_password = \"hunter2-not-a-real-secret\"\n" +
		"}\n"
	reason, ok := PrescanImportPayload(cleanImportBlock, skeleton)
	if ok {
		t.Fatal("payload carrying a secret-named attribute was accepted")
	}
	if !containsAll(reason, "secret-shaped values") {
		t.Fatalf("reason = %q, want it to name the secret battery", reason)
	}
}
