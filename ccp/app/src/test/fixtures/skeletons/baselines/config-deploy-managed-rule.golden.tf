# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: This form deploys AWS-managed guardrail rules only (source owner AWS). A custom-policy rule that runs engineer-authored Guard policy text is out of self-service reach.
# TODO: Confirm the rule's scope and parameters match the intent; a mis-scoped rule reports false compliance and the engineer sets any input parameters at review.

resource "aws_config_config_rule" "s3_public_read_prohibited" {
  name = "s3-public-read-prohibited"
  description = "Flag S3 buckets that allow public read"
  tags = {
    Description = "S3 public-read guardrail"
    PIC = "Ops team"
  }
  source {
    owner = "AWS"
    source_identifier = "S3_BUCKET_PUBLIC_READ_PROHIBITED"
  }
}
