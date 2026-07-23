import type { JSX } from 'react';
import type { FullBlockDiff as FullBlockDiffData } from '@/lib/blockDiff';
import './full-block-diff.css';

/**
 * The learning view: the ENTIRE resource block as it exists in the repo,
 * before and after the requested change, with the touched lines highlighted and
 * real file/line provenance — so an L1 sees the whole bracket they are changing,
 * in context, not just a one-line diff.
 */
export function FullBlockDiff({ diff }: { diff: FullBlockDiffData }): JSX.Element {
  const beforeLines = diff.before.split('\n');
  const afterLines = diff.kind === 'remove' ? [] : diff.after.split('\n');
  const changedB = new Set(diff.changedBefore);
  const changedA = new Set(diff.changedAfter);

  return (
    <div className="fbd">
      <div className="fbd__provenance">
        <code className="fbd__file">{diff.file}</code>
        <span className="fbd__line">line {diff.line}</span>
        {diff.kind === 'remove' && <span className="fbd__removed-tag">whole block removed</span>}
      </div>

      <div className={diff.kind === 'remove' ? 'fbd__panes fbd__panes--single' : 'fbd__panes'}>
        <section className="fbd__pane" aria-label="Current block">
          <h3 className="fbd__pane-title">Current</h3>
          <pre className="fbd__code">
            {beforeLines.map((l, i) => (
              <div
                key={i}
                className={
                  diff.kind === 'remove'
                    ? 'fbd__row fbd__row--del'
                    : changedB.has(i)
                      ? 'fbd__row fbd__row--del'
                      : 'fbd__row'
                }
              >
                <span className="fbd__num" aria-hidden="true">
                  {diff.line + i}
                </span>
                <span className="fbd__text">{l === '' ? ' ' : l}</span>
              </div>
            ))}
          </pre>
        </section>

        {diff.kind !== 'remove' && (
          <section className="fbd__pane" aria-label="After this change">
            <h3 className="fbd__pane-title">After this change</h3>
            <pre className="fbd__code">
              {afterLines.map((l, i) => (
                <div key={i} className={changedA.has(i) ? 'fbd__row fbd__row--add' : 'fbd__row'}>
                  <span className="fbd__num" aria-hidden="true">
                    {diff.line + i}
                  </span>
                  <span className="fbd__text">{l === '' ? ' ' : l}</span>
                </div>
              ))}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
