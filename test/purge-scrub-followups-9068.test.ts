/**
 * #9068 follow-up: every delete that removes a page row also removes the rows that name it outside a foreign key, and
 * an eval capture that lands after a purge does not write the purged slug back.
 *
 * 1. Protects: (a) a deferred eval capture (the query response went out before the insert ran) that lands after the
 *    page purge stores only slugs whose page still exists, and on Postgres one that runs while the purge is still open
 *    waits on the page row and drops the slug; (b) the connector delete (deleteConnectorPage -> deletePages) scrubs
 *    retrieval logs, ratings, weights, the volunteer log, the gazetteer and the eval candidates' captured slugs for
 *    that source in the delete's transaction, and so does the transcript stale-part delete, which now calls it;
 *    (c) removing a source (unmanaged removeSource -> deleteSourceRow, and the managed lifecycle remove) drops every
 *    such row of the source, and strips its slugs from eval candidates no other covered source still answers;
 *    (d) a capture keeps a facts-arm result (facts/<id>) while its fact exists; (e) a source re-created with the same
 *    id between deleteSourceRow's delete and its second scrub keeps its rows; (f) a fire-and-forget volunteer-log write
 *    built before a purge and landing after it (or, on Postgres, while the purge is open) drops the purged page's slug
 *    and rationale and keeps live pages.
 * 2. Fails when: logEvalCandidate inserts slugs without probing the page row under a key-share lock or drops a live
 *    fact's result, insertVolunteerEvents writes a row for a page that no longer exists, a hard delete or a source removal leaves any of those rows behind, or a scrub reaches another
 *    source's rows, a re-created source's rows or a slug another source the candidate covers still holds.
 * 3. Existing coverage: purge-retrieval-feedback-8821 and purge-name-stores-9068 pin delete_page purge and the
 *    tombstone purge only; nothing pinned the capture, the connector and stale-part deletes, or source removal.
 * 4. Real seams: PGLite, and Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt); the feedback store's
 *    writers, captureEvalCandidate under withResponseDeferral, the delete_page op, deleteConnectorPage, runTranscriptsIngest, removeSource,
 *    runManagedSourceLifecycle; repo-less brain, no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EvalCandidateInput } from '../src/core/types.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { applyRatings, insertRetrievalEvents, scrubPurgedSlugs } from '../src/core/feedback/store.ts';
import { awaitPendingVolunteerEventWrites, insertVolunteerEvents, logVolunteerEventsFireAndForget, type VolunteerEventRow } from '../src/core/context/volunteer-events.ts';
import { scrubPurgedNameStores } from '../src/core/persistence/purge-name-stores.ts';
import { captureEvalCandidate } from '../src/core/eval-capture.ts';
import { withResponseDeferral } from '../src/core/background-work.ts';
import { deleteConnectorPage } from '../src/core/connectors/api-source.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { buildTranscriptSlug } from '../src/core/transcripts/types.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-followups-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const OTHER = 'companies/acme-example';

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

const candidate = (query: string, slugs: string[], sources: string[]): EvalCandidateInput => ({ tool_name: 'query', query, retrieved_slugs: slugs,
  retrieved_chunk_ids: [], source_ids: sources, expand_enabled: null, detail: null, detail_resolved: null, vector_enabled: false,
  expansion_applied: false, latency_ms: 1, remote: false, job_id: null, subagent_id: null });
const capturedSlugs = async (engine: BrainEngine, query: string) =>
  (await engine.executeRaw<{ retrieved_slugs: string[] }>('SELECT retrieved_slugs FROM eval_candidates WHERE query = $1', [query])).map(r => r.retrieved_slugs);

async function page(engine: BrainEngine, sourceId: string, slug: string) {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
  await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n# ${slug}\n\nBody text ${randomUUID()}.\n`, { noEmbed: true, sourceId });
}

/** The page and OTHER in `sourceId`, and every store that names the page (traces). */
async function traced(engine: BrainEngine, sourceId: string, slug: string) {
  await page(engine, sourceId, slug);
  await traces(engine, sourceId, slug);
}

