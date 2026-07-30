package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestUnknownSubcommandExits3(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"frobnicate"}, &out, &errb)
	if code != 3 {
		t.Fatalf("exit = %d, want 3", code)
	}
	if !strings.Contains(errb.String(), "unknown subcommand") {
		t.Fatalf("stderr = %q, want unknown subcommand", errb.String())
	}
}

func TestRefuseFormat(t *testing.T) {
	var errb bytes.Buffer
	code := Refuse(&errb, "FMT_DIRTY", "file is not fmt-canonical")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if got := errb.String(); got != "REFUSE FMT_DIRTY: file is not fmt-canonical\n" {
		t.Fatalf("stderr = %q", got)
	}
}

// DOC-8/ARCH-12 — the README's Subcommands table stakes its own credibility on
// "verified directly against internal/cli/cli.go … this is the complete list, no
// more, no fewer." That claim was false (drift-edit, scan-worker and window-check
// were missing) and nothing enforced it. This test derives BOTH sides from their
// real sources — the switch statement's own case labels, and the README's own
// table rows — and diffs them, so the claim is checked mechanically rather than
// re-asserted by hand at the next subcommand addition (L-25: write the rule, not
// the list).
func TestSubcommandTableMatchesREADME(t *testing.T) {
	cliGo, err := os.ReadFile("cli.go")
	if err != nil {
		t.Fatalf("read cli.go: %v", err)
	}
	caseRe := regexp.MustCompile(`(?m)^\tcase "([a-z][a-z0-9-]*)":`)
	matches := caseRe.FindAllStringSubmatch(string(cliGo), -1)
	if len(matches) < 5 {
		// L-1: a regex that stops matching (a reformatted switch, a renamed
		// receiver) must not silently pass with an empty set on both sides.
		t.Fatalf("found only %d case labels in cli.go — the extractor regex is probably broken", len(matches))
	}
	fromCode := map[string]bool{}
	for _, m := range matches {
		fromCode[m[1]] = true
	}

	readmePath := filepath.Join("..", "..", "README.md")
	readme, err := os.ReadFile(readmePath)
	if err != nil {
		t.Fatalf("read %s: %v", readmePath, err)
	}
	start := strings.Index(string(readme), "## Subcommands")
	end := strings.Index(string(readme), "### The `edit` verbs")
	if start < 0 || end < 0 || end <= start {
		t.Fatalf("could not locate the Subcommands section boundaries in README.md — heading text moved")
	}
	section := string(readme)[start:end]
	rowRe := regexp.MustCompile("(?m)^\\| `([a-z][a-z0-9-]*)` \\|")
	rowMatches := rowRe.FindAllStringSubmatch(section, -1)
	if len(rowMatches) < 5 {
		t.Fatalf("found only %d table rows in the README Subcommands section — the extractor regex is probably broken", len(rowMatches))
	}
	fromReadme := map[string]bool{}
	for _, m := range rowMatches {
		fromReadme[m[1]] = true
	}

	for name := range fromCode {
		if !fromReadme[name] {
			t.Errorf("cli.go dispatches %q, but README.md's Subcommands table does not list it", name)
		}
	}
	for name := range fromReadme {
		if !fromCode[name] {
			t.Errorf("README.md's Subcommands table lists %q, but cli.go has no such case — a phantom subcommand", name)
		}
	}
}
