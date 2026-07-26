package edit

import "testing"

func TestProviderShapes(t *testing.T) {
	for _, ok := range []string{"aws_s3_bucket", "azurerm_storage_account", "google_storage_bucket"} {
		if !createResourceTypeShape.MatchString(ok) {
			t.Errorf("%q should be a valid create label", ok)
		}
	}
	for _, bad := range []string{"gcp_storage_bucket", "aws-", "azurerm_", "google_", "Aws_x", "Google_x"} {
		if createResourceTypeShape.MatchString(bad) {
			t.Errorf("%q should be refused", bad)
		}
	}
	// SchemaDumpPrefix: one explicit arm per recognized provider, "" (fail
	// closed — no dump discovered, never another provider's) for the rest.
	for rt, want := range map[string]string{
		"aws_instance":            "aws",
		"azurerm_storage_account": "azurerm",
		"google_storage_bucket":   "google",
		"random_pet":              "",
		"gcp_storage_bucket":      "",
	} {
		if got := SchemaDumpPrefix(rt); got != want {
			t.Errorf("SchemaDumpPrefix(%q) = %q, want %q", rt, got, want)
		}
	}
	for _, rt := range []string{"aws_instance", "azurerm_storage_account", "google_storage_bucket"} {
		if !IsProviderResourceType(rt) {
			t.Errorf("IsProviderResourceType(%q) should be true", rt)
		}
	}
	if IsProviderResourceType("random_pet") {
		t.Error("IsProviderResourceType(random_pet) should be false")
	}
}
