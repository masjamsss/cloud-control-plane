# Security

The Cloud Control Plane sits in the change path for real infrastructure, so security is a
first-class concern of the design.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — use GitHub's
[private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow for this repository rather than opening a public issue. We'll acknowledge and work with
you on a fix and coordinated disclosure.

## How the system is built to be safe

- **Least privilege by design.** The tool's model is read-to-plan / gated-to-apply: changes
  become reviewed pull requests and are applied by CI behind a gated environment, not by the
  portal directly.
- **Authentication.** Local accounts with password + TOTP two-factor; recovery codes; session
  and re-authentication controls.
- **Deterministic Terraform writes.** Only `catalogctl` writes HCL, and its edits are
  golden-tested — no free-form generation in the apply path.
- **No baked-in estate.** No credentials, account ids, or estate identifiers live in this
  codebase; operators supply their own at setup. A published-safety gate
  (`scripts/publish-gate.sh`) enforces that estate-specific values never enter the shared
  tree.

## Scope

This repository is the estate-agnostic product. Operational security of any particular
deployment (cloud IAM, CI credentials, network posture) is the operator's responsibility and
depends on how they configure their environment.
