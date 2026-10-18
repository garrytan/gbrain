/**
 * PR 2 fix lane W (GBRA-117): the held count and the held list agree.
 *
 * 1. Protects: `readBudgetLimited` (doctor `partial_embedding`, `gbrain embed
 *    --stale`, the embed-backfill job) and `listBudgetLimitedPages` (`gbrain
 *    embed --held`) apply one rule for when a held or capped budget row still
 *    applies: its page is above the inline bound (budgetRowAppliesFilter). Rows
 *    on large inline and segmented pages count; rows on pages that shrank to
 *    the bound or under (inline, still segmented inside the demotion
 *    hysteresis, or demoted) and on pages exactly at the bound do not. The
 *    size check reads only TOAST size headers, never a page body (the work
 *    count below). The list still includes embed_skip pages and pages with no
 *    pending chunks, which the count leaves out; the fixture has neither.
 * 2. Fails when: either side applies a held row the other skips, so doctor
 *    reports held pages `gbrain embed --held` cannot list, or the reverse.
 * 3. Why existing coverage misses it: held-budget-shrink.test.ts checks the
 *    list and the stale queue only, and the budget tests hold pages that stay
 *    large.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { holdPageEmbedding, listBudgetLimitedPages } from '../../src/core/page-embedding-budget.ts';
import { readBudgetLimited } from '../../src/core/held-embedding.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-held-budget-count-list-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines = new Map<string, BrainEngine>();
let closePostgres: (() => Promise<void>) | undefined;

const note = (bytes: number, seed: number) => `---\ntype: note\ntitle: Held note\n---\n\n${conversationBody(bytes, { seed })}\n`;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.set('pglite', lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.set('postgres', pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines.values()) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function pageRow(engine: BrainEngine, sourceId: string) {
  const [row] = await engine.executeRaw<{ id: number; body_storage: string; bytes: string }>(
    `SELECT id, body_storage, (CASE WHEN body_storage='segmented' THEN body_bytes ELSE octet_length(compiled_truth)+octet_length(COALESCE(timeline,'')) END)::text AS bytes
      FROM pages WHERE source_id=$1 AND slug='notes/held'`, [sourceId]);
  return { id: Number(row!.id), body_storage: row!.body_storage, bytes: Number(row!.bytes) };
}

/** An inline page of exactly `bytes` body bytes with two chunks and no vectors. */
async function inlinePage(engine: BrainEngine, sourceId: string, bytes: number): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
    VALUES ('notes/held', $1, 'note', 'Held note', repeat('x', $2::int), '', '{}', md5($1), now(), now()) RETURNING id`, [sourceId, bytes]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES ($1, 0, 'acme-example notes'), ($1, 1, 'alice-example notes')`, [row!.id]);
  return Number(row!.id);
}

