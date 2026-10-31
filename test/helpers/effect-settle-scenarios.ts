/**
 * #7423 / #7378: a parked or failed Git effect whose retry can never succeed is settled by an explicit, preview-first,
 * plan-hash-bound operator step (`gbrain sources writer settle-effects`), only on an exact-target proof: its target now
 * resolves db_only under the current gbrain.yml, or it belongs to a former canonical worktree and the already-fetched
 * remote branch holds the current canonical bytes a later committed and pushed Git effect wrote. The original failure,
 * request and target stay as they were; every reader skips the settled row, and `--unsettle` (plan-bound too) restores it.
 * A failed push of the current binding (#7378, no `data.parked`) is retried by `--parked-pushes`, never settled.
 * PGLite runs these from test/persistence-effect-settle.test.ts; test/e2e/w5-persistence-postgres.test.ts runs them on Postgres.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { retryParkedEffects } from '../../src/core/persistence/effect-retry.ts';
import { retrySourceParkedCode, retrySourceParkedPushes } from '../../src/core/persistence/git-durability-administration.ts';
import { settleEffects } from '../../src/core/persistence/effect-settle.ts';
import { hasRearmableTargets, rearmWithheldTargets } from '../../src/core/persistence/effect-journal.ts';
import { WITHHELD_BY_MIRROR } from '../../src/core/persistence/effect-model.ts';
import { readParkedGroups } from '../../src/core/persistence/parked-groups.ts';
import { readGitPushHolds } from '../../src/core/persistence/git-push-holds.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { isPhysicalRootMetadata } from '../../src/core/persistence/physical-root.ts';
import { checkParkedEffects } from '../../src/commands/doctor/checks/parked-effects.ts';
import { managedBrain } from './managed-brain.ts';
import { durableGitRepo, git } from './git-publication.ts';
import { withEnv } from './with-env.ts';

const put = async (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`,
    ...await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }).then(page => page ? { expected_revision: page.revision } : {}) } });
type Effect = { id: number; request_id: string; internal_id: string; kind: string; state: string; error_code: string | null; worktree_id: string;
  source_incarnation: string; recovery: unknown; data: Record<string, unknown>; outcome: Record<string, unknown> | null };
const effects = async (engine: BrainEngine, slug: string) => engine.executeRaw<Effect>(`SELECT e.id,r.request_id::text AS request_id,r.id::text AS internal_id,
  e.kind,e.state,e.error_code,e.worktree_id::text AS worktree_id,e.source_incarnation::text AS source_incarnation,e.recovery,e.data,e.outcome
  FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind IN ('git','withdrawal-mirror') AND r.slug=$1 ORDER BY e.id`, [slug]);
const effectById = async (engine: BrainEngine, id: number) => (await engine.executeRaw<Effect>(`SELECT e.id,e.kind,e.state,e.error_code,e.worktree_id::text AS worktree_id,
  e.source_incarnation::text AS source_incarnation,e.recovery,e.data,e.outcome FROM persistence_effects e WHERE e.id=$1`, [id]))[0]!;
async function sql(engine: BrainEngine, statement: string, params: unknown[]) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(statement, params); });
}
/** Puts one effect back to a fresh queued state with the given data (the resident consumer stopped). */
async function resetEffect(engine: BrainEngine, id: number, data: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await sql(engine, `UPDATE persistence_effects SET data=$2::text::jsonb,state='queued',attempts=0,execution_token=NULL,
    claim_expires_at=NULL,error_code=NULL,outcome=NULL WHERE id=$1`, [id, JSON.stringify(data)]);
}
/** Runs one effect attempt at a time with every other effect deferred. */
async function runOnly(engine: BrainEngine, ctx: OperationContext, id: number, times = 1) {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < times; i++) {
    await sql(engine, "UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=$1 THEN now() ELSE now()+interval '1 hour' END", [id]);
    await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1 });
  }
}
const target = (effect: Effect) => ({ slug: effect.data.slug, page_id: effect.data.page_id, relative_path: effect.data.relative_path, expected_hash: effect.data.expected_hash });
/** The rows a settlement must never change: the failure, its targets and the request. */
const history = async (engine: BrainEngine, id: number) => {
  const effect = await effectById(engine, id);
  const [request] = await engine.executeRaw<Record<string, unknown>>(`SELECT r.state,r.intent,r.authority,r.slug FROM persistence_requests r
    JOIN persistence_effects e ON e.request_id=r.id WHERE e.id=$1`, [id]);
  return { state: effect.state, error_code: effect.error_code, parked: effect.data.parked ?? null, relative_path: effect.data.relative_path,
    expected_hash: effect.data.expected_hash, worktree_id: effect.worktree_id, request };
};

