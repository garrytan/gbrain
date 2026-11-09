/**
 * Wave C 1F: a real append_page to a capped segmented page embeds the appended text under the tail allowance
 * (spec §6.2, decision G6).
 *
 * 1. Protects: the append's embedding effect carries the occurrences the write added (`occurrence_ids`), so the
 *    effect embeds only those, granted from `embed.page_tail_usd_per_day` once the per-page cap leaves them out, and
 *    books the tail spend in the 24-hour ledger.
 * 2. Fails when: the publication queues the append's embedding effect without its occurrences (the effect then runs
 *    without the tail allowance and the capped page's new text stays keyword-only), or the tail embeds the backlog.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The append brain's fake embedder records every text it
 *    is asked to embed; no paid call is made.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationPage } from '../helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { pageTailSpend24h } from '../../src/core/embedding-ledger.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';

const SLUG = 'notes/tail-append';
const TEXT = 'A note appended today about the heron colony on the north marsh, counted at dawn with the tide low.';

for (const kind of testBackends()) {
  describe(`a segmented append embeds under the tail allowance (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.seed(SLUG, conversationPage(1_200_000, { seed: 21 }));
      expect((await brain.body(SLUG)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('the effect carries the appended occurrences and embeds only them from the tail allowance', async () => {
      const engine = brain.engine;
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]);
      await runEmbedCore(engine, { stale: true, quiet: true } as never);
      const column = (await resolveActiveEmbeddingColumnFromEngine(engine)).name;
      const [left] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND "${column}" IS NULL`, [page!.id]);
      expect(Number(left!.n)).toBe(0);
      // The page then reaches its cap: everything it had is embedded, and nothing more fits under it.
      await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason, spent_usd, cap_usd) VALUES ($1, 'capped', 'cap_reached', 2, 2)
        ON CONFLICT (page_id) DO UPDATE SET state = 'capped', reason = 'cap_reached', spent_usd = 2, cap_usd = 2`, [page!.id]);
      brain.embedded.length = 0;
      expect(await brain.call('append_page', { slug: SLUG, text: TEXT, request_id: randomUUID() })).toMatchObject({ isError: false });

      const [effect] = await engine.executeRaw<{ id: number; data: { occurrence_ids?: number[] } }>(
        "SELECT id, data FROM persistence_effects WHERE kind = 'embedding' AND data->>'slug' = $1 ORDER BY id DESC LIMIT 1", [SLUG]);
      expect(effect!.data.occurrence_ids?.length ?? 0).toBeGreaterThan(0);
      const live = await engine.executeRaw<{ occurrence_id: string }>(
        `SELECT m.occurrence_id::text FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
          WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from = p.body_generation`, [page!.id]);
      expect([...effect!.data.occurrence_ids!].map(Number).sort()).toEqual(live.map(row => Number(row.occurrence_id)).sort());

      // The brain's own persistence consumer may hold the effect (state 'running') while it embeds, so wait for it to settle.
      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        const [state] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id = $1', [effect!.id]);
        if (state!.state === 'committed') break;
        if (state!.state === 'running') { await Bun.sleep(100); continue; }
        await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at = now() WHERE id = $1', [effect!.id]);
        await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
      }
      const [done] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id = $1', [effect!.id]);
      expect(done!.state).toBe('committed');
      expect(brain.embedded.some(text => text.includes(TEXT.slice(-40)))).toBe(true);
      // The tail embeds the append's own chunks, never the capped backlog.
      expect(brain.embedded.length).toBeGreaterThan(0);
      expect(brain.embedded.length).toBeLessThanOrEqual(8);
      expect(await pageTailSpend24h(engine, page!.id)).toBeGreaterThan(0);
    }, 600_000);
  });
}
