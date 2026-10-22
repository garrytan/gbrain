/**
 * #6609 (D5): a page restored while its recorded canonical file is gone from
 * the source's syncable tree. Classic sync keys pages on `source_path`, so a
 * plain restore of such a page (one that writes no file: `sync.write_through`
 * off, a sandbox, a database-only source) is undone by the next
 * `gbrain sync --full`, which soft-deletes every live page whose recorded file
 * it does not find. `restore_page` therefore refuses it with
 * `canonical_file_absent` and the user's two choices: put the file back and
 * sync, or restore with `detach: true`, which clears the page's `source_path`
 * in the publication and stamps `pages.database_only_reason='detached'`, so no
 * sync sweeps it. A transient absence (an unpulled checkout, another machine)
 * never turns a page database-only by itself. Doctor `missing_recorded_files`
 * (`scanMissingRecordedFiles`) lists the live pages a full sync would delete
 * that way on a brain without managed persistence (`ghost_pages` covers
 * managed sources on their owner host).
 */
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { isNestedSkipMetafile, isSyncable, readMetafilePagesMode, type MetafilePagesMode, type SyncStrategy } from '../sync.ts';
import { diskMetafileHeads, firstMetafileHead, gitMetafileHeads, metafilePagePredicate } from '../sync-metafile-pages.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { resolvePageWriteTarget, scannerSlugRootMode } from '../write-through.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';

export const DETACHED_REASON = 'detached';
const DOCS = 'docs/storage-tiering.md#restoring-a-page-whose-file-is-gone';

/**
 * Whether classic sync would import the file at `path`: it exists and, inside
 * a Git work tree, is tracked or untracked but not ignored (`git ls-files
 * --cached --others --exclude-standard`, the enumeration sync uses). Outside a
 * work tree, or without git, sync walks the directory, so existence decides.
 */
export function inSyncableTree(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return execFileSync('git', ['-C', dirname(path), 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', basename(path)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitChildEnv() }).length > 0;
  } catch {
    return true;
  }
}

/**
 * The recorded `source_path` of a page whose file the next full sync would
 * not find, else null. A page without a recorded file, a path sync never
 * reconciles, or a source with no checkout on this host is never absent.
 */
export async function absentRecordedFile(engine: BrainEngine, sourceId: string, page: { slug: string; source_path?: string | null }): Promise<string | null> {
  const sourcePath = page.source_path?.trim();
  if (!sourcePath || !isSyncable(sourcePath, { metafilePage: isNestedSkipMetafile })) return null;
  const target = await resolvePageWriteTarget(engine, page.slug, sourceId, { includeDeleted: true });
  if (!target.ok || inSyncableTree(target.filePath)) return null;
  if (!isNestedSkipMetafile(sourcePath)) return sourcePath;
  // GBRA-150: a nested metafile's page is reconciled only when it is typed (as last committed, since its file is gone).
  const [source] = await engine.executeRaw<{ local_path: string | null; last_commit: string | null }>('SELECT local_path, last_commit FROM sources WHERE id=$1', [sourceId]);
  const root = source?.local_path;
  if (!root || !existsSync(root)) return null;
  const metafilePage = recordedMetafilePage(await readMetafilePagesMode(engine), root, source.last_commit, () => relative(root, target.filePath).split('\\').join('/'));
  return metafilePage(sourcePath) ? sourcePath : null;
}

/**
 * Admission rule for `restore_page`: a restore that publishes no file
 * (`publishesFile` false) of a soft-deleted page whose recorded file is absent
 * refuses unless `detach`; `detach` is refused when there is nothing to detach.
 */
export async function assertRestoreOrigin(engine: BrainEngine, input: { sourceId: string; slug: string; snapshot: PageSnapshot | null;
  publishesFile: boolean; detach: boolean; remote: boolean; root?: string }): Promise<void> {
  const { sourceId, slug, snapshot } = input;
  // #7324: a declared database-only origin that left the syncable tree is
  // not made file-backed again merely because this source has a worktree.
  // Presence in the tree still wins: declarations never detach tracked files.
  const declared = !!input.root && isSourceDbOnlySlug(input.root, slug, 'refuse');
  const absent = snapshot?.page.deleted_at && (!input.publishesFile || declared)
    ? await absentRecordedFile(engine, sourceId, snapshot.page) : null;
  if (input.detach) {
    if (absent) return;
    throw opError('invalid_params', 'There is nothing to detach.',
      `detach applies only to restoring a soft-deleted page whose recorded canonical file is gone from the checkout of '${sourceId}' while the restore writes no file. `
        + `Page ${slug} ${!snapshot?.page.deleted_at ? 'is not soft-deleted' : input.publishesFile ? 'gets its file re-created by this restore' : 'has its file in place, or records none'}, so restore it without detach.`);
  }
  if (!absent) return;
  const command = ['gbrain', 'restore', slug, '--source-id', sourceId, '--detach'];
  throw opError('source_changed', `The page's canonical file ${absent} is no longer in the checkout of source '${sourceId}'.`,
    `Nothing was restored: a restored page whose recorded file is gone is soft-deleted again by the next gbrain sync --full. Choose one: put ${absent} back in the checkout, `
      + `commit it and run gbrain sync --source ${sourceId} (sync restores the page from its file); or restore the page database-only with ${command.join(' ')} `
      + '(restore_page with detach: true), which forgets its recorded file so sync keeps it; a file synced later at its path updates it again.',
    { detail: 'canonical_file_absent', retryable: false, docs: DOCS, fix: {
      argv: command, mcp: { tool: 'restore_page', arguments: { slug, source_id: sourceId, detach: true } },
      consent: [], actor: input.remote ? 'user' : 'agent', ask_user: true, requires_exclusive: false, docs: DOCS,
      why: 'Detaching makes the page database-only for good, while putting the file back keeps it file-backed; which one is the user\'s choice, because the file may only be missing on this host.',
      user_message: `The file of ${slug} (${absent}) is gone from the ${sourceId} checkout, so a plain restore would be undone by the next full sync. `
        + 'I can restore it as a database-only page (it forgets its file), or you can put the file back, commit it and sync. Which do you want?',
    } });
}

/** In the restore publication: a detached restore forgets the page's recorded file and stamps it database-only. */
export async function detachRestoredPage(tx: SqlEngine, row: Pick<WriteRequest, 'operation' | 'intent' | 'source_id' | 'slug'>): Promise<void> {
  if (row.operation !== 'restore_page' || row.intent?.detach !== true) return;
  await tx.executeRaw('UPDATE pages SET source_path=NULL, database_only_reason=$3 WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL',
    [row.source_id, row.slug, DETACHED_REASON]);
}

/** Live pages of a source read per scan; past it the result says `truncated`. */
export const MISSING_FILES_SCAN_LIMIT = 50_000;
let scanLimit = MISSING_FILES_SCAN_LIMIT;
/** Tests only: a smaller per-source scan limit (null restores the default). */
export function __setMissingFilesScanLimitForTests(limit: number | null): void { scanLimit = limit ?? MISSING_FILES_SCAN_LIMIT; }

export interface MissingRecordedFiles { source_id: string; pages: Array<{ slug: string; source_path: string }>; inspected: number; truncated: boolean; limit: number }

/**
 * GBRA-150: whether a recorded nested metafile is a page the way `sync --full` judges it: its file under `root`, else its
 * blob at the source's last synced commit. `toFile` maps a recorded `source_path` to its root-relative file.
 */
function recordedMetafilePage(metafilePages: MetafilePagesMode, root: string, lastCommit: string | null, toFile: (path: string) => string): (path: string) => boolean {
  let gitRoot: string | null = null;
  try { gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitChildEnv() }).trim(); } catch { /* not a checkout */ }
  const lastSynced = gitRoot ? gitMetafileHeads(gitRoot, [lastCommit]) : null;
  const rootInGit = gitRoot ? relative(gitRoot, realpathSync(root)).split('\\').join('/') : '';
  const disk = diskMetafileHeads(root);
  return metafilePagePredicate(metafilePages, firstMetafileHead(path => disk(toFile(path)),
    path => lastSynced?.read(rootInGit ? `${rootInGit}/${toFile(path)}` : toFile(path))), toFile);
}

