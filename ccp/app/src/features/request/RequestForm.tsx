import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  ChangeRequest,
  Inventory,
  ManifestOperation,
  Schedule,
  ServiceManifest,
} from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { isChangeFrozen, isOpDisabled, useSettings } from '@/lib/settings';
import { buildRequestDraft, getOperation, validateParams } from '@/lib/interpreter';
import { reusableParams } from '@/lib/requestAgain';
import { deriveFormPlan } from '@/lib/catalog';
import { getServiceMeta } from '@/lib/serviceMeta';
import { getCurrentUser } from '@/lib/session';
import { attempt } from '@/lib/asyncGuard';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { LoadError } from '@/components/LoadError';
import { submitRequestVia } from './submitFlow';
import { activeRefusal, draftKey, type DraftRefusal } from './refusalFlow';
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
        const eligible = inventory.resources.filter(
          (r) => r.resourceType === op.target.resourceType,
        );
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
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by the retry control — re-keys both load effects (FE-2 / UI-1).
  const [reloadToken, setReloadToken] = useState(0);
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
  // A server REFUSAL of THIS draft, stored WITH the state it judged (FE-3).
  //
  // Blocking on it is right — the server decided, and re-sending an identical draft would
  // only be refused again. The bug was that nothing ever cleared it, so the verdict
  // outlived what it judged: an OUT_OF_BOUNDS refusal survived the requester going back,
  // fixing the parameter and returning, leaving the button dead over a value no longer in
  // the form — and the only escape, leaving the route, discards the whole draft.
  //
  // It is not cleared, it EXPIRES: `activeRefusal` yields it only while the draft (and the
  // live settings it may have been about) still match. Clearing was never an action anyone
  // took, which is exactly why it never happened; being out of date is a consequence of
  // editing, so the rule belongs in the derivation. See features/request/refusalFlow.ts.
  const [refusal, setRefusal] = useState<DraftRefusal | null>(null);
  // A submit that never reached the server (FE-1). Kept SEPARATE from
  // the refusal above on purpose: that one is a server REFUSAL and correctly
  // disables the button, whereas this one means nothing was decided at all,
  // so the button must stay live for the retry.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Live settings — dims the Review step's submit control the
  // moment an admin freezes changes or disables this op (this tab or
  // another), even before the requester has attempted to submit once
  // (the refusal above only ever gets set AFTER a failed attempt). The
  // submit-time re-check in onSubmit below is unchanged and stays the
  // actual authority — this is a proactive, honest preview of that same gate.
  const settings = useSettings();

  const errorRef = useRef<HTMLDivElement>(null);
  // UI-12: the target for the focus move on a step transition — each is only
  // ever mounted for its own step, so there is no ambiguity about which one
  // is in the DOM when its `.focus()` call runs.
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const configureHeadingRef = useRef<HTMLHeadingElement>(null);
  const projectId = useActiveProjectId();

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void attempt(() => Promise.all([api.listManifests(), api.getInventory()])).then((outcome) => {
      if (!alive) return;
      if (!outcome.ok) {
        // FE-2/UI-1: `loaded` stays false but the page no longer renders a
        // bare "Loading…" — it says what failed and offers the retry.
        setLoadError(outcome.reason);
        return;
      }
      const [m, inv] = outcome.value;
      setManifests(m);
      setInventory(inv);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [projectId, reloadToken]);

  // Resolve the "Request again" source, when one is named. A missing id just
  // leaves the form default-seeded — degrade, don't dead-end. A FAILED fetch
  // must degrade the same way (FE-2): before this, a rejected getRequest left
  // `fromLoaded` false for ever, so the seed effect below never ran and the
  // form rendered permanently unseeded with no explanation.
  useEffect(() => {
    let alive = true;
    setFromRequest(undefined);
    setFromLoaded(!from);
    if (!from) return;
    void attempt(() => api.getRequest(from)).then((outcome) => {
      if (!alive) return;
      if (outcome.ok) setFromRequest(outcome.value);
      setFromLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [from, projectId, reloadToken]);

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
    setRefusal(null); // a different draft entirely — the old verdict cannot apply
    setSubmitting(false); // and it is certainly not still in flight
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

  if (loadError !== null) {
    return (
      <div className="rq">
        <LoadError
          message={loadError}
          what="this form"
          onRetry={() => setReloadToken((n) => n + 1)}
        />
      </div>
    );
  }

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
    // UI-12: a successful "Review request" swaps the whole page content —
    // without this, keyboard focus dies on the unmounted button (falls back
    // to <body>) and nothing tells assistive tech the step changed. rAF
    // (same technique the invalid path above already uses for errorRef)
    // waits for the Review markup to actually be in the DOM before focusing it.
    requestAnimationFrame(() => reviewHeadingRef.current?.focus());
  };

  const onBackToEdit = (): void => {
    setStep('configure');
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => configureHeadingRef.current?.focus());
  };

  // The identity of the state the server is being asked to judge. Recomputed on every
  // render — cheap, and it must never lag the draft it describes, or a refusal would go
  // on blocking an edit the requester has already made (FE-3).
  const currentDraftKey = draftKey({
    values,
    schedule,
    justification,
    replaceConfirmation,
    settings,
  });

  /** Pair a refusal with the draft it is a verdict about, so it can expire on its own. */
  const refuse = (reason: string): DraftRefusal => ({ reason, forKey: currentDraftKey });

  const onSubmit = (): void => {
    // Admin gates re-checked at submit. A real backend re-enforces both.
    if (isChangeFrozen()) {
      setRefusal(
        refuse(
          'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.',
        ),
      );
      return;
    }
    if (isOpDisabled(op.id)) {
      setRefusal(refuse('This operation has been disabled by an administrator.'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const draft = buildRequestDraft(op, targetAddress, values, justification, getCurrentUser().id);
    draft.schedule = schedule;
    // Forces-replace ops carry the requester's typed confirmation (the review page blocks
    // submit until it matches targetAddress; the server re-checks and stores it). Trimmed so
    // the sent value equals targetAddress exactly — the server + executor compare strictly.
    if (op.forcesReplace) draft.replaceConfirmation = replaceConfirmation.trim();
    // submitRequestVia navigates on success and NEVER rejects: a dropped
    // connection comes back as code:'UNREACHABLE' instead of killing this
    // handler and stranding `submitting` for ever (FE-1).
    void submitRequestVia(api, (path) => navigate(path), draft).then((result) => {
      if (result.ok) return; // already navigated
      setSubmitting(false);
      // A server REFUSAL (freeze / disabled op / bounds) is final for this
      // draft and keeps disabling submit. A never-reached server is not a
      // refusal — nothing was created — so it goes to the retryable slot.
      if (result.code === 'UNREACHABLE') setSubmitError(result.reason);
      else setRefusal(refuse(result.reason));
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
          blocked={activeRefusal(refusal, currentDraftKey) ?? liveBlockedReason ?? undefined}
          submitError={submitError ?? undefined}
          schedule={schedule}
          onScheduleChange={setSchedule}
          replaceConfirmation={replaceConfirmation}
          onReplaceConfirmationChange={setReplaceConfirmation}
          onEdit={onBackToEdit}
          onSubmit={onSubmit}
          headingRef={reviewHeadingRef}
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

      <h1 className="rq-title" ref={configureHeadingRef} tabIndex={-1}>
        {opHeadline(op)}
      </h1>
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
          This change is bounded for an engineer. You can still request it here — on submit it
          routes to an engineer to author and review the Terraform.
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

          {errorItems.length > 0 && revealErrors && (
            <ErrorSummary ref={errorRef} items={errorItems} />
          )}

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
