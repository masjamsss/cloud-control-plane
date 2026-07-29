# Frontend State & Data-Flow Correctness Audit — ccp/app

**Dimension:** frontend-flows · **Audit date:** 2026-07-26 · **Finding prefix:** FE

---

## Scope & method

Read in full (or in all state-bearing sections):

- **State layer:** `ccp/app/src/lib/useStore.ts`, `lib/session.ts`, `lib/auth.ts`, `lib/apiSession.ts`, `lib/settings.ts`, `lib/projectScope.ts`, `lib/ProjectContext.tsx`, `lib/serverInfo.ts`, `lib/permissions.ts`, `lib/changeSet.ts` (selection helpers), `lib/pendingChanges.ts` (reactivity surface only)
- **API clients:** `lib/api.ts` (all 1,757 lines: mock client, seams, singleton wiring), `lib/httpApi.ts` (all 2,036 lines: request plumbing, error taxonomy, every endpoint method)
- **Flow modules:** `features/auth/authFlow.ts`, `features/requests/coolingFlow.ts`, `features/requests/windowFlow.ts`, `features/drift/proposalFlow.ts`, `features/drift/driftActionsFlow.ts`, `features/drift/driftProposalState.ts`, `features/account/accountFlow.ts`, `features/admin/{settingsFlow,usersFlow,pendingChangesFlow,auditFlow,projectsFlow (export surface)}.ts`
- **Stateful pages:** `features/request/RequestForm.tsx` + `ReviewStep.tsx`, `features/request/BulkRequestForm.tsx` / `ProvisionService.tsx` (submit paths), `features/approvals/ApprovalsQueue.tsx` + `approveError.ts`, `features/requests/RequestDetail.tsx`, `features/requests/MyRequests.tsx`, `features/drift/DriftPage.tsx` + `DriftPanel.tsx` + `ResolutionFlow.tsx` (partition), `features/auth/LoginPage.tsx`, `features/account/AccountSecurityPage.tsx` (async call sites), `features/admin/{UsersAdmin,SettingsAdmin,AuditHistory,PendingChanges,ProjectsAdmin (state/polling sections)}.tsx`, `features/dashboard/LeadDashboard.tsx`, `components/{AdvisoryGate,PendingChangesBanner,Notifications,AccountMenu,guards,CommandPalette,useFullBlockDiff}.tsx/.ts`, `main.tsx`
- **Server cross-check:** `ccp/api/src/routes/requests.ts` (OPEN_STATUSES, approve/reject/cancel/rewindow transitions, `scope=pending` semantics) and `routes/admin.ts` (audit paging) to verify the client mirrors the API state machine.

Method: manual code reading with the API's own routes as ground truth for lifecycle mirroring; grep sweeps for every fire-and-forget promise (`void api.*`, `void load*`, `.then(` without `.catch`), every timer, and every `useEffect` staleness guard. The vitest suite was **not** executed (node_modules is not installed in this checkout — `npx vitest run` fails at config load with `ERR_MODULE_NOT_FOUND: vite`); all claims below are anchored in code actually read.

---

## Strengths

This frontend is unusually disciplined about state, and it's worth naming precisely:

