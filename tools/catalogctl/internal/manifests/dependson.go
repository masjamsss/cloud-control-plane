package manifests

// dependson.go is the Go port of app/src/lib/dependsOn.ts#isParamActive — the ONE
// conditional-visibility predicate. The TS module is imported by BOTH
// the SPA and ccp-api's validateParams; this is its executor twin so the Go
// bounds re-check (Validate) and the create renderer gate identically to the form —
// "one predicate, zero drift". A param with dependsOn is ACTIVE only while its
// controller's value satisfies the condition; while inactive it is not rendered,
// NEVER required, and its bounds are not applied (Validate skips it entirely). Pure
// and deterministic.

import (
	"encoding/json"
	"fmt"
)

// paramCondition mirrors the ParamCondition zod shape: a controlling param plus
// exactly one of equals/notEquals. RawMessage distinguishes a present operator from
// an absent one (the TS `cond.equals !== undefined` gate).
type paramCondition struct {
	Param     string          `json:"param"`
	Equals    json.RawMessage `json:"equals"`
	NotEquals json.RawMessage `json:"notEquals"`
}

// IsParamActive reports whether p should render and validate given the current
// values. No dependsOn ⇒ always active (pre-existing behavior exactly). An unset or
// empty controller deactivates the dependent under both operators (fail-closed to
// hidden). A malformed condition also fails closed.
func IsParamActive(p Param, values map[string]any) bool {
	if !rawPresent(p.DependsOn) {
		return true
	}
	var cond paramCondition
	if err := json.Unmarshal(p.DependsOn, &cond); err != nil {
		return false
	}
	controller, ok := values[cond.Param]
	if !ok || isEmptyController(controller) {
		return false
	}
	if rawPresent(cond.Equals) {
		return fmt.Sprint(controller) == fmt.Sprint(rawToAny(cond.Equals))
	}
	if rawPresent(cond.NotEquals) {
		return fmt.Sprint(controller) != fmt.Sprint(rawToAny(cond.NotEquals))
	}
	return false
}

// isEmptyController mirrors dependsOn.ts#isEmpty (undefined/null/"" only).
func isEmptyController(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	}
	return false
}

// rawPresent reports whether a json.RawMessage carries a real (non-null) value.
func rawPresent(raw json.RawMessage) bool {
	s := string(raw)
	return len(raw) > 0 && s != "null"
}

// rawToAny unmarshals a json.RawMessage into a Go any, or nil on failure.
func rawToAny(raw json.RawMessage) any {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}
