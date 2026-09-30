/**
 * Refactor wave 1 EO3 / T-G2: shared definitions for the pinned PGLite
 * upgrade-replay fixture.
 *
 * `scripts/build-pglite-upgrade-fixture.ts` builds a file-backed PGLite brain
 * with the code at HEAD (fresh `initSchema()` + a small generic corpus) and
 * tars its data dir to `UPGRADE_FIXTURE_TARBALL`, with `UPGRADE_FIXTURE_MANIFEST`
 * recording versions and the data it wrote. `test/pglite-upgrade-replay.test.ts`
 * opens that brain with the current code and asserts the upgrade boot and a
 * repeat boot leave schema and data intact. Both sides use `fixtureDataStats`
 * so the manifest and the test measure data the same way.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { GOLDENS_DIR } from './golden.ts';

export const UPGRADE_FIXTURE_DIR = join(GOLDENS_DIR, 'pglite-upgrade-replay');
export const UPGRADE_FIXTURE_TARBALL = join(UPGRADE_FIXTURE_DIR, 'brain.tar.gz');
export const UPGRADE_FIXTURE_MANIFEST = join(UPGRADE_FIXTURE_DIR, 'MANIFEST.json');
/** Directory name inside the tarball that holds the PGLite data dir. */
export const UPGRADE_FIXTURE_BRAIN_DIR = 'brain';

export interface UpgradeFixtureManifest {
  gbrain_version: string;
  schema_version: number;
  latest_migration_version: number;
  pglite_version: string;
  embedding_model: string;
  embedding_dimensions: number;
  build_command: string;
  data: FixtureDataStats;
}

export interface FixtureDataStats {
  counts: Record<string, number>;
  /** sha256 over the corpus rows (slugs, text, embeddings) in a fixed order. */
  fingerprint: string;
}

/** Tables the fixture corpus populates, counted before and after every boot. */
export const FIXTURE_COUNTED_TABLES = [
  'sources',
  'pages',
  'content_chunks',
  'links',
  'tags',
  'timeline_entries',
  'facts',
  'takes',
] as const;

const FINGERPRINT_QUERIES = [
  `SELECT source_id, slug, type, title, compiled_truth, timeline FROM pages ORDER BY source_id, slug`,
  `SELECT p.slug, c.chunk_index, c.chunk_source, c.chunk_text, c.embedding::text AS embedding
     FROM content_chunks c JOIN pages p ON p.id = c.page_id ORDER BY p.slug, c.chunk_index`,
  `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.context
     FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
     ORDER BY 1, 2, 3`,
  `SELECT p.slug, g.tag FROM tags g JOIN pages p ON p.id = g.page_id ORDER BY 1, 2`,
  `SELECT p.slug, e.date::text AS date, e.summary, e.detail
     FROM timeline_entries e JOIN pages p ON p.id = e.page_id ORDER BY 1, 2, 3`,
  `SELECT entity_slug, kind, fact, embedding::text AS embedding FROM facts ORDER BY entity_slug, fact`,
  `SELECT p.slug, t.row_num, t.claim, t.kind, t.holder FROM takes t JOIN pages p ON p.id = t.page_id ORDER BY 1, 2`,
];

export async function fixtureDataStats(engine: PGLiteEngine): Promise<FixtureDataStats> {
  const counts: Record<string, number> = {};
  for (const table of FIXTURE_COUNTED_TABLES) {
    const { rows } = await engine.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = Number(rows[0]!.n);
  }
  const hash = createHash('sha256');
  for (const sql of FINGERPRINT_QUERIES) {
    const { rows } = await engine.db.query(sql);
    hash.update(JSON.stringify(rows));
    hash.update('\n');
  }
  return { counts, fingerprint: hash.digest('hex') };
}
