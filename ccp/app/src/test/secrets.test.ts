import { describe, expect, it } from 'vitest';
import type { ManifestParam } from '@/types';
import { isSensitiveParam, pastedSecretError } from '@/lib/secrets';

function param(over: Partial<ManifestParam> = {}): ManifestParam {
  return { name: 'x', label: 'X', type: 'string', source: 'user_input', required: false, ...over };
}

describe('isSensitiveParam', () => {
  it('flags explicitly-sensitive params', () => {
    expect(isSensitiveParam(param({ sensitive: true }))).toBe(true);
  });
  it('flags secret-named params (token/password/psk/api_key)', () => {
    expect(isSensitiveParam(param({ name: 'api_token' }))).toBe(true);
    expect(isSensitiveParam(param({ name: 'new_psk' }))).toBe(true);
    expect(isSensitiveParam(param({ name: 'master_password' }))).toBe(true);
  });
  it('does not flag ordinary params', () => {
    expect(isSensitiveParam(param({ name: 'instance_type' }))).toBe(false);
    expect(isSensitiveParam(param({ name: 'new_size_gib' }))).toBe(false);
  });
});

describe('pastedSecretError — block secrets on non-sensitive free-text fields', () => {
  it('blocks a UUID/token pasted into an ordinary field', () => {
    expect(pastedSecretError(param({ name: 'tag_value' }), '76677951-ef06-470f-a03b-93df18df3b99')).toMatch(
      /Secrets Manager|credential/i,
    );
  });
  it('allows a sensitive field to hold a secret (masked elsewhere)', () => {
    expect(pastedSecretError(param({ name: 'api_token' }), 'AKIA1234567890ABCDEFghij')).toBeNull();
  });
  it('allows ordinary values', () => {
    expect(pastedSecretError(param({ name: 'tag_value' }), 'ERP-Backup-PROD')).toBeNull();
    expect(pastedSecretError(param({ name: 'tag_value' }), 'production')).toBeNull();
  });
  it('ignores inventory-sourced and non-string params', () => {
    expect(pastedSecretError(param({ source: 'inventory' }), 'deadbeef-0000-4000-8000-000000000000')).toBeNull();
    expect(pastedSecretError(param({ type: 'number' }), 123 as unknown)).toBeNull();
  });

  // 0034 papercut #1 — the two drill ticket classes that were unsubmittable.
  it('allows an allowlist member (S42: the op offers a 24+ char TLS-policy name)', () => {
    const tlsPolicy = param({
      name: 'tls_policy',
      source: 'allowlist',
      bounds: {
        allowlist: [
          'ELBSecurityPolicy-TLS13-1-2-2021-06',
          'ELBSecurityPolicy-TLS13-1-2-Res-2021-06',
          'ELBSecurityPolicy-FS-1-2-Res-2020-10',
        ],
      },
    });
    expect(pastedSecretError(tlsPolicy, 'ELBSecurityPolicy-TLS13-1-2-2021-06')).toBeNull();
  });

  it('allows a value matching the param’s declared pattern (S24: dated snapshot id)', () => {
    const snapId = param({
      name: 'snapshot_identifier',
      bounds: { pattern: '^[a-z][a-z0-9-]{0,254}$' },
    });
    expect(pastedSecretError(snapId, 'pre-release-app-db01-20260715')).toBeNull();
  });

  it('still rejects a real high-entropy token on a plain free-text field', () => {
    // No allowlist, no pattern, not sensitive-named — the guard must still fire.
    expect(pastedSecretError(param({ name: 'tag_value' }), 'AKIA1234567890ABCDEFghij')).toMatch(
      /Secrets Manager|credential/i,
    );
  });

  it('does not exempt a real token merely because SOME allowlist exists (non-member)', () => {
    const bounded = param({
      name: 'tag_value',
      bounds: { allowlist: ['prod', 'staging'] },
    });
    expect(pastedSecretError(bounded, 'AKIA1234567890ABCDEFghij')).toMatch(/credential/i);
  });
});
