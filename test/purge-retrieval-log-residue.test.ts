/**
 * A page purge removes the purged slug from the retrieval logs: the feedback
 * store (retrieval_event_pages, retrieval_event_links, retrieval_feedback,
 * retrieval_weights) and eval capture (eval_candidates.retrieved_slugs).
 * Before this, a purged page's slug stayed in those tables until age-based
 * retention (30 days for feedback events; never for eval_candidates, whose
 * retention is the manual `gbrain eval prune`). Covers both hard-delete paths:
 * `delete_page purge:true` and the expired-tombstone purge
 * (`purge_deleted_pages`, the cycle purge phase). Real PGLite, no provider calls.
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
import { withEnv } from './helpers/with-env.ts';
import { insertRetrievalEvents } from '../src/core/feedback/store.ts';
import { _resetFeedbackRecordingForTests, drainFeedbackQueue } from '../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import { awaitPendingEvalCaptures } from '../src/core/eval-capture.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';

let engine: PGLiteEngine;
let storageDir: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-retrieval-logs-'));
const op = (name: string) => operations.find(o => o.name === name)!;
const SLUG = 'people/jane-roe-diagnosis';
const KEEP = 'notes/zorblax-overview';

function context(sourceId = 'default'): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true, eval: { capture: true },
    storage: { backend: 'local', bucket: 'b', localPath: storageDir } } as never,
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId };
}
const call = (name: string, params: Record<string, unknown>, sourceId = 'default') =>
  withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(sourceId), params)) as Promise<Record<string, any>>;

/** Seeds both pages, then runs one search that logs both and rates the answer, plus a typed edge into the page. */
async function seedRetrievalLogs() {
  await importFromContent(engine, SLUG, '---\ntitle: Jane Roe\ntype: person\n---\nJane Roe zorblax treatment notes.\n', { noEmbed: true, sourceId: 'default' });
  await importFromContent(engine, KEEP, '---\ntitle: Zorblax overview\n---\nZorblax overview for the team.\n', { noEmbed: true, sourceId: 'default' });
  await engine.setConfig('feedback.enabled', 'true');
  _resetFeedbackSettingsCacheForTests();
  const results = await call('search', { query: 'zorblax' }) as unknown as Array<{ slug: string }>;
  expect(results.map(r => r.slug)).toContain(SLUG);
  await drainFeedbackQueue(10_000);
  await awaitPendingEvalCaptures(10_000);
  const [event] = await engine.executeRaw<{ id: string }>('SELECT id FROM retrieval_events ORDER BY created_at DESC LIMIT 1');
  expect(event?.id).toMatch(/^ans_/);
  await call('rate_answer', { answer_id: event!.id, rating: 5 });
  await insertRetrievalEvents(engine, [{ id: `ans_${randomUUID()}`, client_id: 'local', op: 'query', pages: [],
    links: [{ source_id: 'default', edge_key: `${KEEP}|mentions|${SLUG}`, to_slug: SLUG }] }]);
}

/** Every row in the retrieval logs that still names the slug, by table. */
async function residue(slug: string): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await engine.executeRaw<{ n: number }>(sql, [slug]))[0]!.n);
  return {
    retrieval_event_pages: await n('SELECT count(*)::int AS n FROM retrieval_event_pages WHERE slug=$1'),
    retrieval_event_links: await n(`SELECT count(*)::int AS n FROM retrieval_event_links WHERE to_slug=$1 OR split_part(edge_key,'|',1)=$1 OR split_part(edge_key,'|',3)=$1`),
    retrieval_feedback: await n(`SELECT count(*)::int AS n FROM retrieval_feedback WHERE element_key=$1 OR split_part(element_key,'|',1)=$1 OR split_part(element_key,'|',3)=$1`),
    retrieval_weights: await n(`SELECT count(*)::int AS n FROM retrieval_weights WHERE element_key=$1 OR split_part(element_key,'|',1)=$1 OR split_part(element_key,'|',3)=$1`),
    eval_candidates: await n('SELECT count(*)::int AS n FROM eval_candidates WHERE $1 = ANY(retrieved_slugs)'),
  };
}
const NONE = { retrieval_event_pages: 0, retrieval_event_links: 0, retrieval_feedback: 0, retrieval_weights: 0, eval_candidates: 0 };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest();
  _resetFeedbackRecordingForTests(); _resetFeedbackSettingsCacheForTests();
  storageDir = mkdtempSync(join(home, 'storage-'));
});

