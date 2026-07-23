import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countJsonResourceBlocks, runExtractBlocks } from '../../scripts/extract-blocks';
import { redactTfJson } from '@/lib/redact';

// 0014 fix#4: extract-blocks.ts previously walked *.tf only — a `.tf.json`
// (JSON-syntax Terraform) resource was silently invisible, with zero signal,
// even though onboarding's own prescan census counts it correctly (the exact
// gap 0014/5-reusability-onboarding.md found: "Extracted 7 of 8 resources,
// exit 0, no warning"). Counting+warning landed first; now the resources are
// EXTRACTED too, as view-only pretty-printed JSON renderings (viewOnly: true
// on the chunk entry — catalogctl refuses .tf.json edits by design, but the
// "see the whole block" surface must not have holes). These tests exercise
// both against a small real fixture tree (never against environments/prod).
//
// 0014 dim-5: extract-blocks.ts also emitted MODULE-sourced resources under a
// bare `type.name` address — the real Terraform address is
// `module.<instance>.type.name`, so a downstream consumer (catalogctl
// plan-check's R1 allow-set) would target the wrong block entirely. The
// "module addressing" describe block below exercises the fix: unique local
// module calls get the full prefixed address; anything the script cannot
// safely resolve (same dir called twice, count/for_each, nested modules) is
// excluded and warned rather than guessed.

let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'extract-blocks-root-'));
  out = mkdtempSync(join(tmpdir(), 'extract-blocks-out-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe('runExtractBlocks — .tf extraction (unchanged behavior)', () => {
  it('extracts a plain .tf resource block into <chunk>.json + index.json', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'resource "aws_s3_bucket" "example" {\n  bucket = "my-bucket"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(1);
    expect(summary.tfFileCount).toBe(1);
    expect(summary.tfJsonFileCount).toBe(0);
    expect(summary.tfJsonViewOnlyBlocks).toBe(0);

    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_s3_bucket.example']).toBe('main');
    const chunk = JSON.parse(readFileSync(join(out, 'main.json'), 'utf8'));
    expect(chunk['aws_s3_bucket.example'].source).toContain('bucket = "my-bucket"');
  });
});

