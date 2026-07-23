# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: The key uses the DEFAULT KMS key policy (root-account administration). A custom key policy that grants cross-account access or broad principal access is an engineer decision and is deliberately not exposed on this form.
# TODO: Key rotation is enabled and the deletion window guards against accidental loss; confirm the window fits the recovery requirement, since a destroyed key renders every ciphertext under it permanently unrecoverable.

resource "aws_kms_key" "app_data_encryption_key" {
  description = "app data encryption key"
  key_usage = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation = true
  deletion_window_in_days = 30
  tags = {
    Description = "App data key"
    PIC = "Ops team"
  }
}
