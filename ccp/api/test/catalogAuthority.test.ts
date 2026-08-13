import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { projectKey, projectDataVersionKey } from '../src/store/schema';
import { digestsOf, writeProjectDataVersion, type UploadBundle } from '../src/domain/projectData';
import { getOperation } from '../src/manifests';
import { seed, sessionCookieFor, SAMPLE_PROJECT_ID } from './helpers/seed';

/**
 * ARCH-5 — two sources of truth for the catalog.
 *
 * Post data-birth, a real estate's manifests are uploaded by its CI, staged,
 * dual-control-activated and served from the data plane (`GET /projects/:id/manifests`),
 * and the SPA builds its forms from that active version (`httpApi.ts` — "every other
 * account … reads ccp-api's data plane … the ACTIVE uploaded version"). But submit-time
 * validation resolved every operation from the **image-bundled** catalog
 * (`manifests.ts` `DEFAULT_DIR` → `app/src/data/manifests`, vendored into the api image),
 * with no per-project resolution and nothing comparing the two.
 *
 * So the form and the server could disagree, silently, in both directions: an op offered
 * and then refused, bounds displayed that are not the ones enforced, an approval count
 * shown that is not the one required.
 *
 * ## The authority decision this suite encodes
 *
 * **The image-bundled catalog is authoritative for every submit-time decision. The
 * per-project uploaded manifest set is a presentation artifact.** The reasoning is in
 * `ccp/docs/DOMAIN-MODEL.md` (§ "Catalog authority") and `docs/audit/FIXES.md` § ARCH-5;
 * the short version is that an uploaded manifest's governance fields have never been
 * validated by anything. `domain/projectData.ts`'s `UploadManifest` checks operations as
 * `{ id: string }` `.passthrough()` — `exposure`, `forcesReplace` and `riskFloor` ride
 * through unread — while the bundled catalog's same fields are gate-enforced in CI
 * (`npm run verify:safety`'s ForceNew gate is what makes `forcesReplace:false` a true
 * statement rather than a claim). Those fields are authorization inputs:
 * `domain/requirement.ts` derives the approval ladder from `op.exposure`, and
 * `routes/requests.ts` demands the typed replace-confirmation from `op.forcesReplace`.
 *
 * Resolving submits from the uploaded set — the finding's first recommendation — would
 * therefore move the approval ladder onto unvalidated tenant-supplied data. The
 * `ebs-set-encrypted` case below is that escalation, written out: bundled it is
 * `engineer_only` + `forcesReplace`, i.e. two approvals and a typed confirmation naming
 * the resource. An uploaded copy claiming `l1_self_service` + `forcesReplace: false`
 * would make it one approval and no confirmation.
 *
 * Authority alone does not close the finding, though — it decides which side wins, not
 * whether the user is told. The disagreement is now **refused, per item, naming the
 * operation** (`CATALOG_SKEW`), instead of being resolved silently in the bundled
 * catalog's favour against a form built from the other one.
 */

const COMMIT = 'a'.repeat(40);
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A minimal well-formed bundle carrying `manifests`, with self-consistent digests. */
async function bundleWith(manifests: unknown[]): Promise<UploadBundle> {
  const inventory = {
    generatedAt: '2026-07-17T00:00:00.000Z',
    sourceCommit: COMMIT,
    source: 'scan',
    resources: [
      {
        address: 'aws_ebs_volume.dwh01',
        resourceType: 'aws_ebs_volume',
        name: 'dwh01',
        service: 'ebs',
        attributes: { size: '100' },
      },
    ],
  };
  const blocks = {
    index: { 'aws_ebs_volume.dwh01': 'main' },
    chunks: {
      main: {
        'aws_ebs_volume.dwh01': {
          file: 'main.tf',
          line: 1,
          source: 'resource "aws_ebs_volume" "dwh01" {\n  size = 100\n}',
        },
      },
    },
  };
  const bundle = { inventory, blocks, manifests } as unknown as UploadBundle;
  return { ...bundle, digests: await digestsOf(bundle) } as UploadBundle;
}

/**
 * Put the sample project into the state a real onboarded estate is in: one activated data
 * version whose served manifests are `manifests`.
 *
 * The version row and its key are built from the REAL key function and the REAL
 * `writeProjectDataVersion` writer, never hand-typed — a hand-typed key makes the serve
 * path find nothing and every assertion below pass for the wrong reason (runbook: "build
 * keys from the real key functions").
 */
