import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ForgeCredentialError,
  forgeSealKey,
  githubAppAuthHeader,
  githubAppCanServe,
  githubAppConfig,
  mintAppJwt,
  mintInstallationToken,
  openForgeTokenHeader,
  sealForgeToken,
  type FetchLike,
} from "../src/domain/forgeCredentials";
import type { RepoRef } from "../src/store/schema";

/**
 * ADR-0033 Decision 1 — how the scanner reaches a PRIVATE repository. This is
 * the module that holds forge secrets, so the cases below are about what it
 * REFUSES and what it never reveals:
 *
 *  - it will not seal anything without a real key (a secret under a guessable
 *    default is worse than no secret, because the operator believes otherwise);
 *  - the App's private key signs exactly one thing, a ≤10-minute JWT;
 *  - the installation token it mints is narrowed to ONE repository and TWO read
 *    permissions, not whatever the installation happens to hold;
 *  - a misconfigured deployment gets a plain reason, never a silent no-op that
 *    would read as "private repos mysteriously don't work".
 */

const KEY = "f".repeat(40);

// A real RSA key, generated per run — never a committed fixture, since a
// committed private key is a committed private key whatever it is for.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const REPO: RepoRef = {
  host: "github",
  owner: "example-org",
  name: "terraform-example",
};

const ENV_KEYS = [
  "CCP_FORGE_SEAL_KEY",
  "CCP_GITHUB_APP_ID",
  "CCP_GITHUB_APP_KEY",
  "CCP_GITHUB_APP_KEY_FILE",
];
beforeEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("the seal — per-project operator-supplied tokens", () => {
  it("round-trips a pair into the git Basic header", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    const sealed = sealForgeToken("oauth2", "synthetic-forge-token-value");
    expect(openForgeTokenHeader(sealed)).toBe(
      `Basic ${Buffer.from("oauth2:synthetic-forge-token-value").toString("base64")}`,
    );
  });

  it("the sealed blob does not contain the token", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    const sealed = sealForgeToken("oauth2", "synthetic-forge-token-value");
    expect(sealed).not.toContain("synthetic-forge");
    expect(sealed).not.toContain("oauth2");
  });

  it("two seals of the SAME pair differ — a fresh IV every time", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    const a = sealForgeToken("oauth2", "same-token-value-here");
    const b = sealForgeToken("oauth2", "same-token-value-here");
    expect(a).not.toBe(b);
    // …and both still open to the same thing.
    expect(openForgeTokenHeader(a)).toBe(openForgeTokenHeader(b));
  });

  it("a tampered blob fails to open — AES-GCM authenticates it", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    const sealed = sealForgeToken("oauth2", "synthetic-forge-token-value");
    const [iv, tag, ct] = sealed.split(".");
    // Flip a byte of the ciphertext; the auth tag must reject it.
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() =>
      openForgeTokenHeader(`${iv}.${tag}.${flipped.toString("base64")}`),
    ).toThrow();
  });

  it("a DIFFERENT key cannot open it — the seal is key-bound", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    const sealed = sealForgeToken("oauth2", "synthetic-forge-token-value");
    process.env.CCP_FORGE_SEAL_KEY = "g".repeat(40);
    expect(() => openForgeTokenHeader(sealed)).toThrow();
  });

  it("REFUSES to seal with no key, or a key too short to be one", () => {
    for (const k of [undefined, "", "short"]) {
      if (k === undefined) delete process.env.CCP_FORGE_SEAL_KEY;
      else process.env.CCP_FORGE_SEAL_KEY = k;
      expect(forgeSealKey()).toBeNull();
      // The refusal is the point: sealing under a default would look protected.
      expect(() => sealForgeToken("oauth2", "synthetic-forge-token")).toThrow(
        ForgeCredentialError,
      );
    }
  });

  it("refuses a username with a colon — it would move the pair's boundary", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    expect(() => sealForgeToken("user:name", "synthetic-forge-token")).toThrow(
      /colon/i,
    );
  });

  it("refuses an empty half", () => {
    process.env.CCP_FORGE_SEAL_KEY = KEY;
    expect(() => sealForgeToken("", "synthetic-forge-token")).toThrow();
    expect(() => sealForgeToken("oauth2", "")).toThrow();
  });
});

