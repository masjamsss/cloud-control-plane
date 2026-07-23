import { describe, expect, it } from 'vitest';
import { loadEstateDenylist } from '../../scripts/lib/estateDenylist';
import {
  isAccountGenericArn,
  scanHardcodedValues,
  scanManifestBranding,
} from '../../scripts/verify-manifest-safety';

/**
 * Catalog-genericity gate (see scanManifestBranding). The shared manifests are
 * reused across many AWS accounts, so every human-readable PROSE field must read
 * the same on any account — no estate-specific branding (a customer's workload
 * landscape, a region nickname, a local timezone abbreviation, the tenant name).
 * These tests pin BOTH halves of the contract: the scan fires on branded prose,
 * and it is scoped to prose so real AWS identifiers in VALUE fields never trip.
 *
 * The estate terms are NOT hardcoded in the scanner anymore — they come from the
 * resolved denylist (empty in the public built-in; real only in the untracked
 * .estate-denylist.json). So these unit tests inject a SYNTHETIC denylist to prove
 * the mechanism, and never name a real estate value in committed test source.
 */
const SYNTH = {
  estateTerms: ['ACMEWIDGET', 'FOOCORP', 'WIDGETZONE'],
  accountIds: ['999999999999'],
  region: [],
  brand: [],
} as const;

describe('scanManifestBranding — fires on branded prose', () => {
  it('catches a planted branded host in a description', () => {
    const v = scanManifestBranding('x.json', {
      operations: [{ id: 'x-create', description: 'Stand up a new ACMEWIDGET host as a spec.' }],
    }, SYNTH);
    expect(v).toHaveLength(1);
    expect(v[0]?.term).toBe('ACMEWIDGET');
    expect(v[0]?.field).toBe('operations[0].description');
  });

  it('is case-insensitive — catches a lower-case example value in help (acmewidget-daily)', () => {
    const v = scanManifestBranding('x.json', {
      operations: [{ params: [{ help: 'The vault, like acmewidget-daily.' }] }],
    }, SYNTH);
    expect(v).toHaveLength(1);
    expect(v[0]?.term).toBe('acmewidget');
    expect(v[0]?.field).toBe('operations[0].params[0].help');
  });

  it('flags branding inside a decisions[] review-checklist item', () => {
    const v = scanManifestBranding('x.json', {
      operations: [{ decisions: ['Machine image choice', 'ACMEWIDGET placement and tenancy review'] }],
    }, SYNTH);
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('operations[0].decisions[1]');
  });

  it('catches any denylist term anywhere in a top-level summary', () => {
    expect(scanManifestBranding('x.json', { summary: 'cron is UTC; WIDGETZONE is UTC+7' }, SYNTH)[0]?.term).toBe(
      'WIDGETZONE',
    );
    expect(scanManifestBranding('x.json', { summary: 'the FOOCORP estate' }, SYNTH)[0]?.term).toBe(
      'FOOCORP',
    );
    expect(scanManifestBranding('x.json', { summary: 'ACMEWIDGET FOOCORP snapshots' }, SYNTH)).toHaveLength(1);
  });

  it('the public built-in denylist is empty — branded prose passes without a materialized denylist', () => {
    // A fresh public checkout has no estate vocabulary, so even a would-be branded
    // line reports clean; the private deployment materializes .estate-denylist.json.
    expect(scanManifestBranding('x.json', { summary: 'the FOOCORP estate' })).toEqual([]);
  });
});

