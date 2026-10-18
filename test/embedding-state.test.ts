/**
 * #6696 B3 embedding state, derived: the classifier puts every chunk, and every
 * live page with no chunk row, in exactly one state against the ACTIVE embedding
 * column, ops mode reads only index-backed counts (unknown without a covering
 * partial index), and the summary's unsearchable / keyword_only / deleted /
 * unstamped fields follow the contract in src/core/embedding-state.ts.
 *
 * Protects: the state counts doctor `embedding_state`, `get_brain_health` and
 * `gbrain pages unsearchable` report. Regression it catches: a classifier that
 * reads the legacy `embedding` column on a registry-routed brain, drifts from the
 * embed job's predicate, or scans in ops mode. No existing owner: the classifier
 * is new. PGLite in-memory; the SQL is shared by both engines.
 */
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { readEmbeddingState, embeddingStateFix, EMBEDDING_STATES } from '../src/core/embedding-state.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.unsetConfig('search_embedding_column');
  await engine.unsetConfig('embedding_columns');
  await engine.unsetConfig('embedding_disabled');
});

const VEC = `array_fill(0.1::real, ARRAY[1536])::vector`;

async function page(slug: string, opts: { body?: string; frontmatter?: Record<string, unknown>; deletedHoursAgo?: number; source?: string } = {}): Promise<number> {
  const source = opts.source ?? 'default';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: opts.body ?? `${slug} body` }, { sourceId: source });
  const [row] = await engine.executeRaw<{ id: number }>(
    `UPDATE pages SET frontmatter = $3::jsonb, deleted_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(hours => $4::int) END
      WHERE slug = $1 AND source_id = $2 RETURNING id`,
    [slug, source, JSON.stringify(opts.frontmatter ?? {}), opts.deletedHoursAgo ?? null]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  return row!.id;
}

