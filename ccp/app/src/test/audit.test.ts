import { beforeEach, describe, expect, it } from 'vitest';
import { listAudit, recordAudit, resetAuditForTests } from '@/lib/audit';

beforeEach(() => resetAuditForTests());

describe('audit log', () => {
  it('starts empty', () => {
    expect(listAudit()).toEqual([]);
  });

  it('records entries newest-first with actor, action and summary', () => {
    recordAudit('putra', 'Enrolled user', 'Dewi (@dewi) — Requester, ERP Basis');
    recordAudit('putra', 'Changed role', '@dewi → Approver');
    const entries = listAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.action).toBe('Changed role'); // newest first
    expect(entries[0]?.actor).toBe('putra');
    expect(entries[1]?.action).toBe('Enrolled user');
    expect(entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[0]?.id).toBeTruthy();
  });
});
