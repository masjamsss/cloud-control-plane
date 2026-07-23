import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DriftFinding, DriftProposal, DriftReport } from '@/types/drift';
import { findingProposalStateFor } from '@/features/drift/driftProposalState';
import {
  UnmanagedFindingChip,
  UnmanagedFindingRow,
  UnmanagedResourcesSection,
  UnmanagedFooter,
  runbookD5Url,
} from '@/features/drift/UnmanagedResources';
import { ImportDrawer } from '@/features/drift/ImportDrawer';
import { DRIFT_BLAST_RADIUS_NOTE } from '@/features/drift/ProposalDrawer';

/**
 * The out-of-band provisioning spec's SPA surface: the unmanaged-resources
 * section, its per-row chip/state derivation, and the import drawer.
 * Rendered as SSR strings (no jsdom in this repo — the DriftPanel/
 * driftProposalUi precedent).
 *
 * The central proof this file exists for: A SECURITY-FAMILY FINDING NEVER
 * RENDERS AN IMPORT AFFORDANCE IN THE DOM — not a button, not the word
 * "Import proposal ready", not the generated import code — even under an
 * adversarially forged proposal row that claims `flavor: 'import'` for its
 * own arn. See "ADVERSARIAL" below.
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

const IMPORT_FINDING: DriftFinding = {
  class: 'unmanaged_resource',
  tfType: 'aws_instance',
  name: 'bastion-9',
  service: 'ec2',
  stateful: false,
  securityFamily: false,
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0test0000000001a',
  liveId: 'i-0test0000000001a',
  region: 'us-east-1',
  actor: {
    eventName: 'RunInstances',
    eventTime: '2026-07-19T22:00:00Z',
    who: 'arn:aws:sts::123456789012:assumed-role/break-glass/on-call-engineer',
    sourceIp: '203.0.113.1',
  },
  importPayload: {
    address: 'aws_instance.oob_bastion_9',
    targetFile: 'oob-adopted.tf',
    importBlock: 'import {\n  to = aws_instance.oob_bastion_9\n  id = "i-0test0000000001a"\n}\n',
    skeletonHcl: 'resource "aws_instance" "oob_bastion_9" {\n  instance_type = "t3.micro"\n}\n',
  },
  payloadWithheldReason: null,
};

const SECURITY_FINDING: DriftFinding = {
  class: 'unmanaged_resource',
  tfType: 'aws_iam_role',
  name: 'oob-admin-role',
  service: 'iam',
  stateful: false,
  securityFamily: true,
  arn: 'arn:aws:iam::123456789012:role/oob-admin-role',
  liveId: 'oob-admin-role',
  actor: null,
  importPayload: null,
  payloadWithheldReason: null,
};

const WITHHELD_FINDING: DriftFinding = {
  class: 'unmanaged_resource',
  tfType: 'aws_db_instance',
  name: 'oob-reporting-db',
  service: 'rds',
  stateful: true,
  securityFamily: false,
  liveId: 'db-oob-01',
  actor: null,
  importPayload: null,
  payloadWithheldReason:
    'generated config carries secret-shaped values — import via the kit runbook with secret handling (e.g. ignore_changes on the secret attribute), never through the portal',
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

/** A FORGED import proposal claiming to cover the SECURITY finding's own
 * arn — simulates a tampered/buggy generation output. The UI must never
 * trust this label into rendering an import affordance. */
const FORGED_IMPORT_FOR_SECURITY: DriftProposal = {
  ...IMPORT_PROPOSAL,
  digest: 'f6'.repeat(32),
  addresses: ['aws_iam_role.oob_admin_role'],
  arn: SECURITY_FINDING.arn,
  tfType: SECURITY_FINDING.tfType,
};

