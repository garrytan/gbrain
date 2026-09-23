// #5198: a source with an active local worktree owner, on a brain whose managed
// persistence is NOT activated, must sync through the coordinated (journal)
// path instead of the legacy filesystem writer the owner marker refuses.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-claimed-inactive-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
// PGLite always; Postgres too when DATABASE_URL is set (the #5198 reporter's engine).
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, message = 'test content'): string {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
async function source(engine: BrainEngine, files: Record<string, string>, opts: { claim: boolean }) {
  const id = `s-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body);
  }
  const head = commit(root);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  if (opts.claim) await claimWorktree(engine, id, root);
  return { id, root, head };
}
const enabled = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0]?.enabled;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine !== engines[1]) await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('claimed owner with managed persistence inactive: sync imports through the coordinator', async () => withEnv(env, async () => { for (const engine of engines) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const bytes = '---\ntitle: Example note\n---\nA stable observation written before the claim.\n';
  const f = await source(engine, { 'notes/example.md': bytes }, { claim: true });
  expect(await enabled(engine)).toBe(false);

  const first = await performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, noEmbed: true, noExtract: true });
  expect(first).toMatchObject({ status: 'first_sync', added: 1 });
  expect((await engine.getPage('notes/example', { sourceId: f.id }))?.compiled_truth).toContain('before the claim');
  // The coordinated path never rewrites the canonical bytes.
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(bytes);
  const [row] = await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]);
  expect(row.last_commit).toBe(f.head);

  // Incremental: modify one page and add another, as `gbrain sync --no-pull` would after a git commit.
  writeFileSync(join(f.root, 'notes/example.md'), '---\ntitle: Example note\n---\nA revised observation after the claim.\n');
  writeFileSync(join(f.root, 'notes/added.md'), 'A newly added observation about the project.\n');
  const head2 = commit(f.root, 'edit + add');
  const second = await performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, noEmbed: true, noExtract: true });
  expect(second).toMatchObject({ status: 'synced', added: 1, modified: 1, toCommit: head2 });
  expect((await engine.getPage('notes/example', { sourceId: f.id }))?.compiled_truth).toContain('revised observation');
  expect((await engine.getPage('notes/added', { sourceId: f.id }))?.compiled_truth).toContain('newly added');

  const requests = await engine.executeRaw<{ state: string; kind: string }>(
    "SELECT state, intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1", [f.id]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(r => r.state === 'committed' && r.kind.startsWith('managed_sync_'))).toBe(true);
  // Routing never activates managed persistence as a side effect.
  expect(await enabled(engine)).toBe(false);
} }), 120_000);

test('claimed owner with managed persistence inactive: options managed sync cannot honor still refuse', async () => withEnv(env, async () => { for (const engine of engines) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const f = await source(engine, { 'a.md': 'An observation for the refusal test.\n' }, { claim: true });
  await expect(performSync(engine, { sourceId: f.id, repoPath: f.root, noEmbed: true, noExtract: true }))
    .rejects.toMatchObject({ code: 'writer_coordinator_required' });
  await expect(performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, skipFailed: true, noEmbed: true, noExtract: true }))
    .rejects.toMatchObject({ code: 'writer_coordinator_required' });
  await expect(performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, includeGitignored: true, noEmbed: true, noExtract: true }))
    .rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await engine.getPage('a', { sourceId: f.id })).toBeNull();
} }), 120_000);

test('unclaimed source with managed persistence inactive keeps the legacy import path', async () => withEnv(env, async () => { for (const engine of engines) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const f = await source(engine, { 'legacy.md': 'An observation imported by the legacy sync path.\n' }, { claim: false });
  const before = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id]);
  // concurrency:1 keeps the legacy importer on this engine (parallel workers open their own connection from DATABASE_URL).
  const result = await performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
  expect(result.status).toBe('first_sync');
  expect((await engine.getPage('legacy', { sourceId: f.id }))?.compiled_truth).toContain('legacy sync path');
  // Legacy path writes directly: no journal requests for this source.
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual(before);
} }), 120_000);

test('activated managed persistence keeps routing claimed sources to managed sync', async () => withEnv(env, async () => { for (const engine of engines) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const f = await source(engine, { 'on.md': 'An observation imported after activation.\n' }, { claim: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    const result = await performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: true, noEmbed: true, noExtract: true });
    expect(result).toMatchObject({ status: 'first_sync', added: 1 });
    const kinds = await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1", [f.id]);
    expect(kinds.some(k => k.kind === 'managed_sync_import')).toBe(true);
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
} }), 120_000);
