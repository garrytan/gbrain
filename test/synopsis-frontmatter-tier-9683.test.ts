/**
 * #9683: page frontmatter `contextual_retrieval: per_chunk_synopsis` on the host source (or a source that trusts
 * frontmatter overrides) puts the page on the synopsis tier, but the sweep counted the tier as configured only from
 * the global tier or a source row, so `gbrain reindex --synopsis` said "Nothing to do" and never swept those pages.
 * Reported by @Masashi-Ono0611. Repo-less brain on PGLite, and on Postgres through the e2e wrapper; the plan spends
 * and queues nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { planSynopsisSweep } from '../src/core/synopsis-sweep.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { pathologicalArms } from './pathological/harness.ts';

const page = (title: string, extra = '') => `---\ntitle: ${title}\n${extra}---\n\n${`${title} covers the example topic in a few plain sentences. `.repeat(8)}\n`;
const plan = (engine: BrainEngine) => planSynopsisSweep(engine, { synopsisModel: 'anthropic:claude-haiku-4-5-20251001', embeddingPricePerMTok: null });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`reindex --synopsis with the tier chosen only in page frontmatter (${backend}, #9683)`, () => {
    test('a trusted frontmatter opt-in makes the sweep plan that page; an untrusted one does not', async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('mount-a','mount-a','/nonexistent/mount-a','{}')");
        await importFromContent(engine, 'notes/plain-example', page('Plain example'), { sourceId: 'default', noEmbed: true });
        await importFromContent(engine, 'notes/mount-example', page('Mount example', 'contextual_retrieval: per_chunk_synopsis\n'), { sourceId: 'mount-a', noEmbed: true });
        expect((await plan(engine)).config.configured).toBe(false);
        await importFromContent(engine, 'notes/tagged-example', page('Tagged example', 'contextual_retrieval: per_chunk_synopsis\n'), { sourceId: 'default', noEmbed: true });
        const tagged = await plan(engine);
        expect(tagged.config.configured).toBe(true);
        expect(tagged.pages.map(p => p.slug)).toEqual(['notes/tagged-example']);
      } finally { await close(); }
    }, 60_000);
  });
}
