# Frontend UI Robustness & Accessibility Audit — ccp/app

Audit date: 2026-07-26
Dimension: frontend-ui
Auditor scope: `ccp/app/src` — routing & guards, error boundaries, loading/empty/edge states,
the SchemaForm system, large-list handling, DiffView/FullBlockDiff, CommandPalette & keyboard
interactions, accessibility basics, copy consistency, and CSS architecture.

---

## Scope & method

Static code audit (the sandbox has no `node_modules`, so the vitest suite could not be executed;
CI wiring for the suite and the contrast gate was verified instead). Files read in full or in
targeted depth:

- **Routing/guards/shell**: `src/router.tsx`, `src/components/guards.tsx`, `RouteError.tsx`,
  `NotFound.tsx`, `RouteSkeleton.tsx`, `AppShell.tsx`, `Breadcrumbs.tsx`, `src/main.tsx`,
  `src/lib/legacyRoute.ts`, `src/lib/ProjectContext.tsx`, `src/lib/session.ts`,
  `src/features/projects/ProjectSwitcher.tsx`, `src/features/onboarding/FirstRunPage.tsx`
- **SchemaForm system**: `src/components/SchemaForm/{SchemaForm,Field,BoundsHint,RepeatedBlockField,InventoryPicker}.tsx`,
  `src/lib/{catalog,interpreter,validation,dependsOn}.ts`, `src/types/manifestSchema.ts`,
  `src/features/request/{RequestForm,ReviewStep,ErrorSummary,SchedulePicker,BulkRequestForm}.tsx`
- **Lists/diffs/palette**: `src/features/services/{ServiceConsole,VirtualRows,ResourceRow,ResourceDetail}.tsx`,
  `src/components/{DiffView,FullBlockDiff,useFullBlockDiff,CommandPalette,ActionPicker,Notifications,SearchBar}.tsx`,
  `src/lib/diff.ts` (delta-rendering branches)
- **Features / states**: `src/features/requests/{MyRequests,RequestDetail}.tsx`,
  `src/features/approvals/ApprovalsQueue.tsx`, `src/features/drift/{DriftPage,ImportDrawer}.tsx` (+ drawer grep),
  `src/features/auth/{LoginPage,authFlow}.tsx/ts`, `src/features/account/ReauthDialog.tsx`,
  `src/features/admin/AdminLayout.tsx`
- **Styling/a11y infrastructure**: `src/styles/{tokens,global}.css`, `scripts/check-contrast.mjs`,
  hex-literal grep across all 47 component CSS files, `@media`/reduced-motion greps
- **Tests**: `src/test/copyLint.test.ts` (full), `repeatedBlockField.test.ts` (full),
  `coverage.test.ts` and `motionTokens.test.ts` (heads), CI workflows (`.github/workflows/ccp-app.yml`)
- **Data checks**: a scripted cross-check of every manifest's op targets against
  `awsServiceMap.ts` / `azureServiceMap.ts` and every vendored project inventory, to verify the
  ResourceDetail slug-resolution finding empirically (UI-2 below).

---

## Strengths

This is an unusually disciplined frontend. Concretely:

1. **Design-token architecture with a CI-enforced WCAG gate.** All color lives in
   `src/styles/tokens.css` (light + dark + 5 palettes as value-set layers);
   `ccp/app/scripts/check-contrast.mjs` asserts every declared text pair ≥ 4.5:1 and border pair
   ≥ 3:1 for **every palette × theme**, plus an undeclared-`var()` lint, and it runs as a blocking
   CI step (`.github/workflows/ccp-app.yml:46`). A grep of all 47 component CSS files found exactly
   **one** hardcoded hex outside `styles/` — `login.css:231`, the TOTP QR panel's white background,
   with a comment explaining why it is theme-independent by design. Token comments record the
   history of past contrast regressions (F-05, F-09) that motivated the gate.
2. **Motion discipline**: one tokenized motion ramp (`tokens.css:111-121`), a global
   `prefers-reduced-motion` backstop (`global.css:125-134`), 35 per-component reduced-motion
   blocks, and a `motionTokens.test.ts` lint keeping component CSS on the ramp.
