package driftpropose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

// covadopt_cov_test.go closes the coverage holes in adopt.go (the adopt-side
// locate/edit/splice core, its value-shape conversion and its literal-object
// token surgery) and generate.go (the per-lane ungenerable/error routing).
// Everything here asserts an observable contract: the returned refusal
// CODE/reason, the bytes ApplyAdopt actually writes, the rendered diff, or the
// ungenerable row Generate emits.

// covadoptWatchlistJSON is a well-formed but deliberately EMPTY checkout
// watchlist: no resource_types, no attribute_patterns, and a present-but-empty
// creation_security_types key — so the fourth screen (adopt) and the
// creation-security screen (import) both load cleanly and screen nothing,
// leaving the lane routing under test as the only thing that can refuse.
const covadoptWatchlistJSON = `{
  "version": 1,
  "doctrine": "covadopt slot fixture: loads cleanly, screens nothing",
  "resource_types": {},
  "attribute_patterns": [],
  "creation_security_types": []
}`

// covadoptBrokenTF is HCL that fails to parse — hclops.Locate reports exit-code
// 1 (an I/O/parse error on the checkout itself) rather than 3 (not found), which
// is the ONE adoptEdit input that must surface as an error instead of a
// per-verdict ungenerable reason.
const covadoptBrokenTF = "resource \"aws_instance\" \"broken\" {\n  ami = \n"

// covadoptEnvDir writes files (name -> body) into a fresh
// t.TempDir()/environments/prod and returns that directory — the envDir shape
// GenerateAdopt/ApplyAdopt take directly.
func covadoptEnvDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "environments", "prod")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// covadoptRepo is covadoptEnvDir's whole-checkout sibling for generate.go's
// entry points, which take the REPO root (they load
// scripts/drift/security-watchlist.json from it, independent of --root).
func covadoptRepo(t *testing.T, watchlist string, files map[string]string) string {
	t.Helper()
	repo := t.TempDir()
	dir := filepath.Join(repo, "environments", "prod")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if watchlist != "" {
		wlDir := filepath.Join(repo, "scripts", "drift")
		if err := os.MkdirAll(wlDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wlDir, "security-watchlist.json"), []byte(watchlist), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo
}

// covadoptAttr builds one changedAttrs row; live/code are raw JSON texts ("" =
// the key is absent entirely, which is exactly how a sensitive/pre-WI-1 row
// looks on the wire).
func covadoptAttr(path string, segs []any, live, code string) ChangedAttr {
	ca := ChangedAttr{Path: path, PathSegments: segs}
	if live != "" {
		ca.LiveJSON = json.RawMessage(live)
	}
	if code != "" {
		ca.CodeJSON = json.RawMessage(code)
	}
	return ca
}

// covadoptAdoptVerdict is the ADOPT-eligible verdict shape (benign_inplace, low
// risk, exactly [update], drift evidence present) every adopt case below starts
// from — so any refusal a test observes comes from the checkout-dependent
// refinement under test, never from ClassifyByFields' field-level screens.
func covadoptAdoptVerdict(address string, attrs ...ChangedAttr) Verdict {
	return Verdict{
		Address:       address,
		Type:          strings.SplitN(address, ".", 2)[0],
		Class:         "benign_inplace",
		RiskTier:      "low",
		DriftEvidence: true,
		Actions:       []string{"update"},
		ChangedAttrs:  attrs,
	}
}

// covadoptRequireAdoptBucket fails the test unless v is ADOPT-eligible on its
// FIELDS alone — the documented precondition of GenerateAdopt/ApplyAdopt.
func covadoptRequireAdoptBucket(t *testing.T, v Verdict) {
	t.Helper()
	if bucket, reason := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("precondition failed: ClassifyByFields = %q (reason=%q), want %q", bucket, reason, BucketAdopt)
	}
}

// covadoptBlock parses exactly one block out of src for the direct
// setAtSegments/setNestedSingleBlock unit tests below.
func covadoptBlock(t *testing.T, src string) *hclwrite.Block {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "covadopt.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("parse fixture HCL: %s", diags.Error())
	}
	blocks := f.Body().Blocks()
	if len(blocks) != 1 {
		t.Fatalf("fixture HCL declares %d blocks, want 1", len(blocks))
	}
	return blocks[0]
}

// covadoptExprTokens returns the token stream of expr exactly as hclwrite hands
// it to parseObjectLiteral (Attr.Expr().BuildTokens) — a real tokenization, not
// a hand-assembled approximation.
func covadoptExprTokens(t *testing.T, expr string) hclwrite.Tokens {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte("x = "+expr+"\n"), "covadopt.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("parse fixture expression %q: %s", expr, diags.Error())
	}
	a := f.Body().GetAttribute("x")
	if a == nil {
		t.Fatalf("fixture expression %q produced no attribute", expr)
	}
	return a.Expr().BuildTokens(nil)
}

func covadoptTok(tt hclsyntax.TokenType, b string) *hclwrite.Token {
	return &hclwrite.Token{Type: tt, Bytes: []byte(b)}
}

// covadoptAddedLines returns the diff's added content lines (excluding the
// "+++" file header) — how a test proves an adopt diff touched exactly the
// lines it promised and nothing else.
func covadoptAddedLines(diff string) []string {
	var out []string
	for _, l := range strings.Split(diff, "\n") {
		if strings.HasPrefix(l, "+") && !strings.HasPrefix(l, "+++") {
			out = append(out, l)
		}
	}
	return out
}

func covadoptRemovedLines(diff string) []string {
	var out []string
	for _, l := range strings.Split(diff, "\n") {
		if strings.HasPrefix(l, "-") && !strings.HasPrefix(l, "---") {
			out = append(out, l)
		}
	}
	return out
}

