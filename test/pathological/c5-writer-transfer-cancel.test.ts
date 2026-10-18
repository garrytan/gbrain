/**
 * GBRA-130 C-5: a writer transfer that was prepared and never accepted.
 *
 * Protects: `gbrain sources writer transfer prepare` drains the worktree;
 * until now the only exit was `accept` on a successor, so a lost successor (or
 * a change of mind) left maintenance, fence repair, managed repair roots and
 * lifecycle changes refusing `owner_unavailable/transfer_in_progress` with
 * "wait 30 s" forever. `gbrain sources writer transfer cancel <source>
 * --expected-epoch <n>` (admin-intent bound, owner host, native lock, FOR
 * UPDATE) returns the worktree to active and clears the prepared manifest; a
 * racing accept with the old epoch then refuses `writer_transfer_conflict`;
 * past TRANSFER_STALE_MINUTES the refusal's fix turns from wait into ask_user
 * naming accept and cancel with exact argv.
 * Fails when: cancel is missing or changes anything but the worktree state and
 * manifest, a stale drain still reads `wait`, or an accept lands after cancel.
 * Why new: no test covered an abandoned transfer; test/owner-refusal.test.ts
 * pins only the fresh-drain `wait`.
 * Seams: none (the run case wraps the engine's transaction to inject a
 * run-scoped error at the cancel's state write).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { cliRenderContext, toAgentError } from '../../src/core/agent-output.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { maintenancePreflight } from '../../src/core/persistence/prepared-maintenance.ts';
import { TRANSFER_STALE_MINUTES } from '../../src/core/persistence/owner-refusal.ts';
import { parsePersistenceAdminArgs } from '../../src/commands/persistence-admin.ts';
import { failTransactionAt } from '../helpers/fail-transaction.ts';
import { reviewedWriterIntent } from '../helpers/writer-admin-intent.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const SLUGS = ['notes/alice-example', 'notes/acme-example'];

async function seed({ engine }: { engine: BrainEngine }) {
  for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId: SOURCE });
}

async function topology(engine: BrainEngine, sql: string, params: unknown[]) {
  await engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); await tx.executeRaw(sql, params); });
}

async function prepare(engine: BrainEngine): Promise<{ owner_epoch: string; manifest: { digest: string } }> {
  return await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: SOURCE, ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as never;
}

async function worktree(engine: BrainEngine) {
  const binding = (await getWorktreeBinding(engine, SOURCE))!;
  const [row] = await engine.executeRaw<{ state: string; owner_epoch: string; owner_host_id: string; manifest: unknown }>(
    'SELECT state,owner_epoch::text AS owner_epoch,owner_host_id::text AS owner_host_id,manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]);
  return { binding, row: row! };
}

async function refusal(engine: BrainEngine): Promise<OperationError> {
  try { await maintenancePreflight(engine, SOURCE); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('maintenancePreflight did not refuse');
}

const cancelArgv = (epoch: string) => ['gbrain', 'sources', 'writer', 'transfer', 'cancel', SOURCE, '--expected-epoch', epoch, '--admin-intent', 'writer_transfer_cancel', '--expected-state', '<admin_state>'];
const render = (error: OperationError) => toAgentError(error, { transport: 'cli', command: 'chronicle', render: cliRenderContext() });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-5 writer transfer cancel (${backend})`, () => {
    test('C-5 wedge: a drain older than the threshold asks the user to accept or cancel instead of waiting forever', () => managedBrain(async ({ engine }) => {
      const prepared = await prepare(engine);
      expect(render(await refusal(engine))).toMatchObject({ code: 'owner_unavailable', reason: 'transfer_in_progress', fix: { next: 'wait' } });
      const { binding } = await worktree(engine);
      await topology(engine, `UPDATE persistence_worktrees SET manifest=manifest||jsonb_build_object('prepared_at',to_jsonb(now()-make_interval(mins=>$2::int)))
        WHERE id=$1::uuid`, [binding.worktree_id, TRANSFER_STALE_MINUTES + 1]);
      const stale = render(await refusal(engine));
      expect({ reason: stale.reason, next: stale.fix?.next, argv: stale.fix?.argv }).toEqual({ reason: 'transfer_in_progress', next: 'ask_user', argv: cancelArgv(prepared.owner_epoch) });
      expect(stale.fix?.preview_argv).toEqual(['gbrain', 'sources', 'writer', 'transfer', 'cancel', SOURCE, '--expected-epoch', prepared.owner_epoch, '--dry-run', '--json']);
      expect(stale.fix?.user_message).toContain(`gbrain sources writer transfer accept ${SOURCE}`);
      expect(stale.fix?.user_message).toContain(`gbrain sources writer transfer cancel ${SOURCE} --expected-epoch ${prepared.owner_epoch}`);
      // A drain an older release prepared records no time: its age is unknown, so it keeps the wait, whose why names the cancel.
      await topology(engine, "UPDATE persistence_worktrees SET manifest=manifest-'prepared_at' WHERE id=$1::uuid", [binding.worktree_id]);
      const unknown = render(await refusal(engine));
      expect({ next: unknown.fix?.next, names_cancel: unknown.fix?.why.includes(`gbrain sources writer transfer cancel ${SOURCE} --expected-epoch ${prepared.owner_epoch}`) })
        .toEqual({ next: 'wait', names_cancel: true });
    }, { setup: seed, databaseUrl }), 120_000);

    test('C-5 item: cancel returns a stuck drain to active, maintenance runs again, and nothing else changes', () => managedBrain(async ({ engine }) => {
      const prepared = await prepare(engine);
      const failure = await refusal(engine);
      expectItemFailure({ key: SOURCE, code: failure.reason, fix: failure.fix }, { key: SOURCE, code: 'transfer_in_progress', fix: /gbrain sources writer status --source default/ });
      const before = await snapshotItems(engine, SOURCE);
      const drained = await worktree(engine);
      const preview = await runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: prepared.owner_epoch, dry_run: true });
      expect(preview).toMatchObject({ dry_run: true, action: 'writer_transfer_cancel', source_id: SOURCE, cancellable: true, state: 'draining', owner_epoch: prepared.owner_epoch });
      expect((await worktree(engine)).row).toEqual(drained.row);
      const result = await expectUnitNotAborted(async () => runPersistenceAdministration(engine, 'writer_transfer_cancel',
        { source_id: SOURCE, expected_epoch: prepared.owner_epoch, ...await reviewedWriterIntent(engine, 'writer_transfer_cancel') }));
      expect(result).toMatchObject({ cancelled: true, source_id: SOURCE, owner_epoch: prepared.owner_epoch });
      const after = await worktree(engine);
      expect(after.row).toEqual({ state: 'active', owner_epoch: drained.row.owner_epoch, owner_host_id: drained.row.owner_host_id, manifest: null });
      expect({ ...after.binding, state: drained.binding.state, prepared_at: drained.binding.prepared_at }).toEqual({ ...drained.binding, prepared_at: drained.binding.prepared_at });
      expect(await maintenancePreflight(engine, SOURCE)).toMatchObject({ binding: { worktree_id: drained.binding.worktree_id } });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      // Recovery: the owner can prepare the transfer again at the same epoch.
      const again = await prepare(engine);
      expect(again.owner_epoch).toBe(prepared.owner_epoch);
      expect((await worktree(engine)).row.state).toBe('draining');
    }, { setup: seed, databaseUrl }), 120_000);

    test('C-5 race: an accept with the cancelled epoch refuses writer_transfer_conflict and changes nothing', () => managedBrain(async ({ engine, root }) => {
      const prepared = await prepare(engine);
      await runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: prepared.owner_epoch, ...await reviewedWriterIntent(engine, 'writer_transfer_cancel') });
      const settled = await worktree(engine);
      await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', { source_id: SOURCE, path: root, expected_epoch: prepared.owner_epoch,
        manifest: prepared.manifest.digest, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') })).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
      expect(await worktree(engine)).toEqual(settled);
    }, { setup: seed, databaseUrl }), 120_000);

    test('C-5 refusals: cancel needs a drain at the stated epoch on the owner host and changes nothing otherwise', () => managedBrain(async ({ engine }) => {
      const intent = async () => reviewedWriterIntent(engine, 'writer_transfer_cancel');
      await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: '1', ...await intent() }))
        .rejects.toMatchObject({ code: 'writer_transfer_conflict', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', SOURCE, '--json'] } });
      const prepared = await prepare(engine);
      const drained = await worktree(engine);
      await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: String(Number(prepared.owner_epoch) + 1), ...await intent() }))
        .rejects.toMatchObject({ code: 'writer_transfer_conflict' });
      await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: prepared.owner_epoch }))
        .rejects.toMatchObject({ code: 'writer_admin_intent_required' });
      await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: 'one', ...await intent() }))
        .rejects.toMatchObject({ code: 'invalid_params' });
      await topology(engine, 'UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid() WHERE id=$1::uuid', [drained.binding.worktree_id]);
      await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: prepared.owner_epoch, ...await intent() }))
        .rejects.toMatchObject({ code: 'permission_denied' });
      await topology(engine, 'UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [drained.binding.worktree_id, drained.row.owner_host_id]);
      expect(await worktree(engine)).toEqual(drained);
    }, { setup: seed, databaseUrl }), 120_000);

    for (const { name, error } of runScopedErrors().filter(entry => entry.name !== 'owner_unavailable')) {
      test(`C-5 run: a run-scoped error (${name}) at the cancel's state write stops it and the drain stays as it was`, () => managedBrain(async ({ engine }) => {
        const prepared = await prepare(engine);
        const drained = await worktree(engine);
        const injected = error();
        const restore = failTransactionAt(engine, /SET state='active'/, () => injected);
        try {
          await expect(runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: SOURCE, expected_epoch: prepared.owner_epoch,
            ...await reviewedWriterIntent(engine, 'writer_transfer_cancel') })).rejects.toBe(injected);
        } finally { restore(); }
        expect(await worktree(engine)).toEqual(drained);
      }, { setup: seed, databaseUrl }), 120_000);
    }

    test('C-5 CLI: transfer cancel parses to writer_transfer_cancel with its epoch', () => {
      expect(parsePersistenceAdminArgs('writer', ['transfer', 'cancel', SOURCE, '--expected-epoch', '3', '--admin-intent', 'writer_transfer_cancel', '--expected-state', 'a'.repeat(64)]))
        .toMatchObject({ operation: 'writer_transfer_cancel', params: { source_id: SOURCE, expected_epoch: '3', admin_intent: 'writer_transfer_cancel' } });
    });
  });
}