/** OTHER in `sourceId`, and for an existing page a retrieval event (page and edge), page and edge ratings, a volunteer pointer, a gazetteer entry. */
async function traces(engine: BrainEngine, sourceId: string, slug: string) {
  await page(engine, sourceId, OTHER);
  const id = randomUUID(), edge = `${slug}|mentions|${OTHER}`;
  await insertRetrievalEvents(engine, [{ id, client_id: 'local', op: 'query', links: [{ source_id: sourceId, edge_key: edge, to_slug: OTHER }],
    pages: [{ source_id: sourceId, slug, content_hash: null, rank: 1, cited: true }] }]);
  await applyRatings(engine, { eventId: id, clientId: 'local', signal: 'explicit', alpha: 0.2, targets: [
    { kind: 'page', source_id: sourceId, key: slug, rating: 5, content_hash: null }, { kind: 'link', source_id: sourceId, key: edge, rating: 5, content_hash: null }] });
  await insertVolunteerEvents(engine, [{ source_id: sourceId, slug, confidence: 0.9, match_arm: 'alias', rationale: `alias match "${slug}"`, channel: 'op' }]);
  await engine.executeRaw('INSERT INTO mention_gazetteer_entries (source_id, name_norm, target_slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sourceId, slug, slug]);
}

/** Rows per store that still name `slug` in `sourceId` (any row of the source when null). */
async function residue(engine: BrainEngine, sourceId: string, slug: string | null) {
  const n = async (sql: string) => (await engine.executeRaw(sql, [sourceId, slug])).length;
  const named = (col: string) => `($2::text IS NULL OR strpos(${col}, $2::text) > 0)`;
  return {
    retrieval_event_pages: await n(`SELECT 1 FROM retrieval_event_pages WHERE source_id = $1 AND ${named('slug')}`),
    retrieval_event_links: await n(`SELECT 1 FROM retrieval_event_links WHERE source_id = $1 AND ${named("edge_key || '|' || to_slug")}`),
    retrieval_feedback: await n(`SELECT 1 FROM retrieval_feedback WHERE source_id = $1 AND ${named('element_key')}`),
    retrieval_weights: await n(`SELECT 1 FROM retrieval_weights WHERE source_id = $1 AND ${named('element_key')}`),
    context_volunteer_events: await n(`SELECT 1 FROM context_volunteer_events WHERE source_id = $1 AND ${named('slug')}`),
    mention_gazetteer_entries: await n(`SELECT 1 FROM mention_gazetteer_entries WHERE source_id = $1 AND ${named('target_slug')}`),
  };
}
const NONE = { retrieval_event_pages: 0, retrieval_event_links: 0, retrieval_feedback: 0, retrieval_weights: 0, context_volunteer_events: 0, mention_gazetteer_entries: 0 };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => {
  for (const engine of engines) await disposePersistenceConsumer(engine);
  await engines.find(e => e.kind === 'pglite')?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true });
}, 60_000);

