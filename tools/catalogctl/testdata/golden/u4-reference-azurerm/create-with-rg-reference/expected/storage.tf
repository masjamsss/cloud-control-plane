resource "azurerm_storage_account" "appdata002" {
  name = "appdata002"
  resource_group_name = azurerm_resource_group.main.name
}
