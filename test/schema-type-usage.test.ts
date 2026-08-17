/**
 * Alias-footgun visibility (issue 3 of the five-issue fix wave).
 *
 * gbrain stores explicit frontmatter types literally and never re-normalizes
 * them, so a type that is an ALIAS of a canonical pack type (or undeclared
 * entirely) routes silently. These tests pin the mechanism that makes it loud:
 * classifyStoredType, the import-time type_warning field, the aggregated
 * sync/import summary renderer, and the data-plane schema lint rules.
 *
 * Privacy rule: fixtures use generic type names only.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  classifyStoredType,
  sanitizeTypeForDisplay,
  renderTypeWarningSummary,
  type TypeUsagePack,
} from '../src/core/schema-pack/type-usage.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const PACK: TypeUsagePack = {
  page_types: [
    { name: 'event', path_prefixes: ['events/'], aliases: ['happening', 'occasion'] },
    { name: 'note', path_prefixes: ['notes/'], aliases: [] },
    { name: 'isolated', path_prefixes: [] },
  ],
};

describe('classifyStoredType', () => {
  test('canonical page_type name → canonical', () => {
    expect(classifyStoredType('event', PACK)).toEqual({ kind: 'canonical' });
  });

  test('alias → alias_of with canonical + filing directory', () => {
    expect(classifyStoredType('happening', PACK)).toEqual({
      kind: 'alias_of',
      canonical: 'event',
      directory: 'events/',
    });
  });

  test('alias of a type with no path_prefixes → directory undefined', () => {
    const pack: TypeUsagePack = {
      page_types: [{ name: 'isolated', path_prefixes: [], aliases: ['loner'] }],
    };
    const cls = classifyStoredType('loner', pack);
    expect(cls.kind).toBe('alias_of');
    expect((cls as { directory?: string }).directory).toBeUndefined();
  });

  test('undeclared type → undeclared', () => {
    expect(classifyStoredType('mystery', PACK)).toEqual({ kind: 'undeclared' });
  });

  test('canonical wins over alias when a name is both (shadowing pack)', () => {
    const shadowed: TypeUsagePack = {
      page_types: [
        { name: 'event', path_prefixes: ['events/'], aliases: [] },
        { name: 'note', path_prefixes: ['notes/'], aliases: ['event'] },
      ],
    };
    expect(classifyStoredType('event', shadowed)).toEqual({ kind: 'canonical' });
  });
});

describe('sanitizeTypeForDisplay', () => {
  test('strips control characters (ANSI-escape hygiene)', () => {
    expect(sanitizeTypeForDisplay('ev\x1b[31mil')).toBe('ev[31mil');
    expect(sanitizeTypeForDisplay('a\x00b\x07c')).toBe('abc');
  });

  test('caps length at 64', () => {
    const long = 'x'.repeat(100);
    const out = sanitizeTypeForDisplay(long);
    expect(out.length).toBe(64);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('renderTypeWarningSummary', () => {
  test('one line per distinct type, alias line names canonical + directory', () => {
    const lines = renderTypeWarningSummary([
      { kind: 'alias_of', type: 'happening', canonical: 'event', directory: 'events/', count: 12 },
      { kind: 'undeclared', type: 'mystery', count: 3 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("'happening'");
    expect(lines[0]).toContain("'event'");
    expect(lines[0]).toContain('events/');
    expect(lines[0]).toContain('12 file(s)');
    expect(lines[1]).toContain("'mystery'");
    expect(lines[1]).toContain('not declared');
  });

  test('empty input → no lines', () => {
    expect(renderTypeWarningSummary([])).toHaveLength(0);
  });
});

describe('importFromContent type_warning (advisory, type stored literally)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function importWithType(slug: string, type: string | null, activePack?: TypeUsagePack) {
    const { importFromContent } = await import('../src/core/import-file.ts');
    const fm = type === null ? '' : `type: ${type}\n`;
    const md = `---\n${fm}title: T\n---\n\n# T\n\nBody ${Math.random().toString(36).slice(2)}.\n`;
    return importFromContent(engine, slug, md, {
      noEmbed: true,
      ...(activePack ? { activePack: activePack as never } : {}),
    });
  }

  test('explicit alias type → alias_of warning, type stored as-is', async () => {
    const r = await importWithType('notes/alias-page', 'happening', PACK);
    expect(r.status).toBe('imported');
    expect(r.type_warning).toEqual({
      kind: 'alias_of',
      type: 'happening',
      canonical: 'event',
      directory: 'events/',
    });
    const page = await engine.getPage('notes/alias-page');
    expect(page?.type).toBe('happening'); // stored literally — advisory only
  }, 30_000);

  test('explicit undeclared type → undeclared warning', async () => {
    const r = await importWithType('notes/mystery-page', 'mystery', PACK);
    expect(r.type_warning).toEqual({ kind: 'undeclared', type: 'mystery' });
  }, 30_000);

  test('explicit canonical type → no warning', async () => {
    const r = await importWithType('notes/canonical-page', 'event', PACK);
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('no activePack → no warning (classification skipped)', async () => {
    const r = await importWithType('notes/packless-page', 'happening');
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('no explicit type (typeExplicit false) → no warning', async () => {
    const r = await importWithType('notes/implicit-page', null, PACK);
    expect(r.type_warning).toBeUndefined();
  }, 30_000);
});

describe('schema lint data-plane rules: stored_type_is_alias / stored_type_undeclared', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('events/party', {
      type: 'happening', title: 'P', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/odd', {
      type: 'mystery', title: 'M', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
    await engine.putPage('events/legit', {
      type: 'event', title: 'E', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  const manifest = {
    name: 'test-pack',
    page_types: [
      { name: 'event', path_prefixes: ['events/'], aliases: ['happening'] },
      { name: 'note', path_prefixes: ['notes/'], aliases: [] },
    ],
  } as never;

  test('alias-typed corpus rows surface as stored_type_is_alias warnings', async () => {
    const { storedTypeIsAlias } = await import('../src/core/schema-pack/lint-rules.ts');
    const issues = await storedTypeIsAlias(manifest, { engine });
    const hit = issues.find(i => i.type === 'happening');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.message).toContain("alias of 'event'");
  }, 30_000);

  test('undeclared-typed corpus rows surface as stored_type_undeclared warnings', async () => {
    const { storedTypeUndeclared } = await import('../src/core/schema-pack/lint-rules.ts');
    const issues = await storedTypeUndeclared(manifest, { engine });
    const hit = issues.find(i => i.type === 'mystery');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    // canonical + alias types must NOT be flagged
    expect(issues.find(i => i.type === 'event')).toBeUndefined();
    expect(issues.find(i => i.type === 'happening')).toBeUndefined();
  }, 30_000);

  test('rules are engine-gated: no engine → no issues', async () => {
    const { storedTypeIsAlias, storedTypeUndeclared } = await import('../src/core/schema-pack/lint-rules.ts');
    expect(await storedTypeIsAlias(manifest, {})).toHaveLength(0);
    expect(await storedTypeUndeclared(manifest, {})).toHaveLength(0);
  });
});
