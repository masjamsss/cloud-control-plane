package schemadump

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema"
)

// fixtureProvider builds synthetic *schema.Resource values that exercise every
// reflection path the real walker must handle: scalars (ForceNew true/false,
// required/optional/computed/sensitive/deprecated/default/defaultfunc/validate),
// collections of scalars (list/set/map), single nested blocks (TypeList
// MaxItems==1), repeated nested blocks (TypeList/TypeSet), recursion (block in
// block), CustomizeDiff detection, and SchemaVersion. This is the offline
// "stub provider tree" from 0013d G0, expressed as fixtures.
func fixtureSDK() map[string]*schema.Resource {
	return map[string]*schema.Resource{
		"fake_compute": {
			SchemaVersion: 3,
			CustomizeDiff: func(context.Context, *schema.ResourceDiff, interface{}) error { return nil },
			Schema: map[string]*schema.Schema{
				// resize in place -> ForceNew false
				"instance_type": {Type: schema.TypeString, Optional: true, ForceNew: false, Default: "t3.micro"},
				// move AZ -> ForceNew true
				"availability_zone": {Type: schema.TypeString, Optional: true, Computed: true, ForceNew: true},
				"password":          {Type: schema.TypeString, Optional: true, Sensitive: true},
				"old_field":         {Type: schema.TypeString, Optional: true, Deprecated: "use new_field"},
				"validated":         {Type: schema.TypeInt, Optional: true, ValidateFunc: func(interface{}, string) ([]string, []error) { return nil, nil }},
				"dyn_default":       {Type: schema.TypeString, Optional: true, DefaultFunc: func() (interface{}, error) { return nil, nil }},
				"tags":              {Type: schema.TypeMap, Optional: true, Elem: &schema.Schema{Type: schema.TypeString}},
				"security_groups":   {Type: schema.TypeList, Optional: true, Elem: &schema.Schema{Type: schema.TypeString}},
				// single nested block
				"root_block_device": {
					Type: schema.TypeList, Optional: true, MaxItems: 1,
					Elem: &schema.Resource{Schema: map[string]*schema.Schema{
						"volume_size": {Type: schema.TypeInt, Optional: true, Computed: true, ForceNew: false},
						"encrypted":   {Type: schema.TypeBool, Optional: true, ForceNew: true},
					}},
				},
			},
		},
		"fake_policy": {
			Schema: map[string]*schema.Schema{
				// repeated set block
				"ingress": {
					Type: schema.TypeSet, Optional: true,
					Elem: &schema.Resource{Schema: map[string]*schema.Schema{
						"from_port": {Type: schema.TypeInt, Required: true},
						"protocol":  {Type: schema.TypeString, Required: true},
					}},
				},
				// repeated list block with recursion (block in block)
				"schedule": {
					Type: schema.TypeList, Optional: true, MinItems: 1, MaxItems: 4,
					Elem: &schema.Resource{Schema: map[string]*schema.Schema{
						"name": {Type: schema.TypeString, Required: true},
						"create_rule": {
							Type: schema.TypeList, Optional: true, MaxItems: 1,
							Elem: &schema.Resource{Schema: map[string]*schema.Schema{
								"interval": {Type: schema.TypeInt, Optional: true, ForceNew: true},
							}},
						},
					}},
				},
			},
		},
		// Lazy schema via SchemaFunc — how the AWS provider defines MOST v6
		// resources (Schema field nil). Regression fixture for the empty-dump
		// bug: the walker must go through SchemaMap(), not r.Schema.
		"fake_lazy": {
			SchemaFunc: func() map[string]*schema.Schema {
				return map[string]*schema.Schema{
					"engine": {Type: schema.TypeString, Required: true, ForceNew: true},
					"nested": {
						Type: schema.TypeList, Optional: true, MaxItems: 1,
						// nested Elem resource ALSO lazy
						Elem: &schema.Resource{SchemaFunc: func() map[string]*schema.Schema {
							return map[string]*schema.Schema{
								"size": {Type: schema.TypeInt, Optional: true},
							}
						}},
					},
				}
			},
		},
	}
}

func TestBuildDump_LazySchemaFunc(t *testing.T) {
	d := BuildDump(fixtureSDK(), nil, []string{"fake_lazy"}, Metadata{})
	r := d.Resources["fake_lazy"]
	if r == nil || len(r.Attributes) != 2 {
		t.Fatalf("SchemaFunc resource not reflected (empty-dump regression): %+v", r)
	}
	if !r.Attributes["engine"].ForceNew || !r.Attributes["engine"].Required {
		t.Errorf("engine should be required+ForceNew, got %+v", r.Attributes["engine"])
	}
	n := r.Attributes["nested"]
	if n.Block == nil || n.Block.Attributes["size"] == nil {
		t.Fatalf("nested lazy Elem resource not reflected: %+v", n)
	}
}

func TestBuildDump_Counts(t *testing.T) {
	fw := map[string]bool{"fake_fwonly": true}
	requested := []string{"fake_compute", "fake_policy", "fake_fwonly", "fake_absent"}
	d := BuildDump(fixtureSDK(), fw, requested, Metadata{})

	s := d.Metadata.Summary
	if s.Requested != 4 || s.SDKv2Reflected != 2 || s.FrameworkUnreflected != 1 || s.Missing != 1 {
		t.Fatalf("summary = %+v, want requested=4 sdkv2=2 framework=1 missing=1", s)
	}
	if len(s.MissingTypes) != 1 || s.MissingTypes[0] != "fake_absent" {
		t.Errorf("MissingTypes = %v, want [fake_absent]", s.MissingTypes)
	}
	if len(s.FrameworkTypes) != 1 || s.FrameworkTypes[0] != "fake_fwonly" {
		t.Errorf("FrameworkTypes = %v, want [fake_fwonly]", s.FrameworkTypes)
	}
}

