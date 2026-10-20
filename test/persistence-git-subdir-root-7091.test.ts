/**
 * #7091: a managed source whose root sits below the Git toplevel (local_path = <repo>/brain) with Git durability on.
 *
 * commitGitTargets compared ls-files paths (relative to the root) with status and `diff --cached --name-only` paths
 * (relative to the toplevel), so an edit to an already-tracked page and a page removal completed `{ git: 'unchanged' }`
 * and nothing was committed or pushed, while writer status showed nothing pending. Every listing now compares on one
 * base. Doctor `git_convergence` maps such a root to its toplevel, so its #7089 `stranded` warning fires there too, and
 * it also warns about tracked files modified under a durable root with no Git effect left to commit them.
 *
 * PGLite here; Postgres through test/e2e/persistence-git-subdir-root-7091-postgres.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { testBackends } from './helpers/test-backends.ts';
import { type Repo, bindSource, createGitCoalescingFixture, git, harden, pageSlug, pass, pauseGitEffects, putPage, release } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('7091');
afterAll(dispose);

const SUBDIR = 'brain';
const head = (repo: Repo) => git(repo.root, 'rev-parse', 'HEAD').trim();
const remoteHead = (repo: Repo) => git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
const pending = (repo: Repo) => git(repo.root, 'status', '--porcelain', '--', '.').trim();
const latestGitEffect = async (engine: BrainEngine) => (await engine.executeRaw<{ id: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null }>(
  "SELECT id::text AS id, state, error_code, outcome FROM persistence_effects WHERE kind='git' ORDER BY id DESC LIMIT 1"))[0]!;

/** A repository whose managed source root is its `brain/` subdirectory, with Git durability on through the hook. */
async function subdirRepo(engine: BrainEngine, home: string): Promise<{ top: Repo; repo: Repo }> {
  const top = makeRepo(home, 'content');
  mkdirSync(join(top.root, SUBDIR));
  writeFileSync(join(top.root, SUBDIR, 'README.md'), 'brain\n');
  const repo = { ...top, root: join(top.root, SUBDIR) };
  // The reporter's binding: the worktree recorded at the source directory itself, as when the directory was claimed
  // before it sat in a larger repository, not at the toplevel a fresh claim inside a repository discovers.
  renameSync(join(top.root, '.git'), join(top.root, '.git-hidden'));
  try { await bindSource(engine, 'default', repo); } finally { renameSync(join(top.root, '.git-hidden'), join(top.root, '.git')); }
  expect((await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM persistence_host_bindings'))[0]!.local_path).toBe(repo.root);
  await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
  harden(top);
  return { top, repo };
}

/** Put page `i`, then run its Git effect: committed and pushed, with nothing left in the source root. */
async function putAndPublish(engine: BrainEngine, repo: Repo, ctx: OperationContext, i: number, content?: string): Promise<void> {
  const revision = content === undefined ? undefined : (await engine.readPageSnapshot(pageSlug(i), { sourceId: 'default' }))!.revision;
  await pauseGitEffects(engine, () => content === undefined ? putPage(ctx, i)
    : submitPageMutation(ctx, { operation: 'put_page', params: { slug: pageSlug(i), request_id: randomUUID(), content, expected_revision: revision } }));
  await release(engine);
  await pass(engine);
}

const edited = (i: number) => `---\ntype: note\ntitle: Page ${i}\n---\n\nEdited page ${i}.\n`;

for (const kind of testBackends()) describe(`#7091 a source root below the Git toplevel (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test('an edit to a tracked page commits and pushes, never a silent unchanged', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const { repo } = await subdirRepo(engine, home);
    await putAndPublish(engine, repo, ctx('default'), 1);
    expect(git(repo.root, 'log', '-1', '--name-only', '--format=').trim()).toBe(`${SUBDIR}/${pageSlug(1)}.md`);
    expect(remoteHead(repo)).toBe(head(repo));
    const before = head(repo);
    await putAndPublish(engine, repo, ctx('default'), 1, edited(1));
    expect(head(repo)).not.toBe(before);
    expect(git(repo.root, 'log', '-1', '--name-only', '--format=').trim()).toBe(`${SUBDIR}/${pageSlug(1)}.md`);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(pending(repo)).toBe('');
    expect(await latestGitEffect(engine)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  }), 300_000);

  test('a page delete commits its removal and pushes it', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const { repo } = await subdirRepo(engine, home);
    await putAndPublish(engine, repo, ctx('default'), 1);
    const snapshot = await engine.readPageSnapshot(pageSlug(1), { sourceId: 'default' });
    await pauseGitEffects(engine, () => submitPageMutation(ctx('default'), { operation: 'delete_page',
      params: { slug: pageSlug(1), expected_revision: snapshot!.revision, request_id: randomUUID() } }));
    expect(existsSync(join(repo.root, `${pageSlug(1)}.md`))).toBe(false);
    await release(engine);
    await pass(engine);
    expect(git(repo.root, 'log', '-1', '--name-status', '--format=').trim()).toBe(`D\t${SUBDIR}/${pageSlug(1)}.md`);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(pending(repo)).toBe('');
    expect(await latestGitEffect(engine)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  }), 300_000);

  test('a removal whose first push failed is pushed by the next pass (#7089 on a subdirectory root)', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const { repo } = await subdirRepo(engine, home);
    await putAndPublish(engine, repo, ctx('default'), 1);
    const snapshot = await engine.readPageSnapshot(pageSlug(1), { sourceId: 'default' });
    await pauseGitEffects(engine, () => submitPageMutation(ctx('default'), { operation: 'delete_page',
      params: { slug: pageSlug(1), expected_revision: snapshot!.revision, request_id: randomUUID() } }));
    repo.rejectPushes(true);
    await release(engine);
    await pass(engine);
    expect(git(repo.root, 'log', '-1', '--name-status', '--format=').trim()).toBe(`D\t${SUBDIR}/${pageSlug(1)}.md`);
    expect(await latestGitEffect(engine)).toMatchObject({ state: 'queued', error_code: 'git_push_unavailable' });
    repo.rejectPushes(false);
    await release(engine);
    await pass(engine);
    expect(remoteHead(repo)).toBe(head(repo));
    expect(await latestGitEffect(engine)).toMatchObject({ state: 'committed', outcome: { push: 'committed' } });
  }), 300_000);

  test('managed sync imports a page committed under the subdirectory root and an edit to it', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const { top, repo } = await subdirRepo(engine, home);
    await putAndPublish(engine, repo, ctx('default'), 1);
    const page = `${SUBDIR}/notes/synced.md`;
    mkdirSync(join(top.root, SUBDIR, 'notes'), { recursive: true });
    writeFileSync(join(top.root, page), '---\ntype: note\ntitle: Synced\n---\n\nFirst body.\n');
    git(top.root, 'add', page); git(top.root, 'commit', '-q', '-m', 'Add synced');
    await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
    expect((await engine.readPageSnapshot('notes/synced', { sourceId: 'default' }))?.page.compiled_truth).toContain('First body.');
    writeFileSync(join(top.root, page), '---\ntype: note\ntitle: Synced\n---\n\nSecond body.\n');
    git(top.root, 'commit', '-q', '-am', 'Edit synced');
    await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
    expect((await engine.readPageSnapshot('notes/synced', { sourceId: 'default' }))?.page.compiled_truth).toContain('Second body.');
  }), 300_000);

  test('doctor git_convergence calls a subdirectory root stranded: commits ahead, then tracked pages nobody will commit', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const { top, repo } = await subdirRepo(engine, home);
    await putAndPublish(engine, repo, ctx('default'), 1);
    expect((await gitConvergenceCheck(engine))?.status).toBe('ok');

    writeFileSync(join(top.root, 'outside.md'), 'outside\n');
    git(top.root, 'add', 'outside.md'); git(top.root, 'commit', '-q', '-m', 'Local commit');
    const ahead = await gitConvergenceCheck(engine);
    expect(ahead).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', top.root], actor: 'agent' } });
    expect((ahead!.details as { roots: unknown[] }).roots).toEqual([expect.objectContaining({ root: top.root, ahead: 1, stranded: true })]);
    git(top.root, 'push', '-q');

    writeFileSync(join(top.root, 'outside.md'), 'outside edit\n');
    const outside = await gitConvergenceCheck(engine);
    expect(outside?.status, JSON.stringify(outside)).toBe('ok');
    const page = `${SUBDIR}/${pageSlug(1)}.md`;
    writeFileSync(join(top.root, page), edited(1));
    const dirty = await gitConvergenceCheck(engine);
    expect(dirty).toMatchObject({ status: 'warn', fix: { ask_user: true, actor: 'user', argv: ['git', '-C', top.root, 'commit', '-m', 'gbrain: persist canonical memory update', '--', page],
      then: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', top.root] } } });
    expect((dirty!.details as { roots: unknown[] }).roots).toEqual([expect.objectContaining({ root: top.root, stranded: true, uncommitted_pages: [page] })]);
  }), 300_000);
});

if (testBackends().includes('pglite')) describe('#7091 commitGitTargets on a root below the toplevel', () => {
  test('commits a modified tracked file and a removal, each relative to the root', () => withBrain('pglite', async ({ home }) => {
    const top = makeRepo(home, 'direct');
    const root = join(top.root, SUBDIR);
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people', 'x.md'), 'x\n');
    writeFileSync(join(root, 'people', 'y.md'), 'y\n');
    git(top.root, 'add', '-A'); git(top.root, 'commit', '-q', '-m', 'Add');
    writeFileSync(join(root, 'people', 'x.md'), 'x edited\n');
    expect(await commitGitTargets(root, ['people/x.md'])).toEqual(new Map([['people/x.md', { git: 'committed' }]]));
    expect(git(top.root, 'log', '-1', '--name-only', '--format=').trim()).toBe(`${SUBDIR}/people/x.md`);
    rmSync(join(root, 'people', 'y.md'));
    const removal = [...await commitGitTargets(root, ['people/y.md'])];
    expect(removal, JSON.stringify(removal)).toEqual([['people/y.md', { git: 'committed' }]]);
    expect(git(top.root, 'log', '-1', '--name-status', '--format=').trim()).toBe(`D\t${SUBDIR}/people/y.md`);
    expect(git(top.root, 'status', '--porcelain').trim()).toBe('');
  }), 120_000);
});
