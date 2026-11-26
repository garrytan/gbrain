/**
 * #10443: re-deriving a conversation page's facts used to DELETE every prior
 * extractor fact nothing referenced, so a claim the new pass did not reproduce
 * left no row behind. clearConversationFacts now expires each active prior fact
 * and keeps its row (active reads drop it, history keeps it), deletes only the
 * page's audit checkpoint rows, and leaves rows a previous clear expired alone.
 * PGLite always, Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { clearConversationFacts, countConversationFacts } from '../src/core/facts/conversation-publication.ts';
import { TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SLUG = 'conversations/chat-alice-example';
const LANE = 'cli:extract-conversation-facts:v1';

for (const kind of testBackends()) {
  describe(`clearConversationFacts keeps prior facts expired (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.putPage(SLUG, { type: 'conversation', title: 'chat', compiled_truth: 'A chat.' });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    async function insert(fact: string, source: string, expired = false): Promise<number> {
      const [row] = await engine.executeRaw<{ id: string | number }>(
        `INSERT INTO facts (source_id, fact, kind, visibility, source, source_markdown_slug, expired_at)
         VALUES ('default', $1, 'fact', 'private', $2, $3, CASE WHEN $4::boolean THEN now() - interval '1 day' ELSE NULL END) RETURNING id`,
        [fact, source, SLUG, expired]);
      return Number(row!.id);
    }
    const rowOf = async (id: number) => (await engine.executeRaw<{ id: number; expired_at: Date | null }>(
      'SELECT id, expired_at FROM facts WHERE id = $1', [id]))[0];

    test('an unreferenced prior fact is expired, not deleted; audit rows go; earlier expired rows stay', async () => {
      const lost = await insert('Alice Example prefers window seats', LANE);
      const kept = await insert('Alice Example lives in Lisbon', LANE);
      const older = await insert('Alice Example used to live in Porto', LANE, true);
      const audit = await insert('EXTRACTION_COMPLETE', TERMINAL_AUDIT_SOURCE);
      expect(await countConversationFacts(engine, 'default', SLUG)).toBe(2);

      expect(await clearConversationFacts(engine, 'default', SLUG)).toBe(3);

      for (const id of [lost, kept]) expect((await rowOf(id))?.expired_at).not.toBeNull();
      expect((await rowOf(older))?.expired_at).not.toBeNull();
      expect(await rowOf(audit)).toBeUndefined();
      expect(await countConversationFacts(engine, 'default', SLUG)).toBe(0);
      const active = await engine.executeRaw<{ n: number }>(
        'SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL', [SLUG]);
      expect(Number(active[0]!.n)).toBe(0);
    });
  });
}
