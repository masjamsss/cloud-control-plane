import { describe, expect, it } from 'vitest';
import {
  digestsValid,
  onboardCommand,
  statusLabel,
  stepForStatus,
  summarizeTrustRequest,
  summarizePrescanReport,
  summaryFromWire,
  trustedRerunCommand,
  trustControlRenders,
} from '@/features/admin/projectsFlow';

/**
 * W5/N3 — the wizard's pure logic. The old paste-box expected
 * `{repo, commitSha, verdict, findings}` in ONE file, which `catalogctl
 * onboard` has never produced (papercut P1: a genuine artifact failed the
 * UI's own shape check). The real contract is a PAIR: trust-request.json is
 * the `{repo, commitSha, prescanSha256}` triple, and the verdict/findings/
 * census live in prescan-report.json. Both parsers fail soft — pasted JSON
 * never throws into the UI — and the trust control's render rule is
 * fail-closed: no clean verdict, no button.
 */

const SHA = 'c'.repeat(64);

/** Exactly what onboard.go writes into trust-request.json — three keys. */
const REAL_TRUST_REQUEST = {
  repo: 'terraform-acme',
  commitSha: 'abc123def4567890abc123def4567890abc123de',
  prescanSha256: SHA,
};

/** Exactly what onboard.go writes into prescan-report.json (key set pinned
 * Go-side by TestPrescanReportShape_IsTheWizardContract). */
const CLEAN_REPORT = {
  repo: 'terraform-acme',
  verdict: 'clean',
  findings: [],
  resourceBlocks: 12,
  moduleBlocks: 1,
  tfJsonFiles: 0,
  fmtDirtyFiles: 2,
  providerPins: { aws: '~> 6.0' },
};

const REJECT_REPORT = {
  ...CLEAN_REPORT,
  verdict: 'reject',
  findings: [
    { code: 'PROVISIONER', file: 'main.tf', line: 12 },
    { code: 'DATA_EXTERNAL', file: 'data.tf', line: 3 },
  ],
};

describe('summarizeTrustRequest — the REAL artifact schema (P1 closed)', () => {
  it('accepts exactly what catalogctl onboard writes', () => {
    expect(summarizeTrustRequest(REAL_TRUST_REQUEST)).toEqual(REAL_TRUST_REQUEST);
  });

  it("rejects the paste-box's OLD imagined shape (verdict/findings do not live in this file)", () => {
    expect(
      summarizeTrustRequest({ repo: 'x', commitSha: 'y', verdict: 'clean', findings: [] }),
    ).toBeNull();
  });

  it('requires a 64-hex prescanSha256 (the binding the server verifies)', () => {
    expect(summarizeTrustRequest({ ...REAL_TRUST_REQUEST, prescanSha256: 'short' })).toBeNull();
    expect(
      summarizeTrustRequest({ ...REAL_TRUST_REQUEST, prescanSha256: 'Z'.repeat(64) }),
    ).toBeNull();
  });

  it('fails soft on non-objects and missing fields, never throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'text',
      [1, 2],
      {},
      { repo: 'x' },
      { repo: 'x', commitSha: '' },
    ]) {
      expect(() => summarizeTrustRequest(bad)).not.toThrow();
      expect(summarizeTrustRequest(bad)).toBeNull();
    }
  });
});

