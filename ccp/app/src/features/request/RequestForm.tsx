import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ChangeRequest, Inventory, ManifestOperation, Schedule, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { isChangeFrozen, isOpDisabled, useSettings } from '@/lib/settings';
import { buildRequestDraft, getOperation, validateParams } from '@/lib/interpreter';
import { reusableParams } from '@/lib/requestAgain';
import { deriveFormPlan } from '@/lib/catalog';
import { getServiceMeta } from '@/lib/serviceMeta';
import { getCurrentUser } from '@/lib/session';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Button } from '@/components/ui/Button';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { resolveRisk } from '@/lib/riskOverrides';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { OpDescription } from '@/components/OpDescription';
import { opHeadline } from '@/lib/opText';
import { ImpactPanel } from './ImpactPanel';
import { ReviewStep } from './ReviewStep';
import { ErrorSummary, type ErrorSummaryItem } from './ErrorSummary';
import { SgCurrentRules } from './SgCurrentRules';
import './request.css';

type Step = 'configure' | 'review';

const MIN_JUSTIFICATION = 10;

/**
 * Seed a form's values: manifest defaults, plus the target resource — from the
 * `?target=<address>` query when the requester came from the service console, or
 * the lone eligible resource when there is only one.
 */
function seedValues(
  op: ManifestOperation,
  inventory: Inventory,
  target: string | undefined,
): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const p of op.params) {
    // role:"const" params are implied constants the executor writes straight
    // from the manifest (p.const) — never a user input, so never seeded into the
    // editable form state (see isConstParam below).
    if (isConstParam(p)) continue;
    if (p.default !== undefined) init[p.name] = p.default;
    if (p.source === 'inventory') {
      if (target) {
        init[p.name] = target;
      } else {
        const eligible = inventory.resources.filter((r) => r.resourceType === op.target.resourceType);
        const only = eligible[0];
        if (eligible.length === 1 && only) init[p.name] = only.address;
      }
    }
  }
  return init;
}

/** role:"const" params carry no request input — the executor writes their
 * manifest-fixed value directly, so the portal must never render a field for one
 * or include it in a submitted request. */
function isConstParam(p: { role?: string }): boolean {
  return p.role === 'const';
}

/**
 * The request form — one concrete operation on one service, reached from the
 * service console (optionally pre-targeted). A two-step local machine: Configure
 * the manifest-driven form + a justification, then Review the plain summary and
 * the generated Terraform, choose a schedule, and submit. Any severity is
 * requestable; nothing applies without a human approval.
 */