// TestCovadoptAdoptScalarValueShapes drives the [s] (top-level scalar) shape of
// spec addendum A4 end to end for every JSON value shape jsonToCty converts:
// string, null (the explicit "unset" spelling A5 pins), bool, a whole-numbered
// number (rendered "3", never "3.0"), a fractional number, an empty and a
// populated list, and an empty and a populated object. GenerateAdopt's diff and
// ApplyAdopt's written bytes are asserted together, so the reviewed diff and the
// replayed write are proven to be the same edit.
func TestCovadoptAdoptScalarValueShapes(t *testing.T) {
	cases := []struct {
		name       string
		tf         string
		address    string
		path       string
		live       string
		wantInFile []string
		wantGone   []string
	}{
		{
			name:       "string",
			tf:         "resource \"aws_instance\" \"box01\" {\n  ami           = \"ami-0123456789abcdef0\"\n  instance_type = \"m5.xlarge\"\n}\n",
			address:    "aws_instance.box01",
			path:       "instance_type",
			live:       `"m5.large"`,
			wantInFile: []string{`instance_type = "m5.large"`},
			wantGone:   []string{"m5.xlarge"},
		},
		{
			name:       "null writes the explicit unset spelling",
			tf:         "resource \"aws_instance\" \"box02\" {\n  ami        = \"ami-0123456789abcdef0\"\n  monitoring = true\n}\n",
			address:    "aws_instance.box02",
			path:       "monitoring",
			live:       `null`,
			wantInFile: []string{"monitoring = null"},
			wantGone:   []string{"monitoring = true"},
		},
		{
			name:       "bool",
			tf:         "resource \"aws_instance\" \"box03\" {\n  ami        = \"ami-0123456789abcdef0\"\n  monitoring = false\n}\n",
			address:    "aws_instance.box03",
			path:       "monitoring",
			live:       `true`,
			wantInFile: []string{"monitoring = true"},
			wantGone:   []string{"monitoring = false"},
		},
		{
			name:       "whole number renders without a decimal point",
			tf:         "resource \"aws_autoscaling_group\" \"asg01\" {\n  name             = \"asg01\"\n  desired_capacity = 2\n}\n",
			address:    "aws_autoscaling_group.asg01",
			path:       "desired_capacity",
			live:       `3`,
			wantInFile: []string{"desired_capacity = 3"},
			wantGone:   []string{"desired_capacity = 2", "3.0"},
		},
		{
			name:       "fractional number",
			tf:         "resource \"aws_autoscaling_policy\" \"cpu01\" {\n  name         = \"cpu01\"\n  target_value = 60\n}\n",
			address:    "aws_autoscaling_policy.cpu01",
			path:       "target_value",
			live:       `55.5`,
			wantInFile: []string{"target_value = 55.5"},
			wantGone:   []string{"target_value = 60"},
		},
		{
			name:       "empty list",
			tf:         "resource \"aws_elasticache_cluster\" \"cache01\" {\n  cluster_id = \"cache01\"\n  subnet_ids = [\"subnet-0000000000000000a\"]\n}\n",
			address:    "aws_elasticache_cluster.cache01",
			path:       "subnet_ids",
			live:       `[]`,
			wantInFile: []string{"subnet_ids = []"},
			wantGone:   []string{"subnet-0000000000000000a"},
		},
		{
			name:       "populated list",
			tf:         "resource \"aws_elasticache_cluster\" \"cache02\" {\n  cluster_id = \"cache02\"\n  subnet_ids = [\"subnet-0000000000000000a\"]\n}\n",
			address:    "aws_elasticache_cluster.cache02",
			path:       "subnet_ids",
			live:       `["subnet-0000000000000000a","subnet-0000000000000000b"]`,
			wantInFile: []string{"subnet-0000000000000000a", "subnet-0000000000000000b"},
		},
		{
			name:       "empty object",
			tf:         "resource \"aws_instance\" \"box04\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  tags = {\n    Owner = \"platform\"\n  }\n}\n",
			address:    "aws_instance.box04",
			path:       "tags",
			live:       `{}`,
			wantInFile: []string{"tags = {}"},
			wantGone:   []string{"platform"},
		},
		{
			name:       "populated object",
			tf:         "resource \"aws_instance\" \"box05\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  tags = {\n    Owner = \"platform\"\n  }\n}\n",
			address:    "aws_instance.box05",
			path:       "tags",
			live:       `{"Env":"prod","Owner":"bi-team"}`,
			wantInFile: []string{`Owner = "bi-team"`, `Env`, `"prod"`},
			wantGone:   []string{`"platform"`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			envDir := covadoptEnvDir(t, map[string]string{"main.tf": tc.tf})
			v := covadoptAdoptVerdict(tc.address, covadoptAttr(tc.path, []any{tc.path}, tc.live, `"stale"`))
			covadoptRequireAdoptBucket(t, v)

			p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
			if err != nil {
				t.Fatalf("GenerateAdopt: %v", err)
			}
			if reason != "" {
				t.Fatalf("unexpected ungenerable reason: %s", reason)
			}
			if p == nil || p.Diff == nil {
				t.Fatal("GenerateAdopt returned no proposal/diff for an eligible scalar edit")
			}
			if len(p.Attrs) != 1 || p.Attrs[0].Path != tc.path {
				t.Fatalf("proposal attrs = %+v, want the one edited path %q", p.Attrs, tc.path)
			}

			// The write-capable twin must land the very bytes the diff advertised.
			wrote, reason, err := ApplyAdopt(v, envDir)
			if err != nil {
				t.Fatalf("ApplyAdopt: %v", err)
			}
			if reason != "" {
				t.Fatalf("ApplyAdopt ungenerable reason: %s", reason)
			}
			if !wrote {
				t.Fatal("ApplyAdopt reported no write for a real value change")
			}
			got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.wantInFile {
				if !strings.Contains(string(got), want) {
					t.Errorf("written file does not contain %q:\n%s", want, got)
				}
				if !strings.Contains(*p.Diff, want) {
					t.Errorf("diff does not advertise %q:\n%s", want, *p.Diff)
				}
			}
			for _, gone := range tc.wantGone {
				if strings.Contains(string(got), gone) {
					t.Errorf("written file still contains %q:\n%s", gone, got)
				}
			}
			// Re-applying the same verdict is a verified no-op, never a second write.
			wrote2, reason2, err := ApplyAdopt(v, envDir)
			if err != nil || reason2 != "" || wrote2 {
				t.Fatalf("re-apply = (wrote=%v, reason=%q, err=%v), want (false, \"\", nil) — verified no-op", wrote2, reason2, err)
			}
		})
	}
}

// TestCovadoptAdoptVerifiedNoOp pins GenerateAdopt's "verified no-op" outcome
// (adopt.go's empty-diff branch): a re-generation whose liveJson already matches
// the checkout is NOT an error and NOT a proposal — there is simply nothing left
// to propose. ApplyAdopt's twin outcome (success, nothing written) is asserted
// on the same inputs, and the file is proven byte-identical afterwards.
func TestCovadoptAdoptVerifiedNoOp(t *testing.T) {
	cases := []struct {
		name string
		attr ChangedAttr
	}{
		{
			name: "map key already carries the live value",
			attr: covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `"platform"`, `"platform"`),
		},
		{
			name: "map key deleted live is already absent from code",
			attr: covadoptAttr("tags.CostCenter", []any{"tags", "CostCenter"}, `null`, ""),
		},
		{
			name: "scalar already carries the live value",
			attr: covadoptAttr("instance_type", []any{"instance_type"}, `"m5.xlarge"`, `"m5.xlarge"`),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkout := copyCheckoutFixture(t)
			envDir := filepath.Join(checkout, "environments/prod")
			before, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
			if err != nil {
				t.Fatal(err)
			}

			v := covadoptAdoptVerdict("aws_instance.sample01", tc.attr)
			covadoptRequireAdoptBucket(t, v)

			p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
			if err != nil {
				t.Fatalf("GenerateAdopt: %v", err)
			}
			if p != nil {
				t.Fatalf("GenerateAdopt proposed a diff for an already-converged value: %s", *p.Diff)
			}
			if !strings.Contains(reason, "verified no-op") {
				t.Fatalf("reason = %q, want it to report the verified no-op", reason)
			}

			wrote, applyReason, err := ApplyAdopt(v, envDir)
			if err != nil {
				t.Fatalf("ApplyAdopt: %v", err)
			}
			if wrote {
				t.Fatal("ApplyAdopt wrote for a verified no-op")
			}
			if applyReason != "" {
				t.Fatalf("ApplyAdopt reason = %q, want a verified no-op to be plain success", applyReason)
			}
			after, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(before) {
				t.Fatalf("a verified no-op changed the checkout:\n--- before ---\n%s\n--- after ---\n%s", before, after)
			}
		})
	}
}