- **A real external-store architecture.** `lib/useStore.ts` is a tiny, correct `useSyncExternalStore` toolkit: same-tab emitter + cross-tab `storage` listener composed per store (`subscribeWithStorage`, `useStore.ts:64-79`), `clear()`-in-another-tab handled (`e.key === null`, line 70), and multi-source snapshots via `combineSubscriptions` (line 87). `lib/settings.ts:247-286` and `lib/session.ts:35-69` both cache snapshots by value so `getSnapshot` is `Object.is`-stable — the exact contract React demands, documented in place.
- **Per-flow authority honesty.** `lib/serverInfo.ts` + `components/AdvisoryGate.tsx` gate every admin write on a per-flow capability rather than a blanket "authoritative" bit, with a safe pre-load default (`INITIAL_SERVER_INFO_STATE`, AdvisoryGate.tsx:53) so controls never flash armed. `AdminWriteOutcome` (`httpApi.ts:295`) makes it impossible to confuse a 202-proposed dual-control write with an applied one, and every admin screen renders the distinction (`usersFlow.ts:201-205`).
- **Pure, testable flow modules.** The `*Flow.ts` layer (auth, cooling, window, drift proposal, account, all admin flows) is genuinely React-free and unit-tested (`test/authFlow.test.ts`, `test/usersFlow.test.ts`, `test/accountFlow.test.ts`, `test/driftResolutionFlow.test.tsx` exist and are substantial). Components stay thin wrappers.
- **Lazy-settlement honesty on 409.** `coolingFlow.ts:46-54` and `windowFlow.ts:77-99` re-fetch the request on `STATE_CONFLICT` and hand the true current state back to `RequestDetail` (`RequestDetail.tsx:531-559`), so a cancel that raced the lazy cooling/window settlement shows reality instead of a stale "still cooling" view. This is a model pattern.
- **Mutation-result patching instead of blind refetch.** `applyMutatedRequestToList` (`ApprovalsQueue.tsx:151-158`) is pure, exported, and uses the mutation's own returned `ChangeRequest` — including the server's tighten-only re-gated `approvalsRequired` — and the aria-live announcement uses the mutation's own counts (`approvalLadder.ts:195-199`), never stale pre-mutation state.
- **The drift binding invariant is re-derived client-side.** `driftProposalState.ts:37-48,96-109` classifies from the verdict/finding's own fields, never a proposal's `flavor` label, so a security-posture row structurally cannot render an adopt affordance — defense in depth mirroring the server.
- **Project-switch hygiene on most pages.** `ServiceConsole.tsx:130-154`, `ServiceCatalog.tsx:49-62`, `DriftPage.tsx:335-344`, `RequestDetail.tsx:501-524`, `MyRequests.tsx:217-233` all key fetch effects on `useActiveProjectId()`, reset to loading first, and guard `setState` behind an `alive`/`active` flag checked *inside* the `.then`. `DriftPage.tsx:346-385` resets every drawer/selection on switch so a stale digest can never be submitted cross-project.
- **Lifecycle typing is compile-enforced.** `RequestDetail.tsx:85-114`'s `NORMAL_MAP` is a `Record<RequestStatus, …>`, so a new API status is a type error, not a silent render hole; `StatusBadge.tsx` covers `APPROVED_COOLING`/`CANCELLED`/`WINDOW_EXPIRED`.
- **ProjectsAdmin's scan-job polling** (`ProjectsAdmin.tsx:673-703`) is exemplary: polls only while the tab shows and the job is non-terminal, single initial read, `alive` flag + `clearInterval` cleanup, terminal-state registry refresh, `.catch` on every read.
- **Careful data-birth scoping.** `main.tsx:14-24` deliberately keeps `/login` unscoped so no bogus `x-ccp-project` header rides pre-estate calls; `httpApi.ts:1109-1117` reads the ambient scope at call time.

---

## Findings

### FE-1 · HIGH · Mutation calls have no rejection path — a network failure strands the acting control in a permanent busy state

**Location:** `ccp/app/src/features/request/RequestForm.tsx:277`; also `features/request/BulkRequestForm.tsx:136`, `features/request/ProvisionService.tsx:310`, `features/services/ResourceDetail.tsx:654`, `features/approvals/ApprovalsQueue.tsx:608,646`, `features/requests/RequestDetail.tsx:530,551,565,582`, `features/drift/DriftPage.tsx:448,472,502,526,549,575,604,632,662`

**Description.** Every governed mutation on the requester/approver/drift surfaces is fired as `void api.X(...).then(result => …)` with no `.catch`, or `await`ed with no `try/catch`. The HTTP client maps non-2xx *responses* into `{ok:false}` results, but a **rejected fetch** — network drop, DNS failure, proxy error, server unreachable — propagates as a promise rejection (`httpApi.ts:1096-1118`: `request()` simply awaits `doFetch`). In that case the success/failure branch never runs, so:

