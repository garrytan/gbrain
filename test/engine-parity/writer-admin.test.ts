/**
 * Engine parity for writer administration (`gbrain sources writer claim|lock|unlock|transfer prepare|cancel`): the
 * reviewed `--expected-state` digest (BrainEngine readWriterAdminState), the operator lock and the transfer
 * preparation (BrainEngine writerAdminStore), run through runPersistenceAdministration as the CLI runs them.
 *
 * Each case runs under its own GBRAIN_HOME, so this host's identity (host.json) is minted there, never in the real home.
 * The digest itself differs between arms (each brain mints its own id); what every arm must agree on is that a state
 * read twice is the same, that a claim bound to a fresh state applies, and that one bound to a state from before a
 * topology change is refused `writer_admin_state_changed`. The Postgres arm runs on whatever locale the test server
 * has (en_US.utf8 in CI); source ids `a-b` and `ab` sort differently there and in byte order, so the digest must not
 * depend on the server's collation to stay stable.
 *
 * Every arm, the Rust engine included, applies a real claim: writer deactivate and writer activate release it there
 * too (test/engine-parity/writer-release.test.ts), so no arm refuses the claim verb.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A timestamptz as jsonb holds it: `2026-11-20T12:00:00.123456+00:00`, trailing fraction zeros dropped. */
const JSONB_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;

/** Runs `run` with a scratch GBRAIN_HOME and a checkout root registered as source `work` (and `a-b`, `ab`). */
async function withCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-writer-admin-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      await Bun.write(join(root, 'example.md'), 'generic example');
      for (const id of ['a-b', 'ab']) await createSource(engine, backend, id, { kind: 'notes' });
      await createSource(engine, backend, 'work', {}, root);
      try { return await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The code a refused call threw, or `applied` when it did not refuse. */
async function refusal(run: Promise<unknown>): Promise<string> {
  return run.then(() => 'applied', (error: unknown) => String((error as { code?: unknown } | null)?.code ?? (error as Error).message));
}

const reviewed = async (engine: BrainEngine, operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });

