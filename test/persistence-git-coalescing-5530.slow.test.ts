/**
 * #5530: the effect runner coalesces ready single-file Git effects.
 *
 * The v0.13.1 grandfather step admits one put_page per page; before this fix
 * every page's Git effect made its own `git commit` and its own synchronous
 * `git push`. The runner now claims up to 100 ready single-file Git effects
 * for the same worktree, validates each path under the worktree lock, makes
 * one `commit --only` per group and pushes each root once per pass. A path
 * failure fails only its own effect; a failed push leaves the group
 * retryable and the next pass pushes once.
 *
 * Git effects are held back ("effect worker paused") with a future
 * `next_attempt_at` default, then released and drained with one explicit
 * runner pass, so commit and push counts are deterministic. Pushes are
 * counted by a pre-receive hook on the local bare remote.
 *
 * PGLite here; Postgres through test/e2e/persistence-git-coalescing-5530-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { phaseCGrandfather } from '../src/commands/migrations/v0_13_1.ts';
import { admitCanonicalGrandfather } from '../src/core/persistence/grandfather.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const HOOK = '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n';

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

interface Repo { root: string; remote: string; pushes: () => number; rejectPushes: (on: boolean) => void; commits: () => number }

function makeRepo(home: string, name: string): Repo {
  const root = join(home, name), remote = join(home, `${name}.git`), log = join(home, `${name}.pushes`), reject = join(home, `${name}.reject`);
  mkdirSync(root); mkdirSync(remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  git(root, 'add', 'README.md'); git(root, 'commit', '-q', '-m', 'Initial');
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  const preReceive = join(remote, 'hooks', 'pre-receive');
  writeFileSync(preReceive, `#!/bin/sh\necho push >> '${log}'\n[ -f '${reject}' ] && exit 1\nexit 0\n`);
  chmodSync(preReceive, 0o755);
  return {
    root, remote,
    pushes: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0,
    rejectPushes: on => { if (on) writeFileSync(reject, ''); else rmSync(reject, { force: true }); },
    commits: () => Number(git(root, 'rev-list', '--count', 'HEAD').trim()),
  };
}

function harden(repo: Repo): void {
  git(repo.root, 'add', '-A'); git(repo.root, 'commit', '-q', '-m', 'Seed', '--allow-empty'); git(repo.root, 'push', '-q');
  rmSync(join(repo.remote, '..', `${repo.root.split('/').pop()}.pushes`), { force: true });
  const hook = join(repo.root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, HOOK); chmodSync(hook, 0o755);
}

const pageContent = (i: number, note = '') => `---\ntype: note\ntitle: Page ${i}\n---\n\nCoalescing page ${i}.${note}\n`;

async function withBrain(kind: 'pglite' | 'postgres', run: (b: { engine: BrainEngine; home: string; ctx: (source: string) => OperationContext }) => Promise<void>) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-coalesce-5530-')));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(kind === 'postgres' ? process.env.GBRAIN_TEST_COALESCE_PG! : undefined);
      try {
        const ctx = (source: string) => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: source,
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as OperationContext;
        await run({ engine, home, ctx });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function bindSource(engine: BrainEngine, source: string, repo: Repo): Promise<void> {
  if (source !== 'default') await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, repo.root]);
  else await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo.root]);
  await claimWorktree(engine, source, repo.root, localHostId());
}

async function seed(ctx: OperationContext, count: number, offset = 0): Promise<void> {
  for (let i = offset; i < offset + count; i++) {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: `notes/page-${String(i).padStart(4, '0')}`, request_id: randomUUID(), content: pageContent(i) } });
  }
}

async function pauseGitEffects<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
  try { return await run(); } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
  }
}

const effectSql = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
const release = (engine: BrainEngine) => effectSql(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
const pass = (engine: BrainEngine) => runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
const gitStates = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ state: string; n: number }>(
  "SELECT state, count(*)::int AS n FROM persistence_effects WHERE kind='git' GROUP BY state ORDER BY state")).map(r => [r.state, Number(r.n)]));

const PAGES = Number(process.env.GBRAIN_TEST_COALESCE_PAGES ?? 250);

for (const kind of testBackends()) describe(`#5530 Git effect coalescing (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test(`${PAGES} grandfathered pages give ${Math.ceil(PAGES / 100)} commits and 1 push; an interleaved write still completes`, () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await seed(ctx('default'), PAGES - 1);
    await disposePersistenceConsumer(engine);
    harden(repo);
    const commitsBefore = repo.commits();
    await pauseGitEffects(engine, async () => {
      const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true } as never);
      expect(result.detail).toMatchObject({ touched: PAGES - 1, failed: 0 });
      // An ordinary write on the same source publishes while the grandfather's Git work is still pending.
      const ordinary = await submitPageMutation(ctx('default'), { operation: 'put_page', params: { slug: 'notes/ordinary', request_id: randomUUID(), content: pageContent(9999) } }) as { state?: string };
      expect(ordinary.state).toBe('committed');
    });
    expect(await gitStates(engine)).toMatchObject({ queued: PAGES });
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: PAGES + (PAGES - 1) });
    expect(repo.commits() - commitsBefore).toBe(Math.ceil(PAGES / 100));
    expect(repo.pushes()).toBe(1);
    expect(git(repo.remote, 'rev-parse', 'main').trim()).toBe(git(repo.root, 'rev-parse', 'HEAD').trim());
    expect(git(repo.root, 'status', '--porcelain').trim()).toBe('');
  }), 900_000);

  test('two sources commit separately and push once each', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const a = makeRepo(home, 'alpha'), b = makeRepo(home, 'beta');
    await bindSource(engine, 'default', a);
    await bindSource(engine, 'beta', b);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(a); harden(b);
    const [ca, cb] = [a.commits(), b.commits()];
    await pauseGitEffects(engine, async () => { await seed(ctx('default'), 5); await seed(ctx('beta'), 7, 100); });
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toMatchObject({ committed: 12 });
    expect([a.commits() - ca, b.commits() - cb]).toEqual([1, 1]);
    expect([a.pushes(), b.pushes()]).toEqual([1, 1]);
  }), 300_000);

  test('a failed push leaves the group retryable and the next pass pushes once', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    const commitsBefore = repo.commits();
    await pauseGitEffects(engine, () => seed(ctx('default'), 6));
    repo.rejectPushes(true);
    await release(engine);
    await pass(engine);
    expect(repo.commits() - commitsBefore).toBe(1);
    expect(repo.pushes()).toBe(1);
    expect(await gitStates(engine)).toEqual({ queued: 6 });
    expect(new Set((await engine.executeRaw<{ error_code: string }>("SELECT error_code FROM persistence_effects WHERE kind='git'")).map(r => r.error_code)))
      .toEqual(new Set(['git_push_unavailable']));
    repo.rejectPushes(false);
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 6 });
    expect(repo.commits() - commitsBefore).toBe(1);
    expect(repo.pushes()).toBe(2);
    expect(git(repo.remote, 'rev-parse', 'main').trim()).toBe(git(repo.root, 'rev-parse', 'HEAD').trim());
  }), 300_000);

  test('one unsafe path fails only its own effect; the rest of the group commits', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    const commitsBefore = repo.commits();
    await pauseGitEffects(engine, () => seed(ctx('default'), 10));
    await effectSql(engine, `UPDATE persistence_effects SET data=jsonb_set(data,'{relative_path}','"../outside.md"')
      WHERE id=(SELECT id FROM persistence_effects WHERE kind='git' ORDER BY id LIMIT 1 OFFSET 4)`);
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 9, queued: 1 });
    expect(repo.commits() - commitsBefore).toBe(1);
    expect(git(repo.root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toHaveLength(9);
    expect(repo.pushes()).toBe(1);
  }), 300_000);

  test('a Git effect waits for its request\'s withdrawal mirror and is never coalesced ahead of it', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 4));
    const [held] = await engine.executeRaw<{ request_id: string; source_id: string; source_incarnation: string; worktree_id: string }>(
      "SELECT request_id, source_id, source_incarnation, worktree_id FROM persistence_effects WHERE kind='git' ORDER BY id DESC LIMIT 1");
    await effectSql(engine, `INSERT INTO persistence_effects (request_id,kind,data,source_id,source_incarnation,worktree_id,next_attempt_at)
      VALUES ($1::uuid,'withdrawal-mirror','{}'::jsonb,$2,$3::uuid,$4::uuid,now()+interval '1 hour')`, [held.request_id, held.source_id, held.source_incarnation, held.worktree_id]);
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 3, queued: 1 });
    expect(await engine.executeRaw("SELECT state FROM persistence_effects WHERE kind='git' AND request_id=$1::uuid", [held.request_id])).toEqual([{ state: 'queued' }]);
  }), 300_000);
  test('a short group yields to a queued publication on its worktree, within a bounded number of claims', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await seed(ctx('default'), 1, 500);
    await disposePersistenceConsumer(engine);
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 3));
    const commitsBefore = repo.commits();
    const [target] = await engine.executeRaw<{ id: number; slug: string; source_id: string; source_incarnation: string }>(
      "SELECT p.id,p.slug,p.source_id,s.incarnation AS source_incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug='notes/page-0500'");
    // Admitted and not yet published: the publication is queued for the same worktree.
    const admitted = await admitCanonicalGrandfather(engine, target!, () => {});
    expect(admitted.status).toBe('admitted');
    await release(engine);
    await pass(engine);
    expect(repo.commits()).toBe(commitsBefore);
    expect(await engine.executeRaw("SELECT DISTINCT state, error_code FROM persistence_effects WHERE kind='git' AND state<>'committed'"))
      .toEqual([{ state: 'queued', error_code: 'publication_pending' }]);
    // The yield is bounded: past the claim budget the group commits even with the publication still queued.
    await effectSql(engine, "UPDATE persistence_effects SET attempts=21 WHERE kind='git' AND state='queued'");
    await release(engine);
    await pass(engine);
    expect(repo.commits() - commitsBefore).toBe(1);
    expect(await gitStates(engine)).toEqual({ committed: 4 });
    if (admitted.status === 'admitted') expect((await admitted.complete()).revision).toBeTruthy();
  }), 300_000);
  test('sources sharing one worktree are each validated against their own binding', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    mkdirSync(join(repo.root, 'nested'));
    await bindSource(engine, 'default', repo);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('nested', 'nested', $1)", [join(repo.root, 'nested')]);
    await claimWorktree(engine, 'nested', join(repo.root, 'nested'), localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const [shared] = await engine.executeRaw<{ n: number }>('SELECT count(DISTINCT worktree_id)::int AS n FROM persistence_source_bindings');
    expect(Number(shared!.n)).toBe(1);
    harden(repo);
    const commitsBefore = repo.commits();
    // The nested source's effect is claimed first, so it seeds the group.
    await pauseGitEffects(engine, async () => { await seed(ctx('nested'), 2, 700); await seed(ctx('default'), 3); });
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 5 });
    expect(repo.commits() - commitsBefore).toBe(1);
    expect(git(repo.root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort())
      .toEqual(['nested/notes/page-0700.md', 'nested/notes/page-0701.md', 'notes/page-0000.md', 'notes/page-0001.md', 'notes/page-0002.md']);
  }), 300_000);
  test('without the durability hook, coalesced siblings of a shared worktree record their own outcome', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    mkdirSync(join(repo.root, 'nested'));
    await bindSource(engine, 'default', repo);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('nested', 'nested', $1)", [join(repo.root, 'nested')]);
    await claimWorktree(engine, 'nested', join(repo.root, 'nested'), localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await pauseGitEffects(engine, async () => { await seed(ctx('nested'), 2, 700); await seed(ctx('default'), 3); });
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 5 });
    expect(new Set((await engine.executeRaw<{ reason: string }>("SELECT outcome->>'reason' AS reason FROM persistence_effects WHERE kind='git'")).map(r => r.reason)))
      .toEqual(new Set(['durability_not_enabled']));
  }), 300_000);
});
