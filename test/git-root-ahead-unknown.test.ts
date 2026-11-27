/**
 * GCH-03: a removal's retry never completes without its push, and never reads as a commit that was not made, when git
 * cannot tell whether the checkout is ahead of its upstream.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: gitRootAhead answers false only when there is no upstream to push to (none configured, or a tracking ref
 *    never fetched). When the upstream resolves but `rev-list` cannot count past it (a damaged tracking ref), or a step
 *    does not finish, it throws `git_push_unavailable` with diagnostic { phase: push, step: rev-list, reason }. A
 *    removal effect retried then stays queued as a push hold (git_push_holds, never git_commit_holds) and pushes once
 *    the ref is readable. In a grouped pass, a probe that cannot answer holds only the absent targets; a target that
 *    committed still pushes, and a target with its own commit error keeps that error.
 *  - Regression: the effect completing `target_absent` with `push: skipped` while its removal commit stays local (#7089
 *    again), the hold listed as a commit hold, or one probe failure overwriting every target's outcome.
 *  - Why existing coverage misses it: persistence-git-removal-push-7089.test.ts only covers an upstream that reads.
 *  - Seams: a damaged tracking ref is a loose ref file naming an object that does not exist; the grouped case replaces
 *    gitRootAhead with spyOn on its module (effects.ts imports it by name) and asserts the spy fired.
 *
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError, opError } from '../src/core/ops/contract.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import * as effectGit from '../src/core/persistence/effect-git.ts';
import { gitDiagnostic, gitDiagnosticOf, withGitDiagnostic } from '../src/core/persistence/git-diagnostic.ts';
import { readGitCommitHolds } from '../src/core/persistence/git-commit-holds.ts';
import { readGitPushHolds } from '../src/core/persistence/git-push-holds.ts';
import { testBackends } from './helpers/test-backends.ts';
import { type Repo, bindSource, createGitCoalescingFixture, git, harden, pageSlug, pass, pauseGitEffects, putPage, release } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('gch03');
afterAll(dispose);

const MISSING_OBJECT = 'f'.repeat(40);
const head = (repo: Repo) => git(repo.root, 'rev-parse', 'HEAD').trim();
const remoteHead = (repo: Repo) => git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
const trackingRef = (repo: Repo) => join(repo.root, '.git', 'refs', 'remotes', 'origin', 'main');
/** The tracking ref names an object that does not exist: the upstream resolves, `rev-list` cannot count past it. */
const damageTrackingRef = (repo: Repo) => { const sha = git(repo.root, 'rev-parse', 'refs/remotes/origin/main').trim(); writeFileSync(trackingRef(repo), `${MISSING_OBJECT}\n`); return sha; };
const gitEffects = async (engine: BrainEngine) => engine.executeRaw<{ id: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null; last_error: Record<string, unknown> | null; path: string | null }>(
  "SELECT id::text AS id, state, error_code, outcome, data->'last_error' AS last_error, data->>'relative_path' AS path FROM persistence_effects WHERE kind='git' ORDER BY id");

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
  repo.rejectPushes(true);
  await release(engine);
  await pass(engine);
  expect(existsSync(join(repo.root, `${pageSlug(1)}.md`))).toBe(false);
  expect(remoteHead(repo)).not.toBe(head(repo));
  const removal = (await gitEffects(engine)).at(-1)!;
  expect(removal).toMatchObject({ state: 'queued', error_code: 'git_push_unavailable' });
  repo.rejectPushes(false);
  return removal.id;
}

