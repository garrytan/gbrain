/**
 * #8821: a page purge (explicit, or the expired-tombstone purge) removes the purged slug from the retrieval logs
 * (feedback store, eval capture). Real PGLite, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-retrieval-residue-'));
const SECRET = 'people/jane-roe-diagnosis';
const KEEP = 'notes/zorblax-overview';
const context = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true } as never,
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
const call = (name: string, params: Record<string, unknown>) =>
  withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === name)!.handler(context(), params)) as Promise<Record<string, any>>;

async function seed() {
  for (const slug of [SECRET, KEEP]) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `zorblax ${slug}` });
  const edge = `${KEEP}|mentions|${SECRET}`;
  await engine.executeRaw(`INSERT INTO retrieval_events(id, op) VALUES ('e1', 'search')`);
  for (const [rank, slug] of [SECRET, KEEP].entries()) {
    await engine.executeRaw(`INSERT INTO retrieval_event_pages(event_id, source_id, slug, rank) VALUES ('e1','default',$1,$2)`, [slug, rank]);
    await engine.executeRaw(`INSERT INTO retrieval_feedback(event_id, signal, element_kind, source_id, element_key, rating, weight_before, weight_after)
      VALUES ('e1','explicit','page','default',$1,5,0.5,0.6)`, [slug]);
    await engine.executeRaw(`INSERT INTO retrieval_weights(source_id, element_kind, element_key) VALUES ('default','page',$1)`, [slug]);
  }
  await engine.executeRaw(`INSERT INTO retrieval_event_links(event_id, source_id, edge_key, to_slug) VALUES ('e1','default',$1,$2)`, [edge, SECRET]);
  await engine.executeRaw(`INSERT INTO retrieval_feedback(event_id, signal, element_kind, source_id, element_key, rating, weight_before, weight_after)
    VALUES ('e1','explicit','link','default',$1,5,0.5,0.6)`, [edge]);
  await engine.executeRaw(`INSERT INTO retrieval_weights(source_id, element_kind, element_key) VALUES ('default','link',$1)`, [edge]);
  await engine.executeRaw(`INSERT INTO eval_candidates(tool_name, query, retrieved_slugs, vector_enabled, expansion_applied, latency_ms, remote)
    VALUES ('search','zorblax',$1::text[],false,false,1,false)`, [[SECRET, KEEP]]);
}

async function residue() {
  const n = async (sql: string) => Number((await engine.executeRaw<{ c: number }>(sql, [SECRET]))[0]!.c);
  return {
    retrieval_event_pages: await n(`SELECT count(*)::int AS c FROM retrieval_event_pages WHERE slug = $1`),
    retrieval_event_links: await n(`SELECT count(*)::int AS c FROM retrieval_event_links WHERE to_slug = $1 OR edge_key LIKE '%' || $1`),
    retrieval_feedback: await n(`SELECT count(*)::int AS c FROM retrieval_feedback WHERE element_key = $1 OR element_key LIKE '%|' || $1`),
    retrieval_weights: await n(`SELECT count(*)::int AS c FROM retrieval_weights WHERE element_key = $1 OR element_key LIKE '%|' || $1`),
    eval_candidates: await n(`SELECT count(*)::int AS c FROM eval_candidates WHERE $1 = ANY(retrieved_slugs)`),
  };
}
const CLEAN = { retrieval_event_pages: 0, retrieval_event_links: 0, retrieval_feedback: 0, retrieval_weights: 0, eval_candidates: 0 };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest(); await seed(); });

describe('purge removes the slug from retrieval logs', () => {
  test('explicit purge', async () => {
    const snapshot = await engine.readPageSnapshot(SECRET, { sourceId: 'default', includeDeleted: true });
    await call('delete_page', { slug: SECRET, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
    expect(await residue()).toEqual(CLEAN);
    const kept = await engine.executeRaw<{ retrieved_slugs: string[] }>('SELECT retrieved_slugs FROM eval_candidates');
    expect(kept[0]!.retrieved_slugs).toEqual([KEEP]);
    expect(Number((await engine.executeRaw<{ c: number }>(`SELECT count(*)::int AS c FROM retrieval_event_pages WHERE slug = $1`, [KEEP]))[0]!.c)).toBe(1);
  });

  test('expired tombstone purge; a soft delete keeps the rows', async () => {
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, [SECRET]);
    expect((await residue()).retrieval_event_pages).toBe(1);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = $1`, [SECRET]);
    await withEnv({ GBRAIN_HOME: home }, () => purgeDeletedPagesCoordinated(engine, 72));
    expect(await residue()).toEqual(CLEAN);
  });
});
