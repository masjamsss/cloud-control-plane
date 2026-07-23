import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import type { DriftFinding, DriftProposal, DriftVerdict } from '@/types/drift';
import type { ApiClient } from '@/lib/api';
import { partitionForResolution, ResolutionFlow } from '@/features/drift/ResolutionFlow';
import { LegitimizeDrawer, LEGITIMIZE_JUSTIFICATION_TEMPLATE } from '@/features/drift/LegitimizeDrawer';
import { ProposalDrawer } from '@/features/drift/ProposalDrawer';
import { ImportDrawer } from '@/features/drift/ImportDrawer';
import { RestoreDrawer, DRIFT_RESTORE_DATA_LOSS_NOTE, DRIFT_RESTORE_EVIDENCE_DUTY } from '@/features/drift/RestoreDrawer';
import { legitimizeDriftSecurityVia, submitDriftProposalVia } from '@/features/drift/proposalFlow';

/**
 * "Fix the drift"'s batch resolution flow (spec addendum A7 / plan B2) and
 * C2's legitimize drawer (spec addendum A6). Rendered as SSR strings (no
 * jsdom in this repo — the DriftPanel/DriftPage/driftProposalUi precedent);
 * navigation is proved separately at the pure legitimizeDriftSecurityVia
 * function, since renderToStaticMarkup strips event handlers.
 *
 * Pins THE BINDING INVARIANT one layer up from driftProposalUi.test.tsx: a
 * security verdict paired with a forged adopt-flavored proposal for its
 * address can never land in the partition's `adopt` bucket, so the
 * resolution flow structurally never renders an adopt affordance for it.
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
    { path: 'tags.Owner', live: '"bi-team"', code: '"platform"', sensitive: false, liveJson: 'bi-team', codeJson: 'platform' },
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
    { path: 'ingress[0].cidr_blocks', live: '["0.0.0.0/0"]', code: '["10.0.0.0/16"]', sensitive: false, liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] },
  ],
  forceNewAttrs: [],
  securityHits: [{ path: 'ingress[0].cidr_blocks', why: 'network reachability changed out-of-band' }],
};

const UNGENERABLE_VERDICT: DriftVerdict = {
  address: 'aws_subnet.legacy_net',
  type: 'aws_subnet',
  actions: ['create', 'delete'],
  class: 'replacement_forcenew',
  riskTier: 'critical',
  driftEvidence: true,
  changedAttrs: [],
  forceNewAttrs: [{ path: 'cidr_block', verdict: 'force_new' }],
  securityHits: [],
};

const NOT_ARMED_VERDICT: DriftVerdict = {
  address: 'aws_instance.app09',
  type: 'aws_instance',
  actions: ['update'],
  class: 'benign_inplace',
  riskTier: 'low',
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
  diff: '--- a/environments/prod/main.tf\n+++ b/environments/prod/main.tf\n',
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
  attrs: [{ address: SECURITY_VERDICT.address, path: 'ingress[0].cidr_blocks', liveJson: ['0.0.0.0/0'], codeJson: ['10.0.0.0/16'] }],
};

/** A forged adopt proposal claiming to cover the security verdict's
 * address — simulates a tampered/buggy generation output. */
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

/** A forged restore proposal claiming to cover the security verdict's
 * address — the restore-flavor mirror of {@link FORGED_ADOPT_FOR_SECURITY},
 * pinning THE BINDING INVARIANT for the newest bucket too. */
const FORGED_RESTORE_FOR_SECURITY: DriftProposal = {
  ...RESTORE_PROPOSAL,
  digest: 'd7'.repeat(32),
  addresses: [SECURITY_VERDICT.address],
};

/* ── out-of-band provisioning spec: import-eligible findings ────────────── */

const IMPORT_FINDING: DriftFinding = {
  class: 'unmanaged_resource',
  tfType: 'aws_instance',
  name: 'bastion-9',
  service: 'ec2',
  stateful: false,
  securityFamily: false,
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0test0000000001a',
  liveId: 'i-0test0000000001a',
  importPayload: {
    address: 'aws_instance.oob_bastion_9',
    targetFile: 'oob-adopted.tf',
    importBlock: 'import {\n  to = aws_instance.oob_bastion_9\n  id = "i-0test0000000001a"\n}\n',
    skeletonHcl: 'resource "aws_instance" "oob_bastion_9" {\n}\n',
  },
  payloadWithheldReason: null,
};

