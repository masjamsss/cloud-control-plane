# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: AUTH token / Redis password rotation goes through the secrets manager — never entered in this portal
# TODO: Cluster mode (sharding via node_group_configuration) is an engineer decision — this form provisions the common single-shard, multi-replica case
# TODO: Parameter group tuning and a non-default maintenance/snapshot window are engineer decisions
# TODO: Log delivery to CloudWatch or Kinesis Firehose is an engineer follow-up after creation

resource "aws_elasticache_replication_group" "session_cache" {
  replication_group_id = "session-cache"
  description = "Session cache for the web tier"
  engine = "redis"
  node_type = "cache.m5.large"
  num_cache_clusters = 2
  automatic_failover_enabled = true
  multi_az_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name = aws_elasticache_subnet_group.cache_tier.name
  security_group_ids = [aws_security_group.access_to_app01.id]
  tags = {
    Name = "session-cache"
    Description = "Session cache for the web tier"
    PIC = "Ops team"
  }
}
