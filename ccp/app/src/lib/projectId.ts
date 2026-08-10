/**
 * The project-id slug grammar — the ONE place this pattern is spelled out
 * (ARCH-13: five verbatim copies had drifted into existence — the api's
 * `projects.ts`, `routes/drift.ts`, `routes/projectData.ts`,
 * `domain/drift.ts`, and this file's own former local copy — any future
 * change to the grammar would have needed all five edited in lockstep or
 * path-validation and registration would silently disagree).
 *
 * Lives here, in `@/lib` (not `ccp/api/src/`), because this is the one
 * direction shared code can flow: the api reaches into `ccp/app/src/lib/`
 * via the `@app-lib/*` path alias (see `ccp/api/tsconfig.json`) for
 * browser-safe, dependency-free logic — `@app-lib/redact` already does this
 * for the same reason. The api's `projects.ts` re-exports `PROJECT_ID_RE`
 * from here so its own existing internal importers (`routes/projects.ts`,
 * `deploy.ts`, …) keep working unchanged.
 *
 * Structurally excludes the `'*'` all-projects wildcard binding and the
 * reserved `'@control'` scope — both start with a non-`[a-z]` character, so
 * collision with a registrable project id is impossible by construction.
 */
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