const IMPORT_PROPOSAL: DriftProposal = {
  digest: 'e5'.repeat(32),
  flavor: 'import',
  status: 'open',
  addresses: [IMPORT_FINDING.importPayload!.address],
  attrCount: 0,
  generatedAt: '2026-07-20T03:21:47Z',
  lastSeenReportVersion: 1,
  diff: null,
  attrs: [],
  arn: IMPORT_FINDING.arn,
  tfType: IMPORT_FINDING.tfType,
  importPayload: IMPORT_FINDING.importPayload,
};

describe('partitionForResolution', () => {
  it('proposals undefined (Requester tier) yields every bucket empty', () => {
    expect(partitionForResolution([BENIGN_VERDICT, SECURITY_VERDICT], undefined)).toEqual({
      adopt: [],
      security: [],
      restore: [],
      ungenerable: [],
      notArmed: [],
    });
  });

  it('sorts a benign+adopt row into adopt, a security+revert row into security', () => {
    const p = partitionForResolution([BENIGN_VERDICT, SECURITY_VERDICT], [ADOPT_PROPOSAL, REVERT_PROPOSAL]);
    expect(p.adopt).toEqual([{ verdict: BENIGN_VERDICT, proposal: ADOPT_PROPOSAL }]);
    expect(p.security).toEqual([{ verdict: SECURITY_VERDICT, proposal: REVERT_PROPOSAL }]);
    expect(p.ungenerable).toEqual([]);
    expect(p.notArmed).toEqual([]);
  });

  it('an ungenerable verdict carries its reason, never a proposal', () => {
    const p = partitionForResolution([UNGENERABLE_VERDICT], []);
    expect(p.ungenerable).toHaveLength(1);
    expect(p.ungenerable[0]!.verdict).toBe(UNGENERABLE_VERDICT);
    expect(p.ungenerable[0]!.reason).toContain('not auto-generable');
  });

  it('an eligible-looking verdict with no matching proposal lands in notArmed', () => {
    const p = partitionForResolution([NOT_ARMED_VERDICT], []);
    expect(p.notArmed).toEqual([NOT_ARMED_VERDICT]);
  });

  it('THE BINDING INVARIANT: a security verdict with a forged adopt-flavored proposal never lands in adopt', () => {
    const p = partitionForResolution([SECURITY_VERDICT], [FORGED_ADOPT_FOR_SECURITY]);
    expect(p.adopt).toEqual([]);
    // No real revert proposal was supplied either, so it honestly falls to
    // notArmed — never a guessed/forged adopt bucket.
    expect(p.notArmed).toEqual([SECURITY_VERDICT]);
    expect(p.security).toEqual([]);
  });

  it('drift restore tranche (L29): sorts a restore-eligible out-of-band-deletion row into restore', () => {
    const p = partitionForResolution([RESTORE_VERDICT], [RESTORE_PROPOSAL]);
    expect(p.restore).toEqual([{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }]);
    expect(p.adopt).toEqual([]);
    expect(p.security).toEqual([]);
    expect(p.notArmed).toEqual([]);
  });

  it('THE BINDING INVARIANT, restore flavor: a security verdict with a forged restore-flavored proposal never lands in restore', () => {
    const p = partitionForResolution([SECURITY_VERDICT], [FORGED_RESTORE_FOR_SECURITY]);
    expect(p.restore).toEqual([]);
    // No real revert proposal was supplied either, so it honestly falls to
    // notArmed — never a guessed/forged restore bucket.
    expect(p.notArmed).toEqual([SECURITY_VERDICT]);
    expect(p.security).toEqual([]);
  });

  it('restore is a CORE bucket (unlike importEligible): always present on the 2-arg call, never gated behind an extra argument', () => {
    const p = partitionForResolution([BENIGN_VERDICT], [ADOPT_PROPOSAL]);
    expect(Object.keys(p).sort()).toEqual(['adopt', 'notArmed', 'restore', 'security', 'ungenerable']);
    expect(p.restore).toEqual([]);
    // importEligible stays the ADDITIVE exception — omitted entirely unless
    // `findings` is passed, byte-identical to every pre-existing call site.
    expect(p.importEligible).toBeUndefined();
  });

  it('an import-eligible finding sorts into importEligible when findings is passed', () => {
    const p = partitionForResolution([], [IMPORT_PROPOSAL], [IMPORT_FINDING]);
    expect(p.importEligible).toEqual([{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }]);
  });

  it('THE BINDING INVARIANT, one level down: a security-family finding with a forged import-flavored proposal for its own arn never lands in importEligible', () => {
    const securityFinding: DriftFinding = {
      class: 'unmanaged_resource',
      tfType: 'aws_iam_role',
      securityFamily: true,
      arn: 'arn:aws:iam::123456789012:role/oob-admin-role',
      importPayload: null,
      payloadWithheldReason: null,
    };
    const forged: DriftProposal = { ...IMPORT_PROPOSAL, digest: 'f6'.repeat(32), arn: securityFinding.arn };
    const p = partitionForResolution([], [forged], [securityFinding]);
    expect(p.importEligible).toEqual([]);
  });
});

