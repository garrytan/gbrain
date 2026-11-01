/**
 * #7985: a parked Git effect recorded under a former canonical binding is refused by the exact retry (source_changed,
 * the guard stays) and is never selected by the bulk retry of the current binding. The diagnostics now tell the two apart:
 * the parked groups (doctor \`parked_effects\`, \`sources writer status\`) give such effects their own group naming the
 * recorded worktree, the current one, the requests and the settle preview; doctor's per-effect command is that preview;
 * the exact retry refusal names both bindings and the settle preview; the bulk retry names the effects it leaves out.
 * \`settle-effects --retire\` records that nothing current owes such an effect, only on evidence: its source was replaced,
 * or each target's page is gone, deleted, replaced or past the revision the effect owed. It is preview-first, plan-bound,
 * idempotent and reversible, never requeues, and the exact retry still refuses the effect.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { retryParkedEffects } from '../src/core/persistence/effect-retry.ts';
import { retrySourceParkedCode } from '../src/core/persistence/git-durability-administration.ts';
import { settleEffects } from '../src/core/persistence/effect-settle.ts';
import { readParkedGroups } from '../src/core/persistence/parked-groups.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { isPhysicalRootMetadata } from '../src/core/persistence/physical-root.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const backends: Array<string | undefined> = [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])];
const put = async (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`,
    ...await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }).then(page => page ? { expected_revision: page.revision } : {}) } });
async function sql(engine: BrainEngine, statement: string, params: unknown[]) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(statement, params); });
}
/** Parks the newest Git effect of a page on git_unavailable (the resident consumer stopped); returns its ids and worktree. */
async function park(engine: BrainEngine, slug: string) {
  await disposePersistenceConsumer(engine);
  const [effect] = await engine.executeRaw<{ id: number; request_id: string; worktree_id: string }>(`SELECT e.id,r.request_id::text AS request_id,
    e.worktree_id::text AS worktree_id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.kind='git' AND r.slug=$1 ORDER BY e.id DESC LIMIT 1`, [slug]);
  await sql(engine, `UPDATE persistence_effects SET state='failed',error_code='targets_parked',execution_token=NULL,claim_expires_at=NULL,
    data=data||jsonb_build_object('parked',jsonb_build_array(jsonb_build_object('slug',$2::text,'error_code','git_unavailable'))) WHERE id=$1`, [effect!.id, slug]);
  return effect!;
}

async function moveToNewWorktree(engine: BrainEngine, root: string) {
  const old = (await getWorktreeBinding(engine, 'default'))!;
  const moved = join(dirname(root), 'moved');
  cpSync(root, moved, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) });
  await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: moved });
  return { old, current: (await getWorktreeBinding(engine, 'default'))! };
}
type History = { state: string; error_code: string | null; parked: unknown; worktree_id: string; settled: unknown; request_state: string };
const history = async (engine: BrainEngine, id: number) => (await engine.executeRaw<History>(`SELECT e.state,e.error_code,e.data->'parked' AS parked,
  e.worktree_id::text AS worktree_id,e.data->'settled' AS settled,r.state AS request_state FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.id=$1`, [id]))[0]!;

