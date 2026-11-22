import { describe, expect, test } from 'bun:test';
import { packDeclaresPageType } from '../src/core/schema-pack/write-vocabulary.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';

const pack = {
  manifest: {
    name: 'fake-pack',
    page_types: [{ name: 'company', aliases: ['org', 'startup'] }, { name: 'person', aliases: [] }],
    link_types: [],
  },
} as unknown as ResolvedPack;

describe('packDeclaresPageType alias resolution', () => {
  test('a declared alias counts as declared, like schema lint', () => {
    expect(packDeclaresPageType(pack, 'company')).toBe(true);
    expect(packDeclaresPageType(pack, 'org')).toBe(true);
    expect(packDeclaresPageType(pack, 'startup')).toBe(true);
  });
  test('an unrelated name stays undeclared', () => {
    expect(packDeclaresPageType(pack, 'widget')).toBe(false);
  });
});
