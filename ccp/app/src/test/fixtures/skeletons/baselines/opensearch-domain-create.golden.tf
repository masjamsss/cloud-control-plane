# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Fine-grained access control (advanced_security_options) and its master user credentials are engineer decisions
# TODO: Dedicated master nodes and UltraWarm/cold-storage tiers for larger domains are engineer decisions
# TODO: Snapshot, auto-tune, and off-peak maintenance window schedules are engineer follow-ups after creation
# TODO: The access policy JSON is filled in by the engineer from the estate's standard domain-access policy

resource "aws_opensearch_domain" "app_logs" {
  # TODO: access_policies — engineer decides
  domain_name = "app-logs"
  engine_version = "OpenSearch_2.15"
  tags = {
    Name = "app-logs"
    Description = "Log search domain for the app tier"
    PIC = "Ops team"
  }
  cluster_config {
    instance_type = "m5.large.search"
    instance_count = 2
    zone_awareness_enabled = true
  }
  ebs_options {
    ebs_enabled = true
    volume_size = 100
    volume_type = "gp3"
  }
  encrypt_at_rest {
    enabled = true
  }
  node_to_node_encryption {
    enabled = true
  }
  domain_endpoint_options {
    enforce_https = true
    tls_security_policy = "Policy-Min-TLS-1-2-PFS-2023-10"
  }
  vpc_options {
    subnet_ids = [aws_subnet.backup.id]
    security_group_ids = [aws_security_group.access_to_app01.id]
  }
}
