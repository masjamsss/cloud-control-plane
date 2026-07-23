import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateTime, type Schedule, type TimeVerdict } from '../src/domain/schedule';

/**
 * The LIVE half of T-S1's "matches window-check verdict-for-verdict" proof: this
 * shells out to the REAL `catalogctl window-check` binary (0024 §3.2, merged in the
 * pipeline wave) over the fixtures IT ALREADY OWNS
 * (`tools/catalogctl/testdata/windows/*.yaml`, the same ones
 * `windowcheck_test.go#TestRunFixtures` drives) and asserts the TypeScript port in
 * `domain/schedule.ts#evaluateTime` produces the IDENTICAL verdict token and exit
 * code, for the identical inputs, at a matrix of instants.
 *
 * The binary is BUILT once (`go build`) into a temp dir and invoked directly —
 * deliberately not `go run`, which prints "exit status N" to stderr and always
 * exits 1 itself on any non-zero child exit (a well-known `go run` quirk), which
 * would silently defeat an exit-code comparison.
 *
 * Best-effort: this repo's local gate (`scripts/gate.sh`) already treats Go as a
 * first-class toolchain dependency (`gate_go`), and `catalogctl.yml` provisions it
 * explicitly in CI — but `ccp-api.yml` (this suite's own CI job) does NOT set up
 * Go, and that workflow is out of this task's fence to fix. Skip (not fail) when
 * `go` is unavailable or the build fails, so an unrelated toolchain gap on that ONE
 * workflow can never turn into a spurious red X on this otherwise Go-independent
 * test suite — `schedule.test.ts`'s hand-transcribed parity table is the
 * toolchain-independent backstop that keeps running everywhere regardless.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGCTL_DIR = join(HERE, '../../../tools/catalogctl');
const FIXTURES_DIR = join(CATALOGCTL_DIR, 'testdata/windows');

/** Builds the real catalogctl binary once; null (never thrown) if Go/the build is unavailable. */
function buildCatalogctl(): string | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'catalogctl-parity-'));
    const bin = join(dir, process.platform === 'win32' ? 'catalogctl.exe' : 'catalogctl');
    const res = spawnSync('go', ['build', '-o', bin, './cmd/catalogctl'], {
      cwd: CATALOGCTL_DIR,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return res.status === 0 ? bin : null;
  } catch {
    return null;
  }
}

const CATALOGCTL_BIN = buildCatalogctl();
if (!CATALOGCTL_BIN) {
  // eslint-disable-next-line no-console
  console.warn('scheduleWindowCheckParity.test.ts: could not build catalogctl (go missing?) — skipping the live cross-check (see file header).');
}

// The shared fixtures are all windowed at their own literal tz value, `America/New_York`
// (windowed.yaml, cooling-window.yaml, garbled-window.yaml — the no-window fixtures don't
// carry a `window` block, so the tz check never applies to them). windowcheck.go's own
// `TestRunFixtures` (windowcheck_test.go) supplies this SAME `--estate-tz` for this SAME
// fixture set — without it the binary falls back to the compiled UTC default estate tz
// (ADR-0028/#37) and every America/New_York-tagged fixture becomes a cross-estate tz
// mismatch (SCHEDULE_INVALID, exit 3) regardless of `--at`. `evaluateTime` has no
// estate-tz concept at all (freeze is the one documented exclusion; estate-tz is a Go-side
// CLI/estatecfg parameterization the TS port never took on), so the comparison is only
// meaningful once both sides evaluate the fixtures against the SAME estate tz they were
// authored for — matching windowed-utc.yaml's separate UTC-default coverage on the Go side.
const FIXTURE_ESTATE_TZ = 'America/New_York';

function runWindowCheck(fixture: string, at: string): { code: number; stdout: string } {
  const res = spawnSync(CATALOGCTL_BIN!, ['window-check', '--request', join(FIXTURES_DIR, fixture), '--at', at, '--estate-tz', FIXTURE_ESTATE_TZ], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '' };
}

