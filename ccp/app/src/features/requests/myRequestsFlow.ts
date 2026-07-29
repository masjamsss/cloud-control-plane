import type { ChangeRequest, Inventory, ServiceManifest } from '@/types';
import type { ApiClient } from '@/lib/api';
import { attempt, type Attempt } from '@/lib/asyncGuard';

/**
 * "My requests" page load, SPA half. Pure, React-free so the FAILURE rule is
 * unit-testable without mounting the page (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/requests/coolingFlow.ts's shape.
 *
 * NEVER REJECTS (FE-2 / UI-1). `listRequests` throws on any non-2xx in api
 * mode (`httpApi.ts`'s `items()`), and a rejected fetch throws too. The page
 * used to `void Promise.all([…]).then(success)` with no `.catch` and cleared
 * `loading` only inside that success branch, so one 401 after an idle-expired
 * session left the requester's primary screen on "Loading…" for ever, with
 * an unhandled rejection and no retry. Returning an {@link Attempt} makes the
 * failure branch impossible to omit at the call site.
 */
export interface MyRequestsData {
  requests: ChangeRequest[];
  manifests: ServiceManifest[];
  inventory: Inventory;
}

export async function loadMyRequestsVia(
  client: Pick<ApiClient, 'listRequests' | 'listManifests' | 'getInventory'>,
  userId: string,
): Promise<Attempt<MyRequestsData>> {
  return attempt(async () => {
    const [requests, manifests, inventory] = await Promise.all([
      client.listRequests(userId),
      client.listManifests(),
      client.getInventory(),
    ]);
    return { requests, manifests, inventory };
  });
}
