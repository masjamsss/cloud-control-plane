import type { JSX } from 'react';
import type { ManifestOperation, ManifestParam } from '@/types';
import { GLOSSARY, termsInText } from '@/lib/glossary';
import './change-annotations.css';

/** The real Terraform attribute a param maps to (strip the new_/target_ prefix). */
function attrOf(param: ManifestParam): string {
  return param.name.replace(/^new_/, '').replace(/^target_/, '');
}

/** A human description of a param's bounds — what values are safe and why. */
function boundsNote(param: ManifestParam): string | null {
  const b = param.bounds;
  if (!b) return null;
  const parts: string[] = [];
  if (b.allowlist && b.allowlist.length > 0) {
    parts.push(`Allowed: ${b.allowlist.join(', ')}`);
  }
  if (b.growOnly) parts.push('Can only increase (grow-only)');
  if (typeof b.min === 'number' || typeof b.max === 'number') {
    if (typeof b.min === 'number' && typeof b.max === 'number') parts.push(`Between ${b.min} and ${b.max}`);
    else if (typeof b.min === 'number') parts.push(`At least ${b.min}`);
    else parts.push(`At most ${b.max}`);
  }
  if (typeof b.maxLength === 'number') parts.push(`Up to ${b.maxLength} characters`);
  if (b.pattern) parts.push(`Must match ${b.pattern}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The teaching rail. For each attribute this change touches,
 * show what it is (from the manifest help) and its safe bounds; then a short
 * glossary of the Terraform terms in the generated diff. Deterministic, no AI.
 */
export function ChangeAnnotations({
  op,
  values,
  diff,
}: {
  op: ManifestOperation;
  values: Record<string, unknown>;
  diff: string;
}): JSX.Element | null {
  const changed = op.params.filter(
    (p) => p.source !== 'inventory' && values[p.name] !== undefined && values[p.name] !== '',
  );
  const terms = termsInText(diff).filter((t) => !changed.some((p) => attrOf(p) === t));

  if (changed.length === 0 && terms.length === 0) return null;

  return (
    <div className="chann">
      {changed.length > 0 && (
        <ul className="chann__list">
          {changed.map((p) => {
            const note = boundsNote(p);
            return (
              <li key={p.name} className="chann__item">
                <code className="chann__attr">{attrOf(p)}</code>
                {p.help && <p className="chann__help">{p.help}</p>}
                {note && <p className="chann__bounds">{note}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {terms.length > 0 && (
        <details className="chann__glossary">
          <summary className="chann__glossary-summary">
            Terraform terms in this change ({terms.length})
          </summary>
          <dl className="chann__glossary-dl">
            {terms.map((t) => (
              <div key={t} className="chann__glossary-row">
                <dt>
                  <code>{t}</code>
                </dt>
                <dd>{GLOSSARY[t]}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
