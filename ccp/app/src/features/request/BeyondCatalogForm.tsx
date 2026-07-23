import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ChangeRequest, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { useSettings } from '@/lib/settings';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Button } from '@/components/ui/Button';
import { getCurrentUser } from '@/lib/session';
import type { CloudProvider } from '@/lib/providerDisplay';
import {
  beyondCatalogKindLabel,
  BEYOND_CATALOG_MAX_SUMMARY,
  CONNECTIVITY_LABEL,
  CONNECTIVITY_OPTIONS,
  DATA_CLASSIFICATIONS,
  DATA_CLASSIFICATION_LABEL,
  SIZING_UNITS,
  SIZING_UNIT_LABEL,
  catalogedRedirect,
  isBeyondCatalogRequest,
  submitBeyondCatalogRequest,
  validateBeyondCatalogInput,
  type BeyondCatalogInput,
  type BeyondKind,
  type CatalogedRedirect,
  type Connectivity,
  type DataClassification,
  type SizingUnit,
  type TechnologyChooserGroup,
} from '@/lib/beyondCatalog';
import { loadProviderIndex, type CatalogIndex } from '@/lib/providerCatalog';
import { getInstanceIdentity } from '@/lib/instanceIdentity';
import { ProvisionCatalog } from './ProvisionCatalog';
import { ErrorSummary, type ErrorSummaryItem } from './ErrorSummary';
import './request.css';

const KIND_OPTIONS: BeyondKind[] = ['new_resource_uncatalogued', 'enable_new_service'];

const FIELD_LABEL: Record<string, string> = {
  kind: 'Kind',
  service: 'Service',
  resourceType: 'Resource type',
  workload: 'Workload',
  sizingCapacity: 'Capacity',
  sizingUnit: 'Capacity unit',
  instanceCount: 'Instance count',
  connectivity: 'Connectivity',
  dataClassification: 'Data classification',
  neededBy: 'Needed by',
  summary: 'Summary',
  justification: 'Justification',
};

/**
 * STEP 1 — the technology chooser: one card per provision create
 * baseline, grouped by category, each routing into the REAL form (the same
 * RequestForm engine — no second form). The tail entry is the last card.
 * Exported for render-shape tests (renderToStaticMarkup under MemoryRouter).
 */
