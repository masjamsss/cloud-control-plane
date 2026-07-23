// Package estatecfg resolves the estate-wide configuration catalogctl needs — today,
// only the operating timezone — ONCE per invocation, at the top of whichever
// subcommand is running, and hands it down as a plain value (estate-config,
// ADR-0028; spec docs/superpowers/specs/2026-07-22-ccp-estate-config-at-setup.md
// §5.2/5.3). Nothing below this package reads a flag or an env var for it:
// request.Load and windowcheck.Evaluate take Config as a parameter and stay pure.
package estatecfg

import (
	"fmt"
	"os"
	"time"
)

// DefaultEstateTZ is the compiled-in default when neither --estate-tz nor
// CCP_ESTATE_TZ is set. The blank public install (ADR-0020) names no estate zone
// on day one (spec §7), so the public tool source carries only "UTC".
const DefaultEstateTZ = "UTC"

// EstateTZEnv is the CI-projected repo variable scripts/ci/apply-window-gate.sh
// mirrors into --estate-tz, alongside CCP_FREEZE (spec §5.2, mechanism C: the
// same precedent used to project estate state into CI through the wrapper script).
const EstateTZEnv = "CCP_ESTATE_TZ"

// FlagUsage is the shared --estate-tz flag help text every tz-needing subcommand
// registers verbatim, so `catalogctl <cmd> -h` reads identically across commands.
const FlagUsage = `estate operating timezone (IANA name); precedence: this flag > ` + EstateTZEnv + ` env > "` + DefaultEstateTZ + `" (estate-config, ADR-0028)`

// Config is the estate-wide configuration resolved once and threaded down to every
// package that needs it.
type Config struct {
	// EstateTZ is the IANA zone name a request's window.tz is checked against —
	// provenance metadata only; every scheduling comparison stays a UTC instant
	// (ADR-0028, spec §5.1).
	EstateTZ string
	// Loc is EstateTZ resolved via time.LoadLocation, for estate-local display
	// rendering only (windowcheck.renderEstateLocal). Always non-nil in a Config
	// returned by Resolve.
	Loc *time.Location
}

// Resolve applies the precedence order (spec §5.2) — flagValue (from the caller's
// own --estate-tz flag, "" if unset) > the CCP_ESTATE_TZ env > DefaultEstateTZ —
// then loads the IANA zone once via time.LoadLocation. cmd/catalogctl/main.go blank-
// imports time/tzdata so this resolves from the embedded IANA database and never
// depends on the host's system tzdata.
//
// A name that fails to resolve is a startup config error: the caller maps it to
// exit 3 BEFORE producing any verdict (spec §5.3) — a typo'd CCP_ESTATE_TZ (or
// --estate-tz) fails loudly, never half-works.
func Resolve(flagValue string) (Config, error) {
	tz := flagValue
	if tz == "" {
		tz = os.Getenv(EstateTZEnv)
	}
	if tz == "" {
		tz = DefaultEstateTZ
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return Config{}, fmt.Errorf("estate-config: --estate-tz/%s %q does not resolve to a known IANA timezone: %w", EstateTZEnv, tz, err)
	}
	return Config{EstateTZ: tz, Loc: loc}, nil
}
