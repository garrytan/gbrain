/**
 * F0 `gbrain sources refresh`, spec test 1.8.2 (O-ENG-9, "restart converges").
 *
 * Protects: a process killed after `git merge --ff-only` and before the merged
 * bookkeeping commits leaves the worktree fenced; the next owner start moves
 * the refresh to `syncing` (only because HEAD is the verified target and the
 * old HEAD is its ancestor), `--resume` completes it with every member at the
 * target commit, and the write accepted before the fence is committed.
 * GST-1674: a process killed after git refused the fast-forward (a plain-git
 * commit landed on the start commit right before the merge) and before the
 * abort recovers by aborting with that commit kept, so the fence lifts and no
 * deferred write waits on a person, and --abandon abandons it; without a reflog that shows HEAD never
 * reached the target after the merge started, it stays recovery_required.
 * Regression it catches: recovery adopting an unverified HEAD, recovery not
 * wired into owner startup, or accepted writes lost across the crash.
 * Seams: a real child process exits inside the refresh's `merged` boundary,
 * or a `git` on PATH SIGKILLs it right after git refused its merge.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { git, page, setupRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-restart-'));
const cases: Array<{ engine: BrainEngine; database: GBrainConfig; close: () => Promise<void> }> = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const database = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
    const engine = new PGLiteEngine();
    await engine.connect(database); await engine.initSchema();
    cases.push({ engine, database, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    cases.push({ engine: pg.engine, database: { engine: 'postgres', database_url: pg.databaseUrl } as GBrainConfig, close: pg.close });
  }
}, 120_000);
afterAll(async () => {
  for (const item of cases) { await disposePersistenceConsumer(item.engine); await item.close(); }
  rmSync(dir, { recursive: true, force: true });
});

function child(env: Record<string, string>, payload: Record<string, unknown>): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [join(import.meta.dir, 'helpers/worktree-refresh-child.ts')],
    { env: { ...process.env, ...env, GBRAIN_TEST_REFRESH_CHILD: JSON.stringify(payload) }, encoding: 'utf8', timeout: 90_000 });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
}

test('2. O-ENG-9: a crash after git merge and before bookkeeping converges after restart: syncing, then completed', async () => {
  for (const [index, item] of cases.entries()) {
    const caseDir = mkdtempSync(join(dir, `case-${index}-`));
    const home = join(caseDir, 'home');
    let f!: Awaited<ReturnType<typeof setupRefreshFixture>>;
    await withEnv({ GBRAIN_HOME: home }, async () => {
      f = await setupRefreshFixture(item.engine, caseDir);
      await disposePersistenceConsumer(item.engine);
    });
    const target = f.push('alpha/two.md', page('Alpha two', 'An observation that survived a crash.'));
    const old = f.head();
    if (item.engine.kind === 'pglite') await item.engine.disconnect();
    const payload = { database: item.database, sourceId: f.alpha, worktreeId: f.worktreeId };

    const crashed = child({ GBRAIN_HOME: home }, { ...payload, mode: 'crash' });
    expect(crashed.stdout, crashed.stderr).toContain('REFRESH_CRASH_AFTER_MERGE');
    expect(crashed.status).toBe(137);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
    expect(target).not.toBe(old);

    const restarted = child({ GBRAIN_HOME: home }, { ...payload, mode: 'restart' });
    const line = restarted.stdout.split('\n').find(row => row.startsWith('REFRESH_RESULT '));
    expect(line, `${restarted.stdout}\n${restarted.stderr}`).toBeDefined();
    const report = JSON.parse(line!.slice('REFRESH_RESULT '.length)) as { seen: string[]; result: { status: string; synced: Array<{ last_commit: string }> };
      requests: Array<{ state: string; slug: string }> };
    expect(report.seen[0]).toBe('fenced');
    expect(report.seen).toContain('syncing');
    expect(report.seen[report.seen.length - 1]).toBe('completed');
    expect(report.result.status).toBe('completed');
    expect(report.result.synced.map(member => member.last_commit)).toEqual([target, target]);
    const preFence = report.requests.filter(row => row.slug === 'notes/pre-fence');
    expect(preFence).toHaveLength(1);
    expect(report.requests.every(row => row.state === 'committed')).toBe(true);
  }
}, 300_000);

const FOREIGN_ON_TOP = "mkdir -p alpha && printf -- '---\\ntitle: Foreign\\ntype: note\\n---\\nPlain git.\\n' > alpha/foreign.md && git add alpha/foreign.md && git -c user.name=Example -c user.email=example@example.invalid -c commit.gpgsign=false commit -qm foreign";
type Row = { id: string; state: string; outcome: Record<string, any> };

/**
 * GST-1674: a refresh process SIGKILLed after git refused its fast-forward and before it aborted. The `git` on PATH commits on the start
 * commit right before the refresh's own `git merge --ff-only`, runs that merge (git refuses it), then kills the refresh process.
 * Runs `fn` with GBRAIN_HOME set and the barrier on, the row left `fenced` with merge_started true and HEAD on the plain-git commit.
 */
