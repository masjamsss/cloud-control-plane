import { describe, expect, it } from 'vitest';
import { GLOSSARY, termsInText } from '@/lib/glossary';

describe('HCL glossary', () => {
  it('every entry has a non-empty definition', () => {
    for (const [term, def] of Object.entries(GLOSSARY)) {
      expect(def.length, term).toBeGreaterThan(10);
    }
  });

  it('finds whole-word terms present in HCL text', () => {
    const hcl = 'resource "aws_instance" "x" {\n  instance_type = "r6i.xlarge"\n  tags = {}\n}';
    const terms = termsInText(hcl);
    expect(terms).toContain('resource');
    expect(terms).toContain('instance_type');
    expect(terms).toContain('tags');
  });

  it('does not match substrings inside other words', () => {
    // "counting" must not match the glossary term "count".
    expect(termsInText('this is counting only')).not.toContain('count');
  });
});

describe('Azure-core vocabulary (0039 S1 lane L)', () => {
  const AZURE_TERMS = [
    'resource_group',
    'location',
    'tenant',
    'subscription',
    'managed_disk',
    'storage_account',
    'key_vault',
    'sku',
    'vm_size',
    'tags',
  ];

  it('every azure term is a real, defined glossary entry', () => {
    for (const term of AZURE_TERMS) {
      expect(GLOSSARY[term], term).toBeDefined();
      expect(GLOSSARY[term]!.length, term).toBeGreaterThan(10);
    }
  });

  it('finds whole-word azure terms present in azurerm HCL text', () => {
    const hcl =
      'resource "azurerm_storage_account" "x" {\n' +
      '  location = "southeastasia"\n' +
      '  sku      = "Standard_LRS"\n' +
      '  tags     = {}\n' +
      '}';
    const terms = termsInText(hcl);
    expect(terms).toContain('location');
    expect(terms).toContain('sku');
    expect(terms).toContain('tags');
  });

  it('the tags entry notes Azure tag names are case-insensitive, without dropping the original generic AWS-agnostic meaning', () => {
    expect(GLOSSARY.tags).toContain('case-insensitive');
    expect(GLOSSARY.tags).toContain('Key/value metadata');
  });
});
