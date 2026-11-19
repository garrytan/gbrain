/**
 * F0 `foresights sources refresh` fixture: a bare upstream, a pushing clone, and a
 * managed clone whose `alpha/` and `beta/` directories are two sources bound
 * to ONE canonical worktree (the multi-source case a per-source fence cannot
 * protect). Both sources are synced once, so `last_commit` is the clone HEAD.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { withEnv } from './with-env.ts';

export const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;
export const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function commitFile(root: string, path: string, content: string, message = `update ${path}`): string {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', '--', path); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

export interface RefreshFixture {
  engine: BrainEngine; dir: string; home: string; remote: string; upstream: string; root: string;
  alpha: string; beta: string; worktreeId: string; head: () => string;
  ctx: (sourceId: string) => OperationContext;
  /** Commit in the pushing clone and push; returns the new upstream commit. */
  push: (path: string, content: string) => string;
  put: (sourceId: string, slug: string, content: string, requestId?: string) => Promise<Record<string, unknown>>;
  lastCommit: (sourceId: string) => Promise<string | null>;
  refreshRows: () => Promise<Array<{ id: string; state: string; outcome: Record<string, unknown>; preserved_uncommitted: string[] }>>;
  requestCount: () => Promise<number>;
}

/** Caller runs this with GBRAIN_HOME set to `join(dir, 'home')`. */
export async function setupRefreshFixture(engine: BrainEngine, dir: string): Promise<RefreshFixture> {
  const home = join(dir, 'home'), remote = join(dir, 'origin.git'), upstream = join(dir, 'upstream'), root = join(dir, 'brain');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, upstream], { stdio: 'ignore' });
  git(upstream, 'checkout', '-q', '-b', 'main');
  commitFile(upstream, 'alpha/one.md', page('Alpha one', 'The first alpha observation.'));
  commitFile(upstream, 'beta/one.md', page('Beta one', 'The first beta observation.'));
  git(upstream, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const alpha = `alpha-${tag}`, beta = `beta-${tag}`;
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  for (const [id, sub] of [[alpha, 'alpha'], [beta, 'beta']]) {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [id, join(root, sub), JSON.stringify({ remote_url: remote })]);
    await claimWorktree(engine, id, join(root, sub));
  }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  for (const id of [alpha, beta]) await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true });
  const worktreeId = (await getWorktreeBinding(engine, alpha))!.worktree_id;
  const ctx = (sourceId: string): OperationContext => ({ engine, sourceId, remote: false, dryRun: false,
    config: { engine: engine.kind, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} } });
  return {
    engine, dir, home, remote, upstream, root, alpha, beta, worktreeId, ctx,
    head: () => git(root, 'rev-parse', 'HEAD'),
    push: (path, content) => { const sha = commitFile(upstream, path, content); git(upstream, 'push', '-q', 'origin', 'main'); return sha; },
    put: (sourceId, slug, content, requestId = randomUUID()) => submitPageMutation(ctx(sourceId), { operation: 'put_page', params: { slug, content, request_id: requestId } }),
    lastCommit: async sourceId => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]))[0]?.last_commit ?? null,
    refreshRows: async () => engine.executeRaw('SELECT id,state,outcome,preserved_uncommitted FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid ORDER BY created_at', [worktreeId]),
    requestCount: async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE worktree_id=$1::uuid', [worktreeId]))[0].n),
  };
}

/** Runs `fn` with GBRAIN_HOME pointed at the fixture, then removes the fixture and parks the brain. */
export async function withRefreshFixture(engine: BrainEngine, fn: (f: RefreshFixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      try { await fn(await setupRefreshFixture(engine, dir)); }
      finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
