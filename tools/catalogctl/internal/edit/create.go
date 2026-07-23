package edit

// create.go is the `create_resource` verb: the pre-locate ACCEPT branch
// that authors net-new top-level `resource` block(s) at EOF of the service file. It
// is the sibling of instantiate_module's pre-locate REFUSE branch (instantiate.go)
// — a create has no located target block (the resource does not exist yet), so it
// never rides the Locate/splice path the in-place verbs use.
//
// It reuses the estate's safety seams verbatim: the closed idiom TABLE and the
// name sanitizer live in internal/idioms (shared with the plancheck create-guard so
// "what the verb emits" and "what the plan proves" can never drift); the reference
// value seam (value.go#valueTokens: REFERENCE_TYPE_MISMATCH + existence/uniqueness)
// validates every co-emitted reference; the render is the byte-identical port of
// hclSkeleton.ts (idiomrender.go). The ONLY net-new authored HCL surface is the
// closed idiom topology and the local name as a top-level identity — both closed
// (fixed table; tfLocalName + ALREADY_EXISTS).

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/idioms"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// createHandlers marks the codemodOp handled by the pre-locate create ACCEPT path
// (sibling of instantiateHandlers). Unlike instantiate, a create returns file bytes.
var createHandlers = map[string]bool{"create_resource": true}

// createResource authors the new service-file bytes for a create op. It
// is pure except for reading --env (reference/collision checks) and the target
// service file. Returns:
//   - newFile: the whole new file bytes (orig ++ appended, or the skeleton alone
//     when the service file does not yet exist) — the changed-set invariant
//     newFile[:len(orig)] == orig is re-proven before return;
//   - targetFile: <envDir>/<service>.tf (the file that is written / diffed);
//   - orig: the pre-existing service-file bytes ("" when it is created fresh) — the
//     "before" side of the redact-both-sides diff;
//   - (refuseCode, refuseReason): an exit-2 REFUSE (ALREADY_EXISTS,
//     REFERENCE_TYPE_MISMATCH, FMT_DIRTY, a guard) with nil bytes, tree untouched;
//   - err: a resolution error (errResolution → exit 3) or internal error (exit 1).
func createResource(op manifests.Op, req *request.Request, envDir string, idx *nestedBlockIndex) (newFile []byte, targetFile string, orig []byte, refuseCode, refuseReason string, err error) {
	if op.Service == "" {
		return nil, "", nil, "", "", fmt.Errorf("create_resource op %q has no service to target a file", op.ID)
	}

	// 1+2. Local name (the single role:"key" param) and the idiom's address set — the
	// SAME functions the plancheck create-guard uses (idioms), so the emitted labels
	// and the proven plan addresses cannot drift.
	localName := idioms.TfLocalName(keyParamValue(op, req.Params))
	addrs := idioms.Addresses(op.Target.ResourceType, localName, req.Params)

	// 3. Existence gate — the create's edit-time ALREADY_EXISTS inversion
	// (instantiate.go:18), WIDENED to every idiom address (mandatory ∪ conditional):
	// a bucket, its PAB, its SSE config, an attachment — any one already present ⇒ refuse.
	for _, a := range addrs.All() {
		if _, _, code := hclops.Locate(envDir, a); code == 0 {
			return nil, "", nil, "ALREADY_EXISTS", fmt.Sprintf("%s already exists in the environment", a), nil
		}
	}

	// 4. Resolve values through the shared reference seam: every co-emitted reference
	// (attach_to, kms_key, vault, vpc, subnet_group, security groups) flows through
	// valueTokens, so REFERENCE_TYPE_MISMATCH (exit 2) and existence/uniqueness (exit 3)
	// gate the create exactly as they gate every other reference-bearing codemod. The
	// tokens are discarded — the byte-identical render (step 5) authors the value — but
	// the VALIDATION is reused unchanged. Empty/inactive references are not
	// emitted (isEmptyValue / dependsOn), so they are not validated either — matching
	// the renderer, and avoiding a spurious refusal on an omitted optional key.
	if code, reason, verr := validateCreateReferences(op, req, envDir); verr != nil || code != "" {
		return nil, "", nil, code, reason, verr
	}

	// 5. Compose + render (idiomrender.go — the byte-identical hclSkeleton.ts port).
	skeleton, blocks, _ := renderCreateSkeleton(op, req.Params)

	// Guards on the emitted-from-scratch blocks: every top-level label is a
	// schema-real aws_* type with an ident-safe name (guard #2, invert-sense), and
	// every emitted nested block is declared by the provider schema (guard #1, widened).
	if code, reason := guardCreateLabels(blocks); code != "" {
		return nil, "", nil, code, reason, nil
	}
	if code, reason := guardCreateBlocks(blocks, idx); code != "" {
		return nil, "", nil, code, reason, nil
	}

	// 6. Emit: append the block set at EOF of <service>.tf (created iff absent). The
	// output is NOT re-formatted — it is
	// byte-identical to the DRAFT the L1 saw; the engineer terraform-fmts their PR.
	targetFile = filepath.Join(envDir, op.Service+".tf")
	existing, readErr := os.ReadFile(targetFile)
	switch {
	case readErr == nil:
		orig = existing
		if len(orig) > 0 && !hclops.FmtCanonical(orig) {
			return nil, "", nil, "FMT_DIRTY", fmt.Sprintf("%s is not fmt-canonical", filepath.Base(targetFile)), nil
		}
	case os.IsNotExist(readErr):
		orig = nil
	default:
		return nil, "", nil, "", "", readErr
	}

	appended := skeletonAppend(orig, skeleton)
	newFile = append(append([]byte{}, orig...), appended...)

	// re-prove the changed-set invariant (an EOF-append never rewrites a
	// pre-existing byte): newFile[:len(orig)] == orig.
	if !bytes.Equal(newFile[:len(orig)], orig) {
		return nil, "", nil, "", "", fmt.Errorf("internal: create changed-set invariant violated")
	}
	return newFile, targetFile, orig, "", "", nil
}

