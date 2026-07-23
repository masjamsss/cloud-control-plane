# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: A custom MSK configuration (configuration_info) and broker-level parameter overrides are engineer decisions
# TODO: Mutual TLS (client certificate authentication) and Kafka ACLs are engineer decisions — this form enables IAM authentication by default
# TODO: Open monitoring (Prometheus/JMX) and broker logging destinations are engineer follow-ups after creation
# TODO: Public access and multi-VPC connectivity are engineer decisions — brokers are VPC-internal only by default

resource "aws_msk_cluster" "events_backbone" {
  cluster_name = "events-backbone"
  kafka_version = "3.9.x"
  number_of_broker_nodes = 3
  tags = {
    Name = "events-backbone"
    Description = "Kafka backbone for the events pipeline"
    PIC = "Ops team"
  }
  broker_node_group_info {
    instance_type = "kafka.m5.large"
    client_subnets = [aws_subnet.backup.id, aws_subnet.backup_sg.id]
    security_groups = [aws_security_group.access_to_app01.id]
  }
  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster = true
    }
  }
  client_authentication {
    sasl {
      iam = true
    }
  }
}
