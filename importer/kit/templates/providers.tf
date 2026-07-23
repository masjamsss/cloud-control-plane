# NOTE: default_tags is intentionally DEFERRED (kept commented) so this config
# matches the state at import time with zero writes to live resources — the
# same call environments/prod made. Enabling default_tags is its own reviewed
# PR after the import lands. See docs/standards/tagging-policy.md.
#
# Extra regions: add aliased providers per region as needed, mirroring
# environments/prod/providers.tf (aliases ap_southeast_1 / us_east_1 there).

provider "aws" {
  region = var.region

  # default_tags {
  #   tags = {
  #     Environment = var.environment
  #     ManagedBy   = "terraform"
  #     Owner       = var.owner
  #   }
  # }
}
