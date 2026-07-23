# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Additional point-in-time policy tiers (e.g. a coarser daily rule on top of the hourly one authored here) are an engineer follow-up
# TODO: Associating this template with specific source servers happens after the template exists
# TODO: A launch configuration template (right-sizing, licensing, tags for the recovered instance) is a separate, later engineer step

resource "aws_drs_replication_configuration_template" "app_tier_drs_template" {
  staging_area_subnet_id = aws_subnet.backup.id
  replication_servers_security_groups_ids = [aws_security_group.access_to_app01.id]
  associate_default_security_group = false
  create_public_ip = false
  data_plane_routing = "PRIVATE_IP"
  replication_server_instance_type = "t3.small"
  use_dedicated_replication_server = false
  bandwidth_throttling = 0
  default_large_staging_disk_type = "GP3"
  ebs_encryption = "DEFAULT"
  auto_replicate_new_disks = true
  staging_area_tags = {
    Name = "App tier DRS staging"
  }
  tags = {
    Name = "APP-TIER-DRS-TEMPLATE"
    Description = "Replication template for the app tier"
    PIC = "Ops team"
  }
  pit_policy {
    interval = 1
    units = "HOUR"
    retention_duration = 24
  }
}
