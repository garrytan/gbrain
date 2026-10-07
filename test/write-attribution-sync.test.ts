/**
 * Foundations 2 (Lane C) sync rename attribution on an unmanaged brain: the
 * legacy sync's cheap rename and a full sync's move of a held rename advance
 * the page revision (the slug changes) inside maintenanceTransaction, so the
 * moved page names the local maintenance principal instead of `unrecorded`.
 * The facts that follow the page (`moveSlugBindings`) keep their creator and
 * move their last writer.
 *
 * Protects the sync rename writer family in docs/architecture/system-of-record.md.
 * Fails if `src/commands/sync/renames.ts` or `src/commands/sync/holds.ts`
 * renames outside maintenanceTransaction. Runs on PGLite, and on Postgres
 * (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { CREATOR_ACTOR, asCreator, revisionActor, rowActors, unmanagedBrain, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-sync-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const BODY = Array.from({ length: 30 }, (_, i) => `Line ${i} of a synthetic note that keeps the rename detectable.`).join('\n');
const NOTE = `---\ntitle: Renamed example\n---\n${BODY}\n`;
const BROKEN = `---\ntitle: alice-example first line\nalice-example second line\n---\n${BODY}\n`;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

async function gitSource(engine: BrainEngine): Promise<UnmanagedBrain & { root: string }> {
  const brain = await unmanagedBrain(engine);
  const root = join(home, brain.sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true }); await makeGitFixture(root);
  await engine.executeRaw("UPDATE sources SET local_path=$2, config='{}' WHERE id=$1", [brain.sourceId, root]);
  return { ...brain, root };
}
function commit(root: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', message);
}
// concurrency 1: parallel full-sync workers would connect to the configured database, not this isolated one.
const sync = (brain: UnmanagedBrain & { root: string }, extra: Record<string, unknown> = {}) => performSync(brain.engine,
  { repoPath: brain.root, sourceId: brain.sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, ...extra });
const pageId = async (engine: BrainEngine, sourceId: string, slug: string) =>
  (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]?.id;

describe('sync rename attribution on an unmanaged brain', () => {
  test('an incremental sync rename moves the page and its facts under the maintenance principal', () => withEnv(env, async () => {
    for (const engine of engines) {
      const brain = await gitSource(engine);
      commit(brain.root, { 'notes/old-example.md': NOTE }, 'add');
      await sync(brain);
      const id = await pageId(engine, brain.sourceId, 'notes/old-example');
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source)
        VALUES ($1, 'notes/old-example', 'Keeps its creator through a rename', 'fact', 'test')`, [brain.sourceId]));

      git(brain.root, 'mv', 'notes/old-example.md', 'notes/new-example.md');
      git(brain.root, 'commit', '-qm', 'rename');
      await sync(brain);

      expect(await pageId(engine, brain.sourceId, 'notes/new-example')).toBe(id);
      expect(await revisionActor(engine, brain.sourceId, 'notes/new-example')).toEqual(brain.maintenance);
      expect((await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId])).map(({ created, last }) => ({ created, last })))
        .toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }), 120_000);

  test('a full sync moves a held rename once its file screens clean under the maintenance principal', () => withEnv(env, async () => {
    for (const engine of engines) {
      const brain = await gitSource(engine);
      commit(brain.root, { 'notes/held-old.md': NOTE }, 'add');
      await sync(brain);
      const id = await pageId(engine, brain.sourceId, 'notes/held-old');
      git(brain.root, 'mv', 'notes/held-old.md', 'notes/held-new.md');
      commit(brain.root, { 'notes/held-new.md': BROKEN }, 'rename onto a broken file');
      await sync(brain);
      expect(await pageId(engine, brain.sourceId, 'notes/held-new')).toBeUndefined();

      writeFileSync(join(brain.root, 'notes/held-new.md'), NOTE);
      git(brain.root, 'add', '-A'); git(brain.root, 'commit', '-qm', 'fix the renamed file');
      await sync(brain, { full: true });

      expect(await pageId(engine, brain.sourceId, 'notes/held-new')).toBe(id);
      expect(await revisionActor(engine, brain.sourceId, 'notes/held-new')).toEqual(brain.maintenance);
    }
  }), 120_000);
});
