/**
 * GST-2552: a Git effect's commit whose branch moves under it never rebuilds its staged blobs over the commit that
 * moved it. The crash robot's `sync_and_connector_race_direct_write` interleaving, forced: a put_page's Git effect
 * stages its file and reads HEAD, then someone else writes the same file, stages it and commits it, then the effect's
 * `update-ref` finds HEAD moved. Before the fix the retry laid the old staged blob over the new HEAD, so HEAD silently
 * went back to the effect's bytes, the next sync imported nothing and the index kept the other writer's version staged.
 *
 * Protects: the other commit stays HEAD (Git is the parent), the effect completes `superseded` instead of committing
 * stale content, the next sync imports the other writer's edit, the checkout is clean, a later write of the page
 * commits, and the reference model finds no lost write.
 * Fails when: the effect's retry reuses a blob staged before the other commit, or reports the moved path committed.
 * The commitGitTargets cases pin each kind of move: a porcelain commit of the same file (superseded), a plumbing commit
 * that leaves the effect's bytes on disk (retried, then committed on the new HEAD), one that also changed the file
 * (superseded, index back to HEAD), a group with an untouched member (retried alone) and a removal the other commit
 * undid (superseded).
 * Seams: a `git` shim on PATH that makes the other commit just before the effect's first `update-ref`, and
 * `effectSeams.beforeUpdateRef` for the commitGitTargets cases; real repositories and real engines (PGLite, and
 * Postgres when DATABASE_URL is set).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReferenceModel } from '../scripts/persistence/model.ts';
import { crossBoundarySequences } from '../scripts/persistence/generator.ts';
import { ROBOT_TOPOLOGY } from '../scripts/persistence/robot-driver.ts';
import { drain, runSteps } from '../scripts/persistence/crash-robot.ts';
import { contextFor, type OpObservation } from '../scripts/persistence/ops.ts';
import { operationsByName } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { commitGitTargets, effectSeams } from '../src/core/persistence/effect-git.ts';
import { prepareTopology } from '../scripts/persistence/history-fixture.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const realGit = Bun.spawnSync(['which', 'git']).stdout.toString().trim();

async function robotBrain<T>(url: string | undefined, path: string, run: (brain: Awaited<ReturnType<typeof prepareTopology>>) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-moved-head-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, PATH: path }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(url);
      try { return await run(await prepareTopology(engine, { sources: 2, worktrees: 2, root: join(home, 'checkouts'), prefix: 'robot', connector: true })); }
      finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) for (const forced of [false, true]) {
  test(`${backend}: a commit of the same file ${forced ? 'between the effect\'s HEAD read and its update-ref' : 'after the effect'} wins and the next sync imports it`, async () => {
    const url = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    const schedule = crossBoundarySequences(ROBOT_TOPOLOGY).find(s => s.label === 'sync_and_connector_race_direct_write')!;
    const [put, sync] = ['sy0', 'sy1'].map(id => schedule.ops.find(d => d.id === id)!);
    const bin = mkdtempSync(join(tmpdir(), 'gbrain-moved-head-bin-'));
    const armed = join(bin, 'armed'), root = join(bin, 'root'), userContent = join(bin, 'user.md');
    writeFileSync(userContent, String(sync.args.content));
    writeFileSync(join(bin, 'git'), `#!/bin/bash
if [ -e "${armed}" ]; then
  for a in "$@"; do if [ "$a" = update-ref ]; then
    r="$(cat "${armed}")"; rm -f "${armed}"
    cp "${userContent}" "$r/notes/alpha.md"
    ${realGit} -C "$r" add -- notes/alpha.md >&2
    ${realGit} -C "$r" -c user.name=U -c user.email=u@example.invalid commit -q -m 'edit notes/alpha' -- notes/alpha.md >&2
    break
  fi; done
fi
exec ${realGit} "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    try {
      await robotBrain(url, `${bin}:${process.env.PATH}`, async ({ world }) => {
        const dir = world.roots![sync.source]!;
        const g = (...a: string[]) => Bun.spawnSync([realGit, '-C', dir, ...a]).stdout.toString();
        if (forced) writeFileSync(armed, dir);
        const model = new ReferenceModel(world);
        world.descriptors = new Map(schedule.ops.map(d => [d.id, d]));
        await runSteps(world, model, { ...schedule, ops: [put], groups: [] });
        expect(await drain(world.engine, world)).toBe(true);
        expect(existsSync(armed)).toBe(false);
        if (!forced) {
          writeFileSync(join(dir, 'notes/alpha.md'), String(sync.args.content));
          g('add', '--', 'notes/alpha.md'); g('-c', 'user.name=U', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'edit notes/alpha', '--', 'notes/alpha.md');
        }
        expect(g('log', '-1', '--format=%s').trim()).toBe('edit notes/alpha');
        expect(g('show', 'HEAD:./notes/alpha.md')).toContain('mk-sy1');
        expect(g('status', '--porcelain', '--', 'notes/alpha.md')).toBe('');
        const [effect] = await world.engine.executeRaw<{ outcome: Record<string, unknown> | string }>(
          `SELECT e.outcome FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1 AND e.kind='git'`, [put.requestId]);
        const outcome = typeof effect!.outcome === 'string' ? JSON.parse(effect!.outcome) : effect!.outcome;
        expect(outcome.git).toBe(forced ? 'superseded' : 'committed');

        const result = await operationsByName.sync_brain.handler(contextFor(world, 'local', sync.source), { source_id: sync.source, no_pull: true, no_embed: true }) as Record<string, unknown>;
        expect(result.modified).toBe(1);
        const [row] = await world.engine.executeRaw<{ t: string }>(`SELECT compiled_truth AS t FROM pages WHERE source_id=$1 AND slug='notes/alpha'`, [sync.source]);
        expect(row!.t).toContain('mk-sy1');
        const seen: OpObservation = { id: sync.id, kind: sync.kind, actor: sync.actor, source: sync.source, requestId: sync.requestId, status: 'committed', values: {}, raw: result };
        model.beginStep(true); await model.observe(sync, seen); await model.settleGroup([sync], [seen]);
        expect(model.violations).toEqual([]);

        const current = await world.engine.readPageSnapshot('notes/alpha', { sourceId: sync.source });
        await operationsByName.put_page.handler(contextFor(world, 'local', sync.source), { source_id: sync.source, slug: 'notes/alpha',
          content: String(put.args.content).replace('mk-sy0', 'mk-after'), expected_revision: current!.revision, request_id: crypto.randomUUID() });
        expect(await drain(world.engine, world)).toBe(true);
        expect(g('show', 'HEAD:./notes/alpha.md')).toContain('mk-after');
        expect(g('status', '--porcelain', '--', 'notes/alpha.md')).toBe('');
      });
    } finally { rmSync(bin, { recursive: true, force: true }); }
  }, 120_000);
}

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-moved-head-repo-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const [path, body] of Object.entries(files)) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return root;
}
function put(root: string, path: string, body: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), body);
}
/** A commit of `path` holding `body` made without the checkout's index or files, as another tool's plumbing would. */
function plumbingCommit(root: string, path: string, body: string): void {
  const other = { ...env, GIT_INDEX_FILE: join(root, '.git', 'other-index') };
  const run = (args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: other, input }).trim();
  run(['read-tree', 'HEAD']);
  run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], body)},${path}`]);
  git(root, 'update-ref', 'refs/heads/main', run(['commit-tree', run(['write-tree']), '-p', 'HEAD', '-m', 'another commit']));
}
/** Runs `move` once, just before the next effect commit's first update-ref. */
function before(move: () => void): void {
  effectSeams.beforeUpdateRef = () => { effectSeams.beforeUpdateRef = undefined; move(); };
}
const committedByHand = (root: string, path: string, body: string) => {
  put(root, path, body);
  git(root, 'add', '--', path); git(root, 'commit', '-qm', 'another commit', '--', path);
};

afterEach(() => {
  effectSeams.beforeUpdateRef = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('commitGitTargets when another commit lands before update-ref', () => {
  test('a porcelain commit of the same file wins: the target is superseded and the checkout is clean', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    before(() => committedByHand(root, 'notes/a.md', 'a, by hand\n'));
    put(root, 'notes/a.md', 'a, by gbrain\n');
    const outcome = (await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md');
    expect(outcome).toEqual({ git: 'superseded', reason: 'committed_by_another_writer' });
    expect(git(root, 'log', '-1', '--format=%s')).toBe('another commit');
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, by hand');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a plumbing commit that leaves the effect\'s bytes on disk is retried, and the retry commits on the new HEAD', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    before(() => plumbingCommit(root, 'notes/a.md', 'a, elsewhere\n'));
    put(root, 'notes/a.md', 'a, by gbrain\n');
    const outcome = (await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md');
    expect(outcome).toBeInstanceOf(OperationError);
    expect((outcome as OperationError).code).toBe('git_unavailable');
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, elsewhere');
    expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toEqual({ git: 'committed' });
    expect(git(root, 'log', '-2', '--format=%s').split('\n')[1]).toBe('another commit');
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, by gbrain');
  });

  test('a plumbing commit that also changed the file supersedes it, and the index goes back to HEAD', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    before(() => { plumbingCommit(root, 'notes/a.md', 'a, elsewhere\n'); put(root, 'notes/a.md', 'a, elsewhere\n'); });
    put(root, 'notes/a.md', 'a, by gbrain\n');
    expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toMatchObject({ git: 'superseded' });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, elsewhere');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('in a group, only the moved file is superseded; the untouched one is put back and commits on retry', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
    before(() => committedByHand(root, 'notes/a.md', 'a, by hand\n'));
    put(root, 'notes/a.md', 'a, by gbrain\n'); put(root, 'notes/b.md', 'b, by gbrain\n');
    const outcomes = await commitGitTargets(root, ['notes/a.md', 'notes/b.md']);
    expect(outcomes.get('notes/a.md')).toMatchObject({ git: 'superseded' });
    expect(outcomes.get('notes/b.md')).toBeInstanceOf(OperationError);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect((await commitGitTargets(root, ['notes/b.md'])).get('notes/b.md')).toEqual({ git: 'committed' });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, by hand');
    expect(git(root, 'show', 'HEAD:notes/b.md')).toBe('b, by gbrain');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a commit that swept in the effect\'s staged file is not a move: the retry finds it unchanged', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
    before(() => { put(root, 'notes/b.md', 'b, by hand\n'); git(root, 'commit', '-qam', 'another commit'); });
    put(root, 'notes/a.md', 'a, by gbrain\n');
    expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toBeInstanceOf(OperationError);
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, by gbrain');
    expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toEqual({ git: 'unchanged' });
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a removal whose file another commit put back is superseded; the file stays committed', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    before(() => committedByHand(root, 'notes/a.md', 'a, put back by hand\n'));
    unlinkSync(join(root, 'notes/a.md'));
    expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toMatchObject({ git: 'superseded' });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, put back by hand');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
