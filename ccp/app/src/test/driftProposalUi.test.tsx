import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import type { DriftProposal, DriftVerdict } from '@/types/drift';
import type { ApiClient } from '@/lib/api';
import { driftProposalStateFor } from '@/features/drift/driftProposalState';
import {
  DRIFT_BLAST_RADIUS_NOTE,
  DRIFT_CLOUDTRAIL_POINTER,
  DRIFT_REVERT_DEPENDENCY_CAUTION,
  DriftProposalChip,
  ProposalDrawer,
} from '@/features/drift/ProposalDrawer';
import { DriftVerdictTable } from '@/features/drift/DriftPage';
import { submitDriftProposalVia } from '@/features/drift/proposalFlow';

/**
 * WI-7 of docs/superpowers/specs/2026-07-20-ccp-drift-portal.md: the
 * proposal chips/drawer/submit flow. Rendered as SSR strings (no jsdom in
 * this repo; react-dom/server, the DriftPanel/DriftPage precedent from
 * WI-3's driftPanel.test.tsx) — navigation is proved separately, at the
 * pure submitDriftProposalVia function, since renderToStaticMarkup strips
 * event handlers and cannot simulate a click.
 *
 * Pins THE BINDING INVARIANT: a security-posture verdict can never render
 * an adopt affordance, re-derived from the verdict's own fields — never
 * from a matched proposal's own `flavor` label, even an adversarially
 * forged one.
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

const BENIGN_VERDICT: DriftVerdict = {
  address: 'aws_instance.app01',
  type: 'aws_instance',
  actions: ['update'],
  class: 'benign_inplace',
  riskTier: 'low',
  driftEvidence: true,
  changedAttrs: [
    {
      path: 'tags.Owner',
      live: '"bi-team"',
      code: '"platform"',
      sensitive: false,
      liveJson: 'bi-team',
      codeJson: 'platform',
    },
  ],
  forceNewAttrs: [],
  securityHits: [],
};

const SECURITY_VERDICT: DriftVerdict = {
  address: 'aws_security_group.apm_agents',
  type: 'aws_security_group',
  actions: ['update'],
  class: 'security_posture',
  riskTier: 'high',
  driftEvidence: true,
  changedAttrs: [
    {
      path: 'ingress[0].cidr_blocks',
      live: '["0.0.0.0/0"]',
      code: '["10.0.0.0/16"]',
      sensitive: false,
      liveJson: ['0.0.0.0/0'],
      codeJson: ['10.0.0.0/16'],
    },
  ],
  forceNewAttrs: [],
  securityHits: [{ path: 'ingress[0].cidr_blocks', why: 'network reachability changed out-of-band' }],
};

const UNGENERABLE_VERDICT: DriftVerdict = {
  address: 'aws_instance.app02',
  type: 'aws_instance',
  actions: ['update'],
  class: 'benign_inplace',
  riskTier: 'medium', // not low → ungenerable
  driftEvidence: true,
  changedAttrs: [{ path: 'tags.Owner', sensitive: false, liveJson: 'a', codeJson: 'b' }],
  forceNewAttrs: [],
  securityHits: [],
};

const ADOPT_PROPOSAL: DriftProposal = {
  digest: 'a1'.repeat(32),
  flavor: 'adopt',
  status: 'open',
  addresses: [BENIGN_VERDICT.address],
  attrCount: 1,
  generatedAt: '2026-07-20T03:20:11Z',
  lastSeenReportVersion: 1,
  diff: '--- a/environments/prod/main.tf\n+++ b/environments/prod/main.tf\n@@ -1,3 +1,3 @@\n-Owner = "platform"\n+Owner = "bi-team"\n',
  attrs: [{ address: BENIGN_VERDICT.address, path: 'tags.Owner', liveJson: 'bi-team', codeJson: 'platform' }],
};

const REVERT_PROPOSAL: DriftProposal = {
  digest: 'b2'.repeat(32),
  flavor: 'revert',
  status: 'open',
  addresses: [SECURITY_VERDICT.address],
  attrCount: 1,
  generatedAt: '2026-07-20T03:20:11Z',
  lastSeenReportVersion: 1,
  diff: null,
  attrs: [
    { address: SECURITY_VERDICT.address, path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] },
  ],
};

/** A FORGED adopt proposal claiming to cover the SECURITY verdict's address
 * — simulates a tampered/buggy generation output. The UI must never trust
 * this label into rendering an adopt affordance. */
