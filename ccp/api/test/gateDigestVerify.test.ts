import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGateDigest, runBundle, verifyGateDigest, type BundleSteps } from '../src/domain/bundle';

/**
 * ARCH-3 — the "reviewed-plan ≡ applied-plan" guardrail was delegated to an operator's
 * shell string.
 *
 * ADR-0016 makes "the plan must equal the approved change" an Owner requirement, binding,
 * and says the API re-derives the change and runs the plan-check gates. As built, the api
 * spawned `bash -lc "$CCP_BUNDLE_GATE_CMD"` and trusted EXIT 0. The R-gates, the digest
 * pin, and even which tool ran at all were the operator's command string. So the product's
 * central safety property — "what was reviewed is exactly what runs; any difference at all,
 * and it stops" — held only on deployments whose operator wrote the right command, and a
 * typo'd or weakened gate produced a green bundle with nothing in-product violated and
 * nothing in the audit trail to show it.
 *
 * The api now verifies the property itself, before committing. What is pinned here is the
 * four-way decision, because the interesting cases are the two that are NOT a plain
 * match/mismatch.
 */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('parseGateDigest — reading what the gate says it produced', () => {
  it('finds the digest line anywhere in the output', () => {
    expect(parseGateDigest(`running plan-check\nccp-plan-digest: ${DIGEST_A}\ndone`)).toBe(DIGEST_A);
  });

  it('is case-insensitive on the label and normalises the hex', () => {
    expect(parseGateDigest(`CCP-Plan-Digest: ${'A'.repeat(64)}`)).toBe(DIGEST_A);
  });

  it('takes the LAST line when a gate prints more than one', () => {
    // A multi-step gate may report per-step; the final one is the plan that would land.
    expect(parseGateDigest(`ccp-plan-digest: ${DIGEST_A}\nccp-plan-digest: ${DIGEST_B}`)).toBe(DIGEST_B);
  });

  it('returns null for no line, a short hex, or a non-hex value', () => {
    expect(parseGateDigest('gate green')).toBeNull();
    expect(parseGateDigest('ccp-plan-digest: abc123')).toBeNull();
    expect(parseGateDigest(`ccp-plan-digest: ${'z'.repeat(64)}`)).toBeNull();
  });
});

describe('verifyGateDigest — the four-way decision', () => {
  it('VERIFIED: pinned and the gate reports the same digest', () => {
    const v = verifyGateDigest(DIGEST_A, `ccp-plan-digest: ${DIGEST_A}`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.state).toBe('verified');
  });

  it('REFUSES a mismatch — this is the finding’s whole subject', () => {
    // The plan that would land is not the plan that was approved. Nothing about the gate's
    // exit code can express this, which is why it has to be checked here.
    const v = verifyGateDigest(DIGEST_A, `ccp-plan-digest: ${DIGEST_B}`);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/PLAN MISMATCH/);
  });

  it('REFUSES silence when the request is pinned — an optional safety check is not one', () => {
    // Accepting a missing digest would let any operator command skip the check by
    // omission, which is the original defect wearing a different hat (L-1).
    const v = verifyGateDigest(DIGEST_A, 'gate green');
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/reported no digest/);
  });

  it('does NOT refuse when the request carries no pin — but says it is unverified', () => {
    // Today that is every request (API-3: no pin-writer is deployed). Refusing would stop
    // the bundle working at all; claiming verification would be a lie. It reports neither.
    const v = verifyGateDigest(undefined, 'gate green');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.state).toBe('unpinned');
    expect(v.detail).toMatch(/NOT verified/);
  });

  it('an unpinned request whose gate DOES report a digest is still not "verified"', () => {
    // There is nothing to compare against. Treating the gate's own claim as confirmation
    // would be letting the thing being checked grade itself.
    const v = verifyGateDigest(undefined, `ccp-plan-digest: ${DIGEST_A}`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.state).toBe('unpinned');
    expect(v.detail).toMatch(/NOT verified/);
  });

  it('treats an empty pin like no pin, not like a digest that can never match', () => {
    expect(verifyGateDigest('', 'gate green').ok).toBe(true);
  });
});

describe('runBundle refuses BEFORE committing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function steps(gateOut: string, seen: string[]): BundleSteps {
    // A REAL directory: runBundle writes the request payload into it before gating, so a
    // fake path throws there and the gate never runs — which silently turned both of these
    // into vacuous passes on the first attempt.
    const dir = mkdtempSync(join(tmpdir(), 'ccp-gate-digest-'));
    dirs.push(dir);
    return {
      prepare: () => ({ dir, baseSha: 'deadbeef' }),
      gate: () => {
        seen.push('gate');
        return { ok: true, detail: gateOut };
      },
      commit: () => {
        seen.push('commit');
        return { ok: true, detail: 'committed', sha: 'f'.repeat(40) };
      },
      trigger: () => {
        seen.push('trigger');
        return { ok: true, detail: 'triggered' };
      },
      cleanup: () => undefined,
    };
  }

  it('a mismatched digest stops the bundle without committing or triggering', async () => {
    // The ordering is the safety property: a refusal AFTER the commit would already have
    // landed the wrong plan on main, which is what the audit trail could not show.
    const seen: string[] = [];
    const out = await runBundle(
      steps(`ccp-plan-digest: ${DIGEST_B}`, seen),
      JSON.stringify({ id: 'r1', planDigest: DIGEST_A }),
      'msg',
    );

    expect(seen, 'commit and trigger must never run').toEqual(['gate']);
    expect(out?.ok).toBe(false);
    expect(out?.steps.at(-1)?.step).toBe('plan-digest');
    expect(out?.steps.at(-1)?.detail).toMatch(/PLAN MISMATCH/);
  });

  it('an unpinned request still commits — the check must not brick the bundle', async () => {
    const seen: string[] = [];
    const out = await runBundle(steps('gate green', seen), JSON.stringify({ id: 'r1' }), 'msg');
    expect(seen).toEqual(['gate', 'commit', 'trigger']);
    expect(out?.ok).toBe(true);
  });
});