describe('runExtractBlocks — .tf.json is extracted as view-only JSON renderings', () => {
  it('a single-object-form .tf.json resource lands in the index with viewOnly: true', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'resource "aws_s3_bucket" "example" {\n  bucket = "b"\n}\n',
    );
    writeFileSync(
      join(root, 'storage.tf.json'),
      JSON.stringify({
        resource: {
          aws_dynamodb_table: {
            example: { name: 'my-table', billing_mode: 'PAY_PER_REQUEST' },
          },
        },
      }),
    );

    const summary = runExtractBlocks(root, out);

    // The .tf resource is still extracted normally (and stays the editable kind)...
    expect(summary.totalBlocks).toBe(1);
    expect(summary.tfFileCount).toBe(1);
    // ...and the .tf.json resource is extracted view-only, with the WARN kept
    // as an informational count.
    expect(summary.tfJsonFileCount).toBe(1);
    expect(summary.tfJsonViewOnlyBlocks).toBe(1);
    expect(summary.tfJsonUnparsableCount).toBe(0);
    expect(
      summary.messages.some(
        (m) => m.includes('storage.tf.json') && m.includes('1 resource block') && m.includes('VIEW-ONLY'),
      ),
    ).toBe(true);

    // The view surface has no hole: the address resolves to a chunk whose
    // entry is flagged, pretty-printed JSON, and names its source file.
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_dynamodb_table.example']).toBe('storage');
    const chunk = JSON.parse(readFileSync(join(out, 'storage.json'), 'utf8'));
    const entry = chunk['aws_dynamodb_table.example'];
    expect(entry.viewOnly).toBe(true);
    expect(entry.line).toBe(1);
    expect(entry.file.endsWith('storage.tf.json')).toBe(true);
    expect(entry.source).toContain('"aws_dynamodb_table"');
    expect(JSON.parse(entry.source)).toEqual({
      resource: { aws_dynamodb_table: { example: { name: 'my-table', billing_mode: 'PAY_PER_REQUEST' } } },
    });
    // The native .tf entry is NOT flagged — only JSON-syntax ones are view-only.
    const tfChunk = JSON.parse(readFileSync(join(out, 'main.json'), 'utf8'));
    expect(tfChunk['aws_s3_bucket.example'].viewOnly).toBeUndefined();
  });

  it('extracts the array-of-objects JSON block-body form too (HCL JSON spec allows either)', () => {
    writeFileSync(
      join(root, 'multi.tf.json'),
      JSON.stringify({
        resource: [
          { aws_sqs_queue: { main: {} } },
          { aws_sqs_queue: { dlq: {} }, aws_iam_role: { queue_role: {} } },
        ],
      }),
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.tfJsonFileCount).toBe(1);
    expect(summary.tfJsonViewOnlyBlocks).toBe(3); // main, dlq, queue_role
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_sqs_queue.main']).toBe('multi');
    expect(index['aws_sqs_queue.dlq']).toBe('multi');
    expect(index['aws_iam_role.queue_role']).toBe('multi');
  });

  it('masks every value inside a secret-bearing block (e.g. lambda environment)', () => {
    writeFileSync(
      join(root, 'fn.tf.json'),
      JSON.stringify({
        resource: {
          aws_lambda_function: {
            app: {
              runtime: 'python3.12',
              environment: { variables: { DB_HOST: 'db.internal', DB_PASS: 'hunter2' } },
            },
          },
        },
      }),
    );

    runExtractBlocks(root, out);

    const chunk = JSON.parse(readFileSync(join(out, 'fn.json'), 'utf8'));
    const source: string = chunk['aws_lambda_function.app'].source;
    expect(source).not.toContain('db.internal');
    expect(source).not.toContain('hunter2');
    expect(source).toContain('"runtime": "python3.12"'); // outside the block: untouched
    // A17 analog for the JSON path: the emitted rendering is ALREADY redacted —
    // running the shared redactor over it again must be a no-op.
    expect(redactTfJson(JSON.parse(source))).toEqual(JSON.parse(source));
  });

  it('masks secret-NAMED attributes in the rendering', () => {
    writeFileSync(
      join(root, 'db.tf.json'),
      JSON.stringify({
        resource: {
          aws_db_instance: { main: { engine: 'postgres', password: 'super-secret-1' } },
        },
      }),
    );

    runExtractBlocks(root, out);

    const chunk = JSON.parse(readFileSync(join(out, 'db.json'), 'utf8'));
    const source: string = chunk['aws_db_instance.main'].source;
    expect(source).not.toContain('super-secret-1');
    expect(source).toContain('«redacted:');
    expect(source).toContain('"engine": "postgres"'); // benign values untouched
  });

  it('a duplicate address keeps the editable .tf block, never the .tf.json rendering', () => {
    writeFileSync(join(root, 'a.tf'), 'resource "aws_s3_bucket" "same" {\n  bucket = "hcl"\n}\n');
    writeFileSync(
      join(root, 'b.tf.json'),
      JSON.stringify({ resource: { aws_s3_bucket: { same: { bucket: 'json' } } } }),
    );

    const summary = runExtractBlocks(root, out);

    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_s3_bucket.same']).toBe('a');
    expect(summary.messages.some((m) => m.includes('duplicate address aws_s3_bucket.same'))).toBe(true);
  });

  it('a .tf and .tf.json sharing a basename get distinct chunk keys', () => {
    writeFileSync(join(root, 'storage.tf'), 'resource "aws_s3_bucket" "hcl" {\n  bucket = "b"\n}\n');
    writeFileSync(
      join(root, 'storage.tf.json'),
      JSON.stringify({ resource: { aws_dynamodb_table: { js: {} } } }),
    );

    runExtractBlocks(root, out);

    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_s3_bucket.hcl']).toBe('storage');
    expect(index['aws_dynamodb_table.js']).toBeDefined();
    expect(index['aws_dynamodb_table.js']).not.toBe('storage');
  });

  it('reports an unparsable .tf.json distinctly, without crashing the run', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'resource "aws_s3_bucket" "example" {\n  bucket = "b"\n}\n',
    );
    writeFileSync(join(root, 'broken.tf.json'), '{ this is not valid json ');

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(1); // the valid .tf file still extracts fine
    expect(summary.tfJsonFileCount).toBe(1);
    expect(summary.tfJsonUnparsableCount).toBe(1);
    expect(summary.tfJsonViewOnlyBlocks).toBe(0); // unknown, not zero-resources
    expect(
      summary.messages.some((m) => m.includes('broken.tf.json') && m.includes('not valid JSON')),
    ).toBe(true);
  });

  it('a .tf.json with no resource key extracts zero, not unparsable — and writes no chunk', () => {
    writeFileSync(
      join(root, 'vars.tf.json'),
      JSON.stringify({ variable: { region: { default: 'us-east-1' } } }),
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.tfJsonFileCount).toBe(1);
    expect(summary.tfJsonViewOnlyBlocks).toBe(0);
    expect(summary.tfJsonUnparsableCount).toBe(0);
    expect(existsSync(join(out, 'vars.json'))).toBe(false);
  });

  it('mirrors the CLI silence when there are no .tf.json files at all', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'resource "aws_s3_bucket" "example" {\n  bucket = "b"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.tfJsonFileCount).toBe(0);
    expect(summary.messages).toHaveLength(0);
  });

  it('a .tf.json inside a uniquely-called local module dir gets the module-prefixed address', () => {
    writeFileSync(join(root, 'main.tf'), 'module "store" {\n  source = "./modules/store"\n}\n');
    mkdirSync(join(root, 'modules', 'store'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'store', 'tables.tf.json'),
      JSON.stringify({ resource: { aws_dynamodb_table: { t: { name: 'x' } } } }),
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.tfJsonViewOnlyBlocks).toBe(1);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['module.store.aws_dynamodb_table.t']).toBeDefined();
    expect(index['aws_dynamodb_table.t']).toBeUndefined(); // never the bare address
  });

  it('a .tf.json inside an ambiguously-called module dir is excluded and warned, not guessed', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'module "a" {\n  source = "./modules/store"\n}\nmodule "b" {\n  source = "./modules/store"\n}\n',
    );
    mkdirSync(join(root, 'modules', 'store'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'store', 'tables.tf.json'),
      JSON.stringify({ resource: { aws_dynamodb_table: { t: { name: 'x' } } } }),
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.tfJsonViewOnlyBlocks).toBe(0);
    expect(summary.ambiguousModuleFileCount).toBe(1);
    expect(summary.ambiguousModuleSkippedBlocks).toBe(1);
    expect(
      summary.messages.some(
        (m) => m.includes('ambiguous instantiation') && m.includes('"a"') && m.includes('"b"'),
      ),
    ).toBe(true);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toHaveLength(0);
  });
});