- `RequestForm.onSubmit` sets `setSubmitting(true)` at line 270 and only resets it inside the `.then` — the review page's submit button reads "Submitting…" forever (`ReviewStep.tsx:300` disables on `submitting`).
- `ApprovalsQueue.approve/confirmReject` set `setBusyId(id)` (lines 606, 644) and reset it only after the awaited call — the card's Approve/Reject stay disabled forever, with no error line.
- `RequestDetail`'s cancel/rewindow/link-PR handlers set `cancelBusy`/`rewindowBusy`/`linkBusy` and never recover. Note `cancelRequestVia`/`rewindowRequestVia` can also throw from their *internal refetch* (`coolingFlow.ts:50`, `windowFlow.ts:81,96` — `client.getRequest(id)` throws on any non-404 error), so even the 409 honesty path has an unhandled failure mode.
- `DriftPage`'s check/generate/submit handlers strand `checkState:'requesting'`, `generateState:'generating'`, or a drawer's `submitting` — the operator buttons stay disabled until a full page reload.

**Impact.** Under ordinary production conditions (a Wi-Fi blip, a rolling API deploy), the user's action silently dies: the UI shows a spinner-button forever, no error is rendered, and the only recovery is a reload — which for RequestForm discards a fully drafted request. Every one of these is also an unhandled promise rejection in the console.

**Recommendation.** Add a shared wrapper (e.g. `runMutation(setBusy, setError, fn)`) that `finally`-resets the busy flag and maps a thrown error to a generic retryable message. The admin surfaces already do exactly this (`UsersAdmin.tsx:525-537` wraps every action in `try/catch/finally`); the fix is applying the same discipline to the request/approval/drift pipeline, which is the product's core.

---

### FE-2 · HIGH · Initial page loads have no error state — any failed fetch leaves an eternal "Loading…" with no retry

**Location:** `ccp/app/src/features/requests/MyRequests.tsx:217-233`; also `features/dashboard/LeadDashboard.tsx:84-95`, `features/approvals/ApprovalsQueue.tsx:570-593`, `features/requests/RequestDetail.tsx:501-524`, `features/account/AccountSecurityPage.tsx:59-67`, `components/Notifications.tsx:99-113`, `features/request/RequestForm.tsx:130-143` (the `?from=` fetch)

**Description.** In api mode, `listRequests`/`listPendingApprovals`/`listAllRequests` **throw** on any non-2xx (`httpApi.ts:1136-1140` — `items()` throws `Error(reason)`), and `getRequest` throws on any non-404 error (`httpApi.ts:1392-1397`). None of the pages above attaches a `.catch` to its load promise, and `loading` is only cleared inside the success branch. A 401 (expired session — see FE-5), 403, 500, or network failure therefore leaves the page rendering `Loading…` permanently, with an unhandled rejection and no retry affordance. `AccountSecurityPage`'s three refreshers (`loadDevicesVia`/`loadRecoveryStatusVia`/`loadSessionsVia` — all of which throw `ApiRefusalError` on failure, `httpApi.ts:1571-1621`) silently leave their cards in the loading state. `RequestForm`'s "request again" fetch failing leaves `fromLoaded === false`, so the seed effect (`RequestForm.tsx:161-170`) never runs and the form renders permanently unseeded (no target pre-fill, no defaults) with no explanation.

**Impact.** The primary requester/approver screens hard-hang on the first failed fetch. This is exactly the class of failure a control plane sees daily (idle-expired sessions, deploys). The admin screens prove the codebase knows the right pattern — `UsersAdmin.tsx:137-151`, `AuditHistory.tsx:37-52`, `PendingChanges.tsx:62-68`, `SettingsAdmin.tsx:100-106`, `RiskAdmin.tsx:54-60`, `ApprovalPolicyAdmin.tsx:79-87` all set a rendered `loadError` — but none of the high-traffic surfaces got it.

