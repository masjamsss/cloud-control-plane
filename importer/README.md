# Importer kit

Tooling for **adopting an existing cloud environment into Terraform** — the import-first
onboarding path for a new estate. Kept separate from any managed Terraform so that root
stays clean, generated IaC.

- `kit/` — the AWS discovery + import-generation toolkit (offline, fixture-driven, stdlib
  Python). It sweeps a recorded capture of an account, maps resources to services, and emits
  `import {}` blocks and a manifest for review.
- `kit-azure/` — the equivalent for Azure estates.

The kit is deliberately **read-only against the cloud** in its discovery phase and produces
artifacts a human reviews before anything is applied. Real account data, OIDC trust, and an
operator's own import inventory are **not** part of this repository — they live in the
operator's private estate repo.

## Using it

```bash
python3 -m unittest discover -s importer/kit/tests   # the test suite
importer/kit/discover.py --help                       # discovery entry point
```

See the scripts' own `--help` for the discovery → normalize → generate flow.
