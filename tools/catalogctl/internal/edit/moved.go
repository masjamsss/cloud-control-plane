package edit

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// movedBlock relabels the resource and emits a moved{} at EOF of the from-file
// (spec + frozen). forcesReplace is refused by the pipeline before any
// file open; an identical from/to is a resolution error (exit 3).
//
// CTL-2: every other verb that authors a new structural name/address runs it
// through the same three checks this used to skip entirely — a rename verb is
// no different, and skipping them let it write invalid or duplicate-resource
// HCL at exit 0 (verified: `new_name: "bad name!"` produced unparseable HCL;
// renaming onto an address that already existed produced two `resource
// "aws_instance" "app"` blocks, both at exit 0). All three refuse (exit 2,
// tree untouched) rather than guess:
//   - MALFORMED_NEW_NAME — new_name is not a valid HCL identifier
//     (manifests.IsValidBlockIdent, the one canonical name-safety predicate
//     every other verb already funnels structural names through).
//   - ALREADY_EXISTS — the destination address already resolves to a DIFFERENT
//     block in --env (mirrors create_resource/instantiate_module's own
//     pre-write existence gate, same code).
//   - DANGLING_REF — the FROM address is still referenced elsewhere in --env;
//     moved{} rewrites Terraform's own state mapping, never the .tf source, so
//     a stray reference to the old address would fail `terraform plan` after
//     apply ("Reference to undeclared resource") — same check, same code,
//     remove_block already runs against the address it deletes.
func movedBlock(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	from, err := targetAddress(op, req.Params)
	if err != nil {
		return nil, "", "", err
	}
	newName := firstNonInvString(op, req)
	if newName == "" {
		return nil, "", "", fmt.Errorf("moved_block: missing new name param")
	}
	if !manifests.IsValidBlockIdent(newName) {
		return nil, "MALFORMED_NEW_NAME", fmt.Sprintf("new name %q is not a valid HCL identifier — refusing rather than emit unparseable HCL; routed to an engineer", newName), nil
	}
	parts := strings.Split(from, ".")
	if len(parts) != 2 {
		return nil, "", "", fmt.Errorf("moved_block: unsupported from address %q", from)
	}
	to := parts[0] + "." + newName
	if from == to {
		return nil, "", "", fmt.Errorf("%w: moved from == to (%s)", errResolution, from)
	}
	envDir := filepath.Dir(loc.File)
	if _, _, code := hclops.Locate(envDir, to); code == 0 {
		return nil, "ALREADY_EXISTS", fmt.Sprintf("%s already exists in the environment — a moved_block rename can never collide with an existing resource", to), nil
	}
	if danglingRef(envDir, from, loc) {
		return nil, "DANGLING_REF", fmt.Sprintf("%s is still referenced elsewhere in the environment — moved{} rewrites state, not those references", from), nil
	}

	// Relabel the resource block in place.
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	block.SetLabels([]string{parts[0], newName})
	relabeled := hclwrite.Format(f.Bytes())
	spliced, err := hclops.Splice(loc.Bytes, loc.Start, loc.End, relabeled)
	if err != nil {
		return nil, "", "", err
	}

	// Emit moved{} with from/to as traversals (unquoted references).
	mf := hclwrite.NewEmptyFile()
	mv := mf.Body().AppendNewBlock("moved", nil)
	mv.Body().SetAttributeTraversal("from", traversalForAddress(from))
	mv.Body().SetAttributeTraversal("to", traversalForAddress(to))
	movedBytes := hclwrite.Format(mf.Bytes())

	// Append at EOF of the from-file, separated by one blank line.
	newFile := make([]byte, 0, len(spliced)+1+len(movedBytes))
	newFile = append(newFile, spliced...)
	newFile = append(newFile, '\n')
	newFile = append(newFile, movedBytes...)
	return newFile, "", "", nil
}

func firstNonInvString(op manifests.Op, req *request.Request) string {
	for _, p := range nonInvParams(op) {
		if v, ok := req.Params[p.Name].(string); ok {
			return v
		}
	}
	return ""
}

func traversalForAddress(addr string) hcl.Traversal {
	parts := strings.Split(addr, ".")
	tr := hcl.Traversal{hcl.TraverseRoot{Name: parts[0]}}
	for _, p := range parts[1:] {
		tr = append(tr, hcl.TraverseAttr{Name: p})
	}
	return tr
}
