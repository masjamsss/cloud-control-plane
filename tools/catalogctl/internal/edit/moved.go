package edit

import (
	"fmt"
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
func movedBlock(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	from, err := targetAddress(op, req.Params)
	if err != nil {
		return nil, "", "", err
	}
	newName := firstNonInvString(op, req)
	if newName == "" {
		return nil, "", "", fmt.Errorf("moved_block: missing new name param")
	}
	parts := strings.Split(from, ".")
	if len(parts) != 2 {
		return nil, "", "", fmt.Errorf("moved_block: unsupported from address %q", from)
	}
	to := parts[0] + "." + newName
	if from == to {
		return nil, "", "", fmt.Errorf("%w: moved from == to (%s)", errResolution, from)
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
