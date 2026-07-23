variable "location" {
  description = "Primary Azure region for this environment (e.g. southeastasia)"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription GUID this environment's resources live in"
  type        = string
}

variable "tenant_id" {
  description = "Azure Entra tenant GUID"
  type        = string
}

# owner feeds tag governance, which is DEFERRED (no default tags in providers.tf) so the import
# stays zero-write — same posture as environments/prod.
# tflint-ignore: terraform_unused_declarations
variable "owner" {
  description = "Team responsible for this environment (default Owner tag, applied in a later PR)"
  type        = string
  default     = "platform-team"
}