**Recommendation.** Mirror the admin pattern: `.catch` → `setLoadError(reason); setLoading(false)`, render the error with a Retry button. Consider centralizing in a small `useLoad(fn, deps)` hook that also owns the `alive` guard.

---

### FE-3 · HIGH · RequestForm: one server-side rejection permanently disables submit — the only way out abandons the drafted request

**Location:** `ccp/app/src/features/request/RequestForm.tsx:103,258-285` + `features/request/ReviewStep.tsx:300`

**Description.** `blockedReason` is set in three places (local freeze pre-check line 261, local disabled-op pre-check line 267, server rejection line 283) and **never cleared** — no `setBlockedReason(null)` exists anywhere in the file, and the route-change reseed effect (lines 161-170) resets values/touched/justification/schedule/confirmation but not `blockedReason` or `submitting`. `ReviewStep` disables the submit button whenever `blocked !== undefined` (`ReviewStep.tsx:300`, `blocked={blockedReason ?? liveBlockedReason ?? undefined}` at `RequestForm.tsx:318`). Consequences:

- Submit during a freeze → "frozen" message + disabled button. Admin lifts the freeze → `liveBlockedReason` clears but the sticky `blockedReason` keeps the button disabled with the now-false "frozen" explanation. Retry is impossible.
- Server rejects `OUT_OF_BOUNDS` (e.g. the admin narrowed an allowlist after the form loaded) → user clicks Edit, fixes the parameter, returns to Review → still disabled. The one recovery path — leaving the route — discards the entire drafted request.

By contrast `ProvisionService.tsx:190` clears its blocked reason on reseed, and `BulkRequestForm.tsx:215` / `ResourceDetail.tsx:721` disable only on the *live* gate, keeping retry possible (their stale `blocked` text lingers, but the button works).

**Impact.** A transient, correct server refusal converts into a permanent client-side dead end with user data loss — "form loses data on failure" in its purest form.

**Recommendation.** Clear `blockedReason` at the top of `onSubmit` and in the reseed effect; disable submit only on `submitting || liveBlockedReason` and render `blockedReason` as a dismissible/inline error, matching the BulkRequestForm posture.

---

### FE-4 · MEDIUM · ApprovalsQueue's stale-response guard is dead code — overlapping project-switch fetches can commit the wrong project's queue

**Location:** `ccp/app/src/features/approvals/ApprovalsQueue.tsx:570-593`

**Description.** The queue's `load` callback sets `requests`/`manifests`/`inventory` state directly inside itself (lines 576-579). The consuming effect wraps it as:

```ts
useEffect(() => {
  let active = true;
  void load().then(() => {
    if (!active) return;   // ← runs AFTER load() already setState'd
  });
  return () => { active = false; };
}, [load]);
```

The `active` check guards an empty continuation; the state writes have already happened unconditionally by the time it runs. On a project switch, the old scope's in-flight `listPendingApprovals`/`listManifests`/`getInventory` responses (issued under the previous `x-ccp-project`) can resolve **after** the new project's load and clobber it — the classic last-writer-wins race every other page in this app guards against correctly (compare `MyRequests.tsx:217-233`, `RequestDetail.tsx:501-524`, `DriftPage.tsx:335-344`, which check `active` *before* setting state).

**Impact.** For the duration of one HTTP round-trip after switching projects, an approver can be shown — and attempt to act on — another project's pending queue under the new project's banner. Mutations then 404 server-side (id unknown under the new scope), so no corruption, but wrong-tenant data display in the approval surface is a real trust defect.

**Recommendation.** Move the state writes into the guarded continuation (`load` returns the tuple; the effect commits it only when `active`), or pass an `AbortSignal`/epoch token.

---

### FE-5 · HIGH · Api-mode session expiry is never detected in-app — the UI stays "signed in" while every call fails

**Location:** `ccp/app/src/lib/auth.ts:85-98` + `lib/apiSession.ts:31,82-92`; `lib/httpApi.ts:1028-1050` (no 401 handling); `components/guards.tsx:9-13`

