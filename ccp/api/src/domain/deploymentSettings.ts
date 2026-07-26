import type { ConfigStore } from "../store/configStore";
import { loadSetting } from "./config";
import { CONTROL_SCOPE } from "../projects";

/**
 * THE ONE PLACE THAT SAYS WHAT THIS DEPLOYMENT IS CONFIGURED WITH.
 *
 * The goal is an operator who never opens a config file to run the system:
 * everything is visible in the admin portal, and everything that CAN be changed
 * from there, IS. This module is the registry that makes that true — every knob
 * the server reads, in one list, in plain language.
 *
 * Three kinds of knob, and the honesty is in the split:
 *
 *  1. PORTAL-MANAGED. Stored in the settings store under the reserved
 *     `@control` scope, changed from Admin → Deployment, versioned, audited,
 *     and dual-controlled when the change loosens something. The environment
 *     variable still works as the STARTING value, so no existing deployment
 *     changes behaviour on upgrade — but once an admin sets it in the portal,
 *     the portal wins. That precedence (portal → environment → default) is
 *     resolved in exactly one place, {@link resolveKnob}, so no call site can
 *     disagree about it.
 *
 *  2. VISIBLE BUT NOT EDITABLE. Shown in the portal with its current state and
 *     a plain sentence saying why it lives outside and what to do instead. An
 *     operator still has ONE screen to look at; they just cannot type these
 *     particular values into a browser. Each carries its own `reason` — none of
 *     them is "we didn't get to it".
 *
 *  3. SECRET. Never leaves the server, not even to an admin: the portal shows
 *     `configured: true|false` and nothing more. Reading a secret back out of a
 *     web page is how secrets end up in screenshots and bug reports.
 *
 * WHY SOME THINGS GENUINELY CANNOT MOVE — the four recurring reasons:
 *
 *  - IT PROTECTS THE STORE. `CCP_TOTP_KEY` and `CCP_FORGE_SEAL_KEY` encrypt what
 *    is IN the store. A key kept inside the thing it encrypts protects nothing,
 *    so this is not a limitation to engineer around; it is the definition.
 *  - IT IS READ BY A DIFFERENT PROCESS. `CCP_SCANNER_KEY` is presented by the
 *    scanner container, which reads its own environment at boot and never talks
 *    to the settings store. Storing it here would change what the API expects
 *    while the worker kept presenting the old one.
 *  - IT IS NEEDED BEFORE THERE IS A PORTAL. Bootstrap, the store's own location,
 *    the port, and the cookie/CORS posture are all read on the way up — some of
 *    them before any admin exists, and the session settings before anyone can
 *    log in to correct a mistake in them.
 *  - IT EXECUTES. `CCP_BUNDLE_GATE_CMD` and friends are SHELL COMMANDS this
 *    server runs. A text box in an admin screen that sets a command to execute
 *    is a remote shell with extra steps: it would turn any single compromised
 *    admin session — a stolen cookie, a borrowed laptop — into control of the
 *    host. These stay in the deployment's own configuration, where changing
 *    them requires access to the machine, which is exactly the bar they should
 *    sit behind. This one is a deliberate refusal, not an omission.
 */

export type KnobKind = "toggle" | "text" | "list" | "number";
export type KnobGroup =
  | "scanner"
  | "drift"
  | "apply"
  | "git"
  | "identity"
  | "session"
  | "storage"
  | "process";

/** Why a knob is not editable from the portal, and what the operator does instead. */
export type NotEditable = { reason: string; instead: string };

export type Knob = {
  /** Stable id — the settings-store key and the API path segment. */
  id: string;
  /** Plain-language name. No internal vocabulary. */
  label: string;
  /** One or two plain sentences: what it does, and what happens either way. */
  help: string;
  group: KnobGroup;
  kind: KnobKind;
  /** The environment variable this falls back to. Shown so an operator can
   * connect what they see here to what is in their deployment config. */
  env: string;
  /** `true` ⇒ portal-managed. Otherwise the honest reason it is not. */
  editable: true | NotEditable;
  /** A secret: its VALUE never leaves the server, only whether one is set. */
  secret?: true;
  /** Default when neither the portal nor the environment says otherwise. */
  fallback?: string | boolean | number | string[];
  /** True when moving from `before` to `after` WIDENS what the system may do.
   * A loosening change is dual-controlled by the standing machinery — arming
   * the scanner grants this deployment read access to repositories, which is
   * emphatically a decision for two admins, not one. */
  loosens?: (before: unknown, after: unknown) => boolean;
};

