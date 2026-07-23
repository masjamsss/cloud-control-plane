import { lineStartDepths } from '@/lib/hclScan';

/**
 * Read a security group's CURRENT ingress/egress rules out of its committed
 * block source: `sg-remove-ingress-rule` asks for a rule by
 * key/description while the group's live rules were invisible from the form —
 * the L1 guessed. This renders them, from the SAME vendored block-source data
 * the full-block viewer already ships (lib/blockSource.ts) — deterministic,
 * no network, no model.
 *
 * Parsing doctrine mirrors hclScan's: FAIL-SAFE. A rule block this walker
 * cannot follow (an unclosed brace, a style outside the estate's committed
 * idiom) is skipped, never mis-read — the panel then shows fewer rules, and
 * the full-block viewer remains the byte-true fallback right below it.
 */
export interface SgRule {
  direction: 'ingress' | 'egress';
  description?: string;
  protocol?: string;
  fromPort?: number;
  toPort?: number;
  /** Source/destination CIDR ranges (quoted literals in the block). */
  cidrBlocks: string[];
  /** Source/destination security groups — literal sg- ids or Terraform references. */
  securityGroups: string[];
  /** True when the rule allows traffic from/to the group itself. */
  self?: boolean;
}

const RULE_HEADER = /^\s*(ingress|egress)\s*\{\s*$/;
const ATTR_LINE = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/;

/** Split a one-line HCL list body on top-level commas and normalize entries:
 * quoted literals lose their quotes; bare expressions (aws_security_group.x.id)
 * stay verbatim. */
function listEntries(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}

function stringValue(raw: string): string {
  const noComment = raw.replace(/\s(#|\/\/).*$/, '').trim();
  return noComment.startsWith('"') && noComment.endsWith('"') ? noComment.slice(1, -1) : noComment;
}

/**
 * Parse the top-level `ingress {}` / `egress {}` blocks of one
 * `aws_security_group` resource block's source. Line-oriented over the shared
 * tokenizer's depth map, so indentation style never matters; attributes it
 * doesn't know are ignored; a header whose body it cannot bound is skipped.
 */
export function parseSgRules(blockSource: string): SgRule[] {
  const lines = blockSource.split('\n');
  const depths = lineStartDepths(blockSource);
  const rules: SgRule[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (depths[i] !== 1) continue;
    const header = RULE_HEADER.exec(lines[i]!);
    if (!header) continue;

    // The body: lines after the header until the closer — the line at start-
    // depth 2 whose content is just `}`. Anything deeper belongs to a nested
    // block and is ignored (no known SG rule idiom nests, but fail-safe).
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const d = depths[j];
      if (d === undefined || d < 2) break; // left the rule without a clean closer — skip
      if (d === 2 && lines[j]!.trim() === '}') {
        close = j;
        break;
      }
    }
    if (close === -1) continue;

    const rule: SgRule = { direction: header[1] as 'ingress' | 'egress', cidrBlocks: [], securityGroups: [] };
    for (let j = i + 1; j < close; j += 1) {
      if (depths[j] !== 2) continue;
      const m = ATTR_LINE.exec(lines[j]!);
      if (!m) continue;
      const [, key, raw] = m;
      switch (key) {
        case 'description':
          rule.description = stringValue(raw!);
          break;
        case 'protocol':
          rule.protocol = stringValue(raw!);
          break;
        case 'from_port': {
          const n = Number(stringValue(raw!));
          if (Number.isFinite(n)) rule.fromPort = n;
          break;
        }
        case 'to_port': {
          const n = Number(stringValue(raw!));
          if (Number.isFinite(n)) rule.toPort = n;
          break;
        }
        case 'cidr_blocks':
        case 'ipv6_cidr_blocks':
          rule.cidrBlocks.push(...listEntries(raw!));
          break;
        case 'security_groups':
        case 'prefix_list_ids':
          rule.securityGroups.push(...listEntries(raw!));
          break;
        case 'self':
          if (stringValue(raw!) === 'true') rule.self = true;
          break;
        default:
          break; // unknown attribute — ignored, never guessed at
      }
    }
    rules.push(rule);
    i = close;
  }

  return rules;
}

/** "All traffic" / "TCP port 443" / "UDP ports 30000–32767" — the rule's
 * protocol+port phrase, operator-plain. */
export function describePortRange(rule: Pick<SgRule, 'protocol' | 'fromPort' | 'toPort'>): string {
  const protocol = rule.protocol ?? '';
  if (protocol === '-1') return 'All traffic';
  const proto = protocol === '' ? 'Any protocol' : protocol.toUpperCase();
  if (protocol === 'icmp') return 'ICMP';
  const { fromPort, toPort } = rule;
  if (fromPort === undefined || toPort === undefined) return proto;
  if (fromPort === 0 && toPort === 0) return `${proto}, all ports`;
  if (fromPort === toPort) return `${proto} port ${fromPort}`;
  return `${proto} ports ${fromPort}–${toPort}`;
}

/** The rule's source/destination phrase: CIDRs, group references, and self. */
export function describeRuleSource(rule: Pick<SgRule, 'direction' | 'cidrBlocks' | 'securityGroups' | 'self'>): string {
  const parts = [...rule.cidrBlocks, ...rule.securityGroups];
  if (rule.self) parts.push('this group itself');
  const joined = parts.join(', ');
  if (joined === '') return rule.direction === 'ingress' ? 'from an unstated source' : 'to an unstated destination';
  return rule.direction === 'ingress' ? `from ${joined}` : `to ${joined}`;
}