// skeletonAppend returns the bytes appended after orig: the skeleton plus a trailing
// newline, preceded by one blank line when orig already holds content (
// "one blank line before the first block"). A brand-new file gets no leading blank.
func skeletonAppend(orig []byte, skeleton string) []byte {
	if len(orig) == 0 {
		return []byte(skeleton + "\n")
	}
	sep := "\n" // orig ends with a newline (fmt-canonical) → one extra \n = the blank line
	if !bytes.HasSuffix(orig, []byte("\n")) {
		sep = "\n\n" // finish orig's last line, then the blank line
	}
	return []byte(sep + skeleton + "\n")
}

// validateCreateReferences runs every co-emitted reference through the shared value
// seam (value.go#valueTokens) purely for its VALIDATION side effects — the emitted
// bytes come from the byte-identical renderer, not these tokens. A list reference is
// checked element-by-element (valueTokens is scalar-shaped). Empty/inactive
// references are skipped so they match the renderer's omit-if-absent behaviour.
func validateCreateReferences(op manifests.Op, req *request.Request, envDir string) (string, string, error) {
	for _, p := range op.Params {
		if p.Role != "reference" {
			continue
		}
		if !isParamActive(p, req.Params) {
			continue
		}
		raw, present := req.Params[p.Name]
		if !present || isEmptyValue(raw) {
			continue
		}
		for _, elem := range refElements(raw) {
			if isEmptyValue(elem) {
				continue
			}
			if _, code, reason, err := valueTokens(envDir, p, elem); err != nil || code != "" {
				return code, reason, err
			}
		}
	}
	return "", "", nil
}

// refElements returns the element(s) of a reference value: a list yields its members,
// a scalar yields itself.
func refElements(raw any) []any {
	if arr, ok := raw.([]any); ok {
		return arr
	}
	return []any{raw}
}