describe('countJsonResourceBlocks', () => {
  it('returns 0 for a file with no top-level resource key', () => {
    expect(countJsonResourceBlocks(JSON.stringify({ terraform: {} }))).toBe(0);
  });
  it('returns -1 for invalid JSON', () => {
    expect(countJsonResourceBlocks('not json')).toBe(-1);
  });
  it('counts multiple names under one type', () => {
    const n = countJsonResourceBlocks(
      JSON.stringify({ resource: { aws_iam_role: { a: {}, b: {}, c: {} } } }),
    );
    expect(n).toBe(3);
  });
});

describe('runExtractBlocks — output dir hygiene', () => {
  it('clears stale chunks from a shrunk estate (fresh OUT each run)', () => {
    writeFileSync(join(root, 'a.tf'), 'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n');
    runExtractBlocks(root, out);
    expect(existsSync(join(out, 'a.json'))).toBe(true);

    rmSync(join(root, 'a.tf'));
    writeFileSync(join(root, 'b.tf'), 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    runExtractBlocks(root, out);

    expect(existsSync(join(out, 'a.json'))).toBe(false);
    expect(existsSync(join(out, 'b.json'))).toBe(true);
  });

  it('creates OUT when it does not exist yet', () => {
    const freshOut = join(out, 'nested', 'dir');
    writeFileSync(join(root, 'a.tf'), 'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n');
    mkdirSync(join(root), { recursive: true });

    const summary = runExtractBlocks(root, freshOut);

    expect(summary.totalBlocks).toBe(1);
    expect(existsSync(join(freshOut, 'index.json'))).toBe(true);
  });
});

describe('runExtractBlocks — module addressing (0014 dim-5)', () => {
  it('a uniquely-called local module gets the full module.<instance>. address', () => {
    writeFileSync(join(root, 'main.tf'), 'module "vpc" {\n  source = "./modules/vpc"\n}\n');
    mkdirSync(join(root, 'modules', 'vpc'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'vpc', 'vpc.tf'),
      'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(1);
    expect(summary.ambiguousModuleFileCount).toBe(0);
    expect(summary.ambiguousModuleSkippedBlocks).toBe(0);

    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['module.vpc.aws_vpc.this']).toBeDefined();
    expect(index['aws_vpc.this']).toBeUndefined(); // never the bare address

    const chunkKey = index['module.vpc.aws_vpc.this'];
    const chunk = JSON.parse(readFileSync(join(out, `${chunkKey}.json`), 'utf8'));
    expect(chunk['module.vpc.aws_vpc.this'].source).toContain('cidr_block = "10.0.0.0/16"');
  });

  it('the same source dir instantiated twice is excluded and warned, not guessed', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'module "vpc_a" {\n  source = "./modules/vpc"\n}\nmodule "vpc_b" {\n  source = "./modules/vpc"\n}\n',
    );
    mkdirSync(join(root, 'modules', 'vpc'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'vpc', 'vpc.tf'),
      'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n\n' +
        'resource "aws_subnet" "a" {\n  cidr_block = "10.0.1.0/24"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(0);
    expect(summary.ambiguousModuleFileCount).toBe(1);
    expect(summary.ambiguousModuleSkippedBlocks).toBe(2);
    expect(
      summary.messages.some(
        (m) =>
          m.includes('2 resource(s) in module dir') &&
          m.includes('modules/vpc') &&
          m.includes('ambiguous instantiation') &&
          m.includes('"vpc_a"') &&
          m.includes('"vpc_b"'),
      ),
    ).toBe(true);

    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_vpc.this']).toBeUndefined();
    expect(index['module.vpc_a.aws_vpc.this']).toBeUndefined();
    expect(index['module.vpc_b.aws_vpc.this']).toBeUndefined();
  });

  it('count on the module call is excluded and warned, not guessed', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'module "vpc" {\n  source = "./modules/vpc"\n  count  = 2\n}\n',
    );
    mkdirSync(join(root, 'modules', 'vpc'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'vpc', 'vpc.tf'),
      'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(0);
    expect(summary.ambiguousModuleFileCount).toBe(1);
    expect(
      summary.messages.some((m) => m.includes('ambiguous instantiation') && m.includes('"vpc"')),
    ).toBe(true);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toHaveLength(0);
  });

  it('for_each on the module call is excluded and warned, not guessed', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'module "vpc" {\n  source   = "./modules/vpc"\n  for_each = toset(["a", "b"])\n}\n',
    );
    mkdirSync(join(root, 'modules', 'vpc'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'vpc', 'vpc.tf'),
      'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(0);
    expect(summary.ambiguousModuleFileCount).toBe(1);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toHaveLength(0);
  });

  it('a nested module call inside the called directory is excluded and warned', () => {
    writeFileSync(join(root, 'main.tf'), 'module "vpc" {\n  source = "./modules/vpc"\n}\n');
    mkdirSync(join(root, 'modules', 'vpc'), { recursive: true });
    writeFileSync(
      join(root, 'modules', 'vpc', 'vpc.tf'),
      'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n',
    );
    // vpc/ calls a further module of its own — the outer call can no longer
    // be trusted to be a flat, one-level module.vpc.* address.
    writeFileSync(
      join(root, 'modules', 'vpc', 'nested.tf'),
      'module "inner" {\n  source = "./inner"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(0);
    expect(summary.ambiguousModuleFileCount).toBe(1);
    expect(
      summary.messages.some((m) => m.includes('ambiguous instantiation') && m.includes('"vpc"')),
    ).toBe(true);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['module.vpc.aws_vpc.this']).toBeUndefined();
  });

  it('a non-local module source is never mapped — unrelated root files stay bare and unaffected', () => {
    writeFileSync(
      join(root, 'main.tf'),
      'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n',
    );
    writeFileSync(join(root, 'other.tf'), 'resource "aws_instance" "x" {\n  ami = "ami-123"\n}\n');

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(1);
    expect(summary.ambiguousModuleFileCount).toBe(0);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index['aws_instance.x']).toBeDefined();
  });

  it('an estate-shaped flat root with no module calls is completely unchanged', () => {
    // Mirrors environments/prod's shape (multiple per-service .tf files, no
    // subdirectories, no module blocks) at fixture scale — the byte-identical
    // proof against the real estate is run separately (never against
    // environments/prod in a test); this is the regression guard that the
    // default/fallback path is untouched by the module-addressing logic.
    writeFileSync(join(root, 'ec2.tf'), 'resource "aws_instance" "web" {\n  ami = "ami-123"\n}\n');
    writeFileSync(
      join(root, 'vpc.tf'),
      'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n',
    );

    const summary = runExtractBlocks(root, out);

    expect(summary.totalBlocks).toBe(2);
    expect(summary.ambiguousModuleFileCount).toBe(0);
    expect(summary.ambiguousModuleSkippedBlocks).toBe(0);
    expect(summary.messages).toHaveLength(0);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index).toEqual({ 'aws_instance.web': 'ec2', 'aws_vpc.main': 'vpc' });
  });
});
