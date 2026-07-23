package driftpropose

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeEnvelopeFile writes body (JSON text) to a temp file and returns its path.
func writeEnvelopeFile(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "envelope.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestExitCodes drives the `drift-propose` subcommand's run() entrypoint directly
// (mirrors plancheck/windowcheck's own command-level tests) across the exit-code
// contract spec §6.1 defines: 0 ok · 3 envelope unreadable/failed validation · 4
// checkout unusable.
func TestExitCodes(t *testing.T) {
	validEnvelope := `{"schema":"ccp.drift/v1","projectId":"sample","environment":"prod","capturedAt":"2026-07-20T03:17:04Z","runId":"1","commit":"abc","cadenceHours":6,"planExitCode":0,"report":{"verdicts":[]}}`

	t.Run("missing required flags exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{"--envelope", writeEnvelopeFile(t, validEnvelope)}, &out, &errb)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb.String())
		}
	})

	t.Run("malformed JSON envelope exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, `{not json`),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb.String())
		}
	})

	t.Run("wrong schema exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, `{"schema":"ccp.drift/v2","projectId":"sample","planExitCode":0,"report":{"verdicts":[]}}`),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 3 || !strings.Contains(errb.String(), "schema") {
			t.Fatalf("code = %d, want 3 + schema mention (stderr=%q)", code, errb.String())
		}
	})

	t.Run("bad planExitCode exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":1,"report":{"verdicts":[]}}`),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 3 || !strings.Contains(errb.String(), "planExitCode") {
			t.Fatalf("code = %d, want 3 + planExitCode mention (stderr=%q)", code, errb.String())
		}
	})

	t.Run("missing verdict address exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":2,"report":{"verdicts":[{"class":"benign_inplace"}]}}`),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb.String())
		}
	})

	t.Run("nonexistent checkout root exits 4", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, validEnvelope),
			"--repo", filepath.Join(t.TempDir(), "does-not-exist"),
			"--root", "environments/prod",
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 4 {
			t.Fatalf("code = %d, want 4 (stderr=%q)", code, errb.String())
		}
	})

	t.Run("checkout root is a file, not a directory, exits 4", func(t *testing.T) {
		repo := t.TempDir()
		root := "environments/prod"
		// Make the WOULD-BE root path exist as a plain file, not a directory.
		if err := os.MkdirAll(filepath.Join(repo, "environments"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, root), []byte("not a directory"), 0o644); err != nil {
			t.Fatal(err)
		}
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, validEnvelope),
			"--repo", repo,
			"--root", root,
			"--out", filepath.Join(t.TempDir(), "proposals.json"),
		}, &out, &errb)
		if code != 4 {
			t.Fatalf("code = %d, want 4 (stderr=%q)", code, errb.String())
		}
	})

	t.Run("clean envelope, valid checkout exits 0 and writes proposals.json", func(t *testing.T) {
		outPath := filepath.Join(t.TempDir(), "proposals.json")
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", writeEnvelopeFile(t, validEnvelope),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", outPath,
		}, &out, &errb)
		if code != 0 {
			t.Fatalf("code = %d, want 0 (stderr=%q)", code, errb.String())
		}
		b, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatalf("--out was not written: %v", err)
		}
		var doc ProposalsDoc
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatalf("--out is not valid JSON: %v", err)
		}
		if doc.Schema != ProposalsSchema {
			t.Errorf("schema = %q, want %q", doc.Schema, ProposalsSchema)
		}
		if len(doc.Proposals) != 0 || len(doc.Ungenerable) != 0 {
			t.Errorf("a zero-verdict envelope produced %d proposals / %d ungenerable, want 0/0", len(doc.Proposals), len(doc.Ungenerable))
		}
	})

	t.Run("all-ungenerable is a valid exit-0 outcome", func(t *testing.T) {
		outPath := filepath.Join(t.TempDir(), "proposals.json")
		var out, errb bytes.Buffer
		code := run([]string{
			"--envelope", "../../testdata/driftpropose/envelopes/unknown-class.json",
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", outPath,
		}, &out, &errb)
		if code != 0 {
			t.Fatalf("code = %d, want 0 (stderr=%q)", code, errb.String())
		}
		b, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatal(err)
		}
		var doc ProposalsDoc
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatal(err)
		}
		if len(doc.Proposals) != 0 {
			t.Errorf("proposals = %d, want 0", len(doc.Proposals))
		}
		if len(doc.Ungenerable) != 1 {
			t.Errorf("ungenerable = %d, want 1", len(doc.Ungenerable))
		}
	})
}

