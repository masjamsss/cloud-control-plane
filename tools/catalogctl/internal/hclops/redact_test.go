package hclops

import (
	"os"
	"strings"
	"testing"
)

// fakeToken is the UUID-shaped stand-in from ccp/app/src/test/redact.test.ts —
// syntactically identical to environments/prod/lambda.tf:141 but never the real value.
const fakeToken = "deadbeef-0000-4000-8000-000000000000"

// lambdaBlock mirrors the SPA fixture (a lambda whose environment/variables block
// carries an inline API token). Ported verbatim so Go and the SPA are provably the
// same guard over the same shape.
const lambdaBlock = `resource "aws_lambda_function" "asset_sdp_handler" {
  function_name = "asset-sdp-handler"
  runtime       = "python3.12"
  role          = "arn:aws:iam::123456789012:role/asset-sdp"
  environment {
    variables = {
      API_TOKEN = "deadbeef-0000-4000-8000-000000000000"
      LOG_LEVEL = "INFO"
      REGION    = "ap-southeast-5"
    }
  }
  tags = {
    Name = "asset-sdp-handler"
  }
}
`

func TestRedactMasksTokenInLambdaEnvBlock(t *testing.T) {
	out := string(Redact([]byte(lambdaBlock)))
	if strings.Contains(out, fakeToken) {
		t.Fatalf("SECRET LEAK: token present after redaction:\n%s", out)
	}
	// Stable tag = FNV-1a/32 of the inner value; must equal the SPA's stableTag so
	// display and archive mask to the identical pointer (verified: 36e04505).
	if !strings.Contains(out, `API_TOKEN = "«redacted:36e04505»"`) {
		t.Fatalf("API_TOKEN not masked to the stable SPA tag:\n%s", out)
	}
	// A value INSIDE the secret-bearing block is masked even with a benign name.
	if !strings.Contains(out, `LOG_LEVEL = "«redacted:`) {
		t.Fatalf("LOG_LEVEL inside the environment/variables block should be masked:\n%s", out)
	}
	// Ordinary config OUTSIDE any secret scope is untouched (no over-blinding).
	if !strings.Contains(out, `runtime       = "python3.12"`) {
		t.Fatalf("benign runtime should be untouched:\n%s", out)
	}
	if !strings.Contains(out, `function_name = "asset-sdp-handler"`) {
		t.Fatalf("benign function_name should be untouched:\n%s", out)
	}
}

func TestRedactMasksSecretNamedAttrs(t *testing.T) {
	out := string(Redact([]byte("  password = \"hunter2000abc\"\n  db_secret = \"s3cr3t-value-9999\"\n")))
	if strings.Contains(out, "hunter2000abc") || strings.Contains(out, "s3cr3t-value-9999") {
		t.Fatalf("secret-named attribute value leaked:\n%s", out)
	}
}

func TestRedactMasksBareHighEntropyValue(t *testing.T) {
	// Renamed from `some_id` (0039 S1 Lane D): that name now hits the deliberate
	// *_id/*_ids GUID-identifier exception below — this case is about a
	// non-`_id`-named attribute, so it must not collide with it.
	out := string(Redact([]byte("  plain_field = \"deadbeef-0000-4000-8000-000000000000\"\n")))
	if strings.Contains(out, fakeToken) {
		t.Fatalf("bare UUID on an ordinary attribute leaked:\n%s", out)
	}
}

// TestRedactAllowsIdAttrGuidEndToEnd proves the *_id GUID-identifier exception
// reaches the full RedactWith walk, not just the looksLikeSecret unit (attrName is
// threaded through maskRhs from the assignRe match in RedactWith). Mirrors the TS
// redact.test.ts "renders an *_id attribute carrying a bare GUID unmasked
// end-to-end" case.
func TestRedactAllowsIdAttrGuidEndToEnd(t *testing.T) {
	guid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	out := string(Redact([]byte(`  subscription_id = "` + guid + `"` + "\n")))
	if !strings.Contains(out, guid) {
		t.Fatalf("subscription_id GUID should be left visible as an identifier:\n%s", out)
	}
}

// TestRedactStillMasksClientSecretGuidEndToEnd: the name rule fires before the
// shape rule, end to end — client_secret masks regardless of value shape, even a
// bare GUID that would otherwise qualify for the *_id exception. Mirrors the TS
// "still masks a client_secret end-to-end even if its value happens to be a bare
// GUID" case.
func TestRedactStillMasksClientSecretGuidEndToEnd(t *testing.T) {
	guid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	out := string(Redact([]byte(`  client_secret = "` + guid + `"` + "\n")))
	if strings.Contains(out, guid) {
		t.Fatalf("client_secret must mask regardless of value shape:\n%s", out)
	}
}

