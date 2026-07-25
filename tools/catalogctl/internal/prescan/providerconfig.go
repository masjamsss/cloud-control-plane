package prescan

import (
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
)

// providerconfig.go is the STATIC-LITERAL cloud-identity census (ADR-0033
// Decision 5, docs/adr/0033-ccp-zero-touch-first-scan.md): "the census gains a
// static-literal providerConfig so provider/region (and, when statically
// present, account/subscription ids) are proposed with file:line provenance
// and confirmed by a human — never silently inferred, never a product
// constant." It is a SEPARATE, purely additive walk from Scan's verdict-relevant
// logic above (scanRequiredProviders, checkSource, scanForProvisioners): this
// file never calls addFinding and never influences Verdict — a bug here can
// only omit or misreport a proposal, never change what gets trusted. Like the
// rest of the package, nothing here executes anything or evaluates a runtime
// value; every reported value is a bare string literal found in the repo's own
// Terraform source.
//
// FAIL-CLOSED RULES (non-negotiable):
//   - A value that is an expression, variable, local, interpolation, function
//     call, or otherwise not a static string literal is OMITTED, never guessed
//     and never partially evaluated. A missing value is correct output, not an
//     error (mirrors staticString's existing all-or-nothing contract below).
//   - This is a PROPOSAL for a human to confirm (PUT /projects/:id/identity,
//     ccp/api/src/routes/projects.ts) — never an authoritative fact and never a
//     product constant (repo hard rule: estate specifics are operator data).
//   - Only the two recognized cloud providers (aws / azurerm) are reported —
//     this census is about CLOUD IDENTITY, not a full provider inventory
//     (ProviderPins already covers every provider's version pin, findings-
//     independent, the same "report data regardless of verdict" precedent this
//     file follows for a provider whose registry source is off-allowlist).

// LiteralValue is one static string literal found in the repo's Terraform,
// with file:line provenance so the UI can show exactly where it came from
// (ADR-0033 Decision 5). Never a derived/computed/interpolated value.
type LiteralValue struct {
	Value string `json:"value"`
	File  string `json:"file"` // repo-relative, same convention as Finding.File
	Line  int    `json:"line"`
}

// ProviderConfig is the static-literal cloud-identity PROPOSAL. Every field is
// OPTIONAL and independently omitted when not statically determinable — see
// the package-level fail-closed rules above. Never a verdict input.
type ProviderConfig struct {
	// Providers are the recognized cloud provider type(s) found via
	// required_providers and/or `provider` blocks (aws / azurerm only).
	Providers []LiteralValue `json:"providers,omitempty"`

	AWSRegion            *LiteralValue  `json:"awsRegion,omitempty"`
	AWSAllowedAccountIDs []LiteralValue `json:"awsAllowedAccountIds,omitempty"`

	AzureLocation       *LiteralValue `json:"azureLocation,omitempty"`
	AzureSubscriptionID *LiteralValue `json:"azureSubscriptionId,omitempty"`
	AzureTenantID       *LiteralValue `json:"azureTenantId,omitempty"`
}

// isEmpty reports whether pc carries nothing worth reporting. The caller uses
// this to leave Report.ProviderConfig nil rather than emit an all-empty
// object — absence of the WHOLE section is itself meaningful fail-closed
// output ("the scan found nothing to propose"), and it keeps a repo with no
// provider/required_providers block at all byte-identical to before this
// field existed (no golden churn on fixtures unrelated to cloud identity).
func (pc *ProviderConfig) isEmpty() bool {
	return pc == nil ||
		(len(pc.Providers) == 0 &&
			pc.AWSRegion == nil && len(pc.AWSAllowedAccountIDs) == 0 &&
			pc.AzureLocation == nil && pc.AzureSubscriptionID == nil && pc.AzureTenantID == nil)
}

// identityCandidates accumulates every static-literal identity mention found
// across one whole Scan, in deterministic file-sorted / in-file-source order
// (the same walk Findings uses). Purely local to Scan() — never attached to
// Report, never serialized. resolve() turns it into the public ProviderConfig
// once the walk completes.
type identityCandidates struct {
	providers []LiteralValue // de-duplicated by Value, first occurrence wins

	awsRegion            []scalarCandidate
	awsAllowedAccountIDs []listCandidate
	azureLocation        []scalarCandidate
	azureSubscriptionID  []scalarCandidate
	azureTenantID        []scalarCandidate
}

// scalarCandidate/listCandidate pair a found value with whether it came from
// an ALIASED provider block (`alias = "…"` present). Terraform semantics: an
// aliased provider config is a NAMED SECONDARY, never the resource default —
// so when several provider blocks of the same type disagree, the non-aliased
// ("default") one is the honest single proposal; see pickScalar/pickList.
type scalarCandidate struct {
	value   LiteralValue
	aliased bool
}

