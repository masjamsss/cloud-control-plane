resource "aws_s3_bucket" "bird_datalake" {
  bucket = "bird-datalake"

  tags = {
    # owner of record
    PIC = "user09@example.com"
  }

  lifecycle {
    prevent_destroy = true
  }
}
