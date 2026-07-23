# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Retargeting or deleting an alias redirects every encryptor that references it by name to a different key, or breaks them. Confirm the target key is correct, and treat any later retarget as its own reviewed change.

resource "aws_kms_alias" "alias_app_data" {
  name = "alias/app-data"
  target_key_id = aws_kms_key.shared_cmk.id
}
