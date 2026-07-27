/** Provider display seam (0039 S1 lane C; widened to gcp by 0034 lane G1):
 * the ONE place the app knows which cloud providers exist and what their
 * resource ids look like. */
export const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

const PREFIX: Record<CloudProvider, string> = {
  aws: 'aws_',
  azure: 'azurerm_',
  gcp: 'google_',
};

export const RESOURCE_TYPE_PATTERNS: Record<CloudProvider, RegExp> = {
  aws: /^aws_[a-z0-9_]+$/,
  azure: /^azurerm_[a-z0-9_]+$/,
  gcp: /^google_[a-z0-9_]+$/,
};

/** Resolve a resource type's provider from its prefix. Every RECOGNIZED prefix
 * has an explicit arm (0034 rule 8 — before this table, anything
 * non-azurerm classified as 'aws', so a google_* type silently became an AWS
 * one); an unprefixed/unknown type keeps the historical 'aws' reading, which
 * pre-dates the seam and is pinned by providerDisplay.test.ts — callers that
 * need fail-closed semantics filter by RESOURCE_TYPE_PATTERNS first. */
export function providerOfType(resourceType: string): CloudProvider {
  for (const p of CLOUD_PROVIDERS) {
    if (resourceType.startsWith(PREFIX[p])) return p;
  }
  return 'aws';
}

export function stripProviderPrefix(resourceType: string): string {
  return resourceType.replace(/^(?:aws|azurerm|google)_/, '');
}

/** True for a cloud resource identifier: an AWS ARN, an Azure ARM resource
 * path, or a GCP resource name (`projects/…` path or `//service/…` full
 * resource name). */
export function isCloudResourceId(value: string): boolean {
  return (
    value.startsWith('arn:') ||
    value.startsWith('/subscriptions/') ||
    value.startsWith('projects/') ||
    value.startsWith('//')
  );
}

/** The meaningful tail — an ARN's last segment, or a resource path's name. */
export function cloudIdTail(value: string): string {
  const bySlash = value.split('/').filter((s) => s.length > 0);
  if (bySlash.length > 1) return bySlash[bySlash.length - 1]!;
  const byColon = value.split(':').filter((s) => s.length > 0);
  return byColon[byColon.length - 1] ?? value;
}
