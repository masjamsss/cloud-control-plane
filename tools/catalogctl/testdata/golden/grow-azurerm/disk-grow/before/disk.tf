resource "azurerm_managed_disk" "data01" {
  name                 = "data01"
  resource_group_name  = "core-rg"
  location             = "eastus"
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = 128

  tags = {
    Owner = "platform"
  }
}
