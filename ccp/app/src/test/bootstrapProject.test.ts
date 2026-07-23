import { afterEach, describe, expect, it } from 'vitest';
import { listProjects } from '@/lib/projectRegistry';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { api } from '@/lib/api';
import { getBlockSource } from '@/lib/blockSource';
import { redactHcl } from '@/lib/redact';
import bootstrapBlockIndex from '@/data/projects/bootstrap/blocks/index.json';
import bootstrapBlocksS3 from '@/data/projects/bootstrap/blocks/s3.json';
import bootstrapBlocksKms from '@/data/projects/bootstrap/blocks/kms.json';
import bootstrapBlocksIam from '@/data/projects/bootstrap/blocks/iam.json';
import type { BlockSource } from '@/lib/blockSource';

/**
 * R3 §5.4b — the vendored `bootstrap` sample project: a second, synthetic
 * estate under src/data/projects/bootstrap/ (see projectRegistry.ts's
 * three-tier resolution), proving the manifests/inventory/blocks path works
 * end to end for a project other than the bundled sample. Minimal — mirrors
 * the bootstrap-specific assertions projectRegistry.test.ts already makes
 * for discoverability/manifests/inventory, plus the blocks piece that has no
 * other coverage.
 */

afterEach(() => {
  setProjectScopeForTests('sample');
});

const blockChunks: Record<string, Record<string, BlockSource>> = {
  s3: bootstrapBlocksS3,
  kms: bootstrapBlocksKms,
  iam: bootstrapBlocksIam,
};

describe('bootstrap project — vendored end to end (R3 §5.4b)', () => {
  it('is discoverable in the project registry', async () => {
    const projects = await listProjects();
    const bootstrap = projects.find((p) => p.id === 'bootstrap');
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.name).toBe('Bootstrap — importer sandbox');
  });

  it('its manifests load — exactly iam, kms, and s3', async () => {
    setProjectScopeForTests('bootstrap');
    const manifests = await api.listManifests();
    expect(manifests.map((m) => m.service).sort()).toEqual(['iam', 'kms', 's3']);
  });

  it('its inventory is non-empty and every resource is s3/kms/iam', async () => {
    setProjectScopeForTests('bootstrap');
    const inventory = await api.getInventory();
    expect(inventory.resources.length).toBeGreaterThan(0);
    expect(inventory.resources.every((r) => ['s3', 'kms', 'iam'].includes(r.service ?? ''))).toBe(
      true,
    );
  });

  it('every blocks/index.json key resolves to a real chunk + block', () => {
    for (const [address, chunkKey] of Object.entries(
      bootstrapBlockIndex as Record<string, string>,
    )) {
      const chunk = blockChunks[chunkKey];
      expect(chunk, `chunk "${chunkKey}" for ${address}`).toBeDefined();
      expect(chunk?.[address], `block for ${address} in chunk "${chunkKey}"`).toBeDefined();
    }
  });

  it('no vendored block chunk carries a leak the redacting extractor would have masked', () => {
    for (const chunk of Object.values(blockChunks)) {
      for (const [address, block] of Object.entries(chunk)) {
        expect(redactHcl(block.source), `already-redacted: ${address}`).toBe(block.source);
      }
    }
  });

  it('blockSource resolves at least one committed block for the bootstrap project', async () => {
    setProjectScopeForTests('bootstrap');
    const block = await getBlockSource('aws_s3_bucket.state');
    expect(block).toBeTruthy();
    expect(block?.source).toMatch(/^resource "aws_s3_bucket" "state"/);
  });
});
