resource "aws_s3_bucket" "bird_datalake" {
  bucket = "bird-datalake"

  tags = {
    # owner of record
    PIC = "user05@example.com"
  }

  lifecycle {
    prevent_destroy = true
  }
}
