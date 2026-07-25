import type { RepoRef } from "../store/schema";

/**
 * The scanner lane's arming switch and its SSRF-proof clone-URL construction
 * (ADR-0033). This module is deliberately PURE — no store, no network, no
 * process side effects — so every refusal below is exhaustively testable without
 * a server, a container, or a forge.
 *
 * OFF BY DEFAULT is the load-bearing invariant, exactly as it is for the
 * auto-apply loop (`domain/apply/loop.ts`): with `CCP_SCANNER` unset,
 * {@link scannerEnabled} is false, the operator route refuses, the worker lane
 * is closed, and merging this code changes ZERO production behaviour. Turning it
 * on is an explicit deployment act, because it is the one feature that gives the
 * deployment read access to estate repositories.
 *
 * A MISCONFIGURATION REFUSES rather than half-works: scanner on but no worker
 * key, or a self-hosted forge host that isn't on the allowlist, is an error at
 * the point of use — never a silently-skipped guard.
 */

/** The forge's public host when a project names no self-hosted `baseUrl`. */
const DEFAULT_HOSTS: Record<RepoRef["host"], string> = {
  github: "github.com",
  gitlab: "gitlab.com",
};

type Env = Record<string, string | undefined>;

/**
 * True only when the operator explicitly armed the scanner (`CCP_SCANNER=1`).
 * Mirrors `schedulerEnabled()` in domain/apply/loop.ts — same shape, same
 * strict `'1'` comparison, so the two switches read alike.
 */
export function scannerEnabled(env: Env = process.env): boolean {
  return env.CCP_SCANNER === "1";
}

/**
 * The shared secret the scanner worker presents to claim jobs and post status.
 * Returns null when absent, which callers MUST treat as "the worker lane is
 * closed" — an armed scanner with no key is a misconfiguration, not an open door.
 */
export function scannerWorkerKey(env: Env = process.env): string | null {
  const k = env.CCP_SCANNER_KEY;
  return typeof k === "string" && k.length >= 32 ? k : null;
}

/**
 * Hostnames the deployment permits cloning from, from `CCP_FORGE_HOSTS`
 * (comma-separated). The two public forges are ALWAYS allowed — they are where
 * `host: 'github' | 'gitlab'` with no `baseUrl` points, and a project cannot
 * name any other host without a `baseUrl`. Everything else must be listed
 * explicitly, so reaching a self-hosted forge is a deliberate deployment
 * decision rather than a consequence of whatever an admin typed.
 */
