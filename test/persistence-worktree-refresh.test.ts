/**
 * F0 `gbrain sources refresh` (spec section 1.8; tests 1 and 3-13, test 2 is
 * persistence-worktree-refresh-restart.test.ts).
 *
 * Protects: a managed checkout shared by several sources is fast-forwarded only
 * after every accepted write to it drained, never under a moving HEAD, and the
 * refresh converges or refuses with a typed, filled fix.
 * Regression it catches: admission, claiming or the consumer's idle probe
 * ignoring the refresh fence (a write publishing onto a checkout whose HEAD is
 * moving, or a fenced effect waking the consumer every poll), a per-source fence,
 * a refresh that merges dirty or diverged checkouts, a refresh that leaves the
 * fence up after a refusal, or topology changes racing a refresh.
 * Existing coverage: none; managed sync refused to pull and lane B only
 * reported the stale upstream.
 * Seams: the `hooks.boundary` callback pauses the real state machine at its
 * drained, fenced and merged points; no production behavior is replaced.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { parseRefreshArgs, runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { claimCoalescedGitEffects, claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; suggestion?: string; message?: string; docs?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
test('refresh timer bounds reject overflow and accept the maximum delay', () => each(async f => {
  await refusedWith(refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 2 ** 31 }), 'invalid_params');
  const drain = parseRefreshArgs([f.alpha, '--wait-drain', String((2 ** 31) / 1000), '--dry-run']).options;
  expect(drain.waitDrainMs).toBeGreaterThan(2 ** 31 - 1); // the drain wait is a performance.now() deadline, not a timer: still accepted
  expect((await refreshWorktree(f.engine, f.alpha, drain)).status).toBe('dry_run');
  expect((await refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 2 ** 31 - 1, dryRun: true })).status).toBe('dry_run');
}));
/** Requeue a committed git effect so the drain must wait for the consumer to process it again. */
async function requeueGitEffect(f: RefreshFixture, delayMs: number): Promise<number> {
  const [effect] = await f.engine.executeRaw<{ id: number }>(`SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND kind='git' ORDER BY id DESC LIMIT 1`, [f.worktreeId]);
  expect(effect).toBeDefined();
  await f.engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    next_attempt_at=now()+($2::double precision*interval '1 millisecond') WHERE id=$1`, [effect.id, delayMs]);
  return Number(effect.id);
}

test('1. O-ENG-9: writes and syncs to every member are refused while draining, then the same request ids succeed', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation about narwhals.'));
  const before = await f.requestCount();
  const ids = { alpha: randomUUID(), beta: randomUUID() };
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    await refusedWith(f.put(f.alpha, 'notes/during-alpha', page('During', 'alpha body'), ids.alpha), 'worktree_refreshing');
    const beta = await refusedWith(f.put(f.beta, 'notes/during-beta', page('During', 'beta body'), ids.beta), 'worktree_refreshing');
    expect(beta.suggestion).toContain(`gbrain sources writer status ${f.beta}`);
    expect(beta.docs).toBe('docs/guides/write-refusals.md#worktree_refreshing');
    await refusedWith(performManagedSync(f.engine, { sourceId: f.beta, noPull: true, noEmbed: true }), 'worktree_refreshing');
    expect(await f.requestCount()).toBe(before);
    const status = await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.beta }) as { worktree_refreshes: Array<Record<string, unknown>> };
    expect(status.worktree_refreshes).toMatchObject([{ state: 'draining', source_ids: [f.alpha, f.beta].sort(), target_head: target }]);
  } } });
  expect(result).toMatchObject({ status: 'completed', target_head: target, source_ids: [f.alpha, f.beta].sort() });
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await f.lastCommit(f.beta)).toBe(target);
  expect(f.head()).toBe(target);
  expect((await f.put(f.alpha, 'notes/during-alpha', page('During', 'alpha body'), ids.alpha)).state ?? 'committed').toBe('committed');
  expect((await f.put(f.beta, 'notes/during-beta', page('During', 'beta body'), ids.beta)).state ?? 'committed').toBe('committed');
  expect((await f.engine.getPage('two', { sourceId: f.alpha }))?.compiled_truth ?? (await f.engine.getPage('alpha/two', { sourceId: f.alpha }))?.compiled_truth).toContain('narwhals');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
}), 180_000);

test('3. a fetch killed by its bound leaves no refresh row and HEAD unchanged', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Never fetched.'));
  const head = f.head();
  git(f.root, 'config', 'remote.origin.uploadpack', 'sleep 5; git-upload-pack');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 300 }), 'fetch_failed');
  expect(error.message).toContain('300 ms');
  expect(error.suggestion).toContain('--fetch-timeout-ms');
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
}), 120_000);

/** Runs `fn` with a PATH git that fails (stderr line, then `code`) whenever an argument equals `token`; every other command is the real git. */
async function withFailingGit<T>(token: string, code: number, fn: () => Promise<T>): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-failing-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for a in "$@"; do if [ "$a" = "${token}" ]; then echo "fatal: injected failure of ${token}" >&2; exit ${code}; fi; done
exec ${realGit} "$@"
`, { mode: 0o755 });
  try { return await withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn); } finally { rmSync(bin, { recursive: true, force: true }); }
}
const refusedOnGit = async (f: RefreshFixture, token: string, code: number, command: string) => {
  const head = f.head();
  const error = await withFailingGit(token, code, () => refusedWith(refreshWorktree(f.engine, f.alpha), 'git_unavailable'));
  expect(error.message).toContain(`git ${command} failed (fatal: injected failure of ${token})`);
  expect(error.suggestion).toContain(`gbrain sources refresh ${f.alpha}`);
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
};

