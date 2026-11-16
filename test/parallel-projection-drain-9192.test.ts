/**
 * #9192: 'gbrain projections drain' rebuilds the pages search does not answer for first, then the pages it still answers
 * for from their pre-upgrade index, and on Postgres rebuilds several pages at once. A refused extra connection lowers
 * the count and the drain finishes; PGLite stays at one page at a time.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { drainProjections, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { drainConcurrency, textRebuildDuration } from '../src/core/page-state/rebuild-estimate.ts';
import { ACTIVATION_SERVED_REVISION } from '../src/core/search/safe-chunks.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

const ANSWERING = Array.from({ length: 8 }, (_, i) => `notes/answering-${i}`);
const WAITING = Array.from({ length: 5 }, (_, i) => `notes/waiting-${i}`);
const body = (slug: string) => `# ${slug}\n\nThe okapi theremin note for ${slug}, with a second sentence so the chunk has some length.`;
const statements = (sql: string) => sql.split(';').map(s => s.trim()).filter(Boolean);

/** Pages activated by v153: ANSWERING keep serving their pre-upgrade index, WAITING (indexed before the safe-chunk fence) are out of search. */
async function seed(engine: BrainEngine) {
  for (const slug of [...ANSWERING, ...WAITING]) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body(slug) });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body(slug) }]);
  }
  await engine.executeRaw('UPDATE pages SET chunker_version = 3 WHERE slug = ANY($1::text[])', [WAITING]);
  for (const statement of statements(PAGE_PROJECTION_ACTIVATION_SQL)) await engine.executeRaw(statement);
}
const states = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; state: string }>(`SELECT slug,
    CASE WHEN text_projection_revision = knowledge_revision THEN 'rebuilt'
      WHEN text_projection_revision = '${ACTIVATION_SERVED_REVISION}'::uuid THEN 'answering' ELSE 'waiting' END AS state
  FROM pages ORDER BY slug`)).map(r => [r.slug, r.state]));
const chunks = async (engine: BrainEngine) => engine.executeRaw<{ slug: string; chunk_index: number; text: string }>(`SELECT p.slug, c.chunk_index, md5(c.chunk_text) AS text
  FROM pages p JOIN content_chunks c ON c.page_id = p.id ORDER BY p.slug, c.chunk_index`);

for (const backend of testBackends()) {
  const url = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#9192 parallel projection drain (${backend})`, () => {
    test('every page out of search is rebuilt before any page that still answers', async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(url);
      try {
        await seed(engine);
        const before = await states(engine);
        expect(WAITING.map(s => before[s])).toEqual(WAITING.map(() => 'waiting'));
        expect(ANSWERING.map(s => before[s])).toEqual(ANSWERING.map(() => 'answering'));
        const first = await drainProjections(engine, { limit: WAITING.length, concurrency: drainConcurrency(engine).default });
        expect(first.rebuilt).toBe(WAITING.length);
        const mid = await states(engine);
        expect(WAITING.map(s => mid[s])).toEqual(WAITING.map(() => 'rebuilt'));
        expect(ANSWERING.map(s => mid[s])).toEqual(ANSWERING.map(() => 'answering'));
        const rest = await drainProjections(engine, { concurrency: drainConcurrency(engine).default });
        expect(rest).toMatchObject({ rebuilt: ANSWERING.length, failed: [], remaining: 0 });
        expect(Object.values(await states(engine)).every(s => s === 'rebuilt')).toBe(true);
      } finally { await close(); }
    }, 120_000);

    test('several pages at once build the same chunks as one at a time', async () => {
      const one = await isolatedSharedSkillsEngine(url);
      const many = await isolatedSharedSkillsEngine(url);
      try {
        await seed(one.engine);
        await seed(many.engine);
        expect(await drainProjections(one.engine, { concurrency: 1 })).toMatchObject({ rebuilt: 13, failed: [], remaining: 0 });
        // PGLite has one connection: a requested width of 4 still rebuilds one page at a time.
        expect(await drainProjections(many.engine, { concurrency: 4 })).toMatchObject({ rebuilt: 13, failed: [], remaining: 0 });
        expect(await chunks(many.engine)).toEqual(await chunks(one.engine));
      } finally { await one.close(); await many.close(); }
    }, 120_000);
  });
}

