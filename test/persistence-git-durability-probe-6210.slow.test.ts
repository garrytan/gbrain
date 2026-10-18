/**
 * #6210: a native Git durability probe that cannot tell must keep the Git
 * effect unfinished (`git_unavailable`); only a directory that is positively
 * not a Git checkout, or an absent hook, reads as "durability not enabled".
 *
 * Split out of test/persistence-git-coalescing-5530.slow.test.ts (fix wave 16):
 * the probe-timeout case alone waits the product's 10 s probe, and the 5530
 * file was running into the E2E per-file cap. The fixture is shared through
 * test/helpers/git-coalescing-fixture.ts.
 *
 * PGLite here; Postgres through test/e2e/persistence-git-durability-probe-6210-postgres.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { HOOK, type Repo, bindSource, createGitCoalescingFixture, git, gitStates, harden, pass, pauseGitEffects, release, seed } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('6210');
afterAll(dispose);

const gitEffects = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; outcome: { reason?: string } | null }>(
  "SELECT state,error_code,outcome FROM persistence_effects WHERE kind='git' ORDER BY id");
function plainDir(home: string, name: string): Repo {
  const root = join(home, name);
  mkdirSync(root);
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  return { root, remote: '', pushes: () => 0, rejectPushes: () => {}, commits: () => 0 };
}
function stubGit(home: string, body: string): string {
  const dir = join(home, `stub-git-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}
// The hook lives in a configured core.hooksPath, as `gbrain sources harden` installs it when one is set:
// a probe failure must not fall back to .git/hooks, find nothing there and read as "not hardened".
function hardenCustomHooks(repo: Repo): void {
  harden(repo);
  rmSync(join(repo.root, '.git', 'hooks', 'post-commit'));
  const custom = join(repo.root, '.git', 'custom-hooks');
  mkdirSync(custom);
  writeFileSync(join(custom, 'post-commit'), HOOK); chmodSync(join(custom, 'post-commit'), 0o755);
  git(repo.root, 'config', 'core.hooksPath', custom);
}
async function expectUnfinished(engine: BrainEngine, count: number): Promise<void> {
  const effects = await gitEffects(engine);
  expect(effects.length).toBe(count);
  for (const effect of effects) expect(effect).toMatchObject({ state: 'queued', error_code: 'git_unavailable', outcome: null });
}

for (const kind of testBackends()) describe(`#6210 native Git durability probe failures (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test.each([['C'], ['de_DE.UTF-8']])('a directory that is not a Git checkout completes as durability_not_enabled (LANG=%s)', (lang) => withBrain(kind, async ({ engine, home, ctx }) => {
    const plain = plainDir(home, 'plain');
    await bindSource(engine, 'default', plain);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    await withEnv({ LANG: lang, LC_ALL: lang === 'C' ? undefined : lang, LC_MESSAGES: lang === 'C' ? undefined : lang }, async () => { await release(engine); await pass(engine); });
    const effects = await gitEffects(engine);
    expect(effects.map(e => [e.state, e.outcome?.reason])).toEqual([['committed', 'durability_not_enabled'], ['committed', 'durability_not_enabled']]);
  }), 300_000);

  test('a hardened repository still commits under a non-C locale', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    const before = repo.commits();
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    await withEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' }, async () => { await release(engine); await pass(engine); });
    expect(await gitStates(engine)).toEqual({ committed: 2 });
    expect(repo.commits() - before).toBe(1);
  }), 300_000);

  test.each([
    ['damaged HEAD', (repo: Repo) => { writeFileSync(join(repo.root, '.git', 'HEAD'), 'not a ref\n'); return {}; }],
    // Git's own switch for the "dubious ownership" refusal a checkout owned by another user gets. A runner's
    // global or system config can trust every directory (safe.directory=*, common in CI images), which
    // suppresses the refusal, so this case reads an empty global config and no system config.
    ['dubious ownership', (repo: Repo) => {
      const empty = join(repo.root, '..', 'empty-gitconfig');
      writeFileSync(empty, '');
      return { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' };
    }],
    ['a directory at the hook path', (repo: Repo) => { const hook = join(repo.root, '.git', 'custom-hooks', 'post-commit'); rmSync(hook); mkdirSync(hook); return {}; }],
  ] as Array<[string, (repo: Repo) => Record<string, string>]>)('%s keeps Git effects unfinished with git_unavailable', (_name, damage) => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    hardenCustomHooks(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    const before = repo.commits();
    try {
      const env = damage(repo);
      if (env.GIT_TEST_ASSUME_DIFFERENT_OWNER) {
        // Precondition: this git build must refuse the checkout under that env, or the case proves nothing.
        const probe = Bun.spawnSync(['git', '-C', repo.root, 'rev-parse', '--git-path', 'hooks'], { env: { ...process.env, ...env, LC_ALL: 'C' } });
        if (probe.exitCode === 0 || !probe.stderr.toString().includes('dubious ownership')) {
          console.warn(`[#6210] skipped: this git (${Bun.spawnSync(['git', '--version']).stdout.toString().trim()}) does not refuse a checkout under GIT_TEST_ASSUME_DIFFERENT_OWNER (exit ${probe.exitCode})`);
          return;
        }
      }
      await withEnv(env, async () => { await release(engine); await pass(engine); });
    } finally { writeFileSync(join(repo.root, '.git', 'HEAD'), 'ref: refs/heads/main\n'); }
    await expectUnfinished(engine, 2);
    expect(repo.commits()).toBe(before); expect(repo.pushes()).toBe(0);
  }), 300_000);

  test('a .git file naming a missing gitdir keeps Git effects unfinished', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const plain = plainDir(home, 'linked');
    await bindSource(engine, 'default', plain);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    writeFileSync(join(plain.root, '.git'), `gitdir: ${join(home, 'missing-gitdir')}\n`);
    await release(engine); await pass(engine);
    await expectUnfinished(engine, 2);
  }), 300_000);

  test.each([
    ['git that outlives the probe timeout', 'exec sleep 30'],
    ['git that cannot run', 'exit 126'],
  ])('%s keeps Git effects unfinished', (_name, body) => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    hardenCustomHooks(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    const stub = stubGit(home, body);
    await withEnv({ PATH: `${stub}:${process.env.PATH}` }, async () => { await release(engine); await pass(engine); });
    await expectUnfinished(engine, 2);
  }), 300_000);

  // Windows chmod cannot remove search permission; root bypasses it.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable hooks directory is not absent durability', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    hardenCustomHooks(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 2));
    const hooks = join(repo.root, '.git', 'custom-hooks');
    chmodSync(hooks, 0o000);
    try { await release(engine); await pass(engine); } finally { chmodSync(hooks, 0o755); }
    await expectUnfinished(engine, 2);
    expect(repo.pushes()).toBe(0);
  }), 300_000);

  test('a failed probe fails every coalesced sibling of a shared worktree, with no unhandled rejection', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    mkdirSync(join(repo.root, 'nested'));
    await bindSource(engine, 'default', repo);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('nested', 'nested', $1)", [join(repo.root, 'nested')]);
    await claimWorktree(engine, 'nested', join(repo.root, 'nested'), localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    hardenCustomHooks(repo);
    await pauseGitEffects(engine, async () => { await seed(ctx('nested'), 2, 700); await seed(ctx('default'), 3); });
    const stub = stubGit(home, 'exit 126');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await withEnv({ PATH: `${stub}:${process.env.PATH}` }, async () => { await release(engine); await pass(engine); });
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally { process.off('unhandledRejection', onUnhandled); }
    expect(unhandled).toEqual([]);
    await expectUnfinished(engine, 5);
  }), 300_000);
});
