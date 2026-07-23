import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { renderHclSkeleton } from '@/lib/hclSkeleton';
import { parseInventoryEnum, resolveEnum, validateParams } from '@/lib/interpreter';
import type { Inventory, ManifestOperation } from '@/types';
import { BASELINE_VALUES } from './fixtures/skeletons/baselines/values';

/**
 * lane-aws-security — the 20 engineer-gated, bounded SECURITY & MANAGEMENT
 * create forms (IAM / KMS / Secrets Manager / CloudWatch / Config / CloudTrail /
 * WAF / GuardDuty / Security Hub / Macie / Access Analyzer / SSM / RAM /
 * Directory Service). Modeled on the azure-governance forms: every privilege or
 * blast-radius field renders as an allowlisted value, a reference expression, or
 * an engineer-decides review TODO — NEVER a raw policy document, secret value, or
 * free-text privilege. Correctness + safety-bounding is the whole point (these are
 * IAM / KMS / audit / detection resources), so this proves the shipped manifests
 * drive the renderer to the bounded shapes and that no privilege ever leaks in.
 *
 *   1. GOLDENS — every form's rendered DRAFT skeleton is byte-pinned
 *      (fixtures/skeletons/baselines/<op-id>.golden.tf; regenerate consciously
 *      with scripts/dev-gen-baseline-goldens.ts).
 *   2. FROZEN posture — create_resource / Add / engineer_only / HIGH / create,
 *      draftSkeleton, decisions[] non-empty, help on every param, no target.block.
 *   3. NO LEAK — the anti-automation-bias control renders: no policy document,
 *      no secret value, no free-text privilege field ever reaches the draft.
 *   4. PICKERS RESOLVE — every inventory reference fills from committed inventory.
 *   5. SUBMITTABLE — every fixture validates against its op (errors === {}).
 */

const inventory = inventoryData as unknown as Inventory;
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skeletons', 'baselines');

function golden(id: string): string {
  return readFileSync(join(GOLDEN_DIR, `${id}.golden.tf`), 'utf8').replace(/\n$/, '');
}

const allOps = manifests.flatMap((m) => m.operations);
function op(id: string): ManifestOperation {
  const found = allOps.find((o) => o.id === id);
  expect(found, `op ${id} missing from catalog`).toBeDefined();
  return found!;
}

/** The 20 forms, grouped by the resource type each stands up. */
const SECURITY_IDS = [
  'iam-provision-role',
  'iam-provision-policy-attachment',
  'iam-provision-instance-profile',
  'kms-provision-key',
  'kms-provision-alias',
  'secretsmanager-provision-secret',
  'cloudwatch-provision-log-group',
  'cloudwatch-provision-metric-alarm',
  'config-provision-recorder',
  'config-deploy-managed-rule',
  'cloudtrail-provision-trail',
  'waf-provision-web-acl',
  'waf-provision-ip-set',
  'guardduty-enable-detector',
  'securityhub-enable-account',
  'macie-enable-account',
  'accessanalyzer-provision-analyzer',
  'ssm-provision-document',
  'ram-provision-resource-share',
  'directory-service-provision-directory',
] as const;

function render(id: string): string {
  const values = BASELINE_VALUES[id];
  expect(values, `no fixture values for ${id}`).toBeDefined();
  return renderHclSkeleton(op(id), values!, { requestId: 'REQ-W3' });
}

describe('aws security creates — byte-pinned DRAFT skeletons', () => {
  it.each(SECURITY_IDS)('%s renders its pinned DRAFT skeleton', (id) => {
    expect(render(id)).toBe(golden(id));
  });

  it.each(SECURITY_IDS)('%s leads with the DRAFT banner and stringifies no object', (id) => {
    const text = render(id);
    expect(text.startsWith('# DRAFT — generated from request REQ-W3')).toBe(true);
    expect(text).not.toContain('[object Object]');
  });
});

describe('aws security creates — frozen engineer-gated posture', () => {
  it.each(SECURITY_IDS)('%s is create_resource / Add / engineer_only / HIGH / create', (id) => {
    const o = op(id);
    expect(o.codemodOp, id).toBe('create_resource');
    expect(o.macd, id).toBe('Add');
    expect(o.exposure, id).toBe('engineer_only');
    expect(o.riskFloor, id).toBe('HIGH');
    expect(o.group, id).toBe('create');
    expect(o.forcesReplace, id).toBe(false);
    expect(o.autoEligible, id).toBe(false);
    expect(o.draftSkeleton, id).toBe(true);
    expect(o.pinned, `${id} must not be pinned (engineer_only)`).toBeUndefined();
    // A create must NOT carry target.block — that would make it a resource-scoped
    // Add that leaks onto a resource menu instead of the service create picker.
    expect(o.target.block, `${id}: a service-level provision must not be resource-pinned`).toBe(
      undefined,
    );
    expect((o.decisions?.length ?? 0) > 0, `${id} has decisions[]`).toBe(true);
    expect((o.summary ?? '').length, `${id} summary <= 140`).toBeLessThanOrEqual(140);
    for (const p of o.params) {
      expect(typeof p.help === 'string' && p.help.length > 0, `${id}/${p.name} has help`).toBe(true);
    }
  });
});

