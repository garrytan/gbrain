/**
 * #8821 on Postgres: a feedback write that runs while a page purge is still open cannot leave the purged slug behind.
 *
 * 1. Protects: a retrieval event or rating written (a) between the purge's journal reads and its page delete, or
 *    (b) after the page delete but before the purge commits, leaves no row naming the purged slug once both commit.
 * 2. Fails when: the scrub runs before the page row is deleted, or the feedback writers' page probe does not wait on
 *    the purge's row lock, so the late insert survives the purge's commit.
 * 3. Existing coverage: test/purge-retrieval-feedback-8821.test.ts (PGLite, one connection, no interleaving).
 * 4. Real seams: Postgres, two pool connections, the delete_page op with the purge's tail_recheck fault point, the
 *    feedback store's own writers and scrub; repo-less brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { applyRatings, insertRetrievalEvents, scrubPurgedSlugs } from '../../src/core/feedback/store.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const SLUG = 'people/alice-example';
const OTHER = 'companies/acme-example';
const EDGE = `${SLUG}|works_at|${OTHER}`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-race-'));
let engine: PostgresEngine;
let close: () => Promise<void>;

const context = (): OperationContext => ({ engine, config: { engine: 'postgres', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } } as never,
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });

async function lateFeedback(id: string) {
  await insertRetrievalEvents(engine, [{ id, client_id: 'local', op: 'query', links: [{ source_id: 'default', edge_key: EDGE, to_slug: OTHER }],
    pages: [{ source_id: 'default', slug: SLUG, content_hash: null, rank: 1, cited: true }] }]);
  await applyRatings(engine, { eventId: id, clientId: 'local', signal: 'explicit', alpha: 0.2, targets: [
    { kind: 'page', source_id: 'default', key: SLUG, rating: 5, content_hash: null }, { kind: 'link', source_id: 'default', key: EDGE, rating: 5, content_hash: null }] });
}

async function residue() {
  const n = async (sql: string) => (await engine.executeRaw(sql, [SLUG])).length;
  return {
    retrieval_event_pages: await n(`SELECT 1 FROM retrieval_event_pages WHERE source_id='default' AND slug=$1`),
    retrieval_event_links: await n(`SELECT 1 FROM retrieval_event_links WHERE source_id='default' AND strpos(edge_key, $1) > 0`),
    retrieval_feedback: await n(`SELECT 1 FROM retrieval_feedback WHERE source_id='default' AND strpos(element_key, $1) > 0`),
    retrieval_weights: await n(`SELECT 1 FROM retrieval_weights WHERE source_id='default' AND strpos(element_key, $1) > 0`),
  };
}
const NONE = { retrieval_event_pages: 0, retrieval_event_links: 0, retrieval_feedback: 0, retrieval_weights: 0 };

describeE2E('#8821 Postgres: feedback written during an open purge', () => {
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
  }, 120_000);
  afterAll(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    for (const table of ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights', 'retrieval_events']) await engine.executeRaw(`DELETE FROM ${table}`);
    for (const slug of [SLUG, OTHER]) await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n# ${slug}\n\nBody text ${randomUUID()}.\n`, { noEmbed: true, sourceId: 'default' });
  });

  test('a write between the purge\'s journal reads and its page delete is scrubbed', async () => {
    let late: Promise<void> | null = null;
    installFaultHook(async point => {
      if (point !== 'purge:tail_recheck' || late) return;
      late = lateFeedback('event-mid');
      await Promise.race([late, new Promise(r => setTimeout(r, 3000))]);
    });
    try {
      const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
      const result = await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
        { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
      expect(result.status).toBe('purged');
      expect(late).not.toBeNull();
      await late;
    } finally {
      installFaultHook(undefined);
    }
    expect(await residue()).toEqual(NONE);
  }, 120_000);

  test('a write after the page delete waits for the purge and is dropped', async () => {
    let late: Promise<void> | null = null;
    await engine.transaction(async tx => {
      await tx.executeRaw(`DELETE FROM pages WHERE source_id='default' AND slug=$1`, [SLUG]);
      await scrubPurgedSlugs(tx, 'default', [SLUG]);
      late = lateFeedback('event-after');
      await new Promise(r => setTimeout(r, 500));
    });
    await late;
    expect(await residue()).toEqual(NONE);
  }, 120_000);
});
