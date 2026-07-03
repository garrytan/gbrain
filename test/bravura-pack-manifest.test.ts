// gbrain-bravura manifest shape — fork-local company-brain pack.
// Mirrors test/lens-pack-manifests.test.ts so the Bravura taxonomy is
// CI-protected against drift. See brain-deploy/docs/BRAVURA_BRAIN_DESIGN.md.
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSchemaPackManifest,
  parseYamlMini,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = join(here, '..', 'src', 'core', 'schema-pack', 'base');

function loadPack(name: string): SchemaPackManifest {
  const p = join(baseDir, `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`bundled pack not found at ${p}`);
  return parseSchemaPackManifest(parseYamlMini(readFileSync(p, 'utf-8')), { path: p });
}

describe('gbrain-bravura company-brain pack', () => {
  const pack = loadPack('gbrain-bravura');

  test('parses cleanly and extends gbrain-recommended', () => {
    expect(pack.name).toBe('gbrain-bravura');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.extends).toBe('gbrain-recommended');
  });

  test('declares the support + internal + sales-stub + connector reference page types', () => {
    const names = pack.page_types.map((t) => t.name).sort();
    expect(names).toEqual([
      'customer',
      'documentation',
      'inbox',
      'kb_article',
      'knowledge_article',
      'process',
      'product_area',
      'responsive_qa',
      'rfp',
      'support_case',
      'support_pattern',
      'team',
    ]);
  });

  test('support_case + support_pattern + product_area + process are extractable; kb/inbox/entities/connector-refs are not', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    const isExtractable = (n: string) => byName.get(n)!.extractable !== false;
    expect(isExtractable('support_case')).toBe(true);
    expect(isExtractable('support_pattern')).toBe(true);
    expect(isExtractable('product_area')).toBe(true);
    expect(isExtractable('process')).toBe(true);
    expect(isExtractable('kb_article')).toBe(false);
    expect(isExtractable('inbox')).toBe(false);
    expect(isExtractable('customer')).toBe(false);
    expect(isExtractable('responsive_qa')).toBe(false);
    expect(isExtractable('documentation')).toBe(false);
    expect(isExtractable('knowledge_article')).toBe(false);
  });

  test('connector reference types have correct path_prefixes', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    expect(byName.get('responsive_qa')!.path_prefixes).toContain('responsive/');
    expect(byName.get('documentation')!.path_prefixes).toContain('paligo/');
    expect(byName.get('knowledge_article')!.path_prefixes).toContain('salesforce-kb/');
  });

  test('customer has expert_routing enabled in v1.1', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    expect(byName.get('customer')!.expert_routing).toBe(true);
  });

  test('mapping_rules declared for the three connector reference types', () => {
    expect(pack.mapping_rules).toBeDefined();
    const retypes = (pack.mapping_rules ?? []).filter((r) => r.kind === 'retype');
    const fromTypes = retypes.map((r) => r.from_type).sort();
    expect(fromTypes).toContain('responsive_qa');
    expect(fromTypes).toContain('documentation');
    expect(fromTypes).toContain('knowledge_article');
  });

  test('declares the Bravura link verbs with inverses', () => {
    const inv = new Map(pack.link_types.map((l) => [l.name, l.inverse]));
    expect(inv.get('for_customer')).toBe('has_case');
    expect(inv.get('affects_product')).toBe('affected_by');
    expect(inv.get('caused_by')).toBe('causes');
    expect(inv.get('resolved_by')).toBe('resolves');
    expect(inv.get('escalated_to')).toBe('handled_by');
  });

  test('filing rules cover every authored type', () => {
    const kinds = pack.filing_rules.map((r) => r.kind).sort();
    expect(kinds).toEqual([
      'customer',
      'inbox',
      'kb_article',
      'process',
      'product_area',
      'rfp',
      'support_case',
      'support_pattern',
      'team',
    ]);
  });
});
