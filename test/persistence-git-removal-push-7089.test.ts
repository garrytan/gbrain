/**
 * #7089: a page delete's removal commit must reach the remote even when its first push fails.
 *
 * The grouped runner commits the removal and queues its Git effect on the end-of-pass push; a push failure
 * requeues the effect. On master the retry found the removed path untracked and absent (`target_absent`) and
 * completed the effect without pushing, so the removal commit stayed local while writer status and doctor
 * reported nothing pending. Now an absent target joins the push while the root is ahead of its upstream, a
 * page walk that ends on such a root pushes, and doctor `git_convergence` warns at once about a durable managed
 * checkout that is ahead with no Git effect left to push it.
 *
 * PGLite here; Postgres through test/e2e/persistence-git-removal-push-7089-postgres.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { testBackends } from './helpers/test-backends.ts';
import { type Repo, bindSource, createGitCoalescingFixture, effectSql, git, harden, pageSlug, pass, pauseGitEffects, putPage, release } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('7089');
afterAll(dispose);

const head = (repo: Repo) => git(repo.root, 'rev-parse', 'HEAD').trim();
const remoteHead = (repo: Repo) => git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
const latestGitEffect = async (engine: BrainEngine) => (await engine.executeRaw<{ id: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null }>(
  "SELECT id::text AS id, state, error_code, outcome FROM persistence_effects WHERE kind='git' ORDER BY id DESC LIMIT 1"))[0]!;

async function managedRepo(engine: BrainEngine, home: string): Promise<Repo> {
  const repo = makeRepo(home, 'content');
  await bindSource(engine, 'default', repo);
  await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
  harden(repo);
  return repo;
}

/** Put page 1 and push it, then delete it with every push refused: the removal is committed locally and its effect requeued. */
async function deleteWithRefusedPush(engine: BrainEngine, repo: Repo, ctx: OperationContext): Promise<string> {
  await pauseGitEffects(engine, () => putPage(ctx, 1));
  await release(engine);
  await pass(engine);
  expect(remoteHead(repo)).toBe(head(repo));
  const snapshot = await engine.readPageSnapshot(pageSlug(1), { sourceId: 'default' });
  await pauseGitEffects(engine, () => submitPageMutation(ctx, { operation: 'delete_page',
    params: { slug: pageSlug(1), expected_revision: snapshot!.revision, request_id: randomUUID() } }));
  expect(existsSync(join(repo.root, `${pageSlug(1)}.md`))).toBe(false);
  repo.rejectPushes(true);
  await release(engine);
  await pass(engine);
  expect(git(repo.root, 'log', '-1', '--name-status', '--format=').trim()).toBe(`D\t${pageSlug(1)}.md`);
  expect(remoteHead(repo)).not.toBe(head(repo));
  const removal = await latestGitEffect(engine);
  expect(removal).toMatchObject({ state: 'queued', error_code: 'git_push_unavailable' });
  return removal.id;
}

const localCommit = (repo: Repo) => {
  writeFileSync(join(repo.root, 'local.md'), 'local\n');
  git(repo.root, 'add', 'local.md'); git(repo.root, 'commit', '-q', '-m', 'Local commit');
};