**Description.** In api mode, identity is the in-memory `cached` account in `apiSession.ts`, set at login/TOTP/`me()` and cleared only by explicit logout or a fresh `hydrateApiSession` on the login page. The HTTP layer has **no** 401 handling outside `me()` (`httpApi.ts:1550-1555`): a `request()` that comes back 401 just surfaces the server's reason as a thrown error or `{ok:false}`. Nothing calls `clearApiSession()` on it. ccp-api sessions expire at 12h absolute / 30m idle (per `settingsFlow.ts:218-221`), so the common path is: user idles >30m → clicks anything → every fetch 401s → `RequireAuth` (which reads the still-populated cache, `guards.tsx:10`) keeps them on the page → list pages hang on "Loading…" forever (FE-2) and mutations either strand (FE-1) or show a bare server reason with no route back to sign-in. Recovery requires a manual full reload (which drops the in-memory cache and bounces to `/login`).

**Impact.** Every session that outlives the idle window ends in a zombie UI. This will bite daily in production.

**Recommendation.** In `request()` (or a thin wrapper), on a 401 with an `UNAUTHENTICATED`-class code: `clearApiSession()` and emit — `useCurrentUser` subscribers re-render, and a subscribed guard (make `RequireAuth` use `useCurrentUser()` instead of the unsubscribed `currentUser()`) redirects to `/login`. Note the guards are also blind to cross-tab sign-out today for the same unsubscribed-read reason.

---

### FE-6 · MEDIUM · Api-mode submit gates read the advisory localStorage settings, not the server's — the freeze preview is dead and a stale local freeze silently blocks valid submits

**Location:** `ccp/app/src/features/request/RequestForm.tsx:260-268,295-299`; same pattern `BulkRequestForm.tsx:119-125`, `ResourceDetail.tsx:637-645`; store: `lib/settings.ts:288-300`

**Description.** `onSubmit` early-returns on `isChangeFrozen()` / `isOpDisabled(op.id)` **before ever calling the API**, and the "live" proactive banner reads `useSettings()` — both are the project-scoped localStorage store. In api mode the authoritative freeze lives server-side (`freeze.global`, read/written only by `SettingsAdmin` via `settingsFlow.ts:156-176`) and is never mirrored into the local store. Two failure directions:

1. Server freeze ON, local store clean → the advertised "live freeze preview" (`RequestForm.tsx:104-110` comment) never fires; the user only learns at submit, via the server's `FROZEN` rejection — which then triggers FE-3's permanent lockout.
2. Local store carries `changeFreeze:true` or a disabled op (leftover from mock use on the same origin, or any write to `ccp.<project>.settings.v1`) → the client **refuses to submit at all** without consulting the server, and in api mode no UI writes that key to clear it (SettingsAdmin writes server-side when `can('settings')`).

**Impact.** The client-side gate both under-warns and can over-block in the authoritative mode; combined with FE-3 a stale local flag bricks the request form for that project.

