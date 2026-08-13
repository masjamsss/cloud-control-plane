import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { DevAesCipher } from "../auth/totp";
import type { RepoRef } from "../store/schema";

/**
 * How the scanner reaches a PRIVATE repository (ADR-0033 Decision 1) — the half
 * that lifts the public-repos-only limit.
 *
 * There are exactly two ways a deployment can hold forge read access, and both
 * are the operator's deliberate act:
 *
 *  1. A GITHUB APP INSTALLATION (preferred, github.com only). The operator
 *     installs the App on their org and picks which repositories it can see —
 *     least privilege chosen at the forge, in the forge's own UI, revocable
 *     there in one click without touching this deployment. The App's private
 *     key lives in env or a secret file and NEVER in the store; what reaches
 *     the worker is a per-job INSTALLATION token: ≤1 hour, scoped to the single
 *     repository being scanned, with `contents:read` + `metadata:read` and
 *     nothing else. A store-only breach therefore yields no forge secret at
 *     all, and a worker-only breach yields one repository for one hour.
 *  2. A SEALED PER-PROJECT TOKEN (GitLab, self-hosted, or a github.com operator
 *     who cannot install an App). The operator mints a read-only project/deploy
 *     token at their forge and hands it over once; it is sealed AES-256-GCM
 *     under `CCP_FORGE_SEAL_KEY` — a key held in env, deliberately SEPARATE
 *     from the TOTP key so rotating one never breaks the other and the blast
 *     radius of either does not include the other — and no endpoint ever
 *     serializes it back. It is opened exactly once per job, in memory, at
 *     claim time.
 *
 * Neither is required: a public repository is cloned with no credential, which
 * is why the scanner shipped useful before this module existed.
 *
 * FAIL CLOSED, ALWAYS. A missing seal key is a refusal, not a fallback to some
 * default — {@link forgeCipher} throws rather than sealing a forge secret under
 * a well-known dev key, which is the one thing `DevAesCipher`'s own
 * non-production convenience would otherwise do. The envelope itself is that
 * class, reused rather than reimplemented: one audited AES-256-GCM
 * implementation, two keys.
 */

type Env = Record<string, string | undefined>;

/* ── the seal (per-project operator-supplied tokens) ────────────────────────── */

/**
 * The key forge credentials are sealed under. Null when unset or too short —
 * callers MUST treat that as "this deployment cannot hold forge tokens",
 * never as "seal it under something else".
 */
export function forgeSealKey(env: Env = process.env): string | null {
  const k = env.CCP_FORGE_SEAL_KEY;
  return typeof k === "string" && k.length >= 32 ? k : null;
}

/**
 * The cipher for forge credentials. THROWS when no key is configured — a forge
 * secret sealed under a guessable default is worse than refusing to store one,
 * because the operator would believe it was protected.
 */
export function forgeCipher(env: Env = process.env): DevAesCipher {
  const key = forgeSealKey(env);
  if (key === null) {
    throw new ForgeCredentialError(
      "This deployment cannot store forge credentials: CCP_FORGE_SEAL_KEY is unset or shorter than 32 characters.",
    );
  }
  return new DevAesCipher(key);
}

/**
 * A refusal the routes turn into a plain operator-facing message.
 *
 * `transient` tells a caller whether retrying is worth it: `true` means
 * "GitHub blip, network hiccup, or a 5xx — try again"; `false` (the default,
 * and every pre-existing call site's meaning) means "operator must fix
 * something — a missing seal key, a malformed App key, a 404 because the App
 * isn't installed on this repo, a bad credential — and retrying changes
 * nothing." Defaulting to `false` keeps every call site that predates this
 * field exactly as permanent as it already was.
 */
export class ForgeCredentialError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.name = "ForgeCredentialError";
    this.transient = transient;
  }
}

/**
 * Seal a `username:token` pair for storage. The pair is sealed TOGETHER because
 * that is exactly what the git Basic header needs — storing them apart would
 * invite a call site to assemble them itself and get the encoding wrong.
 */
export function sealForgeToken(
  username: string,
  token: string,
  env: Env = process.env,
): string {
  if (username.includes(":")) {
    // The pair is joined on the first colon; a colon in the username would
    // silently move the boundary and produce a different credential.
    throw new ForgeCredentialError("The username cannot contain a colon.");
  }
  if (username.length === 0 || token.length === 0) {
    throw new ForgeCredentialError("Both a username and a token are required.");
  }
  return forgeCipher(env).enc(`${username}:${token}`);
}

