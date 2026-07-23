package edit

// createsupport.go holds the small pure helpers the create renderer (idiomrender.go)
// needs beyond the shared conditional-visibility predicate (manifests.IsParamActive):
// manifest-default decoding and JS-Number coercion. The dependsOn predicate itself
// lives in the manifests package (dependson.go) so the executor's bounds re-check
// (Validate), the create renderer, and the SPA/api all gate identically.

import (
	"encoding/json"
	"strconv"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// isParamActive delegates to the canonical predicate (manifests.IsParamActive) so the
// renderer and the bounds re-check can never drift.
func isParamActive(p manifests.Param, values map[string]any) bool {
	return manifests.IsParamActive(p, values)
}

// paramDefault decodes a param's manifest default (json.RawMessage, "modeled but not
// read" by the executor's write path) into a Go value, so effectiveValue can fall
// back to it exactly as the TS renderer's `values[name] ?? param.default` does.
// Absent/null ⇒ nil.
func paramDefault(p manifests.Param) any {
	if len(p.Default) == 0 || string(p.Default) == "null" {
		return nil
	}
	var v any
	if err := json.Unmarshal(p.Default, &v); err != nil {
		return nil
	}
	return v
}

// toNumber mirrors JS Number(value) for the coercion scalarValue needs: numeric Go
// types pass through; a numeric string parses; everything else is "not finite"
// (ok=false), so the caller falls back to a string literal exactly as the TS
// `Number.isFinite(n)` guard does.
func toNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}
