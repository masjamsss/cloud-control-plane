import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifests } from '@/data/manifests';
import { renderHclSkeleton } from '@/lib/hclSkeleton';
import type { ManifestOperation } from '@/types';
import { AZURE_CREATE_VALUES } from './fixtures/skeletons/azure/values';

/**
 * 0039 S1 review-fix (I3) — the azure PROVISIONING (create_resource) goldens.
 * The AWS twin (baselineSkeletons.test.ts) proves the shipped manifests drive
 * the renderer to the normative AWS shapes; this proves the same for the 35
 * azure create forms (23 resource provisions + the 8 engineer-gated
 * azure-governance creates and the 4 azure-connectivity creates lane-lz-caf
 * added), and is exactly the coverage that would have caught the two
 * apply-breakers this fix wave closed:
 *
 *   C1 — azure-web-function-app-provision's required `site_config {}` never
 *        rendered (its only member hoisted to a top-level TODO).
 *   C2 — azure-containers-instance-provision's required `container.image`
 *        never rendered (engineer-decides sentinel hoisted out of the block).
 *
 * (1) GOLDENS — the headline creates byte-pin their rendered DRAFT
 *     (fixtures/skeletons/azure/<op-id>.golden.tf; regenerate consciously).
 * (2) EVERY required schema attribute + nested block renders — driven off the
 *     committed provider schema (tools/schemadump/azurerm-v4.81.0-schema.json),
 *     so a dropped required attr/block fails here for ALL 35, not just the 11.
 * (3) FROZEN posture — engineer_only / HIGH / create, summary <= 140, help on
 *     every param (the review's non-negotiables).
 * (4) NO hardcoded region — every derived `location` is an expression off the
 *     picked resource group / service plan, never a baked-in `"eastus"`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, 'fixtures', 'skeletons', 'azure');
const SCHEMA = JSON.parse(
  readFileSync(
    join(HERE, '..', '..', '..', '..', 'tools', 'schemadump', 'azurerm-v4.81.0-schema.json'),
    'utf8',
  ),
) as { resources: Record<string, { attributes: Record<string, SchemaAttr> }> };

interface SchemaAttr {
  required?: boolean;
  attributes?: Record<string, SchemaAttr>;
  block?: { attributes?: Record<string, SchemaAttr> };
}

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.golden.tf`), 'utf8').replace(/\n$/, '');
}

const allOps = manifests.flatMap((m) => m.operations);
function op(id: string): ManifestOperation {
  const found = allOps.find((o) => o.id === id);
  expect(found, `op ${id} missing from catalog`).toBeDefined();
  return found!;
}

/** The 35 azure PROVISIONING ops, the real shipped population (23 resource
 * provisions + the 8 engineer-gated azure-governance creates + the 4
 * engineer-gated azure-connectivity creates). */
const CREATE_OPS = allOps.filter(
  (o) => o.codemodOp === 'create_resource' && o.target.resourceType.startsWith('azurerm_'),
);
const CREATE_IDS = CREATE_OPS.map((o) => o.id);

/** The 8 azure-governance ENGINEER-GATED bounded creates (lane-lz-caf). Each
 * converts a former free-text "ask an engineer" placeholder into a
 * create_resource form whose privilege / blast-radius fields render bounded (an
 * allowlisted value or a reference expression) or as an engineer-decides review
 * TODO — never a raw guess. */
const GOVERNANCE_IDS = [
  'azure-governance-add-role-assignment',
  'azure-governance-author-role-definition',
  'azure-governance-author-policy-definition',
  'azure-governance-assign-subscription-policy',
  'azure-governance-assign-management-group-policy',
  'azure-governance-request-management-group',
  'azure-governance-apply-management-lock',
  'azure-governance-configure-diagnostic-setting',
] as const;

/** The headline creates that additionally byte-pin their full rendered draft. */
const HEADLINE = [
  'azure-compute-linux-vm-provision',
  'azure-storage-account-provision',
  'azure-keyvault-vault-provision',
  'azure-database-sql-server-provision',
  'azure-web-function-app-provision',
  'azure-containers-instance-provision',
  'azure-containers-aks-provision',
  // Connectivity CAF reachability creates — the four engineer-gated bounded
  // forms that replaced the free-text azure-connectivity catch-alls. Each byte-
  // pins its draft: a firewall + a gateway prove the required ip_configuration
  // block renders; all three RG-scoped types prove the engineer-decides location
  // TODO (their types are not in the renderer's RG_SCOPED_LOCATION_TYPES set).
  'azure-connectivity-firewall-policy-provision',
  'azure-connectivity-firewall-provision',
  'azure-connectivity-gateway-provision',
  'azure-connectivity-private-dns-link-provision',
];

function render(id: string): string {
  const values = AZURE_CREATE_VALUES[id];
  expect(values, `no fixture values for ${id}`).toBeDefined();
  return renderHclSkeleton(op(id), values!, { requestId: 'REQ-AZ' });
}

