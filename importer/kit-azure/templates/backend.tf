# State backend — an Azure Storage Account + blob container, the analog of the AWS estate's
# versioned private S3 bucket. Fill the placeholder values before `terraform init` (normalize.py
# scaffold --state-storage-account / --state-container / --state-resource-group fill them).
#
# use_azuread_auth = true makes Terraform authenticate to the state blob with the caller's Entra
# identity (the data plane) instead of a storage account key — so the scoped state-writer identity
# needs the DATA-plane role "Storage Blob Data Contributor" on this container, NOT control-plane
# Contributor on the account (the classic Azure mistake; see docs/runbooks/azure-subscription-import.md).
# Blob lease locking (built in) replaces the AWS S3 use_lockfile. Storage accounts are always
# encrypted at rest.
terraform {
  backend "azurerm" {
    resource_group_name  = "REPLACE_STATE_RESOURCE_GROUP"
    storage_account_name = "REPLACE_STATE_STORAGE_ACCOUNT"
    container_name       = "REPLACE_STATE_CONTAINER"
    key                  = "REPLACE_ENV.terraform.tfstate"
    use_azuread_auth     = true
  }
}
