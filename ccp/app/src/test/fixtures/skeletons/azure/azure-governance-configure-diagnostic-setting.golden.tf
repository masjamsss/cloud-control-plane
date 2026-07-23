# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Audit redirection is a security-sensitive change: sending a resource's logs to the wrong sink can hide activity from detection, so the destination must be an approved, access-controlled workspace, storage account, or event hub.
# TODO: At least one destination is required — the engineer confirms which approved sink receives these logs.
# TODO: Confirm the log and metric categories match the target resource; a retargeted setting needs categories that resource actually emits.

resource "azurerm_monitor_diagnostic_setting" "kv_audit_to_logs" {
  name = "kv-audit-to-logs"
  target_resource_id = azurerm_key_vault.app_secrets.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.central.id
  enabled_log {
    category = "AuditEvent"
  }
  metric {
    category = "AllMetrics"
    enabled = true
  }
}