const FORGED_ADOPT_FOR_SECURITY: DriftProposal = {
  ...ADOPT_PROPOSAL,
  digest: 'c3'.repeat(32),
  addresses: [SECURITY_VERDICT.address],
};

/* ── drift restore tranche (L29): a restore-eligible out-of-band deletion ── */

const RESTORE_VERDICT: DriftVerdict = {
  address: 'aws_flow_log.prod_vpc',
  type: 'aws_flow_log',
  actions: ['create'],
  class: 'oob_deletion',
  riskTier: 'high',
  driftEvidence: true,
  changedAttrs: [],
  forceNewAttrs: [],
  securityHits: [],
};

const RESTORE_PROPOSAL: DriftProposal = {
  digest: 'c9'.repeat(32),
  flavor: 'restore',
  status: 'open',
  addresses: [RESTORE_VERDICT.address],
  attrCount: 0,
  generatedAt: '2026-07-21T03:20:11Z',
  lastSeenReportVersion: 1,
  diff: null,
  attrs: [],
};

/** A FORGED restore proposal claiming to cover the SECURITY verdict's
 * address — the restore-flavor mirror of {@link FORGED_ADOPT_FOR_SECURITY}. */
const FORGED_RESTORE_FOR_SECURITY: DriftProposal = {
  ...RESTORE_PROPOSAL,
  digest: 'd7'.repeat(32),
  addresses: [SECURITY_VERDICT.address],
};

describe('driftProposalStateFor — the five states, re-derived locally, never trusting a matched proposal label', () => {
  it('proposals undefined (Requester tier): null — no state at all', () => {
    expect(driftProposalStateFor(BENIGN_VERDICT, undefined)).toBeNull();
  });

  it('an adopt-eligible verdict with a matching open adopt proposal: adopt', () => {
    expect(driftProposalStateFor(BENIGN_VERDICT, [ADOPT_PROPOSAL])).toEqual({
      kind: 'adopt',
      proposal: ADOPT_PROPOSAL,
    });
  });

  it('a security verdict with a matching open revert proposal: revert', () => {
    expect(driftProposalStateFor(SECURITY_VERDICT, [REVERT_PROPOSAL])).toEqual({
      kind: 'revert',
      proposal: REVERT_PROPOSAL,
    });
  });

  it('THE BINDING INVARIANT: a security verdict paired with a forged adopt-flavored proposal for its address still never reads as adopt', () => {
    const state = driftProposalStateFor(SECURITY_VERDICT, [FORGED_ADOPT_FOR_SECURITY]);
    expect(state?.kind).not.toBe('adopt');
    // No matching REVERT proposal was supplied either, so the honest
    // fallback is 'not-armed' — never a guessed/forged adopt state.
    expect(state).toEqual({ kind: 'not-armed' });
  });

  it('an ungenerable verdict: ungenerable, with a runbook-pointing reason, regardless of proposals present', () => {
    expect(driftProposalStateFor(UNGENERABLE_VERDICT, [])?.kind).toBe('ungenerable');
  });

  it('an eligible verdict with no matching proposal at all: not-armed (the honest default explanation)', () => {
    expect(driftProposalStateFor(BENIGN_VERDICT, [])).toEqual({ kind: 'not-armed' });
  });

  it('drift restore tranche (L29): a restore-eligible verdict with a matching open restore proposal: restore', () => {
    expect(driftProposalStateFor(RESTORE_VERDICT, [RESTORE_PROPOSAL])).toEqual({
      kind: 'restore',
      proposal: RESTORE_PROPOSAL,
    });
  });

  it('THE BINDING INVARIANT, restore flavor: a security verdict paired with a forged restore-flavored proposal for its address still never reads as restore', () => {
    const state = driftProposalStateFor(SECURITY_VERDICT, [FORGED_RESTORE_FOR_SECURITY]);
    expect(state?.kind).not.toBe('restore');
    expect(state).toEqual({ kind: 'not-armed' });
  });
});

