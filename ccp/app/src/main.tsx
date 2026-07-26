import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

// NO app-wide ProjectProvider here on purpose. A global provider with no
// `:projectId` resolves the bundled SAMPLE estate and writes it to the ambient
// scope (projectScope.ts) at boot — which then rides on EVERY request as
// `x-ccp-project: sample`, including the very first `/auth/login`. On a fresh
// real backend there is no `sample` project, so the server (correctly) rejects
// that header with 422 and the first admin can never sign in. Blank-first is
// the data-birth contract: `/login` and the first-run screen are PRE-estate and
// must stay unscoped so no project header rides (the server then applies its
// header-less `@control` default). Project context is supplied per route by
// `ProjectRoute`'s `<ProjectProvider projectId={…}>` under `/p/:projectId`,
// which is the only subtree where `useProject()` is called.
createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
