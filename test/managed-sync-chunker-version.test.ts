/**
 * #5566: managed sync stamps `sources.chunker_version` when its run walked the
 * whole tree (first sync or --full), as the legacy chunker gate does, so a
 * quiet managed source reaches doctor sync_freshness's `unchanged` bucket
 * instead of aging into "brain search is stale!". An incremental run leaves
 * the stamp alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { checkSyncFreshness } from '../src/commands/doctor.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_url: '' }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root: string, path: string, body: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), `---\ntitle: ${path}\ntype: note\n---\n${body}\n`);
  git(root, 'add', '.'); git(root, 'commit', '-qm', `add ${path}`);
}

for (const backend of backends) {
  test(`${backend}: a managed full walk stamps sources.chunker_version; an incremental run does not (#5566)`, async () => {
    const engine = engines[backends.indexOf(backend)];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-chunker-')); dirs.push(dir);
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    commit(root, 'notes/first.md', 'A quiet source.');
    const sourceId = `quiet-${backend}`;
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,chunker_version) VALUES($1,$1,$2,$3)', [sourceId, root, '6']);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const stamp = async () => (await engine.executeRaw<{ v: string | null }>('SELECT chunker_version AS v FROM sources WHERE id=$1', [sourceId]))[0].v;
        await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        expect(await stamp()).toBe(chunkerStamp());

        await engine.executeRaw("UPDATE sources SET chunker_version='6' WHERE id=$1", [sourceId]);
        commit(root, 'notes/second.md', 'An incremental change.');
        await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        expect(await stamp()).toBe('6');

        const full = await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, full: true });
        expect(full.status).not.toBe('blocked_by_failures');
        expect(await stamp()).toBe(chunkerStamp());

        // The reporter's symptom: 80 h after a successful sync of an unchanged repo, doctor stays ok.
        const later = Date.now() + 80 * 3_600_000;
        const result = await checkSyncFreshness(engine, { localOnly: true, nowMs: later });
        expect(result.status).toBe('ok');
        expect(result.details).toMatchObject({ unchanged_count: 1, stale_count: 0 });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      }
    });
  }, 120_000);
}
