// Package idioms is the shared, pure encoding of the create-idiom TABLE —
// the closed set of resource-block topologies one `create_resource` verb may
// emit, keyed by target resource type. It holds ONLY the two pieces
// both the edit verb and the plancheck create-guard must agree on byte-for-byte:
//
//   - TfLocalName — the request-identity → Terraform-safe local-name sanitizer
//     (the Go port of hclSkeleton.ts#tfLocalName), and
//   - Addresses  — the idiom's MANDATORY and CONDITIONAL resource-address set
//     for a given (resourceType, localName, params).
//
// It is deliberately dependency-free (no manifests/hclops import) so it can be
// shared without an import cycle: the verb uses it to gate ALREADY_EXISTS on
// every idiom address and the plancheck create-guard uses THE SAME function so
// the "what the verb emits" and "what the plan proves" locks can never drift
// ("two independent locks"). An unknown resource type renders as a
// single default block.
package idioms

import (
	"fmt"
	"regexp"
	"strings"
)

// nonNameRe / multiUnderscoreRe mirror the two replace() passes in
// hclSkeleton.ts#tfLocalName. AddressShapeRe mirrors ADDRESS_SHAPE — the ONLY
// value form the idioms treat as a resource address (else a quoted literal).
var (
	nonNameRe         = regexp.MustCompile(`[^a-z0-9_]+`)
	multiUnderscoreRe = regexp.MustCompile(`_{2,}`)
	// AddressShapeRe is exported so internal/edit (idiomrender.go) shares the
	// SAME value-form definition instead of a drift-prone duplicate.
	AddressShapeRe = regexp.MustCompile(`^(?:aws|azurerm)_[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*$`)
	leadingDigitRe = regexp.MustCompile(`^[0-9]`)
)

// TfLocalName is the byte-for-byte Go port of hclSkeleton.ts#tfLocalName
// lower-case; every run of non-[a-z0-9_] → "_"; strip leading/trailing
// "_"; collapse "__"→"_"; empty → "new_resource"; a leading digit is prefixed
// "r_". A request byte NEVER becomes syntax — the result is only ever a block
// LABEL (`resource "<type>" "<name>"`), collision-gated by ALREADY_EXISTS.
func TfLocalName(raw any) string {
	s := ""
	if raw != nil {
		s = fmt.Sprint(raw)
	}
	s = strings.ToLower(s)
	s = nonNameRe.ReplaceAllString(s, "_")
	s = strings.Trim(s, "_")
	s = multiUnderscoreRe.ReplaceAllString(s, "_")
	if s == "" {
		return "new_resource"
	}
	if leadingDigitRe.MatchString(s) {
		return "r_" + s
	}
	return s
}

// IsAddressShaped reports whether v (a request value) is shaped like a resource
// address (`aws_subnet.app_a`) — the ONLY form an idiom wires as an inter-block
// reference or a conditional companion (mirrors hclSkeleton.ts ADDRESS_SHAPE).
func IsAddressShaped(v any) bool {
	s, ok := v.(string)
	return ok && AddressShapeRe.MatchString(s)
}

// AddressSet is an idiom's resource-address plan: Mandatory addresses MUST be
// created (a bucket without its public-access-block is a violation);
// Conditional addresses are created only when their param is present/chosen.
type AddressSet struct {
	Mandatory   []string
	Conditional []string
}

// All returns mandatory ∪ conditional in a fresh slice (mandatory first).
func (s AddressSet) All() []string {
	out := make([]string, 0, len(s.Mandatory)+len(s.Conditional))
	out = append(out, s.Mandatory...)
	out = append(out, s.Conditional...)
	return out
}

// Contains reports whether addr is any address the idiom may create (the R1
// membership predicate for a create).
func (s AddressSet) Contains(addr string) bool {
	for _, a := range s.All() {
		if a == addr {
			return true
		}
	}
	return false
}

// String renders the expected set for a human-readable R1 reason.
func (s AddressSet) String() string { return strings.Join(s.All(), ", ") }

// Addresses returns the idiom's address set for (resourceType, localName,
// params) — the closed topology. It is keyed ONLY by resourceType
// (the closed table) and reads params ONLY to decide the CONDITIONAL companions
// each idiom's own logic gates on (the same predicates hclSkeleton.ts uses):
//
//   - aws_ebs_volume     → the volume; + aws_volume_attachment WHEN attach_to is
//     address-shaped.
//   - aws_s3_bucket      → bucket + public-access-block + SSE config (all
//     MANDATORY — the estate's 20/20 security idiom); + versioning WHEN
//     versioning==true; + lifecycle_configuration WHEN lifecycle_cleanup_days is
//     given.
//   - everything else    → ONE `<resourceType>.<name>` block (rows 1,3,5-11 are
//     single-resource — their extra structure is NESTED blocks, not separate
//     resources — and row 12 is the mechanical default).
func Addresses(resourceType, localName string, params map[string]any) AddressSet {
	addr := func(t string) string { return t + "." + localName }
	switch resourceType {
	case "aws_ebs_volume":
		s := AddressSet{Mandatory: []string{addr("aws_ebs_volume")}}
		if IsAddressShaped(params["attach_to"]) {
			s.Conditional = append(s.Conditional, addr("aws_volume_attachment"))
		}
		return s
	case "aws_s3_bucket":
		s := AddressSet{Mandatory: []string{
			addr("aws_s3_bucket"),
			addr("aws_s3_bucket_public_access_block"),
			addr("aws_s3_bucket_server_side_encryption_configuration"),
		}}
		if isTrue(params["versioning"]) {
			s.Conditional = append(s.Conditional, addr("aws_s3_bucket_versioning"))
		}
		if !isEmpty(params["lifecycle_cleanup_days"]) {
			s.Conditional = append(s.Conditional, addr("aws_s3_bucket_lifecycle_configuration"))
		}
		return s
	default:
		return AddressSet{Mandatory: []string{addr(resourceType)}}
	}
}

// isTrue mirrors the TS `value === true` gate for a bool param that may arrive as
// a real bool (SPA/JSON) or its canonical string form (YAML request).
func isTrue(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case string:
		return b == "true"
	}
	return false
}

// isEmpty mirrors hclSkeleton.ts#isEmptyValue for the conditional-companion gate:
// undefined/null/""/[] are "not given".
func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return false
}
