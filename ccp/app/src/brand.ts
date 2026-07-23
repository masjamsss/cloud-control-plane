/**
 * The baked-generic identity layer (the instance-identity hybrid model —
 * see the generic-branding decision record). `VITE_INSTANCE_NAME` /
 * `VITE_INSTANCE_TAGLINE` are Vite build-args (docker-compose.yml →
 * app/Dockerfile, exactly the `VITE_API_BASE` pattern) sourced from the
 * installer's one `.env` knob (`CCP_INSTANCE_NAME` — ccp/scripts/setup.sh
 * `env`); empty/unset ⇒ the generic default below, never a stale brand.
 *
 * This module is the SYNCHRONOUS, always-present answer: first paint, mock/
 * standalone builds (no backend, no network call — the standalone-parity
 * invariant), and the fallback while `lib/instanceIdentity.ts`'s runtime layer
 * resolves. It is deliberately NOT the live/rename-aware value — chrome
 * surfaces that must repaint after a Settings rename read
 * `useInstanceIdentity()` instead (lib/instanceIdentity.ts), which layers a
 * cached-last-known runtime identity, then the live server value, over this
 * baked constant. Module-scope consumers that need a stable import (rather
 * than a hook) keep reading APP_NAME/APP_TAGLINE directly — see that module's
 * header for the full resolution order.
 */
export const APP_NAME: string = import.meta.env.VITE_INSTANCE_NAME || 'Cloud Control Plane';

/** One-line identity tagline — generic by default, operator-settable the same
 * way as {@link APP_NAME} (see this module's header). */
export const APP_TAGLINE: string = import.meta.env.VITE_INSTANCE_TAGLINE || 'Terraform change control';
