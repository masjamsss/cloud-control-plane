import { describe, expect, it } from 'vitest';
import { CATEGORY_ORDER, getServiceMeta, hasServiceMeta, type Category } from '@/lib/serviceMeta';
import { CATEGORY_ICON_CLASS } from '@/lib/serviceIcons';
import { AZURE_SERVICES } from '@/lib/azureServiceMap';
import { AWS_SERVICES } from '@/lib/awsServiceMap';

/**
 * The catalog browses Azure at FULL provisionable coverage — the 155 named
 * services in the generated tile map (azureServiceMap.ts): every service that
 * has a catalog op AND every op-less service that only a /provision deep-link
 * reaches, not the 16 shared manifests. Every one must resolve real registry
 * metadata (display name, monogram, a category in the app enum), so the service
 * tile never falls back to a title-cased slug. The portal's wider set of
 * top-level groups EXTENDS the app Category enum; the added categories each reuse
 * an existing icon tint.
 */

/** Representative named services → the exact app Category their portal label maps to. */
const AZURE_NAMED: Record<string, { displayName: string; category: Category }> = {
  vm: { displayName: 'Virtual Machines', category: 'Compute' },
  'storage-account': { displayName: 'Storage Accounts', category: 'Storage' },
  sql: { displayName: 'Azure SQL', category: 'Database' }, // portal 'Databases' → app 'Database'
  cosmos: { displayName: 'Cosmos DB', category: 'Database' },
  redis: { displayName: 'Azure Cache for Redis', category: 'Database' },
  vnet: { displayName: 'Virtual Networks', category: 'Networking' },
  'key-vault': { displayName: 'Key Vault', category: 'Security & Identity' }, // 'Security' → 'Security & Identity'
  aks: { displayName: 'Kubernetes Service', category: 'Containers' },
  acr: { displayName: 'Container Registry', category: 'Containers' },
  'app-service': { displayName: 'App Service', category: 'Web & App' },
  functions: { displayName: 'Azure Functions', category: 'Web & App' },
  'event-hubs': { displayName: 'Event Hubs', category: 'Analytics' },
  'data-factory': { displayName: 'Data Factory', category: 'Analytics' },
  ml: { displayName: 'Machine Learning', category: 'AI & ML' },
  'iot-hub': { displayName: 'IoT Hub', category: 'IoT & Mobile' },
  'service-bus': { displayName: 'Service Bus', category: 'Integration & Messaging' }, // 'Integration' → …
  'log-analytics': { displayName: 'Log Analytics', category: 'Management & Governance' },
  'resource-groups': { displayName: 'Resource Groups', category: 'Management & Governance' },
  rbac: { displayName: 'Azure RBAC', category: 'Identity' },
  'managed-identity': { displayName: 'Managed Identities', category: 'Identity' },
};

describe('serviceMeta — azure named-service registry (155-service full coverage)', () => {
  it('the tile map ships exactly 155 named services', () => {
    expect(Object.keys(AZURE_SERVICES)).toHaveLength(155);
  });

  it('every one of the 155 named services resolves real metadata (never the title-case fallback)', () => {
    for (const slug of Object.keys(AZURE_SERVICES)) {
      expect(hasServiceMeta(slug), slug).toBe(true);
      const meta = getServiceMeta(slug);
      expect(meta.displayName, slug).toBe(AZURE_SERVICES[slug]!.displayName);
      expect(meta.monogram.length, slug).toBeGreaterThan(0);
      expect(meta.monogram, slug).toBe(AZURE_SERVICES[slug]!.monogram);
      expect(CATEGORY_ORDER, slug).toContain(meta.category);
    }
  });

  it('representative services map their portal label onto the exact app Category', () => {
    for (const [slug, want] of Object.entries(AZURE_NAMED)) {
      const meta = getServiceMeta(slug);
      expect(meta.displayName, slug).toBe(want.displayName);
      expect(meta.category, slug).toBe(want.category);
    }
  });

  it('every category in CATEGORY_ORDER has an icon tint (else the tile renders untinted)', () => {
    for (const category of CATEGORY_ORDER) {
      expect(CATEGORY_ICON_CLASS[category], category).toBeTruthy();
    }
    // The 8 curated categories + the 7 azure portal categories that don't fold
    // into an existing one + the 10 aws console categories that don't either.
    expect(CATEGORY_ORDER).toHaveLength(25);
  });

  it('every category a named azure service resolves has a tint', () => {
    for (const slug of Object.keys(AZURE_SERVICES)) {
      const cat = getServiceMeta(slug).category;
      expect(CATEGORY_ICON_CLASS[cat], `${slug} → ${cat}`).toBeTruthy();
    }
  });

  it('existing aws entries are untouched (spot check)', () => {
    expect(getServiceMeta('ec2')).toEqual({
      slug: 'ec2',
      displayName: 'EC2',
      category: 'Compute',
      monogram: 'EC',
    });
    expect(getServiceMeta('s3').category).toBe('Storage');
    expect(getServiceMeta('iam').category).toBe('Security & Identity');
  });

  it('an unlisted slug still falls back to title-case + Developer & Mgmt Tools', () => {
    const meta = getServiceMeta('totally-unknown-slug');
    expect(meta.displayName).toBe('Totally Unknown Slug');
    expect(meta.category).toBe('Developer & Mgmt Tools');
  });
});