/** Open a sealed pair back into the git Basic header value. Never logged. */
export function openForgeTokenHeader(
  sealed: string,
  env: Env = process.env,
): string {
  const pair = forgeCipher(env).dec(sealed);
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/* ── the GitHub App broker ──────────────────────────────────────────────────── */

export type GithubAppConfig = { appId: string; privateKey: string };

/**
 * The App's identity and signing key, or null when this deployment has not
 * installed one. The key is read from a FILE by preference (`…_KEY_FILE`) so it
 * can be a mounted secret with its own permissions; an inline `…_KEY` is
 * accepted for environments that only offer env vars, and tolerates the
 * `\n`-escaped single-line form those environments usually force.
 *
 * A configured-but-unreadable key is a THROW, not a null: silently behaving as
 * if no App were installed would turn a deployment mistake into "private repos
 * mysteriously don't work".
 */
export function githubAppConfig(
  env: Env = process.env,
): GithubAppConfig | null {
  const appId = (env.CCP_GITHUB_APP_ID ?? "").trim();
  const keyFile = (env.CCP_GITHUB_APP_KEY_FILE ?? "").trim();
  const inline = env.CCP_GITHUB_APP_KEY ?? "";
  if (appId === "" && keyFile === "" && inline === "") return null;
  if (!/^\d+$/.test(appId)) {
    throw new ForgeCredentialError(
      "CCP_GITHUB_APP_ID must be the App's numeric id.",
    );
  }
  let privateKey = "";
  if (keyFile !== "") {
    try {
      privateKey = readFileSync(keyFile, "utf8");
    } catch {
      throw new ForgeCredentialError(
        "CCP_GITHUB_APP_KEY_FILE could not be read.",
      );
    }
  } else {
    privateKey = inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  }
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new ForgeCredentialError(
      "The GitHub App key is not a PEM private key.",
    );
  }
  return { appId, privateKey };
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b as never)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * The short-lived RS256 JWT that authenticates AS THE APP (not as an
 * installation) — the only thing the private key ever signs. GitHub caps this
 * at 10 minutes; 9 leaves room for clock skew, and `iat` is backdated 60s for
 * the same reason. Hand-rolled rather than pulling a JWT dependency: this is
 * one signature over two base64url segments, and a new dependency in the
 * credential path is a bigger cost than fifteen lines.
 */
export function mintAppJwt(
  cfg: GithubAppConfig,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat, exp: iat + 9 * 60, iss: cfg.appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(cfg.privateKey))}`;
}

/** The network seam — injected in tests so the whole broker is exercised
 * without reaching github.com. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const GITHUB_API = "https://api.github.com";

/**
 * A non-2xx GitHub response other than the well-known 404: a 5xx is GitHub's
 * own outage, not ours, and worth one retry; any other 4xx is a request the
 * operator (or this code) built wrong and will build wrong again on retry.
 */
function refusalFor(status: number, verb: string): ForgeCredentialError {
  return new ForgeCredentialError(
    `GitHub refused ${verb} (${status}).`,
    status >= 500,
  );
}

/** Wraps a raw network throw from `fetchLike` (DNS failure, connection reset,
 * the `AbortSignal.timeout` in realAppFetch firing) as transient — none of
 * those say anything about the request itself, only that this attempt didn't
 * complete. */
function networkFailure(e: unknown): ForgeCredentialError {
  const message = e instanceof Error ? e.message : String(e);
  return new ForgeCredentialError(
    `Could not reach GitHub to mint an installation token: ${message}`,
    true,
  );
}

/**
 * Mint an installation access token for ONE repository.
 *
 * Two calls, both narrowing: find the installation that can see this repo, then
 * ask it for a token limited to that single repository with exactly the two
 * read permissions the scan needs. The App may be installed on a hundred repos;
 * the token this returns can read one.
 *
 * A repo the App is not installed on comes back 404 — reported as a plain
 * refusal, because "the App cannot see that repository" is the operator's
 * problem to fix at the forge and is precisely what they need told.
 *
 * Every error this throws is a {@link ForgeCredentialError} carrying
 * `transient` so a caller (see `resolveCloneAuth`'s retry-once wrapper in
 * scanJobs.ts) can tell a passing GitHub blip from something the operator
 * has to fix.
 */
export async function mintInstallationToken(
  repo: RepoRef,
  cfg: GithubAppConfig,
  fetchLike: FetchLike,
  nowMs: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const jwt = mintAppJwt(cfg, nowMs);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "user-agent": "ccp-scanner",
    "x-github-api-version": "2022-11-28",
  };
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  let found: Awaited<ReturnType<FetchLike>>;
  try {
    found = await fetchLike(
      `${GITHUB_API}/repos/${owner}/${name}/installation`,
      { method: "GET", headers },
    );
  } catch (e) {
    throw networkFailure(e);
  }
  if (found.status === 404) {
    throw new ForgeCredentialError(
      "The GitHub App is not installed on that repository — add it to the App's repository list.",
    );
  }
  if (found.status < 200 || found.status >= 300) {
    throw refusalFor(found.status, "the App credential");
  }
  const installation = (await found.json()) as { id?: number };
  if (typeof installation.id !== "number") {
    throw new ForgeCredentialError("GitHub returned no installation id.");
  }

  let minted: Awaited<ReturnType<FetchLike>>;
  try {
    minted = await fetchLike(
      `${GITHUB_API}/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        // THE NARROWING. Without these two fields the token would carry every
        // permission and every repository the installation holds.
        body: JSON.stringify({
          repositories: [repo.name],
          permissions: { contents: "read", metadata: "read" },
        }),
      },
    );
  } catch (e) {
    throw networkFailure(e);
  }
  if (minted.status < 200 || minted.status >= 300) {
    throw refusalFor(minted.status, "to mint an installation token");
  }
  const body = (await minted.json()) as { token?: string; expires_at?: string };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new ForgeCredentialError("GitHub returned no installation token.");
  }
  return {
    token: body.token,
    expiresAt: body.expires_at ?? new Date(nowMs + 60 * 60_000).toISOString(),
  };
}

/** The header value git uses for a GitHub App installation token. */
export function githubAppAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

/**
 * Is this repo one the GitHub App can serve? The App authenticates against
 * github.com's API only — a self-hosted GitHub Enterprise has a different API
 * origin, and pointing App-minted tokens at it would not work anyway. Such a
 * deployment uses the sealed per-project token instead.
 */
export function githubAppCanServe(repo: RepoRef): boolean {
  return repo.host === "github" && repo.baseUrl === undefined;
}
