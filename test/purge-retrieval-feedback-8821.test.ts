/**
 * #8821: purging a page removes its slug from the retrieval-feedback stores and from captured eval candidates.
 *
 * 1. Protects: delete_page purge:true and the expired-tombstone purge (purge-deleted on an unmanaged brain) delete
 *    the source's retrieval_event_pages / retrieval_event_links / retrieval_feedback / retrieval_weights rows that
 *    name the slug (as a page key or either end of an edge key) and drop it from eval_candidates.retrieved_slugs,
 *    in the purge transaction, and the purge receipt checks each store.
 * 2. Fails when: a purged slug stays readable in any of those stores, or the scrub reaches another source's rows or
 *    another page's rows.
 * 3. Existing coverage: page-purge pins the page-keyed stores; nothing pinned the feedback tables.
 * 4. Real seams: PGLite, the feedback store's own writers, engine.logEvalCandidate, the delete_page op and
 *    purgeDeletedPagesCoordinated; repo-less brain, local blob storage, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { applyRatings, insertRetrievalEvents, scrubPurgedSlugs } from '../src/core/feedback/store.ts';
import { withEnv } from './helpers/with-env.ts';
import { beliefBrain, beliefPage, openFileBeliefBrain, withFileBeliefBrain } from './helpers/belief-ledger.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-feedback-'));
const SLUG = 'people/alice-example';
const OTHER = 'companies/acme-example';
const EDGE = `${SLUG}|works_at|${OTHER}`;

function context(): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
}

async function seed() {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const sourceId of ['default', 'source-b']) for (const slug of [SLUG, OTHER]) {
    await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n# ${slug}\n\nBody text.\n`, { noEmbed: true, sourceId });
  }
  await insertRetrievalEvents(engine, [{ id: 'event-a', client_id: 'local', op: 'query', links: [
    { source_id: 'default', edge_key: EDGE, to_slug: OTHER }, { source_id: 'source-b', edge_key: EDGE, to_slug: OTHER }], pages: [
    { source_id: 'default', slug: SLUG, content_hash: null, rank: 1, cited: true },
    { source_id: 'default', slug: OTHER, content_hash: null, rank: 2, cited: false },
    { source_id: 'source-b', slug: SLUG, content_hash: null, rank: 3, cited: false }] }]);
  await applyRatings(engine, { eventId: 'event-a', clientId: 'local', signal: 'explicit', alpha: 0.2, targets: [
    { kind: 'page', source_id: 'default', key: SLUG, rating: 5, content_hash: null },
    { kind: 'page', source_id: 'default', key: OTHER, rating: 4, content_hash: null },
    { kind: 'link', source_id: 'default', key: EDGE, rating: 4, content_hash: null },
    { kind: 'page', source_id: 'source-b', key: SLUG, rating: 3, content_hash: null }] });
  const candidate = (slugs: string[], sources: string[]) => engine.logEvalCandidate({ tool_name: 'query', query: 'who is alice', retrieved_slugs: slugs, retrieved_chunk_ids: [],
    source_ids: sources, expand_enabled: false, detail: null, detail_resolved: null, vector_enabled: false, expansion_applied: false, latency_ms: 1, remote: false, job_id: null, subagent_id: null });
  await candidate([OTHER, SLUG], ['default']);
  await candidate([SLUG], ['source-b']);
}

/** Every row, in any store, that still names SLUG; source-b's rows and OTHER's page rows are expected to stay. */
async function residue() {
  const q = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql, [SLUG]);
  return {
    retrieval_event_pages: await q(`SELECT source_id FROM retrieval_event_pages WHERE slug=$1 ORDER BY 1`),
    retrieval_event_links: await q(`SELECT source_id FROM retrieval_event_links WHERE strpos(edge_key, $1) > 0 ORDER BY 1`),
    retrieval_feedback: await q(`SELECT source_id FROM retrieval_feedback WHERE strpos(element_key, $1) > 0 ORDER BY 1`),
    retrieval_weights: await q(`SELECT source_id FROM retrieval_weights WHERE strpos(element_key, $1) > 0 ORDER BY 1`),
    eval_candidates: await q(`SELECT source_ids FROM eval_candidates WHERE $1 = ANY(retrieved_slugs) ORDER BY id`),
  };
}

const ONLY_SOURCE_B = {
  retrieval_event_pages: [{ source_id: 'source-b' }], retrieval_event_links: [{ source_id: 'source-b' }],
  retrieval_feedback: [{ source_id: 'source-b' }], retrieval_weights: [{ source_id: 'source-b' }], eval_candidates: [{ source_ids: ['source-b'] }],
};