async function chunks(pageId: number, specs: Array<{ vector?: boolean; stamped?: boolean; column?: string }>): Promise<void> {
  for (const [i, spec] of specs.entries()) {
    const column = spec.column ?? 'embedding';
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, ${column}, embedding_pending_since)
       VALUES ($1, $2, $3, ${spec.vector ? (column === 'embedding' ? VEC : `array_fill(0.1::real, ARRAY[8])::vector`) : 'NULL'}, ${spec.stamped === false || spec.vector ? 'NULL' : 'now()'})`,
      [pageId, i, `chunk ${i} of page ${pageId}`]);
  }
}

/** One page per state; expected full counts below. */
async function seedEveryState(): Promise<void> {
  await chunks(await page('notes/alice-example'), [{ vector: true }, { vector: true }]);
  await chunks(await page('notes/acme-example'), [{}, { stamped: false }]);
  await chunks(await page('notes/fund-a-oversized', { frontmatter: { embed_skip: { reason: 'oversized', bytes: 600_000, assessed_at: '2026-01-01T00:00:00Z' } } }), [{}]);
  await page('notes/fund-a-oversized-bare', { frontmatter: { embed_skip: { reason: 'oversized', bytes: 700_000, assessed_at: '2026-01-01T00:00:00Z' } } });
  await page('notes/junk-hidden', { frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'captcha', assessed_at: '2026-01-01T00:00:00Z' } } });
  await chunks(await page('notes/junk-legacy', { frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'captcha', assessed_at: '2026-01-01T00:00:00Z' } } }), [{}, {}]);
  await page('notes/empty-stub', { body: '' });
  await page('notes/stub-with-body');
  await chunks(await page('notes/deleted-recent', { deletedHoursAgo: 1 }), [{ vector: true }]);
  await chunks(await page('notes/deleted-old', { deletedHoursAgo: 100 }), [{}, { vector: true }]);
}

const EVERY_STATE = { embedded: 2, pending: 2, keyword_only: 2, quarantined: 3, empty: 1, deleted_page_chunks: 3, chunkless_healable: 1 };

describe('embedding state classifier (full mode)', () => {
  test('every state on the legacy column, exact', async () => {
    await seedEveryState();
    const s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.status).toBe('known');
    expect(s.basis).toBe('exact');
    expect(s.active_column).toBe('embedding');
    expect(s.counts).toEqual(EVERY_STATE);
    expect(Object.keys(s.counts).sort()).toEqual([...EMBEDDING_STATES].sort());
    expect(s.unsearchable).toBe(2 + 3 + 1 + 1);
    expect(s.unsearchable_complete).toBe(true);
    expect(s.deleted_page_chunks).toEqual({ within_window: 1, past_window: 2, window_hours: 72 });
    // The default bytes_block is the 24 MiB page ceiling (large pages Wave A); these markers predate it.
    expect(s.keyword_only).toMatchObject({ reason: 'embed_skip', pages: 2, marker_bytes: 1_300_000, threshold_bytes: PAGE_MAX_BYTES });
    const unstamped = s.unstamped_pending as { count: number; created_at_lower_bound: string | null; writer_version: string };
    expect(unstamped.count).toBe(1);
    expect(unstamped.created_at_lower_bound).not.toBeNull();
    expect(unstamped.writer_version).toMatch(/^\d+\.\d+/);
    expect(s.coverage).toMatchObject({ basis: 'exact', embedded: 2, eligible: 4, ratio: 0.5 });
  });

  test('pending is the embed job predicate minus quarantined pages; chunkless_healable is the healer predicate', async () => {
    await seedEveryState();
    const s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.counts.pending! + 2).toBe(await engine.countStaleChunks());
    expect(s.counts.chunkless_healable).toBe(await engine.countChunklessPagesWithContent());
  });

  test('classifier per state with a custom active column', async () => {
    await seedEveryState();
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_reg8 vector(8)');
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding_reg8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' } }));
    await engine.setConfig('search_embedding_column', 'embedding_reg8');
    // The legacy vectors no longer count: alice-example's two chunks are pending under embedding_reg8.
    let s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.active_column).toBe('embedding_reg8');
    expect(s.counts).toEqual({ ...EVERY_STATE, embedded: 0, pending: 4 });
    await engine.executeRaw(`UPDATE content_chunks SET embedding_reg8 = array_fill(0.1::real, ARRAY[8])::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/acme-example')`);
    s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.counts).toEqual({ ...EVERY_STATE, embedded: 2, pending: 2 });
    const rows = await engine.listEmbeddingStateRows({ states: ['embedded', 'pending'], limit: 10, purgeWindowHours: 72 });
    expect(rows.map(r => [r.slug, r.state])).toEqual([['notes/acme-example', 'embedded'], ['notes/alice-example', 'pending']]);
  });

  test('sourceIds scopes every count', async () => {
    await seedEveryState();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('src-b','src-b') ON CONFLICT DO NOTHING");
    await chunks(await page('notes/other-source', { source: 'src-b' }), [{}, {}, {}]);
    expect((await readEmbeddingState(engine, { mode: 'full' })).counts.pending).toBe(5);
    expect((await readEmbeddingState(engine, { mode: 'full', sourceIds: ['default'] })).counts).toEqual(EVERY_STATE);
    const b = await readEmbeddingState(engine, { mode: 'full', sourceIds: ['src-b'] });
    expect(b.counts).toEqual({ embedded: 0, pending: 3, keyword_only: 0, quarantined: 0, empty: 0, deleted_page_chunks: 0, chunkless_healable: 0 });
    expect((await readEmbeddingState(engine, { mode: 'ops', sourceIds: ['src-b'] })).counts.pending).toBe(3);
  });

  test('a brain keyless by choice does not count pending as unsearchable', async () => {
    await seedEveryState();
    await engine.setConfig('embedding_disabled', 'true');
    const s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.reason).toBe('embeddings_disabled');
    expect(s.counts.pending).toBe(2);
    expect(s.unsearchable).toBe(3 + 1 + 1);
  });
});