export function RequestForm(): JSX.Element {
  const { service, operationId } = useParams();
  const [searchParams] = useSearchParams();
  const target = searchParams.get('target') ?? undefined;
  // "Request again": `?from=<requestId>` pre-seeds the form from an
  // earlier request's params. Only the params carry over — and they flow
  // through the SAME live validateParams as typed values, so anything the
  // current manifest no longer allows is flagged, never smuggled past.
  const from = searchParams.get('from') ?? undefined;
  const navigate = useNavigate();

  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fromRequest, setFromRequest] = useState<ChangeRequest | undefined>(undefined);
  const [fromLoaded, setFromLoaded] = useState(!from);

  const [step, setStep] = useState<Step>('configure');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [justification, setJustification] = useState('');
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'now' });
  // Forces-replace confirmed-override: the typed resource name (empty until the requester
  // confirms on the review page). Only set on the draft for a forces-replace op.
  const [replaceConfirmation, setReplaceConfirmation] = useState('');
  const [revealErrors, setRevealErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  // Live settings — dims the Review step's submit control the
  // moment an admin freezes changes or disables this op (this tab or
  // another), even before the requester has attempted to submit once
  // (blockedReason above only ever gets set AFTER a failed attempt). The
  // submit-time re-check in onSubmit below is unchanged and stays the
  // actual authority — this is a proactive, honest preview of that same gate.
  const settings = useSettings();

  const errorRef = useRef<HTMLDivElement>(null);
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

  // Resolve the "Request again" source, when one is named. A missing id just
  // leaves the form default-seeded — degrade, don't dead-end.
  useEffect(() => {
    let alive = true;
    setFromRequest(undefined);
    setFromLoaded(!from);
    if (!from) return;
    void api.getRequest(from).then((r) => {
      if (!alive) return;
      setFromRequest(r);
      setFromLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [from, projectId]);

  const op: ManifestOperation | undefined = useMemo(
    () => (operationId ? getOperation(operationId, manifests) : undefined),
    [operationId, manifests],
  );

  // The params carried over from the earlier request: only for the SAME
  // operation (a hand-edited `from` pointing elsewhere seeds nothing), only
  // params the CURRENT manifest still declares, never const params.
  const reuse = useMemo(
    () => (op && fromRequest ? reusableParams(op, fromRequest) : {}),
    [op, fromRequest],
  );
  const reused = Object.keys(reuse).length > 0;

  // Enter / route change / target change: seed the form once (waiting for the
  // request-again source when one is named, so its params land in this seed).
  useEffect(() => {
    if (!op || !inventory || !fromLoaded) return;
    setValues({ ...seedValues(op, inventory, target), ...reuse });
    setTouched({});
    setJustification(''); // never carried over — a fresh request re-argues itself
    setSchedule({ kind: 'now' });
    setReplaceConfirmation(''); // the destroy+recreate confirmation is never pre-filled
    setRevealErrors(false);
    setStep('configure');
  }, [op, inventory, target, fromLoaded, reuse]);

  const validation = useMemo(
    () => (op && inventory ? validateParams(op, values, inventory) : { ok: false, errors: {} }),
    [op, inventory, values],
  );

  const targetAddress = useMemo(() => {
    if (!op) return '';
    const targetParam = op.params.find((p) => p.source === 'inventory');
    return targetParam ? String(values[targetParam.name] ?? '') : '';
  }, [op, values]);

  if (!loaded) {
    return (
      <div className="rq">
        <p className="rq-loading">Loading…</p>
      </div>
    );
  }

  const serviceSlug = service ?? op?.service ?? '';
  const meta = getServiceMeta(serviceSlug);

  if (!inventory || !op) {
    return (
      <div className="rq">
        <Breadcrumbs
          items={[
            { label: 'Catalog', to: '/' },
            { label: meta.displayName, to: '/services/' + serviceSlug },
            { label: 'Not found' },
          ]}
        />
        <div className="rq-notfound">
          <h1 className="rq-notfound__title">Nothing to configure</h1>
          <p>
            No operation <code>{operationId}</code> is available on <code>{serviceSlug}</code>.
          </p>
          <Link to={'/services/' + serviceSlug} className="rq-cancel">
            Back to {meta.displayName}
          </Link>
        </div>
      </div>
    );
  }

  const plan = deriveFormPlan(op);

  // role:"const" params are implied constants — there is nothing for the
  // requester to choose, so SchemaForm must never render a field for one (and,
  // per seedValues above, `values` never carries one to submit either).
  const visibleSections = plan.sections
    .map((section) => ({ ...section, fields: section.fields.filter((f) => !isConstParam(f)) }))
    .filter((section) => section.fields.length > 0);

  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;
  const justificationError = justificationTooShort
    ? 'Enter a justification (at least 10 characters).'
    : '';

  const errorItems: ErrorSummaryItem[] = [];
  for (const p of op.params) {
    const msg = validation.errors[p.name];
    if (msg) errorItems.push({ name: p.name, label: p.label, message: msg });
  }
  if (justificationTooShort) {
    errorItems.push({ name: 'justification', label: 'Justification', message: justificationError });
  }

  const onChange = (name: string, value: unknown): void =>
    setValues((v) => ({ ...v, [name]: value }));

  const onBlur = (name: string): void => setTouched((t) => ({ ...t, [name]: true }));

  const onReview = (): void => {
    if (!validation.ok || justificationTooShort) {
      setRevealErrors(true);
      const allTouched: Record<string, boolean> = { justification: true };
      for (const p of op.params) allTouched[p.name] = true;
      setTouched(allTouched);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setStep('review');
    window.scrollTo({ top: 0 });
  };

  const onSubmit = (): void => {
    // Admin gates re-checked at submit. A real backend re-enforces both.
    if (isChangeFrozen()) {
      setBlockedReason(
        'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.',
      );
      return;
    }
    if (isOpDisabled(op.id)) {
      setBlockedReason('This operation has been disabled by an administrator.');
      return;
    }
    setSubmitting(true);
    const draft = buildRequestDraft(op, targetAddress, values, justification, getCurrentUser().id);
    draft.schedule = schedule;
    // Forces-replace ops carry the requester's typed confirmation (the review page blocks
    // submit until it matches targetAddress; the server re-checks and stores it). Trimmed so
    // the sent value equals targetAddress exactly — the server + executor compare strictly.
    if (op.forcesReplace) draft.replaceConfirmation = replaceConfirmation.trim();
    void api.submitRequest(draft).then((result) => {
      // submitRequest returns a SubmitResult: navigate on success, else surface
      // the server-side rejection reason inline (freeze / disabled op / bounds).
      if (result.ok) navigate('/requests/' + result.request.id);
      else {
        setSubmitting(false);
        setBlockedReason(result.reason);
      }
    });
  };

  const showJustificationError =
    (revealErrors || touched['justification']) && justificationTooShort;

  // The live (proactive) half of the same gate onSubmit re-checks at the
  // moment of the actual attempt — settings.changeFreeze/disabledOps
  // come from the one shared, subscribed snapshot, so this
  // reflects an admin action in another tab too, without navigation.
  const liveBlockedReason = settings.changeFreeze
    ? 'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.'
    : settings.disabledOps.includes(op.id)
      ? 'This operation has been disabled by an administrator.'
      : null;

  if (step === 'review') {
    return (
      <div className="rq">
        <Breadcrumbs
          items={[
            { label: 'Catalog', to: '/' },
            { label: meta.displayName, to: '/services/' + serviceSlug },
            { label: op.title },
          ]}
        />
        <ReviewStep
          op={op}
          values={values}
          inventory={inventory}
          justification={justification}
          targetAddress={targetAddress}
          submitting={submitting}
          blocked={blockedReason ?? liveBlockedReason ?? undefined}
          schedule={schedule}
          onScheduleChange={setSchedule}
          replaceConfirmation={replaceConfirmation}
          onReplaceConfirmationChange={setReplaceConfirmation}
          onEdit={() => setStep('configure')}
          onSubmit={onSubmit}
        />
      </div>
    );
  }

  return (
    <div className="rq">
      <Breadcrumbs
        items={[
          { label: 'Catalog', to: '/' },
          { label: meta.displayName, to: '/services/' + serviceSlug },
          { label: op.title },
        ]}
      />

      <h1 className="rq-title">{opHeadline(op)}</h1>
      <OpDescription op={op} variant="form" />

      <div className="rq-strip">
        <MacdTag macd={op.macd} />
        <RiskBadge risk={resolveRisk(op)} />
        <span className="rq-strip__fact">{op.reversible ? 'Reversible' : 'Irreversible'}</span>
        <span className="rq-strip__fact">
          {op.downtime === 'none' ? 'No downtime' : `${op.downtime} downtime`}
        </span>
        <AccessBadge exposure={op.exposure} />
      </div>

      {op.exposure === 'engineer_only' && (
        <p className="rq-note-engineer">
          This change is bounded for an engineer. You can still request it here — on submit it routes
          to an engineer to author and review the Terraform.
        </p>
      )}

      <div className="rq-grid">
        <div className="rq-main">
          {reused && (
            <p className="rq-refill" role="note">
              Values copied from your earlier request — anything the catalog no longer allows is
              flagged before you can submit. The justification starts fresh.
            </p>
          )}

          {errorItems.length > 0 && revealErrors && <ErrorSummary ref={errorRef} items={errorItems} />}

          <SchemaForm
            operationId={op.id}
            sections={visibleSections}
            inventory={inventory}
            values={values}
            errors={validation.errors}
            touched={touched}
            onChange={onChange}
            onBlur={onBlur}
          />

          <SgCurrentRules op={op} targetAddress={targetAddress} />

          <div className="rq-field">
            <label className="rq-field__label" htmlFor="field-justification">
              Why is this change needed? <span className="rq-field__req">*</span>
            </label>
            <textarea
              id="field-justification"
              className="rq-field__textarea"
              rows={3}
              value={justification}
              aria-invalid={showJustificationError}
              aria-describedby={
                showJustificationError ? 'field-justification-error' : 'field-justification-help'
              }
              onChange={(e) => setJustification(e.target.value)}
              onBlur={() => onBlur('justification')}
            />
            <p id="field-justification-help" className="rq-field__help">
              Recorded on the request and in the PR — at least 10 characters.
            </p>
            {showJustificationError && (
              <p id="field-justification-error" className="rq-field__error" role="alert">
                {justificationError}
              </p>
            )}
          </div>

          {plan.warnings.length > 0 && (
            <ul className="rq-warnings">
              {plan.warnings.map((w) => (
                <li key={w} className="rq-warnings__item">
                  <span aria-hidden="true">⚠</span> {w}
                </li>
              ))}
            </ul>
          )}

          <div className="rq-submitbar">
            <Button variant="primary" onClick={onReview}>
              Review request
            </Button>
            <Link to={'/services/' + serviceSlug} className="rq-cancel">
              Cancel
            </Link>
          </div>
        </div>

        <ImpactPanel op={op} values={values} inventory={inventory} />
      </div>
    </div>
  );
}
