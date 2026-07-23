import type { JSX } from 'react';
import type { RequestEvent } from '@/types';
import { formatProjectTime } from '@/lib/datetime';

export function Timeline({ events }: { events: RequestEvent[] }): JSX.Element {
  return (
    <ol className="tl">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="tl__item">
          <span className="tl__dot" aria-hidden="true" />
          <div className="tl__body">
            <div className="tl__label">{e.label}</div>
            <div className="tl__meta">
              {formatProjectTime(e.at)}
              {e.actor ? ` · ${e.actor}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
