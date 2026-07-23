package edit

import "testing"

func TestProviderShapes(t *testing.T) {
	for _, ok := range []string{"aws_s3_bucket", "azurerm_storage_account"} {
		if !createResourceTypeShape.MatchString(ok) {
			t.Errorf("%q should be a valid create label", ok)
		}
	}
	for _, bad := range []string{"google_storage_bucket", "aws-", "azurerm_", "Aws_x"} {
		if createResourceTypeShape.MatchString(bad) {
			t.Errorf("%q should be refused", bad)
		}
	}
	if SchemaDumpPrefix("azurerm_storage_account") != "azurerm" {
		t.Error("azurerm prefix")
	}
	if SchemaDumpPrefix("aws_instance") != "aws" {
		t.Error("aws prefix")
	}
}