describe.each(backends.map(url => [url ? 'postgres' : 'pglite', url] as const))('#7985 effects of a former binding (%s)', (_name, url) => {
  test('the diagnostics name a former-binding effect, its recorded binding and the settle preview, apart from the current binding', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Parked under the old binding.');
    const orphan = await park(engine, 'aa/page');
    const old = (await getWorktreeBinding(engine, 'default'))!;
    expect(orphan.worktree_id).toBe(old.worktree_id);

    const moved = join(dirname(root), 'moved');
    cpSync(root, moved, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) });
    await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: moved });
    const current = (await getWorktreeBinding(engine, 'default'))!;
    expect(current.worktree_id).not.toBe(old.worktree_id);
    await put(ctx, 'bb/page', 'Parked under the current binding.');
    const live = await park(engine, 'bb/page');
    expect(live.worktree_id).toBe(current.worktree_id);

    const settleCode = ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--parked-code', 'git_unavailable', '--dry-run'];
    const groups = await readParkedGroups(engine, ['default']);
    expect(groups).toMatchObject([
      { source_id: 'default', code: 'git_unavailable', effects: 1, targets: 1, command: ['gbrain', 'sources', 'writer', 'retry-effects', 'default', '--parked-code', 'git_unavailable', '--dry-run'] },
      { source_id: 'default', code: 'git_unavailable', effects: 1, targets: 1, command: settleCode,
        former_binding: { reason: 'binding_changed', worktree_ids: [old.worktree_id], current_worktree_id: current.worktree_id, requests: [orphan.request_id] } },
    ]);
    expect(groups[0]).not.toHaveProperty('former_binding');
    expect(groups[1]!.next).toContain('the bulk retry selects none of them, so its zero is not a clearance');
    expect(groups[1]!.next).toContain(orphan.request_id);

    const doctor = await checkParkedEffects(engine);
    expect(doctor.details).toMatchObject({ parked_effects: 2, parked_groups: groups });
    const listed = (doctor.details as { effects: Array<{ request_id: string; command?: string; former_binding?: boolean }> }).effects;
    expect(listed.find(effect => effect.request_id === orphan.request_id)).toMatchObject({ former_binding: true,
      command: `gbrain sources writer settle-effects default --request-id ${orphan.request_id} --dry-run` });
    expect(listed.find(effect => effect.request_id === live.request_id)).toMatchObject({
      command: `gbrain sources writer retry-effects default --request-id ${live.request_id} --dry-run` });
    expect(listed.find(effect => effect.request_id === live.request_id)).not.toHaveProperty('former_binding');

    const refusal = await retryParkedEffects(engine, 'default', orphan.request_id, true).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'source_changed', message: 'The effect canonical binding changed.',
      fix: { argv: ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--request-id', orphan.request_id, '--dry-run', '--json'] } });
    expect(refusal.suggestion).toContain(`worktree ${old.worktree_id}`);
    expect(refusal.suggestion).toContain(`now bound to worktree ${current.worktree_id}`);

    const bulk = await retrySourceParkedCode(engine, 'default', 'git_unavailable', true);
    expect(bulk).toMatchObject({ requests: 1, queued: 1, refused: [],
      former_worktree: { effects: 1, command: settleCode, worktree_ids: [old.worktree_id], requests: [orphan.request_id] } });
    expect(String((bulk.former_worktree as { why: string }).why)).toContain('its counts do not include them');

    expect(await settleEffects(engine, { sourceId: 'default', requestId: orphan.request_id })).toMatchObject({ settleable: 0, refused: 1,
      effects: [{ request_id: orphan.request_id, action: 'refused', refusal: { code: 'no_covering_receipt' } }] });

    await sql(engine, 'UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [orphan.id, randomUUID()]);
    const replaced = (await readParkedGroups(engine, ['default']))[1]!;
    expect(replaced).toMatchObject({ command: [...settleCode.slice(0, -1), '--retire', '--dry-run'], former_binding: { reason: 'source_replaced', requests: [orphan.request_id] } });
    expect(replaced.next).toContain('earlier incarnation of the source');
  }, { databaseUrl: url, setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } }), 240_000);

  test('--retire settles a former-binding effect only when its page moved on, was deleted or its source was replaced, and the exact retry still refuses it', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Parked under the old binding.');
    const moved = await park(engine, 'aa/page');
    await put(ctx, 'cc/page', 'Parked under the old binding.');
    const deleted = await park(engine, 'cc/page');
    await put(ctx, 'dd/page', 'Parked under the old binding, still current.');
    const owed = await park(engine, 'dd/page');
    const { old, current } = await moveToNewWorktree(engine, root);
    await put(ctx, 'bb/page', 'Parked under the current binding.');
    const live = await park(engine, 'bb/page');
    const retire = (apply?: string) => settleEffects(engine, { sourceId: 'default', parkedCode: 'git_unavailable', retire: true, ...(apply ? { apply: true, expect: apply } : {}) });
    const outcome = async () => Object.fromEntries(((await retire()).effects as Array<{ request_id: string; action: string; refusal?: { code: string } }>)
      .map(entry => [{ [moved.request_id]: 'aa', [deleted.request_id]: 'cc', [owed.request_id]: 'dd', [live.request_id]: 'bb' }[entry.request_id], entry.refusal?.code ?? entry.action]));
    expect(await outcome()).toEqual({ aa: 'page_not_moved', cc: 'page_not_moved', dd: 'page_not_moved', bb: 'not_former_binding' });

    await put(ctx, 'aa/page', 'Second version, through the current binding.');
    const snapshot = await engine.readPageSnapshot('cc/page', { sourceId: 'default' });
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'cc/page', expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await disposePersistenceConsumer(engine);
    expect(await outcome()).toEqual({ aa: 'would_settle', cc: 'would_settle', dd: 'page_not_moved', bb: 'not_former_binding' });

    const before = await Promise.all([moved, deleted, owed, live].map(effect => history(engine, effect.id)));
    const preview = await retire();
    expect(preview).toMatchObject({ mode: 'retire', dry_run: true, settleable: 2, refused: 2,
      apply_command: ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--parked-code', 'git_unavailable', '--retire', '--apply', '--expect', preview.plan_hash],
      fix: { ask_user: true, actor: 'user' } });
    const proofs = Object.fromEntries((preview.effects as Array<{ request_id: string; proof?: Record<string, unknown> }>).filter(entry => entry.proof).map(entry => [entry.request_id, entry.proof]));
    expect(proofs[moved.request_id]).toMatchObject({ kind: 'former_binding_retired', reason: 'page_moved', former_worktree_id: old.worktree_id, worktree_id: current.worktree_id,
      targets: [{ slug: 'aa/page', page: 'moved', owed_revision: expect.any(String), current_revision: expect.any(String) }] });
    expect(proofs[deleted.request_id]).toMatchObject({ reason: 'page_moved', targets: [{ slug: 'cc/page', page: 'deleted' }] });
    expect(await Promise.all([moved, deleted, owed, live].map(effect => history(engine, effect.id)))).toEqual(before);

    const plain = await settleEffects(engine, { sourceId: 'default', parkedCode: 'git_unavailable' });
    await expect(retire(plain.plan_hash)).rejects.toMatchObject({ code: 'preview_changed' });
    await expect(retire('ph_000000000000000000000000')).rejects.toMatchObject({ code: 'preview_changed' });
    expect((await history(engine, moved.id)).settled).toBeNull();

    expect(await retire(preview.plan_hash)).toMatchObject({ dry_run: false, settleable: 2 });
    for (const [index, effect] of [moved, deleted].entries()) {
      const { settled, ...after } = await history(engine, effect.id);
      const { settled: was, ...kept } = before[index]!;
      expect(was).toBeNull();
      expect(after).toEqual(kept);
      expect(settled).toMatchObject({ reason: 'former_binding_retired', plan_hash: preview.plan_hash, proof: { kind: 'former_binding_retired' } });
    }
    expect(await Promise.all([owed, live].map(effect => history(engine, effect.id)))).toEqual(before.slice(2));
    await expect(retire(preview.plan_hash)).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await outcome()).toEqual({ dd: 'page_not_moved', bb: 'not_former_binding' });
    expect((await readParkedGroups(engine, ['default'])).map(group => [group.effects, group.former_binding?.requests ?? null]))
      .toEqual([[1, null], [1, [owed.request_id]]]);
    await expect(retryParkedEffects(engine, 'default', moved.request_id, true)).rejects.toMatchObject({ code: 'source_changed' });

    const undo = await settleEffects(engine, { sourceId: 'default', requestId: moved.request_id, unsettle: true });
    expect(await settleEffects(engine, { sourceId: 'default', requestId: moved.request_id, unsettle: true, apply: true, expect: undo.plan_hash }))
      .toMatchObject({ effects: [{ action: 'unsettled' }] });
    expect((await history(engine, moved.id)).settled).toBeNull();

    await sql(engine, 'UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [owed.id, randomUUID()]);
    expect(await settleEffects(engine, { sourceId: 'default', requestId: owed.request_id })).toMatchObject({ settleable: 0,
      effects: [{ action: 'refused', refusal: { code: 'source_replaced', message: expect.stringContaining('--retire') } }] });
    expect(await settleEffects(engine, { sourceId: 'default', requestId: owed.request_id, retire: true })).toMatchObject({ settleable: 1,
      effects: [{ action: 'would_settle', proof: { kind: 'former_binding_retired', reason: 'source_replaced', targets: [{ slug: 'dd/page', page: 'source_replaced' }] } }] });
    await expect(settleEffects(engine, { sourceId: 'default', requestId: owed.request_id, retire: true, unsettle: true })).rejects.toMatchObject({ code: 'invalid_params' });
  }, { databaseUrl: url, setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } }), 300_000);
});

test('settle-effects --retire parses to the writer_settle_effects retire flag', () => {
  expect(parsePersistenceAdminArgs('writer', ['settle-effects', 'source-a', '--parked-code', 'git_unavailable', '--retire', '--dry-run', '--json'])).toEqual({
    operation: 'writer_settle_effects', json: true, brain: undefined, params: { source_id: 'source-a', parked_code: 'git_unavailable', retire: true, dry_run: true } });
});