/** A toggle loosens when it goes off → on. */
const turningOn = (before: unknown, after: unknown): boolean =>
  before !== true && after === true;
/** A list loosens when it gains an entry (a wider allowlist). */
const listGrew = (before: unknown, after: unknown): boolean => {
  const b = Array.isArray(before) ? (before as string[]) : [];
  const a = Array.isArray(after) ? (after as string[]) : [];
  return a.some((x) => !b.includes(x));
};

export const KNOBS: readonly Knob[] = [
  /* ── the repository scanner ─────────────────────────────────────────────── */
  {
    id: "scanner.enabled",
    label: "Let this system scan repositories itself",
    help: "When on, an admin can paste a repository address and this system clones and reads it on its own scanner, instead of anyone running a scan by hand. Off by default, because turning it on is what gives this system read access to your repositories.",
    group: "scanner",
    kind: "toggle",
    env: "CCP_SCANNER",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "scanner.forgeHosts",
    label: "Extra repository hosts we may read from",
    help: "github.com and gitlab.com are always allowed. Add your own server's address here if your code lives on a self-hosted GitHub or GitLab — anything not listed is refused rather than attempted.",
    group: "scanner",
    kind: "list",
    env: "CCP_FORGE_HOSTS",
    editable: true,
    fallback: [],
    loosens: listGrew,
  },
  {
    id: "scanner.githubAppId",
    label: "GitHub App ID",
    help: "The numeric ID of the GitHub App used to reach private repositories. Just an identifier, not a secret — the App's key is set separately and never shown.",
    group: "scanner",
    kind: "text",
    env: "CCP_GITHUB_APP_ID",
    editable: true,
    fallback: "",
  },
  {
    id: "scanner.workerKey",
    label: "Scanner sign-in key",
    help: "The shared key the scanner uses to talk to this system.",
    group: "scanner",
    kind: "text",
    env: "CCP_SCANNER_KEY",
    secret: true,
    editable: {
      reason:
        "The scanner runs as a separate container and reads this from its own configuration when it starts. Changing it here would only change what this side expects, while the scanner kept presenting the old one.",
      instead:
        "Set it in the deployment's configuration for both, then restart the scanner.",
    },
  },
  {
    id: "scanner.githubAppKey",
    label: "GitHub App private key",
    help: "The App's signing key, used to mint a short-lived read token per scan.",
    group: "scanner",
    kind: "text",
    env: "CCP_GITHUB_APP_KEY_FILE",
    secret: true,
    editable: {
      reason:
        "A private key is deliberately never held in this system's own storage, so that a break-in here yields no way into your repositories.",
      instead:
        "Put the key file on the machine and point the deployment configuration at it.",
    },
  },
  {
    id: "scanner.sealKey",
    label: "Key that encrypts stored repository tokens",
    help: "Protects the read-only repository tokens admins paste in.",
    group: "scanner",
    kind: "text",
    env: "CCP_FORGE_SEAL_KEY",
    secret: true,
    editable: {
      reason:
        "This is the key that encrypts things kept in this system's storage. A key kept inside the thing it encrypts protects nothing.",
      instead: "Set it in the deployment's configuration and restart.",
    },
  },

  /* ── drift ──────────────────────────────────────────────────────────────── */
  {
    id: "drift.enabled",
    label: "Show drift reports",
    help: "Turns the drift screens on. With it off, uploaded drift reports are still stored but nothing displays them.",
    group: "drift",
    kind: "toggle",
    env: "CCP_DRIFT",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "drift.proposals",
    label: "Offer one-click fixes for drift",
    help: "Lets the drift screens generate a proposed change for something that drifted. The proposal still goes through the normal approvals — nothing applies itself.",
    group: "drift",
    kind: "toggle",
    env: "CCP_DRIFT_PROPOSALS",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "drift.import",
    label: "Offer to adopt resources created outside Terraform",
    help: "Adds an 'import this' option for things found in the cloud that Terraform does not know about yet.",
    group: "drift",
    kind: "toggle",
    env: "CCP_DRIFT_IMPORT",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "drift.restore",
    label: "Offer to restore deleted resources",
    help: "Adds a 'put it back' option for something that was deleted outside Terraform.",
    group: "drift",
    kind: "toggle",
    env: "CCP_DRIFT_RESTORE",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "drift.keep",
    label: "How many drift reports to keep",
    help: "Older reports beyond this count are deleted. Keeping fewer saves disk; keeping more preserves history.",
    group: "drift",
    kind: "number",
    env: "CCP_DRIFT_KEEP",
    editable: true,
    fallback: 30,
  },

  /* ── applying changes ───────────────────────────────────────────────────── */
  {
    id: "apply.frozen",
    label: "Freeze all applies",
    help: "Stops anything from being applied, regardless of approvals. A safety brake — turning it ON is always allowed immediately; turning it off needs a second admin.",
    group: "apply",
    kind: "toggle",
    env: "CCP_APPLY_FROZEN",
    editable: true,
    fallback: false,
    // Inverted on purpose: the LOOSENING direction here is turning the brake OFF.
    loosens: (before, after) => before === true && after !== true,
  },
  {
    id: "apply.scheduler",
    label: "Run scheduled applies",
    help: "Lets approved changes apply at their scheduled time without someone pressing a button. Off by default.",
    group: "apply",
    kind: "toggle",
    env: "CCP_SCHEDULER",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "apply.autoRevert",
    label: "Automatically roll back a failed apply",
    help: "When an apply fails part-way, attempt to put things back as they were instead of leaving them half-changed.",
    group: "apply",
    kind: "toggle",
    env: "CCP_APPLY_AUTO_REVERT",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "apply.bundle",
    label: "Prepare a pull request from an approved change",
    help: "Turns approved requests into a ready-to-review pull request on your repository.",
    group: "apply",
    kind: "toggle",
    env: "CCP_BUNDLE",
    editable: true,
    fallback: false,
    loosens: turningOn,
  },
  {
    id: "apply.gateCommand",
    label: "Command run to check a prepared change",
    help: "A command this server executes on the machine it runs on.",
    group: "apply",
    kind: "text",
    env: "CCP_BUNDLE_GATE_CMD",
    editable: {
      reason:
        "This is a command this server runs on its own machine. A box in a web page that sets a command to run would turn one stolen admin session into control of the server itself.",
      instead:
        "Set it in the deployment's configuration, where changing it needs access to the machine.",
    },
  },
  {
    id: "apply.triggerCommand",
    label: "Command run to start an apply",
    help: "A command this server executes on the machine it runs on.",
    group: "apply",
    kind: "text",
    env: "CCP_BUNDLE_TRIGGER_CMD",
    editable: {
      reason:
        "Same as above — it runs on the server. Editing commands from a browser is a remote shell with extra steps.",
      instead: "Set it in the deployment's configuration.",
    },
  },
  {
    id: "drift.checkCommand",
    label: "Command run to check for drift",
    help: "A command this server executes on the machine it runs on.",
    group: "drift",
    kind: "text",
    env: "CCP_DRIFT_CHECK_CMD",
    editable: {
      reason: "It runs on the server, so it stays behind machine access.",
      instead: "Set it in the deployment's configuration.",
    },
  },
  {
    id: "drift.generateCommand",
    label: "Command run to generate a drift fix",
    help: "A command this server executes on the machine it runs on.",
    group: "drift",
    kind: "text",
    env: "CCP_DRIFT_GEN_CMD",
    editable: {
      reason: "It runs on the server, so it stays behind machine access.",
      instead: "Set it in the deployment's configuration.",
    },
  },

  /* ── where the code lives ───────────────────────────────────────────────── */
  {
    id: "git.remote",
    label: "Repository the prepared changes are pushed to",
    help: "Where a prepared pull request is sent.",
    group: "git",
    kind: "text",
    env: "CCP_GIT_REMOTE",
    editable: true,
    fallback: "",
  },
  {
    id: "git.branch",
    label: "Branch prepared changes start from",
    help: "The branch a prepared change branches off and targets.",
    group: "git",
    kind: "text",
    env: "CCP_GIT_BRANCH",
    editable: true,
    fallback: "main",
  },
  {
    id: "git.terraformRoot",
    label: "Folder in the repository holding the Terraform",
    help: "Leave blank if the Terraform is at the top of the repository.",
    group: "git",
    kind: "text",
    env: "CCP_TF_ROOT",
    editable: true,
    fallback: "",
  },
  {
    id: "apply.executor",
    label: "How applies are run",
    help: "Which runner carries out an apply.",
    group: "apply",
    kind: "text",
    env: "CCP_EXECUTOR",
    editable: true,
    fallback: "",
  },

  /* ── identity ───────────────────────────────────────────────────────────── */
  {
    id: "identity.name",
    label: "What this system is called",
    help: "The name shown in the header and on the sign-in page.",
    group: "identity",
    kind: "text",
    env: "CCP_INSTANCE_NAME",
    editable: {
      reason: "Already editable in the portal — just on a different screen.",
      instead: "Settings → change the name and tagline there.",
    },
  },
  {
    id: "identity.totpKey",
    label: "Key that encrypts two-factor secrets",
    help: "Protects everyone's authenticator secrets.",
    group: "identity",
    kind: "text",
    env: "CCP_TOTP_KEY",
    secret: true,
    editable: {
      reason:
        "This is the key that encrypts things kept in this system's storage. A key kept inside the thing it encrypts protects nothing.",
      instead: "Set it in the deployment's configuration and restart.",
    },
  },
  {
    id: "identity.bootstrap",
    label: "First-run admin setup",
    help: "Creates the very first admin account and prints a one-time password.",
    group: "identity",
    kind: "toggle",
    env: "CCP_BOOTSTRAP",
    editable: {
      reason:
        "It runs once, before any admin account exists — so there is nobody to sign in and set it.",
      instead:
        "It is a first-boot step only, and the server refuses it once an account exists.",
    },
  },

  /* ── how browsers reach it ──────────────────────────────────────────────── */
  {
    id: "session.secureCookies",
    label: "Require HTTPS for sign-in cookies",
    help: "Whether the sign-in cookie is marked as HTTPS-only.",
    group: "session",
    kind: "toggle",
    env: "CCP_SECURE_COOKIES",
    editable: {
      reason:
        "Getting this wrong signs everyone out, including whoever changed it — and it has to be right BEFORE anyone can log in to fix it.",
      instead: "Set it in the deployment's configuration alongside your proxy.",
    },
  },
  {
    id: "session.sameSite",
    label: "Cookie cross-site rule",
    help: "Depends on whether the app and this system share one address.",
    group: "session",
    kind: "text",
    env: "CCP_COOKIE_SAMESITE",
    editable: {
      reason: "Same as above — a wrong value locks everyone out.",
      instead: "Set it in the deployment's configuration.",
    },
  },
  {
    id: "session.corsOrigin",
    label: "Web address allowed to talk to this system",
    help: "The address the app is served from.",
    group: "session",
    kind: "text",
    env: "CCP_CORS_ORIGIN",
    editable: {
      reason:
        "Read as the server starts, and a wrong value stops the app reaching it at all — including the screen you would fix it from.",
      instead: "Set it in the deployment's configuration.",
    },
  },

  /* ── the machine ────────────────────────────────────────────────────────── */
  {
    id: "storage.location",
    label: "Where this system keeps its data",
    help: "The folder holding accounts, settings and the audit trail.",
    group: "storage",
    kind: "text",
    env: "CCP_DATA_DIR",
    editable: {
      reason:
        "This is where the settings themselves live. It has to be known before anything can be read.",
      instead: "Set it in the deployment's configuration.",
    },
  },
  {
    id: "process.port",
    label: "Port this system listens on",
    help: "The network port inside the container.",
    group: "process",
    kind: "number",
    env: "PORT",
    editable: {
      reason:
        "A property of the container, not of the running system — it is already listening by the time any setting could be read.",
      instead: "Set it in the deployment's configuration.",
    },
  },
];