function baseReportWithSweep(findings: DriftFinding[]): DriftReport {
  return {
    version: 1,
    capturedAt: '2026-07-20T03:17:04Z',
    runId: '1',
    commit: 'abc',
    cadenceHours: 6,
    planExitCode: 2,
    counts: { drifted: 0, security: 0, byClass: {}, unmanaged: findings.length },
    verdicts: [],
    absorbed: [],
    invisibleToPlan: 'Out-of-band creations are invisible to plan-based detection.',
    sweep: {
      method: 'importer-kit discover',
      capturedAt: '2026-07-20T03:15:41Z',
      region: 'us-east-1',
      findings,
      totalFindings: findings.length,
      ignoredCount: 4,
      coverage: { unrecognizedArnFamilies: { 'arn:aws:sns': 3, 'arn:aws:sqs': 1 } },
    },
  };
}

function baseReportNoSweep(): DriftReport {
  return {
    version: 1,
    capturedAt: '2026-07-20T03:17:04Z',
    runId: '1',
    commit: 'abc',
    cadenceHours: 6,
    planExitCode: 0,
    counts: { drifted: 0, security: 0, byClass: {} },
    verdicts: [],
    absorbed: [],
    invisibleToPlan: 'Out-of-band creations are invisible to plan-based detection.',
  };
}

describe('findingProposalStateFor — the states, re-derived locally, never trusting a matched proposal label', () => {
  it('proposals undefined (Requester tier): null — no state at all', () => {
    expect(findingProposalStateFor(IMPORT_FINDING, undefined)).toBeNull();
  });

  it('an import-eligible finding with a matching open import proposal: import', () => {
    expect(findingProposalStateFor(IMPORT_FINDING, [IMPORT_PROPOSAL])).toEqual({
      kind: 'import',
      proposal: IMPORT_PROPOSAL,
    });
  });

  it('THE BINDING INVARIANT: a security-family finding paired with a forged import-flavored proposal for its own arn still never reads as import', () => {
    const state = findingProposalStateFor(SECURITY_FINDING, [FORGED_IMPORT_FOR_SECURITY]);
    expect(state?.kind).not.toBe('import');
    expect(state?.kind).toBe('creation_security');
  });

  it('a payload-withheld finding: payload_withheld, with the mechanical reason verbatim', () => {
    const state = findingProposalStateFor(WITHHELD_FINDING, []);
    expect(state).toEqual({ kind: 'payload_withheld', reason: WITHHELD_FINDING.payloadWithheldReason });
  });

  it('an import-eligible finding with no matching proposal at all: not-armed (the honest default explanation)', () => {
    expect(findingProposalStateFor(IMPORT_FINDING, [])).toEqual({ kind: 'not-armed' });
  });
});

describe('UnmanagedFindingChip — standalone render for each state; ONLY import is clickable', () => {
  it('state null renders nothing at all', () => {
    expect(render(React.createElement(UnmanagedFindingChip, { state: null }))).toBe('');
  });

  it('renders each state label', () => {
    expect(
      render(React.createElement(UnmanagedFindingChip, { state: { kind: 'import', proposal: IMPORT_PROPOSAL } })),
    ).toContain('Import proposal ready');
    expect(
      render(React.createElement(UnmanagedFindingChip, { state: { kind: 'creation_security', reason: 'x' } })),
    ).toContain('Security family — investigate first');
    expect(
      render(React.createElement(UnmanagedFindingChip, { state: { kind: 'type_unmapped', reason: 'type reason' } })),
    ).toContain('No mechanical import — type reason');
    expect(render(React.createElement(UnmanagedFindingChip, { state: { kind: 'not-armed' } }))).toContain(
      'generation not armed',
    );
  });

  it('ADVERSARIAL: the import chip is the ONLY state rendering a <button> — every other state is a plain, non-interactive badge', () => {
    const importHtml = render(
      React.createElement(UnmanagedFindingChip, { state: { kind: 'import', proposal: IMPORT_PROPOSAL } }),
    );
    expect(importHtml).toContain('<button');

    const nonImportStates = [
      { kind: 'creation_security' as const, reason: 'x' },
      { kind: 'type_unmapped' as const, reason: 'x' },
      { kind: 'payload_withheld' as const, reason: 'x' },
      { kind: 'ungenerable' as const, reason: 'x' },
      { kind: 'not-armed' as const },
    ];
    for (const state of nonImportStates) {
      const html = render(React.createElement(UnmanagedFindingChip, { state }));
      expect(html, state.kind).not.toContain('<button');
      expect(html, state.kind).not.toContain('Import proposal ready');
    }
  });
});