3. **Genuine a11y craft in the interactive core**: skip link + focusable `#main-content`
   (`AppShell.tsx:89, 191`); global `:focus-visible` ring on the accent token (`global.css:66-70`);
   a GOV.UK-style `ErrorSummary` that receives focus on failed review
   (`RequestForm.tsx:251`); a visually-hidden polite live region announcing approve outcomes with
   post-mutation counts (`ApprovalsQueue.tsx:696-702`); combobox/listbox ARIA on `InventoryPicker`
   with `aria-activedescendant` kept pointing at *mounted* rows under virtualization
   (`InventoryPicker.tsx:141-144`); per-item section announcements restored after cmdk groups were
   flattened for windowing (`CommandPalette.tsx:174-182, 304`); pre-paint theme stamping in
   `index.html:18` (no theme flash).
4. **Large-list handling done right, three times, with one library**: `VirtualRows` (console
   groups > 40 rows, measured heights, `overscroll-behavior: contain`, bounded `max-height` at
   `console.css:617-621`), `CommandPalette` (owns filtering with `shouldFilter={false}`, two-stage
   build/filter memoization, `useDeferredValue` + stale dimming), and `InventoryPicker` (windowed
   options panel). One shared `ActionPicker` instance is lifted to the console instead of one
   overlay per row (`ServiceConsole.tsx:229-236`).
5. **Empty/edge states are designed, not defaulted**: distinct `null`-vs-empty load states
   (`ServiceConsole.tsx:118-121`), honest empty catalogs, "No service named X", "No such resource",
   bulk-form degradation for hand-typed URLs (`BulkRequestForm.tsx:299-322`), filter-vs-truly-empty
   distinctions with "Clear filters" (`ApprovalsQueue.tsx:752-771`), and the snapshot-vintage
   header that refuses to claim "Live" (`ServiceConsole.tsx:68-112`).
6. **Manifest failure behavior is fail-loud at the data layer**: every manifest (bundled and
   vendored) passes through a strict zod schema (`types/manifestSchema.ts`, `.strict()` at every
   level, recursive `repeated` support, `dependsOn` refinement), and client/server share the same
   `dependsOn`/bounds predicates (`lib/dependsOn.ts`, `lib/validation.ts`) so the form never shows
   a rule the server won't enforce. Malformed patterns in bounds degrade explicitly
   (`validation.ts:130-137`: "a bad pattern in the manifest is a manifest bug, not a user error").
7. **The copyLint test covers more than most products' style guides**: bans §-notation, proposal/ADR
   refs, account-id shapes, region literals, snake_case in operator-facing fields, raw exposure
   enums, estate-identity tokens, and inventory addresses across manifest prose *and* rendered UI
   string literals with a comment-stripping tokenizer (`test/copyLint.test.ts`), plus chip-label
   and ARN-tail rendering lints against every bundled inventory.
8. **Auth flows are the exception that proves the error-handling rule** — every `authFlow.ts`
   helper try/catches and returns structured outcomes; `LoginPage` handles every interstitial
   (enroll/verify/recovery/forced-change/recovery-codes ceremony) without loops, with labeled
   inputs, `autocomplete` hints, `role="alert"` errors, and a non-QR setup-key fallback for
   screen readers (`LoginPage.tsx:617-633`).

---

## Findings

### UI-1 — Non-admin data pages have no fetch-error path: any API failure leaves a permanent "Loading…" with no message or retry
- **Severity:** high
- **Location:** `ccp/app/src/features/requests/MyRequests.tsx:217-229` (pattern; also
  `ServiceConsole.tsx:130-154`, `RequestDetail.tsx:501-524`, `ApprovalsQueue.tsx:570-593`,
  `RequestForm.tsx:115-126`, `BulkRequestForm.tsx:272-283`, `CommandPalette.tsx:109-132`,
  `Notifications.tsx:99-113`, `DriftPage.tsx:335-346`)
