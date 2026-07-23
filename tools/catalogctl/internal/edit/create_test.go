package edit

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/idioms"
	"gopkg.in/yaml.v3"
)

// create_test.go drives the REAL edit pipeline (run) for the create_resource verb
// (0036 T2/T3): the accept path is byte-exact against the banner-stripped goldens,
// and the refusal paths (ALREADY_EXISTS, REFERENCE_TYPE_MISMATCH, the two create
// guards) return exit 2 with no file written. Together with the render backstop
// (idiomrender_test.go) and the live TS↔Go harness (createResourceParity.test.ts)
// this is the T4 hard gate on the authored-HCL bytes.

// validReqID satisfies request.go's REQ-<Crockford-ulid> shape.
const validReqID = "REQ-00000000000000000000000000"

func schemaPathOrSkip(t *testing.T) string {
	t.Helper()
	matches, _ := filepath.Glob("../../../../tools/schemadump/aws-*-schema.json")
	if len(matches) == 0 {
		t.Skip("no schemadump found — skipping create verb test")
	}
	return matches[0]
}

// collectAddresses gathers every address-shaped value (scalar or list element) in a
// value map — the referents whose stub blocks the reference existence check needs.
func collectAddresses(values map[string]any, into map[string]bool) {
	add := func(v any) {
		if idioms.IsAddressShaped(v) {
			into[fmt.Sprint(v)] = true
		}
	}
	for _, v := range values {
		if arr, ok := v.([]any); ok {
			for _, e := range arr {
				add(e)
			}
			continue
		}
		add(v)
	}
}

// writeRefStubs writes one empty stub resource per referenced address into _refs.tf,
// so the reference existence/uniqueness check resolves. Addresses are sorted for a
// deterministic file.
func writeRefStubs(t *testing.T, dir string, addrs map[string]bool) {
	t.Helper()
	var lines []string
	keys := make([]string, 0, len(addrs))
	for a := range addrs {
		keys = append(keys, a)
	}
	sort.Strings(keys)
	for _, a := range keys {
		typ, name, _ := strings.Cut(a, ".")
		lines = append(lines, fmt.Sprintf("resource %q %q {}\n", typ, name))
	}
	if len(lines) == 0 {
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "_refs.tf"), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeRequest writes a minimal ccp.request/v1 YAML for opID + values. Empty
// values ("", []) are dropped: a real SPA request omits empty optional fields, and
// the renderer treats absent and empty identically (isEmptyValue) — so this mirrors
// production and avoids Validate refusing an empty optional that carries a pattern.
func writeRequest(t *testing.T, dir, opID string, values map[string]any) string {
	t.Helper()
	params := map[string]any{}
	for k, v := range values {
		if isEmptyValue(v) {
			continue
		}
		params[k] = v
	}
	doc := map[string]any{
		"schema": "ccp.request/v1",
		"id":     validReqID,
		"item":   opID,
		"params": params,
	}
	b, err := yaml.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "request.yaml")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// runCreate runs `edit` for a create op against a fresh temp env stubbed with the
// referenced addresses, returning the exit code, stdout, stderr, and the env dir.
func runCreate(t *testing.T, opID string, values map[string]any, extraStubs map[string]bool) (int, string, string, string) {
	t.Helper()
	env := t.TempDir()
	addrs := map[string]bool{}
	collectAddresses(values, addrs)
	for a := range extraStubs {
		addrs[a] = true
	}
	writeRefStubs(t, env, addrs)
	reqDir := t.TempDir()
	reqPath := writeRequest(t, reqDir, opID, values)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath,
		"--manifests", realManifestsDir,
		"--env", env,
		"--schema", schemaPathOrSkip(t),
	}, &stdout, &stderr)
	return code, stdout.String(), stderr.String(), env
}

// TestCreateResource_AcceptByteExact — every wired create baseline authors its
// service file byte-identical to the banner-stripped golden, through the full
// pipeline (Validate → ResolveTarget → reference seam → render → guards → write).
func TestCreateResource_AcceptByteExact(t *testing.T) {
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present — skipping")
	}
	serviceOf := map[string]string{
		"ec2-provision-instance": "ec2", "ebs-create-volume": "ebs",
		"s3-create-bucket": "s3", "s3-create-lifecycle-setup": "s3", "s3-start-versioning-setup": "s3",
		"sg-create-security-group": "security-groups", "alb-add-target-group": "alb",
		"efs-create-filesystem": "efs", "rds-provision-instance": "rds",
		"backup-create-vault": "backup", "backup-create-plan": "backup",
		"sns-create-topic": "sns", "lambda-create-function": "lambda",
	}
	// vpn-add-static-route is intentionally excluded (it stays instantiate_module).
	run1 := func(t *testing.T, goldenName, opID string, values map[string]any) {
		code, _, stderr, env := runCreate(t, opID, values, nil)
		if code != 0 {
			t.Fatalf("%s: exit %d, stderr=%s", goldenName, code, stderr)
		}
		got, err := os.ReadFile(filepath.Join(env, serviceOf[opID]+".tf"))
		if err != nil {
			t.Fatalf("%s: service file not written: %v", goldenName, err)
		}
		want := stripDraftBanner(goldenBaseline(t, goldenName))
		if strings.TrimRight(string(got), "\n") != want {
			t.Errorf("%s authored bytes mismatch\n--- got ---\n%s\n--- want ---\n%s", goldenName, got, want)
		}
	}
	for id, values := range baselineValues {
		if _, ok := serviceOf[id]; !ok {
			continue
		}
		t.Run(id, func(t *testing.T) { run1(t, id, id, values) })
	}
	for name, values := range baselineVariants() {
		baseID := strings.Split(name, "--")[0]
		t.Run(name, func(t *testing.T) { run1(t, name, baseID, values) })
	}
}