func TestRedactLeavesBenignAwsIds(t *testing.T) {
	in := strings.Join([]string{
		`  ami           = "ami-0abc1234def567890"`,
		`  subnet_id     = "subnet-0123456789abcdef0"`,
		`  role          = "arn:aws:iam::123456789012:role/asset-sdp"`,
		`  instance_type = "r6i.xlarge"`,
	}, "\n")
	out := string(Redact([]byte(in)))
	for _, keep := range []string{
		"ami-0abc1234def567890", "subnet-0123456789abcdef0",
		"arn:aws:iam::123456789012:role/asset-sdp", "r6i.xlarge",
	} {
		if !strings.Contains(out, keep) {
			t.Fatalf("benign id %q was wrongly masked:\n%s", keep, out)
		}
	}
}

// TestRedactSensitiveAttrsOption pins the extra-attrs hint (e.g. provider-schema
// sensitive:true). "widget" is not a secret name and "plainlookingword" is not
// high-entropy, so it survives WITHOUT the hint and is masked WITH it.
func TestRedactSensitiveAttrsOption(t *testing.T) {
	line := `  widget = "plainlookingword"`
	if out := string(Redact([]byte(line))); !strings.Contains(out, "plainlookingword") {
		t.Fatalf("plain value wrongly masked with no hint:\n%s", out)
	}
	if out := string(Redact([]byte(line), "widget")); strings.Contains(out, "plainlookingword") {
		t.Fatalf("sensitiveAttrs hint was not honored:\n%s", out)
	}
}

// TestRedactNeverMaskAttrs pins the const-guardrail carve-out (0034 papercut #1
// sub-item): http_tokens trips the "token" secret-substring rule and masks by
// default, but a role:"const"/"key" guardrail the reviewer must SEE is exempted via
// NeverMaskAttrs — while an attr also flagged sensitive still masks (sensitive wins).
func TestRedactNeverMaskAttrs(t *testing.T) {
	line := `  http_tokens = "required"`
	if out := string(Redact([]byte(line))); !strings.Contains(out, "«redacted:") {
		t.Fatalf("http_tokens should mask by default (name contains \"token\"):\n%s", out)
	}
	out := string(RedactWith([]byte(line), RedactOptions{NeverMaskAttrs: []string{"http_tokens"}}))
	if !strings.Contains(out, `http_tokens = "required"`) {
		t.Fatalf("const guardrail http_tokens should be visible with NeverMaskAttrs:\n%s", out)
	}
	// Sensitive wins: an attr named in BOTH lists stays masked.
	both := string(RedactWith([]byte(line), RedactOptions{
		SensitiveAttrs: []string{"http_tokens"},
		NeverMaskAttrs: []string{"http_tokens"},
	}))
	if strings.Contains(both, "required") {
		t.Fatalf("sensitive must win over never-mask:\n%s", both)
	}
	// Value-shape still applies under NeverMaskAttrs — a guardrail whose VALUE is
	// itself high-entropy is masked regardless of the name exemption.
	tokenVal := `  creation_token = "AKIA1234567890ABCDEFghij"`
	if got := string(RedactWith([]byte(tokenVal), RedactOptions{NeverMaskAttrs: []string{"creation_token"}})); strings.Contains(got, "AKIA1234567890ABCDEFghij") {
		t.Fatalf("a high-entropy value must still mask even under NeverMaskAttrs:\n%s", got)
	}
}

func TestLooksLikeSecret(t *testing.T) {
	secret := []string{
		"12345678-1234-5678-1234-567812345678",
		"AKIA1234567890ABCDEFghij",
		"c29tZWxvbmdiYXNlNjR0b2tlbjEyMzQ1Njc4OQ==",
	}
	for _, s := range secret {
		if !looksLikeSecret(s, "") {
			t.Errorf("looksLikeSecret(%q, \"\") = false, want true", s)
		}
	}
	benign := []string{
		"r6i.xlarge", "ap-southeast-5", "ami-0abc1234def567890", "production",
		// 0034 papercut #1 — dash-joined structured ids: longest unbroken run is
		// short, so the tightened heuristic (and its SPA twin) leaves them visible.
		"ELBSecurityPolicy-TLS13-1-2-2021-06",
		"ELBSecurityPolicy-FS-1-2-Res-2020-10",
		"pre-release-app-db01-20260715",
	}
	for _, s := range benign {
		if looksLikeSecret(s, "") {
			t.Errorf("looksLikeSecret(%q, \"\") = true, want false", s)
		}
	}
}

