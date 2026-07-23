resource "aws_s3_bucket" "bird_db" {
  bucket = "bird-db"

  lifecycle {
    prevent_destroy = true
  }
}
