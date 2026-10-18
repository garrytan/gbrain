/**
 * GBRA-130 PR 2 review F8: an escaped or shortened entity slug kept no
 * identity of the name it came from.
 *
 * slugifyEntity suffixes a Windows reserved name with the entity type (B-5:
 * `Aux` -> `companies/aux-company`) and cut an over-long name to the file-name
 * budget (B-12). Both are lossy: `Aux` then shared a slug with a company
 * really named `Aux Company`, and two long names sharing their first 235 bytes
 * shared one slug. enrichEntity reused whatever page sat at the slug, so
 * enriching `Aux` wrote its timeline row and backlink to `Aux Company` and
 * never looked at the legacy `companies/aux` page that names it. The fix tags
 * a shortened name with a hash of the full name, checks that a page found at an
 * escaped slug names this entity, prefers the matching legacy page (also the
 * untagged cut slug an older gbrain minted for a long name), and gives
 * an entity whose slug another entity holds its own hash-tagged page.
 *
 * Real PGLite, plus the Postgres arm when DATABASE_URL is set
 * (test/postgres-unit-arms.txt). Placeholder names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { enrichEntity, slugifyEntity } from '../../src/core/enrichment-service.ts';
import { pathologicalArms } from './harness.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';

const page = (type: string, title: string) => `---\ntitle: ${JSON.stringify(title)}\ntype: ${type}\n---\n\n# ${title}\n`;
const PREFIX = 'acme-example-holdings-'.repeat(11);
const LONG_ONE = `${PREFIX}North`;
const LONG_TWO = `${PREFIX}South`;
const OLD_PREFIX = 'globex-example-'.repeat(17);
const OTHER_PREFIX = 'initech-example-'.repeat(16);
/** The slug the previous slugifyEntity minted for an over-budget name: cut to 235 bytes with no hash. */
const untagged = (name: string) => `companies/${name.toLowerCase().slice(0, 235).replace(/[-._:]+$/, '')}`;

async function seed(engine: BrainEngine): Promise<void> {
  const pages: Array<[string, string, string]> = [
    ['companies/aux', 'company', 'Aux'],
    ['companies/aux-company', 'company', 'Aux Company'],
    ['people/con-person', 'person', 'Con Person'],
    ['companies/lpt1-company', 'company', 'Lpt1 Company'],
    [`companies/lpt1-company-${createHash('sha256').update('lpt1').digest('hex').slice(0, 8)}`, 'company', 'Other Example'],
    ['notes/source-example', 'note', 'Source Example'],
    [untagged(`${OLD_PREFIX}Alpha`), 'company', `${OLD_PREFIX}Alpha`],
    [untagged(`${OTHER_PREFIX}Beta`), 'company', `${OTHER_PREFIX}Beta`],
  ];
  for (const [slug, type, title] of pages) await importFromContent(engine, slug, page(type, title), { noEmbed: true });
}

const counts = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ timeline: number; links: number }>(
  `SELECT (SELECT count(*)::int FROM timeline_entries t WHERE t.page_id = p.id) AS timeline,
          (SELECT count(*)::int FROM links l WHERE l.from_page_id = p.id) AS links
     FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL`, [slug]))[0] ?? null;