// TestCovadoptAdoptUpsertsNewMapKey pins mergeSingleKey's not-found arm: a tag
// key present live but absent from code is APPENDED to the existing literal map
// — one added line, every sibling key and its alignment untouched. The two
// spellings keyTokensFor chooses between are both exercised: a bare identifier
// key, and a dotted/slashed key that must be emitted as an escaped string
// literal (never raw bytes, which could break out of the map at format time).
func TestCovadoptAdoptUpsertsNewMapKey(t *testing.T) {
	cases := []struct {
		name        string
		address     string
		file        string
		key         string
		live        string
		wantAdded   string
		wantKeptAll []string
	}{
		{
			name:        "bare identifier key",
			address:     "aws_instance.sample01",
			file:        "main.tf",
			key:         "Team",
			live:        `"bi-team"`,
			wantAdded:   `Team  = "bi-team"`,
			wantKeptAll: []string{`Owner = "platform"`, `Env   = "prod"`},
		},
		{
			name:        "dotted key is emitted as a quoted string literal",
			address:     "aws_instance.dottedbox01",
			file:        "extra-dotted-key.tf",
			key:         "kubernetes.io/role/nlb",
			live:        `"owned"`,
			wantAdded:   `"kubernetes.io/role/nlb" = "owned"`,
			wantKeptAll: []string{`"kubernetes.io/role/elb" = "shared"`, `Owner                    = "platform"`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkout := copyCheckoutFixture(t)
			envDir := filepath.Join(checkout, "environments/prod")
			v := covadoptAdoptVerdict(tc.address,
				covadoptAttr("tags."+tc.key, []any{"tags", tc.key}, tc.live, ""))
			covadoptRequireAdoptBucket(t, v)

			p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
			if err != nil {
				t.Fatalf("GenerateAdopt: %v", err)
			}
			if reason != "" || p == nil {
				t.Fatalf("GenerateAdopt refused a new-key upsert: reason=%q", reason)
			}
			added := covadoptAddedLines(*p.Diff)
			if len(added) != 1 || !strings.Contains(added[0], tc.wantAdded) {
				t.Fatalf("added lines = %q, want exactly one carrying %q:\n%s", added, tc.wantAdded, *p.Diff)
			}
			if removed := covadoptRemovedLines(*p.Diff); len(removed) != 0 {
				t.Fatalf("a pure key upsert removed lines %q:\n%s", removed, *p.Diff)
			}

			if _, _, err := ApplyAdopt(v, envDir); err != nil {
				t.Fatalf("ApplyAdopt: %v", err)
			}
			got, err := os.ReadFile(filepath.Join(envDir, tc.file))
			if err != nil {
				t.Fatal(err)
			}
			for _, kept := range tc.wantKeptAll {
				if !strings.Contains(string(got), kept) {
					t.Errorf("upsert disturbed sibling key line %q:\n%s", kept, got)
				}
			}
			if !strings.Contains(string(got), tc.wantAdded) {
				t.Errorf("written file does not carry the new key %q:\n%s", tc.wantAdded, got)
			}
		})
	}
}

// TestCovadoptAdoptMapPathRefusals pins the map-path refusals that are
// checkout-dependent and therefore invisible to ClassifyByFields — for BOTH
// directions of the 2-segment shape: an upsert (live value) and a removal (live
// null, spec F3/A5). drift-propose v1 never fabricates a map and never
// overwrites a non-literal one, so all four combinations are ungenerable
// reasons — never an error, never a partial write.
func TestCovadoptAdoptMapPathRefusals(t *testing.T) {
	const noTags = "resource \"aws_instance\" \"notags01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n"
	const refTags = "resource \"aws_instance\" \"reftags01\" {\n  ami  = \"ami-0123456789abcdef0\"\n  tags = local.common_tags\n}\n"
	const forTags = "resource \"aws_instance\" \"fortags01\" {\n  ami  = \"ami-0123456789abcdef0\"\n  tags = { for k, v in local.common_tags : k => v }\n}\n"

	cases := []struct {
		name    string
		tf      string
		address string
		live    string
		want    []string
	}{
		{
			name: "upsert into a missing map attribute", tf: noTags, address: "aws_instance.notags01",
			live: `"bi-team"`, want: []string{"tags", "never fabricates"},
		},
		{
			name: "removal from a missing map attribute", tf: noTags, address: "aws_instance.notags01",
			live: `null`, want: []string{"tags", "never fabricates"},
		},
		{
			name: "upsert into a referenced (non-literal) map", tf: refTags, address: "aws_instance.reftags01",
			live: `"bi-team"`, want: []string{"tags", "not a literal object"},
		},
		{
			name: "removal from a referenced (non-literal) map", tf: refTags, address: "aws_instance.reftags01",
			live: `null`, want: []string{"tags", "not a literal object"},
		},
		{
			name: "upsert into a for-expression map", tf: forTags, address: "aws_instance.fortags01",
			live: `"bi-team"`, want: []string{"tags", "not a literal object"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			envDir := covadoptEnvDir(t, map[string]string{"main.tf": tc.tf})
			v := covadoptAdoptVerdict(tc.address, covadoptAttr("tags.Owner", []any{"tags", "Owner"}, tc.live, ""))
			covadoptRequireAdoptBucket(t, v)

			p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
			if err != nil {
				t.Fatalf("GenerateAdopt returned an error, want a clean ungenerable reason: %v", err)
			}
			if p != nil {
				t.Fatalf("GenerateAdopt produced a proposal: %+v", p)
			}
			if !containsAll(reason, tc.want...) {
				t.Fatalf("reason = %q, want it to name %v", reason, tc.want)
			}

			// The write-capable twin must refuse identically and leave the file alone.
			wrote, applyReason, err := ApplyAdopt(v, envDir)
			if err != nil {
				t.Fatalf("ApplyAdopt returned an error, want the same ungenerable reason: %v", err)
			}
			if wrote {
				t.Fatal("ApplyAdopt wrote despite a refusal")
			}
			if applyReason != reason {
				t.Fatalf("ApplyAdopt reason = %q, want GenerateAdopt's own %q (one shared core)", applyReason, reason)
			}
			got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.tf {
				t.Fatalf("a refusal modified the checkout:\n%s", got)
			}
		})
	}
}

