import { beforeEach, describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@/types';
import { createMockApiClient } from '@/lib/api';
import { manifests } from '@/data/manifests';
import { resetSettingsForTests, setChangeFreeze } from '@/lib/settings';
import {
  BEYOND_CATALOG_MAX_SUMMARY,
  BEYOND_CATALOG_OP_ID,
  MAX_OPEN_BEYOND_CATALOG_REQUESTS,
  buildBeyondCatalogDraft,
  catalogedRedirect,
  deriveTechnologyChooser,
  describeBeyondCatalogRequest,
  openBeyondCatalogCount,
  submitBeyondCatalogRequest,
  validateBeyondCatalogInput,
  type BeyondCatalogInput,
} from '@/lib/beyondCatalog';
import { isProvisionAdd } from '@/lib/actionPicker';
import { CATEGORY_ORDER } from '@/lib/serviceMeta';

/**
 * Task 1 + 0034 A11: the beyond-catalog tail is a first-class request kind, not
 * a fake manifest op — it flows through the SAME draft→review→approve pipeline
 * (via api.submitRequest, unchanged) at engineer_only/HIGH. v2 makes it an
 * ELABORATION: a technology chooser routes cataloged tech into real forms, and
 * the surviving tail is structured (workload / sizing / connectivity / data
 * classification / needed-by) with the summary cap raised 200 → 2000 (P4).
 */

function validInput(overrides: Partial<BeyondCatalogInput> = {}): BeyondCatalogInput {
  return {
    kind: 'new_resource_uncatalogued',
    service: 'redshift',
    resourceType: 'aws_redshift_cluster',
    workload: 'Month-end finance analytics for the reporting team.',
    connectivity: 'vpc-internal',
    dataClassification: 'confidential',
    summary: 'A Redshift cluster for the new finance analytics workload.',
    justification:
      'Finance needs a dedicated warehouse for month-end reporting; current RDS instances cannot scale to it.',
    ...overrides,
  };
}

beforeEach(() => {
  resetSettingsForTests();
});

describe('buildBeyondCatalogDraft — the frozen draft shape (v2 structured tail)', () => {
  it('produces every frozen field, including the optional resourceType and the structured tail params', () => {
    const input = validInput({
      sizingCapacity: 500,
      sizingUnit: 'GiB',
      instanceCount: 3,
      neededBy: '2027-01-15',
    });
    const draft = buildBeyondCatalogDraft(input, 'dewi');

    expect(draft.operationId).toBe(BEYOND_CATALOG_OP_ID);
    expect(draft.macd).toBe('Add');
    expect(draft.service).toBe('redshift');
    expect(draft.targetAddress).toBe('(new)');
    expect(draft.params).toEqual({
      kind: 'new_resource_uncatalogued',
      resourceType: 'aws_redshift_cluster',
      workload: input.workload,
      sizingCapacity: 500,
      sizingUnit: 'GiB',
      instanceCount: 3,
      connectivity: 'vpc-internal',
      dataClassification: 'confidential',
      neededBy: '2027-01-15',
      summary: input.summary,
    });
    expect(draft.exposure).toBe('engineer_only');
    expect(draft.risk).toBe('HIGH');
    expect(draft.status).toBe('DRAFT');
    expect(draft.requester).toBe('dewi');
    expect(draft.justification).toBe(input.justification);
    expect(draft.id).toBeTruthy();
    expect(draft.createdAt).toBeTruthy();
    expect(draft.updatedAt).toBeTruthy();
    expect(Array.isArray(draft.events)).toBe(true);
    expect(draft.events.length).toBeGreaterThan(0);
  });

  it('omits every optional field from params when not supplied', () => {
    const input = validInput({ resourceType: undefined, kind: 'enable_new_service' });
    const draft = buildBeyondCatalogDraft(input, 'dewi');
    expect(draft.params).toEqual({
      kind: 'enable_new_service',
      workload: input.workload,
      connectivity: 'vpc-internal',
      dataClassification: 'confidential',
      summary: input.summary,
    });
    for (const absent of [
      'resourceType',
      'sizingCapacity',
      'sizingUnit',
      'instanceCount',
      'neededBy',
    ]) {
      expect(absent in draft.params, absent).toBe(false);
    }
  });
});

describe('validateBeyondCatalogInput — deterministic bounds, no model', () => {
  it('case 1: a fully valid input has no errors', () => {
    expect(validateBeyondCatalogInput(validInput())).toEqual({});
  });

  it('case 2: a bad service slug is rejected', () => {
    const errors = validateBeyondCatalogInput(validInput({ service: 'Redshift Cluster!' }));
    expect(errors.service).toBeTruthy();
  });

  it('case 3: a too-short justification is rejected', () => {
    const errors = validateBeyondCatalogInput(validInput({ justification: 'not enough detail' }));
    expect(errors.justification).toBeTruthy();
  });

  it('case 4: a resourceType that is not aws_-shaped is rejected when present (default provider is aws)', () => {
    const errors = validateBeyondCatalogInput(validInput({ resourceType: 'redshift-cluster' }));
    expect(errors.resourceType).toBeTruthy();
  });

  it("0039 S1 lane C: resourceType is checked against the ACTIVE PROJECT's provider shape", () => {
    const azureInput = validInput({ resourceType: 'azurerm_storage_account' });
    // An azure project accepts its own azurerm_* shape…
    expect(validateBeyondCatalogInput(azureInput, undefined, 'azure').resourceType).toBeUndefined();
    // …but an aws project (the default, and every project prior to this seam) refuses it.
    expect(validateBeyondCatalogInput(azureInput).resourceType).toBeTruthy();
    expect(validateBeyondCatalogInput(azureInput, undefined, 'aws').resourceType).toBeTruthy();
    // Symmetrically, an aws_* type is refused for an azure project.
    const awsInput = validInput({ resourceType: 'aws_redshift_cluster' });
    expect(validateBeyondCatalogInput(awsInput, undefined, 'azure').resourceType).toBeTruthy();
  });

  it('workload is required, 10–500 chars', () => {
    expect(validateBeyondCatalogInput(validInput({ workload: 'too short' })).workload).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ workload: 'x'.repeat(501) })).workload,
    ).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ workload: 'ERP interface archive jobs.' })).workload,
    ).toBeUndefined();
  });

  it('the summary cap is 2000 (P4 closed — no more technology-in-a-tweet)', () => {
    expect(BEYOND_CATALOG_MAX_SUMMARY).toBe(2000);
    expect(
      validateBeyondCatalogInput(validInput({ summary: 'x'.repeat(2000) })).summary,
    ).toBeUndefined();
    expect(
      validateBeyondCatalogInput(validInput({ summary: 'x'.repeat(2001) })).summary,
    ).toBeTruthy();
    expect(validateBeyondCatalogInput(validInput({ summary: 'too short' })).summary).toBeTruthy();
  });

  it('sizing: a capacity number requires a unit; numbers are bounded; count is 1–100', () => {
    expect(
      validateBeyondCatalogInput(validInput({ sizingCapacity: 500, sizingUnit: 'GiB' })),
    ).toEqual({});
    expect(validateBeyondCatalogInput(validInput({ sizingCapacity: 500 })).sizingUnit).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ sizingCapacity: 0, sizingUnit: 'GiB' }))
        .sizingCapacity,
    ).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ sizingCapacity: Number.NaN, sizingUnit: 'GiB' }))
        .sizingCapacity,
    ).toBeTruthy();
    expect(validateBeyondCatalogInput(validInput({ instanceCount: 0 })).instanceCount).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ instanceCount: 101 })).instanceCount,
    ).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ instanceCount: 2.5 })).instanceCount,
    ).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ instanceCount: 3 })).instanceCount,
    ).toBeUndefined();
  });

  it('connectivity and data classification are required enums — classification has NO default', () => {
    const noConn = validateBeyondCatalogInput(validInput({ connectivity: 'wired' as never }));
    expect(noConn.connectivity).toBeTruthy();
    const noClass = validateBeyondCatalogInput(validInput({ dataClassification: '' as never }));
    expect(noClass.dataClassification).toBeTruthy();
  });

  it('needed-by must be a YYYY-MM-DD date, today or later (today injected for determinism)', () => {
    const today = '2026-07-15';
    expect(validateBeyondCatalogInput(validInput({ neededBy: '2026-07-15' }), today)).toEqual({});
    expect(
      validateBeyondCatalogInput(validInput({ neededBy: '2026-07-14' }), today).neededBy,
    ).toBeTruthy();
    expect(
      validateBeyondCatalogInput(validInput({ neededBy: 'next tuesday' }), today).neededBy,
    ).toBeTruthy();
    expect(validateBeyondCatalogInput(validInput({ neededBy: undefined }), today)).toEqual({});
  });
});

