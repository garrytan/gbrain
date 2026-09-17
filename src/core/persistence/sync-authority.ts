import { AsyncLocalStorage } from 'node:async_hooks';
import type { SyncOpts } from '../../commands/sync.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { currentSubmissionAuthority, authorizeJobExecution, assertCurrentRemoteJobPrincipal, authorityDigest, type RemoteJobAuthority } from '../minions/submission-authority.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { submissionAuthority, authorizeWrite } from './authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import type { WriteAuthority } from './model.ts';

const legacyDelegation = new AsyncLocalStorage<boolean>();
/** A shared-secret caller never gains durable CLI authority across activation. */
export function withLegacySyncDelegation<T>(run: () => T): T { return legacyDelegation.run(true, run); }
function assertDurableSyncCaller(): void {
  if (legacyDelegation.getStore()) throw new OperationError('permission_denied', 'Managed sync requires a durable CLI registration; the shared-secret sync lane cannot supply it.');
}

export interface SyncAuthority { writer: WriteAuthority; remoteJob?: RemoteJobAuthority; remoteData?: Record<string, unknown>; }
export async function managedSyncAuthority(engine: BrainEngine, sourceId: string, incarnation: string, repoPath: string): Promise<SyncAuthority> {
  assertDurableSyncCaller();
  const current = currentSubmissionAuthority();
  if (current?.kind === 'remote_agent') throw new OperationError('permission_denied', 'Agent jobs cannot run bulk filesystem sync.');
  if (current?.kind === 'remote_generic') {
    const data = { repoPath, sourceId, noPull: true, noEmbed: true, noExtract: true, auto_embed_backfill: false };
    await authorizeJobExecution(engine, { name: 'sync', data, submission_authority: current });
    const ctx = { engine, remote: true, sourceId, auth: { principal: current.principal, scopes: current.grant.scopes,
      sourceId, allowedOperations: current.grant.allowedOperations }, takesHoldersAllowList: ['world'] } as OperationContext;
    return { writer: await submissionAuthority(ctx, 'submit_job', sourceId, incarnation, '__managed_sync_checkpoint__'),
      remoteJob: structuredClone(current), remoteData: data };
  }
  const verified = currentVerifiedLocalWriter();
  // A verified stdio writer retains its own lane and grant, even in the owner process.
  if (verified?.remote) throw new OperationError('permission_denied', 'Bulk sync requires the local CLI or an authenticated source-scoped admin job.');
  if (!verified) await registerLocalWriter(engine, 'cli');
  const writer = await submissionAuthority({ engine, remote: verified?.remote ?? false, sourceId } as OperationContext,
    'submit_job', sourceId, incarnation, '__managed_sync_checkpoint__');
  if (writer.slugPrefixes !== null) throw new OperationError('permission_denied', 'Bulk sync requires a source-wide local grant.');
  return { writer };
}
export async function validateSyncAuthority(engine: BrainEngine, authority: SyncAuthority, slug: string): Promise<void> {
  await authorizeWrite(engine, authority.writer, 'submit_job', slug);
  await authorizePageVisibility(engine, authority.writer, slug);
  if (!authority.remoteJob) return;
  if (authority.remoteJob.grant.jobName !== 'sync' || authority.remoteJob.grant.sourceId !== authority.writer.sourceId ||
      authorityDigest(authority.remoteData) !== authority.remoteJob.payloadHash ||
      authorityDigest(authority.remoteJob.principal) !== authorityDigest(authority.writer.principal)) {
    throw new OperationError('permission_denied', 'Sync intent exceeds the original job grant.');
  }
  await assertCurrentRemoteJobPrincipal(engine, authority.remoteJob);
  const [source] = await engine.executeRaw<{ created_at: string }>('SELECT created_at FROM sources WHERE id=$1', [authority.writer.sourceId]);
  if (!source || new Date(source.created_at).toISOString() !== authority.remoteJob.grant.sourceCreatedAt) {
    throw new OperationError('source_changed', 'The original sync source was replaced.');
  }
}

/** Worker runtime fields are not an avenue to enlarge the accepted wire payload. */
export function validateManagedSyncOptions(opts: SyncOpts): void {
  assertDurableSyncCaller();
  const current = currentSubmissionAuthority();
  if (current?.kind !== 'remote_generic') return;
  const allowed = new Set(['repoPath','sourceId','noPull','noEmbed','noExtract','signal','concurrency','onProgress','auto_embed_backfill']);
  if (current.grant.jobName !== 'sync' || opts.repoPath !== current.grant.canonicalRoot || opts.sourceId !== current.grant.sourceId ||
      opts.noPull !== true || opts.noEmbed !== true || opts.noExtract !== true ||
      Object.entries(opts).some(([key,value]) => value !== undefined && !allowed.has(key)) ||
      ((opts as Record<string,unknown>).auto_embed_backfill !== undefined && (opts as Record<string,unknown>).auto_embed_backfill !== false)) {
    throw new OperationError('permission_denied', 'Sync options exceed the originally accepted remote job.');
  }
}
