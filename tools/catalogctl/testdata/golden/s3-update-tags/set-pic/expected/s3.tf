resource "aws_s3_bucket" "bird_datalake" {
  bucket = "bird-datalake"

  tags = {
    PIC = "user03@example.com"
  }

  lifecycle {
    prevent_destroy = true
  }
}
