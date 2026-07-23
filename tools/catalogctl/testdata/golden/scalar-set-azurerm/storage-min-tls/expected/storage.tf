resource "azurerm_storage_account" "appdata001" {
  name                     = "appdata001"
  resource_group_name      = "core-rg"
  location                 = "eastus"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  tags = {
    Owner = "platform"
  }
}