/**
 * #6609: the live pages of a classic source (a `local_path` checkout on this
 * host, managed persistence off) whose recorded file is not in the files
 * `gbrain sync --full` enumerates (`collectSyncableFiles`), so that sync would
 * soft-delete them. Null when the source has no such checkout here.
 */
export async function scanMissingRecordedFiles(engine: BrainEngine, sourceId: string): Promise<MissingRecordedFiles | null> {
  if (await managedPersistenceEnabled(engine)) return null;
  const [source] = await engine.executeRaw<{ local_path: string | null; strategy: SyncStrategy | null; last_commit: string | null }>(
    "SELECT local_path, config->>'strategy' AS strategy, last_commit FROM sources WHERE id=$1 AND archived IS NOT TRUE", [sourceId]);
  const root = source?.local_path;
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) return null;
  const strategy = source.strategy ?? 'markdown';
  const rows = await engine.executeRaw<{ slug: string; source_path: string }>(
    `SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND NULLIF(btrim(source_path), '') IS NOT NULL
      ORDER BY id LIMIT ${scanLimit + 1}`, [sourceId]);
  const truncated = rows.length > scanLimit;
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const fileOf = (row: { slug: string; source_path: string }) => resolveSourceLocalFilePath(root, row.source_path, row.slug, mode) ?? join(root, row.source_path);
  const files = new Map(rows.map(row => [row.source_path, relative(root, fileOf(row)).split('\\').join('/')]));
  const metafilePages = await readMetafilePagesMode(engine);
  const metafilePage = recordedMetafilePage(metafilePages, root, source.last_commit, path => files.get(path) ?? path);
  const inspected = rows.slice(0, scanLimit).filter(row => isSyncable(row.source_path, { strategy, metafilePage }));
  const result: MissingRecordedFiles = { source_id: sourceId, pages: [], inspected: inspected.length, truncated, limit: scanLimit };
  if (!inspected.length) return result;
  const { collectSyncableFiles } = await import('../../commands/import.ts');
  const present = new Set(collectSyncableFiles(root, { strategy, metafilePages }).map(file => resolve(file)));
  for (const row of inspected) {
    if (!present.has(resolve(fileOf(row)))) result.pages.push({ slug: row.slug, source_path: row.source_path });
  }
  return result;
}
