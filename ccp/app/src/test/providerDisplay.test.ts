import { describe, expect, it } from 'vitest';
import { providerOfType, stripProviderPrefix, isCloudResourceId, cloudIdTail } from '@/lib/providerDisplay';

/**
 * 0039 S1 lane C: the ONE shared provider-display seam. These tests pin the
 * two things the rest of the app now routes through it — provider-prefix
 * stripping/classification (aws_/azurerm_) and cloud resource id shape
 * detection + tail extraction (ARN / ARM resource path) — so the three
 * duplicated `^aws_` strips and the ARN-only chip logic can be deleted in
 * favor of this module.
 */

describe('stripProviderPrefix', () => {
  it('strips both provider prefixes', () => {
    expect(stripProviderPrefix('aws_s3_bucket')).toBe('s3_bucket');
    expect(stripProviderPrefix('azurerm_storage_account')).toBe('storage_account');
    expect(stripProviderPrefix('random_pet')).toBe('random_pet'); // unknown: unchanged
  });
});

describe('providerOfType', () => {
  it('classifies providers', () => {
    expect(providerOfType('azurerm_virtual_network')).toBe('azure');
    expect(providerOfType('aws_vpc')).toBe('aws');
  });
});

describe('isCloudResourceId / cloudIdTail', () => {
  it('detects and tails both cloud id shapes', () => {
    expect(isCloudResourceId('arn:aws:iam::111122223333:role/x')).toBe(true);
    expect(
      isCloudResourceId(
        '/subscriptions/aaaa-…/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vnet1',
      ),
    ).toBe(true);
    expect(cloudIdTail('arn:aws:iam::111122223333:role/my-role')).toBe('my-role');
    expect(
      cloudIdTail('/subscriptions/x/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vnet1'),
    ).toBe('vnet1');
  });
});
