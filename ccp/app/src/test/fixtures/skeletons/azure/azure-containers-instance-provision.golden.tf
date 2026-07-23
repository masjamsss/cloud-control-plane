# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Container image — the draft carries a <registry>/<image>:<tag> placeholder inside the container block; the engineer replaces it with the real, validated image reference during review.
# TODO: Private IP address type needs the reviewing engineer to add a subnet reference (subnet_ids); None needs no networking; Public needs neither but is internet-reachable.
# TODO: Only one exposed port is captured here; additional ports are an engineer follow-up during review.
# TODO: Restart policy and diagnostics are left at the provider default; adjust during review if the workload needs different behavior.

resource "azurerm_container_group" "app_batch_01" {
  location = azurerm_resource_group.app.location
  name = "app-batch-01"
  resource_group_name = azurerm_resource_group.app.name
  os_type = "Linux"
  ip_address_type = "Private"
  tags = {
    Name = "app-batch-01"
    Description = "Batch worker container group"
    PIC = "Ops team"
  }
  container {
    name = "worker"
    image = "<registry>/<image>:<tag>"
    cpu = 1
    memory = 1.5
    ports {
      port = 80
      protocol = "TCP"
    }
  }
}
