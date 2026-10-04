/**
 * #5255 + short half of #5176 (O-CEO-12, O-DX-8, O-ENG-15): a managed cycle
 * asked to pull syncs local HEAD instead of failing with
 * writer_coordinator_required, reports `upstream_refresh: "skipped_managed"`
 * with the safe refresh sequence, and doctor sync_freshness reports upstream
 * freshness separately from the local projection. An explicit sync without
 * --no-pull keeps refusing.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { performSync } from '../src/commands/sync.ts';
import { checkSyncFreshness } from '../src/commands/doctor.ts';
import { runMirrorMode } from '../src/commands/sources-mirror.ts';
import { operations } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { flagRejection, gbrainInvocations, liveCliVerbs } from './helpers/cli-command-surface.ts';

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
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;
function commit(root: string, path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', '.'); git(root, 'commit', '-qm', `add ${path}`);
}
const logger = { info() {}, warn() {}, error() {} };
/** O-DX-2: every gbrain command a fix prints resolves and parses with the real CLI's flags. */
function expectRunnableFix(fix: string) {
  const invocations = gbrainInvocations(fix);
  expect(invocations.length).toBeGreaterThan(0);
  for (const inv of invocations) {
    expect(liveCliVerbs().has(inv.verb)).toBe(true);
    expect(flagRejection(inv)).toBeNull();
  }
}

/** A managed brain whose source checkout tracks a bare remote another clone pushes to. */
async function managedRemoteSource(engine: BrainEngine, fn: (s: { sourceId: string; root: string; upstream: string; home: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-pull-')); dirs.push(dir);
  const remote = join(dir, 'origin.git'), upstream = join(dir, 'upstream'), root = join(dir, 'brain');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, upstream], { stdio: 'ignore' });
  git(upstream, 'checkout', '-q', '-b', 'main');
  commit(upstream, 'notes/first.md', page('First', 'The first synced observation.'));
  git(upstream, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  const sourceId = `remote-${Math.random().toString(36).slice(2, 8)}`;
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [sourceId, root, JSON.stringify({ remote_url: remote })]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try { await fn({ sourceId, root, upstream, home: join(dir, 'home') }); }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    }
  });
}

