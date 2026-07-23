# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Placement sets inheritance: a management group's parent decides the policy and role assignments every subscription beneath it inherits, so the engineer places it consciously.
# TODO: The management-group ID is immutable — it cannot be renamed after creation, so confirm it before applying.
# TODO: This provisions an empty group; placing subscriptions into it is a separate, reviewed change that re-evaluates their inherited policy and roles.

resource "azurerm_management_group" "platform_landing_zone" {
  # TODO: parent_management_group_id — engineer decides
  name = "platform-landing-zone"
  display_name = "Platform Landing Zone"
}
