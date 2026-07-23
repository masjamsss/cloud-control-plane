// Package edit is the resolution pipeline and codemod dispatch (spec).
// Its init() installs cli.Edit so cli.Run stays the single entrypoint.
package edit

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

func init() { cli.Edit = run }

// transformer takes the located target block and returns the new block bytes, or
// a refusal (code+reason → exit 2), or an internal error (→ exit 1).
type transformer func(op manifests.Op, req *request.Request, loc *hclops.Located) (newBlock []byte, refuseCode, refuseReason string, err error)

// fileTransformer rewrites the whole file (removals and EOF-appends fall outside
// the target block's byte range, so they can't use the block splice).
type fileTransformer func(op manifests.Op, req *request.Request, loc *hclops.Located) (newFile []byte, refuseCode, refuseReason string, err error)

var dispatch = map[string]transformer{
	"set_attribute":             setAttribute,
	"set_attributes":            setAttributes,
	"append_foreach_entry":      appendForeachEntry,
	"remove_foreach_entry":      removeForeachEntry,
	"append_list_entry":         appendListEntry,
	"remove_list_entry":         removeListEntry,
	"append_block":              appendBlock,
	"set_association_attribute": setAssociationAttribute,
	"swap_child_block":          swapChildBlock,
}

var fileDispatch = map[string]fileTransformer{
	"remove_block": removeBlock,
	"moved_block":  movedBlock,
}

