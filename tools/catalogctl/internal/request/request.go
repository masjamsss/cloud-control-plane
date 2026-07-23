// Package request loads and validates the ccp.request/v1 YAML (spec).
package request

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
)

var idRe = regexp.MustCompile(`^REQ-[0-9A-HJKMNP-TV-Z]{26}$`)

type Request struct {
	Schema         string         `yaml:"schema"`
	ID             string         `yaml:"id"`
	Item           string         `yaml:"item"`
	CreatedAt      string         `yaml:"created_at"`
	RequesterLogin string         `yaml:"requester_login"`
	Params         map[string]any `yaml:"params"`
	Justification  string         `yaml:"justification"`
	Computed       map[string]any `yaml:"computed"`

	// --- Production-wiring extensions. All OPTIONAL: absent in a
	// bare edit/plan-check fixture (they load with zero values), populated on a
	// bot PR's approved request. yaml.v3 KnownFields still rejects unknown keys,
	// so a typo in any of these is a schema error (exit 3), not a silent drop.

	// Target is the resolved resource address the op edits, stamped for
	// the evidence record. Optional; when present pr-prepare cross-checks it against
	// the op's inventory param (refuses TARGET_MISMATCH on disagreement) so a
	// mis-stamped request can never be turned into a PR that edits a different address.
	Target string `yaml:"target"`
	// Approvals is the in-app quorum record carried into the PR: who
	// approved, when, under which policy version, and the plan digest they bound to
	// (approve-this-exact-plan). pr-prepare refuses UNAPPROVED when empty; the gate
	// re-verifies the CI-computed plan digest against Digest here.
	Approvals []Approval `yaml:"approvals"`
	// Window is the maintenance window the change may apply within, or
	// null = "apply on the next scheduler tick after approval" (spec). The
	// scheduler (env-gated) enforces it; pr-prepare only carries it forward.
	Window *Window `yaml:"window"`
	// EarliestApplyAt (cooling-off) is the RFC3339 instant before
	// which no apply may run, independent of the window. Carried forward.
	EarliestApplyAt string `yaml:"earliest_apply_at"`

	// Confirmations records the requester's explicit TYPED acknowledgements for an
	// override that would otherwise refuse. OPTIONAL — absent on every ordinary request
	// (they load with a nil pointer, zero behaviour change). Today only `replace` is
	// defined: the exact resource address the engineer typed to confirm a forces-replace
	// (destroy+recreate). The executor honours it ONLY for a forcesReplace op and ONLY
	// when it equals the resolved target address (the confirmed-override lane); it NEVER
	// weakens PREVENT_DESTROY — a lifecycle.prevent_destroy target still refuses regardless.
	// yaml.v3 KnownFields still rejects an unknown sub-key here (a typo is a schema error,
	// exit 3), so a mistyped confirmation field can never be silently dropped.
	Confirmations *Confirmations `yaml:"confirmations"`
}

// Confirmations is the typed-acknowledgement record carried on a request. It exists so a
// destructive override is a deliberate, named act, not an implicit flag.
type Confirmations struct {
	// Replace is the exact resource address the requester typed to confirm a
	// destroy+recreate. The executor requires it to equal the op's target address before a
	// forcesReplace op proceeds, so a confirmation for one resource can never be replayed
	// onto another. Empty = no confirmation (the op refuses, unchanged).
	Replace string `yaml:"replace"`
}

// Approval is one signed quorum decision (who/when/policyVersion/digest).
type Approval struct {
	Approver      string `yaml:"approver"`
	ApprovedAt    string `yaml:"approved_at"`
	PolicyVersion string `yaml:"policy_version"`
	// Digest is the sha256 hex of the plan.json this approval binds to
	// (approve-this-exact-plan). The gate fails closed if the CI-computed digest
	// does not equal this value — approvals never float free of a specific plan.
	Digest   string `yaml:"digest"`
	Decision string `yaml:"decision"`
}

// Window is a maintenance window. All three fields are required when the
// window is non-null; a null window in YAML decodes to a nil *Window.
type Window struct {
	Start string `yaml:"start"`
	End   string `yaml:"end"`
	TZ    string `yaml:"tz"`
}