test('3b. a failing git symbolic-ref is a git failure, not a detached HEAD', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedOnGit(f, 'symbolic-ref', 128, 'symbolic-ref --quiet --short HEAD');
  git(f.root, 'checkout', '-q', '--detach');
  const detached = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
  expect(detached.message).toContain('(detached HEAD)');
}), 120_000);

test('3c. a failing git remote is a git failure, not a checkout without remotes', () => each(async f => {
  git(f.root, 'branch', '--unset-upstream');
  await refusedOnGit(f, 'remote', 128, 'remote');
  const noUpstream = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
  expect(noUpstream.suggestion).toContain('branch --set-upstream-to origin/main');
}), 120_000);

test('3d. a failing git config --get of the branch remote or merge is a git failure, not an unset key', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedOnGit(f, 'branch.main.remote', 3, 'config --get branch.main.remote');
  await refusedOnGit(f, 'branch.main.merge', 3, 'config --get branch.main.merge');
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(f.head()).toBe(target);
}), 120_000);

test('3e. a checkout that is not a Git checkout is refresh_no_upstream naming that, not a detached HEAD or a git failure', () => each(async f => {
  renameSync(join(f.root, '.git'), join(f.dir, 'moved.git'));
  try {
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
    expect(error.message).toContain(`The checkout ${f.root} is not a Git checkout`);
    expect(error.suggestion).toContain('Nothing to refresh');
    expect(await f.refreshRows()).toEqual([]);
  } finally { renameSync(join(f.dir, 'moved.git'), join(f.root, '.git')); }
}), 120_000);

test('4. a diverged checkout is refused with no row and HEAD unchanged', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
  const head = f.head();
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged');
  expect(error.suggestion).toContain(`gbrain sources reclone ${f.alpha}`);
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
}), 120_000);

test('5. dirt overlapping the incoming diff refuses naming the path; unrelated dirt is preserved and listed', () => each(async f => {
  const target = f.push('alpha/one.md', page('Alpha one', 'The upstream rewrite.'));
  writeFileSync(join(f.root, 'alpha/one.md'), page('Alpha one', 'An uncommitted local edit.'));
  writeFileSync(join(f.root, 'beta/draft.txt'), 'unrelated scratch\n');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_dirty');
  expect(error.message).toContain('alpha/one.md');
  expect(error.message).not.toContain('beta/draft.txt');
  expect(await f.refreshRows()).toEqual([]);
  git(f.root, 'checkout', '--', 'alpha/one.md');
  const result = await refreshWorktree(f.engine, f.alpha);
  expect(result.status).toBe('completed');
  expect(result.preserved_uncommitted).toEqual(['beta/draft.txt']);
  expect(readFileSync(join(f.root, 'beta/draft.txt'), 'utf8')).toBe('unrelated scratch\n');
  expect(f.head()).toBe(target);
}), 180_000);

