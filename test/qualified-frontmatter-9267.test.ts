import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractFrontmatterLinks, makeResolver } from '../src/core/link-extraction.ts';
import { loadLinkPageMetadata, makeIndexedLinkResolver, reconcileSourceLinks } from '../src/core/link-reconciliation.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';

const own = 'qualified-origin';
const other = 'qualified-target';
const pack = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1', name: 'qualified-fixture', version: '1.0.0', extends: null,
  page_types: [], link_types: [{ name: 'related_to' }, { name: 'works_at' }],
  frontmatter_links: [{ page_type: 'note', fields: ['related'], link_type: 'related_to' }],
});

for (const backend of testBackends()) describe(`qualified frontmatter (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = fixture.engine; close = fixture.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
      close = () => engine.disconnect();
    }
  }, 120_000);
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    for (const source of [own, other]) {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [source]);
    }
    await engine.setConfig('link_resolution.cross_source', 'true');
  });
  async function seed(slug: string, source = own, frontmatter: Record<string, unknown> = {}, type = 'note') {
    await engine.putPage(slug, { type, title: slug.split('/').at(-1)!, compiled_truth: 'Synthetic graph evidence.', frontmatter }, { sourceId: source });
  }
  async function graph() {
    return engine.executeRaw(`SELECT f.source_id AS from_source,f.slug AS from_slug,t.source_id AS to_source,t.slug AS to_slug,
      l.link_type,l.resolution_type,o.source_id AS origin_source FROM links l
      JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id LEFT JOIN pages o ON o.id=l.origin_page_id
      WHERE o.source_id=$1 ORDER BY f.slug,t.slug`, [own]);
  }
  async function wanted() {
    return engine.executeRaw('SELECT * FROM wanted_links WHERE source_id=$1', [own]);
  }
  async function derive(slug: string) {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: own }))!;
    const prepared = await prepareAutomaticLinks(engine, slug, snapshot.page, own);
    return engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
  }

  test('real preparation publishes the foreign endpoint, and fences a later endpoint edit', async () => {
    await seed('companies/acme-example', own, {}, 'company');
    await seed('companies/acme-example', other, {}, 'company');
    await seed('people/alice-example', own, { company: `${other}:companies/acme-example` }, 'person');
    expect(await derive('people/alice-example')).toMatchObject({ errors: 0 });
    expect(await graph()).toMatchObject([{ to_source: other, resolution_type: 'qualified' }]);
    const snapshot = (await engine.readPageSnapshot('people/alice-example', { sourceId: own }))!;
    const prepared = await prepareAutomaticLinks(engine, snapshot.page.slug, snapshot.page, own);
    await seed('companies/acme-example', other, { changed: true }, 'company');
    const result = await engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
    expect(result.errors).toBeGreaterThan(0);
  });

  test('rename aliases resolve only in the named source and exact live slugs take precedence', async () => {
    await seed('people/canonical-example', other);
    await engine.executeRaw('INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ($1,$2,$3)',
      [other, 'people/old-example', 'people/canonical-example']);
    for (const resolver of [makeResolver(engine, { mode: 'live', sourceId: own }),
      makeIndexedLinkResolver(await loadLinkPageMetadata(engine), own)]) {
      expect(await resolver.resolveQualified!(other, 'people/old-example')).toBe('people/canonical-example');
      expect(await resolver.resolveQualified!(own, 'people/old-example')).toBeNull();
    }
    await seed('people/old-example', other);
    for (const resolver of [makeResolver(engine, { mode: 'live', sourceId: own }),
      makeIndexedLinkResolver(await loadLinkPageMetadata(engine), own)]) {
      expect(await resolver.resolveQualified!(other, 'people/old-example')).toBe('people/old-example');
    }
  });

  test('repeated reconciliation pins the qualified target despite a same-slug local decoy and clears wanted debt', async () => {
    await seed('people/alice-example', own);
    await seed('people/alice-example', other);
    await seed('notes/origin', own, { related: [`[[${other}:people/alice-example|Alice]]`] });
    for (let i = 0; i < 2; i++) {
      const result = await reconcileSourceLinks(engine, own, { pack });
      expect(result).toMatchObject({ ok: true, complete: true, unresolved: [], failures: [] });
      expect(await graph()).toEqual([{ from_source: own, from_slug: 'notes/origin', to_source: other,
        to_slug: 'people/alice-example', link_type: 'related_to', resolution_type: 'qualified', origin_source: own }]);
      expect(await wanted()).toEqual([]);
    }
  });

  test('a missing qualified target remains wanted in its exact source, then converges when that page appears', async () => {
    await seed('people/alice-example', own);
    await seed('notes/origin', own, { related: `${other}:people/alice-example` });
    expect((await reconcileSourceLinks(engine, own, { pack })).ok).toBe(true);
    expect(await graph()).toEqual([]);
    expect(await wanted()).toMatchObject([{ target_source_id: other, target_ref: 'people/alice-example', ref_kind: 'slug' }]);
    await seed('people/alice-example', other);
    expect((await reconcileSourceLinks(engine, own, { pack })).unresolved).toEqual([]);
    expect(await graph()).toHaveLength(1);
    expect(await wanted()).toEqual([]);
  });

  test('cross-source denial never falls back to the local decoy or records a forbidden wanted page', async () => {
    await seed('people/alice-example', own);
    await seed('people/alice-example', other);
    await seed('notes/origin', own, { related: `${other}:people/alice-example` });
    await engine.setConfig('link_resolution.cross_source', 'false');
    const result = await reconcileSourceLinks(engine, own, { pack });
    expect(result.ok).toBe(true);
    expect(result.unresolved).toMatchObject([{ reason: 'cross_source', target: `${other}:people/alice-example` }]);
    expect(await graph()).toEqual([]);
    expect(await wanted()).toEqual([]);
  });

  test('qualified addresses are exact in both resolvers: no basename/title rescue, deleted-target fallback or provider search', async () => {
    await seed('people/alice-example', other);
    await seed('people/deleted-example', other);
    await engine.softDeletePage('people/deleted-example', { sourceId: other });
    for (const resolver of [makeResolver(engine, { mode: 'live', sourceId: own }),
      makeIndexedLinkResolver(await loadLinkPageMetadata(engine), own)]) {
      const result = await extractFrontmatterLinks('notes/origin', 'note', {
        related: [`${other}:alice-example`, `${other}:people/deleted-example`, `${other}:people/alice-example`],
      }, resolver, true);
      expect(result.candidates).toMatchObject([{ targetSlug: 'people/alice-example', targetSourceId: other }]);
      expect(result.candidates).toHaveLength(1);
      expect(result.unresolved.map(ref => ref.name)).toEqual([`${other}:alice-example`, `${other}:people/deleted-example`]);
    }
  });

  test('same-source qualification works without cross-source permission and unqualified names stay source local', async () => {
    await seed('people/alice-example', own);
    await seed('people/foreign-example', other);
    await seed('notes/origin', own, { related: [`${own}:people/alice-example`, 'foreign-example'] });
    await engine.setConfig('link_resolution.cross_source', 'false');
    const result = await reconcileSourceLinks(engine, own, { pack, globalBasename: true });
    expect(result.ok).toBe(true);
    expect(await graph()).toMatchObject([{ to_source: own, to_slug: 'people/alice-example', resolution_type: 'qualified' }]);
    expect(await graph()).toHaveLength(1);
    expect(result.unresolved).toMatchObject([{ target: 'foreign-example', reason: 'missing_target' }]);
  });

  test('incoming qualified frontmatter never substitutes a local same-slug person for the foreign subject', async () => {
    await seed('people/alice-example', own, {}, 'person');
    await seed('people/alice-example', other, {}, 'person');
    await seed('companies/acme-example', own, { key_people: `${other}:people/alice-example` }, 'company');
    const result = await reconcileSourceLinks(engine, own, { pack });
    expect(result.ok).toBe(true);
    // Existing policy admits non-attendance incoming edges only from the origin source.
    expect(result.unresolved).toMatchObject([{ reason: 'cross_source' }]);
    expect(await graph()).toEqual([]);
    expect(await wanted()).toEqual([]);
  });
});