- **Description:** Every non-admin route loads via `void Promise.all([...]).then(...)` with no
  `.catch` and no error state. In api mode `httpApi.request` rejects on any network failure, 5xx
  (`throw new Error(readError(...))` at `httpApi.ts:1138` etc.), or a zod/parse failure
  (`parseManifests` throws from `api.ts:101` for a malformed vendored manifest). The rejection is
  swallowed as an unhandled promise rejection; `loading` stays `true` forever.
- **Impact:** A transient backend blip, an expired session mid-navigation, or one malformed
  manifest turns My requests / a service console / a request form / the approvals queue into an
  eternal "Loading…" with no message, no retry, and nothing in the UI to distinguish it from slow
  data. The admin pages prove the team knows the right pattern — `UsersAdmin.tsx:143`,
  `SettingsAdmin.tsx:102`, `AuditHistory.tsx:45` etc. all `.catch` into an error banner — it simply
  was never applied to the requester/approver surfaces, which are the ones a production incident
  hits first.
- **Recommendation:** Introduce one shared load-state helper (`'loading' | 'error' | 'ready'`) or
  route-level loaders with `errorElement`, and give every fetch effect a `.catch` that renders the
  same error card + retry the admin pages already have. A malformed-manifest parse failure should
  surface its zod message (it is descriptive by design).

### UI-2 — Resource drill-in dead-ends for every "named service" whose slug is not a literal manifest file: all 16 azure-fixture services are broken
- **Severity:** high
- **Location:** `ccp/app/src/features/services/ResourceDetail.tsx:781`
- **Description:** `ServiceConsole` groups ops and resources under *named-service* slugs via
  `catalogServiceKey` and synthesizes a manifest for slugs like `vm`, `sql`, `aks`
  (`ServiceConsole.tsx:156-183`), and each `ResourceRow` links to
  `/services/<slug>/resources/<addr>` (`ResourceRow.tsx:80`). But `ResourceDetail` resolves the
  manifest with a literal `manifests.find((m) => m.service === serviceSlug)` — no
  `catalogServiceKey` fan-in — so any named slug without a same-named manifest file renders
  `status: 'no-service'` → "No service named “vm”" (`ResourceDetail.tsx:811-818`).
  Verified empirically: 194 named services carry ops but no literal manifest slug, and the shipped
  `azure-fixture` project's inventory hits 16 of them (`vm`, `sql`, `aks`, `acr`, `storage-account`,
  `blob`, `key-vault`, `vnet`, `nic`, `disk`, `public-ip`, `resource-groups`, `app-service`,
  `app-service-plan`, `app-insights`, `log-analytics`) — every azure manifest is named
  `azure-compute`/`azure-network`/etc. (none matches a portal slug). The route-resolution half of
  `ResourceDetail` is untested (`resourceDetail.test.ts` only exercises `ResourceDetailView` with
  props).
- **Impact:** In an azure project, clicking any resource row — the console's primary interaction,
  the whole row is the link — lands on a "No service named" dead end. The same trap awaits any AWS
  op fanned into a tile slug without its own manifest file (e.g. the documented ACM-op-on-ALB
  carding under `alb`).
- **Recommendation:** Resolve the manifest in `ResourceDetail` the same way `ServiceConsole` does
  (synthesize from ops whose `catalogServiceKey(op.target.resourceType, m.service) === slug`), or
  extract the console's synthesis memo into a shared `resolveConsoleManifest(slug, manifests)` and
  use it in both. Add a route-level test that walks a ResourceRow href from an azure fixture into
  `ResourceDetail`.

### UI-3 — Primary/admin navigation is built from unscoped absolute paths: current-page indication (aria-current + active styling) never renders, and every nav click detours through a full unmount/redirect
- **Severity:** high
- **Location:** `ccp/app/src/components/AppShell.tsx:74-85` (nav array), `AppShell.css:75,152`
  (dead selectors), `ccp/app/src/features/admin/AdminLayout.tsx:7-17` (admin tabs),
  `ccp/app/src/router.tsx:219,241`
