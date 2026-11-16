/**
 * #9192: v153's activation takes a page indexed before the safe-chunk fence out of search until the projection drain rebuilds it. While that
 * rebuild runs, search and query say how far it is (pages done of total, the rate measured since it started) and which
 * command shows progress, and the upgrade says so once when the activation runs.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { drainConcurrency } from '../src/core/page-state/rebuild-estimate.ts';
import { v153 } from '../src/core/schema-migrations/v153-verified-text-projection-activation.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

const TEXT = 'The quokka harmonica appears in this synthetic note.';

async function activated(run: (engine: BrainEngine) => Promise<void>, databaseUrl?: string) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    for (const slug of ['notes/quokka-one', 'notes/quokka-two']) {
      await engine.putPage(slug, { type: 'note', title: 'Quokka harmonica', compiled_truth: TEXT });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: TEXT }]);
    }
    // Indexed before the safe-chunk fence, so activation takes them out of search (an index built after it stays
    // served: search-during-upgrade-rebuild-9192.test.ts).
    await engine.executeRaw('UPDATE pages SET chunker_version = 3');
    for (const statement of PAGE_PROJECTION_ACTIVATION_SQL.split(';').map(s => s.trim()).filter(Boolean)) await engine.executeRaw(statement);
    await run(engine);
  } finally { await close(); }
}
const answer = async (engine: BrainEngine, tool: string) => JSON.stringify(await dispatchToolCall(engine, tool, { query: 'harmonica synthetic' }, { remote: false }));

for (const backend of testBackends()) {
  const url = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#9192 the index rebuild after activation is reported (${backend})`, () => {
    test('search and query name pages done of total, the measured rate and the progress command', () => activated(async engine => {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect((await rebuildPendingPageProjections(engine, 1)).rebuilt).toBe(1);
      for (const tool of ['search', 'query']) {
        const text = await answer(engine, tool);
        expect(text).toContain('the search index rebuild an upgrade started is 1 of 2 page(s) done, at about ');
        expect(text).toContain('page(s) per second measured since it started');
        expect(text).toContain('gbrain doctor --only text_projection_readiness');
      }
    }, url), 120_000);

    test('the rebuild clause ends with the rebuild', () => activated(async engine => {
      while ((await rebuildPendingPageProjections(engine, 20)).rebuilt > 0) { /* drain */ }
      expect(await answer(engine, 'search')).not.toContain('the search index rebuild an upgrade started');
    }, url), 120_000);

    test('the v153 handler prints what stays served, what waits, the measured estimate and the progress command once', () => activated(async engine => {
      const writes: string[] = [];
      const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write);
      try { await v153.handler!(engine); } finally { spy.mockRestore(); }
      const lines = writes.filter(w => w.includes('[153]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^ {2}\[153\] 2 page\(s\) queued for a keyless search index rebuild \(no embedding calls\)\. Search keeps answering from the index 0 of them already had; 2 \(images, pages indexed before the safe-chunk fence, and pages with a facts or takes fence, private-key text or a quarantine marker\) stay out of search until rebuilt\. At the [\d.]+ ms round trip measured to this database, rebuilding its 2 Markdown and code page\(s\) takes about 1 minute\(s\)(?<atOnce>, \d+ pages at once)?, pages out of search first: gbrain projections drain(?<faster> \(about 1 minute\(s\) with gbrain projections drain --concurrency \d+\))?\. Progress: gbrain doctor --only text_projection_readiness\n$/);
      const width = drainConcurrency(engine);
      const groups = lines[0]!.match(/(?<atOnce>, (?<n>\d+) pages at once)?, pages out of search first: gbrain projections drain(?<faster> \(about 1 minute\(s\) with gbrain projections drain --concurrency (?<max>\d+)\))?\./)!.groups!;
      expect(groups.n === undefined ? 1 : Number(groups.n)).toBe(width.default);
      expect(groups.max === undefined ? width.default : Number(groups.max)).toBe(width.max);
      if (engine.kind === 'pglite') expect(groups.atOnce ?? groups.faster).toBeUndefined();
    }, url), 120_000);
  });
}
