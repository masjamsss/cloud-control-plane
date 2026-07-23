// Package prescan is the untrusted-repo static safety gate (spec).
//
// It parses a repo's Terraform with hashicorp/hcl/v2 and NOTHING is executed —
// no terraform init, no provider download, no expression evaluation of user
// input. It walks BOTH *.tf (ParseHCL) and *.tf.json (ParseJSON): a provisioner
// hidden in JSON syntax is caught the same as in native HCL. The
// order in the onboard orchestrator is the security property; this package is
// step 0 of it — it runs before any trust decision and before any runner call.
//
// Reject rules (spec):
//
//	data "external"                         → DATA_EXTERNAL
//	any provisioner block (nested anywhere) → PROVISIONER
//	required_providers source ∉ allowlist   → PROVIDER_SOURCE
//	module source not relative/allowlisted  → MODULE_SOURCE
//	any provider/module source not a static → NONSTATIC_SOURCE (fail-closed)
//	string literal (var/local/expr)
//
// Any finding ⇒ verdict "reject". The Report also carries onboard-time census
// fields (resource/module/tf.json/fmt-dirty counts, provider pins) that are
// report data, never verdict inputs.
package prescan

import (
	"bytes"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

// DefaultProviderAllowlist is the fail-closed default when a project declares
// none: only the canonical HashiCorp namespace on the public registry.
var DefaultProviderAllowlist = []string{"registry.terraform.io/hashicorp/*"}

// Finding codes.
const (
	CodeDataExternal    = "DATA_EXTERNAL"
	CodeProvisioner     = "PROVISIONER"
	CodeProviderSource  = "PROVIDER_SOURCE"
	CodeModuleSource    = "MODULE_SOURCE"
	CodeNonStaticSource = "NONSTATIC_SOURCE"
)

// Finding is a single rejected construct located in the repo.
type Finding struct {
	Code string `json:"code"` // DATA_EXTERNAL | PROVISIONER | PROVIDER_SOURCE | MODULE_SOURCE | NONSTATIC_SOURCE
	File string `json:"file"` // repo-relative
	Line int    `json:"line"`
}

// Report is the byte-exact prescan output. Findings drive the verdict; the
// census fields are onboard report data.
type Report struct {
	Repo           string            `json:"repo"`
	Verdict        string            `json:"verdict"` // "clean" | "reject"
	Findings       []Finding         `json:"findings"`
	ResourceBlocks int               `json:"resourceBlocks"`
	ModuleBlocks   int               `json:"moduleBlocks"`
	TfJsonFiles    int               `json:"tfJsonFiles"`
	FmtDirtyFiles  int               `json:"fmtDirtyFiles"`
	ProviderPins   map[string]string `json:"providerPins"`
}

// rootSchema captures the top-level Terraform blocks prescan reasons about.
// Unlisted blocks land in PartialContent's remain and are ignored.
var rootSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "resource", LabelNames: []string{"type", "name"}},
		{Type: "data", LabelNames: []string{"type", "name"}},
		{Type: "module", LabelNames: []string{"name"}},
		{Type: "terraform"},
		{Type: "provisioner", LabelNames: []string{"type"}}, // illegal at top level, still flagged
	},
}

// provisionerSchema is used to hunt provisioners nested inside a resource (and
// any dynamic/content/connection container that could generate or wrap one).
var provisionerSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "provisioner", LabelNames: []string{"type"}},
		{Type: "connection"},
		{Type: "content"},
		{Type: "dynamic", LabelNames: []string{"name"}},
	},
}

var requiredProvidersSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{{Type: "required_providers"}},
}

