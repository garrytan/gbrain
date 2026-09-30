import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { materializePageSnapshot } from '../src/core/page-state/materialize.ts';
import { assertPageRevision, PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { withEnv } from './helpers/with-env.ts';

const sourceId = 'page-state-concurrency-test';
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: 'Timeline', frontmatter: {} });
const engines: BrainEngine[] = [];

beforeAll(async () => {
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engines.push(pglite);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL, poolSize: 4 });
    await pg.initSchema();
    engines.push(pg);
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
  }
});

describe('canonical page state, both engines', () => {
  test('only canonical changes advance revisions and invalidate text projection', async () => {
    for (const engine of engines) {
      const first = await engine.putPage('revision', input('First'), { sourceId });
      expect(first.knowledge_revision).toMatch(/^[0-9a-f-]{36}$/);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [first.id]);
      await engine.putPage('revision', input('First'), { sourceId });
      await engine.executeRaw('UPDATE pages SET chunker_version=3,updated_at=now(),content_hash=$2 WHERE id=$1', [first.id, 'index-bookkeeping']);
      const noop = await engine.readPageSnapshot('revision', { sourceId });
      expect(noop!.revision).toBe(first.knowledge_revision!);
      expect(noop!.page.text_projection_revision).toBe(noop!.revision);
      await engine.addTag('revision', 'example', { sourceId });
      const tagged = await engine.readPageSnapshot('revision', { sourceId });
      expect(tagged!.revision).not.toBe(noop!.revision);
      expect(tagged!.tags).toEqual(['example']);
      expect(tagged!.page.text_projection_revision).toBeNull();
      await engine.addTag('revision', 'example', { sourceId });
      await engine.executeRaw('UPDATE tags SET tag=tag WHERE page_id=$1', [first.id]);
      expect((await engine.readPageSnapshot('revision', { sourceId }))!.revision).toBe(tagged!.revision);
      await engine.putPage('revision', input('Changed'), { sourceId, expectedRevision: tagged!.revision });
      expect((await engine.readPageSnapshot('revision', { sourceId }))!.revision).not.toBe(tagged!.revision);
    }
  });

  test('absent-page guards admit exactly one concurrent create and one CAS update', async () => {
    for (const engine of engines) {
      const creates = await Promise.allSettled([
        engine.putPage('contended', input('A'), { sourceId, force: false }),
        engine.putPage('contended', input('B'), { sourceId, force: false }),
      ]);
      expect(creates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = creates.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(PageRevisionConflictError);
      const prior = (await engine.readPageSnapshot('contended', { sourceId }))!;
      const updates = await Promise.allSettled([
        engine.putPage('contended', input('C'), { sourceId, expectedRevision: prior.revision }),
        engine.putPage('contended', input('D'), { sourceId, expectedRevision: prior.revision }),
      ]);
      expect(updates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((updates.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(PageRevisionConflictError);
      await expect(engine.putPage('CONTENDED', input('Cannot bypass'), { sourceId, force: false })).rejects.toBeInstanceOf(PageRevisionConflictError);
      await engine.softDeletePage('contended', { sourceId });
      expect(await engine.getPage('contended', { sourceId })).toBeNull();
      await expect(engine.putPage('contended', input('Recreate'), { sourceId, force: false })).rejects.toBeInstanceOf(PageRevisionConflictError);
      await engine.deletePage('contended', { sourceId });
      const recreated = await engine.putPage('contended', input('New identity'), { sourceId, force: false });
      expect(recreated.knowledge_revision).not.toBe(prior.revision);
      await expect(engine.putPage('contended', input('Stale'), { sourceId, expectedRevision: prior.revision })).rejects.toBeInstanceOf(PageRevisionConflictError);
    }
  });

  test('nested savepoints isolate failures and helper writes roll back with their outer transaction', async () => {
    for (const engine of engines) {
      await engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId, slug: 'nested' }]);
        await tx.putPage('nested', input('Committed'), { sourceId });
        await expect(tx.transaction(async child => {
          await child.putPage('nested', input('Rolled back'), { sourceId });
          // Force a SQL-aborted subtransaction, not only a JS exception.
          await child.executeRaw('SELECT 1/0');
        })).rejects.toThrow();
        expect((await tx.getPage('nested', { sourceId }))!.compiled_truth).toBe('Committed');
        await Promise.all([
          tx.transaction(child => child.addTag('nested', 'first', { sourceId })),
          tx.transaction(child => child.addTag('nested', 'second', { sourceId })),
        ]);
      });
      expect((await engine.readPageSnapshot('nested', { sourceId }))!.tags).toEqual(['first', 'second']);
      await expect(engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId, slug: 'nested' }]);
        await tx.setPageAliases('nested', sourceId, ['rolled-back-alias']);
        const fact = await tx.insertFact({ fact: 'Example fact', source: 'test', entity_slug: 'nested' }, { source_id: sourceId });
        await tx.insertFact({ fact: 'New example fact', source: 'test', entity_slug: 'nested' }, { source_id: sourceId, supersedeId: fact.id });
        await tx.insertFacts([{ fact: 'Batch example', source: 'test', entity_slug: 'nested', row_num: 1, source_markdown_slug: 'nested' }], { source_id: sourceId });
        await tx.createVersion('nested', { sourceId });
        throw new Error('Rollback the complete mutation');
      })).rejects.toThrow('Rollback the complete mutation');
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId])).toHaveLength(0);
      expect(await engine.getVersions('nested', { sourceId })).toHaveLength(0);
      expect((await engine.resolveAliases(['rolled-back-alias'], { sourceId })).size).toBe(0);
    }
  });

  test('snapshots keep tags and page content in one committed view', async () => {
    for (const engine of engines) {
      await engine.putPage('coherence', input('Before'), { sourceId });
      await engine.addTag('coherence', 'before', { sourceId });
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      let release!: () => void;
      const continueWrite = new Promise<void>(resolve => { release = resolve; });
      const write = engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId, slug: 'coherence' }]);
        await tx.putPage('coherence', input('After'), { sourceId });
        ready();
        await continueWrite;
        await tx.removeTag('coherence', 'before', { sourceId });
        await tx.addTag('coherence', 'after', { sourceId });
      });
      await started;
      const reading = engine.readPageSnapshot('coherence', { sourceId });
      release();
      const snapshot = (await reading)!;
      expect(snapshot.tags).toEqual([snapshot.page.compiled_truth.toLowerCase()]);
      await write;
      const committed = (await engine.readPageSnapshot('coherence', { sourceId }))!;
      expect(committed.page.compiled_truth).toBe('After');
      expect(committed.tags).toEqual(['after']);
    }
  });

  test('withdrawals overlay snapshots and versions using database text normalization', async () => {
    for (const engine of engines) {
      const claim = 'İnput  WÖRLD';
      const body = `Intro\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 | | test | |\n<!--- gbrain:facts:end -->`;
      await engine.putPage('withdrawn', input(body), { sourceId });
      await engine.addTag('withdrawn', 'version-tag', { sourceId });
      await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
        VALUES ($1,'world',gbrain_fact_fingerprint($2)) ON CONFLICT DO NOTHING`, [sourceId, claim]);
      const snapshot = (await engine.readPageSnapshot('withdrawn', { sourceId }))!;
      expect(snapshot.withdrawals).toHaveLength(1);
      const facts = parseFactsFence(snapshot.page.compiled_truth);
      expect(facts.warnings).toEqual([]);
      expect(facts.facts[0].active).toBe(false);
      expect(facts.facts[0].claim).toBe(claim);
      const version = await engine.createVersion('withdrawn', { sourceId });
      expect(version.compiled_truth).toBe(snapshot.page.compiled_truth);
      expect(version.knowledge_revision).toBe(snapshot.revision);
      expect(version.timeline).toBe('Timeline');
      expect(version.title).toBe('Example');
      expect(version.tags).toEqual(['version-tag']);
      await materializePageSnapshot(engine, snapshot);
      const materialized = await engine.executeRaw<{ compiled_truth: string; knowledge_revision: string }>('SELECT compiled_truth,knowledge_revision FROM pages WHERE id=$1', [snapshot.page.id]);
      expect(materialized[0].compiled_truth).toBe(snapshot.page.compiled_truth);
      expect(materialized[0].knowledge_revision).toBe(snapshot.revision);
      await engine.putPage('withdrawn', input('A later edit'), { sourceId });
      await expect(materializePageSnapshot(engine, snapshot)).rejects.toBeInstanceOf(PageRevisionConflictError);
    }
  });

  test('aliases and source/privacy scope remain exact', async () => {
    for (const engine of engines) {
      await engine.putPage('canonical-alias', input('Alias target'), { sourceId });
      await engine.executeRaw('INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ($1,$2,$3) ON CONFLICT (source_id,alias_slug) DO UPDATE SET canonical_slug=EXCLUDED.canonical_slug', [sourceId, 'snapshot-alias', 'canonical-alias']);
      expect(await engine.readPageSnapshot('snapshot-alias', { sourceId })).toBeNull();
      expect((await engine.readPageSnapshot('snapshot-alias', { sourceId, resolveAlias: true }))!.page.slug).toBe('canonical-alias');
      expect(await engine.readPageSnapshot('snapshot-alias', { sourceId: 'default', resolveAlias: true })).toBeNull();
      await engine.putPage('private-page', { ...input('Private'), frontmatter: { visibility: 'private' } }, { sourceId });
      expect(await engine.readPageSnapshot('private-page', { sourceId, excludePrivate: true })).toBeNull();
    }
  });

  test('scoped reads restore an enclosing transaction RLS binding', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      for (const engine of engines.filter(e => e.kind === 'postgres')) {
        await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('app.scopes','original-scope',true)");
          expect((await tx.readPageSnapshot('revision', { sourceId }))!.page.source_id).toBe(sourceId);
          const binding = await tx.executeRaw<{ scopes: string }>("SELECT current_setting('app.scopes') AS scopes");
          expect(binding[0].scopes).toBe('original-scope');
        });
      }
    });
  });

  test('guard identity cannot survive deleting and recreating a source', async () => {
    for (const engine of engines) {
      const temporarySource = `${sourceId}-recreated`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [temporarySource]);
      await engine.putPage('same-slug', input('Old source'), { sourceId: temporarySource });
      const old = (await engine.readPageSnapshot('same-slug', { sourceId: temporarySource }))!;
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [temporarySource]);
      expect(await engine.executeRaw('SELECT slug FROM page_write_guards WHERE source_incarnation=$1::uuid', [old.sourceIncarnation])).toHaveLength(0);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [temporarySource]);
      await engine.putPage('same-slug', input('New source'), { sourceId: temporarySource });
      const fresh = (await engine.readPageSnapshot('same-slug', { sourceId: temporarySource }))!;
      expect(fresh.sourceIncarnation).not.toBe(old.sourceIncarnation);
      expect(fresh.revision).not.toBe(old.revision);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [temporarySource]);
      await expect(engine.lockPageKeys([{ sourceId, slug: 'unscoped' }])).rejects.toThrow('requires engine.transaction');
    }
  });
});

test('revision preconditions distinguish absent, existing and explicit force', () => {
  const revision = '10000000-0000-4000-8000-000000000000';
  expect(() => assertPageRevision(null)).not.toThrow();
  expect(() => assertPageRevision({ revision })).toThrow(PageRevisionConflictError);
  expect(() => assertPageRevision(null, { expectedRevision: revision })).toThrow(PageRevisionConflictError);
  expect(() => assertPageRevision({ revision }, { expectedRevision: revision })).not.toThrow();
  expect(() => assertPageRevision(null, { force: true })).not.toThrow();
  expect(() => assertPageRevision(null, { force: true, expectedRevision: revision })).toThrow('mutually exclusive');
  expect(() => assertPageRevision(null, { expectedRevision: 'not-a-revision' })).toThrow('UUID');
});
