package hclops

import (
	"bytes"
	"fmt"
)

// Splice returns orig[:start] ++ newBlock ++ orig[end:] and asserts the
// "changed set ⊆ target" invariant (spec): everything outside [start,end)
// is byte-identical to orig. A violation returns an error (caller exits 1).
func Splice(orig []byte, start, end int, newBlock []byte) ([]byte, error) {
	if start < 0 || end > len(orig) || start > end {
		return nil, fmt.Errorf("splice range [%d,%d) invalid for %d bytes", start, end, len(orig))
	}
	out := make([]byte, 0, start+len(newBlock)+len(orig)-end)
	out = append(out, orig[:start]...)
	out = append(out, newBlock...)
	out = append(out, orig[end:]...)
	if !bytes.Equal(out[:start], orig[:start]) {
		return nil, fmt.Errorf("splice violated prefix invariant")
	}
	if !bytes.Equal(out[len(out)-(len(orig)-end):], orig[end:]) {
		return nil, fmt.Errorf("splice violated suffix invariant")
	}
	return out, nil
}
