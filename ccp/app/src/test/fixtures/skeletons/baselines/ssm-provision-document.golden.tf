# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The document content can run arbitrary commands on managed instances; the content is authored and reviewed by an engineer, never captured or run from this form.
# TODO: Confirm the document type and target scope: a Command or Automation document executes on whatever it targets, so the target type is confirmed at review.

resource "aws_ssm_document" "app_restart_runbook" {
  # TODO: content — engineer decides
  name = "app-restart-runbook"
  document_type = "Automation"
  document_format = "JSON"
  tags = {
    Description = "App restart runbook"
    PIC = "Ops team"
  }
}