describe("the GitHub App configuration", () => {
  it("is null when the deployment installed no App — not an error", () => {
    expect(githubAppConfig()).toBeNull();
  });

  it("reads an inline PEM, including the \\n-escaped single-line form", () => {
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = privateKey.replace(/\n/g, "\\n");
    const cfg = githubAppConfig();
    expect(cfg?.appId).toBe("123456");
    expect(cfg?.privateKey).toBe(privateKey);
  });

  it("REFUSES a half-configured App rather than silently acting unconfigured", () => {
    // A deployment that meant to install an App and mistyped must be told,
    // not left wondering why private repos do not work.
    process.env.CCP_GITHUB_APP_ID = "not-a-number";
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    expect(() => githubAppConfig()).toThrow(/numeric id/i);

    delete process.env.CCP_GITHUB_APP_ID;
    process.env.CCP_GITHUB_APP_KEY = privateKey;
    expect(() => githubAppConfig()).toThrow();

    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY = "not a pem";
    expect(() => githubAppConfig()).toThrow(/PEM/i);
  });

  it("refuses an unreadable key file", () => {
    process.env.CCP_GITHUB_APP_ID = "123456";
    process.env.CCP_GITHUB_APP_KEY_FILE = "/nope/does/not/exist.pem";
    expect(() => githubAppConfig()).toThrow(/could not be read/i);
  });

  it("serves github.com only — a self-hosted forge uses the sealed token", () => {
    expect(githubAppCanServe(REPO)).toBe(true);
    expect(githubAppCanServe({ ...REPO, host: "gitlab" })).toBe(false);
    // GitHub Enterprise has a different API origin; App tokens do not apply.
    expect(
      githubAppCanServe({ ...REPO, baseUrl: "https://ghe.example.internal" }),
    ).toBe(false);
  });
});

describe("the App JWT — the only thing the private key ever signs", () => {
  const cfg = { appId: "123456", privateKey };

  it("verifies under the App's public key", async () => {
    const { createVerify } = await import("node:crypto");
    const jwt = mintAppJwt(cfg, 1_800_000_000_000);
    const [h, p, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    v.end();
    const raw = Buffer.from(
      sig!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    expect(v.verify(publicKey, raw)).toBe(true);
  });

  it("lives well under GitHub's 10-minute cap and backdates iat for clock skew", () => {
    const now = 1_800_000_000_000;
    const [, payload] = mintAppJwt(cfg, now).split(".");
    const claims = JSON.parse(
      Buffer.from(payload!, "base64").toString("utf8"),
    ) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    expect(claims.exp - claims.iat).toBeGreaterThan(60);
  });
});

describe("minting an installation token", () => {
  const cfg = { appId: "123456", privateKey };

  function fakeGithub(plan: Array<{ status: number; body: unknown }>): {
    fetch: FetchLike;
    calls: Array<{ url: string; body?: string }>;
  } {
    const calls: Array<{ url: string; body?: string }> = [];
    let i = 0;
    const f: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      const step = plan[i++] ?? { status: 500, body: {} };
      return { status: step.status, json: async () => step.body };
    };
    return { fetch: f, calls };
  }

  it("narrows the token to ONE repository and TWO read permissions", async () => {
    const { fetch, calls } = fakeGithub([
      { status: 200, body: { id: 42 } },
      {
        status: 201,
        body: { token: "ghs_exampletoken", expires_at: "2026-07-26T04:00:00Z" },
      },
    ]);
    const got = await mintInstallationToken(REPO, cfg, fetch);
    expect(got.token).toBe("ghs_exampletoken");

    // The narrowing IS the security property — without these fields the token
    // carries every permission and every repo the installation holds.
    const body = JSON.parse(calls[1]!.body!) as {
      repositories: string[];
      permissions: Record<string, string>;
    };
    expect(body.repositories).toEqual(["terraform-example"]);
    expect(body.permissions).toEqual({ contents: "read", metadata: "read" });
    expect(calls[1]!.url).toContain("/app/installations/42/access_tokens");
  });

  it("tells the operator plainly when the App is not installed on that repo", async () => {
    const { fetch } = fakeGithub([{ status: 404, body: {} }]);
    await expect(mintInstallationToken(REPO, cfg, fetch)).rejects.toThrow(
      /not installed/i,
    );
  });

  it("refuses when GitHub returns no token rather than proceeding with none", async () => {
    const { fetch } = fakeGithub([
      { status: 200, body: { id: 42 } },
      { status: 201, body: {} },
    ]);
    await expect(mintInstallationToken(REPO, cfg, fetch)).rejects.toThrow(
      ForgeCredentialError,
    );
  });

  it("percent-encodes owner and name into the lookup path", async () => {
    const { fetch, calls } = fakeGithub([
      { status: 200, body: { id: 7 } },
      { status: 201, body: { token: "ghs_x" } },
    ]);
    await mintInstallationToken(
      { host: "github", owner: "a b", name: "c/d" },
      cfg,
      fetch,
    );
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/a%20b/c%2Fd/installation",
    );
  });

  it("produces the header form git needs for an installation token", () => {
    expect(githubAppAuthHeader("ghs_exampletoken")).toBe(
      `Basic ${Buffer.from("x-access-token:ghs_exampletoken").toString("base64")}`,
    );
  });
});