/* ── schema helpers ──────────────────────────────────────────────────────── */
const nestedAttrs = (a: SchemaAttr | undefined): Record<string, SchemaAttr> | undefined =>
  a?.attributes ?? a?.block?.attributes;
function requiredTop(rt: string): string[] {
  const r = SCHEMA.resources[rt];
  return r
    ? Object.entries(r.attributes)
        .filter(([, v]) => v.required)
        .map(([k]) => k)
    : [];
}
function requiredMembers(rt: string, block: string): string[] {
  const sub = nestedAttrs(SCHEMA.resources[rt]?.attributes[block]);
  return sub
    ? Object.entries(sub)
        .filter(([, v]) => v.required)
        .map(([k]) => k)
    : [];
}
const isSchemaBlock = (rt: string, attr: string): boolean =>
  nestedAttrs(SCHEMA.resources[rt]?.attributes[attr]) !== undefined;

/** An attribute is satisfied by an assignment, a rendered block header, or an
 * engineer-decides TODO line naming it (the deliberate not-captured-here case). */
function present(text: string, attr: string): boolean {
  return text
    .split('\n')
    .some(
      (l) =>
        new RegExp(`^\\s*${attr}\\s*=`).test(l) ||
        new RegExp(`^\\s*${attr}\\s*\\{`).test(l) ||
        new RegExp(`# TODO: ${attr}\\b`).test(l),
    );
}

describe('azure create goldens — the headline provisions byte-pin their draft', () => {
  it.each(HEADLINE)('%s renders its pinned DRAFT skeleton', (id) => {
    expect(render(id)).toBe(golden(id));
  });
});