// TestCovadoptAdoptNestedBlockOutcomes covers setNestedSingleBlock's remaining
// arms for the [s, 0, s] shape: a leaf whose live value is null is REMOVED (the
// clean unset spelling for a nested-block attribute, spec addendum A5), and a
// nested block type that simply is not present in the checkout is ungenerable —
// never fabricated.
func TestCovadoptAdoptNestedBlockOutcomes(t *testing.T) {
	t.Run("live null removes the nested leaf", func(t *testing.T) {
		checkout := copyCheckoutFixture(t)
		envDir := filepath.Join(checkout, "environments/prod")
		v := covadoptAdoptVerdict("aws_instance.volbox01",
			covadoptAttr("root_block_device[0].volume_type", []any{"root_block_device", 0, "volume_type"}, `null`, `"gp3"`))
		covadoptRequireAdoptBucket(t, v)

		p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
		if err != nil {
			t.Fatalf("GenerateAdopt: %v", err)
		}
		if reason != "" || p == nil {
			t.Fatalf("GenerateAdopt refused a nested-leaf removal: reason=%q", reason)
		}
		if removed := covadoptRemovedLines(*p.Diff); len(removed) != 1 || !strings.Contains(removed[0], `volume_type = "gp3"`) {
			t.Fatalf("removed lines = %q, want exactly the volume_type line:\n%s", removed, *p.Diff)
		}
		if added := covadoptAddedLines(*p.Diff); len(added) != 0 {
			t.Fatalf("a nested-leaf removal added lines %q (a literal null?):\n%s", added, *p.Diff)
		}

		if _, _, err := ApplyAdopt(v, envDir); err != nil {
			t.Fatalf("ApplyAdopt: %v", err)
		}
		got, err := os.ReadFile(filepath.Join(envDir, "extra-nested-block.tf"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(got), "volume_type") {
			t.Fatalf("volume_type survived the removal:\n%s", got)
		}
		if !strings.Contains(string(got), "volume_size = 80") {
			t.Fatalf("the sibling leaf was disturbed:\n%s", got)
		}
	})

	t.Run("missing nested block is never fabricated", func(t *testing.T) {
		const tf = "resource \"aws_instance\" \"noblock01\" {\n  ami           = \"ami-0123456789abcdef0\"\n  instance_type = \"m5.large\"\n}\n"
		envDir := covadoptEnvDir(t, map[string]string{"main.tf": tf})
		v := covadoptAdoptVerdict("aws_instance.noblock01",
			covadoptAttr("root_block_device[0].volume_size", []any{"root_block_device", 0, "volume_size"}, `100`, `80`))
		covadoptRequireAdoptBucket(t, v)

		p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
		if err != nil {
			t.Fatalf("GenerateAdopt: %v", err)
		}
		if p != nil {
			t.Fatalf("GenerateAdopt fabricated a nested block: %+v", p)
		}
		if !containsAll(reason, "root_block_device", "not present", "never fabricated") {
			t.Fatalf("reason = %q, want it to name the absent block and the never-fabricate doctrine", reason)
		}
		got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tf {
			t.Fatalf("a refusal modified the checkout:\n%s", got)
		}
	})
}

// TestCovadoptAdoptSurfacesCheckoutParseErrorAsError pins the ONE adoptEdit
// input that is an ERROR rather than a per-verdict ungenerable reason: the
// checkout itself does not parse (hclops.Locate's exit-code-1 arm). An
// unparseable tree is not a fact about this verdict, so it must never be
// recorded as "this verdict is ungenerable" — both GenerateAdopt and ApplyAdopt
// must surface it.
func TestCovadoptAdoptSurfacesCheckoutParseErrorAsError(t *testing.T) {
	envDir := covadoptEnvDir(t, map[string]string{"main.tf": covadoptBrokenTF})
	v := covadoptAdoptVerdict("aws_instance.sample01",
		covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `"bi-team"`, `"platform"`))
	covadoptRequireAdoptBucket(t, v)

	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err == nil {
		t.Fatalf("GenerateAdopt swallowed an unparseable checkout (p=%+v, reason=%q)", p, reason)
	}
	if reason != "" {
		t.Errorf("reason = %q, want empty — an unparseable checkout is not a per-verdict refusal", reason)
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Errorf("err = %v, want it to name the parse failure", err)
	}

	wrote, reason, err := ApplyAdopt(v, envDir)
	if err == nil {
		t.Fatal("ApplyAdopt swallowed an unparseable checkout")
	}
	if wrote || reason != "" {
		t.Errorf("ApplyAdopt = (wrote=%v, reason=%q), want (false, \"\") alongside the error", wrote, reason)
	}
}

// TestCovadoptAdoptEditRejectsBypassedCaller pins adoptEdit's two
// programming-error guards: they fire only for a caller that skipped
// ClassifyByFields, so each case asserts BOTH that ClassifyByFields would have
// refused the verdict AND that adoptEdit still fails closed with an error (never
// a silent guess, never a proposal).
func TestCovadoptAdoptEditRejectsBypassedCaller(t *testing.T) {
	const tf = "resource \"aws_instance\" \"bypass01\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  tags = {\n    Owner = \"platform\"\n  }\n}\n"
	cases := []struct {
		name string
		attr ChangedAttr
		// fieldBucket is what ClassifyByFields makes of the row: BucketUngenerable
		// for every shape it can screen on fields alone (so the adoptEdit guard is
		// genuinely unreachable through the sanctioned path), BucketAdopt for the
		// one shape it cannot — liveJson bytes that are PRESENT but not decodable,
		// which encoding/json's own envelope-level decode already makes impossible
		// on the wire (asserted below), leaving only an in-process caller.
		fieldBucket Bucket
		want        []string
	}{
		{
			name:        "row carries no liveJson value",
			attr:        covadoptAttr("tags.Owner", []any{"tags", "Owner"}, "", `"platform"`),
			fieldBucket: BucketUngenerable,
			want:        []string{"no liveJson value", "bypassed ClassifyByFields"},
		},
		{
			name:        "row carries undecodable liveJson bytes",
			attr:        covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `{not json`, ""),
			fieldBucket: BucketAdopt,
			want:        []string{"no liveJson value", "bypassed ClassifyByFields"},
		},
		{
			name:        "segment shape the edit engine cannot express",
			attr:        covadoptAttr("a.b.c.d", []any{"a", "b", "c", "d"}, `"x"`, ""),
			fieldBucket: BucketUngenerable,
			want:        []string{"not expressible by the edit engine", "bypassed ClassifyByFields"},
		},
		{
			name:        "malformed pathSegments never fall back to the display path",
			attr:        covadoptAttr("tags.Owner", []any{"tags", -1}, `"x"`, ""),
			fieldBucket: BucketUngenerable,
			want:        []string{"not expressible by the edit engine", "bypassed ClassifyByFields"},
		},
	}
	// No stored envelope can carry undecodable liveJson bytes: json.RawMessage
	// still has to be a syntactically valid JSON value for the envelope decode
	// itself to succeed.
	if _, err := ParseEnvelope([]byte(`{"schema":"` + EnvelopeSchema + `","projectId":"p","planExitCode":2,` +
		`"report":{"verdicts":[{"address":"aws_instance.bypass01","changedAttrs":[{"path":"tags.Owner","liveJson":{not json}]}]}}`)); err == nil {
		t.Fatal("ParseEnvelope accepted an envelope carrying undecodable liveJson bytes")
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			envDir := covadoptEnvDir(t, map[string]string{"main.tf": tf})
			v := covadoptAdoptVerdict("aws_instance.bypass01", tc.attr)
			if bucket, _ := ClassifyByFields(v); bucket != tc.fieldBucket {
				t.Fatalf("ClassifyByFields = %q, want %q", bucket, tc.fieldBucket)
			}

			p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
			if err == nil {
				t.Fatalf("GenerateAdopt accepted a bypassed row (p=%+v, reason=%q)", p, reason)
			}
			if p != nil || reason != "" {
				t.Errorf("got (p=%+v, reason=%q) alongside the error, want both zero", p, reason)
			}
			if !containsAll(err.Error(), tc.want...) {
				t.Errorf("err = %v, want it to name %v", err, tc.want)
			}
			got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tf {
				t.Fatalf("a bypass error modified the checkout:\n%s", got)
			}
		})
	}
}

// TestCovadoptApplyAdoptComposesEditsToTheSameFile pins ApplyAdopt's documented
// composition property: because the shared core re-reads the *.tf files from
// disk on every call, adopting two verdicts that touch the SAME file in a loop
// composes — the second call sees the first call's write, rather than clobbering
// it with a stale in-memory copy.
func TestCovadoptApplyAdoptComposesEditsToTheSameFile(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	envDir := filepath.Join(checkout, "environments/prod")

	first := covadoptAdoptVerdict("aws_instance.sample01",
		covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `"bi-team"`, `"platform"`))
	second := covadoptAdoptVerdict("aws_db_instance.db1",
		covadoptAttr("instance_class", []any{"instance_class"}, `"db.m5.xlarge"`, `"db.m5.large"`))

	for i, v := range []Verdict{first, second} {
		covadoptRequireAdoptBucket(t, v)
		wrote, reason, err := ApplyAdopt(v, envDir)
		if err != nil {
			t.Fatalf("ApplyAdopt[%d]: %v", i, err)
		}
		if reason != "" || !wrote {
			t.Fatalf("ApplyAdopt[%d] = (wrote=%v, reason=%q), want a real write", i, wrote, reason)
		}
	}

	got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`Owner = "bi-team"`, `instance_class = "db.m5.xlarge"`, `Env   = "prod"`} {
		if !strings.Contains(string(got), want) {
			t.Errorf("composed file does not carry %q:\n%s", want, got)
		}
	}
}