// Scan statically inspects the repo rooted at root. It never executes anything.
// A nil/empty allowlist falls back to DefaultProviderAllowlist.
func Scan(root string, providerAllowlist []string) (Report, error) {
	if len(providerAllowlist) == 0 {
		providerAllowlist = DefaultProviderAllowlist
	}
	rep := Report{
		Repo:         filepath.Base(root),
		Findings:     []Finding{},
		ProviderPins: map[string]string{},
	}

	var files []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".terraform", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if strings.HasSuffix(name, ".tf") || strings.HasSuffix(name, ".tf.json") {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return Report{}, err
	}
	sort.Strings(files) // deterministic file order

	parser := hclparse.NewParser()
	for _, p := range files {
		src, err := os.ReadFile(p)
		if err != nil {
			return Report{}, err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			rel = p
		}
		rel = filepath.ToSlash(rel)

		isJSON := strings.HasSuffix(p, ".tf.json")
		var file *hcl.File
		var diags hcl.Diagnostics
		if isJSON {
			rep.TfJsonFiles++
			file, diags = parser.ParseJSON(src, rel)
		} else {
			// fmt-dirty census is native-syntax only (hclwrite is the fmt terraform delegates to).
			if !bytes.Equal(hclwrite.Format(src), src) {
				rep.FmtDirtyFiles++
			}
			file, diags = parser.ParseHCL(src, rel)
		}
		if diags.HasErrors() || file == nil {
			// A file that will not parse cannot be verified; the sandboxed
			// terraform init (a later, trust-gated step) surfaces it. Skip here.
			continue
		}
		scanBody(file.Body, rel, providerAllowlist, &rep)
	}

	sort.SliceStable(rep.Findings, func(i, j int) bool {
		a, b := rep.Findings[i], rep.Findings[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Code < b.Code
	})

	if len(rep.Findings) > 0 {
		rep.Verdict = "reject"
	} else {
		rep.Verdict = "clean"
	}
	return rep, nil
}

func scanBody(body hcl.Body, file string, allow []string, rep *Report) {
	content, _, _ := body.PartialContent(rootSchema)
	for _, b := range content.Blocks {
		switch b.Type {
		case "resource":
			rep.ResourceBlocks++
			scanForProvisioners(b.Body, file, rep)
		case "data":
			if len(b.Labels) > 0 && b.Labels[0] == "external" {
				addFinding(rep, CodeDataExternal, file, b.DefRange.Start.Line)
			}
		case "module":
			rep.ModuleBlocks++
			checkSource(b.Body, file, allow, true, rep)
		case "terraform":
			scanRequiredProviders(b.Body, file, allow, rep)
		case "provisioner":
			addFinding(rep, CodeProvisioner, file, b.DefRange.Start.Line)
		}
	}
}

// scanForProvisioners flags any provisioner reachable from a resource body,
// including one generated via `dynamic "provisioner"`. Works identically for
// native and JSON bodies (both satisfy hcl.Body).
func scanForProvisioners(body hcl.Body, file string, rep *Report) {
	content, _, _ := body.PartialContent(provisionerSchema)
	for _, b := range content.Blocks {
		switch b.Type {
		case "provisioner":
			addFinding(rep, CodeProvisioner, file, b.DefRange.Start.Line)
		case "dynamic":
			if len(b.Labels) > 0 && b.Labels[0] == "provisioner" {
				addFinding(rep, CodeProvisioner, file, b.DefRange.Start.Line)
			}
			scanForProvisioners(b.Body, file, rep)
		case "connection", "content":
			scanForProvisioners(b.Body, file, rep)
		}
	}
}

func scanRequiredProviders(terraformBody hcl.Body, file string, allow []string, rep *Report) {
	content, _, _ := terraformBody.PartialContent(requiredProvidersSchema)
	for _, rp := range content.Blocks {
		attrs, _ := rp.Body.JustAttributes()
		names := make([]string, 0, len(attrs))
		for name := range attrs {
			names = append(names, name)
		}
		sort.Strings(names) // deterministic finding order
		for _, name := range names {
			a := attrs[name]
			pairs, diags := hcl.ExprMap(a.Expr)
			if diags.HasErrors() {
				// Legacy string form (aws = "~> 6.0"): record pin, no source to check.
				if v, ok := staticString(a.Expr); ok {
					rep.ProviderPins[name] = v
				}
				continue
			}
			var srcExpr hcl.Expression
			for _, kv := range pairs {
				k, ok := staticString(kv.Key)
				if !ok {
					continue
				}
				switch k {
				case "source":
					srcExpr = kv.Value
				case "version":
					if v, ok := staticString(kv.Value); ok {
						rep.ProviderPins[name] = v
					}
				}
			}
			if srcExpr == nil {
				continue
			}
			if len(srcExpr.Variables()) > 0 {
				addFinding(rep, CodeNonStaticSource, file, srcExpr.Range().Start.Line)
				continue
			}
			s, ok := staticString(srcExpr)
			if !ok {
				addFinding(rep, CodeNonStaticSource, file, srcExpr.Range().Start.Line)
				continue
			}
			if !providerSourceAllowed(s, allow) {
				addFinding(rep, CodeProviderSource, file, srcExpr.Range().Start.Line)
			}
		}
	}
}

// checkSource validates a block's `source` attribute (module here). A source
// that references a variable/local/expression is non-static and fails closed.
func checkSource(body hcl.Body, file string, allow []string, isModule bool, rep *Report) {
	attrs, _ := body.JustAttributes()
	a, ok := attrs["source"]
	if !ok {
		return
	}
	line := a.Expr.Range().Start.Line
	if len(a.Expr.Variables()) > 0 {
		addFinding(rep, CodeNonStaticSource, file, line)
		return
	}
	s, ok := staticString(a.Expr)
	if !ok {
		addFinding(rep, CodeNonStaticSource, file, line)
		return
	}
	if isModule && !moduleSourceAllowed(s, allow) {
		addFinding(rep, CodeModuleSource, file, line)
	}
}

// staticString reports whether expr is a variable-free literal string and
// returns its value. Anything referencing a variable/local, or that fails to
// evaluate against a nil context, is treated as non-static.
func staticString(expr hcl.Expression) (string, bool) {
	if len(expr.Variables()) > 0 {
		return "", false
	}
	v, diags := expr.Value(nil)
	if diags.HasErrors() || v.IsNull() || v.Type() != cty.String {
		return "", false
	}
	return v.AsString(), true
}

// providerSourceAllowed glob-matches a provider source against the allowlist.
// A two-segment short form (hashicorp/aws) is normalized to the public registry.
func providerSourceAllowed(source string, allow []string) bool {
	norm := source
	if parts := strings.Split(source, "/"); len(parts) == 2 {
		norm = "registry.terraform.io/" + source
	}
	for _, glob := range allow {
		if ok, _ := path.Match(glob, norm); ok {
			return true
		}
	}
	return false
}

// moduleSourceAllowed accepts a relative path or a registry module whose
// host/namespace matches the allowlist. Every VCS/HTTP/bucket source (git::,
// github.com/…, https://…, .git, s3::, gcs::) fails closed.
func moduleSourceAllowed(source string, allow []string) bool {
	if source == "." || strings.HasPrefix(source, "./") || strings.HasPrefix(source, "../") {
		return true
	}
	if strings.Contains(source, "::") || strings.HasSuffix(source, ".git") ||
		strings.HasPrefix(source, "git@") ||
		strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") ||
		strings.HasPrefix(source, "github.com/") || strings.HasPrefix(source, "bitbucket.org/") {
		return false
	}
	// Strip any submodule path ("ns/name/provider//subdir").
	if i := strings.Index(source, "//"); i >= 0 {
		source = source[:i]
	}
	parts := strings.Split(source, "/")
	var host, namespace string
	switch {
	case len(parts) == 3 && !strings.Contains(parts[0], "."):
		host, namespace = "registry.terraform.io", parts[0]
	case len(parts) == 4 && strings.Contains(parts[0], "."):
		host, namespace = parts[0], parts[1]
	default:
		return false // not a recognizable registry address
	}
	for _, glob := range allow {
		gp := strings.Split(glob, "/")
		if len(gp) < 2 || gp[0] != host {
			continue
		}
		if ok, _ := path.Match(gp[1], namespace); ok {
			return true
		}
	}
	return false
}

func addFinding(rep *Report, code, file string, line int) {
	rep.Findings = append(rep.Findings, Finding{Code: code, File: file, Line: line})
}
