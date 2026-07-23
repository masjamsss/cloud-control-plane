# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Machine image choice and validation
# TODO: SSH public key material is attached by the engineer during review
# TODO: Confirm the subnet and network security group together satisfy the workload's connectivity needs
# TODO: Confirm the chosen size is available in the resource group's region

resource "azurerm_network_interface" "app_web_01" {
  name = "app_web_01-nic"
  location = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  ip_configuration {
    name = "internal"
    subnet_id = azurerm_subnet.app.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_network_interface_security_group_association" "app_web_01" {
  network_interface_id = azurerm_network_interface.app_web_01.id
  network_security_group_id = azurerm_network_security_group.app.id
}

resource "azurerm_linux_virtual_machine" "app_web_01" {
  # TODO: source_image_reference — engineer decides
  # TODO: admin_ssh_key — engineer decides
  location = azurerm_resource_group.app.location
  network_interface_ids = [azurerm_network_interface.app_web_01.id]
  name = "app-web-01"
  resource_group_name = azurerm_resource_group.app.name
  size = "Standard_D2s_v5"
  admin_username = "azureadmin"
  disable_password_authentication = true
  tags = {
    Name = "app-web-01"
    Description = "Front-end web node"
    PIC = "Ops team"
  }
  os_disk {
    disk_size_gb = 128
    storage_account_type = "Premium_LRS"
    caching = "ReadWrite"
  }
  lifecycle {
    prevent_destroy = true
  }
}
