/**
 * The search `stale` flag on the Postgres CJK keyword path for a role that may and a role that may not read
 * timeline_entries.
 *
 * 1. Protects: a CJK query to keyword or chunk search on Postgres (the term-by-term ILIKE path in
 *    engine-sql/cjk-search.ts, full and capped stages) marks a page stale when one of its timeline entries is newer
 *    than the page, and a login with only the docs/ENGINES.md reader-role grants, which name no timeline_entries,
 *    still gets every row, each with stale false.
 * 2. Fails when: the CJK statements name timeline_entries for a role without SELECT on it (42501 from every CJK
 *    search), or they stop computing the flag for a role that may read the table.
 * 3. Real seams: the engine's own search methods on a connection logged in as the reader, and the ENGINES.md reader
 *    GRANT line applied verbatim.
 * Run: DATABASE_URL=... bun test test/e2e/search-stale-reader-role-cjk-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { chunk, seedPage } from '../engine-parity/chunk-fixtures.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
const READER = `gbrain_cjk_reader_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const QUERY = '翠鸟栖息';

/** The reader-role GRANT statement of docs/ENGINES.md for `role`. */
function docsReaderGrant(role: string): string {
  const doc = readFileSync(new URL('../../docs/ENGINES.md', import.meta.url), 'utf8');
  const grant = doc.match(/GRANT SELECT ON pages, [^;]*TO <reader-role>;/)?.[0];
  if (!grant) throw new Error('docs/ENGINES.md has no reader-role GRANT line');
  return grant.replaceAll('<reader-role>', role);
}

describeE2E('CJK keyword search stale flag for a role without SELECT on timeline_entries (Postgres)', () => {
  let admin: PostgresEngine;
  let reader: PostgresEngine | undefined;
  let close: () => Promise<void>;
  let databaseUrl = '';

  beforeAll(async () => {
    ({ engine: admin, databaseUrl, close } = await isolatedPersistencePostgres(DATABASE_URL!));
    for (const slug of ['notes/cjk-fresh', 'notes/cjk-stale']) {
      const text = `${QUERY}的记录 ${slug.slice(10)}`;
      const page = { type: 'note' as const, title: `翠鸟 ${slug.slice(10)}`, compiled_truth: text, timeline: '' };
      await seedPage(admin, { slug, input: page, chunks: [chunk(0, text)] });
    }
    // The entry's created_at must be later than the page's updated_at.
    await new Promise(r => setTimeout(r, 5));
    await admin.addTimelineEntry('notes/cjk-stale', { date: '2026-01-02', summary: '翠鸟计数', detail: '' });

    await admin.executeRaw(`CREATE ROLE ${READER} LOGIN PASSWORD 'cjk-example' NOSUPERUSER NOBYPASSRLS`);
    await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${READER}`);
    const grant = docsReaderGrant(READER);
    expect(grant).not.toContain('timeline_entries');
    await admin.executeRaw(grant);
    // ENGINES.md: "The other tables it reads (config, ...) need policies of their own"; connecting reads config.
    await admin.executeRaw(`GRANT SELECT ON config TO ${READER}`);
    const tables = [...grant.matchAll(/\b(pages|content_chunks|page_body_manifest|page_segment_texts|page_view_digests|sources)\b/g)].map(m => m[1]!);
    for (const table of [...new Set(tables), 'config']) {
      await admin.executeRaw(`CREATE POLICY ${READER}_read ON ${table} FOR SELECT TO ${READER} USING (true)`);
    }
    const url = new URL(databaseUrl); url.username = READER; url.password = 'cjk-example';
    reader = new PostgresEngine();
    await reader.connect({ database_url: url.toString(), poolSize: 2 });
  }, 240_000);

  afterAll(async () => {
    await reader?.disconnect().catch(() => undefined);
    if (!admin) return;
    const me = (await admin.executeRaw<{ u: string }>('SELECT current_user AS u'))[0]!.u;
    await admin.executeRaw(`REASSIGN OWNED BY ${READER} TO ${me}`).catch(() => undefined);
    await admin.executeRaw(`DROP OWNED BY ${READER}`).catch(() => undefined);
    await close();
    const { default: postgres } = await import('#postgres');
    const sql = postgres(DATABASE_URL!, { max: 1, prepare: false });
    await sql.unsafe(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined);
    await sql.end();
  }, 120_000);

  const view = (rows: SearchResult[]) => [...new Set(rows.map(r => `${r.slug} ${r.stale === true}`))].sort();
  // fullBudgetMs 0 skips the full stage, so `capped` runs the candidate stage and its row statement.
  const capped = { cjkKeyword: { deadlineMs: 30_000, fullBudgetMs: 0 } };
  const searches = async (engine: BrainEngine) => ({
    keyword: view(await engine.searchKeyword(QUERY, { limit: 10 })),
    chunks: view(await engine.searchKeywordChunks(QUERY, { limit: 10 })),
    keywordCapped: view(await engine.searchKeyword(QUERY, { limit: 10, ...capped })),
    chunksCapped: view(await engine.searchKeywordChunks(QUERY, { limit: 10, ...capped })),
  });

  test('a role that may read timeline_entries gets the real flag from every CJK search', async () => {
    const marked = ['notes/cjk-fresh false', 'notes/cjk-stale true'];
    expect(await searches(admin)).toEqual({ keyword: marked, chunks: marked, keywordCapped: marked, chunksCapped: marked });
  });

  test('the ENGINES.md reader role still searches CJK text and gets stale false', async () => {
    const [access] = await reader!.executeRaw<{ readable: boolean }>(`SELECT has_table_privilege('timeline_entries', 'SELECT') AS readable`);
    expect(access!.readable).toBe(false);
    const unmarked = ['notes/cjk-fresh false', 'notes/cjk-stale false'];
    expect(await searches(reader!)).toEqual({ keyword: unmarked, chunks: unmarked, keywordCapped: unmarked, chunksCapped: unmarked });
  });
});
