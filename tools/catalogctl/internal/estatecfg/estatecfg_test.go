package estatecfg

import (
	"strings"
	"testing"
	"time"
)

// TestResolveDefault proves the blank-install path (spec §7): no flag, no env →
// DefaultEstateTZ ("UTC"), and Loc resolves to a real, usable location.
func TestResolveDefault(t *testing.T) {
	cfg, err := Resolve("")
	if err != nil {
		t.Fatalf("Resolve(\"\") err = %v, want nil", err)
	}
	if cfg.EstateTZ != DefaultEstateTZ {
		t.Fatalf("EstateTZ = %q, want %q", cfg.EstateTZ, DefaultEstateTZ)
	}
	if cfg.Loc == nil {
		t.Fatal("Loc = nil, want a resolved *time.Location")
	}
	// UTC has a fixed, zero offset — proves Loc is genuinely usable for display.
	if _, off := time.Now().In(cfg.Loc).Zone(); off != 0 {
		t.Fatalf("UTC location offset = %d, want 0", off)
	}
}

// TestResolveEnvFallback proves CCP_ESTATE_TZ is consulted when no flag is given
// (spec §5.2 precedence: flag > env > default).
func TestResolveEnvFallback(t *testing.T) {
	t.Setenv(EstateTZEnv, "America/New_York")
	cfg, err := Resolve("")
	if err != nil {
		t.Fatalf("Resolve(\"\") err = %v, want nil", err)
	}
	if cfg.EstateTZ != "America/New_York" {
		t.Fatalf("EstateTZ = %q, want %q", cfg.EstateTZ, "America/New_York")
	}
}

// TestResolveFlagBeatsEnv proves the flag wins over the env when both are set (spec
// §5.2: "--estate-tz flag > CCP_ESTATE_TZ env").
func TestResolveFlagBeatsEnv(t *testing.T) {
	t.Setenv(EstateTZEnv, "America/New_York")
	cfg, err := Resolve("Europe/London")
	if err != nil {
		t.Fatalf("Resolve err = %v, want nil", err)
	}
	if cfg.EstateTZ != "Europe/London" {
		t.Fatalf("EstateTZ = %q, want %q (flag must beat env)", cfg.EstateTZ, "Europe/London")
	}
}

// TestResolveExplicitUTCBeatsEnv proves an explicit "UTC" flag value is honoured
// even when the env names something else — the flag branch is keyed on the flag
// being non-empty, not on it disagreeing with the default.
func TestResolveExplicitUTCBeatsEnv(t *testing.T) {
	t.Setenv(EstateTZEnv, "America/New_York")
	cfg, err := Resolve("UTC")
	if err != nil {
		t.Fatalf("Resolve err = %v, want nil", err)
	}
	if cfg.EstateTZ != "UTC" {
		t.Fatalf("EstateTZ = %q, want %q", cfg.EstateTZ, "UTC")
	}
}

// TestResolveUnknownZone is the startup-config-error test (spec §5.3): an
// unresolvable tz name fails closed with an error naming the bad value, BEFORE any
// verdict can be produced — the caller (each subcommand's run) maps this to exit 3
// ahead of request.Load / windowcheck.Evaluate.
func TestResolveUnknownZone(t *testing.T) {
	_, err := Resolve("Not/AZone")
	if err == nil {
		t.Fatal("Resolve(\"Not/AZone\") err = nil, want a startup config error")
	}
	if !strings.Contains(err.Error(), "Not/AZone") {
		t.Fatalf("err = %v, want it to name the bad value %q", err, "Not/AZone")
	}
}

// TestResolveUnknownZoneFromEnv proves the same fail-closed behaviour when the bad
// value comes from CCP_ESTATE_TZ rather than the flag — a typo'd CI repo variable
// fails loudly too, never half-works (spec §5.3).
func TestResolveUnknownZoneFromEnv(t *testing.T) {
	t.Setenv(EstateTZEnv, "Definitely/Not_A_Real_Zone")
	_, err := Resolve("")
	if err == nil {
		t.Fatal("Resolve err = nil, want a startup config error for a bad env value")
	}
	if !strings.Contains(err.Error(), "Definitely/Not_A_Real_Zone") {
		t.Fatalf("err = %v, want it to name the bad value", err)
	}
	if !strings.Contains(err.Error(), EstateTZEnv) {
		t.Fatalf("err = %v, want it to name %s so the operator knows which knob to fix", err, EstateTZEnv)
	}
}
