import { describe, expect, it } from "vitest";
import {
  allowedForgeHosts,
  buildCloneUrl,
  canTransitionScanStatus,
  isTerminalScanStatus,
  SCAN_ERROR_MAX,
  SCAN_JOB_STATUSES,
  sanitizeScanError,
  scannerEnabled,
  scannerWorkerKey,
} from "../src/domain/scanner";
import type { RepoRef } from "../src/store/schema";

/**
 * ADR-0033's scanner lane: the arming switch, the SSRF answer, the job state
 * machine, and the untrusted-output sanitizer. The module is pure, so these
 * assertions are the real security proof — no server, container, or forge needed.
 */

const GH: RepoRef = {
  host: "github",
  owner: "example-org",
  name: "terraform-example",
};

describe("scannerEnabled — OFF BY DEFAULT is the load-bearing invariant", () => {
  it('is false when CCP_SCANNER is unset, empty, or anything but exactly "1"', () => {
    for (const env of [
      {},
      { CCP_SCANNER: "" },
      { CCP_SCANNER: "0" },
      { CCP_SCANNER: "true" },
      { CCP_SCANNER: "yes" },
      { CCP_SCANNER: " 1" },
    ]) {
      expect(scannerEnabled(env), JSON.stringify(env)).toBe(false);
    }
  });

  it('is true ONLY for the explicit "1"', () => {
    expect(scannerEnabled({ CCP_SCANNER: "1" })).toBe(true);
  });
});

describe("scannerWorkerKey — an armed scanner with no usable key is a closed lane, not an open door", () => {
  it("returns null when absent or too short to be a secret", () => {
    expect(scannerWorkerKey({})).toBeNull();
    expect(scannerWorkerKey({ CCP_SCANNER_KEY: "" })).toBeNull();
    expect(scannerWorkerKey({ CCP_SCANNER_KEY: "short" })).toBeNull();
    expect(scannerWorkerKey({ CCP_SCANNER_KEY: "x".repeat(31) })).toBeNull();
  });

  it("returns the key at the 32-char floor and above", () => {
    expect(scannerWorkerKey({ CCP_SCANNER_KEY: "x".repeat(32) })).toBe(
      "x".repeat(32),
    );
  });
});

describe("allowedForgeHosts", () => {
  it("always allows the two public forges even with no configuration", () => {
    const hosts = allowedForgeHosts({});
    expect(hosts.has("github.com")).toBe(true);
    expect(hosts.has("gitlab.com")).toBe(true);
  });

  it("adds configured hosts, case-insensitively and whitespace-tolerantly", () => {
    const hosts = allowedForgeHosts({
      CCP_FORGE_HOSTS: " Git.Example.Com , gl.example.com ",
    });
    expect(hosts.has("git.example.com")).toBe(true);
    expect(hosts.has("gl.example.com")).toBe(true);
  });

  it("does not allow a host merely because it looks like a subdomain of an allowed one", () => {
    const hosts = allowedForgeHosts({ CCP_FORGE_HOSTS: "git.example.com" });
    expect(hosts.has("evil.git.example.com")).toBe(false);
    expect(hosts.has("git.example.com.evil.test")).toBe(false);
  });
});

