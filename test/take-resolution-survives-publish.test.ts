/**
 * A take resolution recorded only in the database (unmanaged `grade_takes`
 * auto-resolve, `cycle/grade-takes.ts`) survives the page's next publication.
 *
 * Protects: an ordinary put_page, and a revert to a version from before the
 * grade, whose takes fence carries no resolution cells keep the stored
 * resolution of a take whose claim is unchanged; a claim edited in place at
 * the same row number drops the old claim's resolution; a fence that carries
 * resolution cells still writes them.
 * Fails when: the canonical projection writes every resolution column from
 * the fence unconditionally (it nulled database-only grades on every publish).
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'concepts/graded-take';
const takesFence = (first: string, resolution?: string) => [
  '## Takes', '', '<!--- gbrain:takes:begin -->',
  resolution
    ? '| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |'
    : '| # | claim | kind | who | weight | since | source |',
  resolution ? '|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|' : '|---|-------|------|-----|--------|-------|--------|',
  resolution ? `| 1 | ${first} | bet | brain | 0.6 |  | manual | ${resolution} |` : `| 1 | ${first} | bet | brain | 0.6 |  | manual |`,
  resolution ? '| 2 | a second open take | bet | brain | 0.4 |  | manual |  |  |  |  |  |  |' : '| 2 | a second open take | bet | brain | 0.4 |  | manual |',
  '<!--- gbrain:takes:end -->',
].join('\n');
const page = (prose: string, fence: string) => `---\ntype: concept\ntitle: Graded take\n---\n${prose}\n\n${fence}\n`;

for (const backend of testBackends()) {
  describe(`${backend}: take resolutions recorded only in the database`, () => {
    let engine: BrainEngine;
    let ctx: OperationContext;
    const sourceId = `take-resolution-${randomUUID().slice(0, 8)}`;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-take-resolution-'));
    const root = join(dir, 'brain');
    const home = { GBRAIN_HOME: join(dir, 'home') };
    const submit = async (operation: string, params: Record<string, unknown>) => {
      const result = await withEnv(home, () => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), force: true, ...params } }));
      expect(result.state).toBe('committed');
      return result;
    };
    const resolutions = () => engine.executeRaw<{ row_num: number; claim: string; resolved_quality: string | null; resolved_source: string | null; resolved_by: string | null }>(
      `SELECT t.row_num, t.claim, t.resolved_quality, t.resolved_source, t.resolved_by FROM takes t JOIN pages p ON p.id = t.page_id
        WHERE p.source_id = $1 AND p.slug = $2 ORDER BY t.row_num`, [sourceId, SLUG]);
    const gradeInDatabase = async () => {
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, SLUG]);
      await maintenanceTransaction(engine, tx => tx.resolveTake(id, 1, { quality: 'correct', source: 'grader note', resolvedBy: 'system' }));
    };

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
      ctx = { engine, config: { engine: backend }, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      mkdirSync(root);
      await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [sourceId, root]);
      await withEnv(home, () => claimWorktree(engine, sourceId, root));
      await submit('put_page', { slug: SLUG, content: page('First prose.', takesFence('an earlier graded take')) });
      await gradeInDatabase();
    }, 180_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    });

    test('a prose edit keeps the grade and leaves the open take open', async () => {
      await submit('put_page', { slug: SLUG, content: page('Edited prose.', takesFence('an earlier graded take')) });
      expect(await resolutions()).toEqual([
        { row_num: 1, claim: 'an earlier graded take', resolved_quality: 'correct', resolved_source: 'grader note', resolved_by: 'system' },
        { row_num: 2, claim: 'a second open take', resolved_quality: null, resolved_source: null, resolved_by: null },
      ]);
    }, 60_000);

    test('a revert to a version from before the grade keeps the grade', async () => {
      const [version] = await engine.executeRaw<{ id: number }>(`SELECT v.id FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth LIKE '%First prose.%' ORDER BY v.id LIMIT 1`, [sourceId, SLUG]);
      await submit('revert_version', { slug: SLUG, version_id: Number(version.id) });
      expect((await resolutions())[0]).toMatchObject({ claim: 'an earlier graded take', resolved_quality: 'correct', resolved_source: 'grader note' });
    }, 60_000);

    test('a fence that carries resolution cells writes them', async () => {
      await submit('put_page', { slug: SLUG, content: page('Fence-carried grade.', takesFence('an earlier graded take', '2026-10-01 | incorrect | fence note |  |  | owner')) });
      expect((await resolutions())[0]).toMatchObject({ resolved_quality: 'incorrect', resolved_source: 'fence note', resolved_by: 'owner' });
    }, 60_000);

    test('a claim edited in place drops the old claim\'s grade', async () => {
      await submit('put_page', { slug: SLUG, content: page('Claim rewritten.', takesFence('a different claim at the same row')) });
      expect((await resolutions())[0]).toEqual({ row_num: 1, claim: 'a different claim at the same row', resolved_quality: null, resolved_source: null, resolved_by: null });
    }, 60_000);
  });
}