describe('drain width', () => {
  test('PGLite drains one page at a time; Postgres defaults to at most 4 and keeps two pool connections free', () => {
    expect(drainConcurrency({ kind: 'pglite' } as BrainEngine)).toEqual({ default: 1, max: 1 });
    const pg = (max: number) => ({ kind: 'postgres', sql: { options: { max } } }) as unknown as BrainEngine;
    expect(drainConcurrency(pg(10))).toEqual({ default: 4, max: 8 });
    expect(drainConcurrency(pg(4))).toEqual({ default: 2, max: 2 });
    expect(drainConcurrency(pg(2))).toEqual({ default: 1, max: 1 });
    expect(drainConcurrency(pg(30))).toEqual({ default: 4, max: 28 });
  });
  test('the estimate divides by the pages rebuilt at once', () => {
    expect(textRebuildDuration(50_000, 18, 1)).toBe('9 hour(s)');
    expect(textRebuildDuration(50_000, 18, 4)).toBe('2 hour(s)');
  });
});

const pgUrl = testBackends().includes('postgres') ? process.env.DATABASE_URL : undefined;
describe.skipIf(!pgUrl)('a refused connection (Postgres)', () => {
  test('a database that admits only 2 connections lowers the width and the drain finishes', async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(pgUrl);
    const role = `gbrain_test_cap_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const database = new URL((engine as PostgresEngine).connectedDatabaseUrl!).pathname.slice(1);
    const admin = postgres(pgUrl!, { max: 1, prepare: false });
    const capped = new PostgresEngine();
    try {
      await seed(engine);
      await admin.unsafe(`CREATE ROLE ${role} LOGIN BYPASSRLS PASSWORD 'cap' CONNECTION LIMIT 2`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role};
        GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
      const url = new URL(pgUrl!);
      url.username = role;
      url.password = 'cap';
      url.pathname = `/${database}`;
      await capped.connect({ database_url: url.toString(), poolSize: 6 });
      expect(drainConcurrency(capped)).toEqual({ default: 4, max: 4 });
      const narrowed: number[] = [];
      const result = await drainProjections(capped, { concurrency: 4, onNarrow: n => { narrowed.push(n); } });
      expect(result).toMatchObject({ rebuilt: 13, failed: [], remaining: 0 });
      expect(narrowed.length).toBeGreaterThan(0);
      expect(Math.min(...narrowed)).toBeLessThanOrEqual(2);
      expect(Object.values(await states(engine)).every(s => s === 'rebuilt')).toBe(true);
    } finally {
      await capped.disconnect();
      await close();
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  }, 120_000);
});

describe.skipIf(!pgUrl)('a dropped connection after other workers finished (Postgres)', () => {
  test('the lowered width counts lost connections, not workers that ran out of pages', async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(pgUrl);
    try {
      await seed(engine);
      const rebuiltWaiting = async () => (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages
        WHERE slug = ANY($1::text[]) AND text_projection_revision = knowledge_revision`, [WAITING]))[0]!.n;
      const original = engine.transaction.bind(engine);
      let calls = 0;
      let dropped!: () => void;
      const afterDrop = new Promise<void>(resolve => { dropped = resolve; });
      engine.transaction = (async (fn: Parameters<BrainEngine['transaction']>[0]) => {
        const call = ++calls;
        if (call === 3) {
          const deadline = Date.now() + 60_000;
          while (await rebuiltWaiting() < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
          await new Promise(r => setTimeout(r, 0));
          dropped();
          throw Object.assign(new Error('write CONNECTION_ENDED 127.0.0.1:5432'), { code: 'CONNECTION_ENDED' });
        }
        if (call === 4) await afterDrop;
        return original(fn);
      }) as BrainEngine['transaction'];
      const narrowed: number[] = [];
      const batch = await rebuildPendingPageProjections(engine, 4, { served: 'waiting', concurrency: 4, onNarrow: n => { narrowed.push(n); } });
      expect(batch.rebuilt).toBe(4);
      expect(narrowed).toEqual([3]);
    } finally { await close(); }
  }, 120_000);
});
