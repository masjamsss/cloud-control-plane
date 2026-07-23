// Package hclops holds the shared HCL surgery primitives: block location,
// fmt-canonical gate, prefix/suffix-preserving splice, and unified diff (spec).
package hclops

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// Located pins the byte range [Start,End) of a block within its file. End
// includes the trailing newline of the closing-brace line.
type Located struct {
	File  string
	Bytes []byte
	Start int
	End   int
}

// Locate parses every *.tf in envDir and returns the single block whose address
// (`<type>.<name>` for resources, `module.<name>` for modules) equals address.
// The int return is an exit-code suggestion: 3 on zero-or-multiple matches, 1 on
// I/O or parse error, 0 on the unique hit.
func Locate(envDir, address string) (*Located, error, int) {
	files, err := filepath.Glob(filepath.Join(envDir, "*.tf"))
	if err != nil {
		return nil, err, 1
	}
	parser := hclparse.NewParser()
	var matches []*Located
	for _, fp := range files {
		src, err := os.ReadFile(fp)
		if err != nil {
			return nil, err, 1
		}
		f, diags := parser.ParseHCL(src, fp)
		if diags.HasErrors() {
			return nil, fmt.Errorf("parse %s: %s", fp, diags.Error()), 1
		}
		body, ok := f.Body.(*hclsyntax.Body)
		if !ok {
			continue
		}
		for _, blk := range body.Blocks {
			if !blockMatches(blk, address) {
				continue
			}
			start := blk.TypeRange.Start.Byte
			end := blk.CloseBraceRange.End.Byte
			if end < len(src) && src[end] == '\n' {
				end++ // include the trailing newline of the closing-brace line
			}
			matches = append(matches, &Located{File: fp, Bytes: src, Start: start, End: end})
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil, 0
	case 0:
		return nil, fmt.Errorf("address %q not found under %s", address, envDir), 3
	default:
		return nil, fmt.Errorf("address %q matches %d blocks (ambiguous)", address, len(matches)), 3
	}
}

// blockMatches reports whether blk is addressed by address. A `locals` block
// matches `local.<name>` when it declares attribute <name> (for_each maps).
func blockMatches(blk *hclsyntax.Block, address string) bool {
	if blk.Type == "locals" && strings.HasPrefix(address, "local.") {
		_, ok := blk.Body.Attributes[strings.TrimPrefix(address, "local.")]
		return ok
	}
	addr := blockAddress(blk)
	return addr != "" && addr == address
}

func blockAddress(blk *hclsyntax.Block) string {
	switch blk.Type {
	case "resource":
		if len(blk.Labels) == 2 {
			return blk.Labels[0] + "." + blk.Labels[1]
		}
	case "module":
		if len(blk.Labels) == 1 {
			return "module." + blk.Labels[0]
		}
	}
	return ""
}
