/**
 * Secret-shaped redaction, shared by everything that turns an error into text a human
 * (or a log aggregator) will read.
 *
 * Extracted from `domain/scanner.ts#sanitizeScanError`, which had it first and for a good
 * reason: the scan worker is handed a clone URL and a short-lived upload token, and a
 * naive `err.message` can carry either. That reasoning is not specific to scanning —
 * `errors.ts`'s server-error log has exactly the same exposure from exactly the same
 * strings, so this lives in one place rather than being copied (L-8: a fix that exists in
 * one copy of a copied helper is not fixed).
 *
 * Deliberately shape-based, not allowlist-based. It cannot know which strings are secret,
 * so it redacts the two shapes this system actually mints and passes around. It is a
 * mitigation, not a guarantee: the real defence is not interpolating credentials into
 * error messages in the first place.
 */

/** Any URL — clone URLs carry credentials in the userinfo position often enough. */
const URL_SHAPE = /https?:\/\/\S*/gi;

/** The upload-token shape this system mints: a ULID, a dot, then the secret half. */
const TOKEN_SHAPE = /\b[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{20,}\b/g;

/** Replace URL- and token-shaped substrings with visible placeholders. */
export function redactSecrets(s: string): string {
  return s.replace(URL_SHAPE, '[url]').replace(TOKEN_SHAPE, '[token]');
}