test('6. an external commit between precheck and merge aborts with refresh_source_changed and lifts the fence', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedWith(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') git(f.root, 'commit', '-q', '--allow-empty', '-m', 'external');
  } } }), 'refresh_source_changed');
  const rows = await f.refreshRows();
  expect(rows.map(r => r.state)).toEqual(['aborted']);
  expect((rows[0].outcome.refusal as { code: string }).code).toBe('refresh_source_changed');
  expect((await f.put(f.alpha, 'notes/after', page('After', 'admitted again'))).state ?? 'committed').toBe('committed');
}), 180_000);

test('7. a crash leaving HEAD on an unrelated commit is recovery_required; writes name the resume; --abandon after reset lifts the fence', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'merged') throw new Error('simulated crash after merge'); } } }))
    .rejects.toThrow('simulated crash');
  expect(f.head()).toBe(target);
  git(f.root, 'reset', '-q', '--hard', old);
  git(f.root, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  const refused = await refusedWith(f.put(f.alpha, 'notes/blocked', page('Blocked', 'refused')), 'refresh_recovery_required');
  expect(refused.suggestion).toContain(`gbrain sources refresh ${f.alpha} --resume`);
  const resume = await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  expect(resume.suggestion).toContain(`reset --hard ${old}`);
  git(f.root, 'reset', '-q', '--hard', old);
  expect((await refreshWorktree(f.engine, f.alpha, { abandon: true })).status).toBe('abandoned');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted']);
  expect((await f.put(f.alpha, 'notes/after', page('After', 'admitted again'))).state ?? 'committed').toBe('committed');
}), 180_000);

test('8. a queued git effect drains before fenced, and nothing on the worktree is claimed while fenced', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.beta, 'notes/effect', page('Effect', 'Has a git effect.'));
  const effectId = await requeueGitEffect(f, 800);
  const started = performance.now();
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') {
      expect(performance.now() - started).toBeGreaterThanOrEqual(700);
      expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effectId]))[0].state).toBe('committed');
    }
    if (point === 'fenced') {
      await f.engine.executeRaw(`UPDATE persistence_effects SET state='queued',next_attempt_at=now()-interval '1 second' WHERE id=$1`, [effectId]);
      expect(await claimPersistenceEffect(f.engine, localHostId())).toBeNull();
      expect(await claimCoalescedGitEffects(f.engine, localHostId(), f.worktreeId, 5)).toEqual([]);
      // The idle probe mirrors the claims: a fenced effect is not work, so the consumer keeps backing off.
      const probe = new PersistenceConsumer(f.engine, {} as never, async () => { throw new Error('no preparation in this probe'); });
      expect(await (probe as unknown as { hasWork(): Promise<boolean> }).hasWork()).toBe(false);
      // The resident consumer polls too; a claimable effect would leave 'queued' within a few polls.
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effectId]))[0].state).toBe('queued');
      await f.engine.executeRaw(`UPDATE persistence_effects SET state='committed' WHERE id=$1`, [effectId]);
    }
  } } });
  expect(result.status).toBe('completed');
}), 180_000);

