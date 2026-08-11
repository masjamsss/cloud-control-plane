import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * OPS-6 — a plain `compose up` silently stripped the armed overlay, including on every
 * nightly self-update cycle.
 *
 * Arming the bundle/drift lanes was documented as a ONE-SHOT command:
 *
 *     docker compose -f docker-compose.yml -f docker-compose.armed.yml up -d
 *
 * which arms the CONTAINER and records nothing about the DEPLOYMENT. Every scripted re-up
 * afterwards — `self-update.sh` nightly at 03:17, an `install.sh` re-run, the
 * `migrate-data.sh` cutover — runs a bare `docker compose up -d --build`, which resolves
 * docker-compose.yml alone and recreates the api with no docker socket, no /data/scratch
 * bind and no TMPDIR. The armed lanes then fail with a docker-cannot-connect error that
 * nothing on the host explains.
 *
 * The fix makes arming a property of the deployment (`COMPOSE_FILE` in `.env`) and has the
 * three scripts refuse when a running-armed api meets a not-armed config. This file pins
 * both halves.
 *
 * WHY THIS LIVES IN THE API SUITE. `ccp/scripts/test/*.test.sh` looks like the natural
 * home, and it is where a sibling compose check already lives — but nothing runs those:
 * no workflow, no gate script, no npm script references any of them (grep-verified). A
 * regression test that never executes is the defect this audit keeps finding, not a fix
 * for one. The api suite runs on every CI job that touches `ccp/`, so the check lives
 * where it actually fires. (Wiring the shell suite into CI is a workflow change, which
 * belongs to the batch that owns `.github/workflows/` — recorded as residue instead.)
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CCP_DIR = join(HERE, '..', '..');
const SCRIPTS = join(CCP_DIR, 'scripts');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Does the docker CLI resolve compose files here? Config resolution needs no daemon. */
function composeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway copy of the compose files plus a `.env` holding the required variables, so
 * `docker compose config` resolves without touching the real deployment or needing a daemon.
 */
