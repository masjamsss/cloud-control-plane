import { Fragment, type JSX } from 'react';
import type { Inventory, ManifestParam } from '@/types';
import type { FormSectionPlan } from '@/lib/catalog';
import { groupFields } from '@/lib/catalog';
import { isParamActive } from '@/lib/dependsOn';
import { resolveEnum } from '@/lib/interpreter';
import { Field } from './Field';
import { RepeatedBlockField } from './RepeatedBlockField';
import './SchemaForm.css';

export interface SchemaFormProps {
  /** The operation being requested — used to apply admin allowlist narrowing. */
  operationId: string;
  sections: FormSectionPlan[];
  inventory: Inventory;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  touched: Record<string, boolean>;
  onChange: (name: string, value: unknown) => void;
  onBlur: (name: string) => void;
}

/**
 * Renders a plan's sections as titled groups, one Field per manifest param.
 * The "options" section (Additional configuration) collapses into a closed
 * <details>. Entirely manifest-driven — no per-service form code.
 *
 * Two manifest-driven layers on top of the section plan (both no-ops for ops
 * that don't use them):
 *   - dependsOn: a param renders only while its controlling param
 *     satisfies the condition — the same lib/dependsOn predicate client and
 *     server validation apply, so the form never shows a field whose value
 *     would be ignored.
 *   - param.group: named groups render as <fieldset>s with plain
 *     legends, so a 15-field create baseline reads as labeled sections
 *     instead of one wall; ungrouped params render bare (no wrapper element),
 *     exactly as they did before groups existed.
 */
export function SchemaForm({
  operationId,
  sections,
  inventory,
  values,
  errors,
  touched,
  onChange,
  onBlur,
}: SchemaFormProps): JSX.Element {
  const renderField = (param: ManifestParam): JSX.Element => {
    // A REPEATED nested block (param.repeated) renders as an add/remove list of
    // instance sub-forms; every other param stays the single bounded control it
    // always was (byte-identical markup for non-repeated ops).
    if (param.repeated) {
      return (
        <RepeatedBlockField
          key={param.name}
          operationId={operationId}
          param={param}
          value={values[param.name]}
          error={errors[param.name]}
          touched={touched[param.name]}
          inventory={inventory}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
    }
    const options =
      param.source === 'inventory' || param.source === 'allowlist'
        ? resolveEnum(param, inventory, operationId)
        : undefined;
    return (
      <Field
        key={param.name}
        param={param}
        value={values[param.name]}
        error={errors[param.name]}
        touched={touched[param.name]}
        options={options}
        inventory={inventory}
        onChange={onChange}
        onBlur={onBlur}
      />
    );
  };

  const renderFields = (fields: ManifestParam[]): JSX.Element[] =>
    groupFields(fields).map((group, i) =>
      group.id === null ? (
        // Ungrouped run — bare fields, same markup as before groups existed.
        <Fragment key={`run-${i}`}>{group.fields.map(renderField)}</Fragment>
      ) : (
        <fieldset key={group.id} className="sf-group">
          <legend className="sf-group__legend">{group.legend}</legend>
          <div className="sf-group__body">{group.fields.map(renderField)}</div>
        </fieldset>
      ),
    );

  return (
    <div className="sf">
      {sections.map((section) => {
        const visible = section.fields.filter((f) => isParamActive(f, values));
        if (visible.length === 0) return null;
        return section.id === 'options' ? (
          // The plan's `collapsed` flag finally renders: every manifest plan
          // sets it true (closed, exactly as before), and a generated
          // provision form with nothing required opens it so the parameters
          // are visible at once.
          <details key={section.id} className="sf-section sf-section--options" open={!section.collapsed}>
            <summary className="sf-section__summary">
              <span className="sf-eyebrow">{section.title}</span>
              <span className="sf-section__count">{visible.length}</span>
            </summary>
            <div className="sf-section__body">{renderFields(visible)}</div>
          </details>
        ) : (
          <section key={section.id} className="sf-section">
            <p className="sf-eyebrow">{section.title}</p>
            <div className="sf-section__body">{renderFields(visible)}</div>
          </section>
        );
      })}
    </div>
  );
}