describe('submitBeyondCatalogRequest — the submit path (Task 1 STOP-note resolution)', () => {
  it('a valid submission flows through api.submitRequest unchanged, landing at NEEDS_ENGINEER', async () => {
    const client = createMockApiClient();
    const result = await submitBeyondCatalogRequest(validInput(), 'dewi', client);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.operationId).toBe(BEYOND_CATALOG_OP_ID);
      expect(result.request.status).toBe('NEEDS_ENGINEER');
    }
  });

  it('0039 S1 lane C: the provider param is forwarded to validation — an azure resourceType submits for an azure project, is refused for the aws default', async () => {
    const azureInput = validInput({ resourceType: 'azurerm_storage_account' });
    const refused = await submitBeyondCatalogRequest(azureInput, 'dewi', createMockApiClient());
    expect(refused.ok).toBe(false);
    const accepted = await submitBeyondCatalogRequest(
      azureInput,
      'dewi',
      createMockApiClient(),
      'azure',
    );
    expect(accepted.ok).toBe(true);
  });

  it('rejects with the validation reason before ever calling the API', async () => {
    const client = createMockApiClient();
    const result = await submitBeyondCatalogRequest(validInput({ service: '!!' }), 'dewi', client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBeTruthy();
    expect(openBeyondCatalogCount(await client.listRequests('dewi'))).toBe(0);
  });

  it('case (c): the 4th open beyond-catalog request for the same user is refused', async () => {
    const client = createMockApiClient();
    for (let i = 0; i < MAX_OPEN_BEYOND_CATALOG_REQUESTS; i++) {
      const res = await submitBeyondCatalogRequest(
        validInput({ service: `svc-${i}` }),
        'dewi',
        client,
      );
      expect(res.ok).toBe(true);
    }
    const fourth = await submitBeyondCatalogRequest(
      validInput({ service: 'svc-4' }),
      'dewi',
      client,
    );
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toMatch(/open beyond-catalog/i);

    // A different requester is unaffected by dewi's cap.
    const other = await submitBeyondCatalogRequest(
      validInput({ service: 'svc-5' }),
      'rizky',
      client,
    );
    expect(other.ok).toBe(true);
  });

  it('openBeyondCatalogCount counts only this operation id at NEEDS_ENGINEER', () => {
    const requests: ChangeRequest[] = [
      { ...buildBeyondCatalogDraft(validInput(), 'dewi'), status: 'NEEDS_ENGINEER' },
      { ...buildBeyondCatalogDraft(validInput(), 'dewi'), status: 'REJECTED' },
      {
        ...buildBeyondCatalogDraft(validInput(), 'dewi'),
        operationId: 'ebs-grow',
        status: 'NEEDS_ENGINEER',
      },
    ];
    expect(openBeyondCatalogCount(requests)).toBe(1);
  });

  it('case (d): submitting while frozen still returns the freeze rejection (reuses the settings enforcement helpers)', async () => {
    const client = createMockApiClient();
    setChangeFreeze(true);
    const result = await submitBeyondCatalogRequest(validInput(), 'dewi', client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/frozen/i);
    // Never reached the API — nothing was recorded.
    expect(openBeyondCatalogCount(await client.listRequests('dewi'))).toBe(0);

    setChangeFreeze(false);
    const after = await submitBeyondCatalogRequest(validInput(), 'dewi', client);
    expect(after.ok).toBe(true);
  });
});

