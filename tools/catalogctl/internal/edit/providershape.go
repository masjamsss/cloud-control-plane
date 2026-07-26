// Package-internal provider shape tables — the ONLY place the codemod knows
// which Terraform providers exist (0039 S1 lane B; widened to google by
// ADR-0034 lane G1). Extending to a fourth provider is a one-entry change in
// providerSchemaPrefixes plus a schema dump.
package edit

import (
	"strings"
)

// providerSchemaPrefixes maps every recognized provider resource-type prefix to
// its schema-dump filename prefix (tools/schemadump/<prefix>-<tag>-schema.json).
// ONE table drives both IsProviderResourceType and SchemaDumpPrefix so the two
// can never disagree about which providers exist. Before ADR-0034 rule 8 this
// was an if-azurerm-else-aws dispatch, which answered "aws" for ANY
// unrecognized type — a google_* resource would have been validated against
// the AWS schema dump (and given AWS tag-case semantics) silently.
var providerSchemaPrefixes = map[string]string{
	"aws_":     "aws",
	"azurerm_": "azurerm",
	"google_":  "google",
}

// IsProviderResourceType reports whether s names a provider resource type
// (used to refuse resource types as NESTED block names — a manifest error).
func IsProviderResourceType(s string) bool {
	for p := range providerSchemaPrefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// SchemaDumpPrefix maps a resource type to its schema-dump filename prefix
// (tools/schemadump/<prefix>-<tag>-schema.json). Fail-closed: a type of no
// recognized provider returns "" — the caller then discovers no dump and the
// schema guard fails open exactly as for a provider whose dump is not yet
// committed, but nothing is ever validated against ANOTHER provider's schema.
func SchemaDumpPrefix(resourceType string) string {
	for p, name := range providerSchemaPrefixes {
		if strings.HasPrefix(resourceType, p) {
			return name
		}
	}
	return ""
}
