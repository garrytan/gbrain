import { join, resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { resolveSourceLocalFilePath } from './markdown.ts';
import { resolveSourceId } from './source-resolver.ts';
import { ALL_SOURCES } from './source-id.ts';
import type { SlugRootMode } from './sync-anchor.ts';

/** The restore request does not identify exactly one source and its repo. */
export class RestoreTargetError extends Error {}

/**
 * The source and repo `foresights export --restore-only` restores. `foresights
 * storage status` resolves its restore hint with the same rule, so the files
 * it lists as missing are the ones the hint restores.
 *
 * `source` is an explicit --source already passed through resolveSourceId;
 * `repo` is an explicit --repo. A repo without a source selects the one
 * active source registered at that exact path; a repo registered only to an
 * archived source refuses; otherwise the only active source is selected.
 * Neither selects the flagless resolver chain's source and its local_path
 * (the legacy sync.repo_path answers for `default` only).
 */
export async function resolveRestoreTarget(
  engine: BrainEngine,
  source: string | undefined,
  repo: string | undefined,
): Promise<{ source: string; repo: string }> {
  if (source === ALL_SOURCES) throw new RestoreTargetError('--restore-only requires one source; pass --source <id>.');
  if (!source && repo) {
    const matches = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path=$1 LIMIT 2', [resolve(repo)]);
    if (matches.length === 1) source = matches[0].id;
    else {
      // A repo registered only to an archived source is that source's repo;
      // restoring another source's pages from it would be wrong.
      const [archived] = matches.length ? [] : await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS TRUE AND local_path=$1 ORDER BY id LIMIT 1', [resolve(repo)]);
      if (archived) throw new RestoreTargetError(`The restore repo belongs to archived source "${archived.id}". Run foresights sources restore ${archived.id} first. Or pass --source <id> and --repo <path> for an active source.`);
      const owners = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id LIMIT 2');
      if (!matches.length && owners.length === 1) source = owners[0].id;
      else throw new RestoreTargetError('The restore repo does not identify exactly one source. Pass --source <id> and --repo <path> for that source.');
    }
  }
  source ??= await resolveSourceId(engine, undefined);
  if (source === ALL_SOURCES) throw new RestoreTargetError('--restore-only requires one source; pass --source <id>.');
  if (!repo) {
    const [owner] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [source]);
    repo = owner?.local_path ?? (source === 'default' ? await engine.getConfig('sync.repo_path') : undefined) ?? undefined;
  }
  if (!repo) throw new RestoreTargetError('--restore-only requires --repo <path> or a configured default source with a local_path.');
  return { source, repo };
}

/**
 * The repo file whose absence makes `export --restore-only` restore a db_only
 * page: its recorded source_path when it has one (resolved in the source's
 * slug-root mode, `scannerSlugRootMode`), else `<slug>.md`. Throws
 * RestoreTargetError when the recorded path is too long or unsafe (export
 * then refuses the whole restore).
 */
export function restoreFilePath(repo: string, slug: string, sourcePath: string | null, sourcePathBytes: number, slugRootMode: SlugRootMode): string {
  if (sourcePathBytes > 4096) throw new RestoreTargetError('The recorded restore path exceeds the safe path limit.');
  const recorded = resolveSourceLocalFilePath(repo, sourcePath, slug, slugRootMode);
  if (sourcePath && !recorded) throw new RestoreTargetError('The recorded restore file path is unsafe. Reconcile it before exporting.');
  return recorded ?? join(repo, slug + '.md');
}
