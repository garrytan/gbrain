import { AsyncLocalStorage } from 'node:async_hooks';
import type { SyncOpts } from '../../commands/sync.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { currentSubmissionAuthority, currentJobSignal, authorizeJobExecution, assertCurrentRemoteJobPrincipal, authorityDigest, type RemoteJobAuthority } from '../minions/submission-authority.ts';
import { assertSourceFilesystemActive } from '../minions/source-filesystem.ts';
import { throwIfAborted } from '../abort-check.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { submissionAuthority, authorizeWrite } from './authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import type { WriteAuthority } from './model.ts';

const legacyDelegation = new AsyncLocalStorage<boolean>();
/** The bulk sync of one source, which only the brain host's CLI may run. */
const hostSyncFix = (sourceId: string, actor: 'user' | 'host_admin'): Action => ({
  argv: ['gbrain', 'sync', '--no-pull', '--source', sourceId], consent: [], actor, requires_exclusive: false,
  why: `Bulk filesystem sync of source ${sourceId} runs under the brain host's CLI writer, which reads its registered checkout without git pull.`,
  user_message: actor === 'user'
    ? `Syncing source ${sourceId} needs the gbrain CLI. Please run the command shown in a terminal on this machine.`
    : `Syncing source ${sourceId} needs the gbrain CLI on the machine that hosts the brain. Please ask whoever runs that server to run the command shown.`,
});
/** A shared-secret caller never gains durable CLI authority across activation. */
export function withLegacySyncDelegation<T>(run: () => T): T { return legacyDelegation.run(true, run); }
function assertDurableSyncCaller(): void {
  if (legacyDelegation.getStore()) throw trustedCliRequired('Managed sync requires a durable CLI registration; the shared-secret sync lane cannot supply it.');
}