for (const backend of backends) {
  const engine = () => engines[backends.indexOf(backend)];

  test(`${backend}: runCycle({pull:true}) on a managed brain syncs local HEAD and reports skipped_managed (#5255)`, async () => {
    await managedRemoteSource(engine(), async ({ sourceId, root }) => {
      const report = await runCycle(engine(), { brainDir: root, sourceId, phases: ['sync'], pull: true });
      const sync = report.phases.find(p => p.phase === 'sync')!;
      expect(JSON.stringify(sync)).not.toContain('writer_coordinator_required');
      expect(sync.status).toBe('warn');
      expect(sync.details).toMatchObject({ source_id: sourceId, upstream_refresh: 'skipped_managed', added: 1,
        warning: { code: 'managed_pull_skipped', docs: 'docs/guides/write-refusals.md#managed_pull_skipped' } });
      const warning = (sync.details as { warning: { fix: string; cause: string } }).warning;
      expect(warning.cause.length).toBeGreaterThan(0);
      // F0: the one sanctioned managed refresh (drained, worktree-wide ff-only) replaces the manual pull sequence.
      expect(warning.fix).toBe(`gbrain sources refresh ${sourceId}`);
      expectRunnableFix(warning.fix);
      expect((await engine().getPage('notes/first', { sourceId }))?.compiled_truth).toContain('The first synced observation.');
    });
  }, 120_000);

  test(`${backend}: an explicit managed sync without --no-pull keeps refusing (O-ENG-15)`, async () => {
    await managedRemoteSource(engine(), async ({ sourceId, root }) => {
      const refusal = await performSync(engine(), { repoPath: root, sourceId, noPull: false, noEmbed: true }).then(() => null, (e: unknown) => e);
      expect(refusal).toMatchObject({ code: 'writer_coordinator_required',
        fix: { argv: ['gbrain', 'sync', '--no-pull', '--source', sourceId], actor: 'agent' } });
      expect((refusal as { suggestion: string }).suggestion).toContain(`gbrain sync --no-pull --source ${sourceId}`);
      expect((refusal as { suggestion: string }).suggestion).toContain(`gbrain sources refresh ${sourceId}`);
      expect((refusal as { suggestion: string }).suggestion).toContain(`fast-forward and sync the checkout with gbrain sources refresh ${sourceId}`);
    });
  }, 120_000);

  test(`${backend}: mirror ff-only pull then no-pull sync makes the upstream commit recallable, and doctor splits upstream from local freshness`, async () => {
    await managedRemoteSource(engine(), async ({ sourceId, root, upstream }) => {
      await runMirrorMode(engine(), [sourceId], true);
      await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true });
      commit(upstream, 'notes/second.md', page('Second', 'A zebracorn observation pushed upstream.'));
      git(upstream, 'push', '-q', 'origin', 'main');

      git(root, 'pull', '-q', '--ff-only');
      await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true });
      const query = operations.find(op => op.name === 'query')!;
      const ctx = { engine: engine(), config: { engine: engine().kind } as never, logger, dryRun: false, remote: false, sourceId };
      expect(JSON.stringify(await query.handler(ctx as never, { query: 'zebracorn', limit: 5, expand: false }))).toContain('notes/second');
      const [observed] = await engine().executeRaw<{ upstream_commit: string; upstream_behind: number; upstream_checked_at: Date }>(
        'SELECT upstream_commit,upstream_behind,upstream_checked_at FROM sources WHERE id=$1', [sourceId]);
      expect(observed.upstream_commit).toBe(git(upstream, 'rev-parse', 'HEAD'));
      expect(observed.upstream_behind).toBe(0);
      const fresh = await checkSyncFreshness(engine(), { localOnly: true });
      expect(fresh.status).toBe('ok');
      expect(fresh.details).not.toHaveProperty('upstream_unknown_count');

      // Upstream advances, the checkout fetches but does not merge: the local
      // projection is current (HEAD == last_commit) but upstream is behind.
      commit(upstream, 'notes/third.md', page('Third', 'Not merged yet.'));
      git(upstream, 'push', '-q', 'origin', 'main');
      git(root, 'fetch', '-q');
      await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true });
      const behind = await checkSyncFreshness(engine(), { localOnly: true });
      expect(behind.status).toBe('warn');
      expect(behind.message).toContain(`'${sourceId}' upstream 1 commit(s) ahead of the synced commit`);
      expect(behind.message).toContain(`Fix: gbrain sources refresh ${sourceId} (`);
      expectRunnableFix(behind.message.slice(behind.message.indexOf('Fix: ') + 5));
      expect(behind.details).toMatchObject({ unchanged_count: 1, upstream_behind_count: 1 });

      // Neither fetched nor pulled for over 24 h: upstream unknown, never fresh.
      await engine().executeRaw("UPDATE sources SET upstream_behind=0 WHERE id=$1", [sourceId]);
      const stale = await checkSyncFreshness(engine(), { nowMs: Date.now() + 25 * 3_600_000 });
      expect(stale.status).not.toBe('ok');
      expect(stale.message).toContain(`'${sourceId}' upstream unknown (last checked 25h ago)`);
      expect(stale.details).toMatchObject({ upstream_unknown_count: 1 });
    });
  }, 180_000);

  test(`${backend}: a remote-tracking source with no upstream observation is upstream unknown, not fresh`, async () => {
    const sourceId = `never-${backend}`;
    await engine().executeRaw('INSERT INTO sources(id,name,local_path,config,last_sync_at) VALUES($1,$1,$2,$3::text::jsonb,now())',
      [sourceId, '/example/never-observed', JSON.stringify({ remote_url: 'https://example.invalid/repo.git' })]);
    // An API connector source is not a Git remote: it never reads as upstream unknown.
    await engine().executeRaw('INSERT INTO sources(id,name,local_path,config,last_sync_at) VALUES($1,$1,$2,$3::text::jsonb,now())',
      [`${sourceId}-connector`, '/example/connector', JSON.stringify({ kind: 'github', remote_url: 'https://example.invalid/repo.git' })]);
    try {
      const result = await checkSyncFreshness(engine());
      expect(result.status).toBe('warn');
      expect(result.message).toContain(`'${sourceId}' upstream unknown (never checked)`);
      expect(result.message).not.toContain(`'${sourceId}-connector'`);
      expect(result.details).toMatchObject({ upstream_unknown_count: 1 });
    } finally {
      await engine().executeRaw('DELETE FROM sources WHERE id=ANY($1::text[])', [[sourceId, `${sourceId}-connector`]]);
    }
  });
}
