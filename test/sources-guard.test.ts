/**
 * PR B Part 5: `gbrain sources guard` on a managed source's canonical worktree. Owner host only; enforce mode refuses a
 * plain commit while the effect worker, the door and a refresh fast-forward pass; the install is worktree-local, so a
 * linked sibling worktree of the same repository keeps its own hooks. In-memory PGLite and real git repositories.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseSourcesGuardArgs, sourcesGuard } from '../src/commands/sources-guard.ts';
import { installOwnerGuard, renderGuardHook, uninstallOwnerGuard } from '../src/core/git/commit-guard.ts';
import { gitDurabilityPolicy } from '../src/core/persistence/git-durability-policy.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { foreignWritersEntry, type ForeignCommit } from '../src/commands/doctor/checks/foreign-writers.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';
import { git, page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const refused = async (promise: Promise<unknown>) => promise.then(() => null, e => e as { code?: string; message?: string });

test('the opt-in hook is byte-identical; both owner-path modes guard only the owner worktree; enforce drops only the rewrite exemptions', () => {
  const ownerOnly = 'only the owner worktree is guarded';
  expect(createHash('sha256').update(renderGuardHook()).digest('hex')).toBe('f5afdf64fd917d42c444c7e5b3f721670b2701a92047fceaa2e8fd2c0dac962d');
  expect(renderGuardHook()).not.toContain(ownerOnly);
  const owner = renderGuardHook('default');
  expect(owner).toContain(ownerOnly);
  expect(owner).toContain('for _op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do');
  const enforce = renderGuardHook('enforce');
  expect(enforce).toContain(ownerOnly);
  expect(enforce).toContain('for _op in MERGE_HEAD; do');
  expect(enforce).not.toContain('CHERRY_PICK_HEAD');
});

test('installing the owner guard keeps the brain-durability post-commit hook, so an unrecorded binding stays durable', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-guard-durable-'));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n', { mode: 0o755 });
    expect(await gitDurabilityPolicy({ git_durability: null }, repo)).toEqual({ durable: true, source: 'legacy_hook' });
    for (const mode of ['default', 'enforce'] as const) {
      expect(installOwnerGuard(repo, mode).installed).toBe(true);
      expect(await gitDurabilityPolicy({ git_durability: null }, repo)).toEqual({ durable: true, source: 'legacy_hook' });
    }
    uninstallOwnerGuard(repo);
    expect(await gitDurabilityPolicy({ git_durability: null }, repo)).toEqual({ durable: true, source: 'legacy_hook' });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('arguments: one source, one action, --mode only with --install', () => {
  expect(parseSourcesGuardArgs(['notes', '--install', '--mode', 'enforce'])).toEqual({ sourceId: 'notes', action: 'install', mode: 'enforce' });
  expect(parseSourcesGuardArgs(['notes'])).toEqual({ sourceId: 'notes', action: 'status', mode: 'default' });
  expect(() => parseSourcesGuardArgs(['notes', '--install', '--uninstall'])).toThrow();
  expect(() => parseSourcesGuardArgs(['notes', '--status', '--mode', 'enforce'])).toThrow();
  expect(() => parseSourcesGuardArgs(['--install'])).toThrow();
});

test('owner host only; enforce refuses a plain commit; refresh, effect and door commits pass; doctor names the bypass', () => withRefreshFixture(engine, async f => {
  git(f.root, 'config', 'user.name', 'Example');
  git(f.root, 'config', 'user.email', 'example@example.invalid');
  const other = mkdtempSync(join(tmpdir(), 'gbrain-guard-other-home-'));
  try {
    await withEnv({ GBRAIN_HOME: other, HOME: other }, async () => {
      const error = await refused(sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'enforce' }));
      expect(error?.code).toBe('permission_denied');
    });
  } finally { rmSync(other, { recursive: true, force: true }); }

  const installed = await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'enforce' });
  expect(installed).toMatchObject({ installed: true, mode: 'enforce', changed: true, source_id: f.alpha });
  expect(installed.hooks_path).toBe(join(git(f.root, 'rev-parse', '--absolute-git-dir'), 'gbrain-hooks'));
  expect((await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'enforce' })).changed).toBe(false);
  const later = join(f.dir, 'later');
  git(f.root, 'worktree', 'add', '-q', '-b', 'later', later);
  writeFileSync(join(later, 'alpha', 'later.md'), page('Later', 'A worktree added after the install commits freely.'));
  git(later, 'add', 'alpha/later.md');
  git(later, 'commit', '-q', '-m', 'commit in a worktree added after the install');

  writeFileSync(join(f.root, 'alpha', 'stray.md'), page('Stray', 'A plain commit.'));
  git(f.root, 'add', 'alpha/stray.md');
  expect(() => git(f.root, 'commit', '-q', '-m', 'plain commit in the managed worktree')).toThrow(/gbrain commit guard/);
  expect(() => git(f.root, 'commit', '-q', '--no-verify', '-m', 'no-verify')).toThrow(/gbrain commit guard/);
  git(f.root, 'restore', '--staged', 'alpha/stray.md');
  rmSync(join(f.root, 'alpha', 'stray.md'));

  const target = f.push('alpha/upstream.md', page('Upstream', 'From the pushing clone.'));
  const refreshed = await refreshWorktree(f.engine, f.alpha, {});
  expect(refreshed.status).toBe('completed');
  expect(f.head()).toBe(target);

  writeFileSync(join(f.root, 'alpha', 'effect.md'), page('Effect', 'Committed by the effect worker.'));
  expect((await commitGitTargets(join(f.root, 'alpha'), ['effect.md'])).get('effect.md')).toEqual({ git: 'committed' });
  const doorBody = page('Door', 'Committed by the door.');
  writeFileSync(join(f.root, 'alpha', 'door.md'), doorBody);
  expect(await commitThroughDoor(f.root, [{ path: join(f.root, 'alpha', 'door.md'), planned: createHash('sha256').update(doorBody).digest('hex') }])).toBe(f.head());

  await new Promise(r => setTimeout(r, 1100));
  writeFileSync(join(f.root, 'alpha', 'bypass.md'), page('Bypass', 'Hooks turned off.'));
  git(f.root, 'add', 'alpha/bypass.md');
  git(f.root, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'hooks off in the managed worktree');
  const bypass = f.head();
  const [check] = (await foreignWritersEntry.run({ engine: f.engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[];
  expect(check!.status).toBe('fail');
  expect((check!.details!.foreign as ForeignCommit[]).map(c => [c.sha, c.kind, c.guard_bypassed])).toEqual([[bypass, 'plain', true]]);

  const removed = await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'uninstall', mode: 'default' });
  expect(removed).toMatchObject({ installed: false, changed: true });
}), 120_000);

test('default mode guards only the owner worktree: a worktree added after the install inherits the hooks path and commits freely', () => withRefreshFixture(engine, async f => {
  git(f.root, 'config', 'user.name', 'Example');
  git(f.root, 'config', 'user.email', 'example@example.invalid');
  const installed = await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'default' });
  expect(installed).toMatchObject({ installed: true, mode: 'default' });
  const later = join(f.dir, 'later-default');
  git(f.root, 'worktree', 'add', '-q', '-b', 'later-default', later);
  expect(git(later, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks')).toBe(installed.hooks_path);
  writeFileSync(join(later, 'alpha', 'later.md'), page('Later', 'A person commits in a worktree added after the install.'));
  git(later, 'add', 'alpha/later.md');
  git(later, 'commit', '-q', '-m', 'commit in a worktree added after a default-mode install');
  writeFileSync(join(later, 'alpha', 'later-two.md'), page('Later two', 'And with --no-verify.'));
  git(later, 'add', 'alpha/later-two.md');
  git(later, 'commit', '-q', '--no-verify', '-m', 'no-verify in the later worktree');

  writeFileSync(join(f.root, 'alpha', 'stray.md'), page('Stray', 'Refused in the owner worktree.'));
  git(f.root, 'add', 'alpha/stray.md');
  expect(() => git(f.root, 'commit', '-q', '-m', 'plain commit in the managed worktree')).toThrow(/gbrain commit guard/);
  git(f.root, 'restore', '--staged', 'alpha/stray.md');
  rmSync(join(f.root, 'alpha', 'stray.md'));
  await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'uninstall', mode: 'default' });
}), 120_000);

test('the install is worktree-local: a linked sibling keeps its hooks and commits freely; a foreign hook refuses', () => withRefreshFixture(engine, async f => {
  const sibling = join(f.dir, 'sibling');
  git(f.root, 'worktree', 'add', '-q', '-b', 'side', sibling);
  const installed = await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'enforce' });
  expect(installed).toMatchObject({ installed: true, worktree_config: true });
  expect(git(sibling, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks')).not.toBe(installed.hooks_path);
  writeFileSync(join(sibling, 'alpha', 'side.md'), page('Side', 'A person commits in their own worktree.'));
  git(sibling, 'add', 'alpha/side.md');
  git(sibling, 'commit', '-q', '-m', 'commit in the sibling worktree');
  writeFileSync(join(f.root, 'alpha', 'stray.md'), page('Stray', 'Refused here.'));
  git(f.root, 'add', 'alpha/stray.md');
  expect(() => git(f.root, 'commit', '-q', '-m', 'refused in the managed worktree')).toThrow(/gbrain commit guard/);
  git(f.root, 'restore', '--staged', 'alpha/stray.md');

  const status = await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'status', mode: 'default' });
  expect(status).toMatchObject({ installed: true, mode: 'enforce', changed: false });
  await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'uninstall', mode: 'default' });
  writeFileSync(join(git(f.root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'), 'pre-commit'), '#!/bin/sh\nexit 0\n');
  const error = await refused(sourcesGuard(f.engine, { sourceId: f.alpha, action: 'install', mode: 'enforce' }));
  expect(error?.code).toBe('git_unavailable');
  expect((await sourcesGuard(f.engine, { sourceId: f.alpha, action: 'status', mode: 'default' })).installed).toBe(false);
}), 120_000);

test('GST-1623: the owner-path hook fails closed when git cannot name the git dir, and still passes a foreign git dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-guard-closed-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    const hooks = join(repo, '.git', 'gbrain-hooks');
    mkdirSync(hooks, { recursive: true });
    const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --absolute-git-dir ] && exit 128; done\nexec ${real} "$@"\n`, { mode: 0o755 });
    const msg = join(root, 'msg');
    writeFileSync(msg, 'subject\n');
    for (const mode of ['default', 'enforce'] as const) {
      const hook = join(hooks, `prepare-commit-msg-${mode}`);
      writeFileSync(hook, renderGuardHook(mode), { mode: 0o755 });
      const run = (path: string, cwd: string) => spawnSync('bash', [hook, msg], { cwd, env: { ...process.env, PATH: path, GBRAIN_COMMIT_GUARD: '' }, encoding: 'utf8' });
      const failed = run(`${bin}:${process.env.PATH}`, repo);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('could not resolve');
      const other = join(root, `other-${mode}`);
      mkdirSync(other);
      git(other, 'init', '-q', '-b', 'main');
      expect(run(process.env.PATH!, other).status).toBe(0);
      expect(run(process.env.PATH!, repo).status).toBe(1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

