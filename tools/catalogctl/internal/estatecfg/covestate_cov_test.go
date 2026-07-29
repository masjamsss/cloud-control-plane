package estatecfg

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
	_ "time/tzdata" // same blank import cmd/catalogctl/main.go carries, so these tests resolve zones from the embedded IANA database and never depend on the runner's system tzdata
)

// covestateFixedJan / covestateFixedJul are fixed UTC instants on either side of the
// northern-hemisphere DST boundary. Every zone assertion below is made at one of
// these two instants, never at time.Now(), so the expectations are deterministic.
var (
	covestateFixedJan = time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	covestateFixedJul = time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
)

// TestCovestateResolvePrecedenceMatrix walks the full flag × env matrix of spec §5.2
// ("this flag > CCP_ESTATE_TZ env > DefaultEstateTZ"), including the two cases the
// existing tests leave out: an env var that is *set but empty* (must be treated as
// unset, not as an unresolvable zone name), and a junk flag beating a perfectly good
// env value (precedence is keyed on the flag being non-empty, so a typo'd flag must
// fail loudly rather than silently fall back to the env).
func TestCovestateResolvePrecedenceMatrix(t *testing.T) {
	cases := []struct {
		name    string
		flag    string
		env     string // "" ⇒ do not set the variable at all
		setEnv  bool   // true with env "" ⇒ set it to the empty string
		wantTZ  string
		wantErr bool
	}{
		{name: "no flag no env falls back to compiled default", wantTZ: DefaultEstateTZ},
		{name: "flag only", flag: "Europe/London", wantTZ: "Europe/London"},
		{name: "env only", env: "Asia/Kolkata", setEnv: true, wantTZ: "Asia/Kolkata"},
		{name: "flag beats env", flag: "Europe/London", env: "Asia/Kolkata", setEnv: true, wantTZ: "Europe/London"},
		{name: "empty env is treated as unset", env: "", setEnv: true, wantTZ: DefaultEstateTZ},
		{name: "junk flag beats good env and fails closed", flag: "Not/AZone", env: "Asia/Kolkata", setEnv: true, wantErr: true},
		{name: "junk env with no flag fails closed", env: "Not/AZone", setEnv: true, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.setEnv {
				t.Setenv(EstateTZEnv, tc.env)
			} else {
				// Guarantee the variable really is absent for the "unset" rows,
				// whatever the ambient environment of the test runner is.
				t.Setenv(EstateTZEnv, "")
				if err := os.Unsetenv(EstateTZEnv); err != nil {
					t.Fatalf("os.Unsetenv(%s): %v", EstateTZEnv, err)
				}
			}
			cfg, err := Resolve(tc.flag)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Resolve(%q) err = nil, want a startup config error", tc.flag)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q) err = %v, want nil", tc.flag, err)
			}
			if cfg.EstateTZ != tc.wantTZ {
				t.Fatalf("EstateTZ = %q, want %q", cfg.EstateTZ, tc.wantTZ)
			}
			if cfg.Loc == nil {
				t.Fatal("Loc = nil, want a resolved *time.Location (Resolve promises non-nil on success)")
			}
		})
	}
}

// TestCovestateResolveLocMatchesEstateTZ pins the invariant windowcheck depends on:
// the loaded Loc is the zone EstateTZ names, and EstateTZ is kept verbatim — no
// normalisation, no aliasing. windowcheck.Evaluate string-compares a request's
// window.tz against cfg.EstateTZ and renders refusal reasons through cfg.Loc, so an
// estate configured "Etc/UTC" must stay "Etc/UTC" and not silently become "UTC".
func TestCovestateResolveLocMatchesEstateTZ(t *testing.T) {
	for _, tz := range []string{"UTC", "Etc/UTC", "GMT", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Adelaide"} {
		t.Run(tz, func(t *testing.T) {
			cfg, err := Resolve(tz)
			if err != nil {
				t.Fatalf("Resolve(%q) err = %v, want nil", tz, err)
			}
			if cfg.EstateTZ != tz {
				t.Fatalf("EstateTZ = %q, want the value verbatim (%q)", cfg.EstateTZ, tz)
			}
			if got := cfg.Loc.String(); got != tz {
				t.Fatalf("Loc.String() = %q, want %q — Loc must be the zone EstateTZ names", got, tz)
			}
		})
	}
}

