// v0.42 Type Unification (T29) — expandTypeFilter + buildTypeFilterSql.
//
// Coverage: alias-to-canonical expansion with frontmatter subtype, alias
// without subtype falls back to subtype=alias-name, canonical pass-through,
// unknown type pass-through, SQL fragment generation.

import { describe, expect, it } from 'bun:test';
import { expandTypeFilter, buildTypeFilterSql } from '../src/core/schema-pack/expand-type-filter.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

function packOf(page_types: SchemaPackManifest['page_types']): Pick<SchemaPackManifest, 'page_types'> {
  return { page_types };
}

const fmAlias = packOf([
  {
    name: 'tweet',
    primitive: 'media',
    path_prefixes: [],
    aliases: ['tweet-single', 'tweet-bundle'],
    extractable: false,
    expert_routing: false,
    subtypes: [
      { name: 'single', when: { frontmatter_field: 'thread_length', frontmatter_value: 1 } },
      { name: 'bundle', when: { frontmatter_field: 'bundle', frontmatter_value: true } },
    ],
  },
]);

describe('expandTypeFilter', () => {
  it('null pack → pass-through (D4 EMPTY FILTER)', () => {
    expect(expandTypeFilter('article', null)).toEqual({
      canonical: 'article',
      subtypeFilter: null,
      isAliasExpansion: false,
      originalInput: 'article',
    });
  });

  it('canonical type → pass-through', () => {
    expect(expandTypeFilter('tweet', fmAlias)).toEqual({
      canonical: 'tweet',
      subtypeFilter: null,
      isAliasExpansion: false,
      originalInput: 'tweet',
    });
  });

  it('alias with mapping_rule → uses retype rule subtype (canonical answer)', () => {
    // gbrain-base-v2 shape: mapping_rule says
    //   { from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }
    // so --type tweet-single matches pages where unify stamped subtype='single'.
    const packWithRules = {
      ...fmAlias,
      mapping_rules: [
        { kind: 'retype', from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' },
      ],
    };
    const result = expandTypeFilter('tweet-single', packWithRules);
    expect(result.isAliasExpansion).toBe(true);
    expect(result.canonical).toBe('tweet');
    expect(result.originalInput).toBe('tweet-single');
    expect(result.subtypeFilter).toEqual({
      canonical: 'tweet',
      subtypeField: 'subtype',
      subtypeValue: 'single',
    });
  });

  it('alias without mapping_rule, with matching subtype name → uses subtype rule', () => {
    // Edge case for hand-written packs: subtype rule whose name === alias.
    const pack = packOf([{
      name: 'tweet',
      primitive: 'media',
      path_prefixes: [],
      aliases: ['bundle'],
      extractable: false,
      expert_routing: false,
      subtypes: [
        { name: 'bundle', when: { frontmatter_field: 'bundle', frontmatter_value: true } },
      ],
    }]);
    const result = expandTypeFilter('bundle', pack);
    expect(result.isAliasExpansion).toBe(true);
    expect(result.canonical).toBe('tweet');
    expect(result.subtypeFilter).toEqual({
      canonical: 'tweet',
      subtypeField: 'bundle',
      subtypeValue: 'true',
    });
  });

  it('alias without matching subtype rule → falls back to subtype=alias-name', () => {
    const pack = packOf([{
      name: 'media',
      primitive: 'media',
      path_prefixes: [],
      aliases: ['article'],
      extractable: false,
      expert_routing: false,
    }]);
    const result = expandTypeFilter('article', pack);
    expect(result.isAliasExpansion).toBe(true);
    expect(result.canonical).toBe('media');
    expect(result.subtypeFilter?.subtypeField).toBe('subtype');
    expect(result.subtypeFilter?.subtypeValue).toBe('article');
  });

  it('unknown type → pass-through', () => {
    const result = expandTypeFilter('unknown-type', fmAlias);
    expect(result.canonical).toBe('unknown-type');
    expect(result.isAliasExpansion).toBe(false);
    expect(result.subtypeFilter).toBeNull();
  });
});

describe('buildTypeFilterSql', () => {
  it('non-expansion → simple type = $1', () => {
    const expanded = { canonical: 'media', subtypeFilter: null, isAliasExpansion: false, originalInput: 'media' };
    const { sql, params } = buildTypeFilterSql(expanded);
    expect(sql).toBe('type = $1');
    expect(params).toEqual(['media']);
  });

  it('alias expansion → OR fragment with 4 params', () => {
    const expanded = {
      canonical: 'tweet',
      subtypeFilter: { canonical: 'tweet', subtypeField: 'thread_length', subtypeValue: '1' },
      isAliasExpansion: true,
      originalInput: 'tweet-single',
    };
    const { sql, params } = buildTypeFilterSql(expanded);
    expect(sql).toContain('type = $1');
    expect(sql).toContain('type = $2');
    expect(sql).toContain("frontmatter ->> $3 = $4");
    expect(params).toEqual(['tweet-single', 'tweet', 'thread_length', '1']);
  });

  it('respects startParamIndex offset', () => {
    const expanded = { canonical: 'media', subtypeFilter: null, isAliasExpansion: false, originalInput: 'media' };
    const { sql, params } = buildTypeFilterSql(expanded, 5);
    expect(sql).toBe('type = $5');
    expect(params).toEqual(['media']);
  });
});