// TestCreateResource_AlreadyExists — a create refuses (exit 2) when ANY idiom
// address already exists, and writes nothing.
func TestCreateResource_AlreadyExists(t *testing.T) {
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present — skipping")
	}
	// s3-create-bucket's primary address (localName finance_interface) preplaced.
	code, _, stderr, env := runCreate(t, "s3-create-bucket", baselineValues["s3-create-bucket"],
		map[string]bool{"aws_s3_bucket.finance_interface": true})
	if code != 2 {
		t.Fatalf("exit %d, want 2; stderr=%s", code, stderr)
	}
	if !strings.Contains(stderr, "ALREADY_EXISTS") {
		t.Errorf("stderr missing ALREADY_EXISTS: %s", stderr)
	}
	if _, err := os.Stat(filepath.Join(env, "s3.tf")); !os.IsNotExist(err) {
		t.Errorf("s3.tf should not be written on refusal")
	}
}

// TestCreateResource_ReferenceTypeMismatch — a co-emitted reference pointed at the
// wrong resource type refuses REFERENCE_TYPE_MISMATCH (exit 2), reusing the shared
// value seam.
func TestCreateResource_ReferenceTypeMismatch(t *testing.T) {
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present — skipping")
	}
	bad := map[string]any{}
	for k, v := range baselineValues["ebs-create-volume"] {
		bad[k] = v
	}
	bad["attach_to"] = "aws_kms_key.wrong_type" // enumSource requires aws_instance
	code, _, stderr, _ := runCreate(t, "ebs-create-volume", bad, map[string]bool{"aws_kms_key.wrong_type": true})
	if code != 2 {
		t.Fatalf("exit %d, want 2; stderr=%s", code, stderr)
	}
	if !strings.Contains(stderr, "REFERENCE_TYPE_MISMATCH") {
		t.Errorf("stderr missing REFERENCE_TYPE_MISMATCH: %s", stderr)
	}
}

// TestGuardCreateLabels — the invert-sense label guard (guard #2): aws_* is REQUIRED
// as a top-level create type, and the local name must be a valid HCL ident.
func TestGuardCreateLabels(t *testing.T) {
	ok := []hclBlock{{blockType: "aws_s3_bucket", name: "good_name"}}
	if code, _ := guardCreateLabels(ok); code != "" {
		t.Errorf("well-formed labels refused: %s", code)
	}
	bad := [][]hclBlock{
		{{blockType: "s3_bucket", name: "x"}},        // not aws_*
		{{blockType: "aws_s3_bucket", name: "1bad"}}, // name not ident (leading digit)
		{{blockType: "aws_-evil", name: "x"}},        // malformed type
	}
	for _, blocks := range bad {
		if code, _ := guardCreateLabels(blocks); code != "MALFORMED_CREATE_LABEL" {
			t.Errorf("expected MALFORMED_CREATE_LABEL for %+v, got %q", blocks[0], code)
		}
	}
}

// TestGuardCreateBlocks — the schema widening (guard #1): an undeclared nested block
// on a reflected type refuses; an unreflected type fails open; and every real
// baseline idiom passes (no false refusal).
func TestGuardCreateBlocks(t *testing.T) {
	idx, err := loadNestedBlockIndex(schemaPathOrSkip(t))
	if err != nil {
		t.Fatal(err)
	}
	// Positive disproof: aws_instance declares no nested block "not_a_block".
	bogus := []hclBlock{{blockType: "aws_instance", name: "x", body: []bodyNode{
		{kind: "block", name: "not_a_block", body: nil},
	}}}
	if code, _ := guardCreateBlocks(bogus, idx); code != RefuseUnknownBlockType {
		t.Errorf("expected UNKNOWN_BLOCK_TYPE for undeclared nested block, got %q", code)
	}
	// Fail-open: a type absent from the dump → the schema cannot answer → never refused.
	// (aws_volume_attachment, the former example here, IS reflected in the comprehensive
	// v6.53.0 dump — 7 attrs — so a bogus block in it is now correctly refused; this case
	// needs a genuinely-absent type to still exercise the unanswerable→fail-open path. The
	// gap was masked until the schema guard was fixed to load the committed .gz in CI.)
	unreflected := []hclBlock{{blockType: "aws_totally_made_up", name: "x", body: []bodyNode{
		{kind: "block", name: "whatever", body: nil},
	}}}
	if code, _ := guardCreateBlocks(unreflected, idx); code != "" {
		t.Errorf("unreflected type should fail open, got refusal %q", code)
	}
	// No false refusal on any real baseline idiom.
	ops := loadRealOpsOrSkip(t)
	all := map[string]map[string]any{}
	for k, v := range baselineValues {
		all[k] = v
	}
	for k, v := range baselineVariants() {
		all[strings.Split(k, "--")[0]] = v // base op id
	}
	for id, values := range all {
		op, ok := ops[id]
		if !ok {
			continue
		}
		_, blocks, _ := renderCreateSkeleton(op, values)
		if code, reason := guardCreateBlocks(blocks, idx); code != "" {
			t.Errorf("baseline %s falsely refused by schema guard: %s — %s", id, code, reason)
		}
		if code, reason := guardCreateLabels(blocks); code != "" {
			t.Errorf("baseline %s falsely refused by label guard: %s — %s", id, code, reason)
		}
	}
}