// TestEnableImportFlag pins spec 2026-07-20-ccp-oob-provisioning-import.md
// §5.1/§9's CLI contract: "--enable-import ... off ⇒ behavior today,
// byte-identical." Drives the REAL `drift-propose` entrypoint (run) — not
// just Generate/GenerateWithImport directly — against an envelope carrying a
// sweep section: omitting --enable-import must produce byte-identical output
// to an envelope with no sweep section at all; passing --enable-import must
// additionally emit the import proposal.
func TestEnableImportFlag(t *testing.T) {
	sweepFinding := `{
		"class": "unmanaged_resource", "arn": null, "tfType": "aws_instance", "liveId": "i-0abc123def456789a",
		"securityFamily": false, "payloadWithheldReason": null,
		"importPayload": {
			"address": "aws_instance.oob_bastion01", "targetFile": "oob-adopted.tf",
			"importBlock": "import {\n  to = aws_instance.oob_bastion01\n  id = \"i-0abc123def456789a\"\n}\n",
			"skeletonHcl": "resource \"aws_instance\" \"oob_bastion01\" {\n  ami           = \"ami-0123456789abcdef0\"\n  instance_type = \"m5.large\"\n}\n"
		}
	}`
	noSweep := `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":0,"report":{"verdicts":[]}}`
	withSweep := `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":0,"report":{"verdicts":[]},"sweep":{"findings":[` + sweepFinding + `]}}`

	runOnce := func(t *testing.T, envelopeBody string, extraArgs ...string) (int, string, []byte) {
		t.Helper()
		outPath := filepath.Join(t.TempDir(), "proposals.json")
		args := []string{
			"--envelope", writeEnvelopeFile(t, envelopeBody),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", outPath,
		}
		args = append(args, extraArgs...)
		var out, errb bytes.Buffer
		code := run(args, &out, &errb)
		b, _ := os.ReadFile(outPath)
		return code, out.String() + errb.String(), b
	}

	codeNoFlagNoSweep, _, bytesNoFlagNoSweep := runOnce(t, noSweep)
	if codeNoFlagNoSweep != 0 {
		t.Fatalf("no-sweep, no-flag: code = %d, want 0", codeNoFlagNoSweep)
	}

	codeNoFlagWithSweep, _, bytesNoFlagWithSweep := runOnce(t, withSweep)
	if codeNoFlagWithSweep != 0 {
		t.Fatalf("with-sweep, no-flag: code = %d, want 0", codeNoFlagWithSweep)
	}
	if string(bytesNoFlagWithSweep) != string(bytesNoFlagNoSweep) {
		t.Fatalf("--enable-import omitted did not produce byte-identical output for a sweep-carrying envelope:\n--- no sweep ---\n%s\n--- with sweep, flag off ---\n%s", bytesNoFlagNoSweep, bytesNoFlagWithSweep)
	}

	codeFlagOn, outFlagOn, bytesFlagOn := runOnce(t, withSweep, "--enable-import")
	if codeFlagOn != 0 {
		t.Fatalf("with-sweep, --enable-import: code = %d, want 0 (%s)", codeFlagOn, outFlagOn)
	}
	if string(bytesFlagOn) == string(bytesNoFlagWithSweep) {
		t.Fatal("--enable-import made no difference to the output — the flag is not wired")
	}
	var doc ProposalsDoc
	if err := json.Unmarshal(bytesFlagOn, &doc); err != nil {
		t.Fatalf("--enable-import output is not valid JSON: %v", err)
	}
	if len(doc.Proposals) != 1 || doc.Proposals[0].Flavor != "import" {
		t.Fatalf("proposals = %+v, want exactly 1 import proposal with --enable-import", doc.Proposals)
	}
}

