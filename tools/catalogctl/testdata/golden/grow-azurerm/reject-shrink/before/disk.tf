resource "azurerm_managed_disk" "data02" {
  name                 = "data02"
  resource_group_name  = "core-rg"
  location             = "eastus"
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = 512

  tags = {
    Owner = "platform"
  }
}