export function allowedForgeHosts(env: Env = process.env): Set<string> {
  const extra = (env.CCP_FORGE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return new Set([...Object.values(DEFAULT_HOSTS), ...extra]);
}

/** Why a clone URL was refused — surfaced to the operator, never to the worker. */
export type CloneUrlRefusal =
  | "not-https"
  | "host-not-allowed"
  | "malformed-base-url"
  | "credentials-in-url"
  | "port-not-allowed";

export type CloneUrlResult =
  | { ok: true; url: string; host: string }
  | { ok: false; refusal: CloneUrlRefusal };

/**
 * Rebuild the git clone URL for a project SERVER-SIDE from its already-validated
 * {@link RepoRef}. This is the whole SSRF answer, and the reason the worker is
 * never handed an operator-supplied string:
 *
 *  - The scheme is hard-coded `https:` — never taken from input, so `file://`,
 *    `git://`, `ssh://`, and `http://` are unreachable rather than filtered.
 *  - The host comes from the fixed {@link DEFAULT_HOSTS} table, or — for a
 *    self-hosted forge — from `baseUrl` parsed with `new URL` and then checked
 *    against {@link allowedForgeHosts}. An off-list host refuses.
 *  - `owner`/`name` are already regex-constrained by `RepoRef` (no slashes in
 *    `name`, no `:@?#` anywhere, so no userinfo/query/fragment smuggling) and
 *    are additionally percent-encoded per path segment here. `owner` may legally
 *    contain `/` (GitLab subgroups), so its segments are encoded individually
 *    rather than as one blob.
 *  - Embedded credentials (`user:pass@host`) and any explicit port are refused
 *    outright: a credential belongs in the git auth header the worker adds, and
 *    a port would let an allowlisted hostname be aimed at an unintended service.
 *
 * The returned URL therefore cannot address anything but an allowlisted forge
 * host over https. No caller should ever construct this string another way.
 */
export function buildCloneUrl(
  repo: RepoRef,
  env: Env = process.env,
): CloneUrlResult {
  let host = DEFAULT_HOSTS[repo.host];

  if (repo.baseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(repo.baseUrl);
    } catch {
      return { ok: false, refusal: "malformed-base-url" };
    }
    // RepoRef already pins `startsWith('https://')`, but this module must not
    // depend on a caller's validation for its own security property.
    if (parsed.protocol !== "https:")
      return { ok: false, refusal: "not-https" };
    if (parsed.username !== "" || parsed.password !== "")
      return { ok: false, refusal: "credentials-in-url" };
    if (parsed.port !== "") return { ok: false, refusal: "port-not-allowed" };
    host = parsed.hostname.toLowerCase();
  }

  if (!allowedForgeHosts(env).has(host))
    return { ok: false, refusal: "host-not-allowed" };

  // Encode each path segment. `owner` may carry `/` for GitLab subgroups;
  // `name` cannot (its regex forbids it), so it is a single segment.
  const ownerPath = repo.owner
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `https://${host}/${ownerPath}/${encodeURIComponent(repo.name)}.git`;
  return { ok: true, url, host };
}

/** The scan job's lifecycle. Terminal: `uploaded` | `failed`. */
export const SCAN_JOB_STATUSES = [
  "queued",
  "claimed",
  "cloning",
  "scanning",
  "uploaded",
  "failed",
] as const;
export type ScanJobStatus = (typeof SCAN_JOB_STATUSES)[number];

const TERMINAL: ReadonlySet<ScanJobStatus> = new Set<ScanJobStatus>([
  "uploaded",
  "failed",
]);

/** Forward-only transitions the worker may report. Nothing leaves a terminal state. */
const ALLOWED_NEXT: Record<ScanJobStatus, readonly ScanJobStatus[]> = {
  queued: ["claimed", "failed"],
  claimed: ["cloning", "failed"],
  cloning: ["scanning", "failed"],
  scanning: ["uploaded", "failed"],
  uploaded: [],
  failed: [],
};

export function isTerminalScanStatus(s: ScanJobStatus): boolean {
  return TERMINAL.has(s);
}

/**
 * May a job move `from` → `to`? Deliberately strict and forward-only: a worker
 * cannot walk a job backwards to re-open a finished scan, cannot skip the
 * clone, and cannot resurrect a terminal job. An out-of-order report is a bug
 * or a hostile worker; either way it is refused rather than absorbed.
 */
export function canTransitionScanStatus(
  from: ScanJobStatus,
  to: ScanJobStatus,
): boolean {
  return ALLOWED_NEXT[from].includes(to);
}

/** Hard cap on a worker-supplied error string before it is stored or shown. */
export const SCAN_ERROR_MAX = 500;

/**
 * Sanitize a worker-reported error for storage and display. The worker runs
 * against a hostile repository, so its output is untrusted text: control
 * characters are stripped (no terminal escapes or log forging), it is collapsed
 * to one line and truncated.
 *
 * It also must never carry a secret onward. The worker is handed a clone URL and
 * a short-lived upload token, and a naive `err.message` can contain either — so
 * anything URL-shaped or token-shaped is redacted here, at the boundary, rather
 * than trusting every future call site to remember.
 */
export function sanitizeScanError(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/https?:\/\/\S*/gi, "[url]")
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{20,}\b/g, "[token]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SCAN_ERROR_MAX)
  );
}
