# Pins for a NEW Azure environment root scaffolded by importer/kit-azure/normalize.py.
# The exact provider pins are load-bearing, exactly as environments/prod/versions.tf's
# aws = 6.53.0 pin is for the AWS estate: the (future) azurerm ForceNew schemadump and
# any catalogctl plan-check reasoning are verified at THIS tag, so bumping it without a
# matching schemadump must fail closed rather than silently drift (mirrors the AWS
# ForceNew verify-gate rationale — see importer/kit/templates/versions.tf).
#
# azapi is included because it is the read-only-safe FALLBACK provider for any resource
# type azurerm cannot model (importer/kit-azure/azure-services.json providerHint = azapi).
# If your estate has no azapi-hinted types you may drop that block, but keeping it costs
# nothing until an azapi_resource is actually declared.
terraform {
  required_version = "~> 1.10"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "4.14.0" # exact pin — bind to the azurerm schemadump/ForceNew truth at this tag
    }
    azapi = {
      source  = "Azure/azapi"
      version = "2.1.0" # exact pin — fallback provider for types azurerm cannot model
    }
  }
}