const baseFlowProps = {
  selectedAdopt: new Set<string>(),
  allAdoptSelected: false,
  onToggleAdopt: () => {},
  onToggleSelectAllAdopt: () => {},
  batchJustification: '',
  onBatchJustificationChange: () => {},
  batchSchedule: { kind: 'now' as const },
  onBatchScheduleChange: () => {},
  onSubmitBatch: () => {},
  batchSubmitting: false,
  onChooseRevert: () => {},
  onChooseLegitimize: () => {},
  canRevertOrLegitimize: true,
  // Drift restore tranche (L29) — the Restore section's own batch state
  // (a CORE, always-required prop set, unlike the Import section's
  // optional one below); every call site overrides only what a given test
  // actually exercises.
  selectedRestore: new Set<string>(),
  allRestoreSelected: false,
  onToggleRestore: () => {},
  onToggleSelectAllRestore: () => {},
  restoreBatchJustification: '',
  onRestoreBatchJustificationChange: () => {},
  restoreBatchSchedule: { kind: 'now' as const },
  onRestoreBatchScheduleChange: () => {},
  onSubmitRestoreBatch: () => {},
  restoreBatchSubmitting: false,
  canRestore: true,
  // out-of-band provisioning spec — the Import section's own batch state;
  // every call site below overrides only what a given test actually
  // exercises.
  selectedImport: new Set<string>(),
  allImportSelected: false,
  onToggleImport: () => {},
  onToggleSelectAllImport: () => {},
  importBatchJustification: '',
  onImportBatchJustificationChange: () => {},
  importBatchSchedule: { kind: 'now' as const },
  onImportBatchScheduleChange: () => {},
  onSubmitImportBatch: () => {},
  importBatchSubmitting: false,
  canImport: true,
};

describe('ResolutionFlow — the batch resolution view', () => {
  it('nothing to resolve renders an honest empty state', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [], restore: [], ungenerable: [], notArmed: [] },
      }),
    );
    expect(html).toContain('Nothing to resolve');
  });

  it('renders an adopt checkbox per eligible row, with no batch form until something is selected', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [{ verdict: BENIGN_VERDICT, proposal: ADOPT_PROPOSAL }], security: [], restore: [], ungenerable: [], notArmed: [] },
      }),
    );
    expect(html).toContain('aws_instance.app01');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('Submit 1 adopt fix');
  });

  it('a selected adopt row shows the batch submit form, labelled with the selection count', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [{ verdict: BENIGN_VERDICT, proposal: ADOPT_PROPOSAL }], security: [], restore: [], ungenerable: [], notArmed: [] },
        selectedAdopt: new Set([ADOPT_PROPOSAL.digest]),
      }),
    );
    expect(html).toContain('Submit 1 adopt fix');
  });

  it('a security row renders the C1/C2 choice and NEVER the word "Adopt" anywhere in the DOM', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [{ verdict: SECURITY_VERDICT, proposal: REVERT_PROPOSAL }], restore: [], ungenerable: [], notArmed: [] },
      }),
    );
    expect(html).toContain('Revert (C1)');
    expect(html).toContain('Legitimize (C2)');
    expect(html).not.toContain('Adopt');
    expect(html).not.toContain('type="checkbox"');
  });

  it('a security row disables both choices and explains why when the viewer cannot revert/legitimize', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [{ verdict: SECURITY_VERDICT, proposal: REVERT_PROPOSAL }], restore: [], ungenerable: [], notArmed: [] },
        canRevertOrLegitimize: false,
      }),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('Only an approver or a lead can revert or legitimize');
  });

  it('an ungenerable row renders its enriched reason (the manual path)', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [], restore: [], ungenerable: [{ verdict: UNGENERABLE_VERDICT, reason: 'class "replacement_forcenew" is not auto-generable in v1 — see the limitations register' }], notArmed: [] },
      }),
    );
    expect(html).toContain('aws_subnet.legacy_net');
    expect(html).toContain('is not auto-generable in v1');
  });

  it('a not-armed row renders the honest "not generated yet" explanation', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [], restore: [], ungenerable: [], notArmed: [NOT_ARMED_VERDICT] },
      }),
    );
    expect(html).toContain('Not generated yet');
  });
});

