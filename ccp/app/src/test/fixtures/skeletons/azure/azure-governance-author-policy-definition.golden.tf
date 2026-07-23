# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Engineer-authored rule logic: a policy definition is code that decides what every assignment of it allows or denies, so the policy_rule JSON is written and reviewed by an engineer, never self-service.
# TODO: Confirm the mode: All evaluates every resource type, Indexed only those that carry tags and a location — the wrong mode silently skips resources you meant to govern.
# TODO: A definition does nothing until it is assigned; the assignment, and its enforce-versus-audit choice, is a separate reviewed step.

resource "azurerm_policy_definition" "require_owner_tag" {
  # TODO: policy_rule — engineer decides
  # TODO: parameters — engineer decides
  name = "require-owner-tag"
  display_name = "Require an Owner tag on resources"
  policy_type = "Custom"
  mode = "Indexed"
  description = "Denies resources created without an Owner tag"
}