const BY_ID = new Map(KNOBS.map((k) => [k.id, k]));
export function knobById(id: string): Knob | undefined {
  return BY_ID.get(id);
}
/** Only these may be written through the portal — the gate the route enforces. */
export function isPortalEditable(id: string): boolean {
  return knobById(id)?.editable === true;
}

/** Deployment settings are GLOBAL, so they live on the reserved control scope
 * rather than any estate's. One home, whichever project you happen to be in. */
export const DEPLOYMENT_SCOPE = CONTROL_SCOPE;
/**
 * Key prefixes owned by a SETTINGS REGISTRY rather than by the generic
 * `PUT /admin/settings/:key` route.
 *
 * This exists because of a real bypass, found by review and reproduced before
 * it was fixed. The generic settings route takes its key straight from the URL
 * and writes `settingKey(callerScope, key)`. A registry-backed knob is stored
 * at `settingKey(@control, 'deployment.<id>')` — the SAME row. So an admin
 * bound to `*`, sending no `x-ccp-project` header (which defaults to
 * `@control`), could `PUT /admin/settings/deployment.scanner.enabled` and:
 *
 *   - skip the registry's editable gate entirely, and
 *   - skip the DUAL CONTROL, because an unrecognised key falls through that
 *     route's classification chain to "tightening" and applies at once.
 *
 * Verified: the proper route returned 202 and left the scanner disarmed, while
 * the generic route returned 200 and armed it — one admin, no second approver.
 *
 * The fix is this list plus {@link isRegistryOwnedKey}: a registry's keys are
 * writable ONLY through the route that knows their rules. `estate.` is reserved
 * ahead of the per-estate registry landing, so the same hole cannot reopen for
 * it the day it ships.
 */