for (const kind of testBackends()) describe(`#7089 removal commits are pushed on retry (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test('a removal whose first push failed is pushed by the next pass and records the push, never a silent skip', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    const id = await deleteWithRefusedPush(engine, repo, ctx('default'));
    repo.rejectPushes(false);
    const pushes = repo.pushes();
    await release(engine);
    await pass(engine);
    expect(repo.pushes()).toBe(pushes + 1);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(await latestGitEffect(engine)).toMatchObject({ id, state: 'committed', outcome: { git: 'skipped', reason: 'target_absent', push: 'committed' } });
  }), 300_000);

  test('while the push keeps failing the removal stays queued with the push code, then pushes once the remote is back', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    const id = await deleteWithRefusedPush(engine, repo, ctx('default'));
    await release(engine);
    await pass(engine);
    expect(await latestGitEffect(engine)).toMatchObject({ id, state: 'queued', error_code: 'git_push_unavailable' });
    expect(remoteHead(repo)).not.toBe(head(repo));
    repo.rejectPushes(false);
    await release(engine);
    await pass(engine);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(await latestGitEffect(engine)).toMatchObject({ id, state: 'committed', outcome: { push: 'committed' } });
  }), 300_000);

  test('an absent target on a root that is not ahead completes without a push attempt, even with the remote down', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    const id = await deleteWithRefusedPush(engine, repo, ctx('default'));
    repo.rejectPushes(false);
    git(repo.root, 'push', '-q');
    expect(remoteHead(repo)).toBe(head(repo));
    repo.rejectPushes(true);
    const pushes = repo.pushes();
    await release(engine);
    await pass(engine);
    expect(repo.pushes()).toBe(pushes);
    expect(await latestGitEffect(engine)).toMatchObject({ id, state: 'committed', outcome: { git: 'skipped', reason: 'target_absent', push: 'skipped' } });
  }), 300_000);

  test('a Git page walk that ends while the root is ahead pushes before it completes', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    await pauseGitEffects(engine, () => putPage(ctx('default'), 2));
    const walk = await latestGitEffect(engine);
    await effectSql(engine, `UPDATE persistence_effects SET data=data||'{"source_scan":true,"after_slug":"zzzz"}'::jsonb WHERE id=$1`, [walk.id]);
    localCommit(repo);
    expect(remoteHead(repo)).not.toBe(head(repo));
    await release(engine);
    await pass(engine);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(await latestGitEffect(engine)).toMatchObject({ id: walk.id, state: 'committed', outcome: { push: 'committed' } });
  }), 300_000);

  test('doctor git_convergence warns at once about a durable managed checkout ahead with no Git effect to push it', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    expect((await gitConvergenceCheck(engine))?.status).toBe('ok');
    localCommit(repo);
    const check = await gitConvergenceCheck(engine);
    expect(check).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', repo.root],
      actor: 'agent', verify: { argv: expect.arrayContaining(['doctor', 'git_convergence']) } } });
    expect(check!.message).toContain('no Git effect queued, running or parked');
    expect((check!.details as { roots: unknown[] }).roots).toEqual([expect.objectContaining({ root: repo.root, ahead: 1, stranded: true })]);

    await pauseGitEffects(engine, () => putPage(ctx('default'), 3));
    const pending = await gitConvergenceCheck(engine);
    expect(pending?.status).toBe('ok');
    expect((pending!.details as { roots: Array<{ stranded?: boolean }> }).roots[0]!.stranded).toBeUndefined();

    await release(engine);
    await pass(engine);
    expect(remoteHead(repo)).toBe(head(repo));
    expect((await gitConvergenceCheck(engine))?.status).toBe('ok');
  }), 300_000);

  test('doctor git_convergence never calls a checkout stranded on a host that no longer owns it (its binding outlives a transfer)', () => withBrain(kind, async ({ engine, home }) => {
    const repo = await managedRepo(engine, home);
    localCommit(repo);
    expect((await gitConvergenceCheck(engine))?.status).toBe('warn');
    await engine.executeRaw("UPDATE persistence_worktrees SET owner_host_id='00000000-0000-4000-8000-0000000000ff'::uuid");
    const moved = await gitConvergenceCheck(engine);
    expect(moved?.status).toBe('ok');
    expect(moved?.fix).toBeUndefined();
    expect((moved!.details as { roots: Array<{ stranded?: boolean }> }).roots[0]!.stranded).toBeUndefined();
  }), 300_000);
});

if (testBackends().includes('pglite')) describe('#7089 publishGitEffect on an absent target', () => {
  test('pushes a removal an earlier attempt committed while the root is ahead, and pushes nothing when it is not', () => withBrain('pglite', async ({ home }) => {
    const repo = makeRepo(home, 'single');
    harden(repo);
    writeFileSync(join(repo.root, 'gone.md'), 'gone\n');
    git(repo.root, 'add', 'gone.md'); git(repo.root, 'commit', '-q', '-m', 'Add'); git(repo.root, 'push', '-q');
    git(repo.root, 'rm', '-q', 'gone.md'); git(repo.root, 'commit', '-q', '-m', 'Remove');
    const pushes = repo.pushes();
    expect(await publishGitEffect(repo.root, 'gone.md', undefined, true)).toEqual({ git: 'skipped', reason: 'target_absent', push: 'committed' });
    expect(repo.pushes()).toBe(pushes + 1);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(await publishGitEffect(repo.root, 'gone.md', undefined, true)).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
    expect(repo.pushes()).toBe(pushes + 1);
  }), 120_000);
});