describe('describeBeyondCatalogRequest — the spec sheet L2 reads (0033 §2.2)', () => {
  it('a v2 request yields every structured row, human-labeled', () => {
    const draft = buildBeyondCatalogDraft(
      validInput({
        sizingCapacity: 500,
        sizingUnit: 'GiB',
        instanceCount: 3,
        neededBy: '2027-01-15',
      }),
      'dewi',
    );
    const sheet = describeBeyondCatalogRequest(draft);
    expect(sheet).toBeTruthy();
    expect(sheet!.workload).toBe('Month-end finance analytics for the reporting team.');
    expect(sheet!.sizing).toBe('500 GiB of storage · 3 instances');
    expect(sheet!.connectivity).toBe('Inside the private network only');
    expect(sheet!.dataClassification).toBe('Confidential');
    expect(sheet!.neededBy).toBe('2027-01-15');
    expect(sheet!.summary).toContain('Redshift cluster');
  });

  it('a pre-v2 request (kind/resourceType/summary only) still renders exactly its own rows', () => {
    const legacy: ChangeRequest = {
      ...buildBeyondCatalogDraft(validInput(), 'dewi'),
      params: { kind: 'enable_new_service', summary: 'Enable Redshift for finance.' },
    };
    const sheet = describeBeyondCatalogRequest(legacy);
    expect(sheet).toBeTruthy();
    expect(sheet!.summary).toBe('Enable Redshift for finance.');
    expect(sheet!.workload).toBeUndefined();
    expect(sheet!.sizing).toBeUndefined();
    expect(sheet!.connectivity).toBeUndefined();
    expect(sheet!.dataClassification).toBeUndefined();
    expect(sheet!.neededBy).toBeUndefined();
  });

  it('returns null for any non-beyond-catalog request', () => {
    const other = { ...buildBeyondCatalogDraft(validInput(), 'dewi'), operationId: 'ebs-grow' };
    expect(describeBeyondCatalogRequest(other)).toBeNull();
  });
});