/** A page imported above the bound (segmented when `segmented`), then re-imported at `small` bytes when given. */
async function importedPage(engine: BrainEngine, sourceId: string, segmented: boolean, small?: number): Promise<number> {
  await engine.setConfig('pages.segmented_storage', segmented ? 'on' : 'off');
  expect(await importFromContent(engine, 'notes/held', note(1_200_000, 41), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  const before = await pageRow(engine, sourceId);
  expect(before.body_storage).toBe(segmented ? 'segmented' : 'inline');
  expect(before.bytes).toBeGreaterThan(PAGE_INLINE_MAX_BYTES);
  if (small !== undefined) expect(await importFromContent(engine, 'notes/held', note(small, 42), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  return before.id;
}

const BOUND = PAGE_INLINE_MAX_BYTES;
const cases: Array<{ name: string; counts: boolean; state: 'held' | 'capped'; storage: 'inline' | 'segmented'; bytes: (b: number) => boolean;
  make: (engine: BrainEngine, sourceId: string) => Promise<number> }> = [
  { name: 'inline-large', counts: true, state: 'held', storage: 'inline', bytes: b => b === BOUND + 1, make: (e, s) => inlinePage(e, s, BOUND + 1) },
  { name: 'inline-large-capped', counts: true, state: 'capped', storage: 'inline', bytes: b => b === 2 * BOUND, make: (e, s) => inlinePage(e, s, 2 * BOUND) },
  { name: 'segmented-large', counts: true, state: 'held', storage: 'segmented', bytes: b => b > BOUND, make: (e, s) => importedPage(e, s, true) },
  { name: 'inline-at-bound', counts: false, state: 'held', storage: 'inline', bytes: b => b === BOUND, make: (e, s) => inlinePage(e, s, BOUND) },
  { name: 'segmented-at-bound', counts: false, state: 'held', storage: 'segmented', bytes: b => b === BOUND, make: async (e, s) => {
    const id = await importedPage(e, s, true);
    await e.executeRaw('UPDATE pages SET body_bytes = $2 WHERE id = $1', [id, BOUND]);
    return id;
  } },
  { name: 'inline-shrank', counts: false, state: 'held', storage: 'inline', bytes: b => b <= BOUND, make: (e, s) => importedPage(e, s, false, 200_000) },
  { name: 'segmented-shrank-still-segmented', counts: false, state: 'held', storage: 'segmented', bytes: b => b <= BOUND, make: (e, s) => importedPage(e, s, true, 800_000) },
  { name: 'segmented-shrank-demoted', counts: false, state: 'capped', storage: 'inline', bytes: b => b <= BOUND, make: (e, s) => importedPage(e, s, true, 200_000) },
];

describe('the held count matches the held list', () => {
  for (const kind of ['pglite', 'postgres']) {
    test.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`${kind}: large, shrunk and at-bound pages: count === list.length with the same members`, async () => withEnv(env, async () => {
      const engine = engines.get(kind)!;
      for (const c of cases) {
        await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [c.name]);
        const id = await c.make(engine, c.name);
        if (c.state === 'held') await holdPageEmbedding(engine, id, 'awaiting_approval');
        else await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'capped', 'cap_reached')`, [id]);
        const row = await pageRow(engine, c.name);
        expect({ kind, name: c.name, id: row.id, storage: row.body_storage, bytes: c.bytes(row.bytes) }).toEqual({ kind, name: c.name, id, storage: c.storage, bytes: true });
        const [pending] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND embedding IS NULL', [id]);
        expect(Number(pending!.n)).toBeGreaterThan(0);
      }

      const expected = cases.filter(c => c.counts).map(c => c.name).sort();
      const list = await listBudgetLimitedPages(engine, { limit: null });
      const count = await readBudgetLimited(engine);
      expect({ kind, list: list.map(p => p.source_id).sort() }).toEqual({ kind, list: expected });
      expect({ kind, count: count.by_source.map(s => s.source_id).sort() }).toEqual({ kind, count: expected });
      expect({ kind, count: count.held + count.capped }).toEqual({ kind, count: list.length });
      expect({ kind, held: count.held, capped: count.capped }).toEqual({ kind,
        held: list.filter(p => p.state === 'held').length, capped: list.filter(p => p.state === 'capped').length });
      expect({ kind, pending: count.pending_chunks }).toEqual({ kind, pending: list.reduce((n, p) => n + p.pending_chunks, 0) });
    }), 600_000);
  }
  for (const kind of ['pglite', 'postgres']) {
    test.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`${kind}: the count's size check reads no page body (zero TOAST blocks; a detoasting read of the same page is the control)`, async () => withEnv(env, async () => {
      const engine = engines.get(kind)!;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('work-count','work-count','{}')");
      const id = await inlinePage(engine, 'work-count', 2 * BOUND);
      await holdPageEmbedding(engine, id, 'awaiting_approval');
      const blocks = async (tx: BrainEngine) => Number((await tx.executeRaw<{ n: number }>(
        `SELECT pg_stat_get_xact_blocks_fetched(reltoastrelid)::int AS n FROM pg_class WHERE relname = 'pages'`))[0]!.n);
      const work = await engine.transaction(async tx => {
        const before = await blocks(tx);
        const count = await readBudgetLimited(tx, { sourceId: 'work-count' });
        const counted = await blocks(tx);
        await tx.executeRaw('SELECT length(md5(compiled_truth)) FROM pages WHERE id = $1', [id]);
        return { held: count.held, countBlocks: counted - before, controlBlocks: (await blocks(tx)) - counted };
      });
      expect(work).toEqual({ held: 1, countBlocks: 0, controlBlocks: work.controlBlocks });
      expect(work.controlBlocks).toBeGreaterThan(0);
    }), 120_000);
  }
});
