import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { PRIVATE_ROW, WORLD_PAGE_BODY as BODY } from './helpers/world-fence-page.ts';

const SOURCE = 'default';
const SLUG = 'meetings/input-review';

async function remember(engine: BrainEngine, fact: string, visibility: 'private' | 'world') {
  const reply = await dispatchToolCall(engine, 'remember', { entity: SLUG, fact, provenance: 'fixture',
    visibility, infer_entity: false }, { remote: false, sourceId: SOURCE, config: { engine: engine.kind, embedding_disabled: true } });
  if (reply.isError) throw new Error(reply.content[0]!.text);
  expect(JSON.parse(reply.content[0]!.text!).id).toBeDefined();
}

function scanner() {
  const prompts: string[] = [];
  const chat = async (request: ChatOpts): Promise<ChatResult> => {
    prompts.push(JSON.stringify(request.messages));
    const text = JSON.stringify([{ title: 'Measure every launch', body: 'Use clear exit criteria.', atom_type: 'insight',
      source_quote: 'the team measures every launch against clear exit criteria' }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { chat, prompts };
}

async function activeAtoms(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; slug: string; knowledge_revision: string }>(`SELECT id,slug,knowledge_revision FROM pages WHERE source_id=$1 AND type='atom'
    AND frontmatter->>'source_slug'=$2 AND deleted_at IS NULL ORDER BY id`, [SOURCE, SLUG]);
}

for (const backend of testBackends()) {
  test(`${backend}: a managed private fact does not repeat a valid completed scan`, async () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    await managedBrain(async ({ engine }) => {
      const initial = await dispatchToolCall(engine, 'put_page', { slug: SLUG,
        content: '---\ntitle: Input review\ntype: meeting\n---\n' + BODY },
      { remote: false, sourceId: SOURCE, config: { engine: engine.kind, embedding_disabled: true } });
      if (initial.isError) throw new Error(initial.content[0]!.text);
      const scanner1 = scanner();
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(1);
      expect((await runPhaseExtractAtoms(engine, { sourceId: SOURCE, _chat: scanner1.chat, _transcripts: [] })).status).toBe('ok');
      expect(scanner1.prompts).toHaveLength(1);
      const atoms = await activeAtoms(engine);
      expect(atoms).toHaveLength(1);
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(0);

      const original = await engine.getPage(SLUG, { sourceId: SOURCE });
      await remember(engine, 'The internal review uses a fictional priority label.', 'private');
      await remember(engine, 'The internal review uses a fictional reviewer code.', 'private');
      const amended = await engine.getPage(SLUG, { sourceId: SOURCE });
      expect(amended!.content_hash).not.toBe(original!.content_hash);
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(0);
      expect(await countExtractAtomsBacklog(engine)).toBe(0);
      expect(await discoverExtractablePages(engine, SOURCE, [SLUG], 1)).toEqual([]);
      const scanner2 = scanner();
      await runPhaseExtractAtoms(engine, { sourceId: SOURCE, _chat: scanner2.chat, _transcripts: [] });
      expect(scanner2.prompts).toHaveLength(0);
      expect(await activeAtoms(engine)).toEqual(atoms);

      // Canonical fact-date repair publishes its edited fence with a normal put_page.
      const preimage = (await engine.readPageSnapshot(SLUG, { sourceId: SOURCE }))!;
      const editedTruth = preimage.page.compiled_truth.replace(PRIVATE_ROW, 'A revised private review detail is available.');
      expect(editedTruth).not.toBe(preimage.page.compiled_truth);
      const edited = await dispatchToolCall(engine, 'put_page', { slug: SLUG, expected_revision: preimage.revision,
        content: serializePageToMarkdown({ ...preimage.page, compiled_truth: editedTruth }, preimage.tags) },
      { remote: false, sourceId: SOURCE, config: { engine: engine.kind, embedding_disabled: true } });
      if (edited.isError) throw new Error(edited.content[0]!.text);
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(0);
      expect(await activeAtoms(engine)).toEqual(atoms);

      await remember(engine, 'The public review takes place every Thursday.', 'world');
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(1);
      expect(await countExtractAtomsBacklog(engine)).toBe(1);
      expect((await discoverExtractablePages(engine, SOURCE, [SLUG], 1)).map(page => page.slug)).toEqual([SLUG]);

      await runPhaseExtractAtoms(engine, { sourceId: SOURCE, _chat: scanner().chat, _transcripts: [] });
      const [updated] = await activeAtoms(engine);
      expect(updated).toBeDefined();
      await remember(engine, 'A further private fixture detail has been recorded.', 'private');
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(0);
      const removed = await dispatchToolCall(engine, 'delete_page', { slug: updated.slug, expected_revision: updated.knowledge_revision },
        { remote: false, sourceId: SOURCE, config: { engine: engine.kind, embedding_disabled: true } });
      if (removed.isError) throw new Error(removed.content[0]!.text);
      expect(await activeAtoms(engine)).toEqual([]);
      expect(await countExtractAtomsBacklog(engine, SOURCE)).toBe(1);
      expect((await discoverExtractablePages(engine, SOURCE, [SLUG], 1)).map(page => page.slug)).toEqual([SLUG]);
    }, { databaseUrl });
  }, 120_000);
}
