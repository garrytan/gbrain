/**
 * #7269 (reported by @p3ob7o): a T3 concept's narrative is the deterministic template (`deterministicNarrative` never
 * calls the model), so its member hash must not include the synthesis model. Changing `models.dream.synthesize`
 * rewrote every T3 page; after the fix none is rewritten, while T1 and T2 pages (model narratives) still are. A
 * rewrite that would leave a deterministic page as it is publishes nothing. PGLite; Postgres when DATABASE_URL is set.
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
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const MODEL_A = 'anthropic:claude-sonnet-4-6';
const MODEL_B = 'openai:gpt-5.5';
const SIZES: Record<string, number> = { t1: 10, t2: 5, t3a: 2, t3b: 4 };

const atoms = Object.entries(SIZES).flatMap(([concept, n]) => Array.from({ length: n }, (_, i) => ({
  slug: `atoms/${concept}-${i}`, concept_refs: [`concepts/${concept}`], body: `Atom ${i} about ${concept}.`, title: `${concept} atom ${i}`,
})));

const chat = (model: string) => async (): Promise<ChatResult> => {
  const text = 'A complete narrative about this concept.';
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model, providerId: model.split(':')[0]! };
};

async function revisions(engine: BrainEngine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const concept of Object.keys(SIZES)) out[concept] = (await engine.readPageSnapshot(`concepts/${concept}`, { sourceId: 'default' }))!.revision;
  return out;
}

async function world(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-7269-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try { await run(engine); } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7269 T3 concept member hash (${backend})`, () => {
    test('changing the synthesis model rewrites T1 and T2 concepts and leaves every T3 concept as it was', async () => {
      await world(databaseUrl, async engine => {
        await engine.setConfig('models.dream.synthesize', MODEL_A);
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat(MODEL_A) });
        const tiers = Object.fromEntries(await Promise.all(Object.keys(SIZES).map(async c => [c, (await engine.getPage(`concepts/${c}`, { sourceId: 'default' }))!.frontmatter.tier])));
        expect(tiers).toEqual({ t1: 'T1', t2: 'T2', t3a: 'T3', t3b: 'T3' });
        const before = await revisions(engine);
        await engine.setConfig('models.dream.synthesize', MODEL_B);
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat(MODEL_B) });
        const after = await revisions(engine);
        expect(Object.fromEntries(Object.keys(SIZES).map(c => [c, after[c] !== before[c]]))).toEqual({ t1: true, t2: true, t3a: false, t3b: false });
      });
    }, 240_000);

    test('a T3 concept written before the fix (hash with the model) is not rewritten when the model changes', async () => {
      await world(databaseUrl, async engine => {
        await engine.setConfig('models.dream.synthesize', MODEL_A);
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat(MODEL_A) });
        await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"member_hash":"0123456789abcdef"}'::jsonb WHERE slug IN ('concepts/t3a','concepts/t3b')`);
        const before = await revisions(engine);
        await engine.setConfig('models.dream.synthesize', MODEL_B);
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat(MODEL_B) });
        const after = await revisions(engine);
        expect([after.t3a === before.t3a, after.t3b === before.t3b]).toEqual([true, true]);
      });
    }, 240_000);
  });
}
