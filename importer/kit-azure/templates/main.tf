# Resources land here as the import progresses (normalize.py split writes one file per service
# — network.tf, storage.tf, keyvault.tf, database.tf ... — mirroring the environments/prod layout).
# Workflow per resource: importer/kit-azure/docs/import-plan.md
# (import block -> aztfexport --hcl-only / terraform plan -generate-config-out -> refactor ->
#  no-op plan -> PR).
