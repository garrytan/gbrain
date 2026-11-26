/**
 * #10435: a fence-only edit does not make extract_atoms pay again.
 *
 * The extraction input is the page as a world reader sees it (publicBody: the
 * takes fence and non-world facts rows removed). Accepting a take changes only
 * the takes fence, so the page's content_hash moves while the text the model
 * would read does not. Before the fix the next run extracted the page again
 * (one more paid model call on identical input) and replaced its atoms. Now a
 * page whose public body still matches the committed extract_atoms watermark is
 * stamped complete for its new content hash with no model call, its atoms stay
 * as they were, and the backlog count stops listing it. A real prose change is
 * still extracted. PGLite (repo-less) and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { HIDDEN_TAKE_ROW, WORLD_PAGE_BODY as BODY } from './helpers/world-fence-page.ts';

const SLUG = 'notes/launch-review';
const NEW_TAKE_ROW = '| 2 | Acme-example will hire a second reviewer | take | brain | 0.7 | 2026-02 | test |';

function countingChat() {
  let calls = 0;
  const chat = async (_opts: ChatOpts): Promise<ChatResult> => {
    calls++;
    const text = JSON.stringify([{ title: `Measure every launch ${calls}`, body: 'Measure every launch against clear exit criteria.', atom_type: 'insight',
      source_quote: 'the team measures every launch against clear exit criteria' }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls: () => calls, chat };
}

const liveAtoms = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$2 ORDER BY slug`,
  [sourceId, SLUG])).map(row => row.slug);

describe('#10435 extract_atoms skips a page whose extraction input did not change', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterAll(async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });

  test('a takes-fence-only edit makes no model call and keeps the atoms; a prose edit still extracts', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: BODY, timeline: '' }, { sourceId });
      const first = countingChat();
      expect((await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: [] })).status, backend).toBe('ok');
      expect(first.calls(), backend).toBe(1);
      const before = await liveAtoms(engine, sourceId);
      expect(before.length, backend).toBe(1);

      const fenceEdited = BODY.replace(`| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |`,
        `| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |\n${NEW_TAKE_ROW}`);
      expect(fenceEdited, backend).not.toBe(BODY);
      await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: fenceEdited, timeline: '' }, { sourceId });
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
      const second = countingChat();
      expect((await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] })).status, backend).toBe('ok');
      expect(second.calls(), backend).toBe(0);
      expect(await liveAtoms(engine, sourceId), backend).toEqual(before);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);

      const proseEdited = fenceEdited.replace('# Launch review', '# Launch review\n\nThe review also found that exit criteria are written before work starts.');
      await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: proseEdited, timeline: '' }, { sourceId });
      const third = countingChat();
      expect((await runPhaseExtractAtoms(engine, { sourceId, _chat: third.chat, _transcripts: [] })).status, backend).toBe('ok');
      expect(third.calls(), backend).toBe(1);
    }
  }, 120_000);
});
