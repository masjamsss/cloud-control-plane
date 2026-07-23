// Package schemadump reflects the terraform-plugin-sdk/v2 (SDKv2) resource
// schemas of a Terraform provider into an authoritative per-attribute JSON
// dump — including ForceNew, which `terraform providers schema -json` omits
// (see docs/proposals/0009 L1, 0013d §2.1).
//
// This file is provider-agnostic: it depends ONLY on the public
// github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema API, so it can be
// unit-tested standalone (schemadump_test.go) with synthetic *schema.Resource
// fixtures that exercise every reflection path. At build time gen.sh copies
// this file next to main.go inside a checkout of the provider source, rewriting
// the package clause to `package main` (the only way to import the provider's
// internal/ packages — Go forbids external import of internal/).
//
// SDKv2 resources are reflected completely (each *schema.Schema carries an
// authoritative ForceNew bool). terraform-plugin-framework resources express
// RequiresReplace via plan modifiers that are NOT reliably introspectable, so
// the glue marks them framework_unreflected=true (fail-closed: consumers treat
// unknown ForceNew as engineer-only / WARN).
package schemadump

import (
	"sort"

	"github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema"
)

// maxDepth guards against pathological / cyclic nested-block chains. The
// deepest real AWS schema (aws_dlm_lifecycle_policy) is ~5 levels; 25 is ample.
const maxDepth = 25

// AttrDump is the authoritative record for one schema attribute (scalar,
// collection, or nested block).
type AttrDump struct {
	Type       string `json:"type"` // bool|int|float|string|list|set|map
	Required   bool   `json:"required"`
	Optional   bool   `json:"optional"`
	Computed   bool   `json:"computed"`
	ForceNew   bool   `json:"force_new"` // authoritative — the whole point of this tool
	Sensitive  bool   `json:"sensitive,omitempty"`
	Deprecated bool   `json:"deprecated,omitempty"`

	// Default is the static SDKv2 Default (if any). HasDefaultFunc reports a
	// dynamic DefaultFunc closure (value not statically knowable).
	Default        interface{} `json:"default,omitempty"`
	HasDefaultFunc bool        `json:"has_default_func,omitempty"`

	// HasValidateFunc reports a ValidateFunc/ValidateDiagFunc closure. The bound
	// values are opaque to reflection (an AST pass, out of scope here, would be
	// needed — 0013d §2.1); consumers must treat the attribute as unbounded.
	HasValidateFunc bool `json:"has_validate_func,omitempty"`

	// ElementType is set for collections of scalars (list/set/map whose Elem is
	// a *schema.Schema), e.g. list(string) -> "string".
	ElementType string `json:"element_type,omitempty"`

	// Nested-block fields — set when Elem is a *schema.Resource.
	NestingMode string     `json:"nesting_mode,omitempty"` // list|set|map
	Single      bool       `json:"single,omitempty"`       // SDKv2 single-block idiom: TypeList + MaxItems==1
	MinItems    int        `json:"min_items,omitempty"`
	MaxItems    int        `json:"max_items,omitempty"`
	ConfigMode  string     `json:"config_mode,omitempty"` // "attr" when a block is forced to attribute mode
	Block       *BlockDump `json:"block,omitempty"`
}

// BlockDump is the recursive attribute set of a nested block.
type BlockDump struct {
	Attributes map[string]*AttrDump `json:"attributes"`
}

// ResourceDump is one resource type's reflected schema, or a framework marker.
type ResourceDump struct {
	Framework            bool                 `json:"framework"`
	FrameworkUnreflected bool                 `json:"framework_unreflected,omitempty"`
	Note                 string               `json:"note,omitempty"`
	SchemaVersion        int                  `json:"schema_version,omitempty"`
	HasCustomizeDiff     bool                 `json:"has_customize_diff,omitempty"` // ForceNew residual hazard (0013d §6.4)
	Deprecated           bool                 `json:"deprecated,omitempty"`
	Attributes           map[string]*AttrDump `json:"attributes,omitempty"`
}

// Summary is the coverage census embedded in metadata.
type Summary struct {
	Requested            int      `json:"requested"`
	SDKv2Reflected       int      `json:"sdkv2_reflected"`
	FrameworkUnreflected int      `json:"framework_unreflected"`
	Missing              int      `json:"missing"`
	MissingTypes         []string `json:"missing_types,omitempty"`
	FrameworkTypes       []string `json:"framework_types,omitempty"`
	TotalAttributes      int      `json:"total_attributes_reflected"`
	AttrsForceNewTrue    int      `json:"attributes_force_new_true"`
	AttrsForceNewFalse   int      `json:"attributes_force_new_false"`
}

// Metadata is provenance + census. Standard fields are set by the caller
// (main.go); Summary is computed by BuildDump.
type Metadata struct {
	Provider         string      `json:"provider"`
	ProviderVersion  string      `json:"provider_version"`
	ProviderModule   string      `json:"provider_module"`
	ProviderTag      string      `json:"provider_tag"`
	GeneratedAt      string      `json:"generated_at"`
	Generator        string      `json:"generator"`
	GoVersion        string      `json:"go_version"`
	SDKVersion       string      `json:"terraform_plugin_sdk_version,omitempty"`
	FrameworkVersion string      `json:"terraform_plugin_framework_version,omitempty"`
	Note             string      `json:"note"`
	SourceProvenance interface{} `json:"source_provenance,omitempty"`
	Summary          Summary     `json:"summary"`
}

// Dump is the top-level artifact.
type Dump struct {
	Metadata  Metadata                 `json:"metadata"`
	Resources map[string]*ResourceDump `json:"resources"`
}

