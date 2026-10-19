/**
 * Bare `[[name]]` wikilinks across sources in the DB extract paths.
 *
 * Protects: with `link_resolution.global_basename` and `link_resolution.cross_source` both on,
 * `extract links --source db` and the unmanaged `extract --stale` sweep write the edge from a
 * page in one source to the only page with that basename in another source — the case
 * docs/architecture/brains-and-sources.md describes ("typically via global_basename"). With
 * cross_source off the bare name stays source-isolated (#972), exactly as before.
 * Fails when: the batch resolver's basename index is scoped to the page's own source while
 * cross_source is on (since #5309 each source gets its own resolver), so the foreign page is
 * never a candidate and the edge is silently missing.
 * Why existing coverage misses it: test/link-cross-source.test.ts and
 * test/extract-cross-source-links-db.serial.test.ts link slug-shaped targets
 * (`[[topics/x]]`, `[[people/x]]`), which never consult the basename index.
 * Seams: none (production entry points only). PGLite always, Postgres when DATABASE_URL
 * is set (test/postgres-unit-arms.txt lane).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const BASENAME = { GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME: '1' };
const ON = { ...BASENAME, GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' };
const OFF = { ...BASENAME, GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined };
const CROSS = 'alpha:notes/standup > beta:projects/widget-example';

async function page(engine: BrainEngine, sourceId: string, slug: string, type: string, body = 'A page.') {
  await engine.putPage(slug, { type, title: slug.split('/').pop()!, compiled_truth: body, frontmatter: {} }, { sourceId });
}

/** Every outbound edge of alpha:notes/standup as `from > to`. */
async function edges(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ edge: string }>(`SELECT f.source_id||':'||f.slug||' > '||t.source_id||':'||t.slug AS edge
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id='alpha' AND f.slug='notes/standup'`);
  return rows.map(row => row.edge).sort();
}

/** `extract links --source db`, its summary lines kept off the test output. */
async function extractLinksDb(engine: BrainEngine) {
  const log = console.log;
  console.log = () => {};
  try { await runExtract(engine, ['links', '--source', 'db']); } finally { console.log = log; }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: bare [[basename]] wikilinks across sources in the DB extract paths`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('alpha','alpha','{}'),('beta','beta','{}')`);
      await page(engine, 'beta', 'projects/widget-example', 'project');
      await page(engine, 'alpha', 'notes/standup', 'note', 'Shipped the parser for [[widget-example]] today.');
    }, 120_000);
    afterAll(async () => { await close(); });
    // Every test starts from an unlinked, link-stale origin page.
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM links`);
      await engine.executeRaw(`UPDATE pages SET links_extracted_at=NULL`);
    });

    test('cross_source off: the bare name stays inside its source (#972 isolation unchanged)', () => withEnv(OFF, async () => {
      await extractLinksDb(engine);
      expect(await edges(engine)).toEqual([]);
    }), 60_000);

    test('cross_source on: extract links --source db links the only page with that basename in another source', () => withEnv(ON, async () => {
      await extractLinksDb(engine);
      expect(await edges(engine)).toEqual([CROSS]);
    }), 60_000);

    test('cross_source on: the extract --stale sweep writes the same edge', () => withEnv(ON, async () => {
      const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
      expect(r.pagesProcessed).toBe(2);
      expect(await edges(engine)).toEqual([CROSS]);
    }), 60_000);
  });
}