export const REGISTRY_KEY_PREFIXES = ["deployment.", "estate."] as const;

/** True for a settings key that belongs to a registry, whichever scope it is
 * being written in — the generic settings route must refuse these. */
export function isRegistryOwnedKey(key: string): boolean {
  return REGISTRY_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** The settings-store key for a knob. Namespaced so it can never collide with
 * the per-project settings (freeze, allowlist, rate limits) in the same store,
 * and so {@link isRegistryOwnedKey} can recognise it. */
export function knobSettingKey(id: string): string {
  return `deployment.${id}`;
}

export type Env = Record<string, string | undefined>;
export type KnobSource = "portal" | "environment" | "default";
export type ResolvedKnob = {
  value: unknown;
  source: KnobSource;
};

/** Parse an environment string into the knob's shape. `'1'` is the repo's
 * established "on" spelling (domain/apply/loop.ts, domain/scanner.ts) and stays
 * the only one, so a stray `true`/`yes` reads as OFF rather than half-working. */
function fromEnv(knob: Knob, raw: string): unknown {
  switch (knob.kind) {
    case "toggle":
      return raw === "1";
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "list":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    default:
      return raw;
  }
}

/**
 * THE PRECEDENCE, in one place: what an admin set in the portal wins; otherwise
 * the deployment's environment; otherwise the built-in default.
 *
 * The environment still being honoured is what makes this safe to ship to an
 * existing deployment — nothing an operator already configured stops working,
 * and the portal is purely additive until someone uses it.
 */
export async function resolveKnob(
  store: ConfigStore,
  id: string,
  env: Env = process.env,
): Promise<ResolvedKnob> {
  const knob = knobById(id);
  if (!knob) return { value: undefined, source: "default" };

  if (knob.editable === true) {
    const stored = await loadSetting(
      store,
      DEPLOYMENT_SCOPE,
      knobSettingKey(id),
    );
    if (stored !== undefined) return { value: stored, source: "portal" };
  }
  const raw = env[knob.env];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = fromEnv(knob, raw);
    if (parsed !== undefined) return { value: parsed, source: "environment" };
  }
  return { value: knob.fallback, source: "default" };
}

