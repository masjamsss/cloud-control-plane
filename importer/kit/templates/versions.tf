# Pins mirror environments/prod/versions.tf EXACTLY. The exact provider pin is
# load-bearing: the ForceNew verify gate (docs/proposals/0006 §5) and the Cloud Control Plane's
# per-tag schema dump (tools/schemadump/aws-v6.53.0-schema.json) are verified at
# this tag. Changing it means onboarding fails closed until a dump exists for
# the new tag (docs/proposals/0022 §8.2) — a deliberate cost, not an oversight.
terraform {
  required_version = "~> 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.53.0" # exact pin — the ForceNew verify gate (docs/proposals/0006 §5) checks against this tag
    }
  }
}