// TestCovadoptApplyAdoptSurfacesWriteFailure pins the write-failure arm: a
// refused write is an ERROR naming the file, never a silent success. Skipped as
// root, for whom mode bits are advisory.
func TestCovadoptApplyAdoptSurfacesWriteFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny writes, so the write-failure arm is unreachable here")
	}
	const tf = "resource \"aws_instance\" \"ro01\" {\n  ami           = \"ami-0123456789abcdef0\"\n  instance_type = \"m5.xlarge\"\n}\n"
	envDir := covadoptEnvDir(t, map[string]string{"main.tf": tf})
	target := filepath.Join(envDir, "main.tf")
	if err := os.Chmod(target, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(target, 0o644) })

	v := covadoptAdoptVerdict("aws_instance.ro01",
		covadoptAttr("instance_type", []any{"instance_type"}, `"m5.large"`, `"m5.xlarge"`))
	covadoptRequireAdoptBucket(t, v)

	wrote, reason, err := ApplyAdopt(v, envDir)
	if err == nil {
		t.Fatal("ApplyAdopt reported success writing to a read-only file")
	}
	if wrote || reason != "" {
		t.Errorf("got (wrote=%v, reason=%q), want (false, \"\") alongside the error", wrote, reason)
	}
	if !containsAll(err.Error(), "aws_instance.ro01", "main.tf") {
		t.Errorf("err = %v, want it to name the address and the file", err)
	}
}

// TestCovadoptJSONToCty pins jsonToCty's conversion table over exactly the value
// shapes encoding/json produces, including the int-vs-float distinction the doc
// promises ("80", never the surprising "80.0"), and its fail-closed error for
// anything else — asserted on the RENDERED HCL bytes, which is what the edit
// engine actually writes.
func TestCovadoptJSONToCty(t *testing.T) {
	ok := []struct {
		name       string
		in         any
		wantRender string
		wantType   cty.Type
	}{
		{name: "null", in: nil, wantRender: "null", wantType: cty.DynamicPseudoType},
		{name: "string", in: "hello", wantRender: `"hello"`, wantType: cty.String},
		{name: "bool true", in: true, wantRender: "true", wantType: cty.Bool},
		{name: "bool false", in: false, wantRender: "false", wantType: cty.Bool},
		{name: "whole float renders as an int", in: float64(80), wantRender: "80", wantType: cty.Number},
		{name: "negative whole float", in: float64(-7), wantRender: "-7", wantType: cty.Number},
		{name: "fractional float", in: 1.5, wantRender: "1.5", wantType: cty.Number},
		{name: "empty list", in: []any{}, wantRender: "[]", wantType: cty.EmptyTuple},
		{name: "empty object", in: map[string]any{}, wantRender: "{}", wantType: cty.EmptyObject},
	}
	for _, tc := range ok {
		t.Run(tc.name, func(t *testing.T) {
			got, err := jsonToCty(tc.in)
			if err != nil {
				t.Fatalf("jsonToCty(%#v): %v", tc.in, err)
			}
			if !got.Type().Equals(tc.wantType) {
				t.Errorf("type = %s, want %s", got.Type().GoString(), tc.wantType.GoString())
			}
			if render := string(hclwrite.TokensForValue(got).Bytes()); render != tc.wantRender {
				t.Errorf("rendered %q, want %q", render, tc.wantRender)
			}
		})
	}

	t.Run("nested list and object recurse", func(t *testing.T) {
		got, err := jsonToCty([]any{"a", float64(2), true, map[string]any{"k": "v"}})
		if err != nil {
			t.Fatalf("jsonToCty: %v", err)
		}
		want := cty.TupleVal([]cty.Value{
			cty.StringVal("a"), cty.NumberIntVal(2), cty.True,
			cty.ObjectVal(map[string]cty.Value{"k": cty.StringVal("v")}),
		})
		if !got.RawEquals(want) {
			t.Fatalf("jsonToCty = %#v, want %#v", got, want)
		}
	})

	bad := []struct {
		name string
		in   any
	}{
		{name: "unsupported scalar type", in: 42},
		{name: "unsupported type nested in a list", in: []any{"ok", 42}},
		{name: "unsupported type nested in an object", in: map[string]any{"k": []any{int8(1)}}},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			got, err := jsonToCty(tc.in)
			if err == nil {
				t.Fatalf("jsonToCty(%#v) = %#v, want an error", tc.in, got)
			}
			if !strings.Contains(err.Error(), "unsupported liveJson value type") {
				t.Errorf("err = %v, want it to name the unsupported value type", err)
			}
			if got != cty.NilVal {
				t.Errorf("value = %#v, want cty.NilVal alongside the error", got)
			}
		})
	}
}

// TestCovadoptSetAtSegmentsFailsClosed pins setAtSegments' belt-and-braces
// refusals — the arms reachable only when a caller skipped
// ExpressibleSegments' own gate. Every one must return a refusal CODE (so the
// caller routes it to ungenerable) rather than guessing at a write.
func TestCovadoptSetAtSegmentsFailsClosed(t *testing.T) {
	const src = `resource "aws_instance" "x" {
  ami  = "ami-0123456789abcdef0"
  tags = { Owner = "platform" }

  root_block_device {
    volume_size = 80
  }
}
`
	cases := []struct {
		name     string
		segs     []any
		val      any
		wantCode string
		wantIn   string
	}{
		{name: "no segments at all", segs: nil, val: "x", wantCode: "UNSUPPORTED_PATH", wantIn: "not expressible"},
		{name: "four segments", segs: []any{"a", "b", "c", "d"}, val: "x", wantCode: "UNSUPPORTED_PATH", wantIn: "not expressible"},
		{name: "non-zero nested-block index", segs: []any{"root_block_device", 1, "volume_size"}, val: float64(100),
			wantCode: "UNSUPPORTED_PATH", wantIn: "index 1 is not 0"},
		{name: "unconvertible value on a scalar path", segs: []any{"instance_type"}, val: 42,
			wantCode: "VALUE_SHAPE", wantIn: "unsupported liveJson value type int"},
		{name: "unconvertible value on a map path", segs: []any{"tags", "Owner"}, val: 42,
			wantCode: "VALUE_SHAPE", wantIn: "unsupported liveJson value type int"},
		{name: "unconvertible value on a nested-block path", segs: []any{"root_block_device", 0, "volume_size"}, val: 42,
			wantCode: "VALUE_SHAPE", wantIn: "unsupported liveJson value type int"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block := covadoptBlock(t, src)
			before := string(hclwrite.Format(block.BuildTokens(nil).Bytes()))

			code, reason := setAtSegments(block, tc.segs, tc.val)
			if code != tc.wantCode {
				t.Fatalf("code = %q (reason=%q), want %q", code, reason, tc.wantCode)
			}
			if !strings.Contains(reason, tc.wantIn) {
				t.Errorf("reason = %q, want it to contain %q", reason, tc.wantIn)
			}
			if after := string(hclwrite.Format(block.BuildTokens(nil).Bytes())); after != before {
				t.Fatalf("a refusal still mutated the block:\n--- before ---\n%s\n--- after ---\n%s", before, after)
			}
		})
	}
}

