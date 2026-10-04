import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isImageFilePath, type ImportResult } from '../import-file.ts';
import { loadConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { initializeLocalPersistence, requestPrincipalForContext, submitPageMutation } from './page-mutations.ts';
import { digest, sha256 } from './digest.ts';
import { assertImportPaths, managedImportContent, prepareManagedImportMutation, readImportBytes, type ImportPack, type ManagedImportIntent } from './import-prepare.ts';
import { submissionAuthority } from './authority.ts';
import { inspectUnchanged, screeningRequest } from './noop-kernel.ts';
import type { WorktreeBinding } from './ownership.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';

export async function importManagedFile(engine: BrainEngine, filePath: string, sourcePath: string,
  opts: { sourceId?: string; noEmbed?: boolean; activePack?: ImportPack; signal?: AbortSignal; slugRoot?: string } = {}): Promise<ImportResult> {
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('Managed filesystem import requires the trusted local CLI.');
  }
  opts.signal?.throwIfAborted();
  if (isImageFilePath(sourcePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL !== 'true') {
    throw opError('invalid_params', 'Image import requires GBRAIN_EMBEDDING_MULTIMODAL=true.',
      `${sourcePath} is an image and multimodal embeddings are off, so it was not imported. Import only text files, or ask the user whether to enable GBRAIN_EMBEDDING_MULTIMODAL=true for the gbrain process (image embeddings can cost money).`);
  }
  const sourceId = opts.sourceId ?? 'default';
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw opError('owner_unavailable', 'Managed import must run on the active canonical owner for the selected source.',
      `This host is not the active owner of source ${sourceId}, so nothing was imported. Run the import on the owner host that writer status names, or wait until its owner is active.`,
      { fix: readFix(`Shows source ${sourceId}'s owner host and state, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) });
  }
  const root = join(binding.local_path, binding.relative_path);
  const inputPath = resolve(filePath);
  const canonicalRelative = relative(root, inputPath);
  const canonicalInput = canonicalRelative && !isAbsolute(canonicalRelative) && canonicalRelative !== '..' && !canonicalRelative.startsWith(`..${sep}`);
  if (canonicalInput && !opts.slugRoot) sourcePath = canonicalRelative;
  const path = canonicalInput ? canonicalRelative : sourcePath;
  const target = resolve(root, path);
  await assertImportPaths(engine, sourceId, root, inputPath, target);
  const bytes = readImportBytes(inputPath);
  const inputHash = sha256(bytes);
  const { slug, content } = managedImportContent(sourcePath, bytes, opts.activePack);
  const ctx = { engine, remote: false, sourceId, config: loadConfig() ?? { engine: engine.kind } } as OperationContext;
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const key = digest({ principal, incarnation: binding.source_incarnation, inputPath, sourcePath, path, inputHash, noEmbed: !!opts.noEmbed, activePack: opts.activePack ?? null });
  const op = 'managed-file-import';
  const readPending = async () => {
    const [row] = await engine.executeRaw<{ completed_keys: [ManagedImportIntent & { request_id: string; source_id: string }] }>(
      'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [op, key]);
    return row?.completed_keys[0];
  };
  let params = await readPending();
  if (!params) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    const intent: ManagedImportIntent = { kind: 'managed_file_import', slug, content, sourcePath, path, inputPath, inputHash,
      targetHash: existsSync(target) ? sha256(readImportBytes(target)) : null,
      ownerEpoch: String(binding.owner_epoch), ...(snapshot ? { expected_revision: snapshot.revision } : {}),
      noEmbed: !!opts.noEmbed, ...(opts.activePack ? { activePack: opts.activePack } : {}) };
    // #5470: an import whose publication would change nothing takes no admission.
    if (await unchangedManagedImport(ctx, binding, intent, snapshot)) return { slug, status: 'skipped', chunks: 0 };
    params = { ...intent, request_id: randomUUID(), source_id: sourceId };
    await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING', [op, key, JSON.stringify([params])]);
    params = (await readPending())!;
  }
  try {
    const outcome = await submitPageMutation(ctx, { operation: 'put_page', params, waitMs: 30_000, managedFileImport: true });
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, key, JSON.stringify([params])]);
    return { slug: String(outcome.slug), status: outcome.status as ImportResult['status'], chunks: Number(outcome.chunks ?? 0),
      ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
      ...(outcome.type_warning ? { type_warning: outcome.type_warning as ImportResult['type_warning'] } : {}) };
  } catch (error) {
    if (error instanceof OperationError && error.writeRequest && ['failed', 'conflict', 'cancelled'].includes(error.writeRequest.state)) {
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, key, JSON.stringify([params])]);
    }
    throw error;
  }
}

/** Runs the managed-import preparer on an unadmitted request; true only when the no-op kernel finds nothing to publish. */
async function unchangedManagedImport(ctx: OperationContext, binding: WorktreeBinding, intent: ManagedImportIntent, snapshot: PageSnapshot | null): Promise<boolean> {
  if (!snapshot) return false;
  try {
    const authority = await submissionAuthority(ctx, 'put_page', binding.source_id, binding.source_incarnation, intent.slug);
    const row = screeningRequest({ source_id: binding.source_id, source_incarnation: binding.source_incarnation, slug: intent.slug,
      page_id: snapshot.page.id, worktree_id: binding.worktree_id, authority, intent, operation: 'put_page' });
    const prepared = await prepareManagedImportMutation(ctx.engine, row, ctx.config);
    if ((await inspectUnchanged(ctx.engine, { prepared, snapshot, sourcePath: intent.sourcePath, databaseOnly: false })).admitReason) return false;
    await prepared.validate?.(ctx.engine);
    return true;
  } catch {
    return false;
  }
}