function fixture(extraEnv = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-armed-'));
  tmpDirs.push(dir);
  cpSync(join(CCP_DIR, 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
  cpSync(join(CCP_DIR, 'docker-compose.armed.yml'), join(dir, 'docker-compose.armed.yml'));
  writeFileSync(
    join(dir, '.env'),
    [
      'VITE_API_BASE=https://ccp.example.com/api',
      // PG-5 recognises 'not-a-real-secret' as a placeholder marker (see
      // ccp/scripts/test/compose-logging-and-limits.test.sh for the same fixture
      // shape) — an arbitrary-looking placeholder value trips the publish gate.
      'CCP_TOTP_KEY=not-a-real-secret',
      'CCP_SCANNER_KEY=not-a-real-secret',
      'CCP_DOCKER_GID=999',
      extraEnv,
    ].join('\n'),
  );
  return dir;
}

/** True when the config `up` would create mounts the docker socket into the api. */
function resolvesArmed(dir: string, args: string[] = []): boolean {
  const out = execFileSync('docker', ['compose', ...args, 'config'], { cwd: dir, encoding: 'utf8' });
  return out.includes('/var/run/docker.sock');
}

describe.runIf(composeAvailable())('arming survives the re-ups that actually happen', () => {
  it('the overlay really does arm — otherwise every check below is vacuous', () => {
    // L-1: if the overlay stopped granting the socket, "plain up is disarmed" would be
    // trivially true and this suite would pass while protecting nothing.
    expect(
      resolvesArmed(fixture(), ['-f', 'docker-compose.yml', '-f', 'docker-compose.armed.yml']),
      'setup: the armed overlay must mount the docker socket',
    ).toBe(true);
  });

  it('a plain `compose up` is NOT armed — which is the whole defect', () => {
    expect(resolvesArmed(fixture())).toBe(false);
  });

  it('COMPOSE_FILE in .env makes arming survive a plain `compose up`', () => {
    const dir = fixture('COMPOSE_FILE=docker-compose.yml:docker-compose.armed.yml');
    expect(
      resolvesArmed(dir),
      'with COMPOSE_FILE set, the bare `docker compose up -d --build` that install.sh and self-update.sh run must still resolve the overlay',
    ).toBe(true);
  });
});

/**
 * Text a script PRINTS (a diagnostic, a "here's the command" suggestion) is never this
 * script EXECUTING that command — so `doctor.sh`/`setup.sh` REPORTING
 * `` `docker compose up` `` in a status line or a next-steps banner must not be mistaken
 * for a re-up either one performs. That is the exact false positive both produced before
 * this existed.
 *
 * Two passes, both intentionally coarse rather than a general shell parser:
 *
 *  1. Drop heredoc BODIES (`<<EOF … EOF`) — `setup.sh`'s next-steps banner lives in one.
 *  2. For everything else, a same-LINE quote-parity scan: walk each line's characters up
 *     to a candidate match and count unescaped quote marks: an odd count of either kind
 *     means the match sits inside an open quote, i.e. it is an ARGUMENT to whatever print
 *     helper opened it (`ok "…`, `row OK docker "…`, `printf '…`, …) rather than a command
 *     this line executes. Scoped to ONE line on purpose: a naive multi-line `'[^']*'` was
 *     tried first, and an apostrophe in an English prose comment ("operator's", "doesn't")
 *     paired with a LATER, unrelated apostrophe and silently ate real code between them —
 *     including the very invocations this test exists to find. A per-line scan cannot do
 *     that, and needs no list of helper names to stay right when a new one (`row`, found
 *     by this exact scan replacing an earlier name-list attempt) is added later.
 */
function stripNonExecutedText(src: string): string {
  return src.replace(/<<-?['"]?(\w+)['"]?\n[\s\S]*?\n[ \t]*\1\b/g, '');
}

/** True if `line[idx]` sits inside a single- or double-quoted span opened earlier on the
 *  SAME line. See {@link stripNonExecutedText} for why this stays line-scoped. */
function insideQuotesOnLine(line: string, idx: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < idx; i++) {
    if (line[i] === "'" && !inDouble) inSingle = !inSingle;
    else if (line[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

/** Does this script itself EXECUTE a `compose … up` (directly, or via the local `compose`/
 *  `compose_rollback` wrapper both real scripts use) anywhere outside a printed string? */
function reupsApi(text: string): boolean {
  const re = /\bcompose(_rollback)?\s+up\b|docker compose up/g;
  for (const line of stripNonExecutedText(text).split('\n')) {
    for (const m of line.matchAll(re)) {
      if (!insideQuotesOnLine(line, m.index!)) return true;
    }
  }
  return false;
}

describe('every script that re-ups the api refuses to strip an armed deployment', () => {
  /**
   * The RULE, not the list (L-25): any shipped script that brings the api back up must
   * consult the shared armed-state guard. A fifth script added later gets caught by this
   * without anyone remembering to extend a list of four.
   */
  const REUP_SCRIPTS = ['self-update.sh', 'install.sh', 'migrate-data.sh', 'intranet-setup.sh'];

  it('the scripts that re-up the api are exactly the ones this rule covers', () => {
    // Setup assertion: derive the set from the scripts themselves, so a new re-upping
    // script fails this test rather than silently escaping the rule below. This caught a
    // REAL gap while this test was being written: intranet-setup.sh is documented as
    // re-runnable against an existing host and genuinely re-ups the api/app, and was
    // missing the guard entirely until this test's own setup assertion found it.
    const found = ['self-update.sh', 'install.sh', 'migrate-data.sh', 'doctor.sh', 'setup.sh', 'run-local.sh', 'intranet-setup.sh', 'nginx-vhost.sh']
      .filter((f) => {
        // A script that re-ups the DEPLOYED api. run-local.sh is excluded by
        // construction — it runs the api from source on a temp store and never
        // touches the deployed containers.
        return reupsApi(readFileSync(join(SCRIPTS, f), 'utf8')) && !/^run-local\.sh$/.test(f);
      });
    expect(found.sort()).toEqual([...REUP_SCRIPTS].sort());
  });

  it.each(REUP_SCRIPTS)('%s consults the shared armed-drift guard', (script) => {
    const text = readFileSync(join(SCRIPTS, script), 'utf8');
    expect(text, `${script} re-ups the api and must refuse when that would disarm it`).toContain('armed_drift_detected');
    expect(text, `${script} must source the shared guard rather than restating it (L-8)`).toContain('lib/armed.sh');
  });

  it('the guard refuses rather than silently re-arming', () => {
    // Re-applying the overlay automatically would be a script deciding on its own to grant
    // a container root-equivalence on the host. That decision needs an operator, and the
    // reasoning must stay attached to the code that makes it.
    const lib = readFileSync(join(SCRIPTS, 'lib', 'armed.sh'), 'utf8');
    expect(lib).toContain('armed_drift_detected');
    expect(lib, 'the guard compares the RUNNING container against the RESOLVED config').toContain('armed_in_running_api');
    expect(lib).toContain('armed_in_config');
  });

  it('doctor.sh reports arming that will not survive the next up', () => {
    const text = readFileSync(join(SCRIPTS, 'doctor.sh'), 'utf8');
    expect(text, 'doctor.sh is the one command an operator runs to ask whether the deployment is healthy').toMatch(/not sticky|STICKY/);
  });
});

describe('the sticky mechanism is documented where an operator will find it', () => {
  it('.env.example documents COMPOSE_FILE as the way to arm', () => {
    const env = readFileSync(join(CCP_DIR, '.env.example'), 'utf8');
    expect(env).toContain('COMPOSE_FILE=docker-compose.yml:docker-compose.armed.yml');
  });

  it('go-live.md no longer tells operators to arm with a one-shot -f -f command', () => {
    // The doc that taught the defect has to stop teaching it, or the next armed host is
    // built the same way. Prose describing WHY the one-shot form is wrong is fine and is
    // why this looks for the command form, not the filename.
    const doc = readFileSync(join(CCP_DIR, 'docs', 'go-live.md'), 'utf8');
    const oneShot = /docker compose\s+-f\s+docker-compose\.yml\s+-f\s+docker-compose\.armed\.yml\s+up/;
    const asInstruction = doc
      .split('\n')
      .filter((l) => oneShot.test(l))
      .filter((l) => !l.trimStart().startsWith('>')); // block quotes explain the trap
    expect(asInstruction, 'go-live.md still instructs the one-shot arming that OPS-6 is about').toEqual([]);
    expect(doc, 'and it must give the sticky form instead').toContain('COMPOSE_FILE=docker-compose.yml:docker-compose.armed.yml');
  });
});