describe('writer administration', () => {
  parityTest('a reviewed writer claim applies at the current state and refuses a state from before a topology change', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'getConfig'],
  }, async (engine, backend) => withCheckout(engine, backend, async (root) => {
    const before = await writerAdminState(engine);
    const stable = before === await writerAdminState(engine);
    const claim = await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: before });
    const after = await writerAdminState(engine);
    const stale = await refusal(runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: before }));
    const binding = (claim as { binding: { owner_host_id: string; state: string; relative_path: string } }).binding;
    const answers = {
      digest: /^[a-f0-9]{64}$/.test(before), stable, changed: after !== before,
      claimed: claim.claimed, owner_is_this_host: binding.owner_host_id === localHostId(), state: binding.state, relative_path: binding.relative_path,
      stale, again: (await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') })).claimed,
    };
    expect(answers).toEqual({
      digest: true, stable: true, changed: true, claimed: true, owner_is_this_host: true, state: 'active', relative_path: '',
      stale: 'writer_admin_state_changed', again: true,
    });
    return answers;
  }));

  parityTest('writer lock refuses reviewed and internal claims until unlock, and lock and unlock are idempotent', {
    methods: ['writerAdminStore', 'readWriterAdminState', 'worktreeClaimStore', 'getConfig'],
  }, async (engine, backend) => withCheckout(engine, backend, async (root) => {
    const lock = () => runPersistenceAdministration(engine, 'writer_lock', {});
    const unlock = () => runPersistenceAdministration(engine, 'writer_unlock', {});
    const view = (result: Record<string, unknown>) => {
      const state = result.admin_lock as { locked: boolean; set_at: string | null; host_id: string | null; generation: number };
      return { changed: result.changed, locked: state.locked, generation: state.generation, set_at: state.set_at !== null && ISO_MS.test(state.set_at),
        by_this_host: state.host_id === localHostId(), local_host: result.local_host_id === localHostId() };
    };
    const locked = view(await lock());
    const lockedAgain = view(await lock());
    const reviewedClaim = await refusal(runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') }));
    const internalClaim = await refusal(claimWorktree(engine, 'work', root));
    const unlocked = view(await unlock());
    const unlockedAgain = view(await unlock());
    const claimed = (await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') })).claimed;
    const answers = { locked, lockedAgain, reviewedClaim, internalClaim, unlocked, unlockedAgain, claimed };
    const set = { set_at: true, by_this_host: true, local_host: true };
    expect(answers).toEqual({
      locked: { changed: true, locked: true, generation: 1, ...set }, lockedAgain: { changed: false, locked: true, generation: 1, ...set },
      reviewedClaim: 'writer_admin_locked', internalClaim: 'writer_admin_locked',
      unlocked: { changed: true, locked: false, generation: 2, ...set }, unlockedAgain: { changed: false, locked: false, generation: 2, ...set },
      claimed: true,
    });
    return answers;
  }));

  parityTest('a reviewed transfer prepare drains the worktree, blocks the lock, and a reviewed cancel returns it to active', {
    methods: ['writerAdminStore', 'readWriterAdminState', 'worktreeClaimStore', 'getWorktreeBinding'],
  }, async (engine, backend) => withCheckout(engine, backend, async (root) => {
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') });
    const host = localHostId();
    const preview = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'work', dry_run: true });
    const stillActive = (await engine.getWorktreeBinding('work', host))?.state;
    const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'work', ...await reviewed(engine, 'writer_transfer_prepare') }) as {
      prepared: boolean; owner_epoch: string; manifest: { digest: string; file_count: number } };
    const draining = await engine.getWorktreeBinding('work', host);
    const lockWhilePrepared = await refusal(runPersistenceAdministration(engine, 'writer_lock', {}));
    const staleState = await writerAdminState(engine);
    await createSource(engine, backend, 'late', { kind: 'notes' });
    const staleCancel = await refusal(runPersistenceAdministration(engine, 'writer_transfer_cancel', {
      source_id: 'work', expected_epoch: prepared.owner_epoch, admin_intent: 'writer_transfer_cancel', expected_state: staleState }));
    const cancelled = await runPersistenceAdministration(engine, 'writer_transfer_cancel', {
      source_id: 'work', expected_epoch: prepared.owner_epoch, ...await reviewed(engine, 'writer_transfer_cancel') });
    const active = await engine.getWorktreeBinding('work', host);
    const answers = {
      preview: { dry_run: preview.dry_run, file_count: (preview.manifest as { file_count: number }).file_count, digest_matches: (preview.manifest as { digest: string }).digest === prepared.manifest.digest },
      stillActive, prepared: prepared.prepared, owner_epoch: prepared.owner_epoch, file_count: prepared.manifest.file_count,
      draining: { state: draining?.state, prepared_at: typeof draining?.prepared_at === 'string' && JSONB_TIME.test(draining.prepared_at) },
      lockWhilePrepared, staleCancel, cancelled: { cancelled: cancelled.cancelled, owner_epoch: cancelled.owner_epoch },
      active: { state: active?.state, prepared_at: active?.prepared_at, owner_epoch: active?.owner_epoch },
    };
    expect(answers).toEqual({
      preview: { dry_run: true, file_count: 1, digest_matches: true }, stillActive: 'active', prepared: true, owner_epoch: '1', file_count: 1,
      draining: { state: 'draining', prepared_at: true }, lockWhilePrepared: 'writer_transfer_conflict', staleCancel: 'writer_admin_state_changed',
      cancelled: { cancelled: true, owner_epoch: '1' }, active: { state: 'active', prepared_at: null, owner_epoch: '1' },
    });
    return answers;
  }));

  parityTest('a reviewed transfer accept moves the owner to the successor checkout, bumps the epoch and rebinds the content receipt', {
    methods: ['writerAdminStore', 'readWriterAdminState', 'worktreeClaimStore', 'getWorktreeBinding', 'readWorktreeManifest', 'setConfig', 'getConfig'],
  }, async (engine, backend) => withCheckout(engine, backend, async (root) => {
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') });
    const host = localHostId();
    const claimed = (await engine.getWorktreeBinding('work', host))!;
    const receiptKey = `shared_skills.content.v1.work.${claimed.source_incarnation}`;
    const brainId = await engine.readPersistenceBrainId();
    await engine.setConfig(receiptKey, JSON.stringify({ version: 1, brain_id: brainId, source_id: 'work', source_incarnation: claimed.source_incarnation, owned_root: true, root }));
    // The successor checkout: the same content at a new path (written, not copied, so no root record comes along).
    const successor = join(root, '..', 'successor');
    await Bun.write(join(successor, 'example.md'), 'generic example');
    const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'work', ...await reviewed(engine, 'writer_transfer_prepare') }) as {
      owner_epoch: string; manifest: { digest: string } };
    const accept = (extra: Record<string, unknown>) => runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: 'work', path: successor, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, ...extra });
    const staleState = await writerAdminState(engine);
    await createSource(engine, backend, 'late', { kind: 'notes' });
    const staleAccept = await refusal(accept({ admin_intent: 'writer_transfer_accept', expected_state: staleState }));
    const stillDraining = (await engine.getWorktreeBinding('work', host))?.state;
    const wrongManifest = await refusal(runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: 'work', path: successor, expected_epoch: prepared.owner_epoch, manifest: 'f'.repeat(64), ...await reviewed(engine, 'writer_transfer_accept') }));
    // The accept dry run reads the prepared manifest through the typed member (its scope picks the successor's hash).
    const manifestReads: string[] = [];
    const readManifest = engine.readWorktreeManifest;
    (engine as { readWorktreeManifest: BrainEngine['readWorktreeManifest'] }).readWorktreeManifest = (id: string) => { manifestReads.push(id); return readManifest.call(engine, id); };
    let preview: { dry_run?: boolean; manifest_matches?: boolean; expected_epoch?: string };
    try { preview = await accept({ dry_run: true }) as typeof preview; } finally { (engine as { readWorktreeManifest: BrainEngine['readWorktreeManifest'] }).readWorktreeManifest = readManifest; }
    const dryRun = { dry_run: preview.dry_run, manifest_matches: preview.manifest_matches, expected_epoch: preview.expected_epoch,
      read_through_member: manifestReads.length === 1 && manifestReads[0] === claimed.worktree_id };
    const accepted = await accept(await reviewed(engine, 'writer_transfer_accept')) as {
      transferred: boolean; binding: { owner_epoch: string; state: string; local_path: string; owner_host_id: string; prepared_at: string | null };
      content_receipts?: { source_id: string; from: string | null; to: string }[] };
    const receipt = JSON.parse((await engine.getConfig(receiptKey))!) as { root: string; root_identity?: { device: number; inode: number } };
    const after = (await engine.getWorktreeBinding('work', host))!;
    const replay = await refusal(accept(await reviewed(engine, 'writer_transfer_accept')));
    const kept = await engine.readWorktreeManifest(claimed.worktree_id);
    const answers = {
      staleAccept, stillDraining, wrongManifest, dryRun,
      manifest: { kept: kept?.digest === prepared.manifest.digest, missing: await engine.readWorktreeManifest('00000000-0000-4000-8000-000000000000') },
      accepted: { transferred: accepted.transferred, owner_epoch: accepted.binding.owner_epoch, state: accepted.binding.state,
        at_successor: accepted.binding.local_path === realpathSync(successor), owner_is_this_host: accepted.binding.owner_host_id === host,
        prepared_at_kept: typeof accepted.binding.prepared_at === 'string' && JSONB_TIME.test(accepted.binding.prepared_at) },
      receipts: (accepted.content_receipts ?? []).map(r => ({ source_id: r.source_id, from_old: r.from === root, to_successor: r.to === realpathSync(successor) })),
      receipt: { at_successor: receipt.root === realpathSync(successor), identity: typeof receipt.root_identity?.inode === 'number' },
      after: { owner_epoch: after.owner_epoch, state: after.state, at_successor: after.local_path === realpathSync(successor) },
      replay,
    };
    expect(answers).toEqual({
      staleAccept: 'writer_admin_state_changed', stillDraining: 'draining', wrongManifest: 'writer_manifest_mismatch',
      dryRun: { dry_run: true, manifest_matches: true, expected_epoch: '1', read_through_member: true },
      manifest: { kept: true, missing: null },
      accepted: { transferred: true, owner_epoch: '2', state: 'active', at_successor: true, owner_is_this_host: true, prepared_at_kept: true },
      receipts: [{ source_id: 'work', from_old: true, to_successor: true }],
      receipt: { at_successor: true, identity: true },
      after: { owner_epoch: '2', state: 'active', at_successor: true },
      replay: 'writer_transfer_conflict',
    });
    return answers;
  }));

  parityTest('a real claim applies on every engine and binds the source; the dry run and the reviewed-state check still answer', {
    methods: ['readWriterAdminState', 'getWorktreeBinding'],
  }, async (engine, backend) => withCheckout(engine, backend, async (root) => {
    const dryRun = (await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, dry_run: true })).dry_run;
    const staleState = await writerAdminState(engine);
    await createSource(engine, backend, 'late', { kind: 'notes' });
    const stale = await refusal(runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: staleState }));
    const real = await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') });
    const binding = await engine.getWorktreeBinding('work', localHostId());
    const answers = { dryRun, stale, claimed: real.claimed === true, bound: binding?.state ?? null };
    expect(answers).toEqual({ dryRun: true, stale: 'writer_admin_state_changed', claimed: true, bound: 'active' });
    return answers;
  }));
});
