/**
 * #7548: an unchanged concept still restores its member provenance.
 *
 * Protects: a concept whose member hash is unchanged spends nothing, and when
 * its concept-provenance edges no longer reach every member atom (a link lost
 * to a failed write, a concurrent move or a deletion) the run banks them again
 * at the concept's current revision, without a model call and without
 * duplicating an edge.
 * Fails when: the unchanged-hash shortcut skips the provenance writer, so the
 * concept stays disconnected from its members on every later run.
 * Why new: g7-concept-provenance-edges covers changed member groups only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { withEnv } from '../helpers/with-env.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const ATOMS = [0, 1, 2, 3, 4].map(i => ({ slug: `atoms/storage-${i}`, concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));
const expected = ATOMS.flatMap(a => [`${CONCEPT} synthesized_from ${a.slug}`, `${a.slug} synthesizes ${CONCEPT}`]).sort();

const edges = async (engine: BrainEngine) => (await engine.executeRaw<{ e: string }>(
  `SELECT f.slug || ' ' || l.link_type || ' ' || t.slug AS e FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE l.link_source='concept-provenance' ORDER BY 1`)).map(r => r.e);

async function scenario(engine: BrainEngine, brainDir?: string) {
  let calls = 0;
  const chat = async (): Promise<ChatResult> => {
    calls++;
    const text = 'A complete narrative about this concept.';
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' };
  };
  const run = () => runPhaseSynthesizeConcepts(engine, { _atoms: ATOMS, _chat: chat, brainDir });
  await run();
  expect(calls).toBe(1);
  expect(await edges(engine)).toEqual(expected);
  const revision = (await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision;

  await engine.executeRaw(`DELETE FROM links WHERE link_source='concept-provenance'
    AND (from_page_id = (SELECT id FROM pages WHERE slug='atoms/storage-1') OR to_page_id = (SELECT id FROM pages WHERE slug='atoms/storage-1'))`);
  const repaired = await run();
  expect(calls).toBe(1);
  expect(repaired.details.skipped_unchanged).toEqual([CONCEPT]);
  expect(await edges(engine)).toEqual(expected);
  expect(repaired.details.provenance_restored).toEqual([CONCEPT]);
  expect((await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision).toBe(revision);

  const again = await run();
  expect(calls).toBe(1);
  expect(again.details.provenance_restored).toEqual([]);
  expect(await edges(engine)).toEqual(expected);
}

describe('unchanged concept restores member provenance (#7548)', () => {
  test('unmanaged brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-7548-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        _resetWriteThroughCacheForTest();
        const { engine, close } = await isolatedSharedSkillsEngine();
        try {
          await engine.setConfig('models.dream.synthesize', MODEL);
          for (const atom of ATOMS) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
          await scenario(engine);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 240_000);

  test('managed brain', async () => {
    await managedBrain(async ({ engine, root }) => {
      await engine.setConfig('models.dream.synthesize', MODEL);
      await scenario(engine, root);
    }, { setup: async ({ engine }) => {
      for (const atom of ATOMS) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
    } });
  }, 240_000);
});
