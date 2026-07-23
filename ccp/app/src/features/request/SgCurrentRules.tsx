import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ManifestOperation } from '@/types';
import { getBlockSource, type BlockSource } from '@/lib/blockSource';
import { describePortRange, describeRuleSource, parseSgRules, type SgRule } from '@/lib/sgRules';
import './request.css';

/**
 * The SG current-rules panel: every rule op on a
 * security group renders the group's CURRENT ingress/egress rules beside the
 * form, read from the committed block source (the same vendored, redacted
 * data the full-block viewer uses — no network), so removing or adding a rule
 * is done by READING the live policy, never by guessing a rule key.
 */

export interface SgCurrentRulesViewProps {
  /** The selected group's Terraform address (provenance line). */
  address: string;
  /** The committed block, or null when the address isn't in the block index
   * (a brand-new group, or an estate change that outran the last extraction). */
  block: BlockSource | null;
  rules: SgRule[];
}

function RuleList({ rules, direction }: { rules: SgRule[]; direction: 'ingress' | 'egress' }): JSX.Element | null {
  const matching = rules.filter((r) => r.direction === direction);
  if (matching.length === 0) return null;
  return (
    <div className="sg-rules__group">
      <h3 className="sg-rules__direction">
        {direction === 'ingress' ? 'Inbound' : 'Outbound'}
        <span className="sg-rules__count">{matching.length}</span>
      </h3>
      <ul className="sg-rules__list">
        {matching.map((rule, i) => (
          <li key={i} className="sg-rules__rule">
            <span className="sg-rules__ports">{describePortRange(rule)}</span>{' '}
            <span className="sg-rules__source">{describeRuleSource(rule)}</span>
            {rule.description && <span className="sg-rules__desc">“{rule.description}”</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Pure render layer — exported for renderToStaticMarkup shape tests (the
 * same dual-layer testability CoolingPanel/WindowPanel get). */
export function SgCurrentRulesView({ address, block, rules }: SgCurrentRulesViewProps): JSX.Element {
  return (
    <section className="sg-rules" aria-label="Current rules of the selected security group">
      <h2 className="sg-rules__title">Current rules of this group</h2>
      {block === null ? (
        <p className="sg-rules__empty">
          No committed rules found for this group — it may be new, or newer than the last catalog
          data refresh.
        </p>
      ) : (
        <>
          <p className="sg-rules__provenance">
            From the committed Terraform — <code>{block.file}</code>, line {block.line}. Check the
            rule you mean before submitting.
          </p>
          {rules.length === 0 ? (
            <p className="sg-rules__empty">This group has no inbound or outbound rules in its block.</p>
          ) : (
            <>
              <RuleList rules={rules} direction="ingress" />
              <RuleList rules={rules} direction="egress" />
            </>
          )}
          <span className="sg-rules__addr">{address}</span>
        </>
      )}
    </section>
  );
}

/**
 * Container: renders only for an op that targets `aws_security_group` with a
 * group actually selected. Loads the block source lazily (the same dynamic
 * chunk path useFullBlockDiff uses) and parses it deterministically.
 */
export function SgCurrentRules({
  op,
  targetAddress,
}: {
  op: ManifestOperation;
  targetAddress: string;
}): JSX.Element | null {
  const applicable = op.target.resourceType === 'aws_security_group' && targetAddress !== '';
  const [loaded, setLoaded] = useState<{ block: BlockSource | null; rules: SgRule[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    if (!applicable) return;
    void getBlockSource(targetAddress).then((block) => {
      if (!alive) return;
      setLoaded({ block, rules: block ? parseSgRules(block.source) : [] });
    });
    return () => {
      alive = false;
    };
  }, [applicable, targetAddress]);

  if (!applicable || loaded === null) return null;
  return <SgCurrentRulesView address={targetAddress} block={loaded.block} rules={loaded.rules} />;
}
