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
import { clearConversationFacts, countConversationFacts, publishConversationFacts } from '../src/core/facts/conversation-publication.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
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

    test('a re-extraction that narrows a claim to private narrows its expired copies, so remote history never returns it', async () => {
      const QUIET = 'Alice Example is planning a surprise party';
      const CONTROL = 'Alice Example enjoys jazz concerts';
      for (const fact of [`${QUIET}.`, CONTROL]) {
        await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, visibility, source, source_markdown_slug) VALUES ('default', $1, 'fact', 'world', $2, $3)`, [fact, LANE, SLUG]);
      }
      const narrowed = { fact: QUIET, kind: 'fact', entity_slug: null, context: null, valid_from: null, valid_until: null, source: LANE, source_session: null,
        confidence: 1, notability: 'medium', embedding: null, embedding_model: null, visibility: 'private' };
      await publishConversationFacts(engine, 'default', SLUG, [narrowed as never], { scope: 'full' });
      const copies = await engine.executeRaw<{ visibility: string; expired: boolean }>(
        'SELECT visibility, expired_at IS NOT NULL AS expired FROM facts WHERE fact LIKE $1 ORDER BY id', [`${QUIET}%`]);
      expect(copies.map(c => [c.visibility, c.expired])).toEqual([['private', true], ['private', false]]);
      const auth = { token: 't', clientId: 'history-reader', scopes: ['read'], sourceId: 'default', allowedSources: ['default'] };
      const res = await dispatchToolCall(engine, 'recall', { include_expired: true, limit: 100 },
        { remote: true, transport: 'stdio', sourceId: 'default', auth, config: { engine: engine.kind } as never });
      expect(res.isError).toBeFalsy();
      const text = res.content.map(c => (c as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(CONTROL);
      expect(text).not.toContain(QUIET);
    });
  });
}