describe("buildCloneUrl — SSRF closed by construction, not by filtering", () => {
  it("builds the public github URL from validated parts", () => {
    const r = buildCloneUrl(GH, {});
    expect(r).toEqual({
      ok: true,
      url: "https://github.com/example-org/terraform-example.git",
      host: "github.com",
    });
  });

  it("builds the public gitlab URL and encodes subgroup owners segment-by-segment", () => {
    const r = buildCloneUrl(
      { host: "gitlab", owner: "group/sub-group", name: "terraform-example" },
      {},
    );
    expect(r.ok && r.url).toBe(
      "https://gitlab.com/group/sub-group/terraform-example.git",
    );
  });

  it("the scheme is hard-coded: an http baseUrl can never produce an http clone", () => {
    const r = buildCloneUrl(
      { ...GH, baseUrl: "http://git.example.com" },
      { CCP_FORGE_HOSTS: "git.example.com" },
    );
    expect(r).toEqual({ ok: false, refusal: "not-https" });
  });

  it("refuses a self-hosted host that is NOT on the allowlist (the default-deny case)", () => {
    const r = buildCloneUrl(
      { ...GH, baseUrl: "https://git.internal.test" },
      {},
    );
    expect(r).toEqual({ ok: false, refusal: "host-not-allowed" });
  });

  it("accepts a self-hosted host once the deployment allowlists it", () => {
    const r = buildCloneUrl(
      { ...GH, baseUrl: "https://git.example.com" },
      { CCP_FORGE_HOSTS: "git.example.com" },
    );
    expect(r.ok && r.url).toBe(
      "https://git.example.com/example-org/terraform-example.git",
    );
  });

  it("refuses embedded credentials — a secret never rides in the URL", () => {
    const r = buildCloneUrl(
      { ...GH, baseUrl: "https://user:pass@git.example.com" },
      { CCP_FORGE_HOSTS: "git.example.com" },
    );
    expect(r).toEqual({ ok: false, refusal: "credentials-in-url" });
  });

  it("refuses an explicit port — an allowlisted name must not be aimed at another service", () => {
    const r = buildCloneUrl(
      { ...GH, baseUrl: "https://git.example.com:2222" },
      { CCP_FORGE_HOSTS: "git.example.com" },
    );
    expect(r).toEqual({ ok: false, refusal: "port-not-allowed" });
  });

  it("refuses a malformed baseUrl instead of coercing it", () => {
    expect(buildCloneUrl({ ...GH, baseUrl: "not a url" }, {})).toEqual({
      ok: false,
      refusal: "malformed-base-url",
    });
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["git", "git://git.example.com"],
    ["ssh", "ssh://git@git.example.com"],
    ["javascript", "javascript:alert(1)"],
  ])(
    "a %s baseUrl is unreachable, never merely filtered",
    (_label, baseUrl) => {
      const r = buildCloneUrl(
        { ...GH, baseUrl },
        { CCP_FORGE_HOSTS: "git.example.com" },
      );
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect([
          "not-https",
          "malformed-base-url",
          "host-not-allowed",
        ]).toContain(r.refusal);
    },
  );

  it("cannot be steered at a link-local or loopback address without an explicit allowlist entry", () => {
    for (const baseUrl of [
      "https://169.254.169.254",
      "https://127.0.0.1",
      "https://localhost",
      "https://[::1]",
    ]) {
      expect(buildCloneUrl({ ...GH, baseUrl }, {}).ok, baseUrl).toBe(false);
    }
  });

  it("every produced URL parses back to https, the expected host, and no credentials", () => {
    for (const env of [{}, { CCP_FORGE_HOSTS: "git.example.com" }]) {
      for (const repo of [
        GH,
        { ...GH, baseUrl: "https://git.example.com" },
      ] as RepoRef[]) {
        const r = buildCloneUrl(repo, env);
        if (!r.ok) continue;
        const u = new URL(r.url);
        expect(u.protocol).toBe("https:");
        expect(u.hostname).toBe(r.host);
        expect(u.username).toBe("");
        expect(u.password).toBe("");
        expect(u.port).toBe("");
      }
    }
  });
});

describe("scan-job state machine — forward only, terminal is final", () => {
  it("a terminal job can never transition anywhere, including to itself", () => {
    for (const t of ["uploaded", "failed"] as const) {
      expect(isTerminalScanStatus(t)).toBe(true);
      for (const to of SCAN_JOB_STATUSES)
        expect(canTransitionScanStatus(t, to), `${t}->${to}`).toBe(false);
    }
  });

  it("walks the happy path and refuses every backwards or skipping move", () => {
    expect(canTransitionScanStatus("queued", "claimed")).toBe(true);
    expect(canTransitionScanStatus("claimed", "cloning")).toBe(true);
    expect(canTransitionScanStatus("cloning", "scanning")).toBe(true);
    expect(canTransitionScanStatus("scanning", "uploaded")).toBe(true);
    // skipping
    expect(canTransitionScanStatus("queued", "scanning")).toBe(false);
    expect(canTransitionScanStatus("claimed", "uploaded")).toBe(false);
    // backwards
    expect(canTransitionScanStatus("scanning", "cloning")).toBe(false);
    expect(canTransitionScanStatus("cloning", "queued")).toBe(false);
  });

  it("any non-terminal state may fail", () => {
    for (const s of ["queued", "claimed", "cloning", "scanning"] as const) {
      expect(canTransitionScanStatus(s, "failed")).toBe(true);
    }
  });
});

describe("sanitizeScanError — the worker ran against a hostile repo; its text is untrusted", () => {
  it("redacts a clone URL so an error can never leak where we cloned from", () => {
    expect(
      sanitizeScanError(
        "fatal: could not read https://git.example.com/example-org/x.git",
      ),
    ).toBe("fatal: could not read [url]");
  });

  it("redacts an upload-token-shaped string", () => {
    const tokenish = `${"0123456789ABCDEFGHJKMNPQRS"}.${"abcdefghijklmnopqrstuvwxyz012345"}`;
    expect(sanitizeScanError(`auth failed for ${tokenish}`)).toBe(
      "auth failed for [token]",
    );
  });

  it("strips control characters so it cannot forge a log line or emit terminal escapes", () => {
    const out = sanitizeScanError("a[31mred  b\nc\r\nd");
    expect(out).not.toMatch(/[ -]/);
    expect(out).toBe("a [31mred b c d");
  });

  it("truncates to the cap and never returns a non-string as one", () => {
    expect(sanitizeScanError("x".repeat(5000)).length).toBe(SCAN_ERROR_MAX);
    for (const junk of [undefined, null, 42, {}, [], ""])
      expect(sanitizeScanError(junk)).toBe("");
  });
});
