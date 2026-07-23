variable "region" {
  description = "AWS region for this environment"
  type        = string
}

# environment + owner feed provider default_tags, which is DEFERRED (commented
# in providers.tf) so the import stays zero-write — same as environments/prod.
# tflint-ignore: terraform_unused_declarations
variable "environment" {
  description = "Environment name (used in default tags and naming)"
  type        = string
  default     = "REPLACE_ENV"
}

# tflint-ignore: terraform_unused_declarations
variable "owner" {
  description = "Team responsible for this environment (default Owner tag)"
  type        = string
}
