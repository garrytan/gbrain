/**
 * #6858 ask 6 (option C): a real managed source end to end. The serve-style watcher (default seams: the flag from
 * config, the owned managed sources from the bindings, `git rev-parse HEAD`, the drain lease, and the unchanged
 * `startDelegatedSync` with this host's cli registration) picks up a new commit and the page becomes searchable without
 * any manual sync; the freshness reader then reports commit→searchable for that run. PGLite always; Postgres when
 * DATABASE_URL is set (test/postgres-unit-arms.txt). Serial: the delegated-sync runner is a module singleton.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __resetDelegatedSyncForTests, isDelegatedSyncRunning } from '../src/core/serve-sync-runner.ts';
import { startServeHeadWatcher } from '../src/core/serve-head-watcher.ts';
import { readSyncFreshness } from '../src/core/persistence/sync-freshness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-on-commit-'));
const engines: Array<{ name: string; engine: BrainEngine }> = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, file: string, body: string): string {
  writeFileSync(join(root, file), body);
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', `add ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
async function fixture(engine: BrainEngine): Promise<{ id: string; root: string }> {
  const id = `oncommit-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  commit(root, 'notes/alice-example.md', '---\ntitle: Alice Example\n---\nAlice Example keeps the acme-example ledger.\n');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
async function until(what: string, fn: () => Promise<boolean>, timeoutMs = 150_000, lines: string[] = []): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; watcher log: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}
const searchable = async (engine: BrainEngine, word: string, slug: string) =>
  (await engine.searchKeyword(word, { limit: 20 })).some(r => r.slug === slug);

beforeAll(async () => {
  // An earlier file in the same process may have run a serve shutdown, which leaves the runner refusing starts.
  __resetDelegatedSyncForTests();
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push({ name: 'postgres', engine: pg.engine }); closePostgres = pg.close; }
}, 120_000);
afterEach(() => { __resetDelegatedSyncForTests(); });
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { engine } of engines) {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
      if (engine.kind === 'pglite') await engine.disconnect();
    }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('with sync.on_commit on, a new commit becomes searchable without a manual sync, and freshness reports it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const { name, engine } of engines) {
    const f = await fixture(engine);
    const first = git(f.root, 'rev-parse', 'HEAD');
    await engine.setConfig('sync.on_commit', 'true');
    const lines: string[] = [];
    const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 200, debounceMs: 200 });
    try {
      await until(`${name}: the first sync`, async () => searchable(engine, 'ledger', 'notes/alice-example'), 150_000, lines);
      await until(`${name}: the first sync to settle`, async () => !isDelegatedSyncRunning()
        && (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]?.last_commit === first);
      const head = commit(f.root, 'notes/acme-example.md', '---\ntitle: Acme Example\n---\nAcme Example ships the quarterly zeppelin report.\n');
      await until(`${name}: the commit to become searchable`, async () => searchable(engine, 'zeppelin', 'notes/acme-example'));
      await until(`${name}: the sync to settle`, async () => !isDelegatedSyncRunning()
        && (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]?.last_commit === head);
      expect(lines.filter(l => l.includes('started managed sync job')).length).toBeGreaterThanOrEqual(2);
      expect(lines.some(l => /failed|refused/.test(l))).toBe(false);
      expect(git(f.root, 'status', '--porcelain')).toBe('');
      const [fresh] = await readSyncFreshness(engine, { sourceIds: [f.id] });
      expect(fresh).toMatchObject({ source_id: f.id, window_hours: 24, commits: 1, unresolved_commits: 0 });
      expect(fresh!.commit_to_searchable.samples).toBe(1);
      expect(fresh!.commit_to_searchable.p50_seconds).toBeGreaterThanOrEqual(0);
      expect(fresh!.commit_to_searchable.p95_seconds!).toBeLessThan(600);
    } finally {
      watcher.stop();
      await engine.setConfig('sync.on_commit', 'false');
      await until(`${name}: the runner to idle`, async () => !isDelegatedSyncRunning(), 60_000);
    }
  }
}), 400_000);
