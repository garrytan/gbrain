/**
 * #5530: the effect runner coalesces ready single-file Git effects.
 *
 * A bulk rewrite admits one put_page per page; before this fix
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
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { preparePageAdmission, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { PAGE_BATCH_MAX_PAGES, submitPageBatch } from '../src/core/persistence/page-batch.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimCoalescedGitEffects } from '../src/core/persistence/effect-journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { type Repo, bindSource, createGitCoalescingFixture, effectSql, git, gitStates, harden, pageContent, pageSlug, pass, pauseGitEffects, putPage, release, seed, seedSequentially } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('5530');
afterAll(dispose);

function stubGit(home: string, body: string): string {
  const dir = join(home, `stub-git-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

/** Update pages 0..count-1 through put_pages batches: one managed Git effect per page, as a bulk rewrite admits. */
async function updateBurst(ctx: OperationContext, count: number): Promise<void> {
  for (let start = 0; start < count; start += PAGE_BATCH_MAX_PAGES) {
    const pages = await Promise.all(Array.from({ length: Math.min(PAGE_BATCH_MAX_PAGES, count - start) }, async (_, k) => ({ slug: pageSlug(start + k), content: pageContent(start + k, ' updated'),
      expected_revision: (await ctx.engine.readPageSnapshot(pageSlug(start + k), { sourceId: 'default' }))!.revision })));
    expect((await submitPageBatch(ctx, { request_id: randomUUID(), pages })).state).toBe('committed');
  }
}

const PAGES = Number(process.env.GBRAIN_TEST_COALESCE_PAGES ?? 250);
// Six full groups whose commits each take a second: on master the write waits out about six seconds of them.
const BACKLOG = 600, COMMIT_SLEEP_S = 1;
/** Two full Git groups and one settle pass: the mixed-backlog probe needs a commit in flight, not the full-group depth. */
const MIXED_BACKLOG = 200;
/** One full put_pages batch plus a partial one: the seed-equality check crosses a batch boundary. */
const SEED_EQUALITY_PAGES = 55;