async function withRefusedMergeKill(index: number, fn: (k: { f: RefreshFixture; old: string; target: string; foreign: string; orphan: Row }) => Promise<void>): Promise<void> {
  const item = cases[index]!;
  const caseDir = mkdtempSync(join(dir, `refused-${index}-`));
  const home = join(caseDir, 'home');
  await withEnv({ GBRAIN_HOME: home, GBRAIN_REFRESH_BARRIER: '1' }, async () => {
    resetWriteSwitches();
    if (item.engine.kind === 'pglite') await item.engine.connect(item.database);
    const f = await setupRefreshFixture(item.engine, caseDir);
    await disposePersistenceConsumer(item.engine);
    const old = f.head();
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
    const bin = join(caseDir, 'kill-bin'), armed = join(caseDir, 'kill-armed'), script = join(caseDir, 'kill-race.sh');
    mkdirSync(bin, { recursive: true });
    writeFileSync(script, `cd '${f.root}' || exit 1\n${FOREIGN_ON_TOP}\n`);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" merge --ff-only "*) if [ -f '${armed}' ]; then rm -f '${armed}'; PATH='${process.env.PATH}' sh '${script}' >/dev/null 2>&1; PATH='${process.env.PATH}' git "$@"; kill -9 $PPID; exit 1; fi;; esac\nPATH='${process.env.PATH}' exec git "$@"\n`, { mode: 0o755 });
    writeFileSync(armed, '');
    if (item.engine.kind === 'pglite') await item.engine.disconnect();
    const run = child({ GBRAIN_HOME: home, GBRAIN_REFRESH_BARRIER: '1', PATH: `${bin}:${process.env.PATH}` },
      { database: item.database, sourceId: f.alpha, worktreeId: f.worktreeId, mode: 'kill-refused-merge' });
    if (item.engine.kind === 'pglite') await item.engine.connect(item.database);
    try {
      expect(run.signal, `${run.stdout}\n${run.stderr}`).toBe('SIGKILL');
      const rows = await f.refreshRows() as Row[];
      expect(rows.map(row => [row.state, row.outcome.merge_started])).toEqual([['fenced', true]]);
      const foreign = f.head();
      expect(git(f.root, 'rev-parse', 'HEAD~1')).toBe(old);
      expect(git(f.root, 'log', '-1', '--format=%s')).toBe('foreign');
      expect(() => git(f.root, 'merge-base', '--is-ancestor', target, foreign)).toThrow();
      await fn({ f, old, target, foreign, orphan: rows[0]! });
    } finally { await disposePersistenceConsumer(item.engine); rmSync(caseDir, { recursive: true, force: true }); }
  });
}

test('GST-1674: a refresh killed after git refused its fast-forward recovers by aborting with the commit kept; its deferred write commits and the next refresh completes', async () => {
  for (const index of cases.keys()) await withRefusedMergeKill(index, async ({ f, target, foreign, orphan }) => {
    const requestId = randomUUID();
    const pending = await f.put(f.alpha, 'notes/held', page('Held', 'Written while the refresh was fenced.'), requestId).then(() => null, error => error as { code?: string });
    expect(pending?.code).toBe('write_pending');
    const [held] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect([held!.state, held!.deferred_refresh_id]).toEqual(['deferred', orphan.id]);

    await resumeWorktreeRefreshes(f.engine);
    const [row] = await f.refreshRows() as Row[];
    expect(row!.state).toBe('aborted');
    expect(row!.outcome.refusal).toMatchObject({ code: 'refresh_interrupted' });
    expect(row!.outcome.refusal.cause).toContain('refused');
    expect(row!.outcome.observed_head).toBe(foreign);
    expect(typeof row!.outcome.merge_started_at).toBe('number');
    expect(f.head()).toBe(foreign);

    git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid'); git(f.root, 'config', 'commit.gpgsign', 'false');
    commitAndPush({ repo: f.root, cwd: f.root, pushOnly: true, keepCheckout: true });
    expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
    expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted', 'completed']);
    const head = f.head();
    for (const commit of [foreign, target]) expect(git(f.root, 'merge-base', '--is-ancestor', commit, head)).toBe('');
    for (const source of [f.alpha, f.beta]) expect(await f.lastCommit(source)).toBe(head);
    const done = await waitForWrite(f.engine, (await getWriteRequestById(f.engine, held!.id))!, { engine: f.engine.kind } as never, 30_000);
    expect(done.state).toBe('committed');
    const [left] = await f.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE worktree_id=$1::uuid AND state='deferred'", [f.worktreeId]);
    expect(left!.n).toBe(0);
  });
}, 300_000);

/**
 * Rewrites the HEAD reflog to hold over 32 MiB of earlier entries dated `at` (epoch seconds), chained into
 * the real ones: the log's creation entry now starts from the first commit, which a backfilled creation entry from zeros makes first.
 */
function backfillHeadReflog(f: RefreshFixture, at: number): void {
  const log = join(f.root, '.git', 'logs', 'HEAD');
  const real = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const first = real[0]!.split(' ')[1]!;
  real[0] = `${first} ${real[0]!.slice(real[0]!.indexOf(' ') + 1)}`;
  const line = `${first} ${first} Example <example@example.invalid> ${at} +0000\tbackfill\n`;
  writeFileSync(log, `${'0'.repeat(first.length)} ${first} Example <example@example.invalid> ${at} +0000\tbackfill\n${line.repeat(Math.ceil(33 * 1024 ** 2 / line.length))}${real.join('\n')}\n`);
}

test('GST-1674: the same crash stays recovery_required when the reflog is gone, the row predates merge_started_at, HEAD reached the target and was reset (also onto another commit with those entries expired, or under a later entry with a backdated or misleading line), or the reflog tail holds no entry from before the merge', async () => {
  for (const doubt of ['reflog', 'started_at', 'reset', 'expired', 'recent', 'subject', 'backdated'] as const) for (const index of cases.keys()) await withRefusedMergeKill(index, async ({ f, old, target, foreign, orphan }) => {
    const commit = (message: string) => git(f.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message);
    if (doubt === 'subject' || doubt === 'backdated') {
      git(f.root, 'reset', '-q', '--hard', target);
      git(f.root, 'reset', '-q', '--hard', old);
      if (doubt === 'subject') commit('fix> 1 +0000');
      else await withEnv({ GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }, async () => { commit('backdated'); });
    } else if (doubt === 'recent') {
      backfillHeadReflog(f, Math.floor(orphan.outcome.merge_started_at / 1000));
    } else if (doubt === 'expired') {
      git(f.root, 'branch', 'keep-foreign', foreign);
      git(f.root, 'reset', '-q', '--hard', target);
      git(f.root, 'reset', '-q', '--hard', old);
      commit('after reset');
      for (const ref of git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean)) git(f.root, 'update-ref', '-d', ref);
      git(f.root, 'reflog', 'expire', '--expire-unreachable=all', '--all');
      expect(git(f.root, 'log', '-g', '--format=%H', 'HEAD', '--').split('\n')).not.toContain(target);
    } else if (doubt === 'reflog') {
      git(f.root, 'config', 'core.logAllRefUpdates', 'false');
      rmSync(join(f.root, '.git', 'logs'), { recursive: true, force: true });
    } else if (doubt === 'reset') {
      git(f.root, 'reset', '-q', '--hard', target);
      git(f.root, 'reset', '-q', '--hard', foreign);
    } else {
      await f.engine.executeRaw("UPDATE persistence_worktree_refreshes SET outcome=outcome-'merge_started_at' WHERE worktree_id=$1::uuid", [f.worktreeId]);
    }
    await resumeWorktreeRefreshes(f.engine);
    const [row] = await f.refreshRows() as Row[];
    const head = ['expired', 'subject', 'backdated'].includes(doubt) ? f.head() : foreign;
    expect([doubt, row!.state]).toEqual([doubt, 'recovery_required']);
    expect(row!.outcome.observed_head).toBe(head);
    expect(f.head()).toBe(head);
  });
}, 300_000);

test('GST-1674: a HEAD reflog file over 32 MiB still lets recovery abort the crash, reading only its newest entries', async () => {
  for (const index of cases.keys()) await withRefusedMergeKill(index, async ({ f, foreign, orphan }) => {
    backfillHeadReflog(f, Math.floor(orphan.outcome.merge_started_at / 1000) - 3600);
    await resumeWorktreeRefreshes(f.engine);
    const [row] = await f.refreshRows() as Row[];
    expect([row!.state, row!.outcome.observed_head]).toEqual(['aborted', foreign]);
  });
}, 300_000);

test('GST-1674: a reflog read that git cannot finish leaves the crash fenced for the next owner scan, which then aborts it', async () => {
  for (const index of cases.keys()) await withRefusedMergeKill(index, async ({ f, foreign }) => {
    const bin = join(f.root, '..', 'wedged-git');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--git-path" ]; then kill -9 $$; fi; done\nPATH='${process.env.PATH}' exec git "$@"\n`, { mode: 0o755 });
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try { await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => resumeWorktreeRefreshes(f.engine)); } finally { console.error = consoleError; }
    expect(((await f.refreshRows()) as Row[]).map(row => row.state)).toEqual(['fenced']);
    expect(errors.join('\n')).toContain('git_unavailable');
    await resumeWorktreeRefreshes(f.engine);
    const [row] = await f.refreshRows() as Row[];
    expect([row!.state, row!.outcome.observed_head]).toEqual(['aborted', foreign]);
  });
}, 300_000);

