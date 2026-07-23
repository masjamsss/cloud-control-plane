# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Master password goes through the secrets manager — never entered in this portal
# TODO: Azure AD-only authentication versus SQL authentication is an engineer decision during review
# TODO: No firewall rule is created here, so nothing can reach this server until the engineer adds one or wires up private connectivity
# TODO: Transparent data encryption key management (service-managed versus a customer key) is an engineer decision during review

resource "azurerm_mssql_server" "app_sql_01" {
  # TODO: administrator_login_password — engineer decides
  location = azurerm_resource_group.app.location
  name = "app-sql-01"
  resource_group_name = azurerm_resource_group.app.name
  version = "12.0"
  administrator_login = "sqladmin"
  minimum_tls_version = "1.2"
  public_network_access_enabled = false
  tags = {
    Name = "app-sql-01"
    Description = "Application SQL server"
    PIC = "Ops team"
  }
}
