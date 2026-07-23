resource "azurerm_storage_account" "appdata001" {
  name     = "appdata001"
  location = "eastus"

  tags = {
    Owner = "x"
  }
}
