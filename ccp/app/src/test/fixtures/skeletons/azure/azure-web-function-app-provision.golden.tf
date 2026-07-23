# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Confirm the chosen region matches the target App Service plan's own region — Azure requires them to align.
# TODO: Grant the function app's managed identity the appropriate role (for example Storage Blob Data Owner) on the storage account, and confirm the app carries an identity block — required for storage_uses_managed_identity to actually authenticate.
# TODO: The application_stack (language/runtime and version, or a container image) inside site_config — the engineer sets the exact block during review.
# TODO: The code package and its triggers are always delivered by the engineer, never uploaded here.
# TODO: App settings and connection strings are deliberately excluded here — they can carry secrets and are added by the engineer after review.

resource "azurerm_linux_function_app" "app_webhook" {
  # TODO: application_stack — engineer decides
  location = azurerm_service_plan.shared.location
  name = "app-webhook"
  resource_group_name = azurerm_resource_group.app.name
  service_plan_id = azurerm_service_plan.shared.id
  storage_account_name = azurerm_storage_account.appfunc.name
  storage_uses_managed_identity = true
  https_only = true
  tags = {
    Name = "app-webhook"
    Description = "Webhook function app"
    PIC = "Ops team"
  }
  site_config {
    minimum_tls_version = "1.2"
    ftps_state = "Disabled"
  }
}