const title = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.title ?? null;

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
  const enrich = (entityName: string, entityType: 'person' | 'company') =>
    enrichEntity(engine(), { entityName, entityType, context: 'named in passing', sourceSlug: 'notes/source-example' }, { trusted: true });

  describe(`F8 enrichment keeps entity identity across escaped and shortened slugs (${backend})`, () => {
    test('F8: enriching Aux updates the legacy companies/aux page and leaves Aux Company untouched', async () => {
      const aux = await enrich('Aux', 'company');
      expect({ slug: aux.slug, action: aux.action }).toEqual({ slug: 'companies/aux', action: 'updated' });
      expect(await counts(engine(), 'companies/aux-company')).toEqual({ timeline: 0, links: 0 });
      expect(await counts(engine(), 'companies/aux')).toEqual({ timeline: 1, links: 1 });
      const company = await enrich('Aux Company', 'company');
      expect({ slug: company.slug, action: company.action }).toEqual({ slug: 'companies/aux-company', action: 'updated' });
      expect(await counts(engine(), 'companies/aux')).toEqual({ timeline: 1, links: 1 });
    });

    test('F8: Con gets its own page when Con Person holds people/con-person, and keeps it on the next mention', async () => {
      const first = await enrich('Con', 'person');
      expect({ slug: first.slug, action: first.action }).toEqual({ slug: expect.stringMatching(/^people\/con-person-[0-9a-f]{8}$/), action: 'created' });
      expect(await title(engine(), first.slug)).toBe('Con');
      expect(await counts(engine(), 'people/con-person')).toEqual({ timeline: 0, links: 0 });
      const again = await enrich('Con', 'person');
      expect({ slug: again.slug, action: again.action }).toEqual({ slug: first.slug, action: 'updated' });
      expect((await enrich('Con Person', 'person')).slug).toBe('people/con-person');
      expect(await counts(engine(), first.slug)).toEqual({ timeline: 1, links: 1 });
    });

    test('F8: a company really named Prn Company does not land on the page minted for Prn', async () => {
      const prn = await enrich('Prn', 'company');
      expect({ slug: prn.slug, action: prn.action }).toEqual({ slug: 'companies/prn-company', action: 'created' });
      const company = await enrich('Prn Company', 'company');
      expect({ slug: company.slug, action: company.action }).toEqual({ slug: expect.stringMatching(/^companies\/prn-company-[0-9a-f]{8}$/), action: 'created' });
      expect(await title(engine(), company.slug)).toBe('Prn Company');
      expect(await counts(engine(), 'companies/prn-company')).toEqual({ timeline: 1, links: 1 });
    });

    test('F8: when the hash-tagged slug also names another entity, enrichment skips with a reason and writes nothing', async () => {
      const tagged = `companies/lpt1-company-${createHash('sha256').update('lpt1').digest('hex').slice(0, 8)}`;
      const result = await enrich('Lpt1', 'company');
      expect(result).toMatchObject({ action: 'skipped', skipped_reason: 'entity_slug_taken', timelineAdded: false, backlinkCreated: false });
      for (const slug of ['companies/lpt1-company', tagged]) expect(await counts(engine(), slug)).toEqual({ timeline: 0, links: 0 });
      expect(await title(engine(), tagged)).toBe('Other Example');
    });

    test('F8: two long names sharing their first 235 bytes each land on their own portable page', async () => {
      expect(Buffer.byteLength(PREFIX)).toBeGreaterThan(235);
      const one = await enrich(LONG_ONE, 'company');
      const two = await enrich(LONG_TWO, 'company');
      expect({ one: one.action, two: two.action, distinct: one.slug !== two.slug }).toEqual({ one: 'created', two: 'created', distinct: true });
      for (const [result, name] of [[one, LONG_ONE], [two, LONG_TWO]] as const) {
        expect(Buffer.byteLength(result.slug.split('/')[1]!)).toBeLessThanOrEqual(235);
        expect(result.slug).toBe(slugifyEntity(name, 'company'));
        expect(await title(engine(), result.slug)).toBe(name);
        expect(await counts(engine(), result.slug)).toEqual({ timeline: 1, links: 1 });
      }
      const again = await enrich(LONG_ONE, 'company');
      expect({ slug: again.slug, action: again.action }).toEqual({ slug: one.slug, action: 'updated' });
      expect(await counts(engine(), two.slug)).toEqual({ timeline: 1, links: 1 });
    });

    test('F8: a long name already stored at the untagged slug an older gbrain minted is updated there, with no tagged duplicate', async () => {
      const name = `${OLD_PREFIX}Alpha`;
      expect(untagged(name)).not.toBe(slugifyEntity(name, 'company'));
      const result = await enrich(name, 'company');
      expect({ slug: result.slug, action: result.action }).toEqual({ slug: untagged(name), action: 'updated' });
      expect(await counts(engine(), untagged(name))).toEqual({ timeline: 1, links: 1 });
      expect(await counts(engine(), slugifyEntity(name, 'company'))).toBeNull();
    });

    test('F8: an untagged slug holding the other long name with the same prefix is not reused', async () => {
      const name = `${OTHER_PREFIX}Gamma`;
      const holder = untagged(`${OTHER_PREFIX}Beta`);
      expect(untagged(name)).toBe(holder);
      const result = await enrich(name, 'company');
      expect({ slug: result.slug, action: result.action }).toEqual({ slug: slugifyEntity(name, 'company'), action: 'created' });
      expect(await title(engine(), result.slug)).toBe(name);
      expect(await counts(engine(), holder)).toEqual({ timeline: 0, links: 0 });
    });
  });
}