async function activateManifests(
  store: ConfigStore,
  dataRoot: string,
  manifests: unknown[],
): Promise<void> {
  const id = SAMPLE_PROJECT_ID;
  const version = 1;
  const bundle = await bundleWith(manifests);
  await writeProjectDataVersion(dataRoot, id, version, bundle);
  const vKey = projectDataVersionKey(id, version);
  await store.put({
    ...vKey,
    projectId: id,
    version,
    uploadedAt: '2026-07-17T00:00:00.000Z',
    uploadedVia: 'upload-token:t1',
    digests: bundle.digests,
    uploadDigests: bundle.digests,
    counts: { resources: 1, blockAddresses: 1, blockChunks: 1, manifests: manifests.length },
    chunks: ['main'],
    warnings: [],
    sourceCommit: COMMIT,
  } as never);
  const pk = projectKey(id);
  const row = (await store.get(pk.PK, pk.SK)) as Record<string, unknown>;
  await store.put({
    ...row,
    dataActive: { version, activatedBy: 'putra', activatedAt: '2026-07-17T00:00:00.000Z' },
  } as never);
}

type Ctx = { store: ConfigStore; app: Hono<AppEnv>; sari: string; dataRoot: string };

async function ctx(manifests: unknown[]): Promise<Ctx> {
  const store = new MemoryStore();
  await seed(store);
  const dataRoot = mkdtempSync(join(tmpdir(), 'ccp-arch5-'));
  roots.push(dataRoot);
  const app = createApp(store, { projectDataRoot: dataRoot });
  // Settlement runs on the first authenticated call; do it before planting dataActive so
  // the project row this reads is the settled one.
  const sari = await sessionCookieFor(store, 'sari');
  await app.request('/requests?scope=mine', {
    headers: { 'x-ccp-client': 'ccp-spa', cookie: sari, 'x-ccp-project': SAMPLE_PROJECT_ID },
  });
  await activateManifests(store, dataRoot, manifests);
  return { store, app, sari, dataRoot };
}

async function submit(c: Ctx, body: unknown): Promise<Response> {
  return c.app.request('/requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ccp-client': 'ccp-spa',
      cookie: c.sari,
      'x-ccp-project': SAMPLE_PROJECT_ID,
    },
    body: JSON.stringify(body),
  });
}

/** The served manifest set the SPA renders from. */
async function served(c: Ctx): Promise<Response> {
  return c.app.request(`/projects/${SAMPLE_PROJECT_ID}/manifests`, {
    headers: { 'x-ccp-client': 'ccp-spa', cookie: c.sari, 'x-ccp-project': SAMPLE_PROJECT_ID },
  });
}

/* A served `ebs-grow` whose bound is WIDER than the bundled catalog's (16384). */
const WIDENED_EBS = [
  {
    service: 'ebs',
    scope: 'estate',
    resourceTypes: ['aws_ebs_volume'],
    summary: 'EBS operations.',
    operations: [
      {
        id: 'ebs-grow',
        service: 'ebs',
        macd: 'Change',
        codemodOp: 'set_attribute',
        title: 'Grow a volume',
        description: '',
        target: { attr: 'size', resourceType: 'aws_ebs_volume' },
        exposure: 'l1_with_guardrails',
        riskFloor: 'MEDIUM',
        reversible: false,
        downtime: 'none',
        forcesReplace: false,
        autoEligible: false,
        terraformCapability: '~ update',
        group: 'scale-performance',
        params: [
          { name: 'volume', label: 'Volume', type: 'string', source: 'inventory', required: true },
          {
            name: 'new_size_gib',
            label: 'New size',
            type: 'number',
            source: 'user_input',
            required: true,
            // The bundled catalog caps this at 16384.
            bounds: { min: 1, max: 65536, growOnly: true },
          },
        ],
      },
    ],
  },
];