export interface SyncAuthority { writer: WriteAuthority; remoteJob?: RemoteJobAuthority; remoteData?: Record<string, unknown>; }
export interface SyncProcessingOptions { noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean; }
export function syncProcessingOptions(opts: SyncOpts): SyncProcessingOptions {
  return { noEmbed: opts.noEmbed === true, noExtract: opts.noExtract === true, noSchemaPack: opts.noSchemaPack === true };
}
export const SYNC_PROCESSING_KEYS = ['noEmbed', 'noExtract', 'noSchemaPack'] as const;
/** The processing options a caller set itself; an unfinished cursor supplies the rest (#5632). */
export function explicitSyncProcessing(values: Record<string, unknown>): Array<keyof SyncProcessingOptions> {
  return SYNC_PROCESSING_KEYS.filter(key => typeof values[key] === 'boolean');
}
export function assertSyncDispatchActive(): void {
  assertSourceFilesystemActive(true);
  throwIfAborted(currentJobSignal());
}
export async function resolveSyncPersistenceMode(engine: BrainEngine, opts: SyncOpts): Promise<boolean> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  assertSyncDispatchActive();
  if (brain?.enabled || opts.signal?.aborted) return brain?.enabled === true;
  const [source] = await engine.executeRaw<{ claimed: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM persistence_source_bindings WHERE source_id=s.id AND source_incarnation=s.incarnation) AS claimed
    FROM sources s WHERE s.id=$1`, [opts.sourceId ?? 'default']);
  if (source?.claimed) {
    throw new OperationError('writer_coordinator_required', 'Claimed-source sync, including connectors, requires explicit persistence activation.',
      'Stop older writers and review gbrain sources writer status, then explicitly activate persistence before retrying. Claiming a source alone does not exclude running legacy writers.');
  }
  return false;
}
export async function assertManagedSyncActive(engine: BrainEngine, lock = false): Promise<void> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>(`SELECT enabled FROM persistence_brain WHERE singleton=1${lock ? ' FOR SHARE' : ''}`);
  if (!brain?.enabled) throw new OperationError('writer_coordinator_required', 'Sync cannot publish through an inactive persistence coordinator.',
    'Stop older writers and review gbrain sources writer status, then explicitly activate persistence before retrying. Claiming a source alone does not exclude running legacy writers.');
}
export async function managedSyncAuthority(engine: BrainEngine, sourceId: string, incarnation: string, repoPath: string): Promise<SyncAuthority> {
  assertDurableSyncCaller();
  const current = currentSubmissionAuthority();
  if (current?.kind === 'remote_agent') throw opError('permission_denied', 'Agent jobs cannot run bulk filesystem sync.',
    `A job submitted by an agent connection cannot read the filesystem checkout of source ${sourceId}, so nothing was synced. The brain host's operator runs the sync with the command in fix.`,
    { fix: hostSyncFix(sourceId, 'host_admin') });
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
  if (verified?.remote) throw opError('permission_denied', 'Bulk sync requires the local CLI or an authenticated source-scoped admin job.',
    `This stdio MCP writer cannot run bulk filesystem sync of source ${sourceId}, so nothing was synced. The user runs the command in fix in a terminal on this machine.`,
    { fix: hostSyncFix(sourceId, 'user') });
  if (!verified) await registerLocalWriter(engine, 'cli');
  const writer = await submissionAuthority({ engine, remote: verified?.remote ?? false, sourceId } as OperationContext,
    'submit_job', sourceId, incarnation, '__managed_sync_checkpoint__');
  if (writer.slugPrefixes !== null) throw opError('permission_denied', 'Bulk sync requires a source-wide local grant.',
    `This CLI writer's grant covers only some slug prefixes of source ${sourceId}, and bulk sync can touch any page, so nothing was synced. Review the grant with the command in fix; widening it (gbrain auth local-writer register cli --replace with the complete intended grant) is the user's decision.`,
    { fix: readFix('Lists the local writer registrations with their sources, operations and slug-prefix grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  return { writer };
}
export async function validateSyncAuthority(engine: BrainEngine, authority: SyncAuthority, slug: string): Promise<void> {
  await authorizeWrite(engine, authority.writer, 'submit_job', slug);
  await authorizePageVisibility(engine, authority.writer, slug);
  if (!authority.remoteJob) return;
  if (authority.remoteJob.grant.jobName !== 'sync' || authority.remoteJob.grant.sourceId !== authority.writer.sourceId ||
      authorityDigest(authority.remoteData) !== authority.remoteJob.payloadHash ||
      authorityDigest(authority.remoteJob.principal) !== authorityDigest(authority.writer.principal)) {
    throw opError('permission_denied', 'Sync intent exceeds the original job grant.',
      `The sync of source ${authority.writer.sourceId} no longer matches the job that was approved (its name, source, payload or principal changed), so it stopped before admitting anything more. Submit a new sync job for the source, or have the brain host's operator run the command in fix.`,
      { fix: hostSyncFix(authority.writer.sourceId, 'host_admin') });
  }
  await assertCurrentRemoteJobPrincipal(engine, authority.remoteJob);
  const [source] = await engine.executeRaw<{ created_at: string }>('SELECT created_at FROM sources WHERE id=$1', [authority.writer.sourceId]);
  if (!source || new Date(source.created_at).toISOString() !== authority.remoteJob.grant.sourceCreatedAt) {
    throw opError('source_changed', 'The original sync source was replaced.',
      `Source ${authority.writer.sourceId} was removed and registered again after this sync job was approved, so the job no longer applies and it stopped before admitting anything more. Submit a new sync job for the current source.`,
      { fix: readFix('Lists the registered sources with their IDs and creation times, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  }
}

/** Worker runtime fields are not an avenue to enlarge the accepted wire payload. */
export function validateManagedSyncOptions(opts: SyncOpts): void {
  assertDurableSyncCaller();
  const current = currentSubmissionAuthority();
  if (current?.kind !== 'remote_generic') return;
  const allowed = new Set(['repoPath','sourceId','noPull','noEmbed','noExtract','explicitProcessing','signal','concurrency','onProgress','auto_embed_backfill']);
  if (current.grant.jobName !== 'sync' || opts.repoPath !== current.grant.canonicalRoot || opts.sourceId !== current.grant.sourceId ||
      opts.noPull !== true || opts.noEmbed !== true || opts.noExtract !== true ||
      Object.entries(opts).some(([key,value]) => value !== undefined && !allowed.has(key)) ||
      ((opts as Record<string,unknown>).auto_embed_backfill !== undefined && (opts as Record<string,unknown>).auto_embed_backfill !== false)) {
    throw opError('permission_denied', 'Sync options exceed the originally accepted remote job.',
      `A remote sync job of source ${current.grant.sourceId} runs only on its registered root with no_pull, no_embed and no_extract set and no other options; this run asked for more, so nothing was synced. Submit the job again with only those options, or have the brain host's operator run the command in fix.`,
      { fix: hostSyncFix(current.grant.sourceId, 'host_admin') });
  }
}