describe('azure create — every required schema attribute + nested block renders (all 35)', () => {
  it.each(CREATE_IDS)('%s renders every required attribute and required block', (id) => {
    const text = render(id);
    const rt = op(id).target.resourceType;
    expect(text, `${id} rendered a stringified object`).not.toContain('[object Object]');
    for (const attr of requiredTop(rt)) {
      expect(present(text, attr), `${id}: required attr ${attr} missing`).toBe(true);
      if (isSchemaBlock(rt, attr)) {
        expect(
          new RegExp(`^\\s*${attr}\\s*\\{`, 'm').test(text),
          `${id}: required block ${attr} does not render as a block`,
        ).toBe(true);
        for (const member of requiredMembers(rt, attr)) {
          expect(
            present(text, member),
            `${id}: block ${attr} missing required member ${member}`,
          ).toBe(true);
        }
      }
    }
  });

  it('C1 — the function app renders its required site_config block with concrete members', () => {
    const text = render('azure-web-function-app-provision');
    expect(text).toMatch(/^\s*site_config\s*\{/m);
    expect(text).toContain('minimum_tls_version = "1.2"');
    expect(text).toContain('ftps_state = "Disabled"');
  });

  it('C2 — the container instance renders image INSIDE the container block', () => {
    const text = render('azure-containers-instance-provision');
    const block = text.slice(text.indexOf('container {'));
    expect(block).toContain('image = ');
    // image sits inside the container block, before that block closes.
    expect(block.indexOf('image = ')).toBeLessThan(block.indexOf('\n  }'));
  });
});

describe('azure create — frozen review posture', () => {
  it.each(CREATE_IDS)('%s stays engineer_only / HIGH / create with complete prose', (id) => {
    const o = op(id);
    expect(o.exposure, `${id} exposure`).toBe('engineer_only');
    expect(o.riskFloor, `${id} riskFloor`).toBe('HIGH');
    expect(o.group, `${id} group`).toBe('create');
    expect((o.summary ?? '').length, `${id} summary <= 140`).toBeLessThanOrEqual(140);
    expect((o.decisions?.length ?? 0) > 0, `${id} has decisions[]`).toBe(true);
    for (const p of o.params) {
      expect(typeof p.help === 'string' && p.help.length > 0, `${id}/${p.name} has help`).toBe(
        true,
      );
    }
  });
});

describe('azure create — I4a: location is derived, never a hardcoded region', () => {
  it.each(CREATE_IDS)('%s bakes in no region literal (no eastus in defaults/allowlists)', (id) => {
    for (const p of op(id).params) {
      expect(p.default, `${id}/${p.name} default`).not.toBe('eastus');
      expect(p.bounds?.allowlist ?? [], `${id}/${p.name} allowlist`).not.toContain('eastus');
    }
  });

  it('every rendered top-level location is a derived expression (or the RG root TODO)', () => {
    for (const id of CREATE_IDS) {
      const text = render(id);
      for (const line of text.split('\n')) {
        const m = /^\s{2}location\s*=\s*(.+)$/.exec(line);
        if (m) expect(m[1], `${id} location RHS`).toMatch(/\.location$/);
      }
    }
    // The resource group itself has no parent: its region stays engineer-decides.
    expect(render('azure-core-resource-group-create')).toContain(
      '# TODO: location — engineer decides',
    );
  });
});

/**
 * lane-lz-caf — the 8 azure-governance ENGINEER-GATED create forms. These
 * convert the old free-text "ask an engineer" placeholders into bounded
 * create_resource forms; each byte-pins its drafted skeleton and proves the
 * safety-shaping the conversion exists for. Correctness + safety-bounding is the
 * whole point here (these are IAM / policy / lock / audit resources): every
 * privilege or blast-radius field renders as an allowlisted value, a reference
 * expression, or an engineer-decides review TODO — never a raw request byte.
 */
describe('azure governance creates — the 8 engineer-gated bounded forms byte-pin their draft', () => {
  it.each(GOVERNANCE_IDS)('%s renders its pinned DRAFT skeleton', (id) => {
    expect(render(id)).toBe(golden(id));
  });

  it.each(GOVERNANCE_IDS)('%s leads with the DRAFT banner and stringifies no object', (id) => {
    const text = render(id);
    expect(text.startsWith('# DRAFT — generated from request REQ-AZ')).toBe(true);
    expect(text).not.toContain('[object Object]');
  });

  it.each(GOVERNANCE_IDS)(
    '%s is a top-level engineer-gated create (create_resource / Add / engineer_only, no target.block)',
    (id) => {
      const o = op(id);
      expect(o.codemodOp, id).toBe('create_resource');
      expect(o.macd, id).toBe('Add');
      expect(o.exposure, id).toBe('engineer_only');
      // A create must NOT carry target.block — that would make it a resource-scoped
      // Add (isResourceScopedAdd) that leaks onto a resource menu (actionPicker).
      expect(o.target.block, `${id}: a service-level provision must not be resource-pinned`).toBe(
        undefined,
      );
    },
  );

  it('role assignment: role bounded to least-privilege built-ins (no Owner/Contributor/UAA), scope+principal rendered', () => {
    const role = op('azure-governance-add-role-assignment').params.find(
      (p) => p.name === 'role_definition_name',
    )!;
    const allow = role.bounds?.allowlist ?? [];
    expect(allow).toContain('Reader');
    for (const forbidden of ['Owner', 'Contributor', 'User Access Administrator']) {
      expect(allow, `${forbidden} must never be offered on a self-service grant`).not.toContain(
        forbidden,
      );
    }
    const text = render('azure-governance-add-role-assignment');
    expect(text).toContain('scope = azurerm_resource_group.app.id');
    expect(text).toMatch(/principal_id = "[0-9a-f-]{36}"/); // GUID rendered, not masked
  });

  it('role definition: no-wildcard checklist line + scope/assignable_scopes deferred as engineer TODOs', () => {
    const text = render('azure-governance-author-role-definition');
    expect(text).toContain('# TODO: scope — engineer decides');
    expect(text).toContain('# TODO: assignable_scopes — engineer decides');
    expect(text).toMatch(/# TODO: .*`\*` \(all access\)/); // the no-wildcard decision leads
    expect(text).toMatch(/^\s{2}permissions \{/m); // actions land inside permissions {}
    expect(text).toContain('actions = ["Microsoft.Storage/storageAccounts/read"');
  });

  it('policy definition: policy_rule + parameters JSON deferred to the engineer as review TODOs', () => {
    const text = render('azure-governance-author-policy-definition');
    expect(text).toContain('# TODO: policy_rule — engineer decides');
    expect(text).toContain('# TODO: parameters — engineer decides');
    expect(text).toContain('mode = "Indexed"'); // the enforce-scope choice renders bounded
  });

  it('policy assignments: enforce-vs-audit is a bounded allowlist; subscription scope is a TODO, MG scope a reference', () => {
    for (const id of [
      'azure-governance-assign-subscription-policy',
      'azure-governance-assign-management-group-policy',
    ]) {
      const enf = op(id).params.find((p) => p.name === 'enforcement_mode')!;
      expect(enf.bounds?.allowlist, id).toEqual(['Default', 'DoNotEnforce']);
    }
    expect(render('azure-governance-assign-subscription-policy')).toContain(
      '# TODO: subscription_id — engineer decides',
    );
    expect(render('azure-governance-assign-management-group-policy')).toContain(
      'management_group_id = azurerm_management_group.platform.id',
    );
  });

  it('management lock: lock_level bounded; diagnostic setting routes an inventory target to an inventory sink', () => {
    const lock = op('azure-governance-apply-management-lock').params.find(
      (p) => p.name === 'lock_level',
    )!;
    expect(lock.bounds?.allowlist).toEqual(['CanNotDelete', 'ReadOnly']);
    const diag = render('azure-governance-configure-diagnostic-setting');
    expect(diag).toContain('target_resource_id = azurerm_key_vault.app_secrets.id');
    expect(diag).toContain(
      'log_analytics_workspace_id = azurerm_log_analytics_workspace.central.id',
    );
    expect(diag).toMatch(/^\s{2}enabled_log \{/m);
  });
});