const dbOnly = (root: string, prefix: string) => writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${prefix}\n`);
const gitRepo = (root: string) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

/** #7423: a target parked on git_target_unsafe whose prefix is declared db_only afterwards re-parks on every retry; settle is its exit. */
export async function dbOnlyTargetSettles(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Becomes database-only.');
    const file = join(root, 'aa/page.md');
    const bytes = readFileSync(file);
    rmSync(file); mkdirSync(file);
    const [effect] = await effects(engine, 'aa/page');
    await resetEffect(engine, effect!.id, target(effect!));
    await runOnly(engine, ctx, effect!.id, 5);
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'aa/page', error_code: 'git_target_unsafe' }] } });
    dbOnly(root, 'aa/');
    expect(await retrySourceParkedCode(engine, 'default', 'git_target_unsafe', false)).toMatchObject({ requests: 1, queued: 1 });
    await runOnly(engine, ctx, effect!.id, 5);
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'aa/page', error_code: 'git_target_unsafe' }] } });
    const before = await history(engine, effect!.id);
    expect((await checkParkedEffects(engine)).message).toContain('gbrain sources writer settle-effects default --parked-code git_target_unsafe --dry-run');

    const preview = await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe' });
    expect(preview).toMatchObject({ action: 'writer_settle_effects', mode: 'settle', dry_run: true, settleable: 1, refused: 0,
      effects: [{ request_id: effect!.request_id, action: 'would_settle', proof: { kind: 'db_only', targets: [{ slug: 'aa/page', declared: 'aa/' }] } }] });
    expect(preview.plan_hash).toMatch(/^ph_/);
    expect(preview.apply_command).toEqual(['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--parked-code', 'git_target_unsafe', '--apply', '--expect', preview.plan_hash]);
    expect(await history(engine, effect!.id)).toEqual(before);

    await expect(settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe', apply: true, expect: 'ph_000000000000000000000000' }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    await expect(settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe', apply: true }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect((await effectById(engine, effect!.id)).data.settled).toBeUndefined();

    const applied = await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe', apply: true, expect: preview.plan_hash });
    expect(applied).toMatchObject({ dry_run: false, plan_hash: preview.plan_hash, settleable: 1, effects: [{ action: 'settled' }] });
    expect(await history(engine, effect!.id)).toEqual(before);
    expect((await effectById(engine, effect!.id)).data).toMatchObject({ settled: { reason: 'db_only', plan_hash: preview.plan_hash, host_id: localHostId(),
      proof: { kind: 'db_only' } }, settlements: [{ action: 'settled', plan_hash: preview.plan_hash }] });
    expect(await checkParkedEffects(engine)).toMatchObject({ status: 'ok', details: { parked_effects: 0, parked_groups: [] } });
    expect(await readParkedGroups(engine)).toEqual([]);
    expect(await retrySourceParkedCode(engine, 'default', 'git_target_unsafe', true)).toMatchObject({ requests: 0, queued: 0 });
    expect(await retryParkedEffects(engine, 'default', effect!.request_id, true)).toMatchObject({ effects: [{ kind: 'git', action: 'settled' }] });
    expect(await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe' })).toMatchObject({ settleable: 0, effects: [] });

    const undo = await settleEffects(engine, { sourceId: 'default', requestId: effect!.request_id, unsettle: true });
    expect(undo).toMatchObject({ mode: 'unsettle', dry_run: true, settleable: 1, effects: [{ action: 'would_unsettle', settled: { reason: 'db_only' } }] });
    await expect(settleEffects(engine, { sourceId: 'default', requestId: effect!.request_id, unsettle: true, apply: true, expect: preview.plan_hash }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await settleEffects(engine, { sourceId: 'default', requestId: effect!.request_id, unsettle: true, apply: true, expect: undo.plan_hash }))
      .toMatchObject({ effects: [{ action: 'unsettled' }] });
    expect(await history(engine, effect!.id)).toEqual(before);
    const restored = await effectById(engine, effect!.id);
    expect(restored.data.settled).toBeUndefined();
    expect(restored.data.settlements).toMatchObject([{ action: 'settled', plan_hash: preview.plan_hash }, { action: 'unsettled', plan_hash: undo.plan_hash, settled: { reason: 'db_only' } }]);
    expect(await checkParkedEffects(engine)).toMatchObject({ status: 'warn', details: { parked_effects: 1 } });

    rmSync(join(root, 'gbrain.yml'));
    expect(await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe' })).toMatchObject({ settleable: 0, refused: 1,
      effects: [{ action: 'refused', refusal: { code: 'retry_instead' } }] });
    rmSync(file, { recursive: true }); writeFileSync(file, bytes);
  }, { databaseUrl, setup: ({ root }) => gitRepo(root) });
}

/** A managed checkout with a tracking remote (a bare repository next to it) and the durability hook. */
function remoteRepo(root: string): void {
  const remote = join(dirname(root), 'remote.git');
  git(dirname(root), 'init', '-q', '--bare', '-b', 'main', remote);
  writeFileSync(join(root, '.gitignore'), '\n');
  git(root, 'init', '-q', '-b', 'main');
  durableGitRepo(root, ['.gitignore']);
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
}
const brokenRemote = (root: string) => git(root, 'remote', 'set-url', 'origin', join(dirname(root), 'missing.git'));

/**
 * #7378: Git effects bound to a former canonical worktree (one parked on a push, one failed on a push without parked
 * targets) are refused by the binding guard. After the source moves to a new worktree through a rebind and genuine
 * updates commit and push the current bytes, settle proves each exact path against the fetched remote branch.
 */
export async function formerWorktreeEffectsSettle(databaseUrl?: string) {
  await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, () => managedBrain(async ({ engine, ctx, root }) => {
    const remote = join(dirname(root), 'remote.git');
    brokenRemote(root);
    await put(ctx, 'aa/page', 'First version.');
    await put(ctx, 'bb/page', 'First version.');
    const [parked] = await effects(engine, 'aa/page');
    await resetEffect(engine, parked!.id, target(parked!));
    await runOnly(engine, ctx, parked!.id, 5);
    expect(await effectById(engine, parked!.id)).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'aa/page', error_code: 'git_push_unavailable' }] } });
    const [failed] = await effects(engine, 'bb/page');
    await sql(engine, `UPDATE persistence_effects SET state='failed',error_code='git_push_unavailable',execution_token=NULL,claim_expires_at=NULL,
      data=$2::text::jsonb WHERE id=$1`, [failed!.id, JSON.stringify(target(failed!))]);
    const old = (await getWorktreeBinding(engine, 'default'))!;

    const moved = join(dirname(root), 'moved');
    cpSync(root, moved, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) });
    await disposePersistenceConsumer(engine);
    await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: moved });
    const current = (await getWorktreeBinding(engine, 'default'))!;
    expect(current.worktree_id).not.toBe(old.worktree_id);
    expect(current.source_incarnation).toBe(old.source_incarnation);
    for (const effect of [parked!, failed!]) {
      await expect(retryParkedEffects(engine, 'default', effect.request_id, true)).rejects.toMatchObject({ code: 'source_changed' });
    }
    const settleArgv = ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--parked-code', 'git_push_unavailable', '--dry-run'];
    expect(await readGitPushHolds(engine, ['default'])).toMatchObject([{ source_id: 'default', parked: 2, former_worktree: true, fix: { argv: settleArgv } }]);
    const pushes = await retrySourceParkedPushes(engine, 'default', true);
    expect(pushes).toMatchObject({ requests: 0, queued: 0, former_worktree: { effects: 2, command: settleArgv } });
    expect(String((pushes.former_worktree as { why: string }).why)).toContain('former canonical worktree');

    const refusals = async () => Object.fromEntries(((await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_push_unavailable' })).effects as Array<{
      request_id: string; refusal?: { code: string } }>).map(entry => [entry.request_id === parked!.request_id ? 'aa' : 'bb', entry.refusal?.code ?? 'settleable']));
    expect(await refusals()).toEqual({ aa: 'no_covering_receipt', bb: 'no_covering_receipt' });

    brokenRemote(moved);
    await put(ctx, 'aa/page', 'Second version.');
    const [, update] = await effects(engine, 'aa/page');
    expect(update!.worktree_id).toBe(current.worktree_id);
    await runOnly(engine, ctx, update!.id);
    expect((await effectById(engine, update!.id)).state).toBe('queued');
    expect(await refusals()).toEqual({ aa: 'bytes_unpushed', bb: 'no_covering_receipt' });

    git(moved, 'remote', 'set-url', 'origin', remote);
    await runOnly(engine, ctx, update!.id);
    expect(await effectById(engine, update!.id)).toMatchObject({ state: 'committed', outcome: { push: 'committed' } });
    await put(ctx, 'bb/page', 'Second version.');
    const [, other] = await effects(engine, 'bb/page');
    await runOnly(engine, ctx, other!.id);
    expect(await effectById(engine, other!.id)).toMatchObject({ state: 'committed', outcome: { push: 'committed' } });
    expect(await refusals()).toEqual({ aa: 'settleable', bb: 'settleable' });

    const tip = git(moved, 'rev-parse', 'refs/remotes/origin/main').trim();
    git(moved, 'update-ref', 'refs/remotes/origin/main', `${tip}~1`);
    expect((await refusals()).bb).toBe('remote_ref_stale');
    git(moved, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect((await refusals()).bb).toBe('remote_ref_missing');
    git(moved, 'update-ref', 'refs/remotes/origin/main', tip);
    const file = join(moved, 'bb/page.md');
    const bytes = readFileSync(file);
    writeFileSync(file, `${bytes}Uncoordinated edit.\n`);
    expect((await refusals()).bb).toBe('content_changed');
    rmSync(file);
    expect((await refusals()).bb).toBe('content_missing');
    writeFileSync(file, bytes);
    await sql(engine, 'UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [failed!.id, randomUUID()]);
    expect((await refusals()).bb).toBe('source_replaced');
    await sql(engine, 'UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [failed!.id, failed!.source_incarnation]);
    await sql(engine, `UPDATE persistence_effects SET recovery='{"version":1}'::jsonb WHERE id=$1`, [failed!.id]);
    expect((await refusals()).bb).toBe('recovery_open');
    await sql(engine, 'UPDATE persistence_effects SET recovery=NULL WHERE id=$1', [failed!.id]);
    await sql(engine, 'UPDATE persistence_local_writers SET revoked_at=now() WHERE id=(SELECT principal_id::uuid FROM persistence_requests WHERE id=$1::uuid)', [failed!.internal_id]);
    expect(await refusals()).toEqual({ aa: 'authority_changed', bb: 'authority_changed' });
    await sql(engine, 'UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=(SELECT principal_id::uuid FROM persistence_requests WHERE id=$1::uuid)', [failed!.internal_id]);
    await sql(engine, 'UPDATE persistence_effects SET execution_token=$2::uuid WHERE id=$1', [failed!.id, randomUUID()]);
    expect((await refusals()).bb).toBe('claimed');
    await sql(engine, 'UPDATE persistence_effects SET execution_token=NULL WHERE id=$1', [failed!.id]);
    await sql(engine, 'UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [current.worktree_id, randomUUID()]);
    expect(await refusals()).toEqual({ aa: 'owner_unavailable', bb: 'owner_unavailable' });
    await sql(engine, 'UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [current.worktree_id, localHostId()]);
    expect(await refusals()).toEqual({ aa: 'settleable', bb: 'settleable' });

    const before = await Promise.all([parked!, failed!].map(effect => history(engine, effect.id)));
    const preview = await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_push_unavailable' });
    expect(preview).toMatchObject({ settleable: 2, refused: 0 });
    const proof = (preview.effects as Array<{ request_id: string; proof: Record<string, unknown> }>).find(entry => entry.request_id === failed!.request_id)!.proof;
    expect(proof).toMatchObject({ kind: 'superseded_remote', former_worktree_id: old.worktree_id, worktree_id: current.worktree_id,
      targets: [{ slug: 'bb/page', path: 'bb/page.md', remote_ref: 'refs/remotes/origin/main', remote_commit: tip,
        blob: git(moved, 'rev-parse', `${tip}:bb/page.md`).trim(), receipt_request_id: other!.request_id }] });
    git(moved, 'update-ref', 'refs/remotes/origin/main', `${tip}~1`);
    await expect(settleEffects(engine, { sourceId: 'default', parkedCode: 'git_push_unavailable', apply: true, expect: preview.plan_hash }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    git(moved, 'update-ref', 'refs/remotes/origin/main', tip);
    expect(await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_push_unavailable', apply: true, expect: preview.plan_hash }))
      .toMatchObject({ settleable: 2, effects: [{ action: 'settled' }, { action: 'settled' }] });
    expect(await Promise.all([parked!, failed!].map(effect => history(engine, effect.id)))).toEqual(before);
    expect(await checkParkedEffects(engine)).toMatchObject({ status: 'ok', details: { parked_effects: 0, git_push_holds: [] } });
    expect(await retrySourceParkedPushes(engine, 'default', true)).not.toHaveProperty('former_worktree');
    for (const effect of [parked!, failed!]) await expect(retryParkedEffects(engine, 'default', effect.request_id, true)).rejects.toMatchObject({ code: 'source_changed' });
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) }));
}

/** #7378: a withdrawal effect is never settled, whatever its target. */
export async function withdrawalEffectRefuses(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Becomes database-only.');
    const [effect] = await effects(engine, 'aa/page');
    await disposePersistenceConsumer(engine);
    await sql(engine, `UPDATE persistence_effects SET kind='withdrawal-mirror',state='failed',error_code='targets_parked',
      data=data||'{"parked":[{"slug":"aa/page","error_code":"git_target_unsafe"}]}'::jsonb WHERE id=$1`, [effect!.id]);
    dbOnly(root, 'aa/');
    expect(await settleEffects(engine, { sourceId: 'default', requestId: effect!.request_id })).toMatchObject({ settleable: 0, refused: 1,
      effects: [{ kind: 'withdrawal-mirror', action: 'refused', refusal: { code: 'withdrawal_effect' } }] });
    expect(await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe' })).toMatchObject({ settleable: 0, refused: 1 });
  }, { databaseUrl, setup: ({ root }) => gitRepo(root) });
}

/** #7378: a push of the current binding that failed without parked targets is reachable by --parked-pushes, and commits. */
export async function failedCurrentPushRetries(databaseUrl?: string) {
  await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, () => managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'aa/page', 'Pushed later.');
    const [effect] = await effects(engine, 'aa/page');
    await disposePersistenceConsumer(engine);
    await sql(engine, `UPDATE persistence_effects SET state='failed',error_code='git_push_unavailable',execution_token=NULL,claim_expires_at=NULL,
      data=$2::text::jsonb,outcome=NULL WHERE id=$1`, [effect!.id, JSON.stringify(target(effect!))]);
    expect(await readGitPushHolds(engine, ['default'])).toMatchObject([{ parked: 1, former_worktree: false,
      fix: { argv: ['gbrain', 'sources', 'writer', 'retry-effects', 'default', '--parked-pushes'] } }]);
    expect(await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_push_unavailable' })).toMatchObject({ settleable: 0,
      effects: [{ action: 'refused', refusal: { code: 'retry_instead' } }] });
    expect(await retrySourceParkedPushes(engine, 'default', true)).toMatchObject({ requests: 1, queued: 1, refused: [] });
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'failed', error_code: 'git_push_unavailable' });
    expect(await retrySourceParkedPushes(engine, 'default', false)).toMatchObject({ requests: 1, queued: 1, refused: [] });
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'queued', data: { retried: 1 } });
    await runOnly(engine, ctx, effect!.id);
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'committed', outcome: { push: 'committed' } });
    expect(await checkParkedEffects(engine)).toMatchObject({ status: 'ok', details: { git_push_holds: [] } });
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) }));
}

/** A settled effect stays settled when its request's withdrawal mirror commits: re-arming it would hide a live failure behind data.settled. */
export async function settledEffectIsNotRearmed(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Becomes database-only.');
    const file = join(root, 'aa/page.md');
    rmSync(file); mkdirSync(file);
    const [effect] = await effects(engine, 'aa/page');
    await resetEffect(engine, effect!.id, target(effect!));
    await runOnly(engine, ctx, effect!.id, 5);
    dbOnly(root, 'aa/');
    const preview = await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe' });
    await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_target_unsafe', apply: true, expect: preview.plan_hash });
    await disposePersistenceConsumer(engine);
    const columns = (await engine.executeRaw<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_name='persistence_effects' AND column_name NOT IN ('id','kind','state') AND is_generated='NEVER' AND column_default IS NULL`, []))
      .map(c => c.column_name).join(',');
    await sql(engine, `UPDATE persistence_effects SET data=jsonb_set(data,'{parked,0,error_code}','"${WITHHELD_BY_MIRROR}"') WHERE id=$1`, [effect!.id]);
    await sql(engine, `INSERT INTO persistence_effects (kind,state,${columns}) SELECT 'withdrawal-mirror','committed',${columns} FROM persistence_effects WHERE id=$1`, [effect!.id]);
    expect(await hasRearmableTargets(engine, [effect!.internal_id])).toBe(false);
    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); expect(await rearmWithheldTargets(tx, [effect!.internal_id])).toBe(0); });
    expect(await effectById(engine, effect!.id)).toMatchObject({ state: 'failed', data: { settled: { reason: 'db_only' } } });
  }, { databaseUrl, setup: ({ root }) => gitRepo(root) });
}

