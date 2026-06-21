import { describe, expect, test } from 'bun:test';
import { extractFrontmatterLinks } from '../src/core/link-extraction.ts';

// Resolver shape is taken from the function signature so we don't import the
// internal type name. Only `.resolve(name, dirHint)` is exercised here.
type Resolver = Parameters<typeof extractFrontmatterLinks>[3];
const stubResolver = (map: Record<string, string>): Resolver =>
  ({ resolve: async (name: string) => map[name] ?? null }) as unknown as Resolver;

describe('extractFrontmatterLinks — pack frontmatter_links wiring (v0.42)', () => {
  test('pack-declared field produces a typed edge', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/alice',
      'person',
      { reports_to: 'Bob Roberts' },
      stubResolver({ 'Bob Roberts': 'people/bob-roberts' }),
      [{ page_type: 'person', fields: ['reports_to'], link_type: 'reports_to' }],
    );
    const edge = candidates.find((c) => c.linkType === 'reports_to');
    expect(edge).toBeDefined();
    expect(edge!.targetSlug).toBe('people/bob-roberts');
    expect(edge!.linkSource).toBe('frontmatter');
  });

  test('built-in FRONTMATTER_LINK_MAP wins on conflict with a pack rule', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/alice',
      'person',
      { company: 'Acme' },
      stubResolver({ Acme: 'companies/acme' }),
      // pack tries to remap person.company → related_to; built-in works_at must win
      [{ page_type: 'person', fields: ['company'], link_type: 'related_to' }],
    );
    const edge = candidates.find((c) => c.targetSlug === 'companies/acme');
    expect(edge).toBeDefined();
    expect(edge!.linkType).toBe('works_at');
  });

  test('no pack arg leaves legacy behavior unchanged (unmapped field → no edge)', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/alice',
      'person',
      { reports_to: 'Bob Roberts' },
      stubResolver({}),
    );
    expect(candidates.length).toBe(0);
  });
});