describe('aws security creates — no privilege ever leaks into the draft', () => {
  it.each(SECURITY_IDS)('%s renders no raw policy document / key policy', (id) => {
    const text = render(id);
    // A trust or resource policy attribute must only ever be an engineer TODO,
    // never assigned a value (a raw or half-formed policy document).
    expect(text, `${id} assigns assume_role_policy`).not.toMatch(/^\s*assume_role_policy\s*=/m);
    expect(text, `${id} exposes a key/resource policy attribute`).not.toMatch(/^\s*policy\s*=/m);
    expect(text, `${id} carries an inline_policy block`).not.toContain('inline_policy');
  });

  it('iam role: trust is an engineer TODO, no inline policy, no attached permissions', () => {
    const text = render('iam-provision-role');
    expect(text).toContain('# TODO: assume_role_policy — engineer decides');
    expect(text).not.toContain('inline_policy');
    expect(text).not.toMatch(/^\s*managed_policy_arns/m);
    // The trust bound (allowlisted principals) is documented, never authored here.
    const trust = op('iam-provision-role').params.find((p) => p.name === 'assume_role_policy')!;
    expect(trust.bounds?.allowlist).toEqual(['engineer-decides']);
    expect(trust.default).toBe('engineer-decides');
  });

  it('policy attachment: only AWS-managed, account-generic read-only ARNs are offered', () => {
    const arns = op('iam-provision-policy-attachment').params.find((p) => p.name === 'policy_arn')!
      .bounds!.allowlist!;
    for (const a of arns) {
      if (a === 'engineer-decides') continue;
      // arn:aws:iam::aws:policy/... — the account segment is the literal `aws`, so it
      // reads the same on every account and carries no customer policy body.
      expect(String(a), `${a} is not an AWS-managed policy ARN`).toMatch(
        /^arn:aws:iam::aws:policy\//,
      );
    }
    // The rendered attachment references a managed ARN, never a customer document.
    expect(render('iam-provision-policy-attachment')).toMatch(
      /^\s*policy_arn = "arn:aws:iam::aws:policy\//m,
    );
  });

  it('kms key: the policy attribute is never exposed (default key policy only)', () => {
    const params = op('kms-provision-key').params.map((p) => p.attr ?? p.name);
    expect(params, 'kms key exposes the policy attribute').not.toContain('policy');
    expect(render('kms-provision-key')).not.toMatch(/^\s*policy\s*=/m);
  });

  it('secret: metadata only — no secret value attribute exists or renders', () => {
    const attrs = op('secretsmanager-provision-secret').params.map((p) => p.attr ?? p.name);
    for (const forbidden of ['secret_string', 'secret_binary']) {
      expect(attrs, `secret exposes ${forbidden}`).not.toContain(forbidden);
    }
    expect(render('secretsmanager-provision-secret')).not.toMatch(/secret_string|secret_binary/);
  });

  it('ssm document: arbitrary-command content is an engineer TODO, never captured', () => {
    const text = render('ssm-provision-document');
    expect(text).toContain('# TODO: content — engineer decides');
    expect(text).not.toMatch(/^\s*content\s*=\s*"/m);
    expect(op('ssm-provision-document').params.find((p) => p.name === 'content')!.bounds?.allowlist)
      .toEqual(['engineer-decides']);
  });

  it('directory: the admin password is an engineer TODO, never captured', () => {
    const text = render('directory-service-provision-directory');
    expect(text).toContain('# TODO: password — engineer decides');
    expect(text).not.toMatch(/^\s*password\s*=\s*"/m);
  });

  it('ram share: cross-account external principals are denied by default (const false)', () => {
    const ext = op('ram-provision-resource-share').params.find(
      (p) => p.name === 'allow_external_principals',
    )!;
    expect(ext.role).toBe('const');
    expect(ext.const).toBe(false);
    expect(render('ram-provision-resource-share')).toContain('allow_external_principals = false');
  });

  it('audit/detection enablement guardrails render as const true (never asked)', () => {
    expect(render('guardduty-enable-detector')).toContain('enable = true');
    expect(render('cloudtrail-provision-trail')).toContain('enable_log_file_validation = true');
    expect(render('cloudtrail-provision-trail')).toContain('is_multi_region_trail = true');
    expect(render('securityhub-enable-account')).toContain('enable_default_standards = true');
    expect(render('config-provision-recorder')).toContain('all_supported = true');
  });

  it('config rule: managed rules only (owner AWS) — no custom Guard policy text', () => {
    const owner = op('config-deploy-managed-rule').params.find((p) => p.name === 'source_owner')!;
    expect(owner.bounds?.allowlist).toEqual(['AWS']);
    const attrs = op('config-deploy-managed-rule').params.map((p) => p.attr ?? p.name);
    expect(attrs).not.toContain('policy_text');
  });
});

describe('aws security creates — pickers resolve and fixtures validate', () => {
  it.each(SECURITY_IDS)('%s: every inventory picker resolves from committed inventory', (id) => {
    for (const p of op(id).params) {
      const src = parseInventoryEnum(p.enumSource);
      if (!src) continue;
      const rows = resolveEnum(p, inventory).length;
      expect(rows, `${id}/${p.name} (${p.enumSource})`).toBeGreaterThan(0);
    }
  });

  it.each(SECURITY_IDS)('%s validates its golden fixture values (submittable as authored)', (id) => {
    const result = validateParams(op(id), BASELINE_VALUES[id]!, inventory);
    expect(result.errors, id).toEqual({});
  });
});
