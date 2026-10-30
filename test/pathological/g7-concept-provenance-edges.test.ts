/**
 * GBRA-161 PR 5 (C-4, #4589): a concept's provenance edges (link_source concept-provenance) were insert-only, so an atom
 * that left the concept's member group kept its edges forever. They now retire when a concept generation replaces the
 * previous one, in the transaction that banks the new edges, and only while the concept is still at the revision its
 * publication produced (the revision fence of a derived-link kind; no ledger). Real phase, PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { replaceConceptProvenanceLinks } from '../../src/core/cycle/concept-publication.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const atoms = (ids: number[]) => ids.map(i => ({ slug: `atoms/storage-${i}`, concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));
const chat = async (): Promise<ChatResult> => {
  const text = 'A complete narrative about this concept.';
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' };
};
const edges = async (engine: BrainEngine) => (await engine.executeRaw<{ e: string }>(
  `SELECT f.slug || ' ' || l.link_type || ' ' || t.slug AS e FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE l.link_source='concept-provenance' ORDER BY 1`)).map(r => r.e);
const expected = (ids: number[]) => ids.flatMap(i => [`${CONCEPT} synthesized_from atoms/storage-${i}`, `atoms/storage-${i} synthesizes ${CONCEPT}`]).sort();

async function world(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g7-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const atom of atoms([0, 1, 2, 3, 4, 5])) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 5 concept provenance edges (${backend})`, () => {
    test('C-4: a republished concept retires the edges of the atom that left its group and banks the new one', async () => {
      await world(databaseUrl, async engine => {
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms([0, 1, 2, 3, 4]), _chat: chat });
        expect(await edges(engine)).toEqual(expected([0, 1, 2, 3, 4]));
        const before = (await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision;
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms([0, 1, 2, 3, 5]), _chat: chat });
        expect((await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision).not.toBe(before);
        expect(await edges(engine)).toEqual(expected([0, 1, 2, 3, 5]));
      });
    }, 240_000);

    test('C-4: a concept that moved past the revision its publication produced keeps every edge', async () => {
      await world(databaseUrl, async engine => {
        await runPhaseSynthesizeConcepts(engine, { _atoms: atoms([0, 1, 2, 3, 4]), _chat: chat });
        const published = (await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision;
        const page = (await engine.getPage(CONCEPT, { sourceId: 'default' }))!;
        await engine.putPage(CONCEPT, { type: page.type, title: page.title, compiled_truth: `${page.compiled_truth}\n\nA person added this line.`, timeline: page.timeline ?? '', frontmatter: page.frontmatter });
        const links = atoms([0, 1, 2, 3]).flatMap(a => [
          { from_slug: CONCEPT, to_slug: a.slug, link_type: 'synthesized_from', link_source: 'concept-provenance', context: 'member atom', from_source_id: 'default', to_source_id: 'default' },
          { from_slug: a.slug, to_slug: CONCEPT, link_type: 'synthesizes', link_source: 'concept-provenance', context: 'concept synthesized from this atom', from_source_id: 'default', to_source_id: 'default' },
        ]);
        expect(await replaceConceptProvenanceLinks(engine, 'default', CONCEPT, links, { expectedRevision: published, managed: false })).toBe('moved');
        expect(await edges(engine)).toEqual(expected([0, 1, 2, 3, 4]));
      });
    }, 240_000);
  });
}
