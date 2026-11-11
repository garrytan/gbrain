/**
 * Atoms extracted from a world page never carry a non-world fence row.
 *
 * A world page's facts fence may hold rows marked `visibility: private`, and its
 * takes fence is never part of the page text a remote caller reads. The
 * extraction input is the page as a world reader sees it (the facts fence keeps
 * only world rows, the takes fence is dropped), so neither the model prompt nor
 * the atom it returns (title, body, verified source_quote) can hold a hidden
 * row, and a remote get_page of the atom returns none of it.
 *
 * The stub model copies every fence row it is shown into an atom, so a hidden
 * row that reached the prompt would reach the atom. PGLite and Postgres, the
 * unmanaged cycle phase (page discovery) and a managed brain (origin
 * publication through the coordinator).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { HIDDEN_TAKE_ROW, PRIVATE_ROW, WORLD_ROW, WORLD_PAGE_BODY as BODY } from './helpers/world-fence-page.ts';

const SLUG = 'notes/launch-review';

/** A model that turns every fence row it is shown into an atom quoting that row verbatim. */
function copyingChat() {
  const prompts: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    const prompt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    prompts.push(prompt);
    const rows = [WORLD_ROW, PRIVATE_ROW, HIDDEN_TAKE_ROW].filter(row => prompt.includes(row));
    const atoms = [
      { title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.', atom_type: 'insight',
        source_quote: 'the team measures every launch against clear exit criteria' },
      ...rows.map((row, i) => ({ title: `Row ${i + 1}: ${row}`, body: `Recorded on the page: ${row}.`, atom_type: 'insight', source_quote: row })),
    ];
    const text = JSON.stringify(atoms);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { prompts, chat };
}

const atomsOf = (engine: BrainEngine, sourceId: string) =>
  engine.executeRaw<{ slug: string; title: string; compiled_truth: string; visibility: string | null; source_quote: string | null }>(
    `SELECT slug, title, compiled_truth, frontmatter->>'visibility' AS visibility, frontmatter->>'source_quote' AS source_quote
       FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$2 ORDER BY slug`, [sourceId, SLUG]);

async function remoteGet(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId, takesHoldersAllowList: ['world'] });
  return out.content.map(c => c.text).join('\n');
}

async function expectOnlyWorldRows(engine: BrainEngine, sourceId: string, prompts: string[], backend: string) {
  const atoms = await atomsOf(engine, sourceId);
  expect(atoms.length, backend).toBeGreaterThan(0);
  for (const atom of atoms) {
    expect(atom.visibility, backend).toBe('world');
    const remote = await remoteGet(engine, sourceId, atom.slug);
    expect(remote, backend).not.toContain(PRIVATE_ROW);
    expect(remote, backend).not.toContain(HIDDEN_TAKE_ROW);
    for (const text of [atom.title, atom.compiled_truth, atom.source_quote ?? '']) {
      expect(text, backend).not.toContain(PRIVATE_ROW);
      expect(text, backend).not.toContain(HIDDEN_TAKE_ROW);
    }
  }
  expect(atoms.some(atom => atom.source_quote === WORLD_ROW), backend).toBe(true);
  expect(prompts.length, backend).toBeGreaterThan(0);
  for (const prompt of prompts) {
    expect(prompt, backend).not.toContain(PRIVATE_ROW);
    expect(prompt, backend).not.toContain(HIDDEN_TAKE_ROW);
    expect(prompt, backend).toContain(WORLD_ROW);
  }
  // Control: the source page itself reads back remotely with its world row and without the hidden ones.
  const source = await remoteGet(engine, sourceId, SLUG);
  expect(source, backend).toContain(WORLD_ROW);
  expect(source, backend).not.toContain(PRIVATE_ROW);
}

describe('atoms extracted from a world page never carry a non-world fence row', () => {
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

  test('cycle phase: the prompt, the atoms and a remote read of each atom hold only world rows', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `world-rows-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: BODY, timeline: '' }, { sourceId });
      const { prompts, chat } = copyingChat();
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [] });
      expect(result.status, backend).toBe('ok');
      await expectOnlyWorldRows(engine, sourceId, prompts, backend);
    }
  }, 120_000);

  test('managed brain: the published atoms hold only world rows', async () => {
    for (const backend of testBackends()) {
      const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
      await managedBrain(async ({ engine }) => {
        const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
        const { prompts, chat } = copyingChat();
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: chat, _transcripts: [],
          _pages: [{ slug: SLUG, content: page.compiled_truth, contentHash: page.content_hash! }] });
        await disposePersistenceConsumer(engine);
        expect(result.status, backend).toBe('ok');
        await expectOnlyWorldRows(engine, 'default', prompts, backend);
      }, { databaseUrl, setup: async ({ engine }) => {
        await engine.putPage(SLUG, { type: 'note', title: 'Launch review', compiled_truth: BODY, timeline: '' }, { sourceId: 'default' });
      } });
    }
  }, 180_000);
});
