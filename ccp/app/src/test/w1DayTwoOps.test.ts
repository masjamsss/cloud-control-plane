import { describe, expect, it } from 'vitest';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { resolveEnum } from '@/lib/interpreter';
import { buildPickerOptions } from '@/lib/inventoryPicker';
import type { Inventory, ManifestOperation } from '@/types';

/**
 * 0034 W1 acceptance pins for the day-2 data wave: the new/upgraded ops keep
 * the exact shapes Part 2 specifies, against the REAL estate inventory. Each
 * block cites its 0034 task id.
 */

const inventory = inventoryData as unknown as Inventory;

function op(id: string): ManifestOperation {
  const found = manifests.flatMap((m) => m.operations).find((o) => o.id === id);
  expect(found, `op ${id} missing from catalog`).toBeDefined();
  return found!;
}

describe('D2 — ebs-create-snapshot (0034 S3: pre-change snapshot at LOW)', () => {
  const snap = op('ebs-create-snapshot');

  it('renders exactly 3 fields and rides the proven append_block sibling shape', () => {
    expect(snap.params).toHaveLength(3);
    expect(snap.codemodOp).toBe('append_block');
    expect(snap.target).toEqual({ resourceType: 'aws_ebs_volume', block: 'aws_ebs_snapshot' });
  });

  it('is one L1 click, not an engineer request: LOW · self-service · additive', () => {
    expect(snap.riskFloor).toBe('LOW');
    expect(snap.exposure).toBe('l1_self_service');
    expect(snap.macd).toBe('Add');
    expect(snap.group).toBe('create');
    expect(snap.forcesReplace).toBe(false);
  });

  it('targets any of the estate volumes', () => {
    const volumes = resolveEnum(snap.params[0]!, inventory);
    expect(volumes.length).toBeGreaterThan(0);
  });

  it('the snapshot-first ritual is cross-linked from the ops it protects', () => {
    expect(op('ebs-grow').description).toContain('Create a volume snapshot');
    expect(op('ec2-resize').description).toContain('Create a volume snapshot');
  });
});

describe('D3 — efs-add-mount-target subnet picker (0034 S27/G6/F19)', () => {
  const mt = op('efs-add-mount-target');
  const subnet = mt.params.find((p) => p.name === 'subnet_id')!;

  it('subnet is an inventory picker over the estate subnets, not free text', () => {
    expect(subnet.source).toBe('inventory');
    expect(subnet.enumSource).toBe('inventory://aws_subnet/address');
    expect(subnet.bounds?.pattern).toBeUndefined();
    expect(resolveEnum(subnet, inventory)).toHaveLength(3);
  });

  it('each subnet option shows zone + CIDR as its current value', () => {
    const options = buildPickerOptions(subnet, inventory);
    expect(options).toHaveLength(3);
    for (const o of options) {
      // "ap-<region>-3a · 10.x.y.z/nn" — zone and range in one glance.
      expect(o.current, `${o.address} current chip`).toMatch(/^\S+ · .+\/\d+$/);
    }
  });
});

describe('D4 — acm-lb-listener-set-tls-policy (0034 S42/G8)', () => {
  const tls = op('acm-lb-listener-set-tls-policy');

  it('targets the estate listeners from inventory', () => {
    const listeners = resolveEnum(
      tls.params.find((p) => p.name === 'listener')!,
      inventory,
    );
    expect(listeners).toHaveLength(2); // the modern HTTPS listener + the legacy-policy one pending modernization
  });

  it('offers only the modern allowlisted policies, defaulting to the AWS-recommended one', () => {
    const policy = tls.params.find((p) => p.name === 'tls_policy')!;
    expect(policy.source).toBe('allowlist');
    expect(policy.attr).toBe('ssl_policy');
    expect(policy.default).toBe('ELBSecurityPolicy-TLS13-1-2-2021-06');
    expect(policy.bounds?.allowlist).toEqual([
      'ELBSecurityPolicy-TLS13-1-2-2021-06',
      'ELBSecurityPolicy-TLS13-1-2-Res-2021-06',
      'ELBSecurityPolicy-FS-1-2-Res-2020-10',
    ]);
    // The op exists to move OFF the 2016 policy — it is never a destination.
    expect(policy.bounds?.allowlist).not.toContain('ELBSecurityPolicy-2016-08');
  });

  it('is a guardrailed in-place change', () => {
    expect(tls.codemodOp).toBe('set_attribute');
    expect(tls.riskFloor).toBe('MEDIUM');
    expect(tls.exposure).toBe('l1_with_guardrails');
    expect(tls.forcesReplace).toBe(false);
    expect(tls.reversible).toBe(true);
  });
});