/** Convenience for the common on/off read. */
export async function knobEnabled(
  store: ConfigStore,
  id: string,
  env: Env = process.env,
): Promise<boolean> {
  return (await resolveKnob(store, id, env)).value === true;
}

/**
 * What the portal renders for one knob. A SECRET never carries `value` — only
 * whether one is configured — so a screenshot of this screen leaks nothing.
 */
export type KnobView = {
  id: string;
  label: string;
  help: string;
  group: KnobGroup;
  kind: KnobKind;
  env: string;
  editable: boolean;
  /** Present only when `editable` is false. */
  notEditable?: NotEditable;
  source: KnobSource;
  secret?: true;
  value?: unknown;
  /** For a secret: whether anything is set at all. */
  configured?: boolean;
};

export async function knobView(
  store: ConfigStore,
  knob: Knob,
  env: Env = process.env,
): Promise<KnobView> {
  const { value, source } = await resolveKnob(store, knob.id, env);
  const base: KnobView = {
    id: knob.id,
    label: knob.label,
    help: knob.help,
    group: knob.group,
    kind: knob.kind,
    env: knob.env,
    editable: knob.editable === true,
    source,
    ...(knob.editable === true ? {} : { notEditable: knob.editable }),
  };
  if (knob.secret) {
    const raw = env[knob.env];
    return {
      ...base,
      secret: true,
      configured: typeof raw === "string" && raw.length > 0,
    };
  }
  return { ...base, value };
}

export async function deploymentView(
  store: ConfigStore,
  env: Env = process.env,
): Promise<KnobView[]> {
  return Promise.all(KNOBS.map((k) => knobView(store, k, env)));
}