/**
 * The catalog browses AWS at FULL provisionable coverage too — the 156 named
 * services in the generated tile map (awsServiceMap.ts): with-ops services AND
 * op-less Provision-only ones, not the 57 shared manifests. The ~40 curated
 * slugs (ec2, s3, …) keep their hand-tuned REGISTRY metadata (checked FIRST); the
 * long tail resolves from the tile map with its console label mapped onto the app
 * Category enum, so no service tile ever falls back to a title-case slug. The
 * console's wider set of groups EXTENDS the enum; each added category reuses an
 * existing icon tint.
 */
const AWS_NAMED: Record<string, { displayName: string; category: Category }> = {
  ec2: { displayName: 'EC2', category: 'Compute' }, // curated REGISTRY wins over the tile map
  s3: { displayName: 'S3', category: 'Storage' }, // curated
  athena: { displayName: 'Athena', category: 'Analytics' }, // console 'Analytics'
  glue: { displayName: 'Glue', category: 'Analytics' },
  apprunner: { displayName: 'App Runner', category: 'Compute' }, // console 'Compute'
  ecs: { displayName: 'ECS', category: 'Compute' }, // curated
  eks: { displayName: 'EKS', category: 'Compute' }, // curated
  datasync: { displayName: 'DataSync', category: 'Migration & Transfer' }, // NEW category
  drs: { displayName: 'Elastic Disaster Recovery', category: 'Migration & Transfer' }, // lane-aws-compute
  mediaconvert: { displayName: 'MediaConvert', category: 'Media Services' }, // NEW
  amplify: { displayName: 'Amplify', category: 'Front-End Web & Mobile' }, // NEW
  'iot-core': { displayName: 'IoT Core', category: 'IoT' }, // console 'Internet of Things' → 'IoT'
  workspaces: { displayName: 'WorkSpaces', category: 'End User Computing' }, // NEW
  gamelift: { displayName: 'GameLift', category: 'Game Tech' }, // NEW
  'cost-explorer': { displayName: 'Cost Explorer', category: 'Cost Management' }, // NEW
  comprehend: { displayName: 'Comprehend', category: 'Machine Learning' }, // NEW
  'api-gateway': { displayName: 'API Gateway', category: 'Networking & Content Delivery' }, // NEW
  cloudformation: { displayName: 'CloudFormation', category: 'Management & Governance' }, // folds
  sqs: { displayName: 'SQS', category: 'Integration & Messaging' }, // curated
  'app-mesh': { displayName: 'App Mesh', category: 'Networking & Content Delivery' },
};

describe('serviceMeta — aws named-service registry (156-service full coverage)', () => {
  it('the tile map ships exactly 156 named services', () => {
    expect(Object.keys(AWS_SERVICES)).toHaveLength(156);
  });

  it('every one of the 156 named services resolves real metadata (never the title-case fallback)', () => {
    for (const slug of Object.keys(AWS_SERVICES)) {
      expect(hasServiceMeta(slug), slug).toBe(true);
      const meta = getServiceMeta(slug);
      expect(meta.displayName.length, slug).toBeGreaterThan(0);
      expect(meta.monogram.length, slug).toBeGreaterThan(0);
      expect(CATEGORY_ORDER, slug).toContain(meta.category);
    }
  });

  it('representative services map their console label onto the exact app Category', () => {
    for (const [slug, want] of Object.entries(AWS_NAMED)) {
      const meta = getServiceMeta(slug);
      expect(meta.displayName, slug).toBe(want.displayName);
      expect(meta.category, slug).toBe(want.category);
    }
  });

  it('every category a named aws service resolves has a tint', () => {
    for (const slug of Object.keys(AWS_SERVICES)) {
      const cat = getServiceMeta(slug).category;
      expect(CATEGORY_ICON_CLASS[cat], `${slug} → ${cat}`).toBeTruthy();
    }
  });

  it('curated aws slugs keep their REGISTRY metadata even though they are also tile-map keys', () => {
    // ec2/s3/iam are BOTH REGISTRY entries and AWS_SERVICES keys; REGISTRY wins.
    expect(getServiceMeta('ec2').displayName).toBe('EC2');
    expect(getServiceMeta('s3').monogram).toBe('S3');
    expect(getServiceMeta('iam').category).toBe('Security & Identity');
  });

  it('the three slugs BOTH clouds name resolve per the provider hint (batch/dms/resource-groups)', () => {
    // Without a hint, azure wins (the unchanged pre-aws behavior).
    expect(getServiceMeta('dms').displayName).toBe('Database Migration'); // azure
    expect(getServiceMeta('batch').category).toBe('Containers'); // azure
    // provider:'aws' resolves each to its aws console identity…
    expect(getServiceMeta('dms', 'aws')).toMatchObject({
      displayName: 'Database Migration Service',
      category: 'Migration & Transfer',
      monogram: 'DMS',
    });
    expect(getServiceMeta('batch', 'aws').category).toBe('Compute');
    // …and provider:'azure' resolves each to its azure identity.
    expect(getServiceMeta('dms', 'azure').displayName).toBe('Database Migration');
    expect(getServiceMeta('batch', 'azure').category).toBe('Containers');
    // 'resource-groups' is identical in both maps — the hint is a no-op for it.
    expect(getServiceMeta('resource-groups', 'aws').displayName).toBe('Resource Groups');
    expect(getServiceMeta('resource-groups', 'azure').displayName).toBe('Resource Groups');
  });
});