// TestCovestateResolveLocCarriesRealZoneData proves Loc is genuine IANA zone data and
// not a fixed-offset stand-in: offsets are checked at two fixed instants either side
// of a DST transition, plus a half-hour zone. windowcheck.renderEstateLocal formats
// refusal reasons in this location, so wrong-side-of-DST data would print a wrong
// wall clock in an operator-facing refusal.
func TestCovestateResolveLocCarriesRealZoneData(t *testing.T) {
	cases := []struct {
		tz                   string
		janOffset, julOffset int
		janAbbrev, julAbbrev string
	}{
		{tz: "UTC", janOffset: 0, julOffset: 0, janAbbrev: "UTC", julAbbrev: "UTC"},
		{tz: "America/New_York", janOffset: -5 * 3600, julOffset: -4 * 3600, janAbbrev: "EST", julAbbrev: "EDT"},
		{tz: "Asia/Kolkata", janOffset: 5*3600 + 30*60, julOffset: 5*3600 + 30*60, janAbbrev: "IST", julAbbrev: "IST"},
	}
	for _, tc := range cases {
		t.Run(tc.tz, func(t *testing.T) {
			cfg, err := Resolve(tc.tz)
			if err != nil {
				t.Fatalf("Resolve(%q) err = %v, want nil", tc.tz, err)
			}
			janAbbrev, janOff := covestateFixedJan.In(cfg.Loc).Zone()
			if janOff != tc.janOffset {
				t.Errorf("January offset = %d, want %d", janOff, tc.janOffset)
			}
			if janAbbrev != tc.janAbbrev {
				t.Errorf("January abbreviation = %q, want %q", janAbbrev, tc.janAbbrev)
			}
			julAbbrev, julOff := covestateFixedJul.In(cfg.Loc).Zone()
			if julOff != tc.julOffset {
				t.Errorf("July offset = %d, want %d", julOff, tc.julOffset)
			}
			if julAbbrev != tc.julAbbrev {
				t.Errorf("July abbreviation = %q, want %q", julAbbrev, tc.julAbbrev)
			}
		})
	}
}

// TestCovestateResolveRejectsMalformedNames is the fail-closed sweep of spec §5.3:
// anything that is not an exact IANA name is a startup config error, never a
// best-effort guess. In particular the resolver does no trimming and no case folding
// (IANA names are case-sensitive), and path-shaped values cannot be used to point the
// resolver at an arbitrary file. Each case also asserts the zero-Config invariant so
// a caller that mishandles err cannot proceed with a half-resolved estate zone.
func TestCovestateResolveRejectsMalformedNames(t *testing.T) {
	cases := []struct {
		name string
		tz   string
	}{
		{name: "unknown zone", tz: "Not/AZone"},
		{name: "wrong case region", tz: "utc"},
		{name: "wrong case city", tz: "America/new_york"},
		{name: "leading space not trimmed", tz: " UTC"},
		{name: "trailing space not trimmed", tz: "UTC "},
		{name: "trailing newline not trimmed", tz: "UTC\n"},
		{name: "whitespace only", tz: " "},
		{name: "parent traversal", tz: ".."},
		{name: "path traversal", tz: "../../etc/passwd"},
		{name: "absolute path", tz: "/etc/localtime"},
		{name: "utc offset is not an IANA name", tz: "+05:30"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := Resolve(tc.tz)
			if err == nil {
				t.Fatalf("Resolve(%q) err = nil, want a startup config error", tc.tz)
			}
			if cfg.EstateTZ != "" || cfg.Loc != nil {
				t.Fatalf("Resolve(%q) = %+v on error, want the zero Config so a dropped error cannot half-work", tc.tz, cfg)
			}
		})
	}
}

