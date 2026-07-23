import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceSummary } from '@/lib/catalog';
import { provisionPathFor } from '@/lib/providerCatalog';
import { ServiceIcon } from '@/components/ServiceIcon';
import { RiskMix } from './RiskMix';

export interface ServiceCardProps {
  summary: ServiceSummary;
  /** True when this service belongs to the signed-in user's team. */
  yourTeam?: boolean;
}

/**
 * A Ledger divider row (hairline top border, no card box). A service WITH ops
 * links into its resource console: identity + name + team chip + a clamped
 * description on the left, the risk mini-bar in the middle, and the live resource
 * count as the big tabular-numeral "data authority" figure on the right (with
 * operation count folded into its small label).
 *
 * A service with NO catalogued op (the long tail of provisionable services that
 * full coverage adds) never renders a dead/empty tile: the whole row is a direct
 * "Provision <service>" call-to-action deep-linking into the provider-wide
 * provision page for that type (/provision/<service>?type=<primaryType>). Every
 * service is browsable — no row is hidden or gated.
 */
export function ServiceCard({ summary, yourTeam = false }: ServiceCardProps): JSX.Element {
  const { meta, manifest, counts, primaryType } = summary;
  const opless = summary.operations.length === 0;
  // Op-less tile → a direct Provision deep-link (its "action"); with-ops tile →
  // its resource console. (An op-less service always has a primaryType; the
  // console fallback only guards the impossible case.)
  const to =
    opless && primaryType ? provisionPathFor(primaryType) : `/services/${summary.service}`;

  const hasResources = counts.resources > 0;
  const opsLabel = `${counts.total} ${counts.total === 1 ? 'op' : 'ops'}`;
  const countLabel = hasResources
    ? `${counts.resources === 1 ? 'resource' : 'resources'} · ${opsLabel}`
    : `No resources yet · ${opsLabel}`;
  const description =
    manifest?.summary ?? `No catalogued changes yet — provision a new ${meta.displayName}.`;

  return (
    <Link to={to} className={`service-card${opless ? ' service-card--provision' : ''}`}>
      <div className="service-card__main">
        <div className="service-card__top">
          <ServiceIcon slug={summary.service} size={22} />
          <h3 className="service-card__name">{meta.displayName}</h3>
          {yourTeam && (
            <span className="service-card__team" title="A service your team owns">
              Your team
            </span>
          )}
        </div>
        <p className="service-card__summary">{description}</p>
      </div>

      {opless ? (
        <span className="service-card__provision">Provision +</span>
      ) : (
        <>
          <RiskMix counts={counts.risk} />

          <div className={`service-card__count${hasResources ? '' : ' service-card__count--none'}`}>
            <span className="service-card__count-big">
              {hasResources ? counts.resources.toLocaleString() : '—'}
            </span>
            <span className="service-card__count-label">{countLabel}</span>
          </div>
        </>
      )}
    </Link>
  );
}
