# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Transit and at-rest encryption for a standalone Redis/Valkey node are engineer decisions — Memcached supports neither
# TODO: Parameter group tuning and a non-default port or maintenance window are engineer decisions
# TODO: Cross-AZ node placement (preferred_availability_zones) beyond the default is an engineer decision

resource "aws_elasticache_cluster" "app_memcached" {
  cluster_id = "app-memcached"
  engine = "memcached"
  node_type = "cache.m5.large"
  num_cache_nodes = 1
  subnet_group_name = aws_elasticache_subnet_group.cache_tier.name
  security_group_ids = [aws_security_group.access_to_app01.id]
  tags = {
    Name = "app-memcached"
    Description = "Memcached cluster for the app tier"
    PIC = "Ops team"
  }
}
