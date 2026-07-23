// Package driftpropose is the `drift-propose` subcommand: the deterministic
// generation engine behind spec 2026-07-20-ccp-drift-portal §6. It reads a
// stored ccp.drift/v1 envelope and a scratch checkout, and — with no network, no
// AWS, no LLM, and no wall-clock in the output (ADR-0007) — partitions every verdict
// into adopt / revert / not-generatable (§6.2), mechanically writes the ADOPT edits
// via the same HCL-surgery primitives internal/edit uses (§6.4), and emits a
// digest-pinned proposals.json (§6.1).
//
// The partition doctrine (§6.2, §8): every condition is RE-DERIVED from verdict
// fields at every check — the classifier's own `class` label is never trusted alone.
// security-posture drift (§2.3: class == "security_posture" OR any securityHits row)
// is therefore structurally unroutable to the adopt emitter, by construction, not by
// convention — enforcement point 1 of the binding invariant in §8.
package driftpropose

import (
	"encoding/json"
	"fmt"
	"os"
)

// EnvelopeSchema is the pinned schema name every stored drift report carries (§2.1).
const EnvelopeSchema = "ccp.drift/v1"

// Envelope is the `ccp.drift/v1` wrapper (§2.1) around the classifier's
// classification.json. Only the fields this engine actually consumes are typed;
// everything else (meta, counts, absorbed, invisible_to_plan, per-verdict
// recommendation/neverDo/executor prose, …) is display data the portal renders but
// this engine never reads, and is silently ignored by encoding/json — the same
// tolerant-parse doctrine §2.1 states for the api's zod schema.
type Envelope struct {
	Schema       string `json:"schema"`
	ProjectID    string `json:"projectId"`
	Environment  string `json:"environment"`
	CapturedAt   string `json:"capturedAt"`
	RunID        string `json:"runId"`
	Commit       string `json:"commit"`
	CadenceHours int    `json:"cadenceHours"`
	PlanExitCode int    `json:"planExitCode"`
	Report       Report `json:"report"`
	// Sweep is the additive, optional "sweep" section (spec
	// 2026-07-20-ccp-oob-provisioning-import.md §3.1) — absent on any
	// envelope published before that lane, and on any envelope from a run
	// where the sweep itself was unarmed. Only consumed when the generator's
	// --enable-import flag is set (GenerateWithImport); Generate (the
	// existing, unchanged entry point) never reads it at all.
	Sweep *Sweep `json:"sweep,omitempty"`
}

// Report is the classifier's classification.json, byte-for-byte (§2.1) — only
// `verdicts` is typed here; `absorbed` entries (drift with no actionable verdict,
// already absorbed by an existing ignore_changes) are informational-only and never
// reach the partition (§6.2 operates over "every verdict", i.e. this slice).
type Report struct {
	Verdicts []Verdict `json:"verdicts"`
}

// Verdict is one classify.py verdict row — the "known fields typed" set §2.1 names
// verbatim: address, type, actions, class, riskTier, changedAttrs[], forceNewAttrs[],
// securityHits[], driftEvidence. Display-only prose (recommendation, neverDo,
// executor, notes) is deliberately untyped: this engine renders no markdown (§2.1).
type Verdict struct {
	Address       string         `json:"address"`
	Type          string         `json:"type"`
	Actions       []string       `json:"actions"`
	DriftEvidence bool           `json:"driftEvidence"`
	Class         string         `json:"class"`
	RiskTier      string         `json:"riskTier"`
	ChangedAttrs  []ChangedAttr  `json:"changedAttrs"`
	ForceNewAttrs []ForceNewAttr `json:"forceNewAttrs"`
	SecurityHits  []SecurityHit  `json:"securityHits"`
}