// TestEnableRestoreFlag pins plan 2026-07-20-drift-restore-tranche.md §2.2/§3's
// CLI contract: off by default (an oob_deletion, restore-eligible verdict
// stays ungenerable with the honest arming reason), --enable-restore emits
// the restore proposal instead. Unlike import's Sweep-is-wholesale-ignored
// shape, a restore verdict is always CLASSIFIED (it still shows up, just as
// Ungenerable) regardless of the flag — this is what distinguishes the two
// flags' off-state byte-diff shape, so this test checks the ungenerable ROW
// rather than asserting flag-off output is byte-identical to some flagless
// baseline (there is no sweep-less baseline to compare against here).
func TestEnableRestoreFlag(t *testing.T) {
	deletionVerdict := `{
		"address": "aws_flow_log.vpc1", "type": "aws_flow_log", "class": "oob_deletion", "riskTier": "high",
		"driftEvidence": true, "actions": ["create"], "forceNewAttrs": [], "securityHits": [], "changedAttrs": []
	}`
	envelopeBody := `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":2,"report":{"verdicts":[` + deletionVerdict + `]}}`

	runOnce := func(t *testing.T, extraArgs ...string) (int, string, []byte) {
		t.Helper()
		outPath := filepath.Join(t.TempDir(), "proposals.json")
		args := []string{
			"--envelope", writeEnvelopeFile(t, envelopeBody),
			"--repo", "../../testdata/driftpropose/checkout",
			"--root", "environments/prod",
			"--out", outPath,
		}
		args = append(args, extraArgs...)
		var out, errb bytes.Buffer
		code := run(args, &out, &errb)
		b, _ := os.ReadFile(outPath)
		return code, out.String() + errb.String(), b
	}

	codeOff, _, bytesOff := runOnce(t)
	if codeOff != 0 {
		t.Fatalf("no-flag: code = %d, want 0", codeOff)
	}
	var docOff ProposalsDoc
	if err := json.Unmarshal(bytesOff, &docOff); err != nil {
		t.Fatalf("no-flag output is not valid JSON: %v", err)
	}
	if len(docOff.Proposals) != 0 {
		t.Fatalf("no-flag proposals = %+v, want none (restore not armed)", docOff.Proposals)
	}
	if len(docOff.Ungenerable) != 1 || docOff.Ungenerable[0].Address != "aws_flow_log.vpc1" {
		t.Fatalf("no-flag ungenerable = %+v, want exactly one row naming aws_flow_log.vpc1", docOff.Ungenerable)
	}
	if !strings.Contains(docOff.Ungenerable[0].Reason, "--enable-restore") {
		t.Fatalf("no-flag reason = %q, want it to name the arming flag", docOff.Ungenerable[0].Reason)
	}

	codeOn, outOn, bytesOn := runOnce(t, "--enable-restore")
	if codeOn != 0 {
		t.Fatalf("--enable-restore: code = %d, want 0 (%s)", codeOn, outOn)
	}
	if string(bytesOn) == string(bytesOff) {
		t.Fatal("--enable-restore made no difference to the output — the flag is not wired")
	}
	var docOn ProposalsDoc
	if err := json.Unmarshal(bytesOn, &docOn); err != nil {
		t.Fatalf("--enable-restore output is not valid JSON: %v", err)
	}
	if len(docOn.Proposals) != 1 || docOn.Proposals[0].Flavor != "restore" {
		t.Fatalf("proposals = %+v, want exactly 1 restore proposal with --enable-restore", docOn.Proposals)
	}
	if len(docOn.Ungenerable) != 0 {
		t.Fatalf("ungenerable = %+v, want none with --enable-restore", docOn.Ungenerable)
	}
}