describe('DriftProposalChip — standalone render for each of the five states', () => {
  it('state null renders nothing at all', () => {
    expect(render(React.createElement(DriftProposalChip, { state: null }))).toBe('');
  });

  it('renders each state label verbatim', () => {
    expect(
      render(React.createElement(DriftProposalChip, { state: { kind: 'adopt', proposal: ADOPT_PROPOSAL } })),
    ).toContain('Adopt fix generated');
    expect(
      render(React.createElement(DriftProposalChip, { state: { kind: 'revert', proposal: REVERT_PROPOSAL } })),
    ).toContain('Revert only — security posture');
    expect(
      render(React.createElement(DriftProposalChip, { state: { kind: 'restore', proposal: RESTORE_PROPOSAL } })),
    ).toContain('Restore fix generated');
    expect(
      render(React.createElement(DriftProposalChip, { state: { kind: 'ungenerable', reason: 'riskTier "medium" is not low' } })),
    ).toContain('No mechanical fix — see runbook');
    expect(render(React.createElement(DriftProposalChip, { state: { kind: 'not-armed' } }))).toContain(
      'Generation not armed',
    );
  });

  it('ADVERSARIAL: adopt/revert/restore are the ONLY states rendering a <button> — ungenerable/not-armed are always a plain, non-interactive badge', () => {
    const clickable = (kind: 'adopt' | 'revert' | 'restore', proposal: DriftProposal): boolean =>
      render(React.createElement(DriftProposalChip, { state: { kind, proposal } as never })).includes('<button');
    expect(clickable('adopt', ADOPT_PROPOSAL)).toBe(true);
    expect(clickable('revert', REVERT_PROPOSAL)).toBe(true);
    expect(clickable('restore', RESTORE_PROPOSAL)).toBe(true);
    expect(
      render(
        React.createElement(DriftProposalChip, { state: { kind: 'ungenerable', reason: 'x' } }),
      ),
    ).not.toContain('<button');
    expect(render(React.createElement(DriftProposalChip, { state: { kind: 'not-armed' } }))).not.toContain(
      '<button',
    );
  });
});

describe('DriftVerdictTable / DriftProposalChip — security verdict renders revert-only, never an adopt affordance in the DOM', () => {
  it('a security verdict with a forged adopt proposal renders no "Adopt" text anywhere, and states it honestly', () => {
    const html = render(
      React.createElement(DriftVerdictTable, {
        verdicts: [SECURITY_VERDICT],
        proposals: [FORGED_ADOPT_FOR_SECURITY],
      }),
    );
    expect(html).not.toContain('Adopt');
    expect(html).toContain('Generation not armed');
  });

  it('a security verdict with a real revert proposal renders the revert chip, never adopt', () => {
    const html = render(
      React.createElement(DriftVerdictTable, { verdicts: [SECURITY_VERDICT], proposals: [REVERT_PROPOSAL] }),
    );
    expect(html).toContain('Revert only');
    expect(html).toContain('security posture');
    expect(html).not.toContain('Adopt fix generated');
  });

  it('a benign verdict with a real adopt proposal renders the adopt chip', () => {
    const html = render(
      React.createElement(DriftVerdictTable, { verdicts: [BENIGN_VERDICT], proposals: [ADOPT_PROPOSAL] }),
    );
    expect(html).toContain('Adopt fix generated');
  });

  it('generation-not-armed renders honestly: an eligible verdict with an empty proposals array', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [BENIGN_VERDICT], proposals: [] }));
    expect(html).toContain('Generation not armed');
  });

  it('an ungenerable verdict renders the runbook note, not a fix affordance', () => {
    const html = render(
      React.createElement(DriftVerdictTable, { verdicts: [UNGENERABLE_VERDICT], proposals: [] }),
    );
    expect(html).toContain('No mechanical fix');
    expect(html).toContain('see runbook');
  });

  it('requester tier (proposals absent): no Fix column, no chip, nothing proposal-shaped at all — the no-submit-affordance rule', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [SECURITY_VERDICT, BENIGN_VERDICT] }));
    expect(html).not.toContain('drift-fix');
    expect(html).not.toContain('Adopt fix generated');
    expect(html).not.toContain('Revert only');
    expect(html).not.toContain('>Fix<');
  });

  it('drift restore tranche (L29): a restore-eligible verdict with a real restore proposal renders the restore chip', () => {
    const html = render(
      React.createElement(DriftVerdictTable, { verdicts: [RESTORE_VERDICT], proposals: [RESTORE_PROPOSAL] }),
    );
    expect(html).toContain('Restore fix generated');
    expect(html).toContain('aws_flow_log.prod_vpc');
  });

  it('ADVERSARIAL: a security verdict with a forged restore proposal renders no "Restore" text anywhere, and states it honestly', () => {
    const html = render(
      React.createElement(DriftVerdictTable, {
        verdicts: [SECURITY_VERDICT],
        proposals: [FORGED_RESTORE_FOR_SECURITY],
      }),
    );
    expect(html).not.toContain('Restore');
    expect(html).toContain('Generation not armed');
  });

  it('a restore-eligible verdict with no matching proposal renders honestly as not armed, never a guessed restore chip', () => {
    const html = render(React.createElement(DriftVerdictTable, { verdicts: [RESTORE_VERDICT], proposals: [] }));
    expect(html).toContain('Generation not armed');
    expect(html).not.toContain('Restore fix generated');
  });
});