describe('scanManifestBranding — clean prose passes, VALUE fields are out of scope', () => {
  it('passes on clean, generic prose', () => {
    expect(
      scanManifestBranding('x.json', {
        operations: [
          {
            description: 'Stand up a new host as a complete specification.',
            params: [{ help: 'The vault, like daily-standard.' }],
            decisions: ['Placement and tenancy review'],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('does NOT flag branded tokens in VALUE fields (the reason it is prose-scoped)', () => {
    // Every token here legitimately contains a denylist term but is a resource id /
    // enum / default, not prose — and lives in a non-prose key, so the gate must
    // ignore all of it even with the synthetic denylist active.
    const v = scanManifestBranding('dlm.json', {
      operations: [
        {
          description: 'Set the execution handler to a documented AWS-managed SSM document.',
          params: [
            {
              name: 'execution_handler',
              help: 'AWS-managed handler for application-consistent snapshots.',
              bounds: {
                allowlist: [
                  'AWS_VSS_BACKUP',
                  'AWSSystemsManagerACMEWIDGET-CreateSnapshotForACMEWIDGET',
                  'arn:aws:iam::999999999999:role/service-role/AWSBackupACMEWIDGETRole',
                ],
              },
            },
            { name: 'rule_name', default: 'acmewidget-portal-rate-limit' },
            { name: 'tz', default: 'Region/Zone' },
          ],
        },
      ],
    }, SYNTH);
    expect(v).toEqual([]);
  });

  it('matches whole words only — no substring false positives', () => {
    expect(
      scanManifestBranding('x.json', { summary: 'A mkACMEWIDGETling near a FOOCORPish display.' }, SYNTH),
    ).toEqual([]);
  });
});

describe('scanHardcodedValues — allowed-value fields must be account-agnostic', () => {
  it('flags an account-bound ARN inside a bounds.allowlist entry', () => {
    const v = scanHardcodedValues('x.json', {
      operations: [
        {
          params: [
            {
              name: 'iam_role_arn',
              bounds: { allowlist: ['arn:aws:iam::123456789012:role/service-role/SomeRole'] },
            },
          ],
        },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('operations[0].params[0].bounds.allowlist[0]');
    expect(v[0]?.reason).toContain('account id');
  });

  it('flags a hardcoded account-bound ARN default', () => {
    const v = scanHardcodedValues('x.json', {
      operations: [
        { params: [{ name: 'role', default: 'arn:aws:iam::123456789012:role/x' }] },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('operations[0].params[0].default');
  });

  it('flags an account-less but account-bound ARN (an estate bucket) as an ARN value', () => {
    const v = scanHardcodedValues('x.json', {
      operations: [{ params: [{ name: 'dest', bounds: { allowlist: ['arn:aws:s3:::estate-logs'] } }] }],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain('ARN');
  });

  it('flags a bare 12-digit account id even outside an ARN, and inside a nested map default', () => {
    const v = scanHardcodedValues('x.json', {
      operations: [
        { params: [{ name: 'owner', default: { account: 'owner-123456789012' } }] },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('operations[0].params[0].default.account');
  });

  it('does NOT flag legitimately-generic AWS identifiers', () => {
    // AWS-managed policy ARNs (literal `aws` account segment), service
    // principals, AWS-managed SSM document names, and plain enum values are
    // all generic — none may trip the gate.
    const v = scanHardcodedValues('x.json', {
      operations: [
        {
          params: [
            {
              name: 'policy_arn',
              bounds: {
                allowlist: [
                  'arn:aws:iam::aws:policy/ReadOnlyAccess',
                  'arn:aws:iam::aws:policy/AWSSupportAccess',
                ],
              },
            },
            { name: 'principal', default: 'backup.amazonaws.com' },
            { name: 'handler', bounds: { allowlist: ['AWS_VSS_BACKUP', 'AWSSystemsManagerACME-CreateSnapshotForACMEWIDGET'] } },
            { name: 'state', bounds: { allowlist: ['ENABLED', 'DISABLED'] } },
            { name: 'tz', default: 'Asia/Tokyo' },
          ],
        },
      ],
    });
    expect(v).toEqual([]);
  });

  it('is scoped to VALUE fields — validation patterns and prose stay exempt', () => {
    // A `pattern` legitimately spells the ARN shape (with a \d{12} account
    // segment), and help prose may cite an ARN as a format example; neither is
    // an offered value, so neither may trip.
    const v = scanHardcodedValues('x.json', {
      operations: [
        {
          params: [
            {
              name: 'role',
              help: 'Paste a role ARN like arn:aws:iam::123456789012:role/x.',
              bounds: { pattern: '^arn:aws:iam::[0-9]{12}:role/.+$' },
            },
          ],
        },
      ],
    });
    expect(v).toEqual([]);
  });

  it('isAccountGenericArn: only the literal `aws` account segment is generic', () => {
    expect(isAccountGenericArn('arn:aws:iam::aws:policy/ReadOnlyAccess')).toBe(true);
    expect(isAccountGenericArn('arn:aws:iam::123456789012:role/x')).toBe(false);
    expect(isAccountGenericArn('arn:aws:s3:::some-bucket')).toBe(false);
  });
});

describe('scanHardcodedValues — table-driven: every value-position verdict (fix-wave S1)', () => {
  // Each value is scanned in a `default` field — one of the function's own
  // VALUE_KEYS channels (allowlist/default/const); prose and pattern fields
  // are out of scope by construction (see the "is scoped to VALUE fields"
  // case above). `reason` is undefined for a value that must PASS.
  const cases: Array<{ label: string; value: string; reason: string | undefined }> = [
    { label: 'a 12-digit AWS account id', value: '123456789012', reason: 'account id' },
    {
      label: 'an account-bound ARN (no account digits, so this pins the ARN branch itself)',
      value: 'arn:aws:s3:::estate-bucket',
      reason: 'ARN',
    },
    {
      label: 'an account-generic AWS-managed policy ARN',
      value: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
      reason: undefined,
    },
    {
      label: 'a bare Azure GUID (tenant/subscription id)',
      value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      reason: 'Azure subscription/tenant id',
    },
    {
      label: 'a /subscriptions/<guid>/... ARM resource id (pins fix-3: ARM checked before GUID)',
      value:
        '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x',
      reason: 'subscription-scoped ARM resource id',
    },
    { label: 'a benign generic string', value: 'gp3', reason: undefined },
  ];

  it.each(cases)('$label', ({ value, reason }) => {
    const v = scanHardcodedValues('x.json', {
      operations: [{ params: [{ name: 'p', default: value }] }],
    });
    if (reason === undefined) {
      expect(v).toEqual([]);
    } else {
      expect(v).toHaveLength(1);
      expect(v[0]?.reason).toContain(reason);
    }
  });
});

describe('the bundled catalog', () => {
  // Scan the RAW on-disk manifests (same eager glob the runtime index uses),
  // not the zod-parsed objects, so no prose field can be missed. This is the
  // regression guarantee: if branding ever creeps back into shipped prose, this
  // goes red — the same signal `npm run verify:safety` gives CI.
  const modules = import.meta.glob<{ default: unknown }>('../data/manifests/*.json', {
    eager: true,
  });

  it('has zero estate branding in any prose field across every manifest', () => {
    // Read the RESOLVED denylist: empty in a public checkout (so this is a clean
    // no-op there), real in the private deployment's CI (where .estate-denylist.json
    // is materialized) — keeping this a LIVE regression guard exactly where estate
    // terms could actually leak into the shared catalog.
    const denylist = loadEstateDenylist();
    const violations = Object.entries(modules).flatMap(([path, mod]) =>
      scanManifestBranding(path.split('/').pop() ?? path, mod.default, denylist),
    );
    const report = violations.map((v) => `${v.file} → ${v.field} ("${v.term}")`).join('\n');
    expect(violations, `branding leaked into prose:\n${report}`).toEqual([]);
  });

  it('has zero hardcoded account-bound values in any allowed-value field (inventory-driven only)', () => {
    const violations = Object.entries(modules).flatMap(([path, mod]) =>
      scanHardcodedValues(path.split('/').pop() ?? path, mod.default),
    );
    const report = violations.map((v) => `${v.file} → ${v.field} (${v.reason}): ${v.text}`).join('\n');
    expect(violations, `account-bound values leaked into the catalog:\n${report}`).toEqual([]);
  });
});
