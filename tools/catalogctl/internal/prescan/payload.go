package prescan

import (
	"sort"

	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// payload.go is the narrow sibling of Scan, spec
// 2026-07-20-ccp-oob-provisioning-import.md §5.3a: "the same no-execution
// static gate internal/onboard runs before trusting a repo, narrowed to the
// two block types an import payload may legally contain." Unlike Scan, it
// never touches disk — the payload (an import{} block plus a resource{}
// skeleton, importer/kit/payloads.py's attachment shape) is already in
// memory; driftpropose's shared helper (payloadprescan.go) wraps this walk
// and adds the secret battery on top.

// Additional finding codes, payload-scan only.
const (
	CodeParseFailed     = "PARSE_FAILED"
	CodeDisallowedBlock = "DISALLOWED_BLOCK"
	CodeNonLiteralExpr  = "NONLITERAL_EXPR"
)

// payloadBlocks is the closed set of top-level block types an import payload
// may legally contain (spec §5.3a): the import block gen-imports.py emits,
// and the resource skeleton `-generate-config-out` emits. Anything else —
// data/module/provider/terraform/locals/variable/output, or any other block
// type — is DISALLOWED_BLOCK. Terraform's own grammar has no way to nest a
// top-level block type (data/module/provider/…) inside another block, so
// gating the TOP LEVEL alone keeps all of them out wherever they might
// otherwise appear.
var payloadBlocks = map[string]bool{"import": true, "resource": true}

// ScanPayload statically inspects src — an already-in-memory HCL source,
// never written to disk — as an import-payload candidate:
//
//   - parse must succeed (CodeParseFailed);
//   - every top-level block must be "import" or "resource" (CodeDisallowedBlock);
//   - every resource (and, belt-and-braces, import) body is walked for
//     provisioner/connection/dynamic-provisioner blocks exactly as Scan's
//     own onboard walk does — scanForProvisioners, verbatim reuse
//     (CodeProvisioner);
//   - every attribute expression anywhere in the parsed body — EXCEPT an
//     import block's own `to` attribute, which is structurally a resource
//     address reference in Terraform's grammar, never a literal — must be a
//     pure literal/constructor with no variable/resource/data traversal
//     anywhere in its expression tree (CodeNonLiteralExpr):
//     `-generate-config-out` emits literals only, so a clean payload never
//     trips this.
//
// filename is used only for diagnostic positions; ScanPayload never reads
// from or writes to disk.
func ScanPayload(filename string, src []byte) (Report, error) {
	rep := Report{Repo: filename, Findings: []Finding{}, ProviderPins: map[string]string{}}

	parser := hclparse.NewParser()
	file, diags := parser.ParseHCL(src, filename)
	if diags.HasErrors() || file == nil {
		addFinding(&rep, CodeParseFailed, filename, 1)
		rep.Verdict = "reject"
		return rep, nil
	}
	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		addFinding(&rep, CodeParseFailed, filename, 1)
		rep.Verdict = "reject"
		return rep, nil
	}

	for _, blk := range body.Blocks {
		line := blk.TypeRange.Start.Line
		if !payloadBlocks[blk.Type] {
			addFinding(&rep, CodeDisallowedBlock, filename, line)
			continue
		}
		switch blk.Type {
		case "resource":
			rep.ResourceBlocks++
			scanForProvisioners(blk.Body, filename, &rep)
			scanLiteralsOnly(blk.Body, filename, "", &rep)
		case "import":
			scanForProvisioners(blk.Body, filename, &rep)
			scanLiteralsOnly(blk.Body, filename, "to", &rep)
		}
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

// scanLiteralsOnly recursively walks body's attributes and nested blocks,
// flagging any attribute expression that references a variable, local,
// resource, or data source (hcl.Expression.Variables() — the traversal roots
// an expression touches) as CodeNonLiteralExpr. exemptAttr (empty ⇒ none)
// names the ONE attribute this body's top level is allowed to carry a
// traversal on — the import block's `to`.
func scanLiteralsOnly(body *hclsyntax.Body, file, exemptAttr string, rep *Report) {
	names := make([]string, 0, len(body.Attributes))
	for name := range body.Attributes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if name == exemptAttr {
			continue
		}
		attr := body.Attributes[name]
		if len(attr.Expr.Variables()) > 0 {
			addFinding(rep, CodeNonLiteralExpr, file, attr.SrcRange.Start.Line)
		}
	}
	for _, blk := range body.Blocks {
		scanLiteralsOnly(blk.Body, file, "", rep)
	}
}
