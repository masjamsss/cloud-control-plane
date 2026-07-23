# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A lock changes what is protected: ReadOnly blocks every change in scope and CanNotDelete blocks deletions — both can halt legitimate operations if mis-scoped, so the engineer confirms the scope.
# TODO: Removing this lock later removes the protection — that removal is its own reviewed change; confirm nothing depends on the lock staying in place.
# TODO: A ReadOnly lock can block operations that look like reads but write underneath (some list or connection actions); confirm the workload tolerates it.

resource "azurerm_management_lock" "prod_rg_cannotdelete" {
  name = "prod-rg-cannotdelete"
  lock_level = "CanNotDelete"
  scope = azurerm_resource_group.app.id
  notes = "Protects the production resource group from deletion"
}
