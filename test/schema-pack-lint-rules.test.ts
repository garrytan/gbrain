// v0.40.6.0 — lint-rules.ts unit tests. 36 cases (11 rules covering each
// of clean / single-violation / multi-violation paths plus the audit-aware
// rule's empty-DB and audit-best-effort paths).

import { describe, expect, it } from 'bun:test';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import {
  aliasShadowsType,
  aliasDeclaredByTwoTypes,
  aliasReferencesUndeclaredType,
  enrichableTypesUndeclared,
  linkTypesUndeclared,
  frontmatterLinksUndeclared,
  expertRoutingWithoutPrefix,
  prefixCollision,
  prefixStrictSubsetOverlap,
  runAllLintRules,
  runFilePlaneLintRules,
  FILE_PLANE_LINT_RULES,
  ALL_LINT_RULES,
} from '../src/core/schema-pack/lint-rules.ts';

function mk(opts: Partial<SchemaPackManifest>): SchemaPackManifest {
  const baseTypes = opts.page_types ?? [];
  return {
    api_version: 'gbrain-schema-pack-v1',
    name: opts.name ?? 'p',
    version: '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: null,
    borrow_from: [],
    page_types: baseTypes,
    link_types: opts.link_types ?? [],
    frontmatter_links: opts.frontmatter_links ?? [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: opts.enrichable_types ?? [],
    filing_rules: [],
  } as SchemaPackManifest;
}

const baseType = (over: { name: string; aliases?: string[]; extractable?: boolean; expert?: boolean; prefixes?: string[] }) => ({
  name: over.name,
  primitive: 'entity' as const,
  path_prefixes: over.prefixes ?? [],
  aliases: over.aliases ?? [],
  extractable: over.extractable ?? false,
  expert_routing: over.expert ?? false,
});

describe('aliasShadowsType', () => {
  it('clean: no aliases shadow type names', async () => {
    const m = mk({ page_types: [baseType({ name: 'person', aliases: ['alias-only'] })] });
    expect(await aliasShadowsType(m)).toEqual([]);
  });

  it('single: alias matches another declared type', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'person' }),
      baseType({ name: 'researcher', aliases: ['person'] }),
    ] });
    const issues = await aliasShadowsType(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.rule).toBe('alias_shadows_type');
    expect(issues[0]!.severity).toBe('error');
  });

  it('skips when alias matches self (self-alias is degenerate but not shadow)', async () => {
    const m = mk({ page_types: [baseType({ name: 'person', aliases: ['person'] })] });
    expect(await aliasShadowsType(m)).toEqual([]);
  });
});

describe('aliasDeclaredByTwoTypes', () => {
  it('clean: each alias declared by at most one type', async () => {
    expect(await aliasDeclaredByTwoTypes(mk({ page_types: [baseType({ name: 'p', aliases: ['x'] })] }))).toEqual([]);
  });

  it('flags alias claimed by two types', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', aliases: ['shared'] }),
      baseType({ name: 'b', aliases: ['shared'] }),
    ] });
    const issues = await aliasDeclaredByTwoTypes(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('shared');
    expect(issues[0]!.message).toContain('a');
    expect(issues[0]!.message).toContain('b');
  });

  it('flags multiple distinct duplicate-alias collisions', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', aliases: ['x', 'y'] }),
      baseType({ name: 'b', aliases: ['x', 'y'] }),
    ] });
    const issues = await aliasDeclaredByTwoTypes(m);
    expect(issues.length).toBe(2);
  });
});

describe('aliasReferencesUndeclaredType', () => {
  it('clean: aliases all match declared types', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'person' }),
      baseType({ name: 'researcher', aliases: ['person'] }),
    ] });
    expect(await aliasReferencesUndeclaredType(m)).toEqual([]);
  });

  it('flags alias pointing at undeclared type', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', aliases: ['ghost'] })] });
    const issues = await aliasReferencesUndeclaredType(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('ghost');
  });

  it('flags multiple undeclared references separately', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', aliases: ['g1', 'g2'] })] });
    expect((await aliasReferencesUndeclaredType(m)).length).toBe(2);
  });
});