// TestCovadoptSetNestedSingleBlockAmbiguity pins the remaining
// setNestedSingleBlock arm as a direct unit: two instances of the nested block
// type make the plan-index -> config-block mapping unsafe (register 0009 L28)
// and are refused with BLOCK_AMBIGUOUS, never guessed.
func TestCovadoptSetNestedSingleBlockAmbiguity(t *testing.T) {
	block := covadoptBlock(t, `resource "aws_security_group" "x" {
  name = "x"

  ingress {
    from_port = 80
  }
  ingress {
    from_port = 443
  }
}
`)
	code, reason := setNestedSingleBlock(block, "ingress", "from_port", float64(8080))
	if code != "BLOCK_AMBIGUOUS" {
		t.Fatalf("code = %q (reason=%q), want BLOCK_AMBIGUOUS", code, reason)
	}
	if !containsAll(reason, "2", "ingress", "L28") {
		t.Fatalf("reason = %q, want it to count the blocks and cite register 0009 L28", reason)
	}
}

// TestCovadoptParseObjectLiteral pins the token walker's accept/reject contract
// directly: a literal object is split into ordered entries (comments and nested
// constructor depth included), and anything that is NOT a literal object — a
// reference, a for-expression, a truncated token stream — is rejected so the
// caller refuses instead of blindly overwriting it.
func TestCovadoptParseObjectLiteral(t *testing.T) {
	t.Run("real expressions", func(t *testing.T) {
		cases := []struct {
			name     string
			expr     string
			wantOK   bool
			wantKeys []string
		}{
			{name: "single-line literal", expr: `{ Owner = "platform" }`, wantOK: true, wantKeys: []string{"Owner"}},
			{
				name:     "multi-line literal with comments and nested constructors",
				expr:     "{\n  Owner      = \"platform\" # who owns it\n  Inline     = /* mid */ \"x\"\n  Nested     = { a = \"1\" }\n  List       = [\"a\", \"b\"]\n  CostCenter = \"cc-42\"\n}",
				wantOK:   true,
				wantKeys: []string{"Owner", "Inline", "Nested", "List", "CostCenter"},
			},
			{name: "quoted keys keep their literal bytes", expr: `{ "kubernetes.io/role/elb" = "shared" }`, wantOK: true,
				wantKeys: []string{"kubernetes.io/role/elb"}},
			{name: "empty object", expr: `{}`, wantOK: true},
			{name: "reference is not a literal object", expr: `local.common_tags`, wantOK: false},
			{name: "function call is not a literal object", expr: `merge(local.a, local.b)`, wantOK: false},
			{name: "for-expression is not a literal object", expr: `{ for k, v in local.m : k => v }`, wantOK: false},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				entries, ok := parseObjectLiteral(covadoptExprTokens(t, tc.expr))
				if ok != tc.wantOK {
					t.Fatalf("ok = %v, want %v (entries=%d)", ok, tc.wantOK, len(entries))
				}
				if !tc.wantOK {
					if entries != nil {
						t.Errorf("entries = %+v, want nil on a rejected expression", entries)
					}
					return
				}
				var keys []string
				for _, e := range entries {
					keys = append(keys, e.key)
				}
				if strings.Join(keys, ",") != strings.Join(tc.wantKeys, ",") {
					t.Fatalf("keys = %v, want %v", keys, tc.wantKeys)
				}
			})
		}
	})

	// Token streams hclwrite itself never produces from a balanced expression,
	// but which the walker must still handle without panicking or guessing.
	t.Run("hand-built token streams", func(t *testing.T) {
		cases := []struct {
			name     string
			toks     hclwrite.Tokens
			wantOK   bool
			wantKeys []string
		}{
			{
				name: "leading comment and newline before the brace are skipped",
				toks: hclwrite.Tokens{
					covadoptTok(hclsyntax.TokenComment, "# leading\n"),
					covadoptTok(hclsyntax.TokenNewline, "\n"),
					covadoptTok(hclsyntax.TokenOBrace, "{"),
					covadoptTok(hclsyntax.TokenNewline, "\n"),
					covadoptTok(hclsyntax.TokenIdent, "Owner"),
					covadoptTok(hclsyntax.TokenEqual, "="),
					covadoptTok(hclsyntax.TokenOQuote, `"`),
					covadoptTok(hclsyntax.TokenQuotedLit, "platform"),
					covadoptTok(hclsyntax.TokenCQuote, `"`),
					covadoptTok(hclsyntax.TokenNewline, "\n"),
					covadoptTok(hclsyntax.TokenCBrace, "}"),
				},
				wantOK:   true,
				wantKeys: []string{"Owner"},
			},
			{
				name: "stream that ends mid-key",
				toks: hclwrite.Tokens{
					covadoptTok(hclsyntax.TokenOBrace, "{"),
					covadoptTok(hclsyntax.TokenIdent, "Owner"),
				},
				wantOK: false,
			},
			{
				name: "stream that never closes the brace",
				toks: hclwrite.Tokens{
					covadoptTok(hclsyntax.TokenOBrace, "{"),
					covadoptTok(hclsyntax.TokenIdent, "Owner"),
					covadoptTok(hclsyntax.TokenEqual, "="),
					covadoptTok(hclsyntax.TokenOQuote, `"`),
					covadoptTok(hclsyntax.TokenQuotedLit, "platform"),
					covadoptTok(hclsyntax.TokenCQuote, `"`),
				},
				wantOK: false,
			},
			{
				name:   "empty stream",
				toks:   hclwrite.Tokens{},
				wantOK: false,
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				entries, ok := parseObjectLiteral(tc.toks)
				if ok != tc.wantOK {
					t.Fatalf("ok = %v, want %v (entries=%+v)", ok, tc.wantOK, entries)
				}
				var keys []string
				for _, e := range entries {
					keys = append(keys, e.key)
				}
				if strings.Join(keys, ",") != strings.Join(tc.wantKeys, ",") {
					t.Fatalf("keys = %v, want %v", keys, tc.wantKeys)
				}
			})
		}
	})
}

// TestCovadoptKeyTokensFor pins the two spellings a NEW map key can take: a bare
// identifier when it looks like one, otherwise a fully-escaped string literal
// via TokensForValue — never raw bytes, which would let a crafted key break out
// of the map at format time.
func TestCovadoptKeyTokensFor(t *testing.T) {
	cases := []struct {
		name, key, want string
	}{
		{name: "bare identifier", key: "Owner", want: "Owner"},
		{name: "identifier with a dash and digits", key: "cost-center-2", want: "cost-center-2"},
		{name: "dotted and slashed key is quoted", key: "kubernetes.io/role/elb", want: `"kubernetes.io/role/elb"`},
		{name: "key with a space is quoted", key: "cost center", want: `"cost center"`},
		{name: "quote in the key is escaped", key: `a"b`, want: `"a\"b"`},
		{name: "brace in the key is escaped, never raw", key: `x}${y`, want: `"x}$${y"`},
		{name: "empty key is quoted", key: "", want: `""`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(keyTokensFor(tc.key).Bytes()); got != tc.want {
				t.Fatalf("keyTokensFor(%q) = %q, want %q", tc.key, got, tc.want)
			}
		})
	}
}