function goVerdictOf(stdout: string): string {
  const m = /verdict=(\S+)/.exec(stdout);
  if (!m) throw new Error(`no verdict= token in stdout: ${JSON.stringify(stdout)}`);
  return m[1]!;
}

/** windowcheck.go's `Verdict.ExitCode()` (windowcheck.go:50-61), mirrored for the assertion. */
function exitCodeFor(verdict: TimeVerdict): number {
  switch (verdict) {
    case 'IN_WINDOW':
    case 'NO_WINDOW':
      return 0;
    case 'BEFORE_WINDOW':
      return 5;
    case 'WINDOW_EXPIRED':
      return 6;
    default:
      return 3;
  }
}

// The exact fixtures windowcheck_test.go#TestRunFixtures drives, re-expressed as the
// TS Schedule/earliestApplyAt shape (transcribed from the YAML, not parsed — a
// second, independent reading of the same files guards against a copy-paste bug
// hiding a real divergence).
const FIXTURES: Record<string, { schedule: Schedule; earliestApplyAt?: string }> = {
  'windowed.yaml': {
    schedule: { kind: 'window', at: '2026-07-12T18:00:00Z', endAt: '2026-07-12T22:00:00Z' },
  },
  'no-window.yaml': {
    schedule: { kind: 'now' },
  },
  'cooling.yaml': {
    schedule: { kind: 'now' },
    earliestApplyAt: '2026-07-11T06:00:00Z',
  },
  'cooling-window.yaml': {
    schedule: { kind: 'window', at: '2026-07-12T18:00:00Z', endAt: '2026-07-12T22:00:00Z' },
    earliestApplyAt: '2026-07-12T19:00:00Z',
  },
  'garbled-window.yaml': {
    schedule: { kind: 'window', at: 'not-a-timestamp', endAt: '2026-07-12T22:00:00Z' },
  },
};

// One or more `--at` instants per fixture — chosen to land in every branch
// (before/inside/expired/boundary), mirroring windowcheck_test.go's own table.
const INSTANTS: Record<string, string[]> = {
  'windowed.yaml': ['2026-07-12T17:00:00Z', '2026-07-12T18:00:00Z', '2026-07-12T19:30:00Z', '2026-07-12T22:00:00Z', '2026-07-12T23:00:00Z'],
  'no-window.yaml': ['2000-01-01T00:00:00Z', '2026-07-12T19:00:00Z'],
  'cooling.yaml': ['2026-07-11T05:00:00Z', '2026-07-11T06:00:00Z', '2026-07-11T07:00:00Z'],
  'cooling-window.yaml': ['2026-07-12T17:00:00Z', '2026-07-12T18:30:00Z', '2026-07-12T19:00:00Z', '2026-07-12T22:30:00Z'],
  'garbled-window.yaml': ['2026-07-12T19:00:00Z'],
};

describe.skipIf(!CATALOGCTL_BIN)('evaluateTime vs. the real catalogctl window-check binary — verdict-for-verdict', () => {
  for (const [fixture, { schedule, earliestApplyAt }] of Object.entries(FIXTURES)) {
    for (const at of INSTANTS[fixture]!) {
      it(`${fixture} @ ${at}`, () => {
        const { code: goCode, stdout } = runWindowCheck(fixture, at);
        const goVerdict = goVerdictOf(stdout);

        const { verdict: tsVerdict } = evaluateTime(schedule, earliestApplyAt, Date.parse(at));

        expect(tsVerdict, `verdict mismatch for ${fixture} @ ${at}`).toBe(goVerdict);
        expect(exitCodeFor(tsVerdict), `exit code mismatch for ${fixture} @ ${at}`).toBe(goCode);
      });
    }
  }

  it('sanity: this actually executed real subprocess cases (not a vacuously-empty describe)', () => {
    const total = Object.values(INSTANTS).reduce((n, xs) => n + xs.length, 0);
    expect(total).toBeGreaterThanOrEqual(15);
  });
});
