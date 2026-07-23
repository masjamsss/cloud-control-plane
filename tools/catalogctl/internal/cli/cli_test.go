package cli

import (
	"bytes"
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