describe('ProposalDrawer — blast-radius note, diff-only-for-adopt, and the revert role gate', () => {
  const noop = (): void => {};
  const baseProps = {
    justification: '',
    onJustificationChange: noop,
    schedule: { kind: 'now' as const },
    onScheduleChange: noop,
    onSubmit: noop,
    onClose: noop,
    submitting: false,
  };

  it('the blast-radius note renders verbatim in the submit flow', () => {
    const html = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: BENIGN_VERDICT,
        proposal: ADOPT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(html).toContain(DRIFT_BLAST_RADIUS_NOTE);
  });

  it('adopt shows a diff preview; revert never shows one (no edit exists)', () => {
    const adoptHtml = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: BENIGN_VERDICT,
        proposal: ADOPT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(adoptHtml).toContain('Diff preview');

    const revertHtml = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: SECURITY_VERDICT,
        proposal: REVERT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(revertHtml).not.toContain('Diff preview');
    expect(revertHtml).toContain('No code edit');
  });

  it('addendum A6: a revert proposal renders the dependency/blast-radius caution AND the CloudTrail pointer; adopt renders neither', () => {
    const revertHtml = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: SECURITY_VERDICT,
        proposal: REVERT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(revertHtml).toContain(DRIFT_REVERT_DEPENDENCY_CAUTION);
    expect(revertHtml).toContain(DRIFT_CLOUDTRAIL_POINTER);

    const adoptHtml = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: BENIGN_VERDICT,
        proposal: ADOPT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(adoptHtml).not.toContain(DRIFT_REVERT_DEPENDENCY_CAUTION);
    expect(adoptHtml).not.toContain(DRIFT_CLOUDTRAIL_POINTER);
  });

  it('pinned attrs render the exact machine values (liveJson/codeJson), not the display strings', () => {
    const html = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: SECURITY_VERDICT,
        proposal: REVERT_PROPOSAL,
        canSubmit: true,
      }),
    );
    expect(html).toContain('ingress[0].cidr_blocks');
    expect(html).toContain('0.0.0.0/0');
    expect(html).toContain('10.0.0.0/16');
  });

  it('requester sees no revert submit: canSubmit false renders no justification field and no submit button', () => {
    const html = render(
      React.createElement(ProposalDrawer, {
        ...baseProps,
        verdict: SECURITY_VERDICT,
        proposal: REVERT_PROPOSAL,
        canSubmit: false,
      }),
    );
    expect(html).not.toContain('Submit revert request');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('Only an approver or a lead');
  });
});

describe('submitDriftProposalVia — submit navigates to the created request', () => {
  const CREATED: ChangeRequest = {
    id: 'req-drift-1',
    requester: 'dewi',
    service: 'drift',
    operationId: 'system-drift-adopt',
    macd: 'Change',
    targetAddress: BENIGN_VERDICT.address,
    params: {},
    justification: 'Adopting the observed tag value.',
    exposure: 'l1_with_guardrails',
    risk: 'LOW',
    status: 'AWAITING_CODE_REVIEW',
    createdAt: '2026-07-20T03:21:00.000Z',
    updatedAt: '2026-07-20T03:21:00.000Z',
    events: [],
  };

  it('adopt submit navigates to /requests/:id on success', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'submitDriftProposal'> = {
      submitDriftProposal: async () => ({ ok: true, request: CREATED }),
    };
    const result = await submitDriftProposalVia(client, (p) => navigated.push(p), ADOPT_PROPOSAL.digest, {
      justification: 'Adopting the observed tag value.',
      schedule: { kind: 'now' },
    });
    expect(result).toEqual({ ok: true, request: CREATED });
    expect(navigated).toEqual(['/requests/req-drift-1']);
  });

  it('a server-side rejection never navigates — the reason is left for the caller to show inline', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'submitDriftProposal'> = {
      submitDriftProposal: async () => ({ ok: false, code: 'FORBIDDEN', reason: 'This proposal is stale.' }),
    };
    const result = await submitDriftProposalVia(client, (p) => navigated.push(p), ADOPT_PROPOSAL.digest, {
      justification: 'x',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    expect(navigated).toEqual([]);
  });
});