describe('page purge clears the purged slug from retrieval logs', () => {
  test('delete_page purge:true leaves no retrieval-log row naming the slug, and keeps the other page\'s rows', async () => {
    await seedRetrievalLogs();
    const before = await residue(SLUG);
    for (const [table, count] of Object.entries(before)) expect({ table, present: count > 0 }).toEqual({ table, present: true });
    const kept = await residue(KEEP);
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
    const result = await call('delete_page', { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
    expect(result.status).toBe('purged');
    expect(await residue(SLUG)).toEqual(NONE);
    expect(result.purge.removed).toMatchObject({ retrieval_event_pages: 1, retrieval_event_links: 1, retrieval_feedback: 1, retrieval_weights: 1, eval_candidates: 1 });
    const byStore = new Map((result.receipt.stores as Array<{ store: string }>).map(s => [s.store, s]));
    for (const store of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights']) {
      expect(byStore.get(store)).toMatchObject({ status: 'deleted', removed: 1 });
    }
    // The surviving page's own rows stay (only the edge into the purged page goes).
    const after = await residue(KEEP);
    expect(after.retrieval_event_pages).toBe(kept.retrieval_event_pages);
    expect(after.eval_candidates).toBe(kept.eval_candidates);
    const [candidate] = await engine.executeRaw<{ slugs: string[] }>('SELECT retrieved_slugs AS slugs FROM eval_candidates ORDER BY id LIMIT 1');
    expect(candidate!.slugs).toEqual([KEEP]);
  }, 60_000);

  test('the expired-tombstone purge (soft delete, then purge_deleted_pages) leaves no row naming the slug', async () => {
    await seedRetrievalLogs();
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    const deleted = await call('delete_page', { slug: SLUG, request_id: randomUUID(), expected_revision: snapshot!.revision });
    expect(deleted.status).not.toBe('purged');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug=$1`, [SLUG]);
    const purged = await withEnv({ GBRAIN_HOME: home }, () => purgeDeletedPagesCoordinated(engine, 72));
    expect(purged.slugs).toEqual([SLUG]);
    expect(await residue(SLUG)).toEqual(NONE);
  }, 60_000);
});

describe('a multi-source brain scrubs a capture only of a result the purged source supplied', () => {
  const SHARED = 'people/shared', OTHER = 'notes/other', SOLO = 'people/alpha-only', SOFT = 'people/soft';
  const capture = async (slugs: string[], sources: string[]) => (await engine.executeRaw<{ id: number }>(
    `INSERT INTO eval_candidates (tool_name, query, retrieved_slugs, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
     VALUES ('search', 'q', $1::text[], $2::text[], false, false, 1, false) RETURNING id`, [slugs, sources]))[0]!.id;
  const slugsOf = async (id: number) =>
    (await engine.executeRaw<{ slugs: string[] }>('SELECT retrieved_slugs AS slugs FROM eval_candidates WHERE id=$1', [id]))[0]!.slugs;
  const purge = async (slug: string) => {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'alpha', includeDeleted: true });
    const result = await call('delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }, 'alpha');
    expect(result.status).toBe('purged');
    return result.purge.removed.eval_candidates as number;
  };

  test('a slug another captured source still holds (live or soft-deleted) stays; one only the purged source held goes', async () => {
    for (const id of ['alpha', 'beta']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    for (const [sourceId, slug] of [['alpha', SHARED], ['alpha', OTHER], ['alpha', SOLO], ['alpha', SOFT], ['beta', SHARED], ['beta', SOFT]]) {
      await importFromContent(engine, slug!, `---\ntitle: ${slug}\n---\nBody of ${slug}.\n`, { noEmbed: true, sourceId: sourceId! });
    }
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE source_id = 'beta' AND slug = $1`, [SOFT]);
    const mixed = await capture([OTHER, SHARED], ['alpha', 'beta']);   // beta supplied SHARED
    const alphaOnly = await capture([OTHER, SHARED], ['alpha']);
    const betaOnly = await capture([SHARED], ['beta']);
    const unsourced = await capture([SHARED], []);                     // no source recorded: only a 'default' purge matches
    const solo = await capture([SOLO, SHARED], ['alpha', 'beta']);     // beta has no SOLO page
    const soft = await capture([SOFT], ['alpha', 'beta']);              // beta's SOFT is soft-deleted, so restorable

    expect(await purge(SHARED)).toBe(1);
    expect(await slugsOf(mixed)).toEqual([OTHER, SHARED]);
    expect(await slugsOf(alphaOnly)).toEqual([OTHER]);
    expect(await slugsOf(betaOnly)).toEqual([SHARED]);
    expect(await slugsOf(unsourced)).toEqual([SHARED]);
    expect(await slugsOf(solo)).toEqual([SOLO, SHARED]);

    expect(await purge(SOLO)).toBe(1);
    expect(await slugsOf(solo)).toEqual([SHARED]);

    expect(await purge(SOFT)).toBe(0);
    expect(await slugsOf(soft)).toEqual([SOFT]);
  }, 60_000);
});
