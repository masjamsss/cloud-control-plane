# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Kubernetes version — the engineer picks and validates the exact patch version against the estate's supported-version policy.
# TODO: Disabling local accounts requires Azure AD group integration (azure_active_directory_role_based_access_control) added during review, or cluster access is lost.
# TODO: Node pool autoscaling — leave the minimum/maximum blank for a fixed-size pool, or set them (with autoscaling enabled) to let Azure manage node_count itself.
# TODO: Private cluster networking — confirm a private connectivity path (VPN, ExpressRoute, jump host) exists before relying on a private API server; authorized IP ranges are the alternative for a public-but-restricted API server.

resource "azurerm_kubernetes_cluster" "app_aks_01" {
  # TODO: kubernetes_version — engineer decides
  location = azurerm_resource_group.app.location
  name = "app-aks-01"
  resource_group_name = azurerm_resource_group.app.name
  dns_prefix = "appaks01"
  role_based_access_control_enabled = true
  local_account_disabled = true
  private_cluster_enabled = true
  azure_policy_enabled = true
  tags = {
    Name = "app-aks-01"
    Description = "Application Kubernetes cluster"
    PIC = "Ops team"
  }
  default_node_pool {
    name = "system"
    vm_size = "Standard_D2s_v5"
    node_count = 3
  }
  identity {
    type = "SystemAssigned"
  }
}