describe('#9068 an eval capture does not write a purged slug back', () => {
  test('a deferred capture that lands after delete_page purge:true keeps only live slugs', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/alice-capture';
      await page(engine, 'default', slug);
      await page(engine, 'default', OTHER);
      const query = `deferred capture ${randomUUID()}`;
      let captured!: Promise<void>;
      const deferred = await withResponseDeferral(async () => {
        captured = captureEvalCandidate(engine, { tool_name: 'query', query, latency_ms: 1, remote: true, expand_enabled: null, detail: null, job_id: null, subagent_id: null,
          results: [{ slug, source_id: 'default', chunk_id: 1 }, { slug: OTHER, source_id: 'default', chunk_id: 2 }] as never,
          meta: { detail_resolved: null, vector_enabled: false, expansion_applied: false } as never }, { scrub_pii: false });
      });
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const result = await op('delete_page').handler(ctx(engine), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      expect(deferred.release()).toBe(1);
      await captured;
      expect({ engine: engine.kind, slugs: await capturedSlugs(engine, query) }).toEqual({ engine: engine.kind, slugs: [[OTHER]] });
    }
  }), 120_000);

  test('a capture keeps, in order, each slug a page of its sources still holds', async () => {
    for (const engine of engines) {
      await page(engine, 'default', 'notes/kept-a');
      await page(engine, 'source-b', 'notes/kept-b');
      const query = `kept ${randomUUID()}`;
      await engine.logEvalCandidate(candidate(query, ['notes/kept-b', 'notes/never-existed', 'notes/kept-a'], ['default', 'source-b']));
      expect({ engine: engine.kind, slugs: await capturedSlugs(engine, query) }).toEqual({ engine: engine.kind, slugs: [['notes/kept-b', 'notes/kept-a']] });
    }
  }, 120_000);

  test('a capture keeps a facts-arm result while its fact exists', async () => {
    for (const engine of engines) {
      await page(engine, 'default', 'notes/live-page');
      const [fact] = await engine.executeRaw<{ id: number | string }>(
        `INSERT INTO facts (fact, source, source_id) VALUES ('alice-example joined acme-example', 'fixture', 'default') RETURNING id`);
      const query = `facts arm ${randomUUID()}`;
      await engine.logEvalCandidate(candidate(query, [`facts/${fact!.id}`, 'facts/999999999', 'notes/live-page'], ['default']));
      expect({ engine: engine.kind, slugs: await capturedSlugs(engine, query) })
        .toEqual({ engine: engine.kind, slugs: [[`facts/${fact!.id}`, 'notes/live-page']] });
    }
  }, 120_000);

  const postgresTest = testBackends().includes('postgres') ? test : test.skip;
  postgresTest('on Postgres a capture during an open purge waits for it and drops the slug', async () => {
    const engine = engines.find(e => e.kind === 'postgres')!;
    const slug = 'people/alice-race';
    await page(engine, 'default', slug);
    await page(engine, 'default', OTHER);
    const query = `race ${randomUUID()}`;
    let late: Promise<number> | null = null;
    await engine.transaction(async tx => {
      await tx.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);
      await scrubPurgedSlugs(tx, 'default', [slug]);
      late = engine.logEvalCandidate(candidate(query, [slug, OTHER], ['default']));
      await new Promise(r => setTimeout(r, 500));
    });
    await late;
    expect(await capturedSlugs(engine, query)).toEqual([[OTHER]]);
  }, 120_000);
});

const volunteered = (sourceId: string, slug: string, name: string): VolunteerEventRow =>
  ({ source_id: sourceId, slug, confidence: 0.9, match_arm: 'alias', rationale: `alias match "${name}"`, channel: 'op' });
const volunteerRows = async (engine: BrainEngine, slug: string, name: string) =>
  (await engine.executeRaw<{ slug: string }>('SELECT slug FROM context_volunteer_events WHERE slug = $1 OR strpos(rationale, $2) > 0 ORDER BY id', [slug, name])).map(r => r.slug);

