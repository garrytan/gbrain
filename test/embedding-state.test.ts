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

// #7174: notes/fund-a-oversized-bare (embed_skip, body, no chunk rows) is chunkless_healable: writes keep an embed_skip page's chunks (#6722).
const EVERY_STATE = { embedded: 2, pending: 2, keyword_only: 1, quarantined: 3, empty: 1, deleted_page_chunks: 3, chunkless_healable: 2 };

describe('embedding state classifier (full mode)', () => {
  test('every state on the legacy column, exact', async () => {
    await seedEveryState();
    const s = await readEmbeddingState(engine, { mode: 'full' });
    expect(s.status).toBe('known');
    expect(s.basis).toBe('exact');
    expect(s.active_column).toBe('embedding');
    expect(s.counts).toEqual(EVERY_STATE);
    expect(Object.keys(s.counts).sort()).toEqual([...EMBEDDING_STATES].sort());
    expect(s.unsearchable).toBe(2 + 3 + 1 + 2);
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
    expect(s.unsearchable).toBe(3 + 1 + 2);
  });
});

describe('embedding state classifier (ops mode)', () => {
  test('index-backed counts on the legacy column: exact gated states, estimated embedded, anti-join states omitted', async () => {
    await seedEveryState();
    const s = await readEmbeddingState(engine, { mode: 'ops' });
    expect(s.status).toBe('known');
    expect(s.basis).toBe('estimated');
    expect(s.covering_index).toBe('content_chunks_stale_idx');
    expect(s.counts).toMatchObject({ pending: 2, keyword_only: 1, quarantined: 3, deleted_page_chunks: 3 });
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
      'chunkless_healable notes/fund-a-oversized-bare 0',
      'chunkless_healable notes/stub-with-body 0',
      'deleted_page_chunks notes/deleted-old 2',
      'deleted_page_chunks notes/deleted-recent 1',
      'empty notes/empty-stub 0',
      'keyword_only notes/fund-a-oversized 1',
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

/**
 * Protects stored protected content from false healing and deletion advice while
 * keeping lost public prose detectable. Raw-body classification, filtering after
 * LIMIT, or a state-only fix recommendation breaks these cases. The nine cases
 * above do not classify protected-only cold pages or their command advice.
 * Existing engine and command APIs suffice. No production seam is required.
 * Cold rows and withdrawal ledger entries below are synthetic legacy fixtures.
 */
import { spyOn } from 'bun:test';
import type { Action, RenderedAction } from '../src/core/agent-output.ts';
import type { EmbeddingState } from '../src/core/embedding-state.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { readPagesStatus } from '../src/commands/pages-status.ts';
import { runPagesUnsearchable } from '../src/commands/pages-unsearchable.ts';

const COLD_TAKE_BEGIN = '<!--- gbrain:takes:begin -->';
const COLD_TAKE_END = '<!--- gbrain:takes:end -->';
const COLD_TAKE_TABLE = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | Protectedsentinel prefers the synthetic plan | take | brain | 0.7 | 2026-01 | chat |';
const COLD_TAKES = `${COLD_TAKE_BEGIN}\n${COLD_TAKE_TABLE}\n${COLD_TAKE_END}\n`;
const COLD_FACT_HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const coldFact = (n: number, claim: string, visibility: 'private' | 'world') =>
  `| ${n} | ${claim} | fact | 1.0 | ${visibility} | medium | 2026-01-01 |  | chat |  |`;
const coldFacts = (...rows: string[]) => `<!--- gbrain:facts:begin -->\n\n${COLD_FACT_HEADER}\n${rows.join('\n')}\n<!--- gbrain:facts:end -->\n`;

async function coldPage(slug: string, body: string, timeline = '', source = 'default'): Promise<number> {
  const id = await page(slug, { body: '', source });
  await engine.executeRaw('UPDATE pages SET compiled_truth=$2, timeline=$3 WHERE id=$1', [id, body, timeline]);
  return id;
}

async function coldInventory() {
  return engine.executeRaw<{ source_id: string; slug: string; compiled_truth: string | null; timeline: string | null; body_storage: string; body_bytes: number | null; chunks: number }>(
    `SELECT p.source_id,p.slug,p.compiled_truth,p.timeline,p.body_storage,p.body_bytes,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
     FROM pages p ORDER BY p.source_id,p.slug`);
}

async function coldRows(states: readonly EmbeddingState[], limit = 100, sourceIds?: string[]) {
  return engine.listEmbeddingStateRows({ states, limit, sourceIds, purgeWindowHours: 72 });
}

function projectionObservation(name: string, observed: unknown): void {
  console.info(`embedding-projection-observation ${JSON.stringify({ case: name, observed })}`);
}

function expectNoHealingOrDeletion(fix: Action | RenderedAction | null): void {
  if (!fix) return;
  expect(fix.consent).not.toContain('destructive');
  expect(fix.consent).not.toContain('paid');
  expect(fix.argv?.[1]).not.toBe('embed');
  expect(fix.argv?.[1]).not.toBe('delete');
  expect(fix.argv?.slice(1, 3)).not.toEqual(['pages', 'purge-deleted']);
  if (fix.then) expectNoHealingOrDeletion(fix.then);
}

interface ColdListing {
  rows: Array<{ slug: string; source_id: string; state: EmbeddingState; reason: string; chunks: number; fix: RenderedAction | null }>;
  limit: number;
  complete: boolean;
}

async function coldListing(): Promise<ColdListing> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await runPagesUnsearchable(engine, ['--source', 'default', '--limit', '100', '--json']);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(lines.join('\n')) as ColdListing;
}

const stateIdentity = (rows: Awaited<ReturnType<typeof coldRows>>) => rows.map(r => [r.source_id, r.slug, r.state, r.chunks]);

describe('cold ordinary-projection classification', () => {
  test('closed takes-only content is empty, while lost public prose remains healable', async () => {
    await coldPage('notes/protected-only', COLD_TAKES);
    const before = await coldInventory();
    const projected = await prepareMarkdownChunks({ compiled_truth: COLD_TAKES });
    const candidateCount = await engine.countChunklessPagesWithContent();
    const protectedSummary = await readEmbeddingState(engine, { mode: 'full' });
    const protectedRows = await coldRows(['empty', 'chunkless_healable']);
    const after = await coldInventory();
    await coldPage('notes/lost-prose', 'Publicsentinel describes an ordinary missing paragraph.');
    const controlRows = await coldRows(['chunkless_healable']);
    projectionObservation('closed-takes', { projected: projected.length, candidateCount, counts: protectedSummary.counts,
      rows: stateIdentity(protectedRows), controls: stateIdentity(controlRows), before, after });
    expect(projected).toHaveLength(0);
    expect(candidateCount).toBe(1);
    expect(controlRows.find(r => r.slug === 'notes/lost-prose')).toMatchObject({ state: 'chunkless_healable', chunks: 0 });
    expect(protectedSummary.counts).toMatchObject({ empty: 1, chunkless_healable: 0 });
    expect(stateIdentity(protectedRows)).toEqual([['default', 'notes/protected-only', 'empty', 0]]);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ compiled_truth: COLD_TAKES, chunks: 0 });
  });

  test('private facts stay excluded from the healable nonzero projected shell, and withdrawn world fences keep their observed nonzero shell', async () => {
    const privateBody = coldFacts(coldFact(1, 'Privatefactsentinel holds a synthetic preference', 'private'));
    const worldClaims = ['Worldsentinel ships synthetic widgets', 'Worldsentinel maintains a public catalogue'];
    const worldBody = coldFacts(...worldClaims.map((claim, i) => coldFact(i + 1, claim, 'world')));
    await coldPage('notes/private-only', privateBody);
    await coldPage('notes/world-control', worldBody);
    await coldPage('notes/mixed-private-control', `Ordinary public paragraph.\n${privateBody}`);
    const before = await coldInventory();
    const privateProjection = await prepareMarkdownChunks({ compiled_truth: privateBody });
    const worldProjection = await prepareMarkdownChunks({ compiled_truth: worldBody });
    const initialSnapshot = await readProjectionSnapshot(engine, 'notes/world-control', 'default', { allowUnsealed: true });
    expect(initialSnapshot).not.toBeNull();
    const initialProjection = await preparePageProjection(initialSnapshot!);
    for (const claim of worldClaims) {
      await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
        VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [claim]);
    }
    const withdrawnSnapshot = await readProjectionSnapshot(engine, 'notes/world-control', 'default', { allowUnsealed: true });
    expect(withdrawnSnapshot).not.toBeNull();
    const withdrawnProjection = await preparePageProjection(withdrawnSnapshot!);
    const rawAfter = await prepareMarkdownChunks({ compiled_truth: worldBody });
    const rows = await coldRows(['empty', 'chunkless_healable']);
    const summary = await readEmbeddingState(engine, { mode: 'full' });
    const after = await coldInventory();
    const [withdrawals] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals');
    projectionObservation('private-facts', { privateChunks: privateProjection.length, worldChunks: worldProjection.length,
      initialSnapshotChunks: initialProjection.chunks.length, withdrawnSnapshotChunks: withdrawnProjection.chunks.length,
      rawAfterChunks: rawAfter.length, withdrawals: withdrawals?.n, rows: stateIdentity(rows), counts: summary.counts, before, after });
    expect(privateProjection).toHaveLength(1);
    expect(worldProjection.map(c => c.chunk_text).join('\n')).toContain(worldClaims[0]!);
    expect(privateProjection.map(c => c.chunk_text).join('\n')).not.toContain('Privatefactsentinel');
    expect(initialProjection.chunks).toHaveLength(1);
    expect(withdrawnProjection.chunks).toHaveLength(1);
    expect(rawAfter).toHaveLength(1);
    expect(withdrawals?.n).toBe(2);
    for (const claim of worldClaims) expect(withdrawnProjection.chunks.map(c => c.chunk_text).join('\n')).not.toContain(claim);
    expect(stateIdentity(rows)).toEqual([
      ['default', 'notes/mixed-private-control', 'chunkless_healable', 0],
      ['default', 'notes/private-only', 'chunkless_healable', 0],
      ['default', 'notes/world-control', 'chunkless_healable', 0],
    ]);
    expect(summary.counts).toMatchObject({ empty: 0, chunkless_healable: 3 });
    expect(after).toEqual(before);
  });

  test('mixed public prose and takes are healable without rewriting protected bytes or installing chunks', async () => {
    const mixedBody = `Publicsentinel is ordinary prose that lost its chunks.\n\n${COLD_TAKES}`;
    await coldPage('notes/mixed-takes', mixedBody);
    await coldPage('notes/prose-control', 'Public control without a protected fence.');
    const before = await coldInventory();
    const projection = await prepareMarkdownChunks({ compiled_truth: mixedBody });
    const summary = await readEmbeddingState(engine, { mode: 'full' });
    const rows = await coldRows(['empty', 'chunkless_healable']);
    const after = await coldInventory();
    projectionObservation('mixed-takes', { projection: projection.map(c => c.chunk_text), counts: summary.counts, rows: stateIdentity(rows), before, after });
    expect(projection.map(c => c.chunk_text).join('\n')).toContain('Publicsentinel');
    expect(projection.map(c => c.chunk_text).join('\n')).not.toContain('Protectedsentinel');
    expect(stateIdentity(rows)).toEqual([
      ['default', 'notes/mixed-takes', 'chunkless_healable', 0],
      ['default', 'notes/prose-control', 'chunkless_healable', 0],
    ]);
    expect(summary.counts).toMatchObject({ empty: 0, chunkless_healable: 2 });
    expect(after).toEqual(before);
  });

  test('timeline-only takes and whitespace are empty, but timeline-only ordinary prose is healable', async () => {
    await coldPage('notes/timeline-takes', '', COLD_TAKES);
    await coldPage('notes/timeline-prose', '', 'Timelinepublicsentinel records an ordinary event.');
    await coldPage('notes/whitespace', ' \t\n ', '\n\t');
    await coldPage('notes/blank-stub', '');
    const before = await coldInventory();
    const protectedProjection = await prepareMarkdownChunks({ compiled_truth: '', timeline: COLD_TAKES });
    const controlProjection = await prepareMarkdownChunks({ compiled_truth: '', timeline: 'Timelinepublicsentinel records an ordinary event.' });
    const rows = await coldRows(['empty', 'chunkless_healable']);
    const summary = await readEmbeddingState(engine, { mode: 'full' });
    const after = await coldInventory();
    projectionObservation('timeline', { protectedChunks: protectedProjection.length, controlChunks: controlProjection.length,
      counts: summary.counts, rows: stateIdentity(rows), before, after });
    expect(protectedProjection).toHaveLength(0);
    expect(controlProjection.map(c => c.chunk_text).join('\n')).toContain('Timelinepublicsentinel');
    expect(stateIdentity(rows)).toEqual([
      ['default', 'notes/timeline-prose', 'chunkless_healable', 0],
      ['default', 'notes/blank-stub', 'empty', 0],
      ['default', 'notes/timeline-takes', 'empty', 0],
      ['default', 'notes/whitespace', 'empty', 0],
    ]);
    expect(summary.counts).toMatchObject({ empty: 3, chunkless_healable: 1 });
    expect(after).toEqual(before);
  });

  test('projection classification is source-specific and preserves quarantine, embed_skip, deletion and unsearchable units', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('src-b','src-b')");
    await coldPage('notes/shared', COLD_TAKES);
    await coldPage('notes/shared', 'Public prose in another source.', '', 'src-b');
    await page('notes/quarantined', { body: COLD_TAKES, frontmatter: { quarantine: { reason: 'junk_pattern' } } });
    await page('notes/embed-skipped', { body: 'Ordinary lost prose retains keyword eligibility.', frontmatter: { embed_skip: { reason: 'oversized', bytes: 700_000 } } });
    await page('notes/deleted-protected', { body: COLD_TAKES, deletedHoursAgo: 1 });
    await page('notes/deleted-prose', { deletedHoursAgo: 1 });
    const before = await coldInventory();
    const a = await readEmbeddingState(engine, { mode: 'full', sourceIds: ['default'] });
    const b = await readEmbeddingState(engine, { mode: 'full', sourceIds: ['src-b'] });
    const all = await readEmbeddingState(engine, { mode: 'full' });
    const rows = await coldRows(['empty', 'chunkless_healable', 'quarantined', 'deleted_page_chunks']);
    const aRows = await coldRows(['empty', 'chunkless_healable', 'quarantined'], 100, ['default']);
    const bRows = await coldRows(['empty', 'chunkless_healable', 'quarantined'], 100, ['src-b']);
    const after = await coldInventory();
    projectionObservation('scope-and-markers', { a: a.counts, b: b.counts, all: all.counts, unsearchable: all.unsearchable,
      rows: stateIdentity(rows), aRows: stateIdentity(aRows), bRows: stateIdentity(bRows), before, after });
    expect(stateIdentity(bRows)).toEqual([['src-b', 'notes/shared', 'chunkless_healable', 0]]);
    expect(stateIdentity(aRows)).toEqual([
      ['default', 'notes/embed-skipped', 'chunkless_healable', 0],
      ['default', 'notes/shared', 'empty', 0],
      ['default', 'notes/quarantined', 'quarantined', 0],
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.some(r => r.slug.startsWith('notes/deleted-'))).toBe(false);
    expect(a.counts).toMatchObject({ empty: 1, chunkless_healable: 1, quarantined: 1 });
    expect(b.counts).toMatchObject({ empty: 0, chunkless_healable: 1, quarantined: 0 });
    expect(all.counts).toMatchObject({ empty: 1, chunkless_healable: 2, quarantined: 1, deleted_page_chunks: 0 });
    expect(all.unsearchable).toBe(4);
    expect(after).toEqual(before);
  });

  test('more than fifty projection-empty candidates cannot consume a requested eligible-row limit', async () => {
    const protectedSlugs = Array.from({ length: 55 }, (_, i) => `aaa/protected-${String(i).padStart(2, '0')}`);
    for (const slug of protectedSlugs) await coldPage(slug, COLD_TAKES);
    for (const slug of ['zzz/lost-c', 'zzz/lost-a', 'zzz/lost-b']) await coldPage(slug, 'Ordinary later prose lost its chunks.');
    const before = await coldInventory();
    const limited = await coldRows(['chunkless_healable'], 2);
    const emptyOne = await coldRows(['empty'], 1);
    const allRows = await coldRows(['empty', 'chunkless_healable'], 58);
    const after = await coldInventory();
    projectionObservation('eligible-limit', { requestedLimit: 2, protectedCandidates: protectedSlugs.length,
      limited: stateIdentity(limited), emptyOne: stateIdentity(emptyOne), all: stateIdentity(allRows), unchanged: JSON.stringify(after) === JSON.stringify(before) });
    expect(limited.map(r => r.slug)).toEqual(['zzz/lost-a', 'zzz/lost-b']);
    expect(limited).toHaveLength(2);
    expect(stateIdentity(emptyOne)).toEqual([['default', 'aaa/protected-00', 'empty', 0]]);
    expect(stateIdentity(allRows)).toEqual([
      ...['zzz/lost-a', 'zzz/lost-b', 'zzz/lost-c'].map(slug => ['default', slug, 'chunkless_healable', 0]),
      ...protectedSlugs.map(slug => ['default', slug, 'empty', 0]),
    ]);
    expect(after).toEqual(before);
  }, 60_000);

  test('page status and unsearchable commands do not recommend embedding or deleting protected-only content', async () => {
    await engine.setConfig('embedding_disabled', 'false');
    await coldPage('notes/protected-advice', COLD_TAKES);
    await coldPage('notes/blank-advice', '');
    await coldPage('notes/prose-advice', 'Ordinary lost public prose.');
    const before = await coldInventory();
    const status = await readPagesStatus(engine, 'default', ['notes/protected-advice', 'notes/blank-advice', 'notes/prose-advice']);
    const listing = await coldListing();
    const after = await coldInventory();
    projectionObservation('command-advice', { status, listing, before, after });
    const protectedStatus = status.pages.find(p => p.slug === 'notes/protected-advice')!;
    const blankStatus = status.pages.find(p => p.slug === 'notes/blank-advice')!;
    const proseStatus = status.pages.find(p => p.slug === 'notes/prose-advice')!;
    expect(blankStatus.state).toBe('empty');
    expect(blankStatus.fix).toMatchObject({ ask_user: true, consent: ['destructive'] });
    expect(blankStatus.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'delete', 'notes/blank-advice']);
    expect(proseStatus.state).toBe('chunkless');
    expect(proseStatus.fix?.argv?.[1]).toBe('embed');
    expect(protectedStatus.state).toBe('empty');
    expect(protectedStatus.searchable).toBe(false);
    expect(protectedStatus.why).not.toContain('has no body text');
    expect(protectedStatus.why).toMatch(/protect|take|fact|projection|indexable/i);
    expectNoHealingOrDeletion(protectedStatus.fix);
    const protectedRow = listing.rows.find(r => r.slug === 'notes/protected-advice')!;
    const blankRow = listing.rows.find(r => r.slug === 'notes/blank-advice')!;
    const proseRow = listing.rows.find(r => r.slug === 'notes/prose-advice')!;
    expect(blankRow.fix?.argv?.[1]).toBe('delete');
    expect(blankRow.fix?.next).toBe('ask_user');
    expect(proseRow.fix?.argv?.[1]).toBe('embed');
    expect(protectedRow.state).toBe('empty');
    expect(protectedRow.reason).not.toBe('no_chunk_rows');
    expect(`${protectedRow.reason} ${protectedRow.fix?.why ?? ''}`).toMatch(/protect|take|fact|projection|indexable/i);
    expectNoHealingOrDeletion(protectedRow.fix);
    expect(listing.complete).toBe(true);
    expect(after).toEqual(before);
  });

  test('legacy unpaired markers stay non-exposing and non-destructive while segmented pages keep their raw classifier path', async () => {
    const unpaired = `${COLD_TAKE_BEGIN}\n${COLD_TAKE_TABLE}\n`;
    await coldPage('notes/legacy-unpaired', unpaired);
    await coldPage('notes/legacy-prose-control', `Publicprefixsentinel precedes an unpaired marker.\n${unpaired}`);
    const segmentedId = await coldPage('notes/segmented-control', 'Synthetic segmented precondition.');
    await engine.executeRaw(`UPDATE pages SET body_storage='segmented',compiled_truth=NULL,timeline=NULL,body_bytes=128,body_generation=1 WHERE id=$1`, [segmentedId]);
    const before = await coldInventory();
    const emptyProjection = await prepareMarkdownChunks({ compiled_truth: unpaired });
    const controlProjection = await prepareMarkdownChunks({ compiled_truth: `Publicprefixsentinel precedes an unpaired marker.\n${unpaired}` });
    const bodyAttempts: string[] = [];
    const originalSnapshot = engine.readPageSnapshot.bind(engine);
    const snapshotSpy = spyOn(engine, 'readPageSnapshot').mockImplementation(async (slug, opts) => {
      if (slug === 'notes/segmented-control') { bodyAttempts.push(slug); throw new Error('Classifier must not materialize a segmented body'); }
      return originalSnapshot(slug, opts);
    });
    const originalGet = engine.getPage.bind(engine);
    const getSpy = spyOn(engine, 'getPage').mockImplementation(async (slug, opts) => {
      if (slug === 'notes/segmented-control') { bodyAttempts.push(slug); throw new Error('Classifier must not materialize a segmented body'); }
      return originalGet(slug, opts);
    });
    let rows: Awaited<ReturnType<typeof coldRows>>;
    let summary: Awaited<ReturnType<typeof readEmbeddingState>>;
    let status: Awaited<ReturnType<typeof readPagesStatus>>;
    let listing: ColdListing;
    try {
      rows = await coldRows(['empty', 'chunkless_healable']);
      summary = await readEmbeddingState(engine, { mode: 'full' });
      status = await readPagesStatus(engine, 'default', ['notes/legacy-unpaired', 'notes/legacy-prose-control']);
      listing = await coldListing();
    } finally {
      snapshotSpy.mockRestore();
      getSpy.mockRestore();
    }
    const after = await coldInventory();
    projectionObservation('legacy-and-segmented', { emptyChunks: emptyProjection.length, control: controlProjection.map(c => c.chunk_text),
      rows: stateIdentity(rows), counts: summary.counts, status, listing, bodyAttempts, before, after });
    expect(emptyProjection).toHaveLength(0);
    expect(controlProjection.map(c => c.chunk_text).join('\n')).toContain('Publicprefixsentinel');
    expect(controlProjection.map(c => c.chunk_text).join('\n')).not.toContain('Protectedsentinel');
    expect(stateIdentity(rows)).toEqual([
      ['default', 'notes/legacy-prose-control', 'chunkless_healable', 0],
      ['default', 'notes/segmented-control', 'chunkless_healable', 0],
      ['default', 'notes/legacy-unpaired', 'empty', 0],
    ]);
    expect(summary.counts).toMatchObject({ empty: 1, chunkless_healable: 2 });
    expect(status.pages.find(p => p.slug === 'notes/legacy-prose-control')?.state).toBe('chunkless');
    const protectedStatus = status.pages.find(p => p.slug === 'notes/legacy-unpaired')!;
    expect(protectedStatus.state).toBe('empty');
    expectNoHealingOrDeletion(protectedStatus.fix);
    const protectedRow = listing.rows.find(r => r.slug === 'notes/legacy-unpaired')!;
    expect(protectedRow.state).toBe('empty');
    expectNoHealingOrDeletion(protectedRow.fix);
    expect(bodyAttempts).toEqual([]);
    expect(after).toEqual(before);
  });
});
