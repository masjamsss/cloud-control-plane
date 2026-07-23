import { describe, expect, it } from 'vitest';
import { parseFilters } from '@/features/requests/MyRequests';

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
});