describe('deriveTechnologyChooser — STEP 1 is the catalog itself (0033 §2.1)', () => {
  const groups = deriveTechnologyChooser(manifests);

  it('lists provision create baselines and ONLY those (no tag-adds, no rule-adds)', () => {
    const all = groups.flatMap((g) => g.choices);
    expect(all.length).toBeGreaterThan(10);
    for (const { op } of all) {
      expect(op.group, op.id).toBe('create');
      expect(isProvisionAdd(op), op.id).toBe(true);
    }
    const ids = new Set(all.map((c) => c.op.id));
    // The headline baselines route into their real forms.
    expect(ids.has('ec2-provision-instance')).toBe(true);
    expect(ids.has('ebs-create-volume')).toBe(true);
    expect(ids.has('s3-create-bucket')).toBe(true);
    expect(ids.has('sg-create-security-group')).toBe(true);
    // Attach-and-annotate adds are NOT technologies.
    expect(ids.has('ec2-add-instance-tag')).toBe(false);
    expect(ids.has('sg-add-internal-ingress-rule')).toBe(false);
  });

  it('groups by serviceMeta category, in the catalog’s own category order', () => {
    const seen = groups.map((g) => g.category);
    const expectedOrder = CATEGORY_ORDER.filter((c) => seen.includes(c));
    expect(seen).toEqual(expectedOrder);
    const compute = groups.find((g) => g.category === 'Compute');
    expect(compute).toBeTruthy();
    expect(compute!.choices.some((c) => c.service === 'ec2')).toBe(true);
  });
});

describe('catalogedRedirect — typing a cataloged service shows the baseline one click away', () => {
  it('service: ec2 matches, with the EC2 provision baseline in its ops', () => {
    const redirect = catalogedRedirect('ec2', manifests);
    expect(redirect).toBeTruthy();
    expect(redirect!.displayName).toBe('EC2');
    expect(redirect!.ops.some((op) => op.id === 'ec2-provision-instance')).toBe(true);
  });

  it('trims and lower-cases before matching', () => {
    expect(catalogedRedirect('  EC2 ', manifests)).toBeTruthy();
  });

  it('an uncataloged service yields null (the tail is the honest path)', () => {
    // 'snowflake' is a genuinely new third-party technology the estate does not
    // catalog — the exact beyond-catalog case. (redshift/athena/etc. USED to be
    // uncataloged, but the console-parity wiring now names all 133 aws services,
    // so they resolve a real tile — a redirect, not the tail.)
    expect(catalogedRedirect('snowflake', manifests)).toBeNull();
    expect(catalogedRedirect('', manifests)).toBeNull();
  });
});