type listCandidate struct {
	values  []LiteralValue
	aliased bool
}

func (c *identityCandidates) addProvider(typ, file string, line int) {
	for _, p := range c.providers {
		if p.Value == typ {
			return // first occurrence wins — provenance points at where it was FIRST seen
		}
	}
	c.providers = append(c.providers, LiteralValue{Value: typ, File: file, Line: line})
}

// pickScalar resolves multiple candidates for one singular field: the first
// NON-ALIASED block wins (Terraform's own "default provider" semantics —
// resources use it unless they explicitly name an aliased one); else the
// first candidate found at all. Never invents a value — always returns an
// ACTUAL literal that was found, with ITS OWN real provenance.
func pickScalar(cands []scalarCandidate) *LiteralValue {
	if len(cands) == 0 {
		return nil
	}
	for _, c := range cands {
		if !c.aliased {
			v := c.value
			return &v
		}
	}
	v := cands[0].value
	return &v
}

func pickList(cands []listCandidate) []LiteralValue {
	if len(cands) == 0 {
		return nil
	}
	for _, c := range cands {
		if !c.aliased {
			return c.values
		}
	}
	return cands[0].values
}

// resolve turns the accumulated candidates into the public ProviderConfig, or
// nil when nothing was found (see ProviderConfig.isEmpty).
func (c *identityCandidates) resolve() *ProviderConfig {
	pc := &ProviderConfig{
		Providers:            append([]LiteralValue(nil), c.providers...),
		AWSRegion:            pickScalar(c.awsRegion),
		AWSAllowedAccountIDs: pickList(c.awsAllowedAccountIDs),
		AzureLocation:        pickScalar(c.azureLocation),
		AzureSubscriptionID:  pickScalar(c.azureSubscriptionID),
		AzureTenantID:        pickScalar(c.azureTenantID),
	}
	// Deterministic output order regardless of internal walk-order nuances
	// (JSON-body key ordering in particular is not a guarantee this package
	// otherwise relies on) — same belt-and-braces final sort Findings uses.
	sort.SliceStable(pc.Providers, func(i, j int) bool {
		a, b := pc.Providers[i], pc.Providers[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Value < b.Value
	})
	if pc.isEmpty() {
		return nil
	}
	return pc
}

// recordProviderBlock extracts the static-literal identity fields from ONE
// `provider "aws" {…}` / `provider "azurerm" {…}` block for the providerConfig
// census. Never a Finding, never verdict-relevant. Any other provider's block
// (random, null, tls, …) is silently ignored — this census is about cloud
// identity, not a full provider inventory.
func recordProviderBlock(b *hcl.Block, file string, candidates *identityCandidates) {
	if len(b.Labels) == 0 {
		return
	}
	typ := b.Labels[0]
	if typ != "aws" && typ != "azurerm" {
		return
	}
	candidates.addProvider(typ, file, b.DefRange.Start.Line)

	// diags discarded deliberately: a provider block may legally carry nested
	// blocks (assume_role{}, default_tags{}, endpoints{}, …) alongside flat
	// attributes — JustAttributes still returns every flat attribute, and we
	// only ever look up specific known keys below (the same established
	// pattern checkSource already uses against a module body).
	attrs, _ := b.Body.JustAttributes()
	_, aliased := attrs["alias"] // PRESENCE alone marks a named secondary config

	switch typ {
	case "aws":
		if a, ok := attrs["region"]; ok {
			if lv, ok := literalOf(a.Expr, file); ok {
				candidates.awsRegion = append(candidates.awsRegion, scalarCandidate{lv, aliased})
			}
		}
		if a, ok := attrs["allowed_account_ids"]; ok {
			if items, ok := literalListOf(a.Expr, file); ok {
				candidates.awsAllowedAccountIDs = append(candidates.awsAllowedAccountIDs, listCandidate{items, aliased})
			}
		}
	case "azurerm":
		if a, ok := attrs["location"]; ok {
			if lv, ok := literalOf(a.Expr, file); ok {
				candidates.azureLocation = append(candidates.azureLocation, scalarCandidate{lv, aliased})
			}
		}
		if a, ok := attrs["subscription_id"]; ok {
			if lv, ok := literalOf(a.Expr, file); ok {
				candidates.azureSubscriptionID = append(candidates.azureSubscriptionID, scalarCandidate{lv, aliased})
			}
		}
		if a, ok := attrs["tenant_id"]; ok {
			if lv, ok := literalOf(a.Expr, file); ok {
				candidates.azureTenantID = append(candidates.azureTenantID, scalarCandidate{lv, aliased})
			}
		}
	}
}

// recordRequiredProvidersIdentity walks a terraform{} block's required_providers
// purely to detect a RECOGNIZED cloud provider TYPE (aws/azurerm) for the
// providerConfig census. Deliberately a SEPARATE walk from scanRequiredProviders
// (prescan.go — verdict-relevant: PROVIDER_SOURCE/NONSTATIC_SOURCE findings):
// this function never adds a Finding and never influences the verdict, so a
// change here carries zero risk to that function's existing, golden-pinned
// behavior, and vice versa. A provider is recorded even when its source is
// later found off-allowlist (mirrors the pre-existing ProviderPins census,
// which is also recorded unconditionally, prescan.go's scanRequiredProviders)
// — this is report data, not a trust signal.
func recordRequiredProvidersIdentity(candidates *identityCandidates, terraformBody hcl.Body, file string) {
	content, _, _ := terraformBody.PartialContent(requiredProvidersSchema)
	for _, rp := range content.Blocks {
		attrs, _ := rp.Body.JustAttributes()
		names := make([]string, 0, len(attrs))
		for name := range attrs {
			names = append(names, name)
		}
		sort.Strings(names) // deterministic order, mirrors scanRequiredProviders
		for _, name := range names {
			a := attrs[name]
			typ, ok := providerTypeOf(name, a.Expr)
			if !ok {
				continue
			}
			candidates.addProvider(typ, file, a.NameRange.Start.Line)
		}
	}
}

// providerTypeOf resolves the recognized cloud provider TYPE ("aws" or
// "azurerm") for one required_providers entry, fail-closed: any non-static
// piece (source/version referencing a variable/local) yields ("", false) —
// the same Variables()/staticString all-or-nothing check scanRequiredProviders
// uses, duplicated here deliberately (see recordRequiredProvidersIdentity)
// rather than shared, so a future change to the verdict-relevant walk can
// never silently change this one.
func providerTypeOf(localName string, expr hcl.Expression) (string, bool) {
	pairs, diags := hcl.ExprMap(expr)
	if diags.HasErrors() {
		// Legacy string-pin form (aws = "~> 6.0"): no source to read — derive
		// the type from the local attribute name itself, only when it IS
		// already a recognized type name.
		return recognizedProviderType(localName)
	}
	for _, kv := range pairs {
		k, ok := staticString(kv.Key)
		if !ok || k != "source" {
			continue
		}
		if len(kv.Value.Variables()) > 0 {
			return "", false // non-static source: fail closed, omit
		}
		s, ok := staticString(kv.Value)
		if !ok {
			return "", false
		}
		return recognizedProviderType(lastSourceSegment(s))
	}
	// No `source` attribute in the object form: fall back to the local name,
	// same rule as the legacy-string-form branch above.
	return recognizedProviderType(localName)
}

func lastSourceSegment(source string) string {
	parts := strings.Split(source, "/")
	return parts[len(parts)-1]
}

func recognizedProviderType(name string) (string, bool) {
	switch name {
	case "aws", "azurerm":
		return name, true
	default:
		return "", false
	}
}

// literalOf reports whether expr is a static string literal, returning it
// with file:line provenance. Fail-closed: any variable/local/interpolation/
// non-string anywhere in expr → (_, false) — reuses staticString verbatim
// (prescan.go), never a second evaluation rule to keep in sync.
func literalOf(expr hcl.Expression, file string) (LiteralValue, bool) {
	s, ok := staticString(expr)
	if !ok {
		return LiteralValue{}, false
	}
	return LiteralValue{Value: s, File: file, Line: expr.Range().Start.Line}, true
}

// literalListOf reports whether expr is a list/tuple whose elements are ALL
// static string literals — fail-closed at the WHOLE-ATTRIBUTE granularity
// (mirrors scanRequiredProviders' own source-attribute check): a single
// variable-referencing element anywhere makes expr.Variables() non-empty,
// which omits the ENTIRE field rather than guessing which entries are safe.
// Each returned element still carries ITS OWN file:line (its own token
// position), not the list's.
func literalListOf(expr hcl.Expression, file string) ([]LiteralValue, bool) {
	if len(expr.Variables()) > 0 {
		return nil, false
	}
	elems, diags := hcl.ExprList(expr)
	if diags.HasErrors() {
		return nil, false
	}
	out := make([]LiteralValue, 0, len(elems))
	for _, e := range elems {
		lv, ok := literalOf(e, file)
		if !ok {
			// Should not happen (the parent expression already proved
			// variable-free), but fail closed rather than guess if some
			// exotic element (e.g. a function call) ever reaches here.
			return nil, false
		}
		out = append(out, lv)
	}
	return out, true
}
