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
import { EXTRACT_MAX_INPUT_CHARS_KEY } from '../src/core/cycle/extract-atoms-input.ts';
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
  test('the skip never stands in for an extraction whose outputs moved: a date or visibility edit, or a page restored after its atoms were retired, extracts again', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-outputs-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const put = (frontmatter: Record<string, unknown>) => engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: BODY, timeline: '', frontmatter }, { sourceId });
      const run = async () => { const counted = countingChat(); expect((await runPhaseExtractAtoms(engine, { sourceId, _chat: counted.chat, _transcripts: [] })).status, backend).toBe('ok'); return counted.calls(); };
      const atomFields = async () => (await engine.executeRaw<{ date: string | null; visibility: string | null }>(
        `SELECT frontmatter->>'date' AS date, frontmatter->>'visibility' AS visibility FROM pages
          WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$2`, [sourceId, SLUG]));
      await put({ date: '2026-04-02' });
      expect(await run(), backend).toBe(1);
      expect((await atomFields()).map(a => a.date?.slice(0, 10)), backend).toEqual(['2026-04-02']);

      await put({ date: '2026-05-03' });
      expect(await run(), backend).toBe(1);
      expect((await atomFields()).map(a => a.date?.slice(0, 10)), backend).toEqual(['2026-05-03']);

      await put({ date: '2026-05-03', visibility: 'private' });
      expect(await run(), backend).toBe(1);
      expect((await atomFields()).map(a => a.visibility), backend).toEqual(['private']);

      await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, SLUG]);
      await engine.executeRaw(`UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND type='atom' AND frontmatter->>'source_slug'=$2`, [sourceId, SLUG]);
      await engine.executeRaw('UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, SLUG]);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
      expect(await run(), backend).toBe(1);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
    }
  }, 120_000);
  const fenceEdit = (n: number) => BODY.replace(`| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |`,
    `| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |\n${NEW_TAKE_ROW.replace('| 2 |', `| ${n} |`)}`);
  async function extracted(backend: string, engine: BrainEngine, sourceId: string) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: BODY, timeline: '' }, { sourceId });
    const run = async (chat?: (opts: ChatOpts) => Promise<ChatResult>) => { const counted = countingChat();
      await runPhaseExtractAtoms(engine, { sourceId, _chat: chat ?? counted.chat, _transcripts: [] }); return counted.calls(); };
    const edit = (n: number) => engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: fenceEdit(n), timeline: '' }, { sourceId });
    return { run, edit, backend };
  }

  test('a successful extraction after a malformed response still lets a later fence-only edit skip', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-retry-${backend}`;
      const { run, edit } = await extracted(backend, engine, sourceId);
      const malformed = async (): Promise<ChatResult> => ({ text: 'not json', blocks: [{ type: 'text', text: 'not json' }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
      await run(malformed);
      expect(await liveAtoms(engine, sourceId), backend).toEqual([]);
      expect(await run(), backend).toBe(1);
      const before = await liveAtoms(engine, sourceId);
      expect(before.length, backend).toBe(1);
      await edit(2);
      expect(await run(), backend).toBe(0);
      expect(await liveAtoms(engine, sourceId), backend).toEqual(before);
    }
  }, 120_000);

  test('an atom another page or a transcript links from this page does not make the page look stale', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-linked-${backend}`;
      const { run, edit } = await extracted(backend, engine, sourceId);
      expect(await run(), backend).toBe(1);
      const before = await liveAtoms(engine, sourceId);
      await engine.putPage('atoms/session-insight', { type: 'atom', title: 'Session insight', compiled_truth: 'A session insight.', timeline: '',
        frontmatter: { source_path: 'sessions/2025-01-01.txt', date: '2025-01-01', visibility: 'private' } }, { sourceId });
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        SELECT p.id, a.id, 'derived', 'atom-provenance' FROM pages p, pages a WHERE p.source_id=$1 AND p.slug=$2 AND a.source_id=$1 AND a.slug='atoms/session-insight'`, [sourceId, SLUG]);
      await edit(2);
      expect(await run(), backend).toBe(0);
      expect(await liveAtoms(engine, sourceId), backend).toEqual(before);
    }
  }, 120_000);

  test('a fence-only edit never re-extracts an atom someone made private, so its visibility never widens', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-private-${backend}`;
      const { run, edit } = await extracted(backend, engine, sourceId);
      expect(await run(), backend).toBe(1);
      const before = await liveAtoms(engine, sourceId);
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb
        WHERE source_id=$1 AND type='atom' AND frontmatter->>'source_slug'=$2`, [sourceId, SLUG]);
      await edit(2);
      expect(await run(), backend).toBe(0);
      expect(await liveAtoms(engine, sourceId), backend).toEqual(before);
      expect((await engine.executeRaw<{ v: string }>(`SELECT frontmatter->>'visibility' AS v FROM pages
        WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$2`, [sourceId, SLUG])).map(r => r.v), backend).toEqual(['private']);
    }
  }, 120_000);
  test('a hard abort while the skip checks the outputs leaves the edited page pending', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-abort-${backend}`;
      const { run, edit } = await extracted(backend, engine, sourceId);
      expect(await run(), backend).toBe(1);
      await edit(2);
      const controller = new AbortController();
      const aborting = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          const rows = await target.executeRaw(sql, params);
          if (sql.includes('AS complete')) controller.abort(new Error('test abort'));
          return rows;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await runPhaseExtractAtoms(aborting, { sourceId, _chat: countingChat().chat, _transcripts: [], signal: controller.signal }).catch(() => undefined);
      expect(controller.signal.aborted, backend).toBe(true);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
    }
  }, 120_000);

  test('a partial read after the last full scan never stands in for a full read once the input cap is raised', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `fence-only-partial-${backend}`;
      const { run } = await extracted(backend, engine, sourceId);
      await engine.setConfig(EXTRACT_MAX_INPUT_CHARS_KEY, '2000');
      try {
        expect(await run(), backend).toBe(1);
        await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: `${BODY}\n${'Partner teams now get a second launch checklist. '.repeat(20)}\n`, timeline: '' }, { sourceId });
        expect(await run(), backend).toBe(1);
        await engine.setConfig(EXTRACT_MAX_INPUT_CHARS_KEY, '10000');
        let prompt = '';
        const counted = countingChat();
        await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [], _chat: async opts => { prompt += JSON.stringify(opts); return counted.chat(opts); } });
        expect(counted.calls(), backend).toBe(1);
        expect(prompt, backend).toContain('clear exit criteria');
        expect(prompt, backend).toContain('second launch checklist');
      } finally {
        await engine.unsetConfig(EXTRACT_MAX_INPUT_CHARS_KEY);
      }
    }
  }, 120_000);
});