// TestLooksLikeSecretAttrNameIdentifierException mirrors the four D1 cases in
// ccp/app/src/test/redact.test.ts's `looksLikeSecret` describe block (0039 S1
// Lane D). The exception is narrow: value is a bare UUID AND the attribute name
// ends `_id`/`_ids` AND the name rule (secretTerms) has not already fired.
// Nothing else relaxes.
func TestLooksLikeSecretAttrNameIdentifierException(t *testing.T) {
	const guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	cases := []struct {
		name     string
		value    string
		attrName string
		want     bool
	}{
		// treats a bare GUID in an *_id attribute as an identifier, not a secret
		{"subscription_id", guid, "subscription_id", false},
		{"tenant_id", guid, "tenant_id", false},
		// still masks GUIDs everywhere else
		{"no attr name known", guid, "", true},
		{"ordinary attr name", guid, "value", true},
	}
	for _, c := range cases {
		if got := looksLikeSecret(c.value, c.attrName); got != c.want {
			t.Errorf("%s: looksLikeSecret(%q, %q) = %v, want %v", c.name, c.value, c.attrName, got, c.want)
		}
	}
}

// TestIsSecretNameNeverRelaxedByIdentifierException: the name rule fires before
// the shape rule — client_secret masks regardless of value shape (mirrors the TS
// isSecretAttrName('client_secret') case; isSecretName is this package's
// unexported twin, exercised directly since this test file shares its package).
func TestIsSecretNameNeverRelaxedByIdentifierException(t *testing.T) {
	if !isSecretName("client_secret", nil) {
		t.Errorf("isSecretName(%q, nil) = false, want true", "client_secret")
	}
}

// TestLooksLikeSecretAllowlistsArmResourcePaths mirrors the TS "allowlists ARM
// resource paths" case.
func TestLooksLikeSecretAllowlistsArmResourcePaths(t *testing.T) {
	v := "/subscriptions/aaaa/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x"
	if looksLikeSecret(v, "") {
		t.Errorf("looksLikeSecret(%q, \"\") = true, want false", v)
	}
}

// TestRedactIdempotent: an already-masked value is left alone, so redacting twice is
// a fixed point (matches the SPA's idempotence contract).
func TestRedactIdempotent(t *testing.T) {
	once := Redact([]byte(lambdaBlock))
	twice := Redact(once)
	if string(once) != string(twice) {
		t.Fatalf("Redact not idempotent:\n--- once ---\n%s\n--- twice ---\n%s", once, twice)
	}
}

// TestRedactedUnifiedDiffNeverLeaksToken is the leak-proof golden: a token sitting as
// unchanged CONTEXT next to an edit is exactly how environments/prod/lambda.tf:141
// leaked into the evidence archive. Redacting both sides before the diff guarantees
// the cleartext can never reach an emitted diff line, while the benign edit stays
// visible so a reviewer is not blinded.
func TestRedactedUnifiedDiffNeverLeaksToken(t *testing.T) {
	before := lambdaBlock
	// A benign edit ADJACENT to the token line (LOG_LEVEL, one line below API_TOKEN)
	// so the token line is pulled into the 3-line context window.
	after := strings.Replace(before, `LOG_LEVEL = "INFO"`, `LOG_LEVEL = "DEBUG"`, 1)

	diff := UnifiedDiff("environments/prod/lambda.tf", "environments/prod/lambda.tf",
		Redact([]byte(before)), Redact([]byte(after)))
	ds := string(diff)
	if ds == "" {
		t.Fatalf("expected a non-empty diff")
	}
	if strings.Contains(ds, fakeToken) {
		t.Fatalf("SECRET LEAK: token reached the diff artifact:\n%s", ds)
	}
	if !strings.Contains(ds, "«redacted:36e04505»") {
		t.Fatalf("token context line not masked in the diff:\n%s", ds)
	}
	// The diff still records that a change happened (structure/keys visible), just
	// with the values masked — LOG_LEVEL lives in the mask block so both sides mask.
	if !strings.Contains(ds, "LOG_LEVEL") {
		t.Fatalf("the changed attribute is missing from the diff:\n%s", ds)
	}
}

// TestEmbeddedRedactionRulesInSyncWithCanonical enforces the sync obligation: the
// Go-embedded copy under this package MUST be byte-identical to the canonical
// catalog/redaction-rules.json. Skips when the repo root is not checked out (so the
// package still builds/tests in isolation), fails loudly when the two drift.
func TestEmbeddedRedactionRulesInSyncWithCanonical(t *testing.T) {
	const canonical = "../../../../catalog/redaction-rules.json"
	want, err := os.ReadFile(canonical)
	if err != nil {
		t.Skipf("canonical rules not reachable (%v); embedded-copy sync guard skipped", err)
	}
	if string(want) != string(redactionRulesJSON) {
		t.Fatalf("embedded redaction-rules.json drifted from %s — re-copy the canonical file", canonical)
	}
}
