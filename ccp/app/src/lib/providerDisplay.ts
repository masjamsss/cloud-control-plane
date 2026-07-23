/** Provider display seam (0039 S1 lane C): the ONE place the app knows which
 * cloud providers exist and what their resource ids look like. */
export type CloudProvider = 'aws' | 'azure';

const PREFIX: Record<CloudProvider, string> = { aws: 'aws_', azure: 'azurerm_' };

export const RESOURCE_TYPE_PATTERNS: Record<CloudProvider, RegExp> = {
  aws: /^aws_[a-z0-9_]+$/,
  azure: /^azurerm_[a-z0-9_]+$/,
};

export function providerOfType(resourceType: string): CloudProvider {
  return resourceType.startsWith(PREFIX.azure) ? 'azure' : 'aws';
}

export function stripProviderPrefix(resourceType: string): string {
  return resourceType.replace(/^(?:aws|azurerm)_/, '');
}

/** True for a cloud resource identifier: an AWS ARN or an Azure ARM resource path. */
export function isCloudResourceId(value: string): boolean {
  return value.startsWith('arn:') || value.startsWith('/subscriptions/');
}

/** The meaningful tail — an ARN's last segment, or an ARM path's resource name. */
export function cloudIdTail(value: string): string {
  const bySlash = value.split('/').filter((s) => s.length > 0);
  if (bySlash.length > 1) return bySlash[bySlash.length - 1]!;
  const byColon = value.split(':').filter((s) => s.length > 0);
  return byColon[byColon.length - 1] ?? value;
}