describe('ResolutionFlow — the "Import" section (out-of-band provisioning spec, plugging into the SAME batch view Lane D built for Adopt)', () => {
  it('importEligible omitted entirely (partition.importEligible undefined): no Import section rendered at all — byte-identical to the pre-existing verdict-only view', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [], restore: [], ungenerable: [], notArmed: [] },
      }),
    );
    expect(html).not.toContain('Import — unmanaged resources');
    expect(html).toContain('Nothing to resolve');
  });

  it('renders an import checkbox per eligible row, with no batch form until something is selected', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [],
          ungenerable: [],
          notArmed: [],
          importEligible: [{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }],
        },
        canImport: true,
      }),
    );
    expect(html).toContain('aws_instance.oob_bastion_9');
    expect(html).toContain('bastion-9');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('Submit 1 import');
  });

  it('a selected import row shows the batch submit form, labelled with the selection count', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [],
          ungenerable: [],
          notArmed: [],
          importEligible: [{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }],
        },
        selectedImport: new Set([IMPORT_PROPOSAL.digest]),
        canImport: true,
      }),
    );
    expect(html).toContain('Submit 1 import');
  });

  it('without canImport, every control in the Import section is disabled and the no-role note renders', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [],
          ungenerable: [],
          notArmed: [],
          importEligible: [{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }],
        },
        canImport: false,
      }),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('Only an approver or a lead can import');
  });

  it('the Import section help text names what a selection writes (never a create/update/destroy elsewhere)', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [],
          ungenerable: [],
          notArmed: [],
          importEligible: [{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }],
        },
        canImport: true,
      }),
    );
    expect(html).toContain('resolution__section-help');
    expect(html).toContain('declarative import block');
  });
});

describe('ResolutionFlow — the "Restore" section (drift restore tranche, L29, mirroring the Import batch section)', () => {
  it('partition.restore empty: no Restore section rendered at all', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: { adopt: [], security: [], restore: [], ungenerable: [], notArmed: [] },
      }),
    );
    expect(html).not.toContain('Restore — out-of-band deletions');
    expect(html).toContain('Nothing to resolve');
  });

  it('renders a restore checkbox per eligible row, with no batch form until something is selected', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
          ungenerable: [],
          notArmed: [],
        },
        canRestore: true,
      }),
    );
    expect(html).toContain('aws_flow_log.prod_vpc');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('Submit 1 restore');
  });

  it('a selected restore row shows the batch submit form, labelled with the selection count', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
          ungenerable: [],
          notArmed: [],
        },
        selectedRestore: new Set([RESTORE_PROPOSAL.digest]),
        canRestore: true,
      }),
    );
    expect(html).toContain('Submit 1 restore');
  });

  it('without canRestore, every control in the Restore section is disabled and the no-role note renders', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
          ungenerable: [],
          notArmed: [],
        },
        canRestore: false,
      }),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('Only an approver or a lead can restore an out-of-band deletion');
  });

  it('the Restore section help text names the data-loss honesty duty (never a create/update/destroy elsewhere)', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [],
          security: [],
          restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
          ungenerable: [],
          notArmed: [],
        },
        canRestore: true,
      }),
    );
    expect(html).toContain('resolution__section-help');
    expect(html).toContain('never recovers data');
  });

  it('the restore batch is never mixable with the adopt batch — a restore-eligible row never renders an adopt checkbox and vice versa', () => {
    const html = render(
      React.createElement(ResolutionFlow, {
        ...baseFlowProps,
        partition: {
          adopt: [{ verdict: BENIGN_VERDICT, proposal: ADOPT_PROPOSAL }],
          security: [],
          restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
          ungenerable: [],
          notArmed: [],
        },
        selectedAdopt: new Set([ADOPT_PROPOSAL.digest]),
        selectedRestore: new Set([RESTORE_PROPOSAL.digest]),
        canRestore: true,
      }),
    );
    expect(html).toContain('Submit 1 adopt fix');
    expect(html).toContain('Submit 1 restore');
    expect(html).toContain('aws_instance.app01');
    expect(html).toContain('aws_flow_log.prod_vpc');
  });
});