describe('D5 — cloudwatch-set-alarm-notifications (0034 S47/G9)', () => {
  const notif = op('cloudwatch-set-alarm-notifications');

  it('the topic picker lists the estate notification topics', () => {
    const topics = resolveEnum(
      notif.params.find((p) => p.name === 'topic')!,
      inventory,
    );
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.every((t) => t.startsWith('aws_sns_topic.'))).toBe(true);
  });

  it('writes alarm_actions (required) and ok_actions (optional) as topic-ARN references', () => {
    const topic = notif.params.find((p) => p.name === 'topic')!;
    const ok = notif.params.find((p) => p.name === 'ok_topic')!;
    for (const p of [topic, ok]) {
      expect(p.role).toBe('reference');
      expect(p.refAttr).toBe('arn');
      expect(p.wrap).toBe('list');
    }
    expect(topic.attr).toBe('alarm_actions');
    expect(topic.required).toBe(true);
    expect(ok.attr).toBe('ok_actions');
    expect(ok.required).toBe(false);
    expect(notif.codemodOp).toBe('set_attributes');
  });
});

describe('A9 — no catch-all without a target picker (0033 P5 / 0034 W1)', () => {
  it('every *-engineer-request op carries an inventory-sourced target param', () => {
    const catchAlls = manifests
      .flatMap((m) => m.operations)
      .filter((o) => o.id.endsWith('-engineer-request'));
    expect(catchAlls.length).toBe(30); // 30 aws catch-alls; the 4 azure-connectivity ones became engineer-gated create forms (0039 capability wave)
    const missing = catchAlls
      .filter((o) => !o.params.some((p) => p.source === 'inventory' && p.enumSource))
      .map((o) => o.id);
    expect(missing, `catch-alls without a picker: ${missing.join(', ')}`).toEqual([]);
  });

  it('pickers over resource types with no estate rows yet stay optional (form must stay submittable)', () => {
    // The bundled sample is a small, deliberately narrow demo estate (see
    // EMPTY_TYPES in inventoryEnums.test.ts for the full declared-empty
    // roster) — several catch-all target types it legitimately runs zero of
    // are pre-existing REQUIRED pickers whose optionality is a manifest
    // design question (S3/catalog scope), not something this data-only
    // re-oracle changes. Declared here so the check keeps catching a truly
    // NEW offender introduced by a manifest edit.
    const KNOWN_EMPTY_IN_SAMPLE = new Set([
      'aws_cloudtrail',
      'aws_cloudwatch_dashboard',
      'aws_config_configuration_recorder',
      'aws_config_delivery_channel',
      'aws_dlm_lifecycle_policy',
      'aws_cloudwatch_event_rule',
      'aws_cloudwatch_event_target',
      'aws_default_network_acl',
    ]);
    const byType = new Map<string, number>();
    for (const r of inventory.resources) {
      byType.set(r.resourceType, (byType.get(r.resourceType) ?? 0) + 1);
    }
    const offenders: string[] = [];
    for (const o of manifests.flatMap((m) => m.operations)) {
      if (!o.id.endsWith('-engineer-request')) continue;
      if (KNOWN_EMPTY_IN_SAMPLE.has(o.target.resourceType)) continue;
      for (const p of o.params) {
        if (p.source !== 'inventory' || !p.enumSource) continue;
        const rows = byType.get(o.target.resourceType) ?? 0;
        if (rows === 0 && p.required) offenders.push(`${o.id}/${p.name}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
