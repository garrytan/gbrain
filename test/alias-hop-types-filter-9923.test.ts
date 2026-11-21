import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyAliasHop } from '../src/core/search/alias-hop.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', {
    title: 'Alice Example', type: 'person', compiled_truth: 'Alice works on things.',
    frontmatter: { aliases: ['Quokkafoo'] },
  });
  await engine.executeRaw(
    `INSERT INTO page_aliases (source_id, alias_norm, slug) SELECT source_id, 'quokkafoo', slug FROM pages WHERE slug = 'people/alice-example'`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('alias hop honors the types filter (#9923)', () => {
  it('injects the aliased page when its type is allowed', async () => {
    const out = await applyAliasHop(engine, [], 'Quokkafoo', { types: ['person'] });
    expect(out.map((r) => r.slug)).toEqual(['people/alice-example']);
  });

  it('does not inject an aliased page excluded by types', async () => {
    const out = await applyAliasHop(engine, [], 'Quokkafoo', { types: ['company'] });
    expect(out.map((r) => r.slug)).toEqual([]);
  });

  it('does not inject an aliased page excluded by type', async () => {
    const out = await applyAliasHop(engine, [], 'Quokkafoo', { type: 'concept' });
    expect(out.map((r) => r.slug)).toEqual([]);
  });
});