// valueTypeName maps schema.ValueType to a friendly lowercase name.
func valueTypeName(t schema.ValueType) string {
	switch t {
	case schema.TypeBool:
		return "bool"
	case schema.TypeInt:
		return "int"
	case schema.TypeFloat:
		return "float"
	case schema.TypeString:
		return "string"
	case schema.TypeList:
		return "list"
	case schema.TypeMap:
		return "map"
	case schema.TypeSet:
		return "set"
	default:
		return "invalid"
	}
}

// walkSchema reflects a single *schema.Schema into an *AttrDump, recursing into
// nested blocks.
func walkSchema(s *schema.Schema, depth int) *AttrDump {
	a := &AttrDump{
		Type:       valueTypeName(s.Type),
		Required:   s.Required,
		Optional:   s.Optional,
		Computed:   s.Computed,
		ForceNew:   s.ForceNew,
		Sensitive:  s.Sensitive,
		Deprecated: s.Deprecated != "",
	}
	if s.Default != nil {
		a.Default = s.Default
	}
	if s.DefaultFunc != nil {
		a.HasDefaultFunc = true
	}
	if s.ValidateFunc != nil || s.ValidateDiagFunc != nil {
		a.HasValidateFunc = true
	}

	switch elem := s.Elem.(type) {
	case *schema.Resource:
		// Nested block. The nesting mode is inferred from the collection type;
		// SDKv2 has no explicit nesting_mode (unlike the plugin framework).
		a.NestingMode = valueTypeName(s.Type)
		a.MinItems = s.MinItems
		a.MaxItems = s.MaxItems
		if s.Type == schema.TypeList && s.MaxItems == 1 {
			a.Single = true
		}
		if s.ConfigMode == schema.SchemaConfigModeAttr {
			a.ConfigMode = "attr"
		}
		if depth < maxDepth && elem != nil {
			a.Block = walkResource(elem, depth+1)
		}
	case *schema.Schema:
		// Collection of scalars, e.g. list(string) / set(string) / map(string).
		a.ElementType = valueTypeName(elem.Type)
	}
	return a
}

// walkResource reflects every attribute of a *schema.Resource.
//
// CRITICAL: it must go through SchemaMap(), not the Schema field. The AWS
// provider defines most v6 resource schemas via the lazy SchemaFunc field (an
// SDKv2 memory optimization); for those resources the Schema field is nil and
// reading it directly yields an EMPTY dump (82 of the 84 in-scope types).
// SchemaMap() resolves SchemaFunc when set and falls back to Schema.
func walkResource(r *schema.Resource, depth int) *BlockDump {
	m := r.SchemaMap()
	bd := &BlockDump{Attributes: make(map[string]*AttrDump, len(m))}
	for name, s := range m {
		if s == nil {
			continue
		}
		bd.Attributes[name] = walkSchema(s, depth)
	}
	return bd
}

// countAttrs tallies attributes and ForceNew verdicts recursively.
func countAttrs(attrs map[string]*AttrDump, sum *Summary) {
	for _, a := range attrs {
		sum.TotalAttributes++
		if a.ForceNew {
			sum.AttrsForceNewTrue++
		} else {
			sum.AttrsForceNewFalse++
		}
		if a.Block != nil {
			countAttrs(a.Block.Attributes, sum)
		}
	}
}

// BuildDump reflects the requested resource types.
//
//   - sdk:       the SDKv2 provider's ResourcesMap (type name -> *schema.Resource)
//   - fwTypes:   set of type names registered as plugin-framework resources
//   - requested: the type list to include (nil/empty = every SDKv2 + framework type)
//   - meta:      caller-populated provenance; Summary is filled here.
//
// A requested type present in sdk is reflected in full. A type present only in
// fwTypes is emitted framework_unreflected. A type in neither is recorded in
// Summary.MissingTypes.
func BuildDump(sdk map[string]*schema.Resource, fwTypes map[string]bool, requested []string, meta Metadata) *Dump {
	if len(requested) == 0 {
		seen := make(map[string]bool)
		for t := range sdk {
			if !seen[t] {
				requested = append(requested, t)
				seen[t] = true
			}
		}
		for t := range fwTypes {
			if !seen[t] {
				requested = append(requested, t)
				seen[t] = true
			}
		}
	}
	sort.Strings(requested)

	d := &Dump{Resources: make(map[string]*ResourceDump, len(requested))}
	sum := &Summary{Requested: len(requested)}

	for _, t := range requested {
		if r, ok := sdk[t]; ok {
			rd := &ResourceDump{
				Framework:        false,
				SchemaVersion:    r.SchemaVersion,
				HasCustomizeDiff: r.CustomizeDiff != nil,
				Deprecated:       r.DeprecationMessage != "",
				Attributes:       walkResource(r, 0).Attributes,
			}
			d.Resources[t] = rd
			sum.SDKv2Reflected++
			countAttrs(rd.Attributes, sum)
			continue
		}
		if fwTypes[t] {
			d.Resources[t] = &ResourceDump{
				Framework:            true,
				FrameworkUnreflected: true,
				Note: "terraform-plugin-framework resource: RequiresReplace lives in plan " +
					"modifiers that are not reliably introspectable. ForceNew is UNKNOWN — " +
					"treat as fail-closed (engineer-only / WARN).",
			}
			sum.FrameworkUnreflected++
			sum.FrameworkTypes = append(sum.FrameworkTypes, t)
			continue
		}
		sum.Missing++
		sum.MissingTypes = append(sum.MissingTypes, t)
	}

	sort.Strings(sum.FrameworkTypes)
	sort.Strings(sum.MissingTypes)
	meta.Summary = *sum
	d.Metadata = meta
	return d
}