// errResolution wraps errors a file-level verb wants mapped to exit 3 (spec:
// resolution/schema error), e.g. a moved{} with identical from/to.
var errResolution = errors.New("resolution error")

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	fs.SetOutput(stderr)
	reqPath := fs.String("request", "", "path to the ccp.request/v1 YAML")
	manifestsDir := fs.String("manifests", "", "directory of ServiceManifest JSONs")
	envDir := fs.String("env", "", "directory of *.tf to edit")
	schemaPath := fs.String("schema", "", "path to the schemadump JSON for the block-append guard (default: auto-discover tools/schemadump/aws-*-schema.json)")
	dryRun := fs.Bool("dry-run", false, "print the diff without writing")
	diffOut := fs.String("diff-out", "", "also write the diff to this path")
	diffPrefix := fs.String("diff-prefix", "environments/prod", "repo-relative dir used for diff a/ b/ labels")
	estateTZ := fs.String("estate-tz", "", estatecfg.FlagUsage)
	if err := fs.Parse(args); err != nil {
		return 3
	}

	// Resolved once, before any verdict (estate-config, ADR-0028).
	cfg, err := estatecfg.Resolve(*estateTZ)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}

	req, err := request.Load(*reqPath, cfg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	ops, err := manifests.LoadDir(*manifestsDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	op, ok := ops[req.Item]
	if !ok {
		fmt.Fprintf(stderr, "unknown op %q\n", req.Item)
		return 3
	}
	inPlaceFn, hasInPlace := dispatch[op.CodemodOp]
	fileFn, hasFile := fileDispatch[op.CodemodOp]
	_, isInstantiate := instantiateHandlers[op.CodemodOp]
	_, isCreate := createHandlers[op.CodemodOp]
	if !hasInPlace && !hasFile && !isInstantiate && !isCreate {
		fmt.Fprintf(stderr, "unknown codemodOp %q\n", op.CodemodOp)
		return 3
	}

	// spec: re-validate bounds. Violation refuses before the file is read.
	if code, reason := manifests.Validate(op, req.Params); code != "" {
		return cli.Refuse(stderr, code, reason)
	}
	// spec: a forces-replace op (destroy+recreate) is engineer-only. It
	// stays REFUSED before any file is opened UNLESS the request carries an explicit typed
	// confirmation that NAMES the exact resource being replaced (the confirmed-override
	// lane). The binding — confirmation == the op's target address — is proven here,
	// pre-file-open, so an absent OR mismatched confirmation refuses without reading any
	// HCL, and a confirmation for one resource can never be replayed onto another. The op
	// stays engineer_only; every other guard (bounds above, plan-check R1-R7 downstream)
	// still binds; PREVENT_DESTROY is re-checked AFTER the block is located (below) and is
	// NEVER overridable — a lifecycle.prevent_destroy target refuses regardless.
	if op.ForcesReplace {
		addr, _ := targetAddress(op, req.Params)
		if !replaceConfirmed(req, addr) {
			return cli.Refuse(stderr, "FORCES_REPLACE", fmt.Sprintf("%s forces a destroy+recreate (engineer-only) — no typed confirmation naming %s", op.ID, addr))
		}
	}

	// instantiate_module (spec + frozen): existence check, no in-place target.
	if isInstantiate {
		code, reason := instantiateModule(op, req, *envDir)
		return cli.Refuse(stderr, code, reason) // v1: always a refusal
	}

	// spec: resolve {param:<discriminator>} tokens in Target.Path /
	// Target.Block / Params[i].Attr ONCE, pre-dispatch, so every verb below (descend,
	// guards, AttrFor) works on concrete names. Fail-closed on an unmapped value or a
	// malformed token — nil bytes, tree untouched, before any file is opened.
	op, rcode, rreason := manifests.ResolveTarget(op, req.Params)
	if rcode != "" {
		return cli.Refuse(stderr, rcode, rreason)
	}

	// Guardrail attrs (role:"const"/"key" params — http_tokens="required", an EFS
	// creation_token) the reviewer MUST see unmasked in the evidence diff even
	// though their name trips the secret-substring rule. Mirrors the SPA skeleton's
	// neverMaskAttrs. Value-shape masking still applies,
	// and a sensitive-flagged attr stays masked (sensitive wins, inside RedactWith).
	redactOpts := hclops.RedactOptions{NeverMaskAttrs: neverMaskAttrsFor(op)}

	// create_resource: the pre-locate ACCEPT branch. A create has no
	// located target block (the resource does not exist yet), so it is placed here —
	// after the shared preamble (Validate bounds, ForcesReplace, ResolveTarget) but
	// BEFORE targetAddress/Locate/FmtCanonical (which have no inventory target for a
	// create and would exit 3). It authors net-new resource block(s) at EOF of the
	// service file and rides the same redact-both-sides diff + atomic-write output as
	// the file transformers. A create's diff is all-additions.
	if isCreate {
		idx, serr := resolveSchemaIndex(*schemaPath, *envDir, op.Target.ResourceType)
		if serr != nil {
			fmt.Fprintf(stderr, "schema: %v\n", serr) // only an explicit, unreadable --schema
			return 3
		}
		newFile, targetFile, orig, refuseCode, refuseReason, cerr := createResource(op, req, *envDir, idx)
		if refuseCode != "" {
			return cli.Refuse(stderr, refuseCode, refuseReason)
		}
		if cerr != nil {
			fmt.Fprintln(stderr, cerr)
			if errors.Is(cerr, errResolution) {
				return 3 // a reference/schema resolution failure → exit 3 (value.go seam)
			}
			return 1
		}
		if bytes.Equal(newFile, orig) {
			return 0 // verified no-op (defensive — a create always adds content)
		}
		label := filepath.ToSlash(filepath.Join(*diffPrefix, filepath.Base(targetFile)))
		diff := hclops.UnifiedDiff(label, label, hclops.RedactWith(orig, redactOpts), hclops.RedactWith(newFile, redactOpts))
		if !*dryRun {
			if err := atomicWrite(targetFile, newFile); err != nil {
				fmt.Fprintln(stderr, err)
				return 1
			}
		}
		if _, err := stdout.Write(diff); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if *diffOut != "" {
			if err := os.WriteFile(*diffOut, diff, 0o644); err != nil {
				fmt.Fprintln(stderr, err)
				return 1
			}
		}
		return 0
	}

	// schema-aware block-append guard. An append_block that names a
	// nested block the resource type's provider schema does not declare emits
	// schema-invalid HCL at exit 0 (iam-attach-managed-policy → policy_attachment on
	// aws_iam_role). Refuse here, pre-dispatch and pre-file-open, alongside the other
	// fail-closed gates above; guardKnownBlock defers to the in-verb structural guards
	// for empty/malformed/aws_ blocks and fails open when the schema cannot verify.
	if op.CodemodOp == "append_block" {
		idx, err := resolveSchemaIndex(*schemaPath, *envDir, op.Target.ResourceType)
		if err != nil {
			fmt.Fprintf(stderr, "schema: %v\n", err) // only an explicit, unreadable --schema
			return 3
		}
		if code, reason := guardKnownBlock(op, idx); code != "" {
			return cli.Refuse(stderr, code, reason)
		}
	}

	address, err := targetAddress(op, req.Params)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	loc, err, code := hclops.Locate(*envDir, address)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return code
	}
	if !hclops.FmtCanonical(loc.Bytes) {
		return cli.Refuse(stderr, "FMT_DIRTY", fmt.Sprintf("%s is not fmt-canonical", filepath.Base(loc.File)))
	}

	// PREVENT_DESTROY is NEVER overridable — no confirmation, no exception. Even a
	// confirmed forces-replace refuses a resource protected by lifecycle.prevent_destroy:
	// Terraform itself refuses to replace such a block, and the tool must never author a
	// change that assumes otherwise. Checked here because prevent_destroy is only knowable
	// once the target block is read (the pre-file-open forces-replace gate above cannot see
	// it). remove_block already refuses prevent_destroy inside its own verb; this closes the
	// same veto for the set_attribute / append_block forces-replace shapes.
	if op.ForcesReplace && hasPreventDestroy(loc.Bytes[loc.Start:loc.End]) {
		return cli.Refuse(stderr, "PREVENT_DESTROY", fmt.Sprintf("%s is protected by lifecycle.prevent_destroy — a forces-replace override can never replace it", address))
	}

	orig := loc.Bytes
	var newFile []byte
	if hasInPlace {
		newBlock, refuseCode, refuseReason, err := inPlaceFn(op, req, loc)
		if refuseCode != "" {
			return cli.Refuse(stderr, refuseCode, refuseReason)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			// A reference/schema failure (valueTokens) is a resolution
			// error → exit 3, mirroring the file-transformer branch below.
			if errors.Is(err, errResolution) {
				return 3
			}
			return 1
		}
		if bytes.Equal(newBlock, orig[loc.Start:loc.End]) {
			return 0 // verified no-op (spec): exit 0, empty diff, no write
		}
		nb, err := hclops.Splice(orig, loc.Start, loc.End, newBlock)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		// spec invariant (defense in depth): only [Start, Start+len(newBlock)) changed.
		if !bytes.Equal(nb[:loc.Start], orig[:loc.Start]) ||
			!bytes.Equal(nb[loc.Start+len(newBlock):], orig[loc.End:]) {
			fmt.Fprintln(stderr, "internal: changed-set invariant violated")
			return 1
		}
		newFile = nb
	} else {
		nf, refuseCode, refuseReason, err := fileFn(op, req, loc)
		if refuseCode != "" {
			return cli.Refuse(stderr, refuseCode, refuseReason)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			if errors.Is(err, errResolution) {
				return 3
			}
			return 1
		}
		if bytes.Equal(nf, orig) {
			return 0 // verified no-op (spec)
		}
		newFile = nf
	}

	label := filepath.ToSlash(filepath.Join(*diffPrefix, filepath.Base(loc.File)))
	// Redact both sides BEFORE diffing so every emitted diff line (stdout AND
	// --diff-out below) masks secrets identically to the SPA's display guard — the
	// evidence archive can no longer diverge and leak a cleartext token (e.g.
	// environments/prod/lambda.tf:141) that sits near an edit as context. The applied
	// file written to disk (atomicWrite below) stays the real, unredacted HCL.
	diff := hclops.UnifiedDiff(label, label, hclops.RedactWith(orig, redactOpts), hclops.RedactWith(newFile, redactOpts))

	if !*dryRun {
		if err := atomicWrite(loc.File, newFile); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	if _, err := stdout.Write(diff); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if *diffOut != "" {
		if err := os.WriteFile(*diffOut, diff, 0o644); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	return 0
}

// replaceConfirmed reports whether req carries an explicit typed confirmation that NAMES
// exactly the resource address being replaced — the confirmed-override binding for a
// forces-replace op. Because the human types the address, the acknowledgement is of THIS
// specific destroy+recreate and cannot be replayed onto a different target: a confirmation
// whose value differs from the resolved target address is treated as absent. An empty
// address, a nil Confirmations, or a blank/mismatched Replace all return false (the op
// refuses, unchanged from the pre-override behaviour).
func replaceConfirmed(req *request.Request, address string) bool {
	if address == "" || req.Confirmations == nil || req.Confirmations.Replace == "" {
		return false
	}
	return req.Confirmations.Replace == address
}

// instantiateHandlers marks codemodOps handled by the pre-locate instantiate path.
var instantiateHandlers = map[string]bool{"instantiate_module": true}

// parseSingleBlock reparses the located block bytes as an editable hclwrite tree.
func parseSingleBlock(loc *hclops.Located) (*hclwrite.File, *hclwrite.Block, error) {
	f, diags := hclwrite.ParseConfig(loc.Bytes[loc.Start:loc.End], loc.File, hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return nil, nil, fmt.Errorf("parse block: %s", diags.Error())
	}
	blks := f.Body().Blocks()
	if len(blks) != 1 {
		return nil, nil, fmt.Errorf("expected exactly one block, got %d", len(blks))
	}
	return f, blks[0], nil
}

// nonInvParams returns the op's value params: source != "inventory" and neither a
// role:"selector" (a selector addresses a block) nor a role:"discriminator" (
// a discriminator picks WHICH block/attr is edited — it is never an operation value).
func nonInvParams(op manifests.Op) []manifests.Param {
	var out []manifests.Param
	for _, p := range op.Params {
		if p.Source != "inventory" && p.Role != "selector" && p.Role != "discriminator" {
			out = append(out, p)
		}
	}
	return out
}

// neverMaskAttrsFor returns the leaf attribute names of an op's role:"const" and
// role:"key" params (skipping any flagged sensitive) — the machine-checkable
// guardrails and identity names the reviewer must see UNMASKED in the evidence
// diff even when the name trips the secret-substring rule (http_tokens,
// creation_token). Mirrors ccp/app/src/lib/hclSkeleton.ts neverMaskAttrsOf.
func neverMaskAttrsFor(op manifests.Op) []string {
	var out []string
	for _, p := range op.Params {
		if (p.Role != "const" && p.Role != "key") || p.Sensitive {
			continue
		}
		attr := p.Attr
		if attr == "" {
			attr = p.Name
		}
		if i := strings.LastIndexByte(attr, '.'); i >= 0 {
			attr = attr[i+1:]
		}
		out = append(out, attr)
	}
	return out
}

// origBlock returns the unmodified block bytes (used to signal a no-op).
func origBlock(loc *hclops.Located) []byte {
	return loc.Bytes[loc.Start:loc.End]
}

// targetAddress returns the value of the op's inventory target param (spec
// ): the first source:"inventory" param whose Role is not "reference" (
// a reference param is also source:"inventory" but names a *different* resource to
// read a value from, not the block being edited).
func targetAddress(op manifests.Op, params map[string]any) (string, error) {
	for _, p := range op.Params {
		if p.Source == "inventory" && p.Role != "reference" {
			v, ok := params[p.Name]
			if !ok {
				return "", fmt.Errorf("missing inventory param %q", p.Name)
			}
			s, ok := v.(string)
			if !ok {
				return "", fmt.Errorf("inventory param %q is not a string", p.Name)
			}
			return s, nil
		}
	}
	return "", fmt.Errorf("op %q has no inventory param", op.ID)
}

// atomicWrite writes data via a temp file + rename in the target's directory (spec: never a partial edit).
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".catalogctl-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}
