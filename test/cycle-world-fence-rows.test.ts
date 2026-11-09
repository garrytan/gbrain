/**
 * Dream phases that read page bodies never carry a non-world fence row into
 * what they produce.
 *
 * propose_takes sends a page's prose to the extractor model and files what it
 * returns as take proposals; patterns sends each reflection's excerpt to its
 * subagent, which writes world pattern pages, and grounds those pages' quotes
 * against the reflections. Each reads the page as a world reader sees it
 * (facts rows other than world and the takes fence removed), so a hidden row
 * never reaches the extractor, a proposal, the subagent prompt, or a quote
 * certified as verified. PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { __testing, groundPatternPages } from '../src/core/cycle/patterns.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { FENCES, HIDDEN_TAKE_ROW, PRIVATE_ROW, WORLD_PAGE_BODY, WORLD_ROW } from './helpers/world-fence-page.ts';

const REFLECTION = 'wiki/personal/reflections/launch-week';
const PATTERN = 'wiki/personal/patterns/launch-checklists';

for (const backend of testBackends()) {
  describe(`dream phases read a world page without its non-world fence rows (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined));
      await engine.putPage('notes/launch-review', { type: 'note', title: 'Launch review', compiled_truth: WORLD_PAGE_BODY, timeline: '' }, { sourceId: 'default' });
      await importFromContent(engine, REFLECTION,
        `---\ntype: note\ntitle: Launch week\n---\nI keep writing "ship the checklist first" when a launch slips.\n\n${FENCES}`,
        { noEmbed: true, sourceId: 'default' });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('propose_takes: the extractor input and the proposals hold only world rows', async () => {
      const bodies: string[] = [];
      const extractor: ProposeTakesExtractor = async ({ pageBody, existingTakes }) => {
        bodies.push(pageBody);
        const seen = `${pageBody}\n${JSON.stringify(existingTakes)}`;
        return [WORLD_ROW, PRIVATE_ROW, HIDDEN_TAKE_ROW].filter(row => seen.includes(row))
          .map(row => ({ claim_text: row, kind: 'take' as const, holder: 'world', weight: 0.6 }));
      };
      const ctx: OperationContext = { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' };
      await runPhaseProposeTakes(ctx, { extractor, deadlineMs: 600_000 });
      const proposals = (await engine.executeRaw<{ claim_text: string }>(
        "SELECT claim_text FROM take_proposals WHERE page_slug='notes/launch-review'")).map(row => row.claim_text);
      expect(proposals).not.toContain(PRIVATE_ROW);
      expect(proposals).not.toContain(HIDDEN_TAKE_ROW);
      expect(proposals).toContain(WORLD_ROW);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toContain(PRIVATE_ROW);
        expect(body).not.toContain(HIDDEN_TAKE_ROW);
      }
    }, 120_000);

    test('patterns: the subagent prompt holds only world rows of a reflection', async () => {
      const reflections = await __testing.gatherReflections(engine, 30, 'wiki/personal/reflections', 'default');
      const reflection = reflections.find(r => r.slug === REFLECTION)!;
      expect(reflection.excerpt).toContain(WORLD_ROW);
      const prompt = __testing.buildPatternsPrompt(reflections, 1, 'wiki/personal/reflections', 'wiki/personal/patterns', '2026-11-09');
      expect(prompt).not.toContain(PRIVATE_ROW);
      expect(prompt).not.toContain(HIDDEN_TAKE_ROW);
    });

    test('patterns: quote grounding never certifies a quote only a hidden row holds', async () => {
      await engine.setConfig('dream.quote_verify', 'true');
      await importFromContent(engine, PATTERN,
        `---\ntype: note\ntitle: Launch checklists\ndream_generated: true\n---\nYou wrote "ship the checklist first" and "${WORLD_ROW}".\n\nYou also noted "${PRIVATE_ROW}".\n`,
        { noEmbed: true, sourceId: 'default' });
      const reflections = [{ slug: REFLECTION, title: 'Launch week', excerpt: '', updatedAt: new Date(), seat: null }];
      const stats = await groundPatternPages(engine, null, [{ slug: PATTERN, source_id: 'default' }], reflections, 'wiki/personal/patterns', 'default', '2026-11-09');
      const page = (await engine.getPage(PATTERN, { sourceId: 'default' }))!;
      expect(page.compiled_truth).not.toContain(PRIVATE_ROW);
      expect(page.compiled_truth).toContain('ship the checklist first');
      expect(page.compiled_truth).toContain(WORLD_ROW);
      expect(stats).toMatchObject({ pages: 1, quarantined: 1 });
    });
  });
}
