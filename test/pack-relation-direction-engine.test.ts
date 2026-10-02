/**
 * Schema-pack relation direction through real extraction, retrieval and the
 * re-derivation path, on both engines (eval wave N9-2, N9-3, N9-4, N12-7).
 *
 * The brain has no schema_pack configured, so it resolves the bundled legacy
 * gbrain-base pack, exactly like brains created before `gbrain init` wrote one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract, extractStaleFromDB } from '../src/commands/extract.ts';
import { operations } from '../src/core/operations.ts';
import { buildRelationalArm, type RelationalArmMeta } from '../src/core/search/relational-recall.ts';
import { parseRelationalQuery } from '../src/core/search/relational-intent.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const alice = 'people/alice-example';
const bob = 'people/bob-example';
const company = 'companies/gamma-example';
const bodyMeeting = 'meetings/board-acme-example';
const fmMeeting = 'meetings/board-beta-example';

for (const kind of testBackends()) {
  describe(`schema-pack relation direction (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM links');
      await engine.executeRaw('DELETE FROM pages');
      expect(await engine.getConfig('schema_pack')).toBeNull();
    });

    async function seed(slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}) {
      await engine.putPage(slug, { type, title, compiled_truth: body, frontmatter });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `${title}. ${body}` }]);
    }
    async function seedRepro() {
      await seed(alice, 'person', 'Alice Example', 'Alice Example is a founder.');
      await seed(bob, 'person', 'Bob Example', 'Bob Example is an investor.');
      await seed(bodyMeeting, 'meeting', 'Acme Example Board Meeting',
        'Attendees: [Alice Example](people/alice-example), [Bob Example](people/bob-example).\n\nThe board reviewed the quarter.');
      await seed(fmMeeting, 'meeting', 'Beta Example Board Meeting', 'The board reviewed the quarter.', { attendees: [alice, bob] });
      await seed(company, 'company', 'Gamma Example', 'Gamma Example builds tools.', { investors: [bob] });
    }
    async function extract(args: string[]) {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try { await runExtract(engine, args); } finally { log.mockRestore(); }
    }
    async function typedEdges() {
      const rows = await engine.executeRaw<{ edge: string }>(`SELECT f.slug || ' -> ' || t.slug || ' (' || l.link_type || ', ' || l.link_source || ')' AS edge
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_type IN ('attended','invested_in') ORDER BY 1`);
      return rows.map(row => row.edge);
    }
    const expected = [
      `${alice} -> ${bodyMeeting} (attended, markdown)`,
      `${alice} -> ${fmMeeting} (attended, frontmatter)`,
      `${bob} -> ${company} (invested_in, frontmatter)`,
      `${bob} -> ${bodyMeeting} (attended, markdown)`,
      `${bob} -> ${fmMeeting} (attended, frontmatter)`,
    ];
    async function fanout(seedSlug: string, question: string) {
      const parsed = parseRelationalQuery(question)!;
      return (await engine.relationalFanout([seedSlug], { linkTypes: parsed.linkTypes, direction: parsed.direction, depth: 1, sourceId: 'default' }))
        .map(row => row.slug).sort();
    }

    test('db extraction stores declared incoming relations toward the company and meeting (N9-2, N9-3)', async () => {
      await seedRepro();
      await extract(['links', '--source', 'db', '--include-frontmatter']);
      expect(await typedEdges()).toEqual(expected);
      expect(await fanout(company, 'Who invested in Gamma Example?')).toEqual([bob]);
      expect(await fanout(bodyMeeting, 'Who attended Acme Example Board Meeting?')).toEqual([alice, bob]);
      expect(await fanout(fmMeeting, 'Who attended Beta Example Board Meeting?')).toEqual([alice, bob]);
    });

    test('local publication types only listed attendees as attended (N12-7)', async () => {
      await seed(alice, 'person', 'Alice Example', 'Alice Example.');
      await seed(bob, 'person', 'Bob Example', 'Bob Example.');
      const put = operations.find(op => op.name === 'put_page')!;
      const result = await put.handler({ engine, config: { engine: kind }, remote: false, sourceId: 'default', dryRun: false,
        logger: { info() {}, warn() {}, error() {} } }, { slug: 'meetings/sync',
        content: `---\ntype: meeting\ntitle: Sync\ndate: 2026-04-01\n---\n# Sync\n\n## Attendees\n\n- [[${alice}|Alice Example]]\n\n## Notes\n\n[[${bob}|Bob Example]] will send the deck.\n` }) as { auto_links: { errors: number } };
      expect(result.auto_links.errors).toBe(0);
      expect((await engine.getBacklinks('meetings/sync')).filter(l => l.link_type === 'attended').map(l => l.from_slug)).toEqual([alice]);
      expect((await engine.getLinks('meetings/sync')).filter(l => l.link_type === 'attended')).toEqual([]);
      expect((await engine.getLinks('meetings/sync')).find(l => l.to_slug === bob)?.link_type).toBe('mentions');
    });

    test('"Who attended <meeting title>?" resolves the meeting seed and fires (N9-4)', async () => {
      await seedRepro();
      await extract(['links', '--source', 'db', '--include-frontmatter']);
      let meta: RelationalArmMeta | undefined;
      const rows = await buildRelationalArm(engine, 'Who attended Acme Example Board Meeting?', { onMeta: m => { meta = m; } });
      expect(meta).toMatchObject({ fired: true, seeds_resolved: 1 });
      expect(rows.map(row => row.slug).sort()).toEqual([alice, bob]);
      expect(rows.every(row => row.relational_seed === bodyMeeting)).toBe(true);
    });

    test('meeting titles seed only relations that need them, and only when unique', async () => {
      await seedRepro();
      await extract(['links', '--source', 'db', '--include-frontmatter']);
      let meta: RelationalArmMeta | undefined;
      await buildRelationalArm(engine, 'Who invested in Acme Example Board Meeting?', { onMeta: m => { meta = m; } });
      expect(meta).toMatchObject({ fired: false, seeds_resolved: 0 });
      await seed('meetings/board-acme-example-2', 'meeting', 'Acme Example Board Meeting', 'A second meeting with the same title.');
      await buildRelationalArm(engine, 'Who attended Acme Example Board Meeting?', { onMeta: m => { meta = m; } });
      expect(meta).toMatchObject({ fired: false, seeds_resolved: 0 });
    });

    async function insertPreFixEdges() {
      // What extraction under the legacy pack wrote before the fix: incoming
      // frontmatter mappings stored page -> target, body attendance stored
      // meeting -> person with no origin, and a notes-only mention typed attended.
      await engine.addLinksBatch([
        { from_slug: company, to_slug: bob, link_type: 'invested_in', link_source: 'frontmatter', origin_slug: company, origin_field: 'investors', context: `frontmatter.investors: ${bob}` },
        { from_slug: fmMeeting, to_slug: alice, link_type: 'attended', link_source: 'frontmatter', origin_slug: fmMeeting, origin_field: 'attendees', context: `frontmatter.attendees: ${alice}` },
        { from_slug: fmMeeting, to_slug: bob, link_type: 'attended', link_source: 'frontmatter', origin_slug: fmMeeting, origin_field: 'attendees', context: `frontmatter.attendees: ${bob}` },
        { from_slug: bodyMeeting, to_slug: alice, link_type: 'attended', link_source: 'markdown', context: 'Attendees: [Alice Example]' },
        { from_slug: bodyMeeting, to_slug: bob, link_type: 'attended', link_source: 'markdown', context: 'Attendees: [Bob Example]' },
        { from_slug: 'meetings/sync', to_slug: bob, link_type: 'attended', link_source: 'markdown', context: 'Bob Example will send the deck.' },
      ]);
    }

    test('re-derivation: extract links --source db --include-frontmatter rewrites stored pre-fix edges', async () => {
      await seedRepro();
      await seed('meetings/sync', 'meeting', 'Sync', `## Attendees\n\n- [[${alice}|Alice Example]]\n\n## Notes\n\n[[${bob}|Bob Example]] will send the deck.\n`);
      await insertPreFixEdges();
      await extract(['links', '--source', 'db', '--include-frontmatter']);
      expect(await typedEdges()).toEqual([...expected, `${alice} -> meetings/sync (attended, markdown)`].sort());
      expect((await engine.getLinks('meetings/sync')).find(l => l.to_slug === bob)?.link_type).toBe('mentions');
    });

    test('re-derivation: the extractor version bump makes extract --stale rewrite pages stamped before it', async () => {
      await seedRepro();
      await insertPreFixEdges();
      // Stamped by the pre-fix extractor after its own watermark (2026-09-30T00:00:00Z).
      const before = '2026-09-30T12:00:00Z';
      expect(Date.parse(LINK_EXTRACTOR_VERSION_TS)).toBeGreaterThan(Date.parse(before));
      await engine.executeRaw(`UPDATE pages SET updated_at=$1::timestamptz - interval '1 day', links_extracted_at=$1::timestamptz`, [before]);
      const result = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, includeFrontmatter: true, catchUp: true });
      expect(result.pagesProcessed).toBe(5);
      expect(await typedEdges()).toEqual(expected);
      const stale = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE links_extracted_at < $1::timestamptz', [LINK_EXTRACTOR_VERSION_TS]);
      expect(stale[0].n).toBe(0);
    });
  });
}