test('9. an unexhausted managed-sync cursor refuses sync_in_progress with its resume command and no fence', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const key = `test-cursor-${randomUUID()}`;
  await f.engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
    [key, JSON.stringify([{ sourceId: f.beta, done: false, processingOptions: { noEmbed: true, noExtract: false, noSchemaPack: false },
      syncOptions: { full: false, workingTree: false, srcSubpath: null, exclude: [], includeHidden: [], strategy: null } }])]);
  try {
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'sync_in_progress');
    expect(error.suggestion).toContain(`gbrain sync --source ${f.beta} --no-pull --no-embed`);
    expect(error.suggestion).not.toContain('--retry-failed');
    expect(await f.refreshRows()).toEqual([]);
  } finally { await f.engine.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1`, [key]); }
}), 120_000);

test('10. source add and remove on the worktree during a refresh refuse refresh_in_progress', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    const add = await refusedWith(runManagedSourceLifecycle(f.engine, { operation: 'add', sourceId: `gamma-${randomUUID().slice(0, 6)}`, path: join(f.root, 'alpha') }), 'refresh_in_progress');
    expect(add.suggestion).toContain('--resume');
    await refusedWith(runManagedSourceLifecycle(f.engine, { operation: 'remove', sourceId: f.beta, confirmDestructive: true }), 'refresh_in_progress');
    await refusedWith(refreshWorktree(f.engine, f.beta), 'refresh_in_progress');
  } } });
  expect(result.status).toBe('completed');
}), 180_000);

test('11. end to end: a new upstream commit, `gbrain sources refresh --json`, then query finds it', () => each(async f => {
  f.push('beta/zebra.md', page('Zebra', 'A zebracorn observation pushed upstream.'));
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.beta, '--json']); } finally { console.log = log; }
  const printed = JSON.parse(out.join('\n'));
  expect(printed).toMatchObject({ status: 'completed', target_head: f.head() });
  expect(currentExitCode()).toBe(0);
  const query = operations.find(op => op.name === 'query')!;
  const ctx = { ...f.ctx(f.beta), sourceId: f.beta };
  expect(JSON.stringify(await query.handler(ctx as never, { query: 'zebracorn', limit: 5, expand: false }))).toContain('zebra');
  const [observed] = await f.engine.executeRaw<{ upstream_commit: string; upstream_behind: number }>('SELECT upstream_commit,upstream_behind FROM sources WHERE id=$1', [f.beta]);
  expect(observed).toEqual({ upstream_commit: f.head(), upstream_behind: 0 });
}), 180_000);

test('12. an unmanaged brain refuses refresh_not_managed naming gbrain sync, on stdout with exit 1', () => each(async f => {
  await f.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_not_managed').then(error => expect(error.suggestion).toBe(`gbrain sync --source ${f.alpha}`));
    const out: string[] = [];
    const log = console.log;
    _resetCliExitVerdictForTests();
    console.log = (line: string) => { out.push(line); };
    try { await runSourcesRefresh(f.engine, [f.alpha, '--json']); } finally { console.log = log; }
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'refused', code: 'refresh_not_managed', fix: `gbrain sync --source ${f.alpha}`,
      docs: 'docs/guides/write-refusals.md#refresh_not_managed' });
    expect(currentExitCode()).toBe(1);
  } finally {
    _resetCliExitVerdictForTests();
    process.exitCode = 0; await f.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}), 120_000);

test('13. drain starvation: a writer every 50 ms is refused during draining and the refresh completes inside --wait-drain', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a git effect.'));
  // The git effect the refresh drains becomes runnable once the writer has been refused four times (not after a fixed
  // delay), so the draining window always spans several writer attempts however slow one write is on the host.
  const effect = await requeueGitEffect(f, 60_000);
  let stop = false;
  const outcomes: string[] = [];
  const writer = (async () => {
    while (!stop) {
      try { await f.put(f.alpha, `notes/w-${randomUUID().slice(0, 8)}`, page('W', 'steady traffic')); outcomes.push('accepted'); }
      catch (error) { outcomes.push((error as { code?: string }).code ?? 'error'); }
      if (outcomes.filter(code => code === 'worktree_refreshing').length === 4) await f.engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effect]);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  let result;
  try {
    await new Promise(resolve => setTimeout(resolve, 120));
    result = await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 15_000 });
  } finally { stop = true; await writer; }
  expect(result.status).toBe('completed');
  expect(result.target_head).toBe(target);
  expect(outcomes.filter(code => code === 'worktree_refreshing').length).toBeGreaterThan(3);
  expect(existsSync(join(f.root, 'alpha/two.md'))).toBe(true);
}), 180_000);

test('13b. a publication in flight (recovery under a live claim) is drained, not refused; one no live claim holds is recovery_required', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  const publishing = (claim: string) => f.engine.executeRaw(
    `UPDATE persistence_requests SET state='running', recovery='{"version":1}'::jsonb, claim_expires_at=now()+$2::interval WHERE id=$1::uuid`, [request.id, claim]);
  try {
    await publishing('10 minutes');
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_drain_timeout');
    await publishing('-1 minute');
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_recovery_required');
  } finally {
    await f.engine.executeRaw(`UPDATE persistence_requests SET state='committed', recovery=NULL, claim_expires_at=NULL WHERE id=$1::uuid`, [request.id]);
  }
}), 120_000);

test('13c. a committed write whose publisher still holds the worktree lock (recovery not yet cleared) is drained, not refused', () => each(async f => {
  // The coordinator commits the receipt (completeWrite) and only then clears the request's recovery record
  // (clearResolvedRecovery), holding the worktree native lock throughout. A refresh whose precheck lands in
  // that window used to refuse refresh_recovery_required; on loaded CI this flaked cases 8 and 13.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  const binding = (await getWorktreeBinding(f.engine, f.alpha))!;
  // Let the seed's Git effect finish, then stop the resident consumer so its recovery scan cannot settle the planted record.
  for (let i = 0; i < 100; i++) {
    const [busy] = await f.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE worktree_id=$1::uuid AND kind IN ('git','withdrawal-mirror') AND state IN ('queued','running')`, [f.worktreeId]);
    if (Number(busy.n) === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await disposePersistenceConsumer(f.engine);
  const committedWithRecovery = () => f.engine.executeRaw(
    `UPDATE persistence_requests SET recovery='{"version":1}'::jsonb, claim_expires_at=NULL WHERE id=$1::uuid AND state='committed'`, [request.id]);
  const clear = () => f.engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE id=$1::uuid', [request.id]);
  try {
    // No live owner: the same record left by a crashed publisher is still refused.
    await committedWithRecovery();
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_recovery_required');
    // Live owner: the publisher holds the worktree lock until it clears the record.
    const lock = (await tryAcquireNativeLock(binding.coordination_path!))!;
    expect(lock).not.toBeNull();
    await committedWithRecovery();
    const publisherFinishes = new Promise<void>(resolve => setTimeout(() => { void clear().then(() => lock.release()).then(resolve); }, 400));
    const result = await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 10_000 });
    await publisherFinishes;
    expect(result).toMatchObject({ status: 'completed', target_head: target });
  } finally { await clear(); }
}), 120_000);