// TestCovadoptMergeSingleKeyPreservesUnrelatedBytes is the whole point of the
// literal-object token surgery, asserted on the bytes ApplyAdopt lands: editing
// ONE key of a commented, nested-value map leaves every other key, comment and
// value intact — a whole-map re-render through cty would reformat and silently
// drop them.
func TestCovadoptMergeSingleKeyPreservesUnrelatedBytes(t *testing.T) {
	const tf = `resource "aws_instance" "cmt01" {
  ami = "ami-0123456789abcdef0"

  tags = {
    Owner      = "platform" # who owns it
    Inline     = "keep-me"
    Nested     = { a = "1" }
    List       = ["a", "b"]
    CostCenter = "cc-42"
  }
}
`
	envDir := covadoptEnvDir(t, map[string]string{"main.tf": tf})
	v := covadoptAdoptVerdict("aws_instance.cmt01",
		covadoptAttr("tags.CostCenter", []any{"tags", "CostCenter"}, `"cc-99"`, `"cc-42"`))
	covadoptRequireAdoptBucket(t, v)

	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if reason != "" || p == nil {
		t.Fatalf("GenerateAdopt refused a one-key merge: reason=%q", reason)
	}
	added, removed := covadoptAddedLines(*p.Diff), covadoptRemovedLines(*p.Diff)
	if len(added) != 1 || !strings.Contains(added[0], "cc-99") {
		t.Fatalf("added lines = %q, want exactly the cc-99 line:\n%s", added, *p.Diff)
	}
	if len(removed) != 1 || !strings.Contains(removed[0], "cc-42") {
		t.Fatalf("removed lines = %q, want exactly the cc-42 line:\n%s", removed, *p.Diff)
	}

	if _, _, err := ApplyAdopt(v, envDir); err != nil {
		t.Fatalf("ApplyAdopt: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# who owns it", "keep-me", `Nested`, `"1"`, `["a", "b"]`, `Owner`, "platform", "cc-99"} {
		if !strings.Contains(string(got), want) {
			t.Errorf("one-key merge lost %q:\n%s", want, got)
		}
	}
	if strings.Contains(string(got), "cc-42") {
		t.Errorf("the edited key kept its old value:\n%s", got)
	}
	// The result must still parse — a comment re-emitted in the wrong place
	// would silently swallow the following entry.
	if _, diags := hclwrite.ParseConfig(got, "main.tf", hcl.Pos{Line: 1, Column: 1}); diags.HasErrors() {
		t.Fatalf("merged file no longer parses: %s\n%s", diags.Error(), got)
	}
}

// TestCovadoptRemoveSingleKeyRemovesOnlyThatKey is removeSingleKey's mirror of
// the test above: adopting a live null on a 2-segment map path removes exactly
// that key, keeping every sibling key AND its trailing comment.
func TestCovadoptRemoveSingleKeyRemovesOnlyThatKey(t *testing.T) {
	const tf = `resource "aws_instance" "cmt02" {
  ami = "ami-0123456789abcdef0"

  tags = {
    Owner      = "platform" # who owns it
    CostCenter = "cc-42"
    Env        = "prod"
  }
}
`
	envDir := covadoptEnvDir(t, map[string]string{"main.tf": tf})
	v := covadoptAdoptVerdict("aws_instance.cmt02",
		covadoptAttr("tags.CostCenter", []any{"tags", "CostCenter"}, `null`, `"cc-42"`))
	covadoptRequireAdoptBucket(t, v)

	wrote, reason, err := ApplyAdopt(v, envDir)
	if err != nil {
		t.Fatalf("ApplyAdopt: %v", err)
	}
	if reason != "" || !wrote {
		t.Fatalf("ApplyAdopt = (wrote=%v, reason=%q), want a real write", wrote, reason)
	}
	got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "CostCenter") || strings.Contains(string(got), "cc-42") {
		t.Errorf("CostCenter survived the removal:\n%s", got)
	}
	if strings.Contains(string(got), "null") {
		t.Errorf("removal wrote a literal null instead of dropping the key:\n%s", got)
	}
	for _, want := range []string{"# who owns it", `"platform"`, `"prod"`} {
		if !strings.Contains(string(got), want) {
			t.Errorf("removal disturbed %q:\n%s", want, got)
		}
	}
}

// --- generate.go: per-lane ungenerable/error routing ------------------------

// TestCovadoptGenerateLaneUngenerableRows pins the shape generate.go gives a
// per-verdict, checkout-dependent refusal in EVERY lane: an ungenerable row
// carrying the verdict's own address and class plus the emitter's reason — never
// an error, never a dropped verdict. One envelope drives all three lanes at
// once, so the sorted-by-address document contract is exercised too.
func TestCovadoptGenerateLaneUngenerableRows(t *testing.T) {
	repo := covadoptRepo(t, covadoptWatchlistJSON, map[string]string{
		"main.tf": "resource \"aws_instance\" \"present01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
	})

	adopt := covadoptAdoptVerdict("aws_instance.absent_adopt",
		covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `"bi-team"`, `"platform"`))
	revert := Verdict{
		Address: "aws_security_group.absent_revert", Type: "aws_security_group",
		Class: "security_posture", RiskTier: "high", DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{covadoptAttr("ingress[0].cidr_blocks", nil, `["0.0.0.0/0"]`, `["10.0.0.0/16"]`)},
	}
	restore := Verdict{
		Address: "aws_flow_log.absent_restore", Type: "aws_flow_log",
		Class: "oob_deletion", RiskTier: "high", DriftEvidence: true, Actions: []string{"create"},
	}
	for _, tc := range []struct {
		v    Verdict
		want Bucket
	}{{adopt, BucketAdopt}, {revert, BucketRevert}, {restore, BucketRestore}} {
		if bucket, reason := ClassifyByFields(tc.v); bucket != tc.want {
			t.Fatalf("precondition: %s classified %q (%s), want %q", tc.v.Address, bucket, reason, tc.want)
		}
	}

	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
		Report: Report{Verdicts: []Verdict{restore, adopt, revert}}}

	doc, err := GenerateOpts(env, repo, "environments/prod", GenOptions{EnableRestore: true})
	if err != nil {
		t.Fatalf("GenerateOpts: %v", err)
	}
	if len(doc.Proposals) != 0 {
		t.Fatalf("proposals = %+v, want none — every address is absent from the checkout", doc.Proposals)
	}
	if len(doc.Ungenerable) != 3 {
		t.Fatalf("ungenerable = %d, want 3: %+v", len(doc.Ungenerable), doc.Ungenerable)
	}
	byAddr := map[string]Ungenerable{}
	for _, u := range doc.Ungenerable {
		byAddr[u.Address] = u
	}
	wants := []struct {
		address, class string
		reasonHas      []string
	}{
		{"aws_instance.absent_adopt", "benign_inplace", []string{"aws_instance.absent_adopt", "not found in checkout"}},
		{"aws_security_group.absent_revert", "security_posture", []string{"aws_security_group.absent_revert", "not found in checkout"}},
		{"aws_flow_log.absent_restore", "oob_deletion", []string{"aws_flow_log.absent_restore", "nothing to re-assert"}},
	}
	for _, w := range wants {
		u, ok := byAddr[w.address]
		if !ok {
			t.Fatalf("no ungenerable row for %s: %+v", w.address, doc.Ungenerable)
		}
		if u.Class != w.class {
			t.Errorf("%s class = %q, want %q", w.address, u.Class, w.class)
		}
		if !containsAll(u.Reason, w.reasonHas...) {
			t.Errorf("%s reason = %q, want it to name %v", w.address, u.Reason, w.reasonHas)
		}
	}
	for i := 1; i < len(doc.Ungenerable); i++ {
		if doc.Ungenerable[i-1].Address >= doc.Ungenerable[i].Address {
			t.Errorf("ungenerable not sorted by address: %s >= %s", doc.Ungenerable[i-1].Address, doc.Ungenerable[i].Address)
		}
	}
}

