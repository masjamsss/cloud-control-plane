# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: No wildcard: a custom role's action list is the ceiling every assignment of it inherits, so confirm no action or data-action is `*` (all access) before it is authored.
# TODO: Keep the action list minimal — each action added here is granted to every future assignment of the role, everywhere it is assignable.
# TODO: The management scope the role is created at and its assignable scopes decide how far it can spread; the engineer sets both to the narrowest that works.

resource "azurerm_role_definition" "storage_reader_custom" {
  # TODO: scope — engineer decides
  # TODO: assignable_scopes — engineer decides
  name = "Storage Reader Custom"
  description = "Least-privilege read role for storage operators"
  permissions {
    actions = ["Microsoft.Storage/storageAccounts/read", "Microsoft.Storage/storageAccounts/listKeys/action"]
    not_actions = ["Microsoft.Storage/storageAccounts/delete"]
  }
}
