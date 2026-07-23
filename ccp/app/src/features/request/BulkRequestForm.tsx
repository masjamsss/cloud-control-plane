import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Inventory, ManifestOperation, Schedule, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { isChangeFrozen, isOpDisabled, useSettings } from '@/lib/settings';
import { getOperation, validateParams } from '@/lib/interpreter';
import { stripInactiveParams } from '@/lib/dependsOn';
import { deriveFormPlan } from '@/lib/catalog';
import { getServiceMeta } from '@/lib/serviceMeta';
import { displayResourceLabel } from '@/lib/chipLabel';
import { bulkRequirement, bulkToChangeSet, isBulkableAction, requirementSummary } from '@/lib/changeSet';
import { parseBulkTargets } from '@/lib/bulkRoute';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { SchedulePicker } from './SchedulePicker';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Button } from '@/components/ui/Button';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { resolveRisk } from '@/lib/riskOverrides';
import './request.css';

const MIN_JUSTIFICATION = 10;

/** role:"const" params carry no request input (the executor writes their manifest value) —
 * never a field, never submitted. The inventory target param is per-item (bound to each
 * selected address), so it is not part of the shared bulk form either. */
function isConstParam(p: { role?: string }): boolean {
  return p.role === 'const';
}

export interface BulkRequestFormViewProps {
  serviceSlug: string;
  op: ManifestOperation;
  /** The selected target addresses this one op fans across. */
  targets: string[];
  inventory: Inventory;
}

/**
 * The bulk request form (Phase B): configure ONE action's shared inputs ONCE, then apply it
 * to every selected resource as a single change set — one PR, one approval, applied
 * together. The inventory target is bound per item (each selected address), so the shared
 * form shows only the op's value params. Pure-props (SSR-testable), mirroring
 * ResourceDetailView's split.
 */
