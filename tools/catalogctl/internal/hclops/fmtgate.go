package hclops

import (
	"bytes"

	"github.com/hashicorp/hcl/v2/hclwrite"
)

// FmtCanonical reports whether b is already in hclwrite's canonical form — the
// same formatter terraform fmt delegates to (spec). A non-canonical target
// file is refused (REFUSE FMT_DIRTY) so a one-attribute edit stays a one-line diff.
func FmtCanonical(b []byte) bool {
	return bytes.Equal(hclwrite.Format(b), b)
}