describe('#9068 a late volunteer-log write does not restore a purged page', () => {
  test('a volunteer write built before delete_page purge:true and landing after it keeps only live pages', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/alice-late-volunteer', name = 'Alice Late Volunteer';
      const live = `notes/live-volunteer-${engine.kind}`;
      await page(engine, 'default', slug);
      await page(engine, 'default', live);
      const rows = [volunteered('default', slug, name), volunteered('default', live, 'Live Volunteer')];
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const result = await op('delete_page').handler(ctx(engine), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      logVolunteerEventsFireAndForget(engine, rows);
      expect(await awaitPendingVolunteerEventWrites()).toEqual({ unfinished: 0 });
      expect({ engine: engine.kind, purged: await volunteerRows(engine, slug, name), live: await volunteerRows(engine, live, 'Live Volunteer') })
        .toEqual({ engine: engine.kind, purged: [], live: [live] });
    }
  }), 120_000);

  const postgresTest = testBackends().includes('postgres') ? test : test.skip;
  postgresTest('on Postgres a volunteer write during an open purge waits for it and drops the purged page', async () => {
    const engine = engines.find(e => e.kind === 'postgres')!;
    const slug = 'people/alice-volunteer-race', name = 'Alice Volunteer Race';
    await page(engine, 'default', slug);
    await page(engine, 'default', OTHER);
    let late: Promise<void> | null = null;
    await engine.transaction(async tx => {
      await tx.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);
      await scrubPurgedNameStores(tx, 'default', [slug]);
      late = insertVolunteerEvents(engine, [volunteered('default', slug, name), volunteered('default', OTHER, 'Acme Race')]);
      await new Promise(r => setTimeout(r, 500));
    });
    await late;
    expect(await volunteerRows(engine, slug, name)).toEqual([]);
    expect((await volunteerRows(engine, OTHER, 'Acme Race')).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('#9068 the batch hard delete scrubs what names the page', () => {
  test('the connector delete (deletePages) scrubs the source\'s rows and leaves other sources and pages', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'notes/connector-item';
      for (const sourceId of ['default', 'source-b']) await traced(engine, sourceId, slug);
      const solo = `connector solo ${randomUUID()}`, shared = `connector shared ${randomUUID()}`;
      await engine.logEvalCandidate(candidate(solo, [slug, OTHER], ['default']));
      await engine.logEvalCandidate(candidate(shared, [slug, OTHER], ['default', 'source-b']));
      const summary = { added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], factsRetired: 0 };
      await deleteConnectorPage({ engine, sourceId: 'default', managed: null, summary, label: 'Meetings', tag: 'meetings', record: 'database', dir: null },
        `${slug}.md`, 'delete', 'deleted upstream');
      expect(summary.deleted).toBe(1);
      expect({ engine: engine.kind, residue: await residue(engine, 'default', slug) }).toEqual({ engine: engine.kind, residue: NONE });
      expect(await residue(engine, 'source-b', slug)).toEqual({ retrieval_event_pages: 1, retrieval_event_links: 1, retrieval_feedback: 2, retrieval_weights: 2,
        context_volunteer_events: 1, mention_gazetteer_entries: 1 });
      expect(await capturedSlugs(engine, solo)).toEqual([[OTHER]]);
      expect(await capturedSlugs(engine, shared)).toEqual([[slug, OTHER]]);
      expect(await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1`, [OTHER])).toHaveLength(1);
    }
  }), 120_000);

});

/** An openclaw session file with `count` large messages, so a low page ceiling splits it into parts. */
function session(dir: string, id: string, count: number): string {
  const filler = 'lorem widget fact '.repeat(220);
  const at = (i: number) => `2026-08-10T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
  const lines = [JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-10T08:00:00.000Z', cwd: '/tmp' }),
    ...Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'message', id: `m-${i}`, timestamp: at(i),
      message: { role: i % 2 === 0 ? 'user' : 'assistant', timestamp: at(i), content: [{ type: 'text', text: `marker-${i} ${filler}` }] } }))];
  const path = join(dir, `${id}-${count}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('#9068 the transcript stale-part delete scrubs what names the part', () => {
  test('a re-ingest that shrinks a split session deletes its stale parts with their rows', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const dir = mkdtempSync(join(home, 'sessions-')), id = `shrink-${engine.kind}`;
      const ingest = (path: string) => runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' });
      await engine.setConfig('pages.max_bytes', '100000');
      let parts: number;
      try { parts = (await ingest(session(dir, id, 150))).pages.imported; } finally { await engine.unsetConfig('pages.max_bytes'); }
      expect(parts).toBeGreaterThan(1);
      const stale = `${buildTranscriptSlug('openclaw', '2026-08-10T08:00:00.000Z', { sessionId: id })}-p2`;
      await traces(engine, 'default', stale);
      const query = `stale part ${randomUUID()}`;
      await engine.logEvalCandidate(candidate(query, [stale, OTHER], ['default']));
      expect((await ingest(session(dir, id, 2))).partsDeleted).toBe(parts - 1);
      expect(await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1`, [stale])).toHaveLength(0);
      expect({ engine: engine.kind, residue: await residue(engine, 'default', stale) }).toEqual({ engine: engine.kind, residue: NONE });
      expect(await capturedSlugs(engine, query)).toEqual([[OTHER]]);
    }
  }), 180_000);
});