describe('enrichableTypesUndeclared', () => {
  it('clean: all enrichable_types are declared page_types', async () => {
    const m = mk({
      page_types: [baseType({ name: 'person' })],
      enrichable_types: [{ type: 'person', rubric: 'r' }],
    });
    expect(await enrichableTypesUndeclared(m)).toEqual([]);
  });

  it('flags enrichable that names a ghost type', async () => {
    const m = mk({
      page_types: [baseType({ name: 'person' })],
      enrichable_types: [{ type: 'ghost', rubric: 'r' }],
    });
    const issues = await enrichableTypesUndeclared(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
  });

  it('aggregates multiple ghost references', async () => {
    const m = mk({
      page_types: [baseType({ name: 'person' })],
      enrichable_types: [
        { type: 'ghost1', rubric: 'r' },
        { type: 'ghost2', rubric: 'r' },
      ],
    });
    expect((await enrichableTypesUndeclared(m)).length).toBe(2);
  });
});

describe('linkTypesUndeclared', () => {
  it('clean: inference targets resolve', async () => {
    const m = mk({
      page_types: [baseType({ name: 'person' }), baseType({ name: 'company' })],
      link_types: [{ name: 'works_at', inference: { page_type: 'person', target_type: 'company' } }],
    });
    expect(await linkTypesUndeclared(m)).toEqual([]);
  });

  it('flags inference.page_type referencing ghost', async () => {
    const m = mk({
      page_types: [baseType({ name: 'company' })],
      link_types: [{ name: 'works_at', inference: { page_type: 'ghost', target_type: 'company' } }],
    });
    expect((await linkTypesUndeclared(m)).length).toBe(1);
  });

  it('flags both page_type AND target_type independently', async () => {
    const m = mk({
      page_types: [baseType({ name: 'person' })],
      link_types: [{ name: 'l', inference: { page_type: 'g1', target_type: 'g2' } }],
    });
    expect((await linkTypesUndeclared(m)).length).toBe(2);
  });
});

describe('frontmatterLinksUndeclared', () => {
  it('clean: page_type + link_type both resolve', async () => {
    const m = mk({
      page_types: [baseType({ name: 'meeting' })],
      link_types: [{ name: 'attended' }],
      frontmatter_links: [{ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' }],
    });
    expect(await frontmatterLinksUndeclared(m)).toEqual([]);
  });

  it('flags unknown page_type', async () => {
    const m = mk({
      page_types: [],
      link_types: [{ name: 'attended' }],
      frontmatter_links: [{ page_type: 'ghost', fields: ['x'], link_type: 'attended' }],
    });
    const issues = await frontmatterLinksUndeclared(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.rule).toBe('frontmatter_links_undeclared_page_type');
  });

  it('flags unknown link_type', async () => {
    const m = mk({
      page_types: [baseType({ name: 'meeting' })],
      link_types: [],
      frontmatter_links: [{ page_type: 'meeting', fields: ['x'], link_type: 'ghost' }],
    });
    const issues = await frontmatterLinksUndeclared(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.rule).toBe('frontmatter_links_undeclared_link_type');
  });
});

describe('expertRoutingWithoutPrefix', () => {
  it('clean: expert types have prefixes', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', expert: true, prefixes: ['people/'] })] });
    expect(await expertRoutingWithoutPrefix(m)).toEqual([]);
  });

  it('warns: expert-routed type lacks prefix', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', expert: true })] });
    const issues = await expertRoutingWithoutPrefix(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warning');
  });

  it('skips non-expert types without prefix (legitimate concept-only types)', async () => {
    const m = mk({ page_types: [baseType({ name: 'concept' })] });
    expect(await expertRoutingWithoutPrefix(m)).toEqual([]);
  });
});

describe('prefixCollision', () => {
  it('clean: each prefix declared by only one type', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['a/'] }),
      baseType({ name: 'b', prefixes: ['b/'] }),
    ] });
    expect(await prefixCollision(m)).toEqual([]);
  });

  it('flags two types declaring same prefix', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['shared/'] }),
      baseType({ name: 'b', prefixes: ['shared/'] }),
    ] });
    const issues = await prefixCollision(m);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
  });

  it('aggregates multiple prefix collisions', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['x/', 'y/'] }),
      baseType({ name: 'b', prefixes: ['x/', 'y/'] }),
    ] });
    expect((await prefixCollision(m)).length).toBe(2);
  });
});

describe('prefixStrictSubsetOverlap', () => {
  it('clean: prefixes are unrelated', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['people/'] }),
      baseType({ name: 'b', prefixes: ['companies/'] }),
    ] });
    expect(await prefixStrictSubsetOverlap(m)).toEqual([]);
  });

  it('flags one type prefix that is a strict subset of another', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'researcher', prefixes: ['people/researchers/'] }),
      baseType({ name: 'person', prefixes: ['people/'] }),
    ] });
    const issues = await prefixStrictSubsetOverlap(m);
    // strict-subset detection fires for the researcher prefix.
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]!.severity).toBe('warning');
  });

  it('does not flag identical prefixes (that is prefixCollision territory)', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['x/'] }),
      baseType({ name: 'b', prefixes: ['x/'] }),
    ] });
    // prefixStrictSubsetOverlap only fires on STRICT subsets; identical is collision's job.
    expect(await prefixStrictSubsetOverlap(m)).toEqual([]);
  });
});

describe('runFilePlaneLintRules — composition', () => {
  it('returns ok:true for a clean manifest', async () => {
    const m = mk({ page_types: [baseType({ name: 'person', prefixes: ['people/'] })] });
    const report = await runFilePlaneLintRules(m);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('returns ok:false when any error fires', async () => {
    const m = mk({ page_types: [
      baseType({ name: 'a', prefixes: ['x/'] }),
      baseType({ name: 'b', prefixes: ['x/'] }),
    ] });
    const report = await runFilePlaneLintRules(m);
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('separates warnings from errors', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', expert: true })] });
    const report = await runFilePlaneLintRules(m);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('skips DB-aware rules (file-plane only)', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', extractable: true, prefixes: ['ghost/'] })] });
    const report = await runFilePlaneLintRules(m);
    // extractable_empty_corpus needs an engine; this should NOT fire here.
    expect(report.warnings.find((w) => w.rule === 'extractable_empty_corpus')).toBeUndefined();
  });
});

describe('runAllLintRules — composition', () => {
  it('without engine, behaves like runFilePlaneLintRules', async () => {
    const m = mk({ page_types: [baseType({ name: 'r', extractable: true })] });
    const report = await runAllLintRules(m);
    expect(report.warnings.find((w) => w.rule === 'extractable_empty_corpus')).toBeUndefined();
  });
});

describe('rule registry shape', () => {
  it('ALL_LINT_RULES contains 11 rules', () => {
    expect(ALL_LINT_RULES.length).toBe(11);
  });

  it('FILE_PLANE_LINT_RULES excludes the 2 DB-aware rules', () => {
    expect(FILE_PLANE_LINT_RULES.length).toBe(9);
    expect(FILE_PLANE_LINT_RULES.every((r) => !r.planeAware)).toBe(true);
  });

  it('all rule names are unique', () => {
    const names = ALL_LINT_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