func TestBuildDump_Framework(t *testing.T) {
	d := BuildDump(fixtureSDK(), map[string]bool{"fake_fwonly": true}, []string{"fake_fwonly"}, Metadata{})
	r := d.Resources["fake_fwonly"]
	if r == nil || !r.Framework || !r.FrameworkUnreflected {
		t.Fatalf("framework resource not marked unreflected: %+v", r)
	}
	if r.Attributes != nil {
		t.Errorf("framework resource must not carry reflected attributes (fail-closed)")
	}
}

func TestBuildDump_ForceNewAndFlags(t *testing.T) {
	d := BuildDump(fixtureSDK(), nil, []string{"fake_compute"}, Metadata{})
	c := d.Resources["fake_compute"]
	if c.SchemaVersion != 3 {
		t.Errorf("schema_version = %d, want 3", c.SchemaVersion)
	}
	if !c.HasCustomizeDiff {
		t.Errorf("has_customize_diff should be true (ForceNew residual hazard flag)")
	}

	it := c.Attributes["instance_type"]
	if it.ForceNew {
		t.Errorf("instance_type ForceNew = true, want false (resize in place)")
	}
	if it.Default != "t3.micro" {
		t.Errorf("instance_type default = %v, want t3.micro", it.Default)
	}
	az := c.Attributes["availability_zone"]
	if !az.ForceNew || !az.Computed {
		t.Errorf("availability_zone want ForceNew && Computed, got %+v", az)
	}
	if !c.Attributes["password"].Sensitive {
		t.Errorf("password should be sensitive")
	}
	if !c.Attributes["old_field"].Deprecated {
		t.Errorf("old_field should be deprecated")
	}
	if !c.Attributes["validated"].HasValidateFunc {
		t.Errorf("validated should report has_validate_func")
	}
	if !c.Attributes["dyn_default"].HasDefaultFunc {
		t.Errorf("dyn_default should report has_default_func")
	}
}

func TestBuildDump_Collections(t *testing.T) {
	d := BuildDump(fixtureSDK(), nil, []string{"fake_compute"}, Metadata{})
	c := d.Resources["fake_compute"]

	tags := c.Attributes["tags"]
	if tags.Type != "map" || tags.ElementType != "string" || tags.Block != nil {
		t.Errorf("tags should be map(string) attribute, got %+v", tags)
	}
	sg := c.Attributes["security_groups"]
	if sg.Type != "list" || sg.ElementType != "string" || sg.Block != nil {
		t.Errorf("security_groups should be list(string) attribute, got %+v", sg)
	}
}

func TestBuildDump_NestedBlocks(t *testing.T) {
	d := BuildDump(fixtureSDK(), nil, []string{"fake_compute", "fake_policy"}, Metadata{})

	// single nested block
	rbd := d.Resources["fake_compute"].Attributes["root_block_device"]
	if rbd.NestingMode != "list" || !rbd.Single || rbd.MaxItems != 1 || rbd.Block == nil {
		t.Fatalf("root_block_device should be single list block, got %+v", rbd)
	}
	if rbd.Block.Attributes["encrypted"].ForceNew != true {
		t.Errorf("root_block_device.encrypted should be ForceNew true")
	}
	if rbd.Block.Attributes["volume_size"].ForceNew != false {
		t.Errorf("root_block_device.volume_size should be ForceNew false (grow in place)")
	}

	// set block
	ing := d.Resources["fake_policy"].Attributes["ingress"]
	if ing.NestingMode != "set" || ing.Single {
		t.Errorf("ingress should be a set block (not single), got %+v", ing)
	}

	// recursion: schedule.create_rule.interval
	sched := d.Resources["fake_policy"].Attributes["schedule"]
	if sched.NestingMode != "list" || sched.MinItems != 1 || sched.MaxItems != 4 {
		t.Fatalf("schedule bounds wrong: %+v", sched)
	}
	cr := sched.Block.Attributes["create_rule"]
	if cr.Block == nil || cr.Block.Attributes["interval"].ForceNew != true {
		t.Errorf("schedule.create_rule.interval should reflect ForceNew true (recursion)")
	}
}

func TestBuildDump_CountsAttrsRecursively(t *testing.T) {
	d := BuildDump(fixtureSDK(), nil, []string{"fake_compute", "fake_policy"}, Metadata{})
	s := d.Metadata.Summary
	// fake_compute: 8 top-level + root_block_device{2} = 11
	// fake_policy: ingress{2}+1 + schedule{name+create_rule{interval}=3}+1 = 8
	// total attributes counted (blocks + leaves) = 19
	if s.TotalAttributes == 0 || s.AttrsForceNewTrue == 0 || s.AttrsForceNewFalse == 0 {
		t.Fatalf("attr census not populated: %+v", s)
	}
	if s.AttrsForceNewTrue+s.AttrsForceNewFalse != s.TotalAttributes {
		t.Errorf("forcenew true+false (%d+%d) != total (%d)", s.AttrsForceNewTrue, s.AttrsForceNewFalse, s.TotalAttributes)
	}
}
