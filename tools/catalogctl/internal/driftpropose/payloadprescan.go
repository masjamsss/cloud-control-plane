package driftpropose

import (
	"bytes"
	"fmt"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/prescan"
)

// payloadprescan.go implements spec 2026-07-20-ccp-oob-provisioning-import.md
// §5.3(a): "the onboard trust boundary applied to generated HCL, at EVERY
// plane that touches payload bytes." This is that shared Go helper — the
// generator (Generate's finding loop, generate.go) and drift-edit's own
// import handler (driftedit.go) each call PrescanImportPayload
// INDEPENDENTLY (defense in depth, mirroring the fourth screen's "run again
// at every plane" doctrine, §8). It wraps internal/prescan's walk (never
// touching disk — the payload is already in memory) plus the secret
// battery: the SAME rule importer/kit/payloads.py already enforces
// publisher-side (§2.6 step 4), re-run here because catalogctl trusts no
// producer, the same doctrine §4.1 states for the api's own re-run of
// redaction on ingest.

// PrescanImportPayload runs the full §5.3a screen over the combined bytes of
// one import payload — importBlock then skeletonHcl, joined by a blank
// line, EXACTLY the composition drift-edit's own write (§7.1 step 3)
// produces — so a clean prescan proves the exact bytes that would land in
// oob-adopted.tf. ok=true means clean; ok=false means refused, with reason
// naming the construct (spec: "reason naming the construct").
func PrescanImportPayload(importBlock, skeletonHcl string) (reason string, ok bool) {
	combined := importBlock + "\n" + skeletonHcl

	rep, err := prescan.ScanPayload("import-payload.tf", []byte(combined))
	if err != nil {
		return fmt.Sprintf("payload prescan: internal error: %v", err), false
	}
	if rep.Verdict == "reject" {
		f := rep.Findings[0]
		return fmt.Sprintf(
			"payload prescan refused: %s at line %d — the onboard no-execution static gate, narrowed to import/resource blocks (spec §5.3a)",
			f.Code, f.Line), false
	}

	if masked := hclops.Redact([]byte(combined)); !bytes.Equal(masked, []byte(combined)) {
		return "generated config carries secret-shaped values — import via the kit runbook with secret handling (e.g. ignore_changes on the secret attribute), never through the portal", false
	}

	return "", true
}