- **Description:** The whole shell lives under `/p/:projectId`, but every `NavLink` uses unscoped
  absolute `to` values (`/`, `/requests`, `/drift`, `/admin/users`, …). React Router computes
  `isActive` against the resolved target, so with the location always `/p/<id>/…` no NavLink is
  ever active: `.shell__link--active`, `.shell__navmenu-item[aria-current='page']`
  (`AppShell.css:75,152`), and `.admin__tab--active` (`AdminLayout.tsx:44`) are permanently dead
  code, and `aria-current="page"` is never emitted anywhere in the top nav, mobile nav menu, or
  admin tab bar. Each click also navigates to the unscoped path, which matches the top-level `*`
  route, unmounts the entire `/p` tree (AppShell included), renders `LegacyRedirect`
  (`router.tsx:74-78, 241`), then remounts everything at the rewritten path — a skeleton flash and
  a full refetch of shell data (Notifications, palette) on every top-nav click. The admin index
  redirect does the same double hop (`router.tsx:220` → `/admin/users` → `*` → rewritten).
- **Impact:** Users get no "where am I" signal in any nav (a WCAG 2.4.8 / SC 1.3.1 regression the
  CSS clearly intends to provide), screen-reader users never hear "current page", and navigation
  is visibly heavier than it needs to be (unmount → redirect → remount).
- **Recommendation:** Render nav targets project-scoped (e.g. build `to={`/p/${projectId}${item.to}`}`
  from `useActiveProjectId()`, or use relative `to` values within the `/p/:projectId` layout). Keep
  `LegacyRedirect` for genuine legacy bookmarks only. Add a test asserting `aria-current="page"`
  appears for the matching nav item.

### UI-4 — Mutation handlers `await` API calls without try/catch: a network failure permanently wedges busy/submitting state
- **Severity:** medium
- **Location:** `ccp/app/src/features/approvals/ApprovalsQueue.tsx:604-625` (approve; also
  `confirmReject` at 642-655), `ccp/app/src/features/request/RequestForm.tsx:277-285` (submit),
  `ccp/app/src/features/requests/RequestDetail.tsx:578-586` (link PR)
- **Description:** The API clients return structured `{ok:false, reason}` for *HTTP-level*
  refusals, but the underlying `fetch` still **rejects** on network failure/timeout. `approve()`
  does `setBusyId(id); const result = await api.approveRequest(id); … setBusyId(null)` — a
  rejection skips `setBusyId(null)`, leaving that card's controls disabled ("busy") until a reload,
  with no error surfaced. `RequestForm.onSubmit` sets `submitting=true` then
  `void api.submitRequest(draft).then(...)` with no catch — the Review step's submit button reads
  "Submitting…" forever. `handleLinkPr` likewise wedges `linkBusy`.
- **Impact:** Under flaky connectivity — exactly when a user retries — the approve/reject/submit
  affordances lock up silently. Data appears lost (the request may or may not have been created).
