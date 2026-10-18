/**
 * Writer transfer administration (`gbrain sources writer transfer prepare|accept|cancel`), dispatched by
 * `runPersistenceAdministration`. Prepare drains the owner and records the manifest; accept moves ownership to the
 * successor; cancel (C-5) returns a prepared transfer nobody accepted to active on the owner host. Every non-dry-run
 * change requires its action-specific --admin-intent and the reviewed --expected-state.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { acceptWriterTransfer, cancelWriterTransfer, getWorktreeBinding, humanManifestProgress, prepareWriterTransfer, storedManifestScope, worktreeManifest, type StoredWorktreeManifest } from './ownership.ts';
import { existingLocalHostId } from './identity.ts';
import { requireWriterAdminIntent } from './admin-intent.ts';
import { bool, invalid, keys, path, source } from './administration.ts';

/** #5914: `--confirm-relocated-root` only qualifies a self-transfer; alone it is a usage error, never a silent no-op. */
function transferOptions(params: Record<string, unknown>): { selfTransfer: boolean; relocated: boolean } {
  bool(params, 'confirm_relocated_root');
  if (params.confirm_relocated_root === true && params.self_transfer !== true) throw invalid('confirm_relocated_root requires self_transfer.',
    'Pass --confirm-relocated-root together with --self-transfer: it waives only the directory identity comparison of a self-transfer that repairs a checkout recreated at its recorded path.');
  return { selfTransfer: params.self_transfer === true, relocated: params.confirm_relocated_root === true };
}

const transferStatusFix = (sourceId: string) =>
  readFix(`Shows source ${sourceId}'s owner binding and prepared transfer, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', sourceId, '--json'] });

/** The prepared positive owner epoch a transfer accept or cancel names. */
function expectedEpoch(params: Record<string, unknown>, sourceId: string): string {
  if (typeof params.expected_epoch !== 'string' || !/^[1-9]\d{0,18}$/.test(params.expected_epoch)
    || BigInt(params.expected_epoch) > 9_223_372_036_854_775_807n) throw invalid('expected_epoch must be the prepared positive owner epoch.',
    `Pass --expected-epoch with the owner_epoch that gbrain sources writer transfer prepare ${sourceId} printed (a positive integer).`, transferStatusFix(sourceId));
  return params.expected_epoch;
}

export async function runWriterTransferAdministration(engine: BrainEngine, operation: 'writer_transfer_prepare' | 'writer_transfer_accept' | 'writer_transfer_cancel',
  params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (operation === 'writer_transfer_cancel') {
    keys(params, ['source_id', 'expected_epoch', 'dry_run', 'admin_intent', 'expected_state']);
    const sourceId = source(params.source_id), epoch = expectedEpoch(params, sourceId);
    if (params.dry_run) {
      const preview = await cancelWriterTransfer(engine, sourceId, epoch, existingLocalHostId()!, undefined, { dryRun: true });
      return { dry_run: true, action: operation, source_id: sourceId, ...preview,
        ...(preview.cancellable ? { apply_command: `gbrain sources writer transfer cancel ${sourceId} --expected-epoch ${epoch} --admin-intent writer_transfer_cancel --expected-state <admin_state>` } : {}) };
    }
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    const cancelled = await cancelWriterTransfer(engine, sourceId, epoch, undefined, expectedState);
    return { cancelled: true, source_id: sourceId, worktree_id: cancelled.worktree_id, owner_epoch: cancelled.owner_epoch, binding: await getWorktreeBinding(engine, sourceId) };
  }
  if (operation === 'writer_transfer_prepare') {
    keys(params, ['source_id', 'dry_run', 'admin_intent', 'expected_state', 'self_transfer', 'confirm_relocated_root']);
    const sourceId = source(params.source_id);
    bool(params, 'self_transfer');
    const transfer = transferOptions(params);
    if (params.dry_run) {
      const binding = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
      if (!binding || binding.owner_host_id !== existingLocalHostId() || !binding.local_path) {
        throw opError('permission_denied', 'Only the current owner can prepare a transfer.',
          `This host is not source ${sourceId}'s current owner. Run the transfer prepare on the owner host that writer status names; a transfer is a deliberate topology change the operator reviews.`,
          { fix: readFix(`Shows which host owns source ${sourceId}, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) });
      }
      const { manifest } = await prepareWriterTransfer(engine, sourceId, existingLocalHostId()!, undefined, { ...transfer, dryRun: true });
      return { dry_run: true, action: operation, binding, manifest: { digest: manifest.digest, file_count: manifest.file_count }, ...(transfer.relocated ? { relocated: true } : {}) };
    }
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    const prepared = await prepareWriterTransfer(engine, sourceId, undefined, expectedState, transfer);
    // #6099: a Git-scoped manifest covers tracked files only; untracked files Git does not ignore are reported as a count.
    const untracked = prepared.manifest.untracked_count ?? 0;
    return { prepared: true, source_id: sourceId, worktree_id: prepared.worktree_id, owner_epoch: prepared.owner_epoch,
      manifest: { digest: prepared.manifest.digest, file_count: prepared.manifest.file_count, ...(prepared.manifest.scope ? { scope: prepared.manifest.scope } : {}) },
      ...(untracked ? { untracked_files: untracked, warning: `${untracked} untracked file(s) in the checkout that Git does not ignore are not part of the transfer manifest and are not carried to the successor; commit them, or add them to .gitignore, before the successor clones.` } : {}) };
  }
  keys(params, ['source_id', 'path', 'expected_epoch', 'manifest', 'dry_run', 'admin_intent', 'expected_state', 'self_transfer', 'confirm_relocated_root']);
  bool(params, 'self_transfer');
  const transfer = transferOptions(params);
  const sourceId = source(params.source_id), root = path(params.path);
  const epoch = expectedEpoch(params, sourceId);
  if (typeof params.manifest !== 'string' || !/^[a-f0-9]{64}$/.test(params.manifest)) throw invalid('manifest must be the prepared SHA-256 manifest digest.',
    `Pass --manifest with the 64-character manifest digest that gbrain sources writer transfer prepare ${sourceId} printed.`, transferStatusFix(sourceId));
  if (params.dry_run && params.self_transfer === true) await acceptWriterTransfer(engine, sourceId, root, epoch, params.manifest, existingLocalHostId()!, undefined, { ...transfer, dryRun: true });
  if (params.dry_run) {
    const current = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
    const [prepared] = current ? await engine.executeRaw<{ manifest: StoredWorktreeManifest | null }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [current.worktree_id]) : [];
    const candidate = worktreeManifest(root, { progress: humanManifestProgress(), scope: storedManifestScope(prepared?.manifest) });
    return { dry_run: true, action: operation, source_id: sourceId, current, manifest_matches: candidate.digest === params.manifest, expected_epoch: epoch,
      ...(candidate.scope ? { manifest_scope: candidate.scope } : {}), ...(candidate.untracked_count ? { untracked_files: candidate.untracked_count } : {}) };
  }
  const expectedState = await requireWriterAdminIntent(engine, operation, params);
  const accepted = await acceptWriterTransfer(engine, sourceId, root, epoch, params.manifest, undefined, expectedState, transfer);
  return { transferred: true, binding: await getWorktreeBinding(engine, sourceId), ...(accepted.content_receipts.length ? { content_receipts: accepted.content_receipts } : {}) };
}