describe('UnmanagedFindingRow / UnmanagedResourcesSection — ADVERSARIAL: a security-family finding renders NO import affordance anywhere in the DOM', () => {
  it('a security-family row, even paired with a forged import proposal claiming its own arn, renders no button, no "Import proposal ready", and no generated import code', () => {
    const html = render(
      React.createElement(UnmanagedFindingRow, {
        finding: SECURITY_FINDING,
        proposals: [FORGED_IMPORT_FOR_SECURITY],
      }),
    );
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Import proposal ready');
    expect(html).not.toContain('import {'); // the generated import block's own opening line
    expect(html).not.toContain(FORGED_IMPORT_FOR_SECURITY.importPayload?.skeletonHcl ?? '\0impossible');
    expect(html).toContain('Security family — investigate first');
    // The standing footer is still present — every row's detail carries it.
    expect(html).toContain('delete in AWS');
  });

  it('the same holds inside the full section, rendered alongside a GENUINE import-eligible row: exactly one clickable import button in the whole section, never a second one for the security row', () => {
    const report = baseReportWithSweep([SECURITY_FINDING, IMPORT_FINDING]);
    const html = render(
      React.createElement(UnmanagedResourcesSection, {
        report,
        proposals: [FORGED_IMPORT_FOR_SECURITY, IMPORT_PROPOSAL],
      }),
    );
    expect(html).toContain('Import proposal ready');
    expect(html).toContain('Security family — investigate first');
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(1);
  });

  it('requester tier (proposals absent): the security row renders no chip, no button, no reason text — presence only (type/name/service)', () => {
    const html = render(React.createElement(UnmanagedFindingRow, { finding: SECURITY_FINDING }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Security family');
    expect(html).not.toContain('<details');
    expect(html).toContain('aws_iam_role');
    expect(html).toContain('oob-admin-role');
  });
});

describe('UnmanagedResourcesSection — the three honest states', () => {
  it('no sweep at all: "not swept", never a clean-sounding claim, never a chip or finding list', () => {
    const html = render(
      React.createElement(UnmanagedResourcesSection, { report: baseReportNoSweep(), proposals: [] }),
    );
    expect(html).toContain('not swept');
    expect(html).not.toContain('no unmanaged resources');
    expect(html).not.toContain('unmanaged-row');
  });

  it('swept, zero findings: the genuine dated clean state', () => {
    const html = render(
      React.createElement(UnmanagedResourcesSection, { report: baseReportWithSweep([]), proposals: [] }),
    );
    expect(html).toContain('No unmanaged resources found as of');
    expect(html).not.toContain('not swept');
  });

  it('swept, with findings: renders every row plus the coverage note naming unrecognizedArnFamilies', () => {
    const html = render(
      React.createElement(UnmanagedResourcesSection, {
        report: baseReportWithSweep([IMPORT_FINDING, SECURITY_FINDING, WITHHELD_FINDING]),
        proposals: [IMPORT_PROPOSAL],
      }),
    );
    expect(html).toContain('bastion-9');
    expect(html).toContain('oob-admin-role');
    expect(html).toContain('oob-reporting-db');
    expect(html).toContain('arn:aws:sns');
    expect(html).toContain('arn:aws:sqs');
  });

  it('the payload-withheld row shows the exact mechanical reason, never a guessed/generic one, and no import affordance', () => {
    const html = render(
      React.createElement(UnmanagedResourcesSection, {
        report: baseReportWithSweep([WITHHELD_FINDING]),
        proposals: [],
      }),
    );
    expect(html).toContain('generated config carries secret-shaped values');
    expect(html).not.toContain('<button');
  });
});

describe('UnmanagedFooter / runbookD5Url — the standing delete-in-AWS pointer is a link, never a button', () => {
  it('renders as an <a> element, not a <button>', () => {
    const html = render(React.createElement(UnmanagedFooter, {}));
    expect(html).toContain('<a href=');
    expect(html).not.toContain('<button');
    expect(html).toContain('delete in AWS');
    expect(html).toContain('owner sign-off');
  });

  it('the link points at the runbook D5 section on GitHub, built from project config (never a hardcoded owner/repo)', () => {
    const url = runbookD5Url();
    expect(url).toContain('github.com');
    expect(url).toContain('docs/runbooks/drift-detection.md');
    expect(url).toContain('d5');
  });
});

describe('ImportDrawer — the pinned code, evidence, blast-radius note, and submit role gate', () => {
  const noop = (): void => {};
  const baseProps = {
    finding: IMPORT_FINDING,
    proposal: IMPORT_PROPOSAL,
    justification: '',
    onJustificationChange: noop,
    schedule: { kind: 'now' as const },
    onScheduleChange: noop,
    onSubmit: noop,
    onClose: noop,
    submitting: false,
  };

  it('renders the exact pinned import block and skeleton HCL as code — the bytes that would land on main', () => {
    const html = render(React.createElement(ImportDrawer, { ...baseProps, canSubmit: true }));
    expect(html).toContain('import {');
    expect(html).toContain('aws_instance.oob_bastion_9');
    expect(html).toContain('resource &quot;aws_instance&quot; &quot;oob_bastion_9&quot;');
  });

  it('renders the standing blast-radius note (shared verbatim with ProposalDrawer) and the delete-in-AWS footer link', () => {
    const html = render(React.createElement(ImportDrawer, { ...baseProps, canSubmit: true }));
    expect(html).toContain(DRIFT_BLAST_RADIUS_NOTE);
    expect(html).toContain('delete in AWS');
    expect(html).toContain('<a href=');
  });

  it('renders CloudTrail evidence when present, and the "lookup duty still open" note when actor is null', () => {
    const withActor = render(React.createElement(ImportDrawer, { ...baseProps, canSubmit: true }));
    expect(withActor).toContain('RunInstances');

    const noActorFinding: DriftFinding = { ...IMPORT_FINDING, actor: null };
    const noActor = render(
      React.createElement(ImportDrawer, { ...baseProps, finding: noActorFinding, canSubmit: true }),
    );
    expect(noActor).toContain('lookup duty is still open');
    expect(noActor).not.toContain('RunInstances');
  });

  it('requester (canSubmit false) sees no textarea and no submit button', () => {
    const html = render(React.createElement(ImportDrawer, { ...baseProps, canSubmit: false }));
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Submit import request');
    expect(html).toContain('Only an approver or a lead');
  });

  it('a too-short justification renders a disabled submit button; a long one does not', () => {
    const shortHtml = render(
      React.createElement(ImportDrawer, { ...baseProps, canSubmit: true, justification: 'short' }),
    );
    expect(shortHtml).toContain('disabled=""');

    const longHtml = render(
      React.createElement(ImportDrawer, {
        ...baseProps,
        canSubmit: true,
        justification: 'This bastion host is legitimate infrastructure that should be tracked in Terraform.',
      }),
    );
    expect(longHtml).not.toContain('disabled=""');
  });

  it('help text accompanies the justification field (every new control carries help)', () => {
    const html = render(React.createElement(ImportDrawer, { ...baseProps, canSubmit: true }));
    expect(html).toContain('drift-drawer__help');
    expect(html).toContain('aria-describedby="drift-import-justification-help"');
  });
});
