import { createBrowserRouter } from 'react-router-dom';
import { routeConfig } from '@/routeConfig';
import { legacyPathToProjectPath } from '@/lib/legacyRoute';

export { legacyPathToProjectPath };

/**
 * The actual browser router — `createBrowserRouter` reaches for
 * `window`/`history` immediately, so this file (unlike `routeConfig.tsx`,
 * its data) can only ever be imported in a real browser. See
 * `routeConfig.tsx` for the route tree itself and the UI-9 rationale for
 * its root `errorElement`; see `test/routeConfig.test.ts` for the
 * structural regression test over that data.
 */
export const router = createBrowserRouter(routeConfig);

export default router;
