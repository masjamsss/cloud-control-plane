# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Enforce versus audit is the blocking-versus-advisory decision, and a management-group assignment is inherited by every subscription in the group — its blast radius is the whole branch of the hierarchy.
# TODO: Confirm the policy has run in audit mode across the group before switching it to enforce.
# TODO: Placement matters: the higher the management group, the more subscriptions inherit this assignment.

resource "azurerm_management_group_policy_assignment" "require_owner_tag_mg" {
  name = "require-owner-tag-mg"
  policy_definition_id = azurerm_policy_definition.require_owner_tag.id
  management_group_id = azurerm_management_group.platform.id
  enforcement_mode = "DoNotEnforce"
  description = "Audit the Owner-tag policy across the platform group"
}
