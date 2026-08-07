import { describe, expect, it } from 'vitest';
import { parseFilters } from '@/features/requests/MyRequests';
import { REQUEST_STATUSES } from '@/types';

/**
 * Task 3: filter state for MyRequests lives in the URL (useSearchParams), so a
 * filtered view is a shareable link. parseFilters is the pure coercion at the
 * center of that: valid params pass through, invalid ones fall back to the
 * documented defaults ('all' / '') rather than producing a broken view.
 */
describe('MyRequests parseFilters — URL → filter state (valid, invalid, absent)', () => {
  it('valid: reads a known status and a text query', () => {
    const sp = new URLSearchParams('status=APPLIED&q=app01');
    expect(parseFilters(sp)).toEqual({ status: 'APPLIED', q: 'app01' });
  });

  it('invalid: an unknown status coerces to "all"', () => {
    const sp = new URLSearchParams('status=NOT_A_REAL_STATUS');
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });

  it('absent: no params default to "all" and empty text', () => {
    const sp = new URLSearchParams();
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });

  it('the literal "all" status is accepted as-is', () => {
    const sp = new URLSearchParams('status=all');
    expect(parseFilters(sp)).toEqual({ status: 'all', q: '' });
  });

  it('FE-11: every REQUEST_STATUSES value round-trips through the URL — none coerces to "all"', () => {
    // The option list this filter accepts USED TO BE a hand-typed array that omitted
    // WINDOW_EXPIRED — the one status that most needs a filter, since it is the sole
    // status demanding user action (rewindow or cancel) — and, after ARCH-7 added them,
    // silently omitted HALTED_DRIFT/HALTED_APPLY_FAILED too. Checking the WHOLE closed
    // vocabulary rather than naming WINDOW_EXPIRED alone means this cannot regress the
    // same way a second time under a status added next quarter.
    for (const status of REQUEST_STATUSES) {
      const sp = new URLSearchParams(`status=${status}`);
      expect(parseFilters(sp), status).toEqual({ status, q: '' });
    }
  });
});