for (const kind of testBackends()) describe(`GCH-03 a removal retried while the upstream cannot be read (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test('stays a queued push hold with step rev-list, is never completed unpushed, and pushes once the ref reads', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    const id = await deleteWithRefusedPush(engine, repo, ctx('default'));
    const good = damageTrackingRef(repo);
    const pushes = repo.pushes();
    await release(engine);
    await pass(engine);
    const held = (await gitEffects(engine)).find(e => e.id === id)!;
    expect({ state: held.state, error_code: held.error_code, last_error: held.last_error })
      .toEqual({ state: 'queued', error_code: 'git_push_unavailable', last_error: { phase: 'push', step: 'rev-list', reason: 'object_missing' } });
    expect(repo.pushes()).toBe(pushes);
    expect(remoteHead(repo)).not.toBe(head(repo));
    expect(await readGitCommitHolds(engine, ['default'])).toEqual([]);
    expect((await readGitPushHolds(engine, ['default'])).map(h => ({ source_id: h.source_id, retrying: h.retrying, codes: h.codes })))
      .toEqual([{ source_id: 'default', retrying: 1, codes: ['git_push_unavailable'] }]);

    writeFileSync(trackingRef(repo), `${good}\n`);
    await release(engine);
    await pass(engine);
    expect(remoteHead(repo)).toBe(head(repo));
    expect((await gitEffects(engine)).find(e => e.id === id)).toMatchObject({ state: 'committed', outcome: { git: 'skipped', reason: 'target_absent', push: 'committed' } });
  }), 300_000);

  test('a grouped pass whose probe cannot answer holds only the absent target; the other target commits and pushes', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = await managedRepo(engine, home);
    const id = await deleteWithRefusedPush(engine, repo, ctx('default'));
    await pauseGitEffects(engine, () => putPage(ctx('default'), 2));
    let probes = 0;
    const spy = spyOn(effectGit, 'gitRootAhead').mockImplementation(async () => {
      probes++;
      throw withGitDiagnostic(opError('git_push_unavailable', 'probe', 'probe failed'), gitDiagnostic('push', 'rev-list', '', 'timeout'));
    });
    try {
      await release(engine);
      await pass(engine);
    } finally { spy.mockRestore(); }
    expect(probes).toBeGreaterThan(0);
    const effects = await gitEffects(engine);
    const removal = effects.find(e => e.id === id)!, page = effects.find(e => e.path === `${pageSlug(2)}.md`)!;
    // F4 first: the probe's failure must not become the outcome of a target that committed.
    expect({ state: page.state, error_code: page.error_code, push: page.outcome?.push }).toEqual({ state: 'committed', error_code: null, push: 'committed' });
    expect({ state: removal.state, error_code: removal.error_code }).toEqual({ state: 'queued', error_code: 'git_push_unavailable' });
    expect(removal.last_error).toEqual({ phase: 'push', step: 'rev-list', reason: 'timeout' });
    expect(git(repo.root, 'ls-files', `${pageSlug(2)}.md`).trim()).toBe(`${pageSlug(2)}.md`);
    // The page's push sent the removal commit too; the removal's own retry then finds nothing left to push.
    expect(remoteHead(repo)).toBe(head(repo));
  }), 300_000);
});

if (testBackends().includes('pglite')) describe('GCH-03 gitRootAhead and publishGitEffect on an absent target', () => {
  const removedAndUnpushed = (repo: Repo) => {
    harden(repo);
    writeFileSync(join(repo.root, 'gone.md'), 'gone\n');
    git(repo.root, 'add', 'gone.md'); git(repo.root, 'commit', '-q', '-m', 'Add'); git(repo.root, 'push', '-q');
    git(repo.root, 'rm', '-q', 'gone.md'); git(repo.root, 'commit', '-q', '-m', 'Remove');
  };

  test('a damaged tracking ref throws git_push_unavailable at rev-list and pushes nothing', () => withBrain('pglite', async ({ home }) => {
    const repo = makeRepo(home, 'single');
    removedAndUnpushed(repo);
    damageTrackingRef(repo);
    const pushes = repo.pushes();
    const error = await effectGit.gitRootAhead(repo.root).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('git_push_unavailable');
    expect(gitDiagnosticOf(error)).toEqual({ phase: 'push', step: 'rev-list', reason: 'object_missing' });
    const published = await effectGit.publishGitEffect(repo.root, 'gone.md', undefined, true).then(() => null, (e: unknown) => e);
    expect((published as OperationError).code).toBe('git_push_unavailable');
    expect(repo.pushes()).toBe(pushes);
  }), 120_000);

  test('no upstream configured, or a tracking ref never fetched: not ahead, as before', () => withBrain('pglite', async ({ home }) => {
    const repo = makeRepo(home, 'single');
    removedAndUnpushed(repo);
    git(repo.root, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(await effectGit.gitRootAhead(repo.root)).toBe(false);
    git(repo.root, 'branch', '--unset-upstream');
    expect(await effectGit.gitRootAhead(repo.root)).toBe(false);
    expect(await effectGit.publishGitEffect(repo.root, 'gone.md', undefined, true)).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  }), 120_000);
});