describe('embedding state classifier (ops mode)', () => {
  test('index-backed counts on the legacy column: exact gated states, estimated embedded, anti-join states omitted', async () => {
    await seedEveryState();
    const s = await readEmbeddingState(engine, { mode: 'ops' });
    expect(s.status).toBe('known');
    expect(s.basis).toBe('estimated');
    expect(s.covering_index).toBe('content_chunks_stale_idx');
    expect(s.counts).toMatchObject({ pending: 2, keyword_only: 2, quarantined: 3, deleted_page_chunks: 3 });
    expect(s.counts.empty).toBeUndefined();
    expect(s.counts.chunkless_healable).toBeUndefined();
    expect(typeof s.counts.embedded).toBe('number');
    expect(s.omitted_states).toEqual(['empty', 'chunkless_healable']);
    expect(s.unsearchable).toBe(2 + 3);
    expect(s.unsearchable_complete).toBe(false);
    expect(s.deleted_page_chunks).toMatchObject({ within_window: 1, past_window: 2 });
  });

  test('a custom active column without a covering partial index is unknown, never scanned; the index makes it known', async () => {
    await seedEveryState();
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_reg8 vector(8)');
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding_reg8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' } }));
    await engine.setConfig('search_embedding_column', 'embedding_reg8');
    const unknown = await readEmbeddingState(engine, { mode: 'ops' });
    expect(unknown).toMatchObject({ status: 'unknown', basis: 'unknown', reason: 'no_covering_index', active_column: 'embedding_reg8', counts: {}, unsearchable: null });
    await engine.executeRaw('CREATE INDEX content_chunks_reg8_stale_idx ON content_chunks(page_id, chunk_index) WHERE embedding_reg8 IS NULL');
    try {
      const known = await readEmbeddingState(engine, { mode: 'ops' });
      expect(known.status).toBe('known');
      expect(known.covering_index).toBe('content_chunks_reg8_stale_idx');
      expect(known.counts.pending).toBe(4);
    } finally {
      await engine.executeRaw('DROP INDEX content_chunks_reg8_stale_idx');
    }
  });
});

describe('embedding state rows and fixes', () => {
  test('rows per (page, state) with reason inputs, bytes and limit', async () => {
    await seedEveryState();
    const rows = await engine.listEmbeddingStateRows({ states: ['keyword_only', 'quarantined', 'empty', 'chunkless_healable', 'deleted_page_chunks'], limit: 50, purgeWindowHours: 72 });
    expect(rows.map(r => `${r.state} ${r.slug} ${r.chunks}`)).toEqual([
      'chunkless_healable notes/stub-with-body 0',
      'deleted_page_chunks notes/deleted-old 2',
      'deleted_page_chunks notes/deleted-recent 1',
      'empty notes/empty-stub 0',
      'keyword_only notes/fund-a-oversized 1',
      'keyword_only notes/fund-a-oversized-bare 0',
      'quarantined notes/junk-hidden 0',
      'quarantined notes/junk-legacy 2',
    ]);
    const old = rows.find(r => r.slug === 'notes/deleted-old')!;
    expect(old.overdue).toBe(true);
    expect(old.deleted_at).toBeInstanceOf(Date);
    expect(rows.find(r => r.slug === 'notes/deleted-recent')!.overdue).toBe(false);
    expect(rows.find(r => r.slug === 'notes/fund-a-oversized')).toMatchObject({ embed_skip_reason: 'oversized', marker_bytes: 600_000 });
    expect(rows.find(r => r.slug === 'notes/junk-hidden')!.quarantine_reason).toBe('junk_pattern');
    expect(rows.find(r => r.slug === 'notes/stub-with-body')!.bytes).toBe('notes/stub-with-body body'.length);
    expect(await engine.listEmbeddingStateRows({ states: ['quarantined'], limit: 1, purgeWindowHours: 72 })).toHaveLength(1);
  });

  test('every state but embedded has a protocol fix with a read-only verify and the docs anchor', () => {
    for (const state of EMBEDDING_STATES) {
      const fix = embeddingStateFix(state, { sourceId: 'default', slug: 'notes/alice-example', markerBytes: 600_000, embeddingsEnabled: true });
      if (state === 'embedded') { expect(fix).toBeNull(); continue; }
      expect(fix, state).not.toBeNull();
      expect(fix!.argv?.[0]).toBe('gbrain');
      expect(Array.isArray(fix!.consent)).toBe(true);
      expect(typeof fix!.why).toBe('string');
      expect(fix!.requires_exclusive).toBe(false);
      expect(fix!.docs).toBe('docs/guides/troubleshooting.md#embedding-state');
      expect(fix!.verify?.argv).toEqual(['gbrain', 'pages', 'unsearchable', '--source', 'default', '--state', state, '--json']);
    }
    expect(embeddingStateFix('keyword_only', { sourceId: 'default', markerBytes: 600_000, embeddingsEnabled: true })).toMatchObject({
      ask_user: true, argv: ['gbrain', 'config', 'set', 'content_sanity.bytes_block', '600001'], then: { argv: ['gbrain', 'sync', '--source', 'default', '--full'] } });
    expect(embeddingStateFix('deleted_page_chunks', { sourceId: 'default', embeddingsEnabled: true })).toMatchObject({
      argv: ['gbrain', 'pages', 'purge-deleted', '--yes'], preview_argv: ['gbrain', 'pages', 'purge-deleted', '--dry-run', '--json'], consent: ['destructive'] });
  });
});