- **Recommendation:** Wrap each mutation in try/finally (`finally { setBusy(null) }`) and map the
  rejection to the existing inline error slot ("Could not reach the server — check your connection
  and try again"). This is a small, mechanical fix at ~6 call sites.

### UI-5 — RepeatedBlockField renders duplicate DOM ids and a shared radio-group `name` across instances
- **Severity:** medium
- **Location:** `ccp/app/src/components/SchemaForm/Field.tsx:43,118` with
  `ccp/app/src/components/SchemaForm/RepeatedBlockField.tsx:110-149`
- **Description:** `Field` derives `id = field-${param.name}` (and `labelId`/`helpId`/`errorId`
  from it), and the radio-group branch uses that id as the radios' `name` (`Field.tsx:118`).
  `RepeatedBlockField` renders the *same* sub-`Field`s once per instance with no instance prefix,
  so two instances of a repeated block produce duplicate `field-<sub>` ids (labels, help and error
  ids collide; `htmlFor`/`aria-describedby` resolve to the first instance) and — worse — all
  instances' radios share one native radio group: the browser enforces single-checked across the
  document per `name`, so with instance 1 = `tcp` and instance 2 = `udp`, only one instance can
  ever *display* its checked state, and arrow keys walk across instances. The codebase already
  documents this exact hazard class and its fix for `SchedulePicker`
  (`SchedulePicker.tsx:9-20`: "must be unique among every SchedulePicker … or the native radio
  grouping collides") but `Field` inside repeated blocks never got the same treatment.
  `repeatedBlockField.test.ts` renders two instances (lines 151-164) yet never asserts id
  uniqueness. Mitigating factor: no *shipped* manifest currently declares `repeated`
  (verified by grep over `src/data`; generated provision forms map repeated blocks to a JSON
  textarea instead, `providerCatalogGen.ts:876`), so the defect is latent until the first
  manifest uses the feature it was built for.
- **Impact:** The first repeated-block op with an allowlist sub-field of ≤ 7 options ships a form
  where selections visually vanish across instances and assistive tech reads the wrong
  label/help/error; duplicate ids are an outright HTML validity/a11y failure.
- **Recommendation:** Thread an `idPrefix` (e.g. `${param.name}.${index}`) from
  `RepeatedBlockField` into `Field` and use it for `id` and the radio `name`. Add an SSR test
  asserting no duplicate `id=` in a two-instance render.

### UI-6 — Hand-rolled drift drawers are dialogs in name only: no aria-modal, no focus move, no focus trap, no Escape
- **Severity:** medium
- **Location:** `ccp/app/src/features/drift/ImportDrawer.tsx:70-84` (also
  `LegitimizeDrawer.tsx:78`, `ProposalDrawer.tsx:149`, `RestoreDrawer.tsx:95`;
  `ccp/app/src/features/account/ReauthDialog.tsx:139-146` partially)
- **Description:** The four drift drawers render `role="dialog"` over a click-to-close backdrop
  but: no `aria-modal`, no initial focus move into the drawer, no focus trap, no Escape handling,
  and no focus restoration on close — the page behind stays fully tab-reachable and
  screen-reader-browsable behind the visual overlay. `ReauthDialog` is better (`aria-modal="true"`,
  `autoFocus` on the input) but still lacks the trap, Escape, and focus return to its trigger.
  This contrasts sharply with the rest of the app, which correctly delegates overlay behavior to
  Radix (dropdowns, popover) and cmdk (palette dialogs) — the drift feature re-implemented the
  primitive by hand.
- **Impact:** Keyboard users tab "through" the modal into the obscured page; screen-reader users
  are not informed the rest of the page is inert (it isn't); Escape — the universally expected
  dismissal — does nothing. On the drift surfaces several drawers can be open in sequence during
  a resolution workflow, compounding the confusion.
- **Recommendation:** Reuse `@radix-ui/react-dialog` (Radix is already a dependency) or add a
  small shared `useModal` (focus trap + Escape + `aria-modal` + focus return). One shared fix
  covers all five surfaces.

### UI-7 — ErrorSummary links are dead anchors for radio-group and repeated-block fields
- **Severity:** medium
- **Location:** `ccp/app/src/features/request/ErrorSummary.tsx:40` with
  `ccp/app/src/components/SchemaForm/Field.tsx:102-129` and `RepeatedBlockField.tsx:72-83`
- **Description:** The error summary links to `#field-<name>` for every failing param. Text
  inputs, selects, toggles and the `InventoryPicker` input all carry `id={`field-${name}`}` — but
  the radio-group branch renders **no element** with that id (the string is used only as the
  radios' `name`), and `RepeatedBlockField` renders a `<fieldset>` with no id at all. For those
  params the summary link scrolls/focuses nothing.
- **Impact:** The flagship a11y affordance (focus-the-error) silently no-ops for exactly the
  field types that are hardest to locate visually — a failed segmented control or a repeated block
  with "one or more entries need attention".
- **Recommendation:** Put `id={id}` on the radiogroup wrapper `div` and on the repeated
  `<fieldset>` (both are focus-targetable with `tabIndex={-1}`), or anchor to the first control of
  the group.

### UI-8 — DiffView corrupts `~` change lines whose old value contains " -> "
- **Severity:** medium
- **Location:** `ccp/app/src/components/DiffView.tsx:30-40` (with `lib/diff.ts:91`)
- **Description:** `generateDiff` emits `~ attr = JSON.stringify(old) -> JSON.stringify(new)`.
  `toRows` re-parses that line by `body.split(' -> ')` and takes `parts[0]`/`parts[1]` only. If the
  *old value itself* contains `" -> "` (a description, a tag value, a name — all requester/estate
  data), the split yields ≥ 3 parts: the rendered removal shows a truncated old value and the
  rendered addition shows a *fragment of the old value* while the actual new value is silently
  dropped. The add/del branches also re-`trim()` content (`DiffView.tsx:43,47`), discarding the
  generator's alignment inside nested blocks.
- **Impact:** The review artifact — the thing a human approves — can misrepresent both sides of a
  change for pathological-but-legal attribute values. Low probability, but this is the one surface
  where display fidelity is the product's core promise.
- **Recommendation:** Split on the **last** `' -> '` (`body.lastIndexOf(' -> ')`), or better,
  have `generateDiff` emit structured rows (it already knows old/new) and let `DiffView` render
  them without re-parsing its own serialization.

### UI-9 — `/login`, `/onboarding`, and the LegacyRedirect route have no errorElement: a render error there shows React Router's raw default error screen
- **Severity:** medium
- **Location:** `ccp/app/src/router.tsx:94-110,241`
- **Description:** Only the `/p/:projectId` route carries `errorElement: <RouteError />`
  (`router.tsx:115`). A throw during `LoginPage`, `FirstRunPage` (or its lazy-chunk load failure —
  a stale deployment's 404'd chunk rejects the `lazy()` promise and propagates as a route error),
  or the `LegacyRedirect` render falls through to React Router's built-in "Unexpected Application
  Error" page — unstyled, off-brand, with a stack trace in dev.
- **Impact:** The two entry surfaces users hit *before* the app shell — sign-in and first-run —
  are exactly the ones with the least protection; a chunk-load failure after a redeploy lands new
  users on a raw error page.
- **Recommendation:** Add a top-level `errorElement: <RouteError />` on the router root (one line
  covers all three), and consider a retry-on-chunk-failure wrapper for the lazy routes.

### UI-10 — Request-status copy has four competing sources; raw enum text can reach the UI
- **Severity:** low
- **Location:** `ccp/app/src/components/ui/StatusBadge.tsx:17-51`,
  `ccp/app/src/features/requests/MyRequests.tsx:50-53`,
  `ccp/app/src/features/approvals/ApprovalsQueue.tsx:110-113`, `ccp/app/src/lib/palette.ts:100-102`,
  `ccp/app/src/components/Notifications.tsx:62`
- **Description:** `StatusBadge` owns a curated label map ("Awaiting review", "No change",
  "Cooling off"), but `humanizeStatus` is duplicated in three files as a mechanical
  underscore-to-space transform, producing different words for the same state right next to the
  badge ("Awaiting code review", "Noop", "Approved cooling" in the filter dropdowns and palette
  hints). `Notifications.ownNote`'s default branch renders the raw enum (`· ${req.status}` →
  "· CHECKS_RUNNING"). The copyLint suite cannot catch any of this — these are derived strings,
  not literals — so the "one fact, one phrasing" doctrine the codebase states elsewhere
  (AppShell freeze banner comment) is unenforced for statuses.
- **Impact:** Inconsistent vocabulary in adjacent UI; a raw SCREAMING_SNAKE token in the
  notifications bell for in-flight statuses.
- **Recommendation:** Export the `STATUS_SPEC` labels from `StatusBadge` (or a `lib/statusCopy.ts`)
  and delete the three `humanizeStatus` clones; route the Notifications default branch through it.

### UI-11 — Nested repeated blocks skip their instance-count bounds
- **Severity:** low
- **Location:** `ccp/app/src/lib/catalog.ts:579-585` (vs. `lib/interpreter.ts:150-163`)
- **Description:** Top-level repeated params validate `bounds.minItems/maxItems` in
  `validateParams`, but `repeatedInstanceErrors`' recursion for a *nested* repeated sub-field only
  checks per-instance sub-field validity — a nested block with `minItems: 2` and one row passes.
  The Add/Remove buttons enforce the same counts interactively (`RepeatedBlockField.tsx:62-65`),
  which masks the gap unless a value arrives programmatically (request-again seeding, drafts).
- **Impact:** The client submit gate is weaker than intended for one nesting level; the server-side
  twin (which shares the same helper per the comments) inherits the same blind spot.
- **Recommendation:** In `repeatedInstanceErrors`' `f.repeated` branch, apply the same
  min/maxItems checks `validateParams` applies at the top level before recursing.

### UI-12 — Configure ⇄ Review step transitions never move focus, and the Suspense skeleton is silent for assistive tech
- **Severity:** low
- **Location:** `ccp/app/src/features/request/RequestForm.tssx:254-256` (`setStep('review');
  window.scrollTo(...)` — no focus target), `ccp/app/src/components/RouteSkeleton.tsx:9`
- **Description:** A successful "Review request" swaps the whole page content; keyboard focus dies
  on the unmounted button (falls to `<body>`), and nothing announces the step change. "Back to
  edit" has the same gap. The invalid path is handled well (focus → ErrorSummary) — only the happy
  path was missed. Separately, `RouteSkeleton` is `aria-hidden` with no `aria-busy`/live "Loading"
  text anywhere, so lazy-route loads are a silent void for screen-reader users.
- **Impact:** Screen-reader and keyboard users lose context at the most important transition in
  the funnel.
- **Recommendation:** Focus the review `<h1>` (`tabIndex={-1}`) on step change, mirror on the way
  back; give the skeleton's container `role="status"` + visually-hidden "Loading page…" text.

### UI-13 — RepeatedBlockField keys instances and touched-state by array index: state misattributes after a mid-list removal
- **Severity:** low
- **Location:** `ccp/app/src/components/SchemaForm/RepeatedBlockField.tsx:94,111-116`
- **Description:** Instances render with `key={i}` and sub-field touched flags are stored as
  `\`${i}.${sub.name}\``. Removing instance 0 shifts every later instance down one index: their
  touched flags (and React state identity) now belong to the wrong rows — a previously-blurred
  field on the removed row reveals errors on its successor. Entries are never cleaned on remove.
- **Impact:** Cosmetic-to-confusing error reveals in multi-instance editing; no data corruption
  (values live in the array itself).
- **Recommendation:** Key rows by a generated per-instance id (`seedRepeatedInstance` could attach
  a symbol/uuid held outside the submitted record), or reindex `subTouched` inside `remove()`.

### UI-14 — InventoryPicker: an optional single-select can never be cleared
- **Severity:** low
- **Location:** `ccp/app/src/components/SchemaForm/InventoryPicker.tsx:110-123,240-244`
- **Description:** Once an address is committed, the input renders the selection; typing opens the
  query but Escape/blur restores the committed value and nothing offers "no selection". For an
  optional `source:"inventory"` param the only way back to empty is reloading the form. (Minor
  adjacent nit: `aria-controls={listId}` is present even while the listbox is not in the DOM.)
- **Impact:** Users can't undo an optional pick; small spec-conformance nit on the combobox.
- **Recommendation:** Add a clear affordance (an "×" button, or commit-empty when the query is
  cleared and Enter is pressed) for non-required params; set `aria-controls` only while open.

### UI-15 — CommandPalette data is fetched once per shell mount, so "My requests" rows go stale within a session
- **Severity:** low
- **Location:** `ccp/app/src/components/CommandPalette.tsx:109-132`
- **Description:** Manifests/inventory/requests load in a `[user, projectId]` effect. The palette
  never refetches on open — a request submitted two minutes ago is absent, and an approved one
  keeps its old status in palette hints until a project/user change. `Notifications` fixed exactly
  this by keying its effect on `open` (`Notifications.tsx:99-113`, comment "UIUX-13"); the palette
  didn't get the same fix. Manifests/inventory are legitimately static; the requests slice is not.
- **Impact:** Mildly wrong search results in long-lived sessions; inconsistent with the bell one
  icon over.
- **Recommendation:** Re-run the requests fetch when `open` flips true (keep the heavy
  manifest/inventory memo as-is).

---

## Minor observations

- **Allowlist select with a persisted-but-narrowed value renders blank** — the stored value stays
  in state and is correctly *flagged* by validation (`interpreter.ts:179-187`), but the `<select>`
  shows the placeholder row while holding an invisible value (`Field.tsx:130-147`). An explicit
  "(currently restricted) — <value>" disabled option would be more honest.
- **A radio-group whose admin-narrowed allowlist is empty renders an empty control** with no
  explanatory copy (`Field.tsx:102-129`); the select branch at least shows "— select —".
- **`Field`'s fallback `resolveEnum` calls omit `operationId`** (`Field.tsx:52,65`), skipping
  admin allowlist narrowing — currently unreachable (both call sites pass `options`), but a trap
  for a future direct `Field` consumer.
- **FullBlockDiff's "After" pane numbers lines from the original start line** (`FullBlockDiff.tsx:56-57`)
  — once the after-block's length differs, numbers past the change are notional; fine for a
  learning view, worth a tooltip note.
- **`useFullBlockDiff` / `getBlockSource` promise has no rejection handler**
  (`useFullBlockDiff.ts:25-32`) — falls back to null (correct UX) but leaks an unhandled rejection.
- **Raw fetch errors surface verbatim on login** — a network failure during `apiLogin` shows the
  browser's "Failed to fetch" as the error text (`authFlow.ts:66`); a friendlier mapping would help.
- **`ownNote`'s `notif__count` badge** counts the (already capped-at-8) merged list — fine, but the
  cap means "8" is really "8+"; consider `8+` copy.
- **`navigator.platform`** (`AppShell.tsx:28`) is deprecated; harmless, prefer
  `navigator.userAgentData?.platform` with fallback.
- **Render-phase ambient-scope write in `ProjectProvider`** (`ProjectContext.tsx:58-66`) is
  well-documented and fenced (`'use no memo'`), but remains a purity exception that concurrent
  rendering could someday surprise; the inline decision record is exactly the right mitigation
  short of a refactor.
- **CSS architecture is sustainable**: 47 files, strict BEM-ish prefixes per feature, tokens-only
  color (verified by grep), 63 media queries, shared primitives (`ui.css`, `command-palette.css`
  reused by ActionPicker). The one systemic risk is that shared class contracts cross files by
  convention (e.g. ActionPicker consuming `.cmdp__*`), with `motionTokens.test.ts` and
  `check-contrast.mjs` as the only mechanical guards — acceptable at this scale.
- **copyLint coverage vs. reality**: excellent for authored prose and literals; blind (by nature)
  to *derived* strings — UI-10's status divergence and Notifications' raw enum are precisely the
  class it cannot see. A tiny unit test pinning "status labels come from STATUS_SPEC" would close
  the gap.

---

## Overall grade: B

The craft level here is far above typical internal-tool frontends: a token system with a
CI-enforced contrast gate across five palettes and two themes, disciplined virtualization,
designed empty states, a strict zod boundary on manifest data, real live-region and
focus-management work, and a copy-lint suite with teeth. But three high findings keep it out of
the A range: the entire non-admin surface can hang on "Loading…" forever with no error path
(UI-1), the resource drill-in — the console's primary interaction — dead-ends for every named
azure service in the shipped fixture (UI-2), and current-page indication is structurally dead in
every navigation surface while each nav click pays a full unmount/redirect cycle (UI-3). All
three are systemic-pattern fixes rather than deep rewrites; landing UI-1..UI-4 would move this
to an A−.