describe('RestoreDrawer — the restore proposal detail/submit drawer (drift restore tranche, L29)', () => {
  const baseDrawerProps = {
    verdict: RESTORE_VERDICT,
    proposal: RESTORE_PROPOSAL,
    onJustificationChange: () => {},
    schedule: { kind: 'now' as const },
    onScheduleChange: () => {},
    onSubmit: () => {},
    onClose: () => {},
    submitting: false,
  };

  it('renders both MANDATORY honesty blocks verbatim — the data-loss note and the D4 evidence duty', () => {
    const html = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: '', canSubmit: true }),
    );
    expect(html).toContain(DRIFT_RESTORE_DATA_LOSS_NOTE);
    expect(html).toContain(DRIFT_RESTORE_EVIDENCE_DUTY);
  });

  it('the data-loss note says data is NOT recovered, and names the state-recovery runbook as the separate human path', () => {
    expect(DRIFT_RESTORE_DATA_LOSS_NOTE).toContain('is not recovered by this action');
    expect(DRIFT_RESTORE_DATA_LOSS_NOTE).toContain('state-recovery runbook');
  });

  it('the evidence duty names the CloudTrail Delete* event and the approving lead’s sign-off', () => {
    expect(DRIFT_RESTORE_EVIDENCE_DUTY).toContain('CloudTrail');
    expect(DRIFT_RESTORE_EVIDENCE_DUTY).toContain('Delete*');
    expect(DRIFT_RESTORE_EVIDENCE_DUTY).toContain('approving lead');
  });

  it('renders no diff and no live/code attribute table — a restore carries no edit, only a re-create', () => {
    const html = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: '', canSubmit: true }),
    );
    expect(html).not.toContain('Diff preview');
    expect(html).not.toContain('drift-drawer__diff');
  });

  it('renders the standing blast-radius note (shared verbatim with ProposalDrawer/ImportDrawer)', () => {
    const html = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: '', canSubmit: true }),
    );
    expect(html).toContain(
      'This estate applies one Terraform root. While any other drift is outstanding, applying this change also reverts every other drifted resource',
    );
  });

  it('a too-short justification renders a disabled submit button; a long one does not', () => {
    const shortHtml = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: 'too short', canSubmit: true }),
    );
    expect(shortHtml).toContain('disabled=""');

    const longJustification =
      'Deleted out-of-band per CloudTrail Delete event captured 2026-07-21; restoring per runbook D4.';
    const longHtml = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: longJustification, canSubmit: true }),
    );
    expect(longHtml).not.toContain('disabled=""');
  });

  it('requester tier (canSubmit false) sees no textarea and no submit button, and the no-role note names approver/lead', () => {
    const html = render(
      React.createElement(RestoreDrawer, { ...baseDrawerProps, justification: '', canSubmit: false }),
    );
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Submit restore request');
    expect(html).toContain('Only an approver or a lead can submit a drift restore');
  });

  it('no §-notation or bare proposal/register reference leaks into either honesty block (the app copy-lint gate)', () => {
    const sectionSign = /§/;
    const proposalRef = /\b00\d{2}[a-z]?\b|\bADR-\d+/i;
    for (const text of [DRIFT_RESTORE_DATA_LOSS_NOTE, DRIFT_RESTORE_EVIDENCE_DUTY]) {
      expect(text).not.toMatch(sectionSign);
      expect(text).not.toMatch(proposalRef);
    }
  });
});

