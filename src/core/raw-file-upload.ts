/**
 * #5963 Part A: raw files are not coordinated on managed brains yet. A
 * git-storage `gbrain files upload-raw` whose destination lies in a managed
 * canonical worktree is refused before anything is created; a configured
 * storage backend (`gbrain files upload`) is the working path.
 */
import type { BrainEngine } from './engine.ts';
import { opError, type OperationError } from './ops/contract.ts';
import { managedFilesystemRootFor } from './persistence/filesystem-guard.ts';

export function managedRawUploadRefusal(dest: string, filePath: string, pageSlug: string): OperationError | null {
  const managed = managedFilesystemRootFor(dest);
  if (!managed) return null;
  const error = opError('writer_coordinator_required',
    `gbrain files upload-raw cannot bank ${filePath} next to ${pageSlug}: that path is in the managed canonical worktree ${managed.root}${managed.sourceId ? ` (source ${managed.sourceId})` : ''}. Nothing was created.`,
    'Store the file in a configured storage backend instead: configure `storage` (supabase | s3 | local) in the gbrain config, then run the command in fix. Starting a gbrain serve owner does not help.',
    { why: 'Raw file uploads are not supported on a managed brain in this release: the persistence coordinator does not publish raw files yet, so the managed worktree refuses writes from outside it.',
      docs: 'docs/guides/write-refusals.md#managed_raw_upload',
      fix: { argv: ['gbrain', 'files', 'upload', filePath, '--page', pageSlug], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Uploads the file to the configured storage backend and links it to the page; it needs `storage` configured first.',
        verify: { argv: ['gbrain', 'files', 'list', pageSlug] } } });
  error.detail = `root=${managed.root} source=${managed.sourceId ?? 'unknown'} evidence=${managed.evidence}`;
  return error;
}

/** True when a git-storage upload for this page would land in a managed worktree (so upload-raw is refused). */
export async function rawUploadRefusedFor(engine: BrainEngine, pageSlug: string, sourceId: string): Promise<boolean> {
  const { resolvePageWriteTarget } = await import('./write-through.ts');
  const target = await resolvePageWriteTarget(engine, pageSlug, sourceId).catch(() => null);
  return !!target?.ok && managedFilesystemRootFor(target.filePath) !== null;
}
