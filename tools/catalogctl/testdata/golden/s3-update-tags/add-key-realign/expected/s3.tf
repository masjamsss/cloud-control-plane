resource "aws_s3_bucket" "bird_datalake" {
  bucket = "bird-datalake"

  tags = {
    PIC        = "user05@example.com"
    CostCenter = "ERP-BASIS"
  }

  lifecycle {
    prevent_destroy = true
  }
}