// TestCovestateResolveErrorIsDiagnosable checks the error an operator actually sees:
// it is attributed to estate-config, names BOTH knobs (flag and env) so they know
// where to look regardless of which one they set, quotes the offending value, and
// wraps the underlying time error rather than flattening it.
func TestCovestateResolveErrorIsDiagnosable(t *testing.T) {
	const bad = "Mars/Olympus_Mons"
	_, err := Resolve(bad)
	if err == nil {
		t.Fatalf("Resolve(%q) err = nil, want an error", bad)
	}
	msg := err.Error()
	for _, want := range []string{"estate-config", "--estate-tz", EstateTZEnv, `"` + bad + `"`} {
		if !strings.Contains(msg, want) {
			t.Errorf("err = %q, want it to mention %q", msg, want)
		}
	}
	inner := errors.Unwrap(err)
	if inner == nil {
		t.Fatalf("errors.Unwrap(err) = nil for %v, want the wrapped time.LoadLocation error", err)
	}
	if !strings.Contains(inner.Error(), bad) {
		t.Errorf("wrapped error = %q, want the underlying zone-lookup failure for %q", inner, bad)
	}
}

// TestCovestateResolveDoesNotMutateEnv proves Resolve only *reads* CCP_ESTATE_TZ. It
// is called once at the top of every subcommand and the resolved value is threaded
// down as a plain value, so it must not write the environment back (which would leak
// the flag value into any child process or subsequent read).
func TestCovestateResolveDoesNotMutateEnv(t *testing.T) {
	t.Setenv(EstateTZEnv, "Asia/Kolkata")
	if _, err := Resolve("Europe/London"); err != nil {
		t.Fatalf("Resolve err = %v, want nil", err)
	}
	if got := os.Getenv(EstateTZEnv); got != "Asia/Kolkata" {
		t.Fatalf("%s = %q after Resolve, want it untouched (%q)", EstateTZEnv, got, "Asia/Kolkata")
	}
	if _, err := Resolve("Not/AZone"); err == nil {
		t.Fatal("Resolve(\"Not/AZone\") err = nil, want an error")
	}
	if got := os.Getenv(EstateTZEnv); got != "Asia/Kolkata" {
		t.Fatalf("%s = %q after a failed Resolve, want it untouched (%q)", EstateTZEnv, got, "Asia/Kolkata")
	}
}

// TestCovestateResolveIsDeterministic proves repeated resolution of the same inputs
// yields the same estate zone and the same offsets at a fixed instant. Resolve is
// called once per invocation but several subcommands resolve it independently within
// one CI run, and their verdicts must agree.
func TestCovestateResolveIsDeterministic(t *testing.T) {
	t.Setenv(EstateTZEnv, "America/New_York")
	first, err := Resolve("")
	if err != nil {
		t.Fatalf("first Resolve err = %v, want nil", err)
	}
	second, err := Resolve("")
	if err != nil {
		t.Fatalf("second Resolve err = %v, want nil", err)
	}
	// Both calls must agree, AND agree on the RIGHT answer: comparing the two
	// results only to each other would also hold for a resolver that returned the
	// zero Config every time.
	for i, cfg := range []Config{first, second} {
		if cfg.EstateTZ != "America/New_York" {
			t.Fatalf("call %d EstateTZ = %q, want America/New_York (the env value)", i+1, cfg.EstateTZ)
		}
		if _, off := covestateFixedJul.In(cfg.Loc).Zone(); off != -4*3600 {
			t.Fatalf("call %d July offset = %d, want %d (EDT)", i+1, off, -4*3600)
		}
	}
}

// TestCovestateDefaultsAreSelfConsistent guards the compiled-in constants themselves:
// the blank-install default must be a resolvable zone (otherwise every command would
// exit 3 out of the box on a fresh install, spec §7), and the shared flag help text
// must describe the real precedence chain — same env name, same default — since every
// tz-needing subcommand registers FlagUsage verbatim.
func TestCovestateDefaultsAreSelfConsistent(t *testing.T) {
	if _, err := time.LoadLocation(DefaultEstateTZ); err != nil {
		t.Fatalf("DefaultEstateTZ %q does not resolve: %v", DefaultEstateTZ, err)
	}
	for _, want := range []string{"precedence", EstateTZEnv, DefaultEstateTZ} {
		if !strings.Contains(FlagUsage, want) {
			t.Errorf("FlagUsage = %q, want it to mention %q", FlagUsage, want)
		}
	}
}
