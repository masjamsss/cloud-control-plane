import { describe, expect, it } from 'vitest';
import { scanMixedProviderManifest } from '../../scripts/verify-manifest-safety';

/**
 * Single-provider manifest gate (0039 S1 lane L, beside the branding gate in
 * scripts/verify-manifest-safety.ts). lib/catalog.ts's deriveServiceCatalog
 * filters a project's catalog by providerOfType(resourceType) vs the active
 * project's own provider — a filter that is only sound if every manifest's
 * resourceTypes are homogeneous. A manifest naming BOTH aws_* and azurerm_*
 * resource types would defeat that filter for whichever type it evaluates
 * against the "wrong" arm, so this gate FAILs the build on any manifest whose
 * resourceTypes mix providers.
 */

describe('scanMixedProviderManifest — every manifest is exactly one cloud provider', () => {
  it('passes a clean all-aws resourceTypes list', () => {
    expect(scanMixedProviderManifest('ec2.json', ['aws_instance', 'aws_ebs_volume'])).toBeNull();
  });

  it('passes a clean all-azure resourceTypes list', () => {
    expect(
      scanMixedProviderManifest('azure-compute.json', [
        'azurerm_linux_virtual_machine',
        'azurerm_managed_disk',
      ]),
    ).toBeNull();
  });

  it('passes an empty resourceTypes list (nothing to mix)', () => {
    expect(scanMixedProviderManifest('empty.json', [])).toBeNull();
  });

  it('FAILs a synthetic manifest mixing aws_* and azurerm_* resource types', () => {
    const v = scanMixedProviderManifest('mixed.json', [
      'aws_instance',
      'azurerm_linux_virtual_machine',
    ]);
    expect(v).not.toBeNull();
    expect(v?.file).toBe('mixed.json');
    expect(v?.providers.sort()).toEqual(['aws', 'azure']);
    expect(v?.resourceTypes).toEqual(['aws_instance', 'azurerm_linux_virtual_machine']);
  });

  it('FAILs regardless of which provider appears first in the array', () => {
    const v = scanMixedProviderManifest('mixed2.json', [
      'azurerm_storage_account',
      'aws_s3_bucket',
    ]);
    expect(v).not.toBeNull();
    expect(v?.providers.sort()).toEqual(['aws', 'azure']);
  });

  it('FAILs a manifest with 3+ resourceTypes where only one is the odd provider out', () => {
    const v = scanMixedProviderManifest('mostly-aws.json', [
      'aws_instance',
      'aws_ebs_volume',
      'azurerm_managed_disk',
    ]);
    expect(v).not.toBeNull();
    expect(v?.resourceTypes).toHaveLength(3);
  });
});

describe('the bundled catalog — zero mixed-provider manifests today', () => {
  // Scan the RAW on-disk manifests, same eager glob the runtime index and the
  // sibling genericity regression test use — the guarantee this gate exists
  // to protect: if a mixed-provider manifest is ever authored, this goes red,
  // the same signal `npm run verify:safety` gives CI.
  const modules = import.meta.glob<{ default: { resourceTypes?: string[] } }>(
    '../data/manifests/*.json',
    { eager: true },
  );

  it('has zero mixed-provider manifests across the shipped catalog', () => {
    const violations = Object.entries(modules)
      .map(([path, mod]) =>
        scanMixedProviderManifest(path.split('/').pop() ?? path, mod.default.resourceTypes ?? []),
      )
      .filter((v) => v !== null);
    const report = violations
      .map((v) => `${v!.file}: ${v!.providers.join('+')} — ${v!.resourceTypes.join(', ')}`)
      .join('\n');
    expect(violations, `mixed-provider manifest(s) found:\n${report}`).toEqual([]);
  });
});
