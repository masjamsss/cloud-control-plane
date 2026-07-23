import { describe, expect, it } from 'vitest';
import { isSecretAttrName, looksLikeSecret, redactHcl } from '@/lib/redact';

// A fixture shaped like environments/prod/lambda.tf:135-150 — a lambda whose
// environment block carries an inline API token. The real token is NOT used;
// this is a syntactically identical stand-in with a fake UUID.
const FAKE_TOKEN = 'deadbeef-0000-4000-8000-000000000000';
const LAMBDA_BLOCK = `resource "aws_lambda_function" "app_handler" {
  function_name = "app-handler"
  runtime       = "python3.12"
  role          = "arn:aws:iam::123456789012:role/app-handler"
  environment {
    variables = {
      API_TOKEN = "${FAKE_TOKEN}"
      LOG_LEVEL = "INFO"
      REGION    = "ap-southeast-5"
    }
  }
  tags = {
    Name = "app-handler"
  }
}`;

describe('redactHcl — the display-side secret guard', () => {
  it('masks a token inside a lambda environment/variables block', () => {
    const out = redactHcl(LAMBDA_BLOCK);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toMatch(/API_TOKEN = "«redacted:[0-9a-f]{8}»"/);
  });

  it('masks values of secret-named attributes anywhere', () => {
    const out = redactHcl('  password = "hunter2000abc"\n  db_secret = "s3cr3t-value-9999"');
    expect(out).not.toContain('hunter2000abc');
    expect(out).not.toContain('s3cr3t-value-9999');
  });

  it('masks a bare UUID/high-entropy value even on an ordinary attribute', () => {
    // Renamed from `some_id` (0039 S1 Lane D): that name now hits the deliberate
    // `*_id`/`*_ids` GUID-identifier exception below — this case is about a
    // non-`_id`-named attribute, so it must not collide with it.
    const out = redactHcl('  plain_field = "deadbeef-0000-4000-8000-000000000000"');
    expect(out).not.toContain('deadbeef-0000-4000-8000-000000000000');
  });

  it('leaves ordinary configuration values untouched', () => {
    const out = redactHcl(LAMBDA_BLOCK);
    expect(out).toContain('runtime       = "python3.12"');
    expect(out).toContain('LOG_LEVEL = "«redacted'); // inside the secret block, masked
    expect(out).toContain('function_name = "app-handler"');
  });

  it('does not mask benign AWS id / ARN shapes outside secret blocks', () => {
    const hcl = [
      '  ami           = "ami-0abc1234def567890"',
      '  subnet_id     = "subnet-0123456789abcdef0"',
      '  role          = "arn:aws:iam::123456789012:role/app-handler"',
      '  instance_type = "r6i.xlarge"',
    ].join('\n');
    const out = redactHcl(hcl);
    expect(out).toContain('ami-0abc1234def567890');
    expect(out).toContain('subnet-0123456789abcdef0');
    expect(out).toContain('arn:aws:iam::123456789012:role/app-handler');
    expect(out).toContain('r6i.xlarge');
  });

  it('masks both sides of an old -> new diff line for a secret attribute', () => {
    const out = redactHcl('  ~ api_token = "oldtok-1111aaaa" -> "newtok-2222bbbb"');
    expect(out).not.toContain('oldtok-1111aaaa');
    expect(out).not.toContain('newtok-2222bbbb');
  });

  it('honors an extra sensitiveAttrs list (e.g. from a provider-schema map)', () => {
    const out = redactHcl('  master_user_password = "plainlookingword"', {
      sensitiveAttrs: ['master_user_password'],
    });
    expect(out).not.toContain('plainlookingword');
  });

  // 0039 S1 Lane D — end-to-end proof that the *_id GUID-identifier exception
  // reaches the walk, not just the looksLikeSecret unit (attrName is threaded
  // through maskRhs from the ASSIGN match in redactHcl).
  it('renders an *_id attribute carrying a bare GUID unmasked end-to-end', () => {
    const out = redactHcl('  subscription_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
    expect(out).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('still masks a client_secret end-to-end even if its value happens to be a bare GUID', () => {
    const out = redactHcl('  client_secret = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
    expect(out).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('looksLikeSecret', () => {
  it('flags UUIDs and long mixed tokens', () => {
    expect(looksLikeSecret('76677951-ef06-470f-a03b-93df18df3b99')).toBe(true);
    expect(looksLikeSecret('AKIA1234567890ABCDEFghij')).toBe(true);
  });
  it('does not flag ordinary values or allowlisted ids', () => {
    expect(looksLikeSecret('r6i.xlarge')).toBe(false);
    expect(looksLikeSecret('ap-southeast-5')).toBe(false);
    expect(looksLikeSecret('ami-0abc1234def567890')).toBe(false);
    expect(looksLikeSecret('production')).toBe(false);
  });

  // 0034 papercut #1 — dash-joined structured identifiers are not credentials:
  // their longest unbroken run is short, so the tightened heuristic lets them
  // through (at submit AND in the rendered review artifact).
  it('does not flag dash-separated structured identifiers', () => {
    expect(looksLikeSecret('ELBSecurityPolicy-TLS13-1-2-2021-06')).toBe(false);
    expect(looksLikeSecret('ELBSecurityPolicy-FS-1-2-Res-2020-10')).toBe(false);
    expect(looksLikeSecret('pre-release-app-db01-20260715')).toBe(false);
  });

  it('still flags a solid-entropy token (no separators) and base64', () => {
    expect(looksLikeSecret('AKIA1234567890ABCDEFghij')).toBe(true);
    expect(looksLikeSecret('c29tZWxvbmdiYXNlNjR0b2tlbjEyMzQ1Njc4OQ==')).toBe(true);
  });

  // 0039 S1 Lane D — Azure identifiers (bare GUIDs, ARM resource paths) are not
  // secrets. The exception is narrow: value is a bare UUID AND the attribute
  // name ends `_id`/`_ids` AND the name rule (secretAttributeNames) has not
  // already fired. Nothing else relaxes.
  it('treats a bare GUID in an *_id attribute as an identifier, not a secret', () => {
    expect(looksLikeSecret('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'subscription_id')).toBe(false);
    expect(looksLikeSecret('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'tenant_id')).toBe(false);
  });
  it('still masks GUIDs everywhere else', () => {
    expect(looksLikeSecret('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    expect(looksLikeSecret('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'value')).toBe(true);
  });
  it('never relaxes secret-named attributes', () => {
    // name rule fires before shape rule — client_secret masks regardless of value shape
    expect(isSecretAttrName('client_secret')).toBe(true);
  });
  it('allowlists ARM resource paths', () => {
    expect(
      looksLikeSecret('/subscriptions/aaaa/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x'),
    ).toBe(false);
  });
});