**Recommendation.** In api mode, skip the local pre-check entirely (let the server's `FROZEN`/`OP_DISABLED` result be the answer — the code already renders it), or mirror the server settings into the shared snapshot on load.

---

### FE-7 · MEDIUM · PendingChangesBanner count goes stale after any dual-control activity — and the mock branch reads an unsubscribed store

**Location:** `ccp/app/src/components/PendingChangesBanner.tsx:26-42`; store: `lib/pendingChanges.ts` (no emitter/subscription surface)

**Description.** The banner is mounted once in `AdminLayout` and fetches the server count in an effect keyed only on `[authoritative]` — i.e. once per admin visit. Acking/rejecting a proposal in `PendingChanges.tsx` refreshes only that page's own list (`PendingChanges.tsx:61-84`); proposing a new loosening from SettingsAdmin/UsersAdmin/RiskAdmin never touches the banner either. So the banner shows "2 pending config changes" after both were decided, or 0 after a fresh proposal, until the admin leaves and re-enters the admin area. In mock mode the fallback `pendingCount()` (line 42) is a bare synchronous read of a store with no emitter — unlike settings/session/teams, `lib/pendingChanges.ts` was never given a `useSyncExternalStore` binding, so same-tab writes don't re-render the banner at all.

**Impact.** The dual-control queue's most visible signal — "a second admin must look at this" — is wrong for the rest of the admin session. Stale-cache-after-mutation, on a governance surface.

**Recommendation.** Give `lib/pendingChanges` the same emitter + `subscribeWithStorage` treatment as settings, and have the server branch refetch on route change within the admin area (or lift the count into a small shared store the queue page updates from mutation results).

---

### FE-8 · MEDIUM · AuditHistory silently truncates to the first page (100 entries) — the cursor is fetched and thrown away

**Location:** `ccp/app/src/features/admin/auditFlow.ts:93-103`; `features/admin/AuditHistory.tsx:37-52,95-97`

**Description.** `loadAuditRows` calls `client.listAuditEntries()` with no options and returns `page.items`, discarding `page.cursor`. The server pages at a default limit of 100 (`ccp/api/src/routes/admin.ts:1201-1217`). The screen then renders "`{entries.length}` events · governance actions, newest first" and offers client-side search over what it has — presenting a truncated window as the whole history, with no "load more" and no indication anything is missing. The `cursor`/`limit` plumbing exists end-to-end in the client (`httpApi.ts:1641-1649`) but has no consumer.

**Impact.** On any deployment with real governance traffic, admins searching the audit trail will get silent false negatives past the first 100 entries — an important gap for an evidence surface (export is unaffected: it fetches the whole chain).

**Recommendation.** Loop the cursor or add a "Load older" control; at minimum caption the count honestly ("latest 100").

---

### FE-9 · MEDIUM · apiSession role resolution falls back to another scope's role when the user has no binding on the active project

**Location:** `ccp/app/src/lib/apiSession.ts:45-51,62-79`

**Description.** `bindingFor` documents `undefined` as "not a member of that account". But `authAccountToAccount` then does `role: (binding?.role ?? a.role)`, `teamId: binding?.teamId ?? a.teamId` — falling back to the scalar the server resolved **for whatever scope the login/me request was made under**. The fallback is documented as being for a legacy backend that serves no `roles` map, but it also fires when the map exists and simply lacks an entry for `currentProjectId()`. Switching the active project to one where the signed-in user holds no role therefore renders them with the *previous* scope's role (e.g. "lead") — nav items, approve affordances (`canApprove`, ApprovalsQueue's `mayApprove`), and drift operator buttons (`DriftPage.tsx:432`) all key off this. The server re-enforces everything, so the damage is confusing UI plus guaranteed 403s, not privilege — but the client's own model (`apiSessionScopes`, project switcher) exists precisely to prevent this state from rendering.

**Impact.** Wrong-role UI on non-member projects; actions offered that can only bounce.

**Recommendation.** Apply the scalar fallback only when `a.roles` is absent; when the map exists with no binding, resolve to a "no role here" representation (e.g. `role:'requester'`-with-no-team or an explicit null the callers handle) and let the project switcher exclude unscoped projects.

---

### FE-10 · LOW · Mock `rejectRequest` skips the status guard the real API enforces

**Location:** `ccp/app/src/lib/api.ts:1680-1705`; server contrast: `ccp/api/src/routes/requests.ts:723`

**Description.** The mock's `approveRequest` faithfully mirrors the server (`OPEN_STATUSES`-style guard at `api.ts:1635-1637`, SoD, dedup, tighten-only re-gate), but `rejectRequest` checks role and self-rejection only — no status check. A terminal request (APPLIED/REJECTED/WITHDRAWN) can be flipped to REJECTED in mock mode, where the API returns `STATE_CONFLICT` (`requests.ts:723`). Reachable via a stale card (the queue only offers Reject on displayed rows, but the row can be stale relative to another actor in tests/demos).

