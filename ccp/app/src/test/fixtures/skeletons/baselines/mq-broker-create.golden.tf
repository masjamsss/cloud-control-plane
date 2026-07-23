# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Additional broker users beyond the one authored here (the user block, a set) are an engineer follow-up.
# TODO: LDAP authentication, a custom broker engine configuration (aws_mq_configuration), and cross-region data replication are engineer follow-ups after creation.

resource "aws_mq_broker" "orders_broker" {
  # TODO: engine_version — engineer decides
  # TODO: password — engineer decides
  broker_name = "orders-broker"
  engine_type = "ActiveMQ"
  host_instance_type = "mq.m5.large"
  deployment_mode = "SINGLE_INSTANCE"
  publicly_accessible = false
  subnet_ids = [aws_subnet.backup.id]
  security_groups = [aws_security_group.access_to_app01.id]
  auto_minor_version_upgrade = true
  apply_immediately = false
  tags = {
    Name = "ORDERS-BROKER"
    Description = "ActiveMQ broker for the order-processing service"
    PIC = "Ops team"
  }
  user {
    username = "app-admin"
    console_access = false
  }
}