async function untouched() {
  expect(await engine.executeRaw(`SELECT 1 FROM retrieval_event_pages WHERE source_id='default' AND slug=$1`, [OTHER])).toHaveLength(1);
  expect(await engine.executeRaw(`SELECT 1 FROM retrieval_weights WHERE source_id='default' AND element_key=$1`, [OTHER])).toHaveLength(1);
  expect(await engine.executeRaw<{ retrieved_slugs: string[] }>(`SELECT retrieved_slugs FROM eval_candidates WHERE 'default' = ANY(source_ids)`)).toEqual([{ retrieved_slugs: [OTHER] }]);
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest(); await seed(); });

describe('#8821 a page purge removes the slug from the retrieval logs and eval capture', () => {
  test('delete_page purge:true scrubs the source\'s rows and the receipt checks every store', async () => {
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    const result = await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
      { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect(result.status).toBe('purged');
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    await untouched();
    const stores = new Map((result.receipt.stores as Array<{ store: string; status: string }>).map(s => [s.store, s.status]));
    for (const store of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights', 'eval_candidates.retrieved_slugs']) {
      expect(stores.get(store)).toBe('deleted');
    }
  }, 60_000);

  test('the expired-tombstone purge scrubs the same rows', async () => {
    await engine.softDeletePage(SLUG, { sourceId: 'default' });
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    expect(purged.slugs).toContain(SLUG);
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    await untouched();
  }, 60_000);

  test('a feedback write still queued when the purge commits does not bring the slug back', async () => {
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
      { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }));
    await insertRetrievalEvents(engine, [{ id: 'event-late', client_id: 'local', op: 'query',
      links: [{ source_id: 'default', edge_key: EDGE, to_slug: OTHER }],
      pages: [{ source_id: 'default', slug: SLUG, content_hash: null, rank: 1, cited: true }, { source_id: 'default', slug: OTHER, content_hash: null, rank: 2, cited: false }] }]);
    await applyRatings(engine, { eventId: 'event-late', clientId: 'local', signal: 'explicit', alpha: 0.2, targets: [
      { kind: 'page', source_id: 'default', key: SLUG, rating: 5, content_hash: null }, { kind: 'link', source_id: 'default', key: EDGE, rating: 5, content_hash: null }] });
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    expect(await engine.executeRaw(`SELECT 1 FROM retrieval_event_pages WHERE event_id='event-late' AND slug=$1`, [OTHER])).toHaveLength(1);
  }, 60_000);

  test('a federated capture keeps a slug that another of its sources still has a page for', async () => {
    await engine.logEvalCandidate({ tool_name: 'query', query: 'federated', retrieved_slugs: [SLUG, OTHER], retrieved_chunk_ids: [],
      source_ids: ['default', 'source-b'], expand_enabled: false, detail: null, detail_resolved: null, vector_enabled: false, expansion_applied: false,
      latency_ms: 1, remote: false, job_id: null, subagent_id: null });
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    const result = await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
      { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect(await engine.executeRaw(`SELECT retrieved_slugs FROM eval_candidates WHERE query = 'federated'`)).toEqual([{ retrieved_slugs: [SLUG, OTHER] }]);
    const stores = new Map((result.receipt.stores as Array<{ store: string; status: string }>).map(s => [s.store, s.status]));
    expect(stores.get('eval_candidates.retrieved_slugs')).toBe('deleted');
  }, 60_000);

  // Added by /ship coverage audit.
  // Value: protects=purging the page at the to end of a from|type|to edge removes that edge's link rating, weight and event row;
  //   fails_when=the edge match keeps only the starts_with arm and drops the right-end arm; why_new=every case above purges the from end;
  //   seam=none; no_claim=Postgres parity (PGLite only)
  test('purging the page at the to end of an edge scrubs the edge\'s link rows too', async () => {
    const snapshot = await engine.readPageSnapshot(OTHER, { sourceId: 'default' });
    const result = await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
      { slug: OTHER, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect(result.status).toBe('purged');
    for (const table of ['retrieval_feedback', 'retrieval_weights']) {
      expect({ table, rows: await engine.executeRaw(`SELECT source_id FROM ${table} WHERE element_kind = 'link' AND element_key = $1 ORDER BY 1`, [EDGE]) })
        .toEqual({ table, rows: [] });
    }
    expect(await engine.executeRaw(`SELECT source_id FROM retrieval_event_links WHERE edge_key = $1 ORDER BY 1`, [EDGE])).toEqual([{ source_id: 'source-b' }]);
    expect(await engine.executeRaw(`SELECT 1 FROM retrieval_weights WHERE source_id = 'default' AND element_kind = 'page' AND element_key = $1`, [SLUG])).toHaveLength(1);
  }, 60_000);

  // Added by /ship coverage audit.
  // Value: protects=a slug that is a prefix of another page's slug scrubs none of that page's rows or edges;
  //   fails_when=the edge match drops its '|' delimiter (a LIKE/prefix match) or the page match loosens; why_new=no case purges a prefix slug;
  //   seam=none; no_claim=the purge transaction around the scrub (called directly)
  test('a slug that prefixes another page\'s slug scrubs none of its rows', async () => {
    expect(await scrubPurgedSlugs(engine, 'default', ['people/alice', 'companies/acme', 'works_at'])).toEqual({
      retrieval_event_pages: 0, retrieval_event_links: 0, retrieval_feedback: 0, retrieval_weights: 0, 'eval_candidates.retrieved_slugs': 0 });
    expect(await residue()).toEqual({ ...ONLY_SOURCE_B,
      retrieval_event_pages: [{ source_id: 'default' }, { source_id: 'source-b' }], retrieval_event_links: [{ source_id: 'default' }, { source_id: 'source-b' }],
      retrieval_feedback: [{ source_id: 'default' }, { source_id: 'default' }, { source_id: 'source-b' }],
      retrieval_weights: [{ source_id: 'default' }, { source_id: 'default' }, { source_id: 'source-b' }],
      eval_candidates: [{ source_ids: ['default'] }, { source_ids: ['source-b'] }] });
  }, 60_000);
});

test('#8821 a recorded tombstone the belief ledger expires scrubs the same rows', () => beliefBrain(async b => {
  await b.put(SLUG, beliefPage({ title: 'Alice', prose: 'Body of the page.' }));
  await b.put(OTHER, beliefPage({ title: 'Acme', prose: 'Body of the other page.' }));
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2`, [b.sourceId, SLUG]);
  await insertRetrievalEvents(b.engine, [{ id: 'event-b', client_id: 'local', op: 'query', links: [{ source_id: b.sourceId, edge_key: EDGE, to_slug: OTHER }],
    pages: [{ source_id: b.sourceId, slug: SLUG, content_hash: null, rank: 1, cited: true }] }]);
  await applyRatings(b.engine, { eventId: 'event-b', clientId: 'local', signal: 'explicit', alpha: 0.2,
    targets: [{ kind: 'page', source_id: b.sourceId, key: SLUG, rating: 5, content_hash: null }] });
  for (const table of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights']) {
    expect(await b.engine.executeRaw(`SELECT 1 FROM ${table} WHERE source_id = $1`, [b.sourceId])).toHaveLength(1);
  }
  const purged = await purgeDeletedPagesCoordinated(b.engine, 72);
  expect(purged.slugs).toContain(SLUG);
  for (const table of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights']) {
    expect(await b.engine.executeRaw(`SELECT 1 FROM ${table} WHERE source_id = $1`, [b.sourceId])).toHaveLength(0);
  }
}), 120_000);


test('#8821 a restore that replays a page purge scrubs the same rows from the restored brain', () => withFileBeliefBrain('restore-8821', async fb => {
  const src = 'restore-8821';
  await fb.open(async b => {
    await b.put(SLUG, beliefPage({ title: 'Alice', prose: 'Body of the page.' }));
    await b.put(OTHER, beliefPage({ title: 'Acme', prose: 'Body of the other page.' }));
    await insertRetrievalEvents(b.engine, [{ id: 'event-r', client_id: 'local', op: 'query', links: [{ source_id: src, edge_key: EDGE, to_slug: OTHER }],
      pages: [{ source_id: src, slug: SLUG, content_hash: null, rank: 1, cited: true }] }]);
    await applyRatings(b.engine, { eventId: 'event-r', clientId: 'local', signal: 'explicit', alpha: 0.2,
      targets: [{ kind: 'page', source_id: src, key: SLUG, rating: 5, content_hash: null }] });
  });
  const archive = join(fb.home, 'archive.gbrain-backup');
  await createPgliteBackup({ root: fb.home, output: archive });
  await fb.open(async b => {
    const snapshot = await b.engine.readPageSnapshot(SLUG, { sourceId: src });
    await operations.find(o => o.name === 'delete_page')!.handler(b.ctx, { slug: SLUG, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() });
  });
  const into = join(fb.home, 'restored');
  const result = await restorePgliteBackup({ archive, into });
  expect(result.purge_replay.replays.map(x => x.scope)).toEqual(['page']);
  const { brain, close } = await openFileBeliefBrain(join(into, '.gbrain', 'brain.pglite'), src, join(into, 'content'));
  try {
    expect((await brain.engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug', [src])).map(p => p.slug)).toEqual([OTHER]);
    for (const table of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights']) {
      expect({ table, rows: await brain.engine.executeRaw(`SELECT 1 FROM ${table} WHERE source_id = $1`, [src]) }).toEqual({ table, rows: [] });
    }
  } finally { await close(); }
}), 300_000);