// TestCovadoptGenerateSurfacesCheckoutParseError pins the other half of the same
// routing: an unparseable checkout is NOT a per-verdict fact, so every lane
// aborts the whole document with an error (exit 1 at the command seam) rather
// than recording a misleading "this verdict is ungenerable" row.
func TestCovadoptGenerateSurfacesCheckoutParseError(t *testing.T) {
	cases := []struct {
		name string
		v    Verdict
		opts GenOptions
	}{
		{
			name: "adopt lane",
			v: covadoptAdoptVerdict("aws_instance.sample01",
				covadoptAttr("tags.Owner", []any{"tags", "Owner"}, `"bi-team"`, `"platform"`)),
		},
		{
			name: "revert lane",
			v: Verdict{Address: "aws_security_group.sg1", Type: "aws_security_group", Class: "security_posture",
				RiskTier: "high", DriftEvidence: true, Actions: []string{"update"}},
		},
		{
			name: "restore lane",
			v: Verdict{Address: "aws_flow_log.vpc1", Type: "aws_flow_log", Class: "oob_deletion",
				RiskTier: "high", DriftEvidence: true, Actions: []string{"create"}},
			opts: GenOptions{EnableRestore: true},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := covadoptRepo(t, covadoptWatchlistJSON, map[string]string{"main.tf": covadoptBrokenTF})
			env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
				Report: Report{Verdicts: []Verdict{tc.v}}}

			doc, err := GenerateOpts(env, repo, "environments/prod", tc.opts)
			if err == nil {
				t.Fatalf("GenerateOpts swallowed an unparseable checkout: %+v", doc)
			}
			if doc != nil {
				t.Errorf("doc = %+v, want nil alongside the error", doc)
			}
			if !strings.Contains(err.Error(), "parse") {
				t.Errorf("err = %v, want it to name the parse failure", err)
			}
		})
	}
}

// TestCovadoptGenerateImportLaneUngenerableRows pins the import lane's own
// three ungenerable routes (spec §5.2/§5.3), each keyed by findingKey since a
// finding has no Terraform address: a finding the field partition refuses, a
// payload the prescan refuses, and an address that already resolves in the
// checkout. All three are rows in the document, never errors.
func TestCovadoptGenerateImportLaneUngenerableRows(t *testing.T) {
	arnUnmapped := "arn:aws:sqs:us-east-1:123456789012:unmapped-queue"
	unmapped := Finding{Class: findingClass, Arn: &arnUnmapped, TfType: "", LiveID: "unmapped-queue"}

	provisioner := cleanImportFinding()
	provisioner.LiveID = "i-0dirty00000000000"
	provisioner.ImportPayload = &FindingImportPayload{
		Address:     "aws_instance.oob_dirty01",
		TargetFile:  oobAdoptedFile,
		ImportBlock: "import {\n  to = aws_instance.oob_dirty01\n  id = \"i-0dirty00000000000\"\n}\n",
		SkeletonHcl: "resource \"aws_instance\" \"oob_dirty01\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  provisioner \"local-exec\" {\n    command = \"echo pwned\"\n  }\n}\n",
	}

	collides := cleanImportFinding()
	collides.LiveID = "i-0collide0000000000"
	collides.ImportPayload = &FindingImportPayload{
		Address:     "aws_instance.present01",
		TargetFile:  oobAdoptedFile,
		ImportBlock: "import {\n  to = aws_instance.present01\n  id = \"i-0collide0000000000\"\n}\n",
		SkeletonHcl: "resource \"aws_instance\" \"present01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
	}

	cases := []struct {
		name      string
		finding   Finding
		wantKey   string
		reasonHas []string
	}{
		{
			name: "field partition refuses the finding", finding: unmapped, wantKey: arnUnmapped,
			reasonHas: []string{"tfType is absent", "services.json"},
		},
		{
			name: "payload prescan refuses the reviewed bytes", finding: provisioner,
			wantKey: "aws_instance/i-0dirty00000000000", reasonHas: []string{"PROVISIONER", "prescan"},
		},
		{
			name: "address already resolves in the checkout", finding: collides,
			wantKey: "aws_instance/i-0collide0000000000", reasonHas: []string{"aws_instance.present01", "already managed"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := covadoptRepo(t, covadoptWatchlistJSON, map[string]string{
				"main.tf": "resource \"aws_instance\" \"present01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
			})
			env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
				Sweep: &Sweep{Findings: []Finding{tc.finding}}}

			doc, err := GenerateOpts(env, repo, "environments/prod", GenOptions{EnableImport: true})
			if err != nil {
				t.Fatalf("GenerateOpts: %v", err)
			}
			if len(doc.Proposals) != 0 {
				t.Fatalf("proposals = %+v, want none", doc.Proposals)
			}
			if len(doc.Ungenerable) != 1 {
				t.Fatalf("ungenerable = %d, want 1: %+v", len(doc.Ungenerable), doc.Ungenerable)
			}
			u := doc.Ungenerable[0]
			if u.Address != tc.wantKey {
				t.Errorf("ungenerable address = %q, want the finding key %q", u.Address, tc.wantKey)
			}
			if u.Class != tc.finding.Class {
				t.Errorf("ungenerable class = %q, want %q", u.Class, tc.finding.Class)
			}
			if !containsAll(u.Reason, tc.reasonHas...) {
				t.Errorf("reason = %q, want it to name %v", u.Reason, tc.reasonHas)
			}
		})
	}
}

// The merge promises to preserve every byte except the one changed entry's
// value (the one-line-diff guarantee). A comment sitting INSIDE an untouched
// entry's value used to be hoisted out and re-emitted after the value, so
// `Inline = /* mid */ "keep-me"` became `Inline = "keep-me" /* mid */` — a
// second added/removed line pair for a key the merge never touched.
func TestCovadoptMergeKeepsAnInteriorCommentInPlace(t *testing.T) {
	const src = `resource "aws_instance" "web" {
  tags = {
    CostCenter = "old"
    Inline     = /* mid */ "keep-me"
    Trailing   = "v" # trailing note
  }
}
`
	block := covadoptBlock(t, src)
	code, reason := mergeSingleKey(block, "tags", "CostCenter", cty.StringVal("new"))
	if code != "" {
		t.Fatalf("mergeSingleKey refused: %s %s", code, reason)
	}
	got := string(hclwrite.Format(block.BuildTokens(nil).Bytes()))

	if !strings.Contains(got, `CostCenter = "new"`) {
		t.Fatalf("the edited key was not written:\n%s", got)
	}
	// The untouched entry must come back byte-identical in ORDER: comment
	// before the value, not after it.
	if !strings.Contains(got, `/* mid */ "keep-me"`) {
		t.Errorf("interior comment was relocated — untouched entry rewritten:\n%s", got)
	}
	if strings.Contains(got, `"keep-me" /* mid */`) {
		t.Errorf("interior comment moved after the value:\n%s", got)
	}
	// A genuine TRAILING comment still rides after its value, as before.
	if !strings.Contains(got, `"v" # trailing note`) {
		t.Errorf("trailing comment was not preserved:\n%s", got)
	}
	// And the old value is gone.
	if strings.Contains(got, `"old"`) {
		t.Errorf("the replaced value survived:\n%s", got)
	}
}