test('GST-1674: --abandon on a refresh killed after git refused its fast-forward abandons it with the commit kept, not recovery_required, and its owed sync releases the held write', async () => {
  for (const index of cases.keys()) await withRefusedMergeKill(index, async ({ f, foreign, orphan }) => {
    const requestId = randomUUID();
    const pending = await f.put(f.alpha, 'notes/held', page('Held', 'Written while the refresh was fenced.'), requestId).then(() => null, error => error as { code?: string });
    expect(pending?.code).toBe('write_pending');
    const [held] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect([held!.state, held!.deferred_refresh_id]).toEqual(['deferred', orphan.id]);

    const result = await refreshWorktree(f.engine, f.alpha, { abandon: true });
    expect(result.status).toBe('abandoned');
    const [row] = await f.refreshRows() as Row[];
    expect([row!.state, row!.outcome.refusal?.code]).toEqual(['aborted', 'refresh_abandoned']);
    expect(f.head()).toBe(foreign);
    expect(result.synced.map(member => member.source_id).sort()).toEqual([f.alpha, f.beta].sort());
    for (const source of [f.alpha, f.beta]) expect(await f.lastCommit(source)).toBe(foreign);
    const done = await waitForWrite(f.engine, (await getWriteRequestById(f.engine, held!.id))!, { engine: f.engine.kind } as never, 30_000);
    expect(done.state).toBe('committed');
  });
}, 300_000);
