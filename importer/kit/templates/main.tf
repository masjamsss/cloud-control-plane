# Resources land here as the import progresses (normalize.py split writes one
# file per service — ec2.tf, vpc.tf, s3.tf ... — mirroring environments/prod).
# Workflow per resource: importer/docs/import-plan.md
# (import block -> plan -generate-config-out -> refactor -> no-op plan -> PR)