describe('summarizePrescanReport — verdict, findings, census', () => {
  it('summarizes a clean report with its census', () => {
    const s = summarizePrescanReport(CLEAN_REPORT);
    expect(s).not.toBeNull();
    expect(s!.verdict).toBe('clean');
    expect(s!.findings).toEqual([]);
    expect(s!.census).toEqual({
      resourceBlocks: 12,
      moduleBlocks: 1,
      tfJsonFiles: 0,
      fmtDirtyFiles: 2,
      providerPins: { aws: '~> 6.0' },
    });
  });

  it('summarizes a reject report with its findings rows', () => {
    const s = summarizePrescanReport(REJECT_REPORT);
    expect(s!.verdict).toBe('reject');
    expect(s!.findings).toHaveLength(2);
    expect(s!.findings[0]).toEqual({ code: 'PROVISIONER', file: 'main.tf', line: 12 });
  });

  it('refuses the clean-with-findings contradiction (a hand-edited verdict never renders a clean badge)', () => {
    expect(
      summarizePrescanReport({
        ...CLEAN_REPORT,
        findings: [{ code: 'PROVISIONER', file: 'a.tf', line: 1 }],
      }),
    ).toBeNull();
    expect(summarizePrescanReport({ ...REJECT_REPORT, findings: [] })).toBeNull();
  });

  it('fails soft on wrong shapes: off-enum verdicts, malformed findings, missing census, bad pins', () => {
    for (const bad of [
      null,
      'text',
      { ...CLEAN_REPORT, verdict: 'maybe' },
      { ...REJECT_REPORT, findings: ['PROVISIONER'] },
      { ...CLEAN_REPORT, resourceBlocks: 'twelve' },
      { ...CLEAN_REPORT, resourceBlocks: undefined },
      { ...CLEAN_REPORT, providerPins: { aws: 6 } },
      { ...CLEAN_REPORT, providerPins: null },
    ]) {
      expect(() => summarizePrescanReport(bad)).not.toThrow();
      expect(summarizePrescanReport(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });

  it('summaryFromWire shapes the server-stored report identically to a local parse', () => {
    expect(summaryFromWire(CLEAN_REPORT as never)).toEqual(summarizePrescanReport(CLEAN_REPORT));
  });
});

describe('trustControlRenders — the fail-closed render rule (review stays a human decision)', () => {
  it('renders ONLY for a present, clean report', () => {
    expect(trustControlRenders(summarizePrescanReport(CLEAN_REPORT))).toBe(true);
  });

  it('no report ⇒ no control; reject ⇒ no control, full stop', () => {
    expect(trustControlRenders(null)).toBe(false);
    expect(trustControlRenders(undefined)).toBe(false);
    expect(trustControlRenders(summarizePrescanReport(REJECT_REPORT))).toBe(false);
  });
});

describe('wizard derivations', () => {
  it('stepForStatus follows the server status ladder', () => {
    expect(stepForStatus(undefined)).toBe(1);
    expect(stepForStatus('draft')).toBe(2);
    expect(stepForStatus('pending-trust')).toBe(3);
    // trusted lands on "Connect the repo's CI" (step 5, activate, renders
    // alongside once that CI stages an upload).
    expect(stepForStatus('trusted')).toBe(4);
    expect(stepForStatus('ready')).toBe('done');
  });

  it('statusLabel renders plain words, never the raw enum', () => {
    for (const status of ['draft', 'pending-trust', 'trusted', 'ready'] as const) {
      const label = statusLabel(status);
      expect(label).not.toContain('pending-trust');
      expect(label.length).toBeGreaterThan(3);
    }
    expect(statusLabel('ready')).toBe('Ready');
  });

  it('the copy-paste commands carry the project id and the exact trusted commit', () => {
    expect(onboardCommand('acme')).toBe(
      'catalogctl onboard <path-to-your-checkout> --project-id acme --out out/',
    );
    expect(trustedRerunCommand('acme', 'abc123')).toContain('--trusted-commit abc123');
    expect(trustedRerunCommand('acme', 'abc123')).toContain('--project-id acme');
  });

  it('digestsValid requires three 64-hex digests', () => {
    const ok = {
      inventorySha256: 'a'.repeat(64),
      blocksSha256: 'b'.repeat(64),
      manifestsSha256: 'c'.repeat(64),
    };
    expect(digestsValid(ok)).toBe(true);
    expect(digestsValid({ ...ok, blocksSha256: 'nope' })).toBe(false);
    expect(digestsValid({ ...ok, inventorySha256: '' })).toBe(false);
  });
});