// ChangedAttr is one changedAttrs[] row (§2.2, additive over the display-only
// `live`/`code` classify.py already emitted). LiveJSON/CodeJSON are
// json.RawMessage so presence is exactly distinguishable from absence — "present
// only when sensitive is false" (§2.2) is a byte-length check (len(...) == 0),
// never a nil-interface guess after decoding. PathSegments is spec addendum A4's
// (F8) additive raw diff tuple — ints are list indices, everything else is a
// string; absent on a legacy/pre-F8 envelope, in which case every consumer
// (partition.go's ExpressibleSegments, adopt.go, revert.go) falls back to
// parsing the display-path string exactly as before (see NormalizeSegments).
type ChangedAttr struct {
	Path         string          `json:"path"`
	Live         string          `json:"live"`
	Code         string          `json:"code"`
	Sensitive    bool            `json:"sensitive"`
	LiveJSON     json.RawMessage `json:"liveJson,omitempty"`
	CodeJSON     json.RawMessage `json:"codeJson,omitempty"`
	PathSegments []any           `json:"pathSegments,omitempty"`
}

// liveValue decodes LiveJSON into a generic JSON value (string/float64/bool/nil/
// []any/map[string]any). ok=false means the row carries no machine value at all
// (sensitive, or an envelope built before WI-1's additive fields) — never guessed
// from the display-only Live string.
func (c ChangedAttr) liveValue() (any, bool) {
	if len(c.LiveJSON) == 0 {
		return nil, false
	}
	var v any
	if err := json.Unmarshal(c.LiveJSON, &v); err != nil {
		return nil, false
	}
	return v, true
}

// codeValue is liveValue's symmetric twin for CodeJSON.
func (c ChangedAttr) codeValue() (any, bool) {
	if len(c.CodeJSON) == 0 {
		return nil, false
	}
	var v any
	if err := json.Unmarshal(c.CodeJSON, &v); err != nil {
		return nil, false
	}
	return v, true
}

// ForceNewAttr is one forceNewAttrs[] row (plan-proven replace_paths or the
// schemadump chain-OR verdict, docs/runbooks/drift-detection.md D3/D3b).
type ForceNewAttr struct {
	Path    string `json:"path"`
	Verdict string `json:"verdict"`
	Why     string `json:"why"`
}

// SecurityHit is one securityHits[] evidence row — a scripts/drift/security-watchlist.json
// match. Any non-empty SecurityHits makes IsSecurityPosture true regardless of Class
// (§2.3's fail-closed union — the portal/engine only ever WIDENS this, never narrows it).
type SecurityHit struct {
	Path string `json:"path"`
	Why  string `json:"why"`
}

// LoadEnvelope reads and validates a stored envelope file. A read failure, invalid
// JSON, or a failed validation is returned as an error; the caller (command.go) maps
// any error here to exit 3 ("envelope unreadable/failed validation", §6.1) — the
// engine never guesses at untrusted input.
func LoadEnvelope(path string) (*Envelope, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read envelope: %w", err)
	}
	return ParseEnvelope(b)
}

// ParseEnvelope is LoadEnvelope's testable core: decode + validate envelope bytes
// (schema pin, required projectId, planExitCode ∈ {0,2} per §2.1's "0 = verified
// clean · 2 = drift (exit 1 never publishes)", and every verdict carries a non-empty
// address). It does not validate `class` against the closed eleven-id enum — an
// unrecognized class is a per-verdict ungenerable outcome (§6.2: "Unknown class ⇒
// ungenerable, always"), never a whole-envelope refusal, so an additive classifier
// class can never brick generation (mirrors the api's own ingest doctrine, §2.1).
func ParseEnvelope(b []byte) (*Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(b, &e); err != nil {
		return nil, fmt.Errorf("envelope: invalid JSON: %w", err)
	}
	if e.Schema != EnvelopeSchema {
		return nil, fmt.Errorf("envelope: schema %q, want %q", e.Schema, EnvelopeSchema)
	}
	if e.ProjectID == "" {
		return nil, fmt.Errorf("envelope: projectId is required")
	}
	if e.PlanExitCode != 0 && e.PlanExitCode != 2 {
		return nil, fmt.Errorf("envelope: planExitCode %d is neither 0 (verified clean) nor 2 (drift)", e.PlanExitCode)
	}
	for i, v := range e.Report.Verdicts {
		if v.Address == "" {
			return nil, fmt.Errorf("envelope: report.verdicts[%d] has no address", i)
		}
	}
	return &e, nil
}
