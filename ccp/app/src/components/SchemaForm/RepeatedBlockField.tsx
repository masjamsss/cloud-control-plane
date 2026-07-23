import { useState, type JSX } from 'react';
import type { Inventory, ManifestParam } from '@/types';
import { resolveEnum } from '@/lib/interpreter';
import { isParamActive } from '@/lib/dependsOn';
import {
  addRepeatedInstance,
  readRepeatedInstances,
  removeRepeatedInstance,
  repeatedInstanceErrors,
  updateRepeatedInstance,
} from '@/lib/catalog';
import { Field } from './Field';

export interface RepeatedBlockFieldProps {
  /** The operation id (for admin allowlist narrowing on sub-field pickers). */
  operationId: string;
  /** The manifest param — MUST carry `param.repeated`. */
  param: ManifestParam;
  /** The stored value: an array of instance records (anything else reads empty). */
  value: unknown;
  inventory: Inventory;
  /** Aggregated submit-gate error on the whole block (count / an invalid entry). */
  error?: string;
  /** Whether the parent has revealed errors (a failed Review reveals every
   * sub-field error at once, matching the flat form's behavior). */
  touched?: boolean;
  onChange: (name: string, value: unknown) => void;
  onBlur: (name: string) => void;
}

/**
 * Renders a REPEATED nested block (a param with `repeated`) as an add/remove
 * list of instance sub-forms — the form half of the repeated-block foundation
 * (the draft renderer's half is lib/hclSkeleton.ts). Each instance renders its
 * sub-schema through the SAME {@link Field} the flat form uses (so every widget
 * — pickers, toggles, allowlists, textareas — works inside a block for free),
 * and a sub-field that is itself `repeated` recurses into a nested
 * RepeatedBlockField. All array mutation goes through the pure helpers in
 * lib/catalog, so this component holds only DOM concerns: which sub-fields have
 * been touched (for inline error reveal) and the add/remove buttons.
 *
 * Instance-count bounds (`bounds.minItems/maxItems`) disable Remove at the floor
 * and Add at the ceiling; the submit gate (interpreter.validateParams) enforces
 * the same counts and per-instance sub-field validity authoritatively.
 */
export function RepeatedBlockField({
  operationId,
  param,
  value,
  inventory,
  error,
  touched,
  onChange,
  onBlur,
}: RepeatedBlockFieldProps): JSX.Element {
  const spec = param.repeated!;
  const instances = readRepeatedInstances(value);
  // Sub-field touched state, keyed `<instanceIndex>.<subName>` — local DOM
  // concern only; never enters the submitted request.
  const [subTouched, setSubTouched] = useState<Record<string, boolean>>({});

  const min = param.bounds?.minItems;
  const max = param.bounds?.maxItems;
  const canRemove = min === undefined || instances.length > min;
  const canAdd = max === undefined || instances.length < max;

  const noun = param.label;
  const add = (): void => onChange(param.name, addRepeatedInstance(value, spec));
  const remove = (i: number): void => onChange(param.name, removeRepeatedInstance(value, i));

  return (
    <fieldset className="sf-repeat">
      <legend className="sf-repeat__legend">
        {noun}
        {param.required ? (
          <span className="sf-req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : (
          <span className="sf-optional"> (optional)</span>
        )}
      </legend>
      {param.help && <p className="sf-help sf-repeat__help">{param.help}</p>}

      {instances.length === 0 && (
        <p className="sf-repeat__empty">No {noun.toLowerCase()} added yet.</p>
      )}

      {instances.map((row, i) => {
        const errs = repeatedInstanceErrors(spec, row);
        const active = spec.fields.filter((f) => f.role !== 'const' && isParamActive(f, row));
        return (
          <div className="sf-repeat__item" key={i}>
            <div className="sf-repeat__item-head">
              <span className="sf-repeat__item-title">
                {noun} {i + 1}
              </span>
              <button
                type="button"
                className="sf-repeat__remove"
                onClick={() => remove(i)}
                disabled={!canRemove}
                aria-label={`Remove ${noun} ${i + 1}`}
              >
                Remove
              </button>
            </div>
            <div className="sf-repeat__item-body">
              {active.map((sub) => {
                const reveal = subTouched[`${i}.${sub.name}`] || Boolean(touched);
                const onSubChange = (subName: string, v: unknown): void =>
                  onChange(param.name, updateRepeatedInstance(value, i, subName, v));
                const onSubBlur = (subName: string): void => {
                  setSubTouched((t) => ({ ...t, [`${i}.${subName}`]: true }));
                  onBlur(param.name);
                };
                if (sub.repeated) {
                  return (
                    <RepeatedBlockField
                      key={sub.name}
                      operationId={operationId}
                      param={sub}
                      value={row[sub.name]}
                      inventory={inventory}
                      error={errs[sub.name]}
                      touched={reveal}
                      onChange={onSubChange}
                      onBlur={onSubBlur}
                    />
                  );
                }
                const options =
                  sub.source === 'inventory' || sub.source === 'allowlist'
                    ? resolveEnum(sub, inventory, operationId)
                    : undefined;
                return (
                  <Field
                    key={sub.name}
                    param={sub}
                    value={row[sub.name]}
                    error={errs[sub.name]}
                    touched={reveal}
                    options={options}
                    inventory={inventory}
                    onChange={onSubChange}
                    onBlur={onSubBlur}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <button type="button" className="sf-repeat__add" onClick={add} disabled={!canAdd}>
        + Add {noun.toLowerCase()}
      </button>

      {error && touched && (
        <p className="sf-repeat__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