// ApprovedDigest returns the single plan digest the quorum bound to, or "" if no
// approval carries one. It refuses ("", false) when two approvals name DIFFERENT
// non-empty digests — a split-brain quorum (approvers signed off on different plans)
// that must never be turned into one PR. All-empty (pre-plan approvals) returns
// ("", true): nothing to bind yet, not a disagreement.
func (r *Request) ApprovedDigest() (digest string, ok bool) {
	for _, a := range r.Approvals {
		if a.Digest == "" {
			continue
		}
		if digest == "" {
			digest = a.Digest
			continue
		}
		if a.Digest != digest {
			return "", false
		}
	}
	return digest, true
}

// Load reads and strictly validates a request file. Unknown top-level keys are a
// schema error (spec, exit 3). cfg is the estate's resolved operating timezone
// (estate-config, ADR-0028) that window.tz is checked against — Load takes it as a
// plain value and reads no env/flags itself, so it stays a pure function of its
// inputs (the caller resolves cfg once, e.g. via estatecfg.Resolve). Callers map any
// returned error to exit code 3.
func Load(path string, cfg estatecfg.Config) (*Request, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true) // unknown top-level keys are a schema error (spec, exit 3)
	var r Request
	if err := dec.Decode(&r); err != nil {
		// yaml.v3 KnownFields reports unknown keys as "field X not found in type".
		if strings.Contains(err.Error(), "not found in type") {
			return nil, fmt.Errorf("request schema: unknown top-level field: %w", err)
		}
		return nil, fmt.Errorf("request schema: %w", err)
	}
	if r.Schema != "ccp.request/v1" {
		return nil, fmt.Errorf("request schema: got %q, want ccp.request/v1", r.Schema)
	}
	if !idRe.MatchString(r.ID) {
		return nil, fmt.Errorf("request id %q does not match REQ-<ulid>", r.ID)
	}
	if r.Item == "" {
		return nil, fmt.Errorf("request item is required")
	}
	if err := r.validateSchedule(cfg); err != nil {
		return nil, err
	}
	return &r, nil
}

// validateSchedule hardens the maintenance-window and cooling-off fields (
// "a gate cannot trust fields nobody checks"). Until now these rode the
// YAML as unvalidated strings; the window-check gate refuses to compare fields
// it has not proven parseable. Rules, all fail-closed to a schema error (exit 3):
//
//   - when window is non-nil: start and end must parse as RFC3339, start must be
//     strictly before end, and tz must equal the estate's configured operating
//     timezone (cfg.EstateTZ — estate-config, ADR-0028; tz is display/provenance
//     metadata, the only value any gate compares is the UTC instant, and no tz
//     database sits on the gate path);
//   - when earliest_apply_at is present: it must parse as RFC3339.
//
// A nil window and an empty earliest_apply_at are valid (a bare/no-window request),
// so the 98 fixtures without a schedule load unchanged. This is deliberately NOT the
// place that decides in/out-of-window — that is windowcheck.Evaluate at a supplied
// instant; Load only proves the fields are well-formed enough to be compared.
func (r *Request) validateSchedule(cfg estatecfg.Config) error {
	if r.EarliestApplyAt != "" {
		if _, err := time.Parse(time.RFC3339, r.EarliestApplyAt); err != nil {
			return fmt.Errorf("request earliest_apply_at %q is not RFC3339: %w", r.EarliestApplyAt, err)
		}
	}
	if r.Window == nil {
		return nil
	}
	w := r.Window
	start, err := time.Parse(time.RFC3339, w.Start)
	if err != nil {
		return fmt.Errorf("request window.start %q is not RFC3339: %w", w.Start, err)
	}
	end, err := time.Parse(time.RFC3339, w.End)
	if err != nil {
		return fmt.Errorf("request window.end %q is not RFC3339: %w", w.End, err)
	}
	if !start.Before(end) {
		return fmt.Errorf("request window.start %q must be before window.end %q", w.Start, w.End)
	}
	if w.TZ != cfg.EstateTZ {
		return fmt.Errorf("request window.tz %q must be the estate operating timezone %q (estate-config, ADR-0028)", w.TZ, cfg.EstateTZ)
	}
	return nil
}
