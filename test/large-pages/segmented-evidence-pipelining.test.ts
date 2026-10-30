/**
 * Evidence on segmented pages costs as few round trips in series as the pin allows.
 *
 * 1. Protects: one segmented page's evidence read issues its manifest rows and withdrawal ledger before the page row
 *    answers, and the batch's segment metadata before its first segment text answers; the pin confirm still starts
 *    only after every segment read answered. Several segmented hits are read at once, not one page after another.
 * 2. Fails when: openSegmentedBody waits for the page row before reading rows or the ledger, loadSegments waits for
 *    the metadata before the first text, the confirm runs alongside a read, or deliverEvidence plans segmented pages
 *    one after another again. Each statement in series is a round trip of wall time on a pooled Postgres.
 * 3. Existing coverage: test/large-pages/segmented-evidence.test.ts pins what the windows hold and
 *    test/large-pages/pinned-segmented-reads.test.ts that a raced read is refused; neither pins when statements run.
 * 4. Seam: none. Statement start and finish are observed on the PGLite handle the engine uses (one connection, so a
 *    statement issued before another one answered was issued concurrently).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { readBodyLedger } from '../../src/core/page-body/segment-ledger.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { importSegmented } from '../helpers/segmented-privacy-fixture.ts';

const PAGE_BYTES = 1536 * 1024;
const assemble = operations.find(o => o.name === 'assemble_evidence')!;
let engine: PGLiteEngine;
const events: Array<{ at: 'start' | 'end'; sql: string; params: unknown[] }> = [];
const pages: Record<string, { id: number; chunk: number }> = {};

const ctx = (): OperationContext => ({ engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
  emitResponseMeta: () => {} } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, word, seed] of [['chat/pipeline-a', 'zzpipelinealpha', 3], ['chat/pipeline-b', 'zzpipelinebeta', 5]] as const) {
    const id = await importSegmented(engine, slug, conversationPage(PAGE_BYTES, { seed, needles: [{ at: 0.6, word }] }));
    const [hit] = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text, $2) > 0 ORDER BY chunk_index LIMIT 1', [id, word]);
    pages[slug] = { id, chunk: Number(hit!.id) };
  }
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    const params = Array.isArray(rest[0]) ? rest[0] as unknown[] : [];
    events.push({ at: 'start', sql: text, params });
    return query(sql, ...rest).finally(() => events.push({ at: 'end', sql: text, params }));
  };
}, 600_000);

afterAll(async () => { await engine?.disconnect(); });

type Match = (e: { sql: string; params: unknown[] }) => boolean;
const first = (at: 'start' | 'end', match: Match) => events.findIndex(e => e.at === at && match(e));
const last = (at: 'start' | 'end', match: Match) => events.findLastIndex(e => e.at === at && match(e));
const onPage = (prefix: string, id: number): Match => e => e.sql.startsWith(prefix) && Number(e.params[0]) === id;
const OPEN = 'SELECT id, source_id, slug, body_storage, body_generation';
const ROWS = 'SELECT m.seq, m.occurrence_id';
const META = 'SELECT occurrence_id, entry_state, protected_regions';
const CONFIRM = 'SELECT slug, body_generation, knowledge_revision::text AS revision';
const isText: Match = e => e.sql.includes('FROM page_segment_texts');
const isLedger = (slug: string): Match => e => e.sql.startsWith('WITH chosen AS') && e.params[0] === slug;

async function evidence(slugs: string[]) {
  events.length = 0;
  const out = await assemble.handler(ctx(), { hits: slugs.map(slug => ({ source_id: 'default', slug, chunk_id: pages[slug]!.chunk })), return_unit: 'window', return_window: 2,
    token_budget: 30_000 }) as { results: Array<{ slug: string; chunk_text: string; delivered: { unit: string } }> };
  return out.results;
}

describe('segmented evidence reads (PGLite)', () => {
  test('one page: rows and ledger are issued with the page row, metadata with the first text, and the pin confirm after every read', async () => {
    const results = await evidence(['chat/pipeline-a']);
    expect(results.map(r => [r.slug, r.delivered.unit, r.chunk_text.includes('zzpipelinealpha')])).toEqual([['chat/pipeline-a', 'window', true]]);
    const { id } = pages['chat/pipeline-a']!;
    const openEnd = first('end', onPage(OPEN, id));
    expect(openEnd).toBeGreaterThan(-1);
    expect(first('start', onPage(ROWS, id))).toBeGreaterThan(-1);
    expect(first('start', onPage(ROWS, id))).toBeLessThan(openEnd);
    expect(first('start', isLedger('chat/pipeline-a'))).toBeGreaterThan(-1);
    expect(first('start', isLedger('chat/pipeline-a'))).toBeLessThan(openEnd);
    expect(first('start', onPage(META, id))).toBeGreaterThan(-1);
    expect(first('start', onPage(META, id))).toBeLessThan(first('end', isText));
    expect(first('start', isText)).toBeLessThan(first('end', onPage(META, id)));
    const confirmStart = first('start', onPage(CONFIRM, id));
    expect(confirmStart).toBeGreaterThan(last('end', isText));
    expect(confirmStart).toBeGreaterThan(last('end', onPage(META, id)));
    expect(confirmStart).toBeGreaterThan(last('end', onPage(ROWS, id)));
    expect(confirmStart).toBeGreaterThan(last('end', isLedger('chat/pipeline-a')));
  }, 120_000);

  test('two pages: the second page is opened before the first page is confirmed', async () => {
    const results = await evidence(['chat/pipeline-a', 'chat/pipeline-b']);
    expect(results.map(r => [r.slug, r.delivered.unit])).toEqual([['chat/pipeline-a', 'window'], ['chat/pipeline-b', 'window']]);
    expect(results[0]!.chunk_text).toContain('zzpipelinealpha');
    expect(results[1]!.chunk_text).toContain('zzpipelinebeta');
    const [a, b] = [pages['chat/pipeline-a']!.id, pages['chat/pipeline-b']!.id];
    const opened = (id: number) => first('start', onPage(OPEN, id));
    const confirmed = (id: number) => first('end', onPage(CONFIRM, id));
    expect(Math.min(opened(a), opened(b))).toBeGreaterThan(-1);
    expect(Math.max(opened(a), opened(b))).toBeLessThan(Math.min(confirmed(a), confirmed(b)));
  }, 120_000);

  test('a ledger read under a name the page row does not carry is read again under its own', async () => {
    const { id } = pages['chat/pipeline-a']!;
    await engine.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', 'chat/pipeline-a', gbrain_fact_fingerprint('zz withdrawn claim')) ON CONFLICT DO NOTHING");
    try {
      const own = await readBodyLedger(engine, 'default', 'chat/pipeline-a');
      expect(own.withdrawals.length).toBeGreaterThan(0);
      const body = await openSegmentedBody(engine, { pageId: id, expect: { slug: 'chat/pipeline-b', sourceId: 'default' } });
      expect(body.ledger).toEqual(own);
    } finally {
      await engine.executeRaw("DELETE FROM fact_withdrawals WHERE subject='chat/pipeline-a'");
    }
  }, 120_000);
});
