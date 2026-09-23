import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { BUNDLED_PACK_NAMES } from '../src/core/schema-pack/bundled.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { mergeInheritedManifest } from '../src/core/schema-pack/merge.ts';
import { buildAliasGraph, expandClosure } from '../src/core/schema-pack/closure.ts';
import { runFilePlaneLintRules } from '../src/core/schema-pack/lint-rules.ts';
import { locateMutablePackFile, SchemaPackMutationError } from '../src/core/schema-pack/mutate.ts';
import { expandTypeFilter } from '../src/core/schema-pack/expand-type-filter.ts';
import { inferTypeFromPack, parseMarkdown } from '../src/core/markdown.ts';

const parent = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
const child = loadPackFromFile(bundledPackPath('company-brain')!);
const pack = mergeInheritedManifest([parent], child, { page_types: [], link_types: [] });
const sampleRoot = join(import.meta.dir, '../src/core/company-brain/sample');

describe('bundled company-brain schema', () => {
  test('ships a readable, attributed optional preset', () => {
    expect(BUNDLED_PACK_NAMES).toContain('company-brain');
    expect(child.extends).toBe('gbrain-base-v2');
    expect(child.license).toBe('MIT');
    expect(child.homepage).toBe('https://github.com/mattzimak/gbrain-company-brain');
    expect(child.version).toBe('0.2.0');
    const embeddedAsset = readFileSync(bundledPackPath('company-brain')!, 'utf8');
    const license = readFileSync(join(import.meta.dir, '../third-party/company-brain/LICENSE'), 'utf8');
    expect(embeddedAsset.split('\n').filter(line => line.startsWith('#')).map(line => line.replace(/^# ?/, '')).join('\n'))
      .toBe(license.trimEnd());
  });

  test('does not inherit destructive normalization or opt into maintenance phases', () => {
    expect(parent.mapping_rules!.length).toBeGreaterThan(0);
    expect(pack.mapping_rules).toEqual([]);
    expect(pack.phases).toEqual([]);
  });

  test('resolved schema passes existing structural error checks', async () => {
    expect((await runFilePlaneLintRules(pack)).errors).toEqual([]);
    expect(new Set(pack.page_types.map(type => type.name)).size).toBe(pack.page_types.length);
  });

  test('keeps product and company query closures separate without changing the base', () => {
    const graph = buildAliasGraph(pack);
    expect(expandClosure('company', graph)).not.toContain('product');
    expect(expandClosure('product', graph)).toEqual(['product']);
    expect(expandTypeFilter('product', pack).canonical).toBe('product');
    expect(parent.page_types.find(type => type.name === 'company')!.aliases).toContain('product');
    expect(inferTypeFromPack('products/widget-example.md', parent)).toBe('company');
  });

  test.each([
    ['customers/acme-example.md', 'customer'],
    ['competitors/competitor-example.md', 'competitor'],
    ['suppliers/supplier-example.md', 'supplier'],
    ['distributors/distributor-example.md', 'distributor'],
    ['decisions/2026-09-01-example.md', 'decision'],
    ['weekly/2026-W37.md', 'weekly'],
    ['products/widget-example.md', 'product'],
    ['companies/company-example.md', 'company'],
    ['inbox/extracted/example.md', 'extracted-facts'],
  ])('infers %s as %s', (path, type) => {
    expect(inferTypeFromPack(path, pack)).toBe(type);
  });

  test('preserves ownership, supersession and the profile attendee mapping', () => {
    expect(pack.frontmatter_links).toContainEqual({ page_type: 'customer', fields: ['owner'], link_type: 'owned_by' });
    expect(pack.frontmatter_links).toContainEqual({ page_type: 'decision', fields: ['supersedes'], link_type: 'supersedes' });
    expect(pack.frontmatter_links).toContainEqual({ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' });
  });

  test('bundled preset cannot be mutated in place', () => {
    expect(() => locateMutablePackFile('company-brain')).toThrow(SchemaPackMutationError);
    try {
      locateMutablePackFile('company-brain');
    } catch (error) {
      expect((error as SchemaPackMutationError).code).toBe('PACK_READONLY');
    }
  });

  test('all fifteen fictional sample pages retain declared types and resolve their references', () => {
    const files = readdirSync(sampleRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => join(entry.parentPath, entry.name));
    expect(files).toHaveLength(15);
    const counts: Record<string, number> = {};
    const pages = files.map(file => {
      const content = readFileSync(file, 'utf8');
      const path = file.slice(sampleRoot.length + 1);
      const parsed = parseMarkdown(content, path, { validate: true });
      expect(parsed.errors).toEqual([]);
      expect(pack.page_types.some(type => type.name === parsed.type)).toBe(true);
      counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
      return { slug: path.replace(/\.md$/, ''), content, parsed };
    });
    expect(counts).toEqual({
      company: 1, competitor: 1, customer: 1, decision: 2, 'extracted-facts': 1,
      meeting: 2, person: 3, product: 1, strategy: 1, supplier: 1, weekly: 1,
    });
    const slugs = new Set(pages.map(page => page.slug));
    for (const page of pages) {
      for (const match of page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        expect(slugs.has(match[1])).toBe(true);
      }
    }
    expect(pages.find(page => page.slug === 'customers/acme-example')!.parsed.frontmatter.owner)
      .toBe('[[people/alice-example]]');
    expect(pages.find(page => page.slug === 'decisions/2026-08-20-focus-3pl')!.parsed.frontmatter.supersedes)
      .toEqual(['[[decisions/2026-05-02-focus-grocery]]']);
  });
});
