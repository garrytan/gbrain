/**
 * B-9 (#6948 sweep): enrichment wrote to a retired alias page.
 *
 * #6898 made fact resolution follow `superseded_by` / `merged_into` off a
 * retired page (`canonical: false`, a retired status), but `enrichEntity`
 * (and `extract_entities`, which calls it) resolved the entity slug and wrote
 * the timeline row and backlink to whatever page sat there. A retired page then
 * kept accreting mentions while its canonical page saw none. The fix follows
 * the retirement chain after alias resolution, and skips with a reason when the
 * chain cannot be followed (no target, a missing target, a cycle).
 *
 * Real PGLite, plus the Postgres arm when DATABASE_URL is set
 * (test/postgres-unit-arms.txt). Placeholder names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { enrichEntity } from '../../src/core/enrichment-service.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { pathologicalArms } from './harness.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';

const page = (fm: Record<string, unknown>, title: string) =>
  `---\n${Object.entries({ title, ...fm }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# ${title}\n`;

/** A canonical person page, a retired page at the slug enrichment derives for its name, and retired pages whose chain cannot be followed. */
async function seed(engine: BrainEngine): Promise<void> {
  const pages: Array<[string, Record<string, unknown>, string]> = [
    ['people/aliceexample', { type: 'person', canonical: true, aliases: ['alice-example'] }, 'Alice Example'],
    ['people/alice-example', { type: 'person', status: 'historical-retired-alias', canonical: false, superseded_by: 'people/aliceexample' }, 'Alice Example'],
    ['people/bob-example', { type: 'person', canonical: false }, 'Bob Example'],
    ['people/carol-example', { type: 'person', superseded_by: 'people/dora-example' }, 'Carol Example'],
    ['people/dora-example', { type: 'person', superseded_by: 'people/carol-example' }, 'Dora Example'],
    ['notes/source-example', { type: 'note' }, 'Source Example'],
  ];
  for (const [slug, fm, title] of pages) await importFromContent(engine, slug, page(fm, title), { noEmbed: true });
}

const timeline = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`, [slug]))[0]!.n;
const backlinks = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.slug = $1`, [slug]))[0]!.n;

const arms = pathologicalArms();
const engines: Array<{ name: string; engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  for (const arm of arms) {
    const { engine, close } = await isolatedSharedSkillsEngine(arm.databaseUrl); await seed(engine);
    engines.push({ name: arm.backend, engine, close });
  }
}, 120_000);
afterAll(async () => { for (const e of engines) await e.close(); });

for (const { backend } of arms) {
  const engine = () => engines.find(e => e.name === backend)!.engine;
  describe(`B-9 enrichment follows a retired page to its canonical page (${backend})`, () => {
    test('enriching Alice Example updates the canonical page and leaves the retired one untouched', async () => {
      const result = await enrichEntity(engine(), { entityName: 'Alice Example', entityType: 'person', context: 'met at the offsite', sourceSlug: 'notes/source-example' }, { trusted: true });
      expect(result.slug).toBe('people/aliceexample');
      expect(result.action).toBe('updated');
      expect(await timeline(engine(), 'people/alice-example')).toBe(0);
      expect(await backlinks(engine(), 'people/alice-example')).toBe(0);
      expect(await timeline(engine(), 'people/aliceexample')).toBe(1);
      expect(await backlinks(engine(), 'people/aliceexample')).toBe(1);
    });

    test('a retired page with no target, or a redirect cycle, is skipped with a reason and nothing is written', async () => {
      for (const [name, slug] of [['Bob Example', 'people/bob-example'], ['Carol Example', 'people/carol-example']] as const) {
        const result = await enrichEntity(engine(), { entityName: name, entityType: 'person', context: 'named in passing', sourceSlug: 'notes/source-example' }, { trusted: true });
        expect(result).toMatchObject({ slug, action: 'skipped', skipped_reason: 'retired_page_unfollowable', timelineAdded: false, backlinkCreated: false });
        expect(await timeline(engine(), slug)).toBe(0);
        expect(await backlinks(engine(), slug)).toBe(0);
      }
      expect(await timeline(engine(), 'people/dora-example')).toBe(0);
    });

    test('extract_entities takes the same path: the mention lands on the canonical page', async () => {
      const ctx = { engine: engine(), remote: false, dryRun: false, sourceId: 'default', config: {} as never,
        logger: { info() {}, warn() {}, error() {} } as never } as OperationContext;
      const before = await timeline(engine(), 'people/aliceexample');
      const out = await operationsByName.extract_entities!.handler(ctx, { text: 'Lunch with Alice Example today.', source_slug: 'notes/source-example', trusted_extraction: true }) as { entities: Array<{ slug: string }> };
      expect(out.entities.map(e => e.slug)).toContain('people/aliceexample');
      expect(await timeline(engine(), 'people/alice-example')).toBe(0);
      expect(await timeline(engine(), 'people/aliceexample')).toBeGreaterThanOrEqual(before);
    });
  });
}