test('13d. a publisher that clears its record and releases the lock between the precheck probe and its lock attempt is not refused', () => each(async f => {
  // TOCTOU on 13c's fix: the precheck sees the record, then the publisher finishes before the lock probe.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  for (let i = 0; i < 100; i++) {
    const [busy] = await f.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE worktree_id=$1::uuid AND kind IN ('git','withdrawal-mirror') AND state IN ('queued','running')`, [f.worktreeId]);
    if (Number(busy.n) === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await disposePersistenceConsumer(f.engine);
  const clear = () => f.engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE id=$1::uuid', [request.id]);
  await f.engine.executeRaw(`UPDATE persistence_requests SET recovery='{"version":1}'::jsonb, claim_expires_at=NULL WHERE id=$1::uuid AND state='committed'`, [request.id]);
  const engine = f.engine as BrainEngine & { executeRaw: BrainEngine['executeRaw'] };
  const original = engine.executeRaw;
  let finished = false;
  // Intercept only the precheck's first recovery probe, then hand the engine back untouched.
  engine.executeRaw = (async (sql: string, params?: unknown[], opts?: unknown) => {
    if (finished || !sql.includes('AS publication')) return original.call(engine, sql, params as never, opts as never);
    finished = true;
    engine.executeRaw = original;
    const rows = await original.call(engine, sql, params as never, opts as never);
    await clear();
    return rows;
  }) as BrainEngine['executeRaw'];
  try {
    expect(await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 10_000 })).toMatchObject({ status: 'completed', target_head: target });
    expect(finished).toBe(true);
  } finally { engine.executeRaw = original; await clear(); }
}), 120_000);

test('admission completes a syncing refresh whose members all reached the target, and refuses while one lags', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const [row] = await f.refreshRows();
  // A refresh whose process died in `syncing` after a later cycle sync caught one member up but not the other.
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [row.id]);
  const setLastCommit = (sha: string) => f.engine.transaction(tx => withCoordinatedWrite(tx, [f.beta], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.beta, sha]), TEST_WRITE_ATTRIBUTION));
  await setLastCommit(git(f.root, 'rev-parse', 'HEAD~1'));
  await refusedWith(f.put(f.alpha, 'notes/lagging', page('Lagging', 'refused')), 'worktree_refreshing');
  await setLastCommit(target);
  expect((await f.put(f.alpha, 'notes/caught-up', page('Caught up', 'admitted'))).state ?? 'committed').toBe('committed');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
}), 120_000);
