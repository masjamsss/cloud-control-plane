# State backend — fill REPLACE_STATE_BUCKET before `terraform init` (scaffold
# --state-bucket fills it for you). The shape mirrors environments/prod:
# versioned private bucket, SSE asserted, S3-native lockfile (TF >= 1.10).
# The state-WRITING credential needs only importer/state-writer-policy.json
# (S3 rw under Terraform/*) on top of read-only — never broader.
terraform {
  backend "s3" {
    bucket = "REPLACE_STATE_BUCKET"
    key    = "Terraform/REPLACE_ENV/terraform.tfstate"
    region = "REPLACE_REGION"
    # If the bucket default is SSE-S3 (AES256) no kms_key_id is needed;
    # encrypt=true still asserts server-side encryption on the state object.
    encrypt      = true
    use_lockfile = true # writes Terraform/REPLACE_ENV/terraform.tfstate.tflock
  }
}