**Impact.** Mock/API state-machine divergence — the mock's stated doctrine ("mirror the server's fail-closed gates") has a hole; tests written against the mock won't see the conflict path.

**Recommendation.** Add `if (req.status !== 'AWAITING_CODE_REVIEW' && req.status !== 'NEEDS_ENGINEER') return { ok:false, reason:… }` to the mock.

---

### FE-11 · LOW · `WINDOW_EXPIRED` is missing from both status-filter vocabularies

**Location:** `ccp/app/src/features/requests/MyRequests.tsx:25-46`; `features/approvals/ApprovalsQueue.tsx:86-107`

**Description.** Both `ALL_STATUSES` lists carry every `RequestStatus` **except** `WINDOW_EXPIRED`, which the API produces (`requests.ts:659`) and which the rest of the app models (`RequestDetail.tsx:113`, `StatusBadge.tsx:50`, `Notifications.tsx:44-48`). The dropdown can't select it, and `parseFilters` coerces `?status=WINDOW_EXPIRED` to `'all'` — so the one status that *requires* user action (re-window or cancel) is the one you can't filter to. Being plain arrays (not `Record<RequestStatus,…>`), these lists have no compile-time completeness check, which is how the drift happened.

**Recommendation.** Derive the option list from a single exhaustively-typed source (e.g. `Object.keys` of the `StatusBadge` map, which *is* a `Record<RequestStatus,…>`).

---

### FE-12 · LOW · After a partial approval, the queue keeps a card the server's pending scope would drop

**Location:** `ccp/app/src/features/approvals/ApprovalsQueue.tsx:151-158`

**Description.** `applyMutatedRequestToList` keeps a row iff `status === 'AWAITING_CODE_REVIEW'`, and its doc comment claims this matches "what a fresh `listPendingApprovals()` would have returned anyway". Not quite: on a two-step ladder (risk-tier `[L2, L3]`), the approver's own signature leaves the status `AWAITING_CODE_REVIEW`, so the card stays — but the server's `scope=pending` excludes it for this viewer (already signed / next step not signable, `requests.ts:535-538`). The retained card is non-actionable (`canApprove` disables Approve) but Reject is still offered, the "pending" header count includes it, and a manual refresh makes it vanish — a small honesty/consistency drift between patch-in-place and refetch. Same asymmetry for NEEDS_ENGINEER rows served by the api-mode pending scope: any update leaves `status === 'NEEDS_ENGINEER'` and the patch drops them even when the server would still list them for another reason.

**Recommendation.** Filter with the same predicate the server uses (open status ∧ `canApprove` ∧ viewer can sign next step) — all the inputs are on the returned request.

---

### FE-13 · LOW · RequestDetail sub-panels hold un-keyed local state across request-id navigation

**Location:** `ccp/app/src/features/requests/RequestDetail.tsx:420 (LinkPrPanel's prUrl), 294 (WindowPanel's rewindowAt)`