export function BulkRequestFormView({
  serviceSlug,
  op,
  targets,
  inventory,
}: BulkRequestFormViewProps): JSX.Element {
  const navigate = useNavigate();
  const meta = getServiceMeta(serviceSlug);
  const settings = useSettings();

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [justification, setJustification] = useState('');
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'now' });
  const [revealErrors, setRevealErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  const targetParam = useMemo(() => op.params.find((p) => p.source === 'inventory'), [op]);

  // Seed manifest defaults for the shared (non-const, non-inventory) params.
  useEffect(() => {
    const init: Record<string, unknown> = {};
    for (const p of op.params) {
      if (isConstParam(p) || p.source === 'inventory') continue;
      if (p.default !== undefined) init[p.name] = p.default;
    }
    setValues(init);
    setTouched({});
    setJustification('');
    setSchedule({ kind: 'now' });
    setRevealErrors(false);
  }, [op]);

  // The shared value fields — the op's form plan minus const params AND the inventory target
  // (which is filled per item). An op with no shared params (e.g. a plain delete) shows none.
  const plan = deriveFormPlan(op);
  const visibleSections = plan.sections
    .map((section) => ({
      ...section,
      fields: section.fields.filter((f) => !isConstParam(f) && f.source !== 'inventory'),
    }))
    .filter((section) => section.fields.length > 0);

  // Validate the shared params against a REPRESENTATIVE target (the first selected) so their
  // static bounds (min/max/pattern/allowlist) are checked; the server re-validates every
  // item independently. growOnly (target-dependent) is advisory only in bulk.
  const validation = useMemo(
    () => validateParams(op, { ...values, ...(targetParam ? { [targetParam.name]: targets[0] ?? '' } : {}) }, inventory),
    [op, values, targetParam, targets, inventory],
  );

  const requirement = bulkRequirement(op, targets.length);
  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;
  const canSubmit = targets.length > 0 && validation.ok && !justificationTooShort && !submitting;

  const liveBlocked = settings.changeFreeze
    ? 'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.'
    : settings.disabledOps.includes(op.id)
      ? 'This operation has been disabled by an administrator.'
      : null;

  const onSubmit = (): void => {
    if (!validation.ok || justificationTooShort) {
      setRevealErrors(true);
      const all: Record<string, boolean> = { justification: true };
      for (const p of op.params) all[p.name] = true;
      setTouched(all);
      return;
    }
    if (isChangeFrozen()) {
      setBlocked('Change requests are frozen by an administrator right now. Try again once the freeze is lifted.');
      return;
    }
    if (isOpDisabled(op.id)) {
      setBlocked('This operation has been disabled by an administrator.');
      return;
    }
    setSubmitting(true);
    // Strip inactive dependsOn params (evaluated with a representative target), then drop the
    // target itself — bulkToChangeSet binds each item's own address.
    const active = stripInactiveParams(op.params, {
      ...values,
      ...(targetParam ? { [targetParam.name]: targets[0] ?? '' } : {}),
    });
    if (targetParam) delete active[targetParam.name];
    const draft = bulkToChangeSet(op, targets, active, justification.trim(), schedule);
    void api.submitChangeSet(draft).then((result) => {
      if (result.ok) navigate('/requests/' + result.request.id);
      else {
        setSubmitting(false);
        setBlocked(result.reason);
      }
    });
  };

  const crumbs = [
    { label: 'Catalog', to: '/' },
    { label: meta.displayName, to: '/services/' + serviceSlug },
    { label: 'Bulk change' },
  ];

  return (
    <div className="rq">
      <Breadcrumbs items={crumbs} />

      <h1 className="rq-title">
        {op.title} · {targets.length} {targets.length === 1 ? 'resource' : 'resources'}
      </h1>
      <p className="rq-lede">
        This applies <strong>{op.title}</strong> to every selected resource as ONE change — one PR,
        one approval, applied together.
      </p>

      <div className="rq-strip">
        <MacdTag macd={op.macd} />
        <RiskBadge risk={resolveRisk(op)} />
        <AccessBadge exposure={op.exposure} />
      </div>

      <div className="rq-grid">
        <div className="rq-main">
          {visibleSections.length > 0 ? (
            <SchemaForm
              operationId={op.id}
              sections={visibleSections}
              inventory={inventory}
              values={values}
              errors={validation.errors}
              touched={touched}
              onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
              onBlur={(name) => setTouched((t) => ({ ...t, [name]: true }))}
            />
          ) : (
            <p className="rq-lede">This action takes no extra input — it applies to each selected resource.</p>
          )}

          <div className="rq-field">
            <label className="rq-field__label" htmlFor="bulk-justification">
              Why is this change needed? <span className="rq-field__req">*</span>
            </label>
            <textarea
              id="bulk-justification"
              className="rq-field__textarea"
              rows={3}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, justification: true }))}
            />
            <p className="rq-field__help">Recorded on the request and in the PR — at least 10 characters.</p>
            {revealErrors && justificationTooShort && (
              <p className="rq-field__error" role="alert">
                Enter a justification (at least 10 characters).
              </p>
            )}
          </div>

          <SchedulePicker value={schedule} onChange={setSchedule} />

          {(blocked ?? liveBlocked) && (
            <p className="rq-blocked" role="alert">
              {blocked ?? liveBlocked}
            </p>
          )}

          <div className="rq-submitbar">
            <Button variant="primary" disabled={!canSubmit || liveBlocked !== null} onClick={onSubmit}>
              {submitting ? 'Submitting…' : `Submit for ${targets.length} ${targets.length === 1 ? 'resource' : 'resources'}`}
            </Button>
            <Link to={'/services/' + serviceSlug} className="rq-cancel">
              Cancel
            </Link>
          </div>
        </div>

        <aside className="rq-side">
          <div className="rq-side__card">
            <h2 className="rq-side__title">Review requirement</h2>
            <p className="rq-side__req">{requirementSummary(requirement)}</p>
            {requirement.approvalsRequired > 1 && (
              <p className="rq-side__note">Two distinct approvers must sign before anything applies.</p>
            )}
          </div>
          <div className="rq-side__card">
            <h2 className="rq-side__title">
              Applies to {targets.length} {targets.length === 1 ? 'resource' : 'resources'}
            </h2>
            <ul className="rq-side__targets">
              {targets.map((addr) => {
                const res = inventory.resources.find((r) => r.address === addr);
                return (
                  <li className="rq-side__target" key={addr}>
                    <span className="rq-side__target-name">{res ? displayResourceLabel(res) : addr}</span>
                    <code className="rq-side__target-addr">{addr}</code>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * Route container for `/services/:service/bulk/:operationId?targets=a,b,c`: loads the
 * manifest + inventory, resolves the op + the selected targets, and hands pure props to
 * {@link BulkRequestFormView}. Degrades honestly when the op is unknown, is not
 * bulk-eligible (forces-replace stays on the single-resource path), or the selection is
 * missing (a refreshed/hand-typed URL).
 */
export function BulkRequestForm(): JSX.Element {
  const { service, operationId } = useParams<{ service: string; operationId: string }>();
  const [searchParams] = useSearchParams();
  const serviceSlug = service ?? '';
  const targets = useMemo(() => parseBulkTargets(searchParams.get('targets')), [searchParams]);

  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loaded, setLoaded] = useState(false);
  const projectId = useActiveProjectId();

  useEffect(() => {
    let alive = true;
    void Promise.all([api.listManifests(), api.getInventory()]).then(([m, inv]) => {
      if (!alive) return;
      setManifests(m);
      setInventory(inv);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const op = useMemo(
    () => (operationId ? getOperation(operationId, manifests) : undefined),
    [operationId, manifests],
  );
  const meta = getServiceMeta(serviceSlug);

  if (!loaded || !inventory) {
    return (
      <div className="rq">
        <p className="rq-loading">Loading…</p>
      </div>
    );
  }

  if (!op || !isBulkableAction(op) || targets.length === 0) {
    return (
      <div className="rq">
        <Breadcrumbs
          items={[
            { label: 'Catalog', to: '/' },
            { label: meta.displayName, to: '/services/' + serviceSlug },
            { label: 'Bulk change' },
          ]}
        />
        <div className="rq-notfound">
          <h1 className="rq-notfound__title">Nothing to change in bulk</h1>
          <p>
            {targets.length === 0
              ? 'No resources are selected. Pick resources from the list and choose a bulk action.'
              : 'This action cannot be applied in bulk. Open the resource and request it there.'}
          </p>
          <Link to={'/services/' + serviceSlug} className="rq-cancel">
            Back to {meta.displayName}
          </Link>
        </div>
      </div>
    );
  }

  return <BulkRequestFormView serviceSlug={serviceSlug} op={op} targets={targets} inventory={inventory} />;
}

export default BulkRequestForm;
