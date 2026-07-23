resource "aws_db_snapshot" "prod" {
  db_instance_identifier = "prod-db"
  db_snapshot_identifier = "prod-db-final"
  shared_accounts        = []
}