export function TechnologyChooserStep({
  groups,
  onPickTail,
}: {
  groups: TechnologyChooserGroup[];
  onPickTail: () => void;
}): JSX.Element {
  return (
    <div className="bc-chooser">
      <p className="rq-desc">
        Pick the technology you need — each card opens the full request form with every parameter an
        engineer needs, already bounded for this estate. Only something {getInstanceIdentity().name} has no form for yet
        goes through the describe-it route at the bottom.
      </p>
      {groups.map((group) => (
        <section key={group.category} className="bc-chooser__section">
          <h2 className="bc-chooser__category">{group.category}</h2>
          <div className="console__add-grid">
            {group.choices.map(({ service, displayName, op }) => (
              <Link
                key={op.id}
                className="console__add-card"
                to={`/services/${service}/${op.id}`}
              >
                <span className="console__add-glyph" aria-hidden="true">
                  +
                </span>
                <span className="console__add-body">
                  <span className="console__add-title">{op.title}</span>
                  <span className="console__add-desc">{displayName}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <section className="bc-chooser__section">
        <h2 className="bc-chooser__category">Anything else</h2>
        <button type="button" className="console__add-card bc-chooser__tail" onClick={onPickTail}>
          <span className="console__add-glyph" aria-hidden="true">
            ?
          </span>
          <span className="console__add-body">
            <span className="console__add-title">Something {getInstanceIdentity().name} doesn’t offer yet</span>
            <span className="console__add-desc">
              Describe the technology in a structured request — it routes to an engineer with the
              same approvals as everything else.
            </span>
          </span>
        </button>
      </section>
    </div>
  );
}

/**
 * The non-blocking redirect banner (routing rule): the typed service
 * slug matches a cataloged service, so the baseline is one click away. Never a
 * gate — the tail submission stays possible underneath it.
 */
export function CatalogedRedirectBanner({ redirect }: { redirect: CatalogedRedirect | null }): JSX.Element | null {
  if (!redirect) return null;
  const first = redirect.ops[0];
  return (
    <div className="bc-redirect" role="note">
      <p className="bc-redirect__text">
        <strong>{redirect.displayName}</strong> is already cataloged
        {first ? (
          <>
            {' '}
            — the “{first.title}” form asks everything an engineer needs.{' '}
            <Link to={`/services/${redirect.service}/${first.id}`}>Use the {redirect.displayName} form</Link>
          </>
        ) : (
          <>
            {' '}
            — its actions live on the service page.{' '}
            <Link to={`/services/${redirect.service}`}>Open {redirect.displayName}</Link>
          </>
        )}
        . You can still submit here if this is genuinely something else.
      </p>
    </div>
  );
}

/** Tail-field prefill from an earlier beyond-catalog request ("Request again"):
 * copies the structured params — never the justification, which a
 * fresh submission must re-argue. Exported for unit tests. */
export function tailPrefillFrom(request: ChangeRequest): Partial<TailState> | null {
  if (!isBeyondCatalogRequest(request)) return null;
  const p = request.params;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
  return {
    kind: p.kind === 'enable_new_service' ? 'enable_new_service' : 'new_resource_uncatalogued',
    service: request.service,
    resourceType: str(p.resourceType),
    workload: str(p.workload),
    sizingCapacity: num(p.sizingCapacity),
    sizingUnit: (SIZING_UNITS as readonly string[]).includes(String(p.sizingUnit))
      ? (p.sizingUnit as SizingUnit)
      : '',
    instanceCount: num(p.instanceCount),
    connectivity: (CONNECTIVITY_OPTIONS as readonly string[]).includes(String(p.connectivity))
      ? (p.connectivity as Connectivity)
      : 'unknown',
    dataClassification: (DATA_CLASSIFICATIONS as readonly string[]).includes(String(p.dataClassification))
      ? (p.dataClassification as DataClassification)
      : '',
    neededBy: str(p.neededBy),
    summary: str(p.summary),
  };
}

/** The tail form's controlled-input state (strings for the number inputs —
 * parsed at the BeyondCatalogInput boundary). */
export interface TailState {
  kind: BeyondKind;
  service: string;
  resourceType: string;
  workload: string;
  sizingCapacity: string;
  sizingUnit: SizingUnit | '';
  instanceCount: string;
  connectivity: Connectivity;
  dataClassification: DataClassification | '';
  neededBy: string;
  summary: string;
}

const EMPTY_TAIL: TailState = {
  kind: 'new_resource_uncatalogued',
  service: '',
  resourceType: '',
  workload: '',
  sizingCapacity: '',
  sizingUnit: '',
  instanceCount: '',
  connectivity: 'unknown',
  dataClassification: '',
  neededBy: '',
  summary: '',
};

/**
 * "Request something new" v2 — elaboration, not a
 * suggestion box. STEP 1 is a technology chooser over the catalog's own
 * provision baselines (a cataloged technology routes into its real form);
 * the structured tail (STEP 2b) survives ONLY for uncataloged technology,
 * and even there it captures workload/sizing/connectivity/classification/
 * needed-by as bounded controls, so L2 reviews a spec sheet. The form is
 * never a submission gate — it always flows to submitBeyondCatalogRequest
 * (→ api.submitRequest, unchanged) at engineer_only/HIGH; the only checks in
 * front of it are the change freeze and the per-user open-request cap.
 */
export function BeyondCatalogForm(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const from = searchParams.get('from') ?? undefined;

  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  // The provider catalog index — every AWS service the pinned Terraform
  // provider supports. Its own lazy chunk; loaded once for the chooser.
  const [providerIndex, setProviderIndex] = useState<CatalogIndex | null>(null);
  // "Request again": arriving with ?from=<id> jumps straight to the tail
  // pre-filled from that request — otherwise the chooser is the front door.
  const [mode, setMode] = useState<'choose' | 'tail'>(from ? 'tail' : 'choose');
  const [tail, setTail] = useState<TailState>(EMPTY_TAIL);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [revealErrors, setRevealErrors] = useState(false);
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const projectId = useActiveProjectId();
  // 0039 S1 lane C: the active project's cloud provider. ProjectConfig now
  // carries an optional `provider` field (types/project.ts) that is
  // DELIBERATELY never default-filled there — absent means the honest
  // current reality (an aws project, matching the api's own wire convention),
  // read here rather than guessed at an unknown provider.
  const project = useProject();
  const provider: CloudProvider = project.provider ?? 'aws';
  // LD-4: the live (subscribed) freeze signal — same store every other
  // submit surface reads (lib/settings.ts). This form has no Review step of
  // its own to reveal it at the last moment; the notice below sits at the
  // top of the structured tail so the freeze is known before the operator
  // fills ten-plus fields, not after. submitBeyondCatalogRequest still
  // re-checks at submit time (unchanged) — this is upstream visibility only.
  const frozen = useSettings().changeFreeze;

  useEffect(() => {
    let alive = true;
    void api.listManifests().then((m) => {
      if (alive) setManifests(m);
    });
    void loadProviderIndex(provider).then((idx) => {
      if (alive) setProviderIndex(idx);
    });
    return () => {
      alive = false;
    };
  }, [projectId, provider]);

  useEffect(() => {
    if (!from) return;
    let alive = true;
    void api.getRequest(from).then((request) => {
      if (!alive || !request) return;
      const prefill = tailPrefillFrom(request);
      if (!prefill) return;
      setTail((t) => ({ ...t, ...prefill }));
      setPrefilledFrom(request.id);
      setMode('tail');
    });
    return () => {
      alive = false;
    };
  }, [from, projectId]);

  const input: BeyondCatalogInput = useMemo(
    () => ({
      kind: tail.kind,
      service: tail.service.trim(),
      resourceType: tail.resourceType.trim() || undefined,
      workload: tail.workload,
      sizingCapacity: tail.sizingCapacity.trim() === '' ? undefined : Number(tail.sizingCapacity),
      sizingUnit: tail.sizingUnit === '' ? undefined : tail.sizingUnit,
      instanceCount: tail.instanceCount.trim() === '' ? undefined : Number(tail.instanceCount),
      connectivity: tail.connectivity,
      // '' (no choice yet) fails validation on purpose — classification has no default.
      dataClassification: tail.dataClassification as DataClassification,
      neededBy: tail.neededBy.trim() || undefined,
      summary: tail.summary,
      justification,
    }),
    [tail, justification],
  );

  const errors = useMemo(
    () => validateBeyondCatalogInput(input, undefined, provider),
    [input, provider],
  );
  const redirect = useMemo(
    () => catalogedRedirect(tail.service, manifests),
    [tail.service, manifests],
  );

  const set = <K extends keyof TailState>(name: K, value: TailState[K]): void =>
    setTail((t) => ({ ...t, [name]: value }));
  const onBlur = (name: string): void => setTouched((t) => ({ ...t, [name]: true }));
  const showError = (name: string): boolean => Boolean((revealErrors || touched[name]) && errors[name]);

  const errorItems: ErrorSummaryItem[] = Object.entries(errors).map(([name, message]) => ({
    name,
    label: FIELD_LABEL[name] ?? name,
    message,
  }));

  const onSubmit = (): void => {
    if (Object.keys(errors).length > 0) {
      setRevealErrors(true);
      const all: Record<string, boolean> = {};
      for (const name of Object.keys(FIELD_LABEL)) all[name] = true;
      setTouched(all);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    void submitBeyondCatalogRequest(input, getCurrentUser().id, api, provider).then((result) => {
      if (!result.ok) {
        setSubmitting(false);
        setSubmitError(result.reason);
        return;
      }
      navigate(`/requests/${result.request.id}`);
    });
  };

  if (mode === 'choose') {
    // The SERVICE-CENTRIC catalog: every AWS service the provider supports,
    // one provision entry each. The op-level TechnologyChooserStep it
    // replaces still exists (exported below) — its create baselines now
    // surface inside each service's provision page instead.
    return (
      <div className="rq">
        <Breadcrumbs items={[{ label: 'Catalog', to: '/' }, { label: 'Request something new' }]} />
        <h1 className="rq-title">What do you need?</h1>
        <ProvisionCatalog index={providerIndex} onPickTail={() => setMode('tail')} />
      </div>
    );
  }

  return (
    <div className="rq">
      <Breadcrumbs items={[{ label: 'Catalog', to: '/' }, { label: 'Request something new' }]} />

      <h1 className="rq-title">Request something new</h1>
      <p className="rq-desc">
        Describe the technology {getInstanceIdentity().name} doesn’t offer yet — structured, so an engineer starts from a
        specification, not from zero. It routes to an engineer with the same approvals as everything
        else; no Terraform is generated here.
      </p>
      <p className="rq-desc">
        <button type="button" className="bc-back" onClick={() => setMode('choose')}>
          ← Back to the technology list
        </button>
      </p>

      <div className="rq-main">
        {frozen && (
          <p className="bc-frozen-notice" role="note">
            Change requests are frozen by an administrator right now. You can still fill this
            out, but it won’t submit until the freeze is lifted.
          </p>
        )}

        {prefilledFrom && (
          <p className="bc-prefill" role="note">
            Values copied from your earlier request — review them before submitting. The
            justification starts fresh.
          </p>
        )}

        {errorItems.length > 0 && revealErrors && <ErrorSummary ref={errorRef} items={errorItems} />}

        {submitError && (
          <p className="rq-field__error" role="alert">
            {submitError}
          </p>
        )}

        <div className="rq-field">
          <span className="rq-field__label" id="field-kind-label">
            What kind of request is this? <span className="rq-field__req">*</span>
          </span>
          <div className="rq-field__radios" role="radiogroup" aria-labelledby="field-kind-label">
            {KIND_OPTIONS.map((k) => (
              <label key={k} className="rq-field__radio">
                <input
                  type="radio"
                  name="beyond-catalog-kind"
                  value={k}
                  checked={tail.kind === k}
                  onChange={() => set('kind', k)}
                  onBlur={() => onBlur('kind')}
                />
                <span>{beyondCatalogKindLabel(k)}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-service">
            Service <span className="rq-field__req">*</span>
          </label>
          <input
            id="field-service"
            className="rq-field__input"
            type="text"
            value={tail.service}
            aria-invalid={showError('service')}
            aria-describedby={showError('service') ? 'field-service-error' : 'field-service-help'}
            onChange={(e) => set('service', e.target.value)}
            onBlur={() => onBlur('service')}
            placeholder="e.g. redshift"
          />
          <p id="field-service-help" className="rq-field__help">
            A short lowercase slug for the AWS service — letters, numbers, and hyphens only.
          </p>
          {showError('service') && (
            <p id="field-service-error" className="rq-field__error" role="alert">
              {errors.service}
            </p>
          )}
        </div>

        <CatalogedRedirectBanner redirect={redirect} />

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-resource-type">
            Resource type <span className="rq-field__optional">(optional)</span>
          </label>
          <input
            id="field-resource-type"
            className="rq-field__input"
            type="text"
            value={tail.resourceType}
            aria-invalid={showError('resourceType')}
            aria-describedby={
              showError('resourceType') ? 'field-resource-type-error' : 'field-resource-type-help'
            }
            onChange={(e) => set('resourceType', e.target.value)}
            onBlur={() => onBlur('resourceType')}
            placeholder="e.g. aws_redshift_cluster"
          />
          <p id="field-resource-type-help" className="rq-field__help">
            The Terraform resource type, if you already know it.
          </p>
          {showError('resourceType') && (
            <p id="field-resource-type-error" className="rq-field__error" role="alert">
              {errors.resourceType}
            </p>
          )}
        </div>

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-workload">
            What runs on it? <span className="rq-field__req">*</span>
          </label>
          <textarea
            id="field-workload"
            className="rq-field__textarea"
            rows={2}
            value={tail.workload}
            aria-invalid={showError('workload')}
            aria-describedby={showError('workload') ? 'field-workload-error' : 'field-workload-help'}
            onChange={(e) => set('workload', e.target.value)}
            onBlur={() => onBlur('workload')}
          />
          <p id="field-workload-help" className="rq-field__help">
            The application or job this serves, in 10–500 characters.
          </p>
          {showError('workload') && (
            <p id="field-workload-error" className="rq-field__error" role="alert">
              {errors.workload}
            </p>
          )}
        </div>

        <fieldset className="rq-field bc-sizing">
          <legend className="rq-field__label">
            Sizing <span className="rq-field__optional">(optional — numbers, not prose)</span>
          </legend>
          <div className="bc-sizing__row">
            <label className="bc-sizing__cell">
              <span className="rq-field__help">Capacity</span>
              <input
                className="rq-field__input"
                type="number"
                min={1}
                value={tail.sizingCapacity}
                aria-invalid={showError('sizingCapacity')}
                onChange={(e) => set('sizingCapacity', e.target.value)}
                onBlur={() => onBlur('sizingCapacity')}
              />
            </label>
            <label className="bc-sizing__cell">
              <span className="rq-field__help">Measured in</span>
              <select
                className="rq-field__input"
                value={tail.sizingUnit}
                aria-invalid={showError('sizingUnit')}
                onChange={(e) => set('sizingUnit', e.target.value as SizingUnit | '')}
                onBlur={() => onBlur('sizingUnit')}
              >
                <option value="">Choose…</option>
                {SIZING_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {SIZING_UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
            </label>
            <label className="bc-sizing__cell">
              <span className="rq-field__help">How many instances</span>
              <input
                className="rq-field__input"
                type="number"
                min={1}
                max={100}
                value={tail.instanceCount}
                aria-invalid={showError('instanceCount')}
                onChange={(e) => set('instanceCount', e.target.value)}
                onBlur={() => onBlur('instanceCount')}
              />
            </label>
          </div>
          {(showError('sizingCapacity') || showError('sizingUnit') || showError('instanceCount')) && (
            <p className="rq-field__error" role="alert">
              {errors.sizingCapacity ?? errors.sizingUnit ?? errors.instanceCount}
            </p>
          )}
        </fieldset>

        <div className="rq-field">
          <span className="rq-field__label" id="field-connectivity-label">
            How is it reached? <span className="rq-field__req">*</span>
          </span>
          <div className="rq-field__radios" role="radiogroup" aria-labelledby="field-connectivity-label">
            {CONNECTIVITY_OPTIONS.map((c) => (
              <label key={c} className="rq-field__radio">
                <input
                  type="radio"
                  name="beyond-catalog-connectivity"
                  value={c}
                  checked={tail.connectivity === c}
                  onChange={() => set('connectivity', c)}
                  onBlur={() => onBlur('connectivity')}
                />
                <span>{CONNECTIVITY_LABEL[c]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rq-field">
          <span className="rq-field__label" id="field-classification-label">
            What kind of data will it hold? <span className="rq-field__req">*</span>
          </span>
          <div
            className="rq-field__radios"
            role="radiogroup"
            aria-labelledby="field-classification-label"
          >
            {DATA_CLASSIFICATIONS.map((d) => (
              <label key={d} className="rq-field__radio">
                <input
                  type="radio"
                  name="beyond-catalog-classification"
                  value={d}
                  checked={tail.dataClassification === d}
                  onChange={() => set('dataClassification', d)}
                  onBlur={() => onBlur('dataClassification')}
                />
                <span>{DATA_CLASSIFICATION_LABEL[d]}</span>
              </label>
            ))}
          </div>
          <p className="rq-field__help">
            A reviewer uses this to route the security questions now, not at review time.
          </p>
          {showError('dataClassification') && (
            <p className="rq-field__error" role="alert">
              {errors.dataClassification}
            </p>
          )}
        </div>

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-needed-by">
            Needed by <span className="rq-field__optional">(optional)</span>
          </label>
          <input
            id="field-needed-by"
            className="rq-field__input"
            type="date"
            value={tail.neededBy}
            aria-invalid={showError('neededBy')}
            aria-describedby={showError('neededBy') ? 'field-needed-by-error' : undefined}
            onChange={(e) => set('neededBy', e.target.value)}
            onBlur={() => onBlur('neededBy')}
          />
          {showError('neededBy') && (
            <p id="field-needed-by-error" className="rq-field__error" role="alert">
              {errors.neededBy}
            </p>
          )}
        </div>

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-summary">
            What do you need? <span className="rq-field__req">*</span>
          </label>
          <textarea
            id="field-summary"
            className="rq-field__textarea"
            rows={5}
            value={tail.summary}
            aria-invalid={showError('summary')}
            aria-describedby={showError('summary') ? 'field-summary-error' : 'field-summary-help'}
            onChange={(e) => set('summary', e.target.value)}
            onBlur={() => onBlur('summary')}
          />
          <p id="field-summary-help" className="rq-field__help">
            10–{BEYOND_CATALOG_MAX_SUMMARY.toLocaleString('en-US')} characters — room to specify the
            whole thing, not a headline.
          </p>
          {showError('summary') && (
            <p id="field-summary-error" className="rq-field__error" role="alert">
              {errors.summary}
            </p>
          )}
        </div>

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-justification">
            Why is this needed? <span className="rq-field__req">*</span>
          </label>
          <textarea
            id="field-justification"
            className="rq-field__textarea"
            rows={3}
            value={justification}
            aria-invalid={showError('justification')}
            aria-describedby={
              showError('justification') ? 'field-justification-error' : 'field-justification-help'
            }
            onChange={(e) => setJustification(e.target.value)}
            onBlur={() => onBlur('justification')}
          />
          <p id="field-justification-help" className="rq-field__help">
            Recorded on the request — at least 20 characters.
          </p>
          {showError('justification') && (
            <p id="field-justification-error" className="rq-field__error" role="alert">
              {errors.justification}
            </p>
          )}
        </div>

        <div className="rq-submitbar">
          <Button variant="primary" disabled={submitting} onClick={onSubmit}>
            {submitting ? 'Submitting…' : 'Submit to an engineer'}
          </Button>
          <Link to="/" className="rq-cancel">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}

export default BeyondCatalogForm;
