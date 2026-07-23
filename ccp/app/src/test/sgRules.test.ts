import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describePortRange, describeRuleSource, parseSgRules } from '@/lib/sgRules';
import { SgCurrentRulesView } from '@/features/request/SgCurrentRules';
import { getBlockSource } from '@/lib/blockSource';

/**
 * 0034 D13 (closes F24/G10) — the SG current-rules panel: rule ops on a
 * security group render the group's CURRENT ingress/egress rules from the
 * committed block source, so "which rule do I remove?" is answered by
 * reading, not guessing. Dual-layer proof, the CoolingPanel pattern: the
 * pure parser/formatters here, the render shape via renderToStaticMarkup,
 * and one read against the REAL vendored block data (no network — the same
 * standalone invariant blockSource already keeps).
 */

const ESTATE_STYLE_BLOCK = `resource "aws_security_group" "prd_app_sg" {
  name        = "PRD-App-SG"
  description = "App tier"
  vpc_id      = "vpc-0abc12345def67891" # PRD VPC

  ingress {
    description = "App from web tier"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16", "10.1.0.0/16"]
  }

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.prd_db_sg.id]
  }

  ingress {
    from_port = -1
    to_port   = -1
    protocol  = "icmp"
    self      = true
  }

  egress {
    description = "Allow all out"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "PRD-App-SG"
  }
}`;

describe('parseSgRules — the committed rules, read fail-safe', () => {
  const rules = parseSgRules(ESTATE_STYLE_BLOCK);

  it('finds every ingress and egress block, in order, and nothing else', () => {
    expect(rules.map((r) => r.direction)).toEqual(['ingress', 'ingress', 'ingress', 'egress']);
  });

  it('reads description, ports, protocol, and CIDR lists', () => {
    const first = rules[0]!;
    expect(first.description).toBe('App from web tier');
    expect(first.fromPort).toBe(8443);
    expect(first.toPort).toBe(8443);
    expect(first.protocol).toBe('tcp');
    expect(first.cidrBlocks).toEqual(['10.0.0.0/16', '10.1.0.0/16']);
  });

  it('reads security-group references (unquoted Terraform expressions) verbatim', () => {
    expect(rules[1]!.securityGroups).toEqual(['aws_security_group.prd_db_sg.id']);
    expect(rules[1]!.cidrBlocks).toEqual([]);
  });

  it('reads self:true and icmp', () => {
    expect(rules[2]!.self).toBe(true);
    expect(rules[2]!.protocol).toBe('icmp');
  });

  it('the tags map is not a rule; the resource header is not a rule', () => {
    expect(rules).toHaveLength(4);
  });

  it('a block with no rules parses to an empty list (never throws)', () => {
    expect(parseSgRules('resource "aws_security_group" "empty" {\n  name = "x"\n}')).toEqual([]);
  });

  it('decoy "ingress {" inside a comment or string is never a rule (tokenizer depth map)', () => {
    const decoy = `resource "aws_security_group" "d" {
  # ingress {
  description = "the word ingress { in a string"
  ingress {
    from_port = 22
    to_port   = 22
    protocol  = "tcp"
  }
}`;
    const parsed = parseSgRules(decoy);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.fromPort).toBe(22);
  });
});

describe('describePortRange / describeRuleSource — operator-plain phrases', () => {
  it('protocol -1 reads "All traffic"; 0-0 reads "all ports"; ranges and single ports read naturally', () => {
    expect(describePortRange({ protocol: '-1', fromPort: 0, toPort: 0 })).toBe('All traffic');
    expect(describePortRange({ protocol: 'tcp', fromPort: 0, toPort: 0 })).toBe('TCP, all ports');
    expect(describePortRange({ protocol: 'tcp', fromPort: 443, toPort: 443 })).toBe('TCP port 443');
    expect(describePortRange({ protocol: 'udp', fromPort: 30000, toPort: 32767 })).toBe('UDP ports 30000–32767');
    expect(describePortRange({ protocol: 'icmp', fromPort: -1, toPort: -1 })).toBe('ICMP');
  });

  it('sources join CIDRs, group references, and self', () => {
    expect(
      describeRuleSource({ direction: 'ingress', cidrBlocks: ['10.0.0.0/8'], securityGroups: [], self: true }),
    ).toBe('from 10.0.0.0/8, this group itself');
    expect(
      describeRuleSource({ direction: 'egress', cidrBlocks: ['0.0.0.0/0'], securityGroups: [] }),
    ).toBe('to 0.0.0.0/0');
    expect(describeRuleSource({ direction: 'ingress', cidrBlocks: [], securityGroups: [] })).toBe(
      'from an unstated source',
    );
  });
});

describe('SgCurrentRulesView — the render shape', () => {
  const block = { file: 'environments/prod/security_groups.tf', line: 120, source: ESTATE_STYLE_BLOCK };
  const rules = parseSgRules(ESTATE_STYLE_BLOCK);

  it('renders provenance, both direction groups with counts, and the rules readable in-form', () => {
    const html = renderToStaticMarkup(
      React.createElement(SgCurrentRulesView, { address: 'aws_security_group.prd_app_sg', block, rules }),
    );
    expect(html).toContain('Current rules of this group');
    expect(html).toContain('environments/prod/security_groups.tf');
    expect(html).toContain('line 120');
    expect(html).toContain('Inbound');
    expect(html).toContain('Outbound');
    expect(html).toContain('TCP port 8443');
    expect(html).toContain('from 10.0.0.0/16, 10.1.0.0/16');
    expect(html).toContain('App from web tier');
    expect(html).toContain('All traffic');
    expect(html).toContain('aws_security_group.prd_app_sg');
  });

  it('an unknown address (no committed block) says so honestly instead of rendering nothing', () => {
    const html = renderToStaticMarkup(
      React.createElement(SgCurrentRulesView, { address: 'aws_security_group.brand_new', block: null, rules: [] }),
    );
    expect(html).toContain('No committed rules found');
  });

  it('a rule-less group says so rather than showing an empty panel', () => {
    const html = renderToStaticMarkup(
      React.createElement(SgCurrentRulesView, {
        address: 'aws_security_group.x',
        block: { ...block, source: 'resource "aws_security_group" "x" {}' },
        rules: [],
      }),
    );
    expect(html).toContain('no inbound or outbound rules');
  });
});

describe('the real vendored block data serves the panel (no network)', () => {
  it('a committed estate security group parses to at least one rule', async () => {
    const block = await getBlockSource('aws_security_group.app');
    expect(block).toBeTruthy();
    const rules = parseSgRules(block!.source);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.direction === 'ingress')).toBe(true);
    expect(rules.some((r) => r.direction === 'egress')).toBe(true);
  });
});
