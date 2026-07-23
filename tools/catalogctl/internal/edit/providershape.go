// Package-internal provider shape tables — the ONLY place the codemod knows
// which Terraform providers exist (0039 S1 lane B). Extending to a third
// provider is a one-line change here plus a schema dump.
package edit

import (
	"strings"
)

// providerTypePrefixes: every recognized provider resource-type prefix.
var providerTypePrefixes = []string{"aws_", "azurerm_"}

// IsProviderResourceType reports whether s names a provider resource type
// (used to refuse resource types as NESTED block names — a manifest error).
func IsProviderResourceType(s string) bool {
	for _, p := range providerTypePrefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// SchemaDumpPrefix maps a resource type to its schema-dump filename prefix
// (tools/schemadump/<prefix>-<tag>-schema.json).
func SchemaDumpPrefix(resourceType string) string {
	if strings.HasPrefix(resourceType, "azurerm_") {
		return "azurerm"
	}
	return "aws"
}
