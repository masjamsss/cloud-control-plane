import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectProvider, resolveActiveProject } from '@/lib/ProjectContext';
import { setProjectScopeForTests } from '@/lib/projectScope';
import { ProjectSwitcher } from '@/features/projects/ProjectSwitcher';
import { api } from '@/lib/api';
import { deriveServiceCatalog } from '@/lib/catalog';
import { validateBeyondCatalogInput, type BeyondCatalogInput } from '@/lib/beyondCatalog';
import type { CloudProvider } from '@/lib/providerDisplay';

/**
 * 0039 S1 lane G: the first REAL azure project fixture, proving the whole
 * portal path renders honestly end to end — not a hardcoded provider literal
 * fed into a unit function (that's Lane C's own beyondCatalog.test.ts), but a
 * real vendored project.json a user could actually switch to.
 *
 * This repo has no jsdom/RTL (see useActiveProjectId.test.ts's docblock), so
 * "renders" here means the same thing it means in every other page-level test
 * in this suite (notInControlPlane.test.ts, beyondCatalogForm.test.ts):
 * renderToStaticMarkup under MemoryRouter for anything resolved DURING render
 * (ProjectProvider uses useMemo, not useEffect — see ProjectContext.tsx), and
 * the real async/data-fetching seam (api.ts) called directly for anything a
 * page would otherwise only reach via a useEffect that SSR never commits.
 */

const FIXTURE_ID = 'azure-fixture';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  setProjectScopeForTests('sample');
});

function azureBeyondCatalogInput(overrides: Partial<BeyondCatalogInput> = {}): BeyondCatalogInput {
  return {
    kind: 'new_resource_uncatalogued',
    service: 'storage',
    resourceType: 'azurerm_storage_account',
    workload: 'Static asset storage for the fixture workload under test.',
    connectivity: 'vpc-internal',
    dataClassification: 'confidential',
    summary: 'An azurerm_storage_account for the azure fixture project catalog test.',
    justification:
      'Proves the beyond-catalog form accepts azurerm_* resource types once the active project genuinely carries provider: azure.',
    ...overrides,
  };
}

describe('azure fixture project — the portal path renders honestly (0039 S1 lane G)', () => {
  it('assertion 1: the switcher header renders the azure fixture project’s own name (no provider-conditional header exists yet)', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProjectProvider projectId={FIXTURE_ID}>
          <ProjectSwitcher />
        </ProjectProvider>
      </MemoryRouter>,
    );
    const project = resolveActiveProject(FIXTURE_ID);
    expect(project.provider).toBe('azure');

    // ProjectSwitcher's own listProjects() effect never commits under SSR, so
    // it deterministically renders the plain identity chip — the project's
    // name, with "name · owner/repo · region" as the tooltip title (F-19: the
    // name leads so a hover always recovers whatever the chip's own ellipsis
    // truncated, ahead of the repo/region detail it already carried). This
    // only proves the fixture's OWN name renders (the name happens to carry
    // Lane A's Azure vocabulary, but ProjectSwitcher has no provider-conditional
    // header of its own — a possible S3 UI item, not built here): asserting on
    // "Azure" / "subscription" would be pinning the fixture's prose, not the
    // component.
    expect(html).toContain(project.name);
    expect(html).toContain(
      `title="${project.name} · ${project.github.owner}/${project.github.repo} · ${project.region}"`,
    );
  });

  it('assertion 2: the services page still renders the honest empty-catalog state (zero manifests) even though the fixture now carries a real inventory (turnkey-onboarding lane)', async () => {
    // resolveActiveProject both proves the fixture is genuinely REGISTERED
    // (not just an unknown id — api.ts's empty-catalog fallback would look
    // identical for either, see projectRegistry.test.ts's "entirely unknown
    // project id" case) and sets the ambient scope api.ts reads at call time.
    const project = resolveActiveProject(FIXTURE_ID);
    expect(project.id).toBe(FIXTURE_ID);

    const manifests = await api.listManifests();
    const inventory = await api.getInventory();

    // No azurerm manifests are vendored for this project — still correct, and
    // untouched by the turnkey-onboarding lane (manifests stay bundle-global,
    // never per-project — see azureCatalogFlow.test.ts). Never another
    // project's estate leaking through under this project's name
    // (projectRegistry.test.ts pins that resolution rule for the injected case).
    expect(manifests).toEqual([]);
    // The fixture DOES now carry a real vendored inventory.json (a just-imported
    // subscription's representative landing zone — makes every catalog op's
    // inventory picker resolve once a project also vendors manifests; see
    // azureOnboardTurnkey.test.ts for the live-picker proof). A specific,
    // known resource — not a brittle exact count another lane's fixture edits
    // could shift — is enough to prove this is the REAL file, not another
    // project's data leaking through.
    expect(inventory.resources.length).toBeGreaterThan(0);
    expect(inventory.resources).toContainEqual(
      expect.objectContaining({ address: 'azurerm_resource_group.core_rg' }),
    );

    // The exact derivation ServiceCatalog.tsx feeds its `visibleGroups` from —
    // zero MANIFESTS means zero groups regardless of inventory size, the
    // precondition for its `manifests.length === 0` branch (deriveServiceCatalog
    // filters by manifest first — see lib/catalog.ts).
    expect(deriveServiceCatalog(manifests, inventory)).toEqual([]);

    // Pin the branch itself + its exact honest copy (this repo has no
    // jsdom/RTL to mount ServiceCatalog and watch its useEffect-driven fetch
    // resolve — same source-inspection technique notInControlPlane.test.ts
    // uses for router.tsx's registration).
    const source = readFileSync(join(SRC, 'features/catalog/ServiceCatalog.tsx'), 'utf8');
    expect(source).toContain('manifests.length === 0');
    expect(source).toContain('This account’s data hasn’t been loaded yet.');
  });

  it('assertion 3: the beyond-catalog form accepts azurerm_storage_account under the fixture project', () => {
    const project = resolveActiveProject(FIXTURE_ID);

    // The EXACT derivation BeyondCatalogForm.tsx uses (0039 S1 lane C): an
    // absent `provider` means aws. Before this fixture, every test exercising
    // this path fed the validator a hardcoded 'azure' literal — this is the
    // first REAL project object making that path real.
    const provider: CloudProvider = (project as { provider?: CloudProvider }).provider ?? 'aws';
    expect(provider).toBe('azure');

    const errors = validateBeyondCatalogInput(azureBeyondCatalogInput(), undefined, provider);
    expect(errors).toEqual({});
    expect(errors.resourceType).toBeUndefined();

    // Symmetrically: the aws default (every project before this seam) still
    // refuses an azurerm_* type — proving the seam is real, not a rubber stamp.
    const awsErrors = validateBeyondCatalogInput(azureBeyondCatalogInput(), undefined, 'aws');
    expect(awsErrors.resourceType).toBeTruthy();
  });
});