**Description.** Navigating from `/requests/A` to `/requests/B` reuses the same `RequestDetail` element (same route), so child components at the same position keep state. `LinkPrPanel` initializes `useState(request.prUrl ?? '')` once — a half-typed PR URL drafted on request A (or A's linked URL) remains in the input when B renders; `WindowPanel`'s `rewindowAt` similarly survives. A Lead can plausibly paste A's engineering PR onto B.

**Recommendation.** Key the panels by request id (`<LinkPrPanel key={request.id} …>`), the idiomatic reset.

---

### FE-14 · LOW · DriftPage's post-trigger refetches bypass the staleness guard

**Location:** `ccp/app/src/features/drift/DriftPage.tsx:456,475`

**Description.** `handleStartCheck`/`handleGenerate` follow success with `void api.getDriftStatus().then(setStatus)` — no `active` flag, no project check, unlike the main effect (lines 335-344). A late response after a project switch or unmount writes stale/foreign state (`getDriftStatus` reads the *current* scope at call time, so a switch mid-flight fetches the new project under the old page state — racing the main effect's own fetch for last-writer-wins). Blast radius is small (both fetches usually target the same new scope), but the page's own reset doctrine (lines 346-385) is undermined by these two writers.

**Recommendation.** Route the refresh through the same guarded loader the effect uses.

---

### FE-15 · LOW · Notifications bell and CommandPalette swallow rejections silently

**Location:** `ccp/app/src/components/Notifications.tsx:99-113`; `components/CommandPalette.tsx:109-130`

**Description.** Both fetch `listRequests`/`listPendingApprovals` (throwing calls in api mode) inside effects with `alive` guards but no `.catch`. On failure (expired session, network) the bell silently shows stale/empty data and the palette misses its request group; each failure is an unhandled rejection. Low impact because these are ambient surfaces, but they refetch on every open (`Notifications.tsx:113` keys on `open`), so an expired session makes every bell-open throw.

**Recommendation.** Attach `.catch(() => {})` at minimum; ideally surface a small "couldn't refresh" hint.

---

## Minor observations

- **Render-phase global write in `ProjectProvider`.** `resolveActiveProject` mutates the ambient module scope during render via `useMemo` (`ProjectContext.tsx:58-66`). This is documented, fenced with `'use no memo'`, and idempotent — but it remains a concurrent-rendering hazard by construction (an interrupted/interleaved render of a different project subtree could leave the ambient scope pointing at the wrong project for a sibling's read). Acceptable as a deliberate trade-off; worth a test if `useTransition` usage grows beyond `ApprovalsQueue`.
- **aria-live announcement can be swallowed on repeat.** `ApprovalsQueue.tsx:558,612` sets the same string for two consecutive approvals with identical counts; identical text in the same live region may not re-announce. Clearing before setting (or appending an invisible toggle) makes it reliable.
- **`useFullBlockDiff` gets a fresh `{}` each render while `RequestDetail` loads** (`RequestDetail.tsx:590`, `request?.params ?? {}`), re-running the effect per render. Harmless (state bails out on identical `null`) but easy to hoist to a module constant.
- **`AccountMenu.handleSignOut`** fires `void authClient?.logout()` with no catch (`AccountMenu.tsx:54`) — local state clears regardless, but a failed server logout is an unhandled rejection; the LoginPage `cancelTotp` (`LoginPage.tsx:268`) shares the pattern.
- **Mock reads return live references.** `createMockApiClient`'s `getRequest`/`listRequests` hand out the same mutable objects `approveRequest` later mutates in place (`api.ts:1043-1051,1638-1678`) — the drift report is defensively shallow-copied (`api.ts:954-960`) but requests are not. Works today because pages re-render off mutation results; a future memoized consumer could observe spooky mutation.
- **`seedValues` seeds a `?target=` address without validating it exists in inventory or matches the op's resource type** (`RequestForm.tsx:50-52`) — `validateParams` catches it downstream, so this is only a wasted-render nicety.
- **LoginPage reads `isAuthenticated()`/`currentUser()` unsubscribed during render** (`LoginPage.tsx:115-123`) — fine for its own flows (every transition navigates explicitly), but the same unsubscribed-guard caveat as FE-5's `RequireAuth` note.

---

## Overall grade: B

The architecture is genuinely strong — a correct `useSyncExternalStore` layer, honest per-flow authority gating, pure and well-tested flow modules, careful project-scope hygiene, and several patterns (409-refetch honesty, mutation-result patching, the drift binding invariant) that most codebases never reach. What keeps it out of the A range is one systemic hole and one flow-breaking bug, both on the product's *primary* surfaces: async failure handling is essentially absent from the request/approval/drift pipeline (FE-1, FE-2, FE-5 — permanent spinners and zombie sessions under ordinary production conditions), and RequestForm's sticky `blockedReason` (FE-3) turns any server refusal into an unrecoverable dead end with data loss. The contrast with the admin screens — which handle every one of these cases correctly — shows the fix is a known in-house pattern away, not a redesign.