describe('submitDriftProposalVia — restore submit navigates to the created request (mirrors adopt/import)', () => {
  const CREATED: ChangeRequest = {
    id: 'req-restore-1',
    requester: 'carol',
    service: 'drift',
    operationId: 'system-drift-restore',
    macd: 'Add',
    targetAddress: RESTORE_VERDICT.address,
    params: {},
    justification: 'CloudTrail Delete event captured; restoring the flow log.',
    exposure: 'l1_with_guardrails',
    risk: 'HIGH',
    status: 'AWAITING_CODE_REVIEW',
    createdAt: '2026-07-21T09:00:00.000Z',
    updatedAt: '2026-07-21T09:00:00.000Z',
    events: [],
  };

  it('navigates to /requests/:id on success', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'submitDriftProposal'> = {
      submitDriftProposal: async () => ({ ok: true, request: CREATED }),
    };
    const result = await submitDriftProposalVia(client, (p) => navigated.push(p), RESTORE_PROPOSAL.digest, {
      justification: 'CloudTrail Delete event captured; restoring the flow log.',
      schedule: { kind: 'now' },
    });
    expect(result).toEqual({ ok: true, request: CREATED });
    expect(navigated).toEqual(['/requests/req-restore-1']);
  });

  it('a server-side rejection never navigates', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'submitDriftProposal'> = {
      submitDriftProposal: async () => ({ ok: false, code: 'FORBIDDEN', reason: 'Only an approver or a lead can submit a drift restore.' }),
    };
    const result = await submitDriftProposalVia(client, (p) => navigated.push(p), RESTORE_PROPOSAL.digest, {
      justification: 'x',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    expect(navigated).toEqual([]);
  });
});

describe('LegitimizeDrawer — C2', () => {
  const baseDrawerProps = {
    verdict: SECURITY_VERDICT,
    proposal: REVERT_PROPOSAL,
    onJustificationChange: () => {},
    schedule: { kind: 'now' as const },
    onScheduleChange: () => {},
    onSubmit: () => {},
    onClose: () => {},
    submitting: false,
  };

  it('offers the emergency-justification template and pins the evidence table to the live value', () => {
    const html = render(
      React.createElement(LegitimizeDrawer, { ...baseDrawerProps, justification: '', canSubmit: true }),
    );
    expect(html).toContain(LEGITIMIZE_JUSTIFICATION_TEMPLATE);
    expect(html).toContain('Use this template');
    expect(html).toContain('ingress[0].cidr_blocks');
    expect(html).toContain('0.0.0.0/0');
    // The revert value (what would be re-imposed) is deliberately absent —
    // legitimize converges to the LIVE value, never shows a "code" column.
    expect(html).not.toContain('10.0.0.0/16');
  });

  it('a too-short justification renders a disabled submit button; a long one does not', () => {
    const shortHtml = render(
      React.createElement(LegitimizeDrawer, { ...baseDrawerProps, justification: 'too short', canSubmit: true }),
    );
    expect(shortHtml).toContain('disabled=""');

    const longJustification =
      'Emergency change: widened an SG rule to unblock an incident. CloudTrail event attached below.';
    const longHtml = render(
      React.createElement(LegitimizeDrawer, { ...baseDrawerProps, justification: longJustification, canSubmit: true }),
    );
    expect(longHtml).not.toContain('disabled=""');
  });

  it('requester tier (canSubmit false) sees no textarea and no submit button', () => {
    const html = render(
      React.createElement(LegitimizeDrawer, { ...baseDrawerProps, justification: '', canSubmit: false }),
    );
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Start legitimize request');
    expect(html).toContain('Only an approver or a lead');
  });

  it('never renders an edit/diff — legitimize is engineer-authored, not a portal apply', () => {
    const html = render(
      React.createElement(LegitimizeDrawer, { ...baseDrawerProps, justification: '', canSubmit: true }),
    );
    expect(html).not.toContain('Diff preview');
  });
});

describe('legitimizeDriftSecurityVia — submit navigates to the created (NEEDS_ENGINEER) request', () => {
  const CREATED: ChangeRequest = {
    id: 'req-legit-1',
    requester: 'carol',
    service: 'drift',
    operationId: 'system-drift-legitimize',
    macd: 'Change',
    targetAddress: SECURITY_VERDICT.address,
    params: {},
    justification: 'Emergency change, CloudTrail evidence attached.',
    exposure: 'engineer_only',
    risk: 'HIGH',
    status: 'NEEDS_ENGINEER',
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:00:00.000Z',
    events: [],
  };

  it('navigates to /requests/:id on success', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'legitimizeDriftSecurity'> = {
      legitimizeDriftSecurity: async () => ({ ok: true, request: CREATED }),
    };
    const result = await legitimizeDriftSecurityVia(client, (p) => navigated.push(p), REVERT_PROPOSAL.digest, {
      justification: 'Emergency change, CloudTrail evidence attached.',
      schedule: { kind: 'now' },
    });
    expect(result).toEqual({ ok: true, request: CREATED });
    expect(navigated).toEqual(['/requests/req-legit-1']);
  });

  it('a server-side rejection never navigates', async () => {
    const navigated: string[] = [];
    const client: Pick<ApiClient, 'legitimizeDriftSecurity'> = {
      legitimizeDriftSecurity: async () => ({ ok: false, code: 'FORBIDDEN', reason: 'Not eligible.' }),
    };
    const result = await legitimizeDriftSecurityVia(client, (p) => navigated.push(p), REVERT_PROPOSAL.digest, {
      justification: 'x',
      schedule: { kind: 'now' },
    });
    expect(result.ok).toBe(false);
    expect(navigated).toEqual([]);
  });
});

