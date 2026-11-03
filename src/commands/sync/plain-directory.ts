/**
 * #7973: a source registered as a plain directory (`gbrain sources add --path <dir> --force`, no Git checkout at or
 * above it) syncs without Git: each run imports the directory's files the way `gbrain import` does on a repo-less
 * brain, where the database is the record. There are no commits to diff, so a file removed from the directory keeps
 * its page (`gbrain delete` removes one), and no commit bookmark is written.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig } from '../../core/config.ts';
import { serr, slog } from '../../core/console-prefix.ts';
import { matchesAnyGlob, readMetafilePagesMode } from '../../core/sync.ts';
import { isAnchorOwnedSyncPath } from '../../core/sync-anchor.ts';
import { syncExcludePatterns } from '../../core/persistence/sync-discovery.ts';
import { maintenanceAttribution } from '../../core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../../core/persistence/context.ts';
import { opError } from '../../core/ops/contract.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';

/** Whether `dir` or any directory above it has a `.git` entry (read from the filesystem, no Git process). */
function underGitCheckout(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (current === dirname(current)) return false;
  }
}

/**
 * The registered root of a plain-directory source, or null when sync's Git path applies: a connector, a path override
 * other than the registered root, a root inside any Git checkout, or the classic default brain repo, whose sync keeps
 * its own self-heal (#2964). A source that has synced from Git (`last_commit` set) and lost its checkout refuses
 * `sync_not_applicable` (`checkout_missing`): importing it as plain would overwrite database-only edits and stop
 * deletions from propagating.
 */
export async function plainDirectorySyncRoot(engine: BrainEngine, opts: SyncOpts, managed: boolean): Promise<string | null> {
  if (opts.githubItem || opts.srcSubpath) return null;
  const sourceId = opts.sourceId ?? 'default';
  const [source] = await engine.executeRaw<{ local_path: string | null; last_commit: string | null; config: { kind?: unknown } | null }>(
    'SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  const registered = source?.local_path;
  if (!registered || !isAbsolute(registered) || source.config?.kind != null) return null;
  let root: string;
  try {
    root = realpathSync(registered);
    if (!statSync(root).isDirectory()) return null;
    if (opts.repoPath && realpathSync(opts.repoPath) !== root) return null;
  } catch { return null; }
  if (underGitCheckout(root)) return null;
  if (!managed && await isAnchorOwnedSyncPath(engine, opts, root)) return null;
  if (source.last_commit) throw opError('sync_not_applicable',
    `Sync refused for source ${sourceId}: it last synced from Git commit ${source.last_commit.slice(0, 12)}, but ${root} is no longer inside a Git checkout.`,
    `Ask the user whether the checkout was moved or deleted. Restore the Git checkout at ${root} (or point the source at where it now lives) and sync again. Nothing was synced.`,
    { reason: 'checkout_missing', why: 'Importing a former Git checkout as a plain directory would overwrite pages edited since the last commit and stop deletions from propagating.',
      fix: { argv: ['gbrain', 'sources', 'status', sourceId], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
        user_message: `Source ${sourceId} used to sync from a Git checkout at ${root}, but that folder is no longer a Git checkout. Was it moved or deleted? Restore it (or tell me where it lives now) and I will sync again.`,
        why: 'Shows the source and its registered path; nothing changes until the checkout is back.' } });
  return root;
}

/** Sync a plain-directory source by importing its files; a dry run counts them and writes nothing. */
export async function performPlainDirectorySync(engine: BrainEngine, opts: SyncOpts, root: string, managed: boolean): Promise<SyncResult> {
  const sourceId = opts.sourceId ?? 'default';
  const exclude = await syncExcludePatterns(engine, opts.exclude);
  const empty = { fromCommit: null, toCommit: '', modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
  serr(`[sync] ${root} is a plain directory, not a Git checkout, so sync imports its files into source ${sourceId}; a file removed from it keeps its page.`);
  const { runImport, collectSyncableFiles } = await import('../import.ts');
  if (opts.dryRun) {
    const files = collectSyncableFiles(root, { strategy: opts.strategy ?? 'markdown', includeHidden: opts.includeHidden, metafilePages: await readMetafilePagesMode(engine) })
      .filter(abs => !matchesAnyGlob(relative(root, abs), exclude));
    slog(`Plain-directory dry run: ${files.length} file(s) would be imported from ${root}.`);
    return { ...empty, status: 'dry_run', added: files.length };
  }
  const keyless = loadConfig()?.embedding_disabled === true || (await engine.getConfig('embedding_disabled')) === 'true';
  const result = await runImport(engine, [root, ...(opts.noEmbed || keyless ? ['--no-embed'] : [])],
    { signal: opts.signal, sourceId, strategy: opts.strategy, exclude, includeHidden: opts.includeHidden });
  if (result.errors > 0) return { ...empty, status: 'blocked_by_failures', added: result.imported, chunksCreated: result.chunksCreated, failedFiles: result.errors };
  // A managed brain fences source checkpoints to coordinated writers; the classic import stamps last_sync_at itself.
  if (managed) {
    const attribution = await maintenanceAttribution(engine);
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1', [sourceId]), attribution));
  }
  return { ...empty, status: 'synced', added: result.imported, chunksCreated: result.chunksCreated, ...(result.malformedSkipped ? { malformedSkipped: result.malformedSkipped } : {}) };
}
