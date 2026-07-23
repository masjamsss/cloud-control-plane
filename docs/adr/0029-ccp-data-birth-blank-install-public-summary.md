# ADR-0029: Estate data is per-account runtime data, not a product bundle — the blank-generic install (public summary)

**Status:** Accepted — enacted
**Date:** 2026-07-22
**Deciders:** repo owner
**Note:** This is a generic public restatement of a decision originally recorded privately
(this deployment's ADR-0020). That original's full text names estate-specific identifiers
— a real customer's project code-name, real account and resource identifiers — not
suitable for a public release; the private original stays private (see
`scripts/split/public-excludes.txt`) and is never rewritten. The decision substance below
is unchanged from that original; only the identifying detail is generalized. Companion:
[ADR-0030](0030-ccp-control-scope-and-settlement-public-summary.md).

## Context

A product built out of one operator's real, running deployment can silently drift into
shipping that operator's own captured infrastructure as the default state of every fresh
install — inventory data, historical resource captures, even a people/roster file — when
the product's actual design premise is "one control plane serves many accounts, and the
first account onboarded is not privileged over the rest." That drift is a defect against
the product's own stated architecture, not a cosmetic one: every fresh install of the
product would leak one deployment's infrastructure to every other operator's install, and
the very first account's onboarding path would go permanently unexercised in practice,
because it was never actually walked — it was pre-loaded instead.

## Decision

A fresh install ships the product itself — the generic change catalog, provider safety
data, and governance machinery — and zero estates. The first estate arrives exactly like
the Nth: through the same register → trust → upload → activate ladder every subsequent
account already uses, guided by a first-run screen. The captured estate data that used to
be baked in as the unconditional default becomes an explicitly-loaded, clearly-labeled
**sample estate** with a generic, fixed, non-identifying id — loaded only for
demos/mock/standalone builds, or by explicit operator request on the first-run screen —
never as a default a real, API-backed install falls into unasked.

## Options considered

### Option A: Blank-generic install; estate arrives by onboarding (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium — estate data was reachable from several call sites across two packages; each needed an explicit "no estate yet" fallback instead of a bundled default |
| Cost | Low incremental build — the register/trust/upload/activate ladder, the data plane, and dual control already existed and needed no redesign, only a widened front door |
| Team familiarity | High — reuses exactly the mechanism every non-first account already onboarded through |

**Pros:** matches the product's own stated architecture exactly (one control plane, many
accounts, no account privileged); the first account's onboarding path is now provably
exercised, not assumed; a fresh install never leaks one operator's infrastructure to
another deployment's operators; a sample estate remains available, explicitly, for demos
and evaluation.
**Cons:** the sample fixture's dual role — a generic demo dataset, and, for the specific
deployment it happens to have been captured from, a real historical record — is a nuance
that operators and docs for that deployment must carry precisely; a solo evaluation
instance cannot complete onboarding at all under the product's dual-control rules, which
the first-run screen must say plainly instead of papering over.

### Option B: Keep a baked default estate (status quo)
**Pros:** zero build cost; a fresh install "already works," for a definition of "works"
that means "shows one particular operator's captured data by default."
**Cons:** directly contradicts the product's stated architecture ("many accounts... the
estate is simply the first account onboarded"); every fresh install of the product ships
another operator's captured infrastructure, including account identifiers and a seed
roster of real usernames; the first account's onboarding path stays permanently
unexercised — a latent, undetectable gap. Rejected.

### Option C: Fork-per-estate (a distinct build/checkout per customer)
**Pros:** trivially "generic" in the sense that no single shared install carries anyone's
data.
**Cons:** abandons "one control plane serves many accounts" for N maintained forks,
defeats the premise of one shared change catalog and one shared governance core, and
multiplies the audit/approval surface instead of keeping it singular. Rejected without a
build.

## Consequences

- **Easier:** the product's own architecture claim — "the estate is simply the first
  account onboarded" — is now provably true instead of aspirational; onboarding a first
  customer now exercises the identical code path every other account already covers,
  instead of a code path that existed on paper but was never actually run for account #1.
- **Harder:** operators bringing up a new instance now see an honest "no accounts
  onboarded yet" screen instead of a working-looking demo; a solo evaluation instance
  must be told plainly it cannot onboard a real estate until a second admin is seated — a
  less impressive first five minutes than a baked-in demo, accepted deliberately as the
  honest trade-off.
- **Revisit:** whether to commission a synthetic, non-identifying demo estate distinct
  from today's frozen sample fixture (kept for its test-oracle value), and how far
  in-portal onboarding goes next (server-triggered data generation), are both deferred to
  their own future ADRs.

## Action items

1. [x] Retire the app's unconditional sample default; route a scopeless real install to a
   first-run screen instead of any bundled shell.
2. [x] Retire the freshness CI gate that existed only to keep the baked default in sync
   with one deployment's own live account; freshness of served per-account data is owned
   entirely by that account's own CI lane going forward.
3. [x] Keep the sample fixture byte-identical at its existing path, relabeled as an
   explicit sample with a generic fixed id — no fixture or golden file hand-edited to make
   this pass.
4. [x] Blank-store boot proven end to end through the real onboarding ladder, not a
   shortcut.
5. [ ] Revisit: split the sample estate into its own lazy-loaded chunk so the initial
   bundle carries zero estate bytes (deferred, not required for blank-install behavior).