describe('SchedulePicker name collision — every drift surface that can co-mount uses a distinct radio-group name', () => {
  // ProposalDrawer (the per-row chip's drawer), ResolutionFlow's adopt,
  // restore (L29), AND import batch forms, LegitimizeDrawer, ImportDrawer,
  // and RestoreDrawer (out-of-band provisioning spec + drift restore
  // tranche) are NOT mutually exclusive: DriftPage can render any
  // combination at once — e.g. the resolution flow open with adopt, restore,
  // AND import rows all selected (three of its own SchedulePickers) while a
  // security row's Legitimize choice is also open (LegitimizeDrawer's), or
  // a table-row chip opens ProposalDrawer/RestoreDrawer while the
  // resolution flow is still showing behind it, or the unmanaged section's
  // chip opens ImportDrawer alongside any of the above. HTML radio-button
  // grouping is by the `name` string across the WHOLE document, not by
  // component instance, so two co-mounted SchedulePickers sharing one name
  // would fight over which option is actually checked at the native DOM
  // level. This pins that every drift call site was given its own name
  // (SchedulePicker.tsx's `name` prop, default `'sched'`, added for exactly
  // this reason).
  it('extracts every radio name= attribute from every drift surface rendered together and finds them pairwise distinct', () => {
    const html =
      render(
        React.createElement(ProposalDrawer, {
          verdict: SECURITY_VERDICT,
          proposal: REVERT_PROPOSAL,
          justification: '',
          onJustificationChange: () => {},
          schedule: { kind: 'now' },
          onScheduleChange: () => {},
          onSubmit: () => {},
          onClose: () => {},
          submitting: false,
          canSubmit: true,
        }),
      ) +
      render(
        React.createElement(ResolutionFlow, {
          ...baseFlowProps,
          partition: {
            adopt: [{ verdict: BENIGN_VERDICT, proposal: ADOPT_PROPOSAL }],
            security: [],
            restore: [{ verdict: RESTORE_VERDICT, proposal: RESTORE_PROPOSAL }],
            ungenerable: [],
            notArmed: [],
            importEligible: [{ finding: IMPORT_FINDING, proposal: IMPORT_PROPOSAL }],
          },
          selectedAdopt: new Set([ADOPT_PROPOSAL.digest]),
          selectedRestore: new Set([RESTORE_PROPOSAL.digest]),
          canRestore: true,
          selectedImport: new Set([IMPORT_PROPOSAL.digest]),
          canImport: true,
        }),
      ) +
      render(
        React.createElement(LegitimizeDrawer, {
          verdict: SECURITY_VERDICT,
          proposal: REVERT_PROPOSAL,
          justification: '',
          onJustificationChange: () => {},
          schedule: { kind: 'now' },
          onScheduleChange: () => {},
          onSubmit: () => {},
          onClose: () => {},
          submitting: false,
          canSubmit: true,
        }),
      ) +
      render(
        React.createElement(ImportDrawer, {
          finding: IMPORT_FINDING,
          proposal: IMPORT_PROPOSAL,
          justification: '',
          onJustificationChange: () => {},
          schedule: { kind: 'now' },
          onScheduleChange: () => {},
          onSubmit: () => {},
          onClose: () => {},
          submitting: false,
          canSubmit: true,
        }),
      ) +
      render(
        React.createElement(RestoreDrawer, {
          verdict: RESTORE_VERDICT,
          proposal: RESTORE_PROPOSAL,
          justification: '',
          onJustificationChange: () => {},
          schedule: { kind: 'now' },
          onScheduleChange: () => {},
          onSubmit: () => {},
          onClose: () => {},
          submitting: false,
          canSubmit: true,
        }),
      );

    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(14); // 2 radios per SchedulePicker x 7 surfaces
    const distinct = new Set(names);
    expect(distinct.size, `saw names: ${names.join(', ')}`).toBe(7);
  });
});
