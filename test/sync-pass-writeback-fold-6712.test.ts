/**
 * #6712 PR 4b (GBRA-108, option A): a writeback import carries the pass's folded stamp. The stamp publishes in the import's
 * own transaction through the post-effects hook (coordinator.ts `afterEffects`, sync-pass-fold.ts), right after the import's
 * Git effect is queued, and records that effect in the pass row (`converged.writeback`): the source is not idle until the
 * effect commits.
 *
 * Protects:
 * - a parked writeback effect keeps every following tick non-idle, and each of those passes converges without re-importing;
 * - a kill between the publication commit and the Git effect (the effect left queued, as a dead process leaves it): the next
 *   tick is not idle; once the effect runs, the commit holds the writeback bytes, the next tick converges and then idles;
 * - durability on: the writeback folds (no checkpoint request), the Git effect commits exactly the bytes the import wrote,
 *   the next tick converges at that commit and the one after is idle;
 * - a writeback whose Git effect fails for good shows in doctor (`parked_effects`) and in `sync status` (blocked,
 *   `writeback_failed`), never as an idle, healthy source;
 * - against a bare tracking remote (the keep-checkout publish, #7010): a foreign commit pushed first keeps every tick
 *   non-idle until the effect resolves; it commits a merge of the writeback and foreign commits on the remote only, the
 *   checkout stays at the writeback commit, the source converges there and idles with no foreign page, and
 *   `sources refresh` imports the foreign file through a full level read. Both sides changing the writeback file holds the
 *   effect with `integrate_conflict` (sync status names the user's choice), then parks it: blocked, never idle. A remote
 *   that refuses every push parks the effect: doctor and `sync status` show it, and no tick is idle.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-writeback-fold-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
/** A one-file commit whose file is not canonical: its import rewrites it (a writeback). */
const writebackCommit = (root: string) => { writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical'); };
const lastSequence = async (engine: BrainEngine) => Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
/** The newest import of notes/a and its Git effect. */
async function writebackEffect(engine: BrainEngine): Promise<{ request_id: string; write_id: string; effect_id: string; state: string; data: Record<string, unknown>; updated: string } | undefined> {
  return (await engine.executeRaw<{ request_id: string; write_id: string; effect_id: string; state: string; data: Record<string, unknown>; updated: string }>(
    `SELECT r.request_id::text AS request_id, r.id::text AS write_id, e.id::text AS effect_id, e.state, e.data, e.updated_at::text AS updated FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id AND e.kind='git'
      WHERE r.slug='notes/a' AND r.intent->>'kind'='managed_sync_import' ORDER BY r.sequence DESC LIMIT 1`))[0];
}
const effectSettled = (engine: BrainEngine) => waitFor(async () => ['committed', 'failed'].includes((await writebackEffect(engine))?.state ?? ''),
  { timeoutMs: 60_000, label: 'the writeback Git effect settles' });
/** An effect-row update as the persistence writer makes it (protocol 2, which the writer guard requires). */
const asWriter = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(async tx => {
  await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
  await tx.executeRaw(sql, params);
});
/** Parks the writeback's Git effect as five consecutive failures leave it (effects.ts `parkEffectTarget`). */
const park = (engine: BrainEngine, effectId: string) => asWriter(engine, `UPDATE persistence_effects SET state='failed', error_code='targets_parked',
  data=data||jsonb_build_object('parked', jsonb_build_array(jsonb_build_object('slug','notes/a','error_code','git_unavailable'))) WHERE id=$1`, [effectId]);
/** One sync tick: its status and the pass kind it recorded (`idle` only when it read nothing). */
async function tick(engine: BrainEngine): Promise<{ status: string; kind: string }> {
  const result = await performManagedSync(engine, OPTS);
  const [row] = await engine.executeRaw<{ kind: string }>("SELECT completed_keys->0->'telemetry'->>'kind' AS kind FROM op_checkpoints WHERE op=$1", [MANAGED_SYNC_PASS_OP]);
  return { status: result.status as string, kind: row!.kind };
}
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ c: string | null }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c;
/** The requests of this pass that carried the stamp, with how each published it. */
const stamped = (engine: BrainEngine, after: number) => engine.executeRaw<{ kind: string; stamp: string | null }>(
  "SELECT intent->>'kind' AS kind, outcome->>'pass_stamp' AS stamp FROM persistence_requests WHERE sequence > $1 AND intent ? 'stamp' ORDER BY sequence", [after]);