describe('ARCH-5 — the served catalog and the enforced catalog cannot silently disagree', () => {
  it('the fixture actually serves the divergent catalog (sanity)', async () => {
    // Without this, every refusal below could be a 404/500 on the serve path and the
    // suite would be proving nothing about catalog skew at all (L-1).
    const c = await ctx(WIDENED_EBS);
    const res = await served(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ operations: Array<{ id: string; params: Array<{ name: string; bounds?: { max?: number } }> }> }>;
    const op = body[0]!.operations.find((o) => o.id === 'ebs-grow')!;
    const bound = op.params.find((p) => p.name === 'new_size_gib')!.bounds!.max;
    expect(bound).toBe(65536);

    // And the two catalogs must genuinely differ on that field, or the test is comparing
    // a thing to itself.
    const bundled = getOperation('ebs-grow')!;
    const bundledMax = (bundled.params.find((p) => p.name === 'new_size_gib')!.bounds as { max: number }).max;
    expect(bundledMax).toBe(16384);
    expect(bundledMax).not.toBe(bound);
  });

  it('THE DEFECT: a value the served form offers is refused by the enforced catalog', async () => {
    // 30000 is inside the served bound (65536) and outside the bundled one (16384). The
    // SPA built a form that offers it; the server validates against the other catalog.
    // Pre-fix this was PARAM_OUT_OF_BOUNDS — a refusal that blames the requester for a
    // value their own form said was fine, with nothing anywhere naming the real cause.
    const c = await ctx(WIDENED_EBS);
    const res = await submit(c, {
      operationId: 'ebs-grow',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 30000 },
      justification: 'grow the volume for month-end load',
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe('CATALOG_SKEW');
  });

  it('the refusal names the operation and the diverging field, not just "invalid"', async () => {
    const c = await ctx(WIDENED_EBS);
    const res = await submit(c, {
      operationId: 'ebs-grow',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 30000 },
      justification: 'grow the volume for month-end load',
      schedule: { kind: 'now' },
    });
    const body = (await res.json()) as { code: string; details?: { operationId?: string; fields?: string[] } };
    expect(body.details?.operationId).toBe('ebs-grow');
    expect(body.details?.fields).toContain('params.new_size_gib.bounds');
  });

  it('a submit INSIDE both catalogs is still refused — skew is about the catalogs, not the value', async () => {
    // The point of failing closed here: with the two catalogs disagreeing, a value that
    // happens to satisfy both today tells us nothing about whether the FORM the requester
    // filled in matched the rules being enforced. A per-value check would let the skew
    // keep shipping until someone hit the edge of it.
    const c = await ctx(WIDENED_EBS);
    const res = await submit(c, {
      operationId: 'ebs-grow',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
      justification: 'grow the volume for month-end load',
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CATALOG_SKEW');
  });

  it('an estate whose served catalog AGREES submits exactly as before', async () => {
    // The regression that matters most: this check must be invisible to every estate whose
    // CI uploads the catalog its control plane actually ships.
    const bundled = getOperation('ebs-grow')!;
    const agreeing = [
      {
        service: 'ebs',
        scope: 'estate',
        resourceTypes: ['aws_ebs_volume'],
        summary: 'EBS operations.',
        operations: [bundled],
      },
    ];
    const c = await ctx(agreeing);
    const res = await submit(c, {
      operationId: 'ebs-grow',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
      justification: 'grow the volume for month-end load',
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(201);
  });

  it('an op the served catalog does not carry at all still submits — served is a SUBSET view', async () => {
    // An estate may legitimately serve fewer ops than the image ships (a narrower rollout).
    // Absence is not disagreement: there is no competing definition to disagree with, and
    // the requester's form could not have offered it in the first place.
    const c = await ctx(WIDENED_EBS); // carries ebs-grow only
    const res = await submit(c, {
      operationId: 'ebs-add-tag',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', key: 'owner', value: 'dwh' },
      justification: 'tag the volume with its owner',
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(201);
  });

  it('a project with NO active data is unaffected — the bundled catalog is simply authoritative', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const res = await app.request('/requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ccp-client': 'ccp-spa',
        cookie: sari,
        'x-ccp-project': SAMPLE_PROJECT_ID,
      },
      body: JSON.stringify({
        operationId: 'ebs-grow',
        targetAddress: 'aws_ebs_volume.dwh01',
        params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
        justification: 'grow the volume for month-end load',
        schedule: { kind: 'now' },
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe('ARCH-5 — the escalation the authority decision refuses', () => {
  /**
   * `ebs-set-encrypted` is `engineer_only` + `forcesReplace: true` in the bundled catalog:
   * two approvals and a typed confirmation naming the resource. This served copy claims
   * self-service and no replace. If the served catalog were authoritative — the finding's
   * own first recommendation — this upload would have bought one approval and no
   * confirmation for a destroy-and-recreate of an encrypted volume.
   */
  const DOWNGRADED = [
    {
      service: 'ebs',
      scope: 'estate',
      resourceTypes: ['aws_ebs_volume'],
      summary: 'EBS operations.',
      operations: [
        {
          ...getOperation('ebs-set-encrypted')!,
          exposure: 'l1_self_service',
          riskFloor: 'LOW',
          forcesReplace: false,
        },
      ],
    },
  ];

  it('a served catalog that downgrades an op is refused, not obeyed', async () => {
    const c = await ctx(DOWNGRADED);
    const res = await submit(c, {
      operationId: 'ebs-set-encrypted',
      targetAddress: 'aws_ebs_volume.dwh01',
      params: { volume: 'aws_ebs_volume.dwh01', encrypted: 'true' },
      justification: 'encrypt the volume at rest',
      schedule: { kind: 'now' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: { fields?: string[] } };
    expect(body.code).toBe('CATALOG_SKEW');
    // Both governance fields are named — these are the ladder and the confirmation.
    expect(body.details?.fields).toContain('exposure');
    expect(body.details?.fields).toContain('forcesReplace');
  });
});
