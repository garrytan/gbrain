/**
 * #6858 ask 6: commit→embedded on the on-commit path, and the deferrals that keep a page stale. A managed sync import
 * queues an `embedding` publication effect with the page write (persistence/effect-journal.ts) unless the run defers
 * embedding, and the persistence consumer drains it right after publication, so no inline-embed path is needed.
 * What it protects:
 *   - with `sync.on_commit` on, a small page committed to a managed source is embedded within about a second of becoming
 *     searchable (the watcher's sync, the real consumer, a mock embedding transport), and the freshness reader says so;
 *   - a delegated managed sync with `--no-embed` (`noEmbed`), or with the cost gate's deferral (`noEmbed` plus
 *     `embedDeferred`, as sync/run.ts and sync-delegate.ts pass them), makes no provider call: the receipt says
 *     `embedding_state: deferred`, no embedding effect is queued, and the page's chunks stay stale for embed-backfill.
 * The provider is the gateway's transport seam (no spend). PGLite always; Postgres when DATABASE_URL is set
 * (test/postgres-unit-arms.txt). Serial: the gateway transport and the delegated-sync runner are process-wide.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readSyncFreshness } from '../src/core/persistence/sync-freshness.ts';
import { __resetDelegatedSyncForTests, getDelegatedSyncStatus, isDelegatedSyncRunning, startDelegatedSync } from '../src/core/serve-sync-runner.ts';
import { startServeHeadWatcher } from '../src/core/serve-head-watcher.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const home = mkdtempSync(join(tmpdir(), 'gbrain-on-commit-embed-'));
const engines: Array<{ name: string; engine: BrainEngine }> = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let providerCalls = 0;

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
  const id = `embed-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  commit(root, 'notes/alice-example.md', '---\ntitle: Alice Example\n---\nAlice Example keeps the acme-example ledger.\n');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
async function until(what: string, fn: () => Promise<boolean>, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
/** One delegated managed sync of `sourceId` with this host's cli registration (the watcher's own start, plus `extra`), run to its end. */
async function delegatedSync(engine: BrainEngine, sourceId: string, extra: Record<string, unknown>): Promise<void> {
  const local = await registerLocalWriter(engine, 'cli');
  const start = await startDelegatedSync(engine, { sourceId, noPull: true, timeoutSeconds: 600, origin: 'background', ...extra }, `test-${randomUUID()}`,
    { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
  expect(start).toMatchObject({ ok: true });
  await until('the delegated sync to end', async () => !isDelegatedSyncRunning());
  expect(getDelegatedSyncStatus(start.jobId!)).toMatchObject({ ok: true, state: 'done' });
}
const pageChunks = async (engine: BrainEngine, sourceId: string, slug: string) => engine.executeRaw<{ embedded: boolean }>(
  'SELECT c.embedded_at IS NOT NULL AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, slug]);

beforeAll(async () => {
  __resetDelegatedSyncForTests();
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push({ name: 'postgres', engine: pg.engine }); closePostgres = pg.close; }
}, 120_000);
// Installed per test: other suites sharing a process reset the gateway.
beforeEach(() => {
  providerCalls = 0;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerCalls++;
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.01)), usage: { tokens: input.values.length } };
  }) as never);
});
afterEach(() => { __resetDelegatedSyncForTests(); });
afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
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

test('on-commit: a small page is embedded by the publication effect within about a second of becoming searchable', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const { name, engine } of engines) {
    const f = await fixture(engine);
    const first = git(f.root, 'rev-parse', 'HEAD');
    await engine.setConfig('sync.on_commit', 'true');
    const watcher = startServeHeadWatcher(engine, { log: () => {}, pollMs: 200, debounceMs: 200 });
    try {
      const lastCommit = async () => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]?.last_commit;
      await until(`${name}: the first sync to settle`, async () => !isDelegatedSyncRunning() && await lastCommit() === first);
      const head = commit(f.root, 'notes/acme-example.md', '---\ntitle: Acme Example\n---\nAcme Example ships the quarterly zeppelin report.\n');
      await until(`${name}: the commit to sync`, async () => !isDelegatedSyncRunning() && await lastCommit() === head);
      await until(`${name}: the page to embed`, async () => {
        const chunks = await pageChunks(engine, f.id, 'notes/acme-example');
        return chunks.length > 0 && chunks.every(c => c.embedded);
      }, 30_000);
      expect(providerCalls, name).toBeGreaterThan(0);
      const [fresh] = await readSyncFreshness(engine, { sourceIds: [f.id] });
      expect(fresh, name).toMatchObject({ commits: 1, commit_to_searchable: { samples: 1 }, commit_to_embedded: { samples: 1, pending: 0 } });
      const lag = fresh!.commit_to_embedded.p50_seconds! - fresh!.commit_to_searchable.p50_seconds!;
      expect(lag, `${name}: commit→embedded ${fresh!.commit_to_embedded.p50_seconds}s vs commit→searchable ${fresh!.commit_to_searchable.p50_seconds}s`).toBeLessThanOrEqual(1.5);
    } finally {
      await watcher.stop();
      await engine.setConfig('sync.on_commit', 'false');
      await until(`${name}: the runner to idle`, async () => !isDelegatedSyncRunning(), 60_000);
    }
  }
}), 400_000);

for (const [label, extra] of [['--no-embed', { noEmbed: true }], ['the cost gate\'s deferral', { noEmbed: true, embedDeferred: true }]] as const) {
  test(`a managed sync with ${label} makes no provider call; the page stays stale for embed-backfill`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of engines) {
      const f = await fixture(engine);
      await delegatedSync(engine, f.id, extra);
      const chunks = await pageChunks(engine, f.id, 'notes/alice-example');
      expect(chunks.length, name).toBeGreaterThan(0);
      expect(chunks.every(c => !c.embedded), name).toBe(true);
      const receipts = await engine.executeRaw<{ embedding_state: string | null; effects: number }>(`SELECT r.outcome->>'embedding_state' AS embedding_state,
          (SELECT count(*)::int FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='embedding') AS effects
        FROM persistence_requests r WHERE r.source_id=$1 AND r.slug='notes/alice-example' AND r.state='committed'`, [f.id]);
      expect(receipts, name).toEqual([{ embedding_state: 'deferred', effects: 0 }]);
      await Bun.sleep(500);
      expect(providerCalls, name).toBe(0);
    }
  }), 300_000);
}
