# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Multi-region replication's region list is an engineer decision — this form provisions the common single-region case
# TODO: Tables, with their own capacity mode and TTL settings, are an engineer follow-up after the keyspace exists

resource "aws_keyspaces_keyspace" "session_state" {
  name = "session_state"
  tags = {
    Name = "session_state"
    Description = "Session-state keyspace for the app tier"
    PIC = "Ops team"
  }
  replication_specification {
    replication_strategy = "SINGLE_REGION"
  }
}
