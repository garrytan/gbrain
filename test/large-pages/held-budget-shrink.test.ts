/**
 * PR 2 fix lane J2: a large page held (or capped) by the per-page embedding
 * budget that is edited down to the inline threshold or under embeds again.
 *
 * 1. Protects: the budget meters large pages only (planPageEmbedding treats a
 *    page at or under 1 MiB as unmetered), so a held row left on a page that
 *    shrank no longer applies: the stale-chunk queue (staleChunkWhere and the
 *    stale lists), the held lists (`gbrain embed --held`, doctor
 *    `partial_embedding`) and the write receipts' size state ignore it, and
 *    the stale sweep embeds the page's chunks. Covers an inline page shrinking
 *    inline, a segmented page shrinking within the demotion hysteresis (it
 *    stays segmented under 1 MiB) and one demoted to inline.
 * 2. Fails when: a stale held row keeps a page that is no longer large out of
 *    the embedding queue (it stays keyword-only forever) or reported as held.
 * 3. Why existing coverage misses it: the budget tests hold pages that stay
 *    large.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { embedStaleForSource } from '../../src/core/embed-stale.ts';
import { holdPageEmbedding, listBudgetLimitedPages, readPageSizeStates } from '../../src/core/page-embedding-budget.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { visibleChunks } from '../helpers/segmented-page-checks.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-held-budget-shrink-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const note = (bytes: number, seed: number) => `---\ntype: note\ntitle: Held note\n---\n\n${conversationBody(bytes, { seed })}\n`;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

/** Run the stale sweep for the source with a stand-in provider; returns how many texts it sent. */
async function sweep(engine: BrainEngine, sourceId: string): Promise<number> {
  const [column] = await engine.executeRaw<{ dims: number }>(`SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'`);
  let sent = 0;
  await embedStaleForSource(engine, sourceId, { embedFn: async (batch: string[]) => {
    sent += batch.length;
    return batch.map(() => new Float32Array(Number(column!.dims)).fill(0.1));
  } });
  return sent;
}

async function pageRow(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ id: number; body_storage: string; bytes: string }>(
    `SELECT id, body_storage, (CASE WHEN body_storage='segmented' THEN body_bytes ELSE octet_length(compiled_truth)+octet_length(COALESCE(timeline,'')) END)::text AS bytes
      FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
  return { id: Number(row!.id), body_storage: row!.body_storage, bytes: Number(row!.bytes) };
}

const cases = [
  { name: 'an inline page shrinking inline', switch: 'off', large: 1_200_000, small: 200_000, before: 'inline', after: 'inline' },
  { name: 'a segmented page shrinking under 1 MiB (it stays segmented)', switch: 'on', large: 1_200_000, small: 800_000, before: 'segmented', after: 'segmented' },
  { name: 'a segmented page demoted to inline', switch: 'on', large: 1_200_000, small: 200_000, before: 'segmented', after: 'inline' },
] as const;

describe('a held large page that shrinks under 1 MiB', () => {
  for (const c of cases) {
    test(`${c.name}: its held row no longer applies and the stale sweep embeds it`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        const sourceId = `held-${randomUUID().slice(0, 8)}`;
        const slug = 'notes/held';
        await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
        await engine.setConfig('pages.segmented_storage', c.switch);
        expect(await importFromContent(engine, slug, note(c.large, 91), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
        const large = await pageRow(engine, sourceId, slug);
        expect(large.body_storage).toBe(c.before);
        expect(large.bytes).toBeGreaterThan(1024 ** 2);
        await holdPageEmbedding(engine, large.id, 'awaiting_approval');
        expect(await sweep(engine, sourceId)).toBe(0);
        expect((await listBudgetLimitedPages(engine, { sourceId })).map(p => p.slug)).toEqual([slug]);

        expect(await importFromContent(engine, slug, note(c.small, 92), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
        const small = await pageRow(engine, sourceId, slug);
        expect(small).toMatchObject({ id: large.id, body_storage: c.after });
        expect(small.bytes).toBeLessThanOrEqual(1024 ** 2);
        expect(await engine.countStaleChunks({ sourceId })).toBeGreaterThan(0);
        expect(await sweep(engine, sourceId)).toBeGreaterThan(0);
        const chunks = await visibleChunks(engine, small.id);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every(chunk => chunk.embedded)).toBe(true);
        expect(await engine.countStaleChunks({ sourceId })).toBe(0);
        expect(await listBudgetLimitedPages(engine, { sourceId })).toEqual([]);
        expect((await readPageSizeStates(engine, sourceId, [slug])).filter(s => s.embedding === 'held')).toEqual([]);
      }
    }), 600_000);
  }
});