describe('#9068 removing a source scrubs every row that names its pages', () => {
  test('unmanaged removeSource drops the source\'s rows and strips its slugs from eval candidates', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const gone = 'source-gone', slug = 'notes/gone-page';
      await traced(engine, gone, slug);
      await traced(engine, 'default', 'notes/default-page');
      await engine.executeRaw(`INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, rationale, channel) VALUES ($1, 'notes/orphan', 0.5, 'alias', 'alias match "orphan"', 'op')`, [gone]);
      const solo = `source solo ${randomUUID()}`, shared = `source shared ${randomUUID()}`;
      await engine.logEvalCandidate(candidate(solo, [slug, OTHER], [gone]));
      await engine.logEvalCandidate(candidate(shared, [slug, OTHER], [gone, 'default']));
      const before = await residue(engine, 'default', null);
      const result = await removeSource(engine, { id: gone, yes: true });
      expect(result.pages_deleted).toBe(2);
      expect({ engine: engine.kind, residue: await residue(engine, gone, null) }).toEqual({ engine: engine.kind, residue: NONE });
      expect(await residue(engine, 'default', null)).toEqual(before);
      expect(await capturedSlugs(engine, solo)).toEqual([[]]);
      expect(await capturedSlugs(engine, shared)).toEqual([[OTHER]]);
    }
  }), 120_000);

  test('a source re-created between the delete and its second scrub keeps its rows', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const id = 'source-reused', slug = 'notes/reused-page', query = `reused ${randomUUID()}`;
      await traced(engine, id, slug);
      let calls = 0;
      const racing = { executeRaw: async (sql: string, params?: unknown[]) => {
        if (calls++ === 1) {
          await traced(engine, id, slug);
          await engine.logEvalCandidate(candidate(query, [slug, OTHER], [id]));
        }
        return engine.executeRaw(sql, params);
      } } as Pick<BrainEngine, 'executeRaw'>;
      expect(await deleteSourceRow(racing, id)).toBe(true);
      expect({ engine: engine.kind, residue: await residue(engine, id, slug) }).toEqual({ engine: engine.kind, residue: { retrieval_event_pages: 1,
        retrieval_event_links: 1, retrieval_feedback: 2, retrieval_weights: 2, context_volunteer_events: 1, mention_gazetteer_entries: 1 } });
      expect(await capturedSlugs(engine, query)).toEqual([[slug, OTHER]]);
    }
  }), 120_000);

  test('the managed lifecycle remove does the same', async () => {
    for (const engine of engines) {
      const lifecycleHome = mkdtempSync(join(tmpdir(), 'gbrain-purge-followups-managed-'));
      try {
        await withEnv({ GBRAIN_HOME: lifecycleHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const managed = 'source-managed', slug = 'notes/managed-page', root = join(lifecycleHome, 'canonical');
          mkdirSync(root);
          await registerLocalWriter(engine, 'cli');
          await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [managed, root]);
          await traced(engine, managed, slug);
          const query = `managed ${randomUUID()}`;
          await engine.logEvalCandidate(candidate(query, [slug, OTHER], [managed]));
          await claimWorktree(engine, managed, root);
          await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
          try {
            const result = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: managed, confirmDestructive: true, requestId: randomUUID() });
            expect(result).toMatchObject({ state: 'committed' });
          } finally {
            await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
            await disposePersistenceConsumer(engine);
          }
          expect({ engine: engine.kind, residue: await residue(engine, managed, null) }).toEqual({ engine: engine.kind, residue: NONE });
          expect(await capturedSlugs(engine, query)).toEqual([[]]);
        });
      } finally { rmSync(lifecycleHome, { recursive: true, force: true }); }
    }
  }, 180_000);
});
