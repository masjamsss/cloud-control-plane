package prescan

import (
	"os"
	"path/filepath"
	"testing"
)

// providerconfig_test.go is the dedicated, independent-oracle test suite for
// the providerConfig census (providerconfig.go, ADR-0033 Decision 5) — table
// driven, deliberately separate from the golden-fixture suite in
// prescan_test.go so a change here can never accidentally touch the
// verdict/finding-focused goldens (and vice versa). Every case writes a
// throwaway repo to t.TempDir() and asserts directly on the returned
// prescan.Report — no golden bytes involved.

func writeRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestProviderConfig_NothingFound_OmitsTheWholeSection(t *testing.T) {
	dir := writeRepo(t, map[string]string{
		"main.tf": `resource "null_resource" "x" {}` + "\n",
	})
	rep, err := Scan(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if rep.ProviderConfig != nil {
		t.Fatalf("ProviderConfig = %+v, want nil (no provider/required_providers block at all)", rep.ProviderConfig)
	}
}

func TestProviderConfig_StaticLiteralsExtractedWithFileLine(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		check func(t *testing.T, rep Report)
	}{
		{
			name: "aws provider block: region + allowed_account_ids, correct file:line",
			files: map[string]string{
				"main.tf": `provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = ["123456789012", "234567890123"]
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				wantProviders(t, pc, LiteralValue{Value: "aws", File: "main.tf", Line: 1})
				if pc.AWSRegion == nil || *pc.AWSRegion != (LiteralValue{Value: "ap-southeast-1", File: "main.tf", Line: 2}) {
					t.Errorf("AWSRegion = %+v, want {ap-southeast-1 main.tf 2}", pc.AWSRegion)
				}
				want := []LiteralValue{
					{Value: "123456789012", File: "main.tf", Line: 3},
					{Value: "234567890123", File: "main.tf", Line: 3},
				}
				if len(pc.AWSAllowedAccountIDs) != len(want) {
					t.Fatalf("AWSAllowedAccountIDs = %+v, want %+v", pc.AWSAllowedAccountIDs, want)
				}
				for i := range want {
					if pc.AWSAllowedAccountIDs[i] != want[i] {
						t.Errorf("AWSAllowedAccountIDs[%d] = %+v, want %+v", i, pc.AWSAllowedAccountIDs[i], want[i])
					}
				}
			},
		},
		{
			name: "azurerm provider block: location + subscription_id + tenant_id",
			files: map[string]string{
				"main.tf": `provider "azurerm" {
  features {}
  location        = "southeastasia"
  subscription_id = "11111111-2222-3333-4444-555555555555"
  tenant_id       = "66666666-7777-8888-9999-000000000000"
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				wantProviders(t, pc, LiteralValue{Value: "azurerm", File: "main.tf", Line: 1})
				if pc.AzureLocation == nil || *pc.AzureLocation != (LiteralValue{Value: "southeastasia", File: "main.tf", Line: 3}) {
					t.Errorf("AzureLocation = %+v, want {southeastasia main.tf 3}", pc.AzureLocation)
				}
				if pc.AzureSubscriptionID == nil || pc.AzureSubscriptionID.Value != "11111111-2222-3333-4444-555555555555" {
					t.Errorf("AzureSubscriptionID = %+v", pc.AzureSubscriptionID)
				}
				if pc.AzureTenantID == nil || pc.AzureTenantID.Value != "66666666-7777-8888-9999-000000000000" {
					t.Errorf("AzureTenantID = %+v", pc.AzureTenantID)
				}
				// features{} is a nested block alongside flat attributes — JustAttributes
				// must still see region/subscription_id/tenant_id despite it.
			},
		},
		{
			name: "required_providers object form (source + version): provider type derived from source's last segment",
			files: map[string]string{
				"main.tf": `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				wantProviders(t, pc, LiteralValue{Value: "aws", File: "main.tf", Line: 3})
				if pc.AWSRegion != nil {
					t.Errorf("AWSRegion = %+v, want nil (no provider block, only required_providers)", pc.AWSRegion)
				}
			},
		},
		{
			name: "required_providers legacy string-pin form: type derived from the local attribute name",
			files: map[string]string{
				"main.tf": `terraform {
  required_providers {
    azurerm = "~> 3.0"
  }
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				wantProviders(t, pc, LiteralValue{Value: "azurerm", File: "main.tf", Line: 3})
			},
		},
		{
			name: "provider block AND required_providers both name aws: providers deduped, one entry",
			files: map[string]string{
				"main.tf": `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				if len(pc.Providers) != 1 {
					t.Fatalf("Providers = %+v, want exactly 1 deduped entry", pc.Providers)
				}
				if pc.Providers[0].Value != "aws" {
					t.Errorf("Providers[0].Value = %q, want aws", pc.Providers[0].Value)
				}
			},
		},
		{
			name: "an unrecognized provider type (random) is not reported",
			files: map[string]string{
				"main.tf": `provider "random" {}
`,
			},
			check: func(t *testing.T, rep Report) {
				if rep.ProviderConfig != nil {
					t.Fatalf("ProviderConfig = %+v, want nil (only random provider present)", rep.ProviderConfig)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := writeRepo(t, tc.files)
			rep, err := Scan(dir, nil)
			if err != nil {
				t.Fatal(err)
			}
			tc.check(t, rep)
		})
	}
}

func TestProviderConfig_NonStaticValuesAreOmittedNeverGuessed(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		check func(t *testing.T, rep Report)
	}{
		{
			name: "region referencing a variable: omitted, not guessed",
			files: map[string]string{
				"main.tf": `variable "region" { type = string }

provider "aws" {
  region = var.region
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep) // "aws" itself is still a static block label
				if pc.AWSRegion != nil {
					t.Errorf("AWSRegion = %+v, want nil (var.region is not a static literal)", pc.AWSRegion)
				}
			},
		},
		{
			name: "region built from interpolation: omitted",
			files: map[string]string{
				"main.tf": `variable "suffix" { type = string }

provider "aws" {
  region = "us-${var.suffix}"
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				if pc.AWSRegion != nil {
					t.Errorf("AWSRegion = %+v, want nil (interpolated, not a static literal)", pc.AWSRegion)
				}
			},
		},
		{
			name: "allowed_account_ids with one variable element: WHOLE field omitted, never partially evaluated",
			files: map[string]string{
				"main.tf": `variable "extra" { type = string }

provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = ["123456789012", var.extra]
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				if pc.AWSRegion == nil || pc.AWSRegion.Value != "ap-southeast-1" {
					t.Errorf("AWSRegion = %+v, want ap-southeast-1 (independent of the account-ids field)", pc.AWSRegion)
				}
				if pc.AWSAllowedAccountIDs != nil {
					t.Errorf("AWSAllowedAccountIDs = %+v, want nil (one non-static element fails the WHOLE list closed)", pc.AWSAllowedAccountIDs)
				}
			},
		},
		{
			name: "required_providers source referencing a variable: type NOT derived from the local name either",
			files: map[string]string{
				"variables.tf": `variable "src" { type = string }
`,
				"main.tf": `terraform {
  required_providers {
    aws = {
      source  = var.src
      version = "~> 6.0"
    }
  }
}
`,
			},
			check: func(t *testing.T, rep Report) {
				if rep.ProviderConfig != nil {
					t.Fatalf("ProviderConfig = %+v, want nil (source is non-static, fail closed — never fall back to the local name when a source IS present but non-static)", rep.ProviderConfig)
				}
			},
		},
		{
			name: "azure subscription_id via local: omitted",
			files: map[string]string{
				"main.tf": `locals {
  sub = "11111111-2222-3333-4444-555555555555"
}

provider "azurerm" {
  subscription_id = local.sub
}
`,
			},
			check: func(t *testing.T, rep Report) {
				pc := requireProviderConfig(t, rep)
				if pc.AzureSubscriptionID != nil {
					t.Errorf("AzureSubscriptionID = %+v, want nil (local.sub is not a static literal)", pc.AzureSubscriptionID)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := writeRepo(t, tc.files)
			rep, err := Scan(dir, nil)
			if err != nil {
				t.Fatal(err)
			}
			tc.check(t, rep)
		})
	}
}

// TestProviderConfig_TfJSON proves the SAME extraction works from .tf.json
// syntax (the JSON body implementation of hcl.Body) — both the static-literal
// case and the non-static-omission case.
func TestProviderConfig_TfJSON(t *testing.T) {
	t.Run("static region + allowed_account_ids extracted with file:line", func(t *testing.T) {
		dir := writeRepo(t, map[string]string{
			"main.tf.json": `{
  "provider": {
    "aws": {
      "region": "ap-southeast-1",
      "allowed_account_ids": ["123456789012"]
    }
  }
}
`,
		})
		rep, err := Scan(dir, nil)
		if err != nil {
			t.Fatal(err)
		}
		pc := requireProviderConfig(t, rep)
		// HCL's JSON body tracks real source line numbers matching the JSON
		// layout above: line 3 is `"aws": {`, line 4 `"region": …`, line 5
		// `"allowed_account_ids": …` — verified against the parser directly
		// before pinning these, same as the .tf provenance assertions above.
		wantProviders(t, pc, LiteralValue{Value: "aws", File: "main.tf.json", Line: 3})
		if pc.AWSRegion == nil || *pc.AWSRegion != (LiteralValue{Value: "ap-southeast-1", File: "main.tf.json", Line: 4}) {
			t.Errorf("AWSRegion = %+v, want {ap-southeast-1 main.tf.json 4}", pc.AWSRegion)
		}
		wantIDs := []LiteralValue{{Value: "123456789012", File: "main.tf.json", Line: 5}}
		if len(pc.AWSAllowedAccountIDs) != len(wantIDs) || pc.AWSAllowedAccountIDs[0] != wantIDs[0] {
			t.Errorf("AWSAllowedAccountIDs = %+v, want %+v", pc.AWSAllowedAccountIDs, wantIDs)
		}
	})

	t.Run("a variable-referencing region in tf.json is omitted, never guessed", func(t *testing.T) {
		dir := writeRepo(t, map[string]string{
			"variables.tf.json": `{ "variable": { "region": { "type": "string" } } }
`,
			"main.tf.json": `{
  "provider": {
    "aws": {
      "region": "${var.region}"
    }
  }
}
`,
		})
		rep, err := Scan(dir, nil)
		if err != nil {
			t.Fatal(err)
		}
		pc := requireProviderConfig(t, rep) // "aws" label is still static
		if pc.AWSRegion != nil {
			t.Errorf("AWSRegion = %+v, want nil (${var.region} is not a static literal)", pc.AWSRegion)
		}
	})

	t.Run("required_providers in tf.json: provider type derived from source", func(t *testing.T) {
		dir := writeRepo(t, map[string]string{
			"main.tf.json": `{
  "terraform": {
    "required_providers": {
      "azurerm": { "source": "hashicorp/azurerm", "version": "~> 3.0" }
    }
  }
}
`,
		})
		rep, err := Scan(dir, nil)
		if err != nil {
			t.Fatal(err)
		}
		pc := requireProviderConfig(t, rep)
		// Line 4 is `"azurerm": { … }` — verified against the parser directly.
		wantProviders(t, pc, LiteralValue{Value: "azurerm", File: "main.tf.json", Line: 4})
	})
}

// TestProviderConfig_AliasPreference proves the "default (non-aliased)
// provider block wins" resolution rule when several blocks of the same type
// disagree — never a guess, always an ACTUAL literal found in the repo, with
// its own real provenance.
func TestProviderConfig_AliasPreference(t *testing.T) {
	dir := writeRepo(t, map[string]string{
		"main.tf": `provider "aws" {
  alias  = "west"
  region = "us-west-2"
}

provider "aws" {
  region = "us-east-1"
}
`,
	})
	rep, err := Scan(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	pc := requireProviderConfig(t, rep)
	if pc.AWSRegion == nil || pc.AWSRegion.Value != "us-east-1" {
		t.Errorf("AWSRegion = %+v, want us-east-1 (the non-aliased/default block, even though the aliased one appears first in the file)", pc.AWSRegion)
	}
	if pc.AWSRegion.Line != 7 {
		t.Errorf("AWSRegion.Line = %d, want 7 (the default block's own region line)", pc.AWSRegion.Line)
	}
}

// TestProviderConfig_NoRunnerCall proves the census never shells out to
// terraform or touches a Runner — it is a pure hcl parse, same guarantee the
// rest of the package already provides. Scan's signature takes no Runner at
// all, so this is really a documentation-test: it fixes that fact so a future
// change that tries to thread a Runner through here is caught by a compile
// error, not a silent regression.
func TestProviderConfig_NoRunnerCall(t *testing.T) {
	dir := writeRepo(t, map[string]string{
		"main.tf": `provider "aws" {
  region = "ap-southeast-1"
}
`,
	})
	// Scan(root, allowlist) — exactly two arguments, neither a Runner/executor
	// seam. If this signature ever grows one, this line stops compiling.
	if _, err := Scan(dir, nil); err != nil {
		t.Fatal(err)
	}
}

func requireProviderConfig(t *testing.T, rep Report) *ProviderConfig {
	t.Helper()
	if rep.ProviderConfig == nil {
		t.Fatal("ProviderConfig is nil, want a populated proposal")
	}
	return rep.ProviderConfig
}

func wantProviders(t *testing.T, pc *ProviderConfig, want ...LiteralValue) {
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