const enableDurability = (engine: BrainEngine) => engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
/** The worktree tracks a bare remote (`<home>/remote.git`) its branch was pushed to, so a Git effect pushes. */
const trackedSetup = ({ root }: { root: string }) => {
  setup({ root });
  execFileSync('git', ['init', '-q', '--bare', remoteDir(root)]);
  git(root, 'remote', 'add', 'origin', remoteDir(root));
  git(root, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${git(root, 'symbolic-ref', '--short', 'HEAD')}`);
};
const remoteDir = (root: string) => join(root, '..', 'remote.git');
const remoteTip = (root: string) => git(root, '--git-dir', remoteDir(root), 'rev-parse', `refs/heads/${git(root, 'symbolic-ref', '--short', 'HEAD')}`);
/** A commit another clone pushed to the remote, writing `content` at `path`; returns it. */
const foreignPush = (root: string, path: string, content: string) => {
  const clone = join(root, '..', 'foreign');
  execFileSync('git', ['clone', '-q', remoteDir(root), clone]);
  git(clone, 'config', 'user.name', 'Other'); git(clone, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(clone, path), content);
  commit(clone, `foreign ${path}`); git(clone, 'push', '-q');
  return git(clone, 'rev-parse', 'HEAD');
};
/** Runs the writeback's Git effect once more now (its retry backoff skipped) and waits until that attempt ends. */
async function attemptNow(engine: BrainEngine): Promise<string> {
  const before = (await writebackEffect(engine))!;
  if (before.state === 'committed' || before.state === 'failed') return before.state;
  await asWriter(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1 AND state='queued'", [before.effect_id]);
  startPersistenceConsumer(engine, { engine: engine.kind }).wake(true);
  await waitFor(async () => { const now = (await writebackEffect(engine))!; return now.state !== 'running' && now.updated !== before.updated; },
    { timeoutMs: 60_000, label: 'one Git effect attempt ends' });
  return (await writebackEffect(engine))!.state;
}
/** Ticks until the writeback's Git effect resolves, one attempt per tick: every tick before then is non-idle. */
async function ticksUntilResolved(engine: BrainEngine): Promise<{ state: string; ticks: string[] }> {
  const ticks: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await attemptNow(engine);
    if (state === 'committed' || state === 'failed') return { state, ticks };
    ticks.push((await tick(engine)).kind);
  }
  return { state: (await writebackEffect(engine))!.state, ticks };
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b writeback folds its stamp, its Git effect keeps the source busy (${backend})`, () => {
    test('a parked writeback effect keeps every next tick non-idle; each pass converges without importing again', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      writebackCommit(root);
      expect((await tick(engine)).status).toBe('synced');
      await effectSettled(engine);
      const effect = (await writebackEffect(engine))!;
      await park(engine, effect.effect_id);
      const imports = await lastSequence(engine);
      expect([await tick(engine), await tick(engine)].map(t => t.kind === 'idle')).toEqual([false, false]);
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE sequence > $1 AND intent->>'kind'='managed_sync_import'", [imports]))[0]!.n).toBe(0);
    }), 180_000);

    test('a kill between the publication commit and the Git effect: not idle meanwhile; the effect runs, the source converges, nothing is lost', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      const from = git(root, 'rev-parse', 'HEAD');
      writebackCommit(root);
      const target = git(root, 'rev-parse', 'HEAD');
      // The process dies right after the import's publication commits: its Git effect stays queued, unclaimed.
      installFaultHook(async (point, detail) => {
        if (point !== 'publication:after_commit' || !detail.requestId) return;
        await asWriter(engine, `UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'
          WHERE request_id=(SELECT id FROM persistence_requests WHERE request_id=$1::uuid) AND kind='git' AND state='queued'`, [detail.requestId]);
      });
      expect((await tick(engine)).status).toBe('synced');
      installFaultHook(undefined);
      expect((await writebackEffect(engine))!.state).toBe('queued');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
      expect((await tick(engine)).kind).not.toBe('idle');
      expect((await tick(engine)).kind).not.toBe('idle');
      // The owner comes back: the queued effect runs.
      await asWriter(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
      startPersistenceConsumer(engine, { engine: engine.kind }).wake(true);
      await effectSettled(engine);
      expect((await writebackEffect(engine))!.state).toBe('committed');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(head).not.toBe(target);
      expect(git(root, 'rev-parse', `${head}^`)).toBe(target);
      expect(git(root, 'show', `${head}:notes/a.md`)).toBe(readFileSync(join(root, 'notes/a.md'), 'utf8').trimEnd());
      expect(git(root, 'diff', '--name-only', target, head)).toBe('notes/a.md');
      expect(from).not.toBe(target);
      const converge = await tick(engine);
      expect(converge.kind).not.toBe('idle');
      expect(await lastCommit(engine)).toBe(head);
      expect((await tick(engine)).kind).toBe('idle');
      expect((await engine.getPage('notes/a', { sourceId: 'default' }))?.compiled_truth).toContain('A committed change of notes/a.');
    }), 180_000);

    test('durability on: the writeback folds, its effect commits exactly the bytes written, the next tick converges and the one after idles', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      writebackCommit(root);
      const target = git(root, 'rev-parse', 'HEAD'), after = await lastSequence(engine);
      expect((await tick(engine)).status).toBe('synced');
      expect(await stamped(engine, after)).toEqual([{ kind: 'managed_sync_import', stamp: 'folded' }]);
      await effectSettled(engine);
      const effect = (await writebackEffect(engine))!;
      expect(effect.state).toBe('committed');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(git(root, 'rev-parse', `${head}^`)).toBe(target);
      expect(git(root, 'diff', '--name-only', target, head)).toBe('notes/a.md');
      expect(git(root, 'show', `${head}:notes/a.md`)).toBe(readFileSync(join(root, 'notes/a.md'), 'utf8').trimEnd());
      const converge = await tick(engine);
      expect(await lastCommit(engine)).toBe(head);
      expect(converge.status === 'up_to_date' && converge.kind === 'idle').toBe(false);
      expect(await tick(engine)).toEqual({ status: 'up_to_date', kind: 'idle' });
    }), 180_000);

    test('durability on, the effect commits before the confirm round: HEAD moved by exactly the pass\'s bytes ends the pass on its stamp, no level read', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      writebackCommit(root);
      const target = git(root, 'rev-parse', 'HEAD'), after = await lastSequence(engine);
      const reads: number[] = [];
      installFaultHook(async (point, detail) => {
        if (point === 'sync:level_read') reads.push(detail.round as number);
        if (point !== 'sync:round_start' || (detail.round as number) < 2) return;
        startPersistenceConsumer(engine, { engine: engine.kind }).wake(true);
        await effectSettled(engine);
      });
      expect((await tick(engine)).status).toBe('synced');
      installFaultHook(undefined);
      expect(reads).toEqual([1]);
      expect(await stamped(engine, after)).toEqual([{ kind: 'managed_sync_import', stamp: 'folded' }]);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(git(root, 'rev-parse', `${head}^`)).toBe(target);
      expect(await lastCommit(engine)).toBe(target);
      expect((await tick(engine)).kind).not.toBe('idle');
      expect(await lastCommit(engine)).toBe(head);
      expect(await tick(engine)).toEqual({ status: 'up_to_date', kind: 'idle' });
    }), 180_000);

    test('durability on, a foreign commit lands beside the effect\'s: the confirm round reads in full and imports it', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      writebackCommit(root);
      const reads: number[] = [];
      installFaultHook(async (point, detail) => {
        if (point === 'sync:level_read') reads.push(detail.round as number);
        if (point !== 'sync:round_start' || detail.round !== 2) return;
        startPersistenceConsumer(engine, { engine: engine.kind }).wake(true);
        await effectSettled(engine);
        writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A foreign change of notes/b.'));
        commit(root, 'foreign change of b');
      });
      expect((await tick(engine)).status).toBe('synced');
      installFaultHook(undefined);
      expect(reads.slice(0, 2)).toEqual([1, 2]);
      expect(await lastCommit(engine)).toBe(git(root, 'rev-parse', 'HEAD'));
      expect((await engine.getPage('notes/b', { sourceId: 'default' }))?.compiled_truth).toContain('A foreign change of notes/b.');
    }), 180_000);

    test('a writeback whose Git effect fails for good shows in doctor and in sync status, never as an idle, healthy source', () => brain(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      writebackCommit(root);
      expect((await tick(engine)).status).toBe('synced');
      await effectSettled(engine);
      const effect = (await writebackEffect(engine))!;
      await park(engine, effect.effect_id);
      const doctor = await checkParkedEffects(engine, ['default']);
      expect(doctor.status).toBe('warn');
      expect(JSON.stringify(doctor.details)).toContain(effect.request_id);
      const status = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: status.state, reason: status.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
      expect(JSON.stringify(status.next)).toContain('retry-effects');
      expect((await tick(engine)).kind).not.toBe('idle');
      const again = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: again.state, reason: again.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
    }), 180_000);
  });

  describe(`#6712 PR 4b writeback fold against a tracking remote, durability on (${backend})`, () => {
    // The keep-checkout publish runs this checkout's own CLI as a child (GBRAIN_JOB_CHILD_CLI), over the file transport.
    const tracked = (run: Parameters<typeof managedBrain>[0]) => {
      const bin = mkdtempSync(join(tmpdir(), 'gbrain-wb-cli-')), cli = join(bin, 'gbrain-child');
      writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, '../src/cli.ts')}' "$@"\n`); chmodSync(cli, 0o700);
      return withEnv({ GBRAIN_JOB_CHILD_CLI: cli, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' },
        () => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup: trackedSetup })).finally(() => rmSync(bin, { recursive: true, force: true }));
    };

    test('the remote moved first: non-idle until the effect resolves; it commits a merge on the remote only, the checkout stays, and sources refresh imports the foreign file', () => tracked(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      const foreign = foreignPush(root, 'notes/c.md', note('notes/c', 'A foreign note pushed by another clone.'));
      writebackCommit(root);
      expect((await tick(engine)).status).toBe('synced');
      const resolved = await ticksUntilResolved(engine);
      expect(resolved.ticks.filter(kind => kind === 'idle')).toEqual([]);
      expect(resolved.state).toBe('committed');
      // The keep-checkout publish (#7010) merged the remote in memory and pushed the merge; the checkout did not move.
      const writeback = git(root, 'rev-parse', 'HEAD'), tip = remoteTip(root);
      expect(git(root, 'log', '-1', '--format=%s')).toBe('gbrain: persist canonical memory update');
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(root, 'notes/c.md'))).toBe(false);
      expect(git(root, '--git-dir', remoteDir(root), 'rev-list', '--parents', '-n', '1', tip).split(' ').slice(1).sort()).toEqual([writeback, foreign].sort());
      expect(git(root, '--git-dir', remoteDir(root), 'show', `${tip}:notes/a.md`)).toBe(readFileSync(join(root, 'notes/a.md'), 'utf8').trimEnd());
      expect(git(root, '--git-dir', remoteDir(root), 'show', `${tip}:notes/c.md`)).toBe(note('notes/c', 'A foreign note pushed by another clone.').trimEnd());
      // The pass imports only what the checkout holds: it converges at the writeback commit and idles, with no notes/c page.
      const converge = await tick(engine);
      expect(converge.kind).not.toBe('idle');
      expect(await lastCommit(engine)).toBe(writeback);
      expect(await tick(engine)).toEqual({ status: 'up_to_date', kind: 'idle' });
      expect(await engine.getPage('notes/c', { sourceId: 'default' })).toBeNull();
      // sources refresh fast-forwards the checkout to the merge; its sync imports notes/c through a full level read.
      const reads: number[] = [];
      installFaultHook(point => { if (point === 'sync:level_read') reads.push(1); });
      expect((await refreshWorktree(engine, 'default')).status).toBe('completed');
      installFaultHook(undefined);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(tip);
      expect(reads.length).toBeGreaterThan(0);
      expect((await engine.getPage('notes/c', { sourceId: 'default' }))?.compiled_truth).toContain('A foreign note pushed by another clone.');
      expect(await lastCommit(engine)).toBe(tip);
      expect(await tick(engine)).toEqual({ status: 'up_to_date', kind: 'idle' });
    }), 240_000);

    test('both sides changed the writeback file: the effect holds integrate_conflict, retries, then parks; sync status shows it blocked, never idle and healthy', () => tracked(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      const theirs = foreignPush(root, 'notes/a.md', note('notes/a', 'The other clone\'s version of notes/a.'));
      writebackCommit(root);
      expect((await tick(engine)).status).toBe('synced');
      // The first attempt holds it: nothing is pushed, the checkout keeps this side's bytes, and the hold names the user's choice.
      expect(await attemptNow(engine)).toBe('queued');
      expect(remoteTip(root)).toBe(theirs);
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('A committed change of notes/a.');
      const held = await readSyncStatus(engine, 'default', { detail: false });
      expect(held.git_push_holds).toMatchObject([{ retrying: 1, parked: 0, codes: ['integrate_conflict'], conflict: { paths: ['notes/a.md'], remote: theirs } }]);
      expect(held.next).toEqual(held.git_push_holds[0]!.fix);
      const resolved = await ticksUntilResolved(engine);
      expect(resolved.ticks.filter(kind => kind === 'idle')).toEqual([]);
      expect(resolved.state).toBe('failed');
      const effect = (await writebackEffect(engine))!;
      expect(JSON.stringify(effect.data.parked)).toContain('integrate_conflict');
      expect(remoteTip(root)).toBe(theirs);
      const status = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: status.state, reason: status.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
      expect(status.git_push_holds).toMatchObject([{ retrying: 0, parked: 1, codes: ['integrate_conflict'], conflict: { paths: ['notes/a.md'], remote: theirs } }]);
      expect((await checkParkedEffects(engine, ['default'])).status).toBe('warn');
      expect((await tick(engine)).kind).not.toBe('idle');
      const again = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: again.state, reason: again.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
    }), 240_000);

    test('the remote refuses every push: non-idle while it retries; parked, doctor and sync status show it, never idle and healthy', () => tracked(async ({ engine, root }) => {
      expect((await tick(engine)).status).toBe('first_sync');
      await enableDurability(engine);
      const hook = join(remoteDir(root), 'hooks', 'pre-receive');
      writeFileSync(hook, '#!/bin/sh\necho "refused by policy" >&2\nexit 1\n'); chmodSync(hook, 0o755);
      writebackCommit(root);
      expect((await tick(engine)).status).toBe('synced');
      const resolved = await ticksUntilResolved(engine);
      expect(resolved.ticks.filter(kind => kind === 'idle')).toEqual([]);
      expect(resolved.state).toBe('failed');
      const effect = (await writebackEffect(engine))!;
      expect(JSON.stringify(effect.data.parked)).toContain('git_push_unavailable');
      const doctor = await checkParkedEffects(engine, ['default']);
      expect(doctor.status).toBe('warn');
      expect(JSON.stringify(doctor.details)).toContain(effect.request_id);
      const status = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: status.state, reason: status.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
      expect((await tick(engine)).kind).not.toBe('idle');
      const again = await readSyncStatus(engine, 'default', { detail: false });
      expect({ state: again.state, reason: again.reason }).toEqual({ state: 'blocked', reason: 'writeback_failed' });
    }), 240_000);
  });
}
