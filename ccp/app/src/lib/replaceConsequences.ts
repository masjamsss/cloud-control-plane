import data from '@/data/replaceConsequences.json';
import { stripProviderPrefix } from '@/lib/providerDisplay';

/**
 * The curated "what a REPLACE costs" table. A `terraform plan`
 * proves THAT a resource is destroyed and recreated; this table says, per
 * resource type, what is lost inside that swap — data destruction, identity
 * changes, downtime — in plain language a reviewer can weigh before approving.
 * Data-only (src/data/replaceConsequences.json); PlanSummaryPanel renders it.
 */
export interface ReplaceConsequence {
  /** The human noun for the type ("volume", "database") — also the headline noun. */
  noun: string;
  /** True when replacing this type destroys the data it holds (EBS, RDS, EFS, S3). */
  destroysData: boolean;
  /** One-sentence summary of what a replacement does. */
  headline: string;
  /** The specific consequences to weigh before approving. */
  consequences: string[];
}

const TABLE = data as Record<string, ReplaceConsequence>;

/** The curated consequence entry for a resource type, or undefined when the
 * type has no curated entry (a generic replace with no special hazard note). */
export function consequencesFor(type: string): ReplaceConsequence | undefined {
  return TABLE[type];
}

/** The human noun for a resource type: the curated one when known, else the
 * type de-prefixed and de-underscored (aws_nat_gateway → "nat gateway"), so a
 * headline always has a readable noun even for an uncurated type. */
export function nounForType(type: string): string {
  return TABLE[type]?.noun ?? humanizeType(type);
}

function humanizeType(type: string): string {
  const stripped = stripProviderPrefix(type).replace(/_/g, ' ').trim();
  return stripped || 'resource';
}