for (const kind of testBackends()) describe(`#5530 Git effect coalescing (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  // Fix wave 16: setup seeds go through put_pages. The batch seed must leave the brain as the per-page
  // seed did: the same Git effect rows (payload, state, id order), the same page hashes, nothing committed.
  test('the put_pages seed leaves the same Git effect rows and page hashes as put_page per page', async () => {
    const snapshot = async (seeder: (ctx: OperationContext, count: number) => Promise<void>) => {
      let state: unknown;
      await withBrain(kind, async ({ engine, home, ctx }) => {
        const repo = makeRepo(home, 'content');
        await bindSource(engine, 'default', repo);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        harden(repo);
        const commitsBefore = repo.commits();
        await pauseGitEffects(engine, () => seeder(ctx('default'), SEED_EQUALITY_PAGES));
        const effects = await engine.executeRaw<{ state: string; error_code: string | null; attempts: number; data: Record<string, unknown>; page: string }>(
          `SELECT e.state, e.error_code, e.attempts, e.data, p.slug AS page FROM persistence_effects e JOIN pages p ON p.id=(e.data->>'page_id')::int
           WHERE e.kind='git' ORDER BY e.id`);
        const pages = await engine.executeRaw<{ slug: string; content_hash: string }>('SELECT slug, content_hash FROM pages ORDER BY slug');
        // The written file carries `ingested_at`, so its hash differs between any two seeds: compare the
        // payload keys, the hash against the file it names, and the file with that one line removed.
        state = {
          effects: effects.map(e => {
            const file = readFileSync(join(repo.root, String(e.data.relative_path)), 'utf8');
            return { state: e.state, error_code: e.error_code, attempts: Number(e.attempts), page: e.page,
              keys: Object.keys(e.data).sort(), slug: e.data.slug, relative_path: e.data.relative_path,
              hash_matches_file: e.data.expected_hash === createHash('sha256').update(file).digest('hex'),
              file: file.replace(/^ingested_at: .*\n/m, '') };
          }),
          pages: pages.map(p => [p.slug, p.content_hash]),
          gitStates: await gitStates(engine), commits: repo.commits() - commitsBefore, pushes: repo.pushes(),
        };
      });
      return state as { effects: unknown[]; gitStates: Record<string, number>; commits: number };
    };
    const sequential = await snapshot(seedSequentially);
    expect(sequential.gitStates).toEqual({ queued: SEED_EQUALITY_PAGES });
    expect(sequential.commits).toBe(0);
    expect(sequential.effects.map(e => (e as { slug: string }).slug)).toEqual(Array.from({ length: SEED_EQUALITY_PAGES }, (_, i) => `notes/page-${String(i).padStart(4, '0')}`));
    expect(await snapshot(seed)).toEqual(sequential);
  }, 300_000);

  test(`${PAGES - 1} updated pages plus one write give ${Math.ceil(PAGES / 100)} commits and 1 push; an interleaved write still completes`, () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    // The seed's own Git effects are setup, not under test: hold them while
    // seeding (the consumer would otherwise probe the worktree once per page)
    // and apply them all here, before hardening, so only the update burst's and
    // the interleaved write's effects are pending below.
    await pauseGitEffects(engine, () => seed(ctx('default'), PAGES - 1));
    for (let i = 0; (await gitStates(engine)).queued && i < 50; i++) { await release(engine); await pass(engine); }
    expect((await gitStates(engine)).queued).toBeUndefined();
    harden(repo);
    const commitsBefore = repo.commits();
    await pauseGitEffects(engine, async () => {
      await updateBurst(ctx('default'), PAGES - 1);
      // An ordinary write on the same source publishes while the update burst's Git work is still pending.
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
    await putPage(ctx('default'), 500);
    await disposePersistenceConsumer(engine);
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 3));
    const commitsBefore = repo.commits();
    const [target] = await engine.executeRaw<{ id: number; slug: string; source_id: string; source_incarnation: string }>(
      "SELECT p.id,p.slug,p.source_id,s.incarnation AS source_incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug='notes/page-0500'");
    // Admitted and not yet published: the publication is queued for the same worktree.
    const update = { operation: 'put_page', params: { slug: target!.slug, request_id: randomUUID(), content: pageContent(500, ' updated'),
      expected_revision: (await engine.readPageSnapshot(target!.slug, { sourceId: 'default' }))!.revision } };
    await admitWrite(engine, (await preparePageAdmission(ctx('default'), update)).admission!);
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
    expect((await submitPageMutation(ctx('default'), update)).state).toBe('committed');
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
  // Wave 8: a group without the durability hook guards each source once and records its plain outcomes in one
  // statement. Every other outcome (a replaced file, an unsafe path, an archived source) is unchanged.
  test('without the durability hook, a group records its outcomes in one statement and one guard transaction per source', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    mkdirSync(join(repo.root, 'nested'));
    await bindSource(engine, 'default', repo);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('nested', 'nested', $1)", [join(repo.root, 'nested')]);
    await claimWorktree(engine, 'nested', join(repo.root, 'nested'), localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await pauseGitEffects(engine, async () => { await seed(ctx('nested'), 3, 700); await seed(ctx('default'), 30); });
    await release(engine);
    const outcomeWrites: string[] = [];
    let transactions = 0;
    const executeRaw = engine.executeRaw, transaction = engine.transaction;
    Object.assign(engine, {
      executeRaw(this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>) { if (/^UPDATE persistence_effects\b[\s\S]*outcome=/.test(args[0])) outcomeWrites.push(args[0]); return executeRaw.apply(this, args); },
      transaction(this: BrainEngine, ...args: Parameters<BrainEngine['transaction']>) { transactions++; return transaction.apply(this, args); },
    });
    try { await pass(engine); } finally { Object.assign(engine, { executeRaw, transaction }); }
    expect(await gitStates(engine)).toEqual({ committed: 33 });
    expect(outcomeWrites).toHaveLength(1);
    // Two guards (one per source) plus the pass's fixed claim transactions; one guard per effect made 37.
    expect(transactions).toBeLessThanOrEqual(6);
  }), 300_000);
  test('without the durability hook, every effect of a mixed group keeps its own outcome', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    mkdirSync(join(repo.root, 'nested'));
    await bindSource(engine, 'default', repo);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('nested', 'nested', $1)", [join(repo.root, 'nested')]);
    await claimWorktree(engine, 'nested', join(repo.root, 'nested'), localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await pauseGitEffects(engine, async () => { await seed(ctx('default'), 6); await seed(ctx('nested'), 2, 700); });
    await effectSql(engine, `UPDATE persistence_effects SET data=jsonb_set(data,'{relative_path}','"../outside.md"')
      WHERE id=(SELECT id FROM persistence_effects WHERE kind='git' ORDER BY id LIMIT 1 OFFSET 2)`);
    writeFileSync(join(repo.root, 'notes', 'page-0004.md'), pageContent(4, ' Edited by hand.'));
    await effectSql(engine, "UPDATE persistence_effects SET source_incarnation=gen_random_uuid() WHERE kind='git' AND source_id='nested'");
    await release(engine);
    await pass(engine);
    const rows = await engine.executeRaw<{ slug: string; state: string; error_code: string | null; reason: string | null; git: string | null }>(`SELECT data->>'slug' AS slug,
      state,error_code,outcome->>'reason' AS reason,outcome->>'git' AS git FROM persistence_effects WHERE kind='git' ORDER BY source_id,data->>'slug'`);
    expect(rows.map(r => [r.slug, r.state, r.error_code, r.reason, r.git])).toEqual([
      ['notes/page-0000', 'committed', null, 'durability_not_enabled', 'skipped'],
      ['notes/page-0001', 'committed', null, 'durability_not_enabled', 'skipped'],
      ['notes/page-0002', 'queued', 'source_changed', null, null],
      ['notes/page-0003', 'committed', null, 'durability_not_enabled', 'skipped'],
      ['notes/page-0004', 'committed', null, null, 'superseded'],
      ['notes/page-0005', 'committed', null, 'durability_not_enabled', 'skipped'],
      ['notes/page-0700', 'failed', 'source_changed', null, null],
      ['notes/page-0701', 'failed', 'source_changed', null, null],
    ]);
  }), 300_000);
  // Wave 9: under a backlog every group is full. A write admitted while the consumer drains a hooked
  // worktree's Git effects publishes within the 5 s write wait instead of waiting out the whole backlog.
  test('a write admitted behind a full-group Git backlog publishes within the write wait', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), BACKLOG));
    const real = Bun.which('git')!;
    const committing = join(home, 'committing');
    const stub = stubGit(home, `case " $* " in *" commit "*) touch '${committing}'; sleep ${COMMIT_SLEEP_S};; esac\nexec '${real}' "$@"`);
    await withEnv({ PATH: `${stub}:${process.env.PATH}` }, async () => {
      await release(engine);
      startPersistenceConsumer(engine, { engine: engine.kind, embedding_disabled: true } as never);
      // The consumer is committing a full group under the worktree lock when the write arrives.
      for (let i = 0; i < 200 && !existsSync(committing); i++) await Bun.sleep(25);
      expect(existsSync(committing)).toBe(true);
      const commitsBefore = repo.commits();
      const started = performance.now();
      const result = await submitPageMutation(ctx('default'), { operation: 'put_page', waitMs: 5000,
        params: { slug: 'notes/behind-backlog', request_id: randomUUID(), content: pageContent(9999) } });
      const elapsed = performance.now() - started;
      expect(result.status).not.toBe('pending');
      expect(elapsed).toBeLessThan(5000);
      // It went ahead of the backlog: at most the group already committing when it arrived landed first.
      expect(repo.commits() - commitsBefore).toBeLessThanOrEqual(2);
      await disposePersistenceConsumer(engine);
    });
    // Every effect still commits, in claim order per worktree.
    await release(engine);
    while ((await gitStates(engine)).queued) { await release(engine); await pass(engine); }
    expect(await gitStates(engine)).toEqual({ committed: BACKLOG + 1 });
  }), 300_000);
  test('a write that finds the worktree busy is requeued as writer_busy with no stale preparing phase', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await putPage(ctx('default'), 0);
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    const held = (await acquireWorktree(binding, 30_000, undefined, engine))!;
    try {
      await submitPageMutation(ctx('default'), { operation: 'put_page', waitMs: 1500,
        params: { slug: 'notes/lock-held', request_id: randomUUID(), content: pageContent(7777) } }).catch(() => undefined);
      // The wait can end while the consumer still holds the write (a loaded runner claims it late): the outcome under test is
      // where the write lands once the consumer lets it go, so read it after it leaves `running`.
      const latest = async () => (await engine.executeRaw<{ state: string; blocked_reason: string | null; claim_phase: unknown }>(
        "SELECT state,blocked_reason,claim_phase FROM persistence_requests ORDER BY created_at DESC LIMIT 1"))[0];
      let row = await latest();
      for (let i = 0; i < 600 && row?.state === 'running'; i++) { await Bun.sleep(50); row = await latest(); }
      expect(row).toEqual({ state: 'queued', blocked_reason: 'writer_busy', claim_phase: null });
    } finally { await held.release(); await disposePersistenceConsumer(engine); }
  }), 300_000);
  // The no-op embedding settle (embedding-noop-settle.ts) under the same backlog: the drain also settles queued embedding
  // effects whose chunks already carry current vectors, yielding between batches; the write still publishes within its
  // wait, the settle never touches a Git row, and every effect still commits once.
  test('a write admitted behind a Git backlog and a no-op embedding backlog publishes within the write wait', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), MIXED_BACKLOG));
    // Every seeded page is already embedded at the current signature, as `embed --stale` leaves an import.
    const [{ type }] = await engine.executeRaw<{ type: string }>("SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    const dims = Number(/vector\((\d+)\)/.exec(type)![1]);
    const model = 'openai:text-embedding-3-small';
    configureGateway({ embedding_model: model, embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test-not-used' } });
    try {
      await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector, embedded_at=now(), embedded_text_hash=md5(chunk_text), model=$2`,
        [`[${new Array(dims).fill(0.1).join(',')}]`, model]);
      await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dims}`]);
      const noops = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects e JOIN pages p ON p.id=(e.data->>'page_id')::int
        WHERE e.kind='embedding' AND e.state='queued' AND p.text_projection_revision=p.knowledge_revision AND p.knowledge_revision=e.revision`);
      expect(Number(noops[0]!.n)).toBeGreaterThanOrEqual(MIXED_BACKLOG);
      await effectSql(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='embedding' AND state='queued'");
      const real = Bun.which('git')!;
      const committing = join(home, 'committing');
      const stub = stubGit(home, `case " $* " in *" commit "*) touch '${committing}'; sleep ${COMMIT_SLEEP_S};; esac\nexec '${real}' "$@"`);
      await withEnv({ PATH: `${stub}:${process.env.PATH}` }, async () => {
        await release(engine);
        startPersistenceConsumer(engine, { engine: engine.kind, embedding_disabled: true } as never);
        for (let i = 0; i < 200 && !existsSync(committing); i++) await Bun.sleep(25);
        expect(existsSync(committing)).toBe(true);
        const started = performance.now();
        const result = await submitPageMutation(ctx('default'), { operation: 'put_page', waitMs: 5000,
          params: { slug: 'notes/behind-both-backlogs', request_id: randomUUID(), content: pageContent(9998) } });
        expect(result.status).not.toBe('pending');
        expect(performance.now() - started).toBeLessThan(5000);
        await disposePersistenceConsumer(engine);
      });
      await release(engine);
      while ((await gitStates(engine)).queued) { await release(engine); await pass(engine); }
      expect(await gitStates(engine)).toEqual({ committed: MIXED_BACKLOG + 1 });
      const embedding = await engine.executeRaw<{ state: string; attempts: number; n: number }>(
        "SELECT state, attempts, count(*)::int AS n FROM persistence_effects WHERE kind='embedding' AND data->>'slug' LIKE 'notes/page-%' GROUP BY 1,2");
      expect(embedding.map(r => ({ state: r.state, attempts: Number(r.attempts), n: Number(r.n) }))).toEqual([{ state: 'committed', attempts: 1, n: MIXED_BACKLOG }]);
    } finally { resetGateway(); }
  }), 300_000);
  // Wave 7: the coalesced claim hoists its worktree-wide conditions into one InitPlan. This is the claim's
  // predicate before that change, row by row; every state below must claim exactly the rows it selects.
  test('the coalesced claim takes exactly the rows of the per-row reference predicate', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 6));
    const [{ worktree_id: worktree }] = await engine.executeRaw<{ worktree_id: string }>("SELECT DISTINCT worktree_id FROM persistence_effects WHERE kind='git'");
    const host = localHostId();
    const reference = async (limit: number) => (await engine.executeRaw<{ id: number }>(`SELECT e.id FROM persistence_effects e
      JOIN persistence_worktrees w ON w.id=e.worktree_id AND w.owner_host_id=$1::uuid
      WHERE e.worktree_id=$2::uuid AND e.kind='git' AND e.data ? 'relative_path'
      AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'version')
      AND (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
      AND NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required'))
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
      ORDER BY e.next_attempt_at,e.id LIMIT $3`, [host, worktree, limit])).map(r => Number(r.id));
    const ids = async () => (await engine.executeRaw<{ id: number }>("SELECT id FROM persistence_effects WHERE kind='git' ORDER BY id")).map(r => Number(r.id));
    const all = await ids();
    expect(all.length).toBe(6);
    const reset = () => effectSql(engine, `UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,recovery=NULL,
      next_attempt_at=now()-interval '1 second',data=data-'targets' WHERE kind='git'`);
    const [{ request_id: mirrored, source_id, source_incarnation }] = await engine.executeRaw<{ request_id: string; source_id: string; source_incarnation: string }>(
      'SELECT request_id,source_id,source_incarnation FROM persistence_effects WHERE id=$1', [all[2]]);
    const states: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['ready', async () => {}, async () => {}],
      ['future, running and targeted rows', () => effectSql(engine, `UPDATE persistence_effects SET
        next_attempt_at=CASE WHEN id=$1 THEN now()+interval '1 hour' ELSE next_attempt_at END,
        state=CASE WHEN id IN ($2,$3) THEN 'running' ELSE state END,
        claim_expires_at=CASE WHEN id=$2 THEN now()+interval '1 hour' WHEN id=$3 THEN now()-interval '1 second' ELSE claim_expires_at END,
        data=CASE WHEN id=$4 THEN data||'{"targets":[]}'::jsonb ELSE data END WHERE kind='git'`, [all[0], all[1], all[2], all[3]]), async () => {}],
      ['a pending withdrawal mirror', () => effectSql(engine, `INSERT INTO persistence_effects (request_id,kind,data,source_id,source_incarnation,worktree_id,next_attempt_at)
        VALUES ($1::uuid,'withdrawal-mirror','{}'::jsonb,$2,$3::uuid,$4::uuid,now()+interval '1 hour')`, [mirrored, source_id, source_incarnation, worktree]),
        () => effectSql(engine, "DELETE FROM persistence_effects WHERE kind='withdrawal-mirror'")],
      ['an effect in recovery', () => effectSql(engine, `UPDATE persistence_effects SET recovery='{"reason":"probe"}'::jsonb WHERE id=$1`, [all[5]]), async () => {}],
      ['another owner', () => engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid() WHERE id=$1::uuid', [worktree]),
        () => engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [worktree, host])],
      ...(['fenced', 'merged', 'recovery_required', 'draining', 'syncing'] as const).map(state => [`a ${state} refresh`,
        () => engine.executeRaw(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
          VALUES ($1::uuid,ARRAY['default'],gen_random_uuid(),1,1,$2,'a','b','origin/main')`, [worktree, state]),
        () => engine.executeRaw('DELETE FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid', [worktree])] as [string, () => Promise<unknown>, () => Promise<unknown>]),
    ];
    for (const [name, apply, undo] of states) for (const limit of [1, 4, 100]) {
      await reset(); await apply();
      const expected = await reference(limit);
      const claimed = (await claimCoalescedGitEffects(engine, host, worktree, limit)).map(e => Number(e.id));
      expect({ name, limit, claimed }).toEqual({ name, limit, claimed: [...expected].sort((a, b) => a - b) });
      await undo();
    }
    await reset();
    expect(await reference(100)).toHaveLength(6);
  }), 300_000);
});
