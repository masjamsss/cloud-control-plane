# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The image recipe and infrastructure configuration are prerequisite resources this catalog does not yet create — an engineer picks validated existing ones during review
# TODO: A container recipe (building into ECR instead of an AMI), a distribution configuration, and cross-account/region distribution are engineer decisions
# TODO: Additional workflows (build/test/distribution stage customization) beyond the recipe's defaults are an engineer follow-up

resource "aws_imagebuilder_image_pipeline" "golden_al2023_pipeline" {
  # TODO: image_recipe_arn — engineer decides
  # TODO: infrastructure_configuration_arn — engineer decides
  name = "golden-al2023-pipeline"
  description = "Builds the estate golden AL2023 AMI"
  status = "ENABLED"
  tags = {
    Name = "GOLDEN-AL2023-PIPELINE"
    Description = "Golden AMI build pipeline"
    PIC = "Ops team"
  }
  image_scanning_configuration {
    image_scanning_enabled = true
  }
  schedule {
    schedule_expression = "cron(0 0 * * ? *)"
  }
}
