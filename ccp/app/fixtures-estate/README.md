# fixtures-estate — synthetic Terraform root

A small, entirely synthetic Terraform root (no real account, no real
resource, nothing ever applied — AGENTS.md rule 1 forbids `terraform
apply`/`destroy` everywhere in this repo, and that applies here too). It
exists as the INPUT to the real generators
(`ccp/app/scripts/build-inventory.py` + `ccp/app/scripts/extract-blocks.ts`),
so the bundled sample estate under `ccp/app/src/data/{inventory.json,
blocks/**}` is produced by the same pipeline a real account's data goes
through, never hand-authored or string-patched into the frozen fixture
(AGENTS.md rule 5).

Account `123456789012` (AWS's own documentation-reserved placeholder),
region `us-east-1`, generic crew tags (`user01@example.com`…,
`alice`/`bob`/…). ~40 resources spanning the resource families the app's
demo mode and test suite exercise: vpc, subnet, security group, ec2, ebs,
s3, iam (users + roles — the IAM users carry AKIA-example-shaped tag keys,
sequentially numbered from the public documentation-placeholder series, so
the access-key-inventory UI stays demonstrable without a real key), rds,
efs, lambda, kms, cloudfront, acm, alb, sns, ssm, dynamodb, cloudwatch,
vpn, waf.

Regenerate the sample data after editing this root:

```
python3 ccp/app/scripts/build-inventory.py \
  --root ccp/app/fixtures-estate \
  --out ccp/app/src/data/inventory.json \
  --imports /nonexistent-imports.tf \
  --manifests ccp/app/src/data/manifests
(cd ccp/app && npx vite-node scripts/extract-blocks.ts \
  --root ../fixtures-estate --out src/data/blocks)
```

Never hand-edit `inventory.json` / `blocks/**` directly — they are the
generator's output, byte-for-byte, exactly like a real onboarded estate's
would be.
