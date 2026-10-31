/**
 * Sync applicability (agent-first operator wave, Lane E4).
 *
 * `gbrain init` creates a gbrain-owned content directory
 * (`<GBRAIN_HOME>/.gbrain/content/<brain_id>/<source>`, or an owned
 * `--content-root`) that is not a Git checkout. Sync imports changes between
 * Git commits, so it does not apply there: performSync refuses with
 * `sync_not_applicable` (why + the import fix) before any Git probe, instead of
 * a raw `git rev-parse` failure or the legacy anchor self-heal that would
 * `git init` the directory. gbrain never initializes Git on the user's behalf;
 * the refusal names `git init` only as something to ask the user about.
 *
 * #7630: a relative stored anchor (`sources.local_path` or `sync.repo_path`
 * such as ".") is refused `sync_anchor_relative` first, because it names
 * whatever directory gbrain runs from.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { gbrainPath, loadConfig } from './config.ts';
import { opError, type OperationError } from './ops/contract.ts';
import { readSyncAnchor } from './sync-anchor.ts';
import { contentSetupKey } from './shared-skills/setup.ts';

/** A source whose sync root is a gbrain-owned content directory with no Git checkout. */
export interface SyncContentDirectory {
  sourceId: string;
  root: string;
  keyless: boolean;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function underGbrainContent(root: string): boolean {
  const rel = relative(canonical(gbrainPath('content')), canonical(root));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function ownedByContentReceipt(engine: BrainEngine, sourceId: string, root: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source?.incarnation) return false;
  const saved = await engine.getConfig(contentSetupKey(sourceId, source.incarnation));
  if (!saved) return false;
  try {
    const receipt = JSON.parse(saved) as { owned_root?: unknown; root?: unknown };
    return receipt.owned_root === true && typeof receipt.root === 'string' && canonical(receipt.root) === canonical(root);
  } catch { return false; }
}

/**
 * The gbrain-owned, non-Git content directory this sync would run against, or
 * null when sync applies (a Git checkout, a user directory, or no root). The
 * root resolves exactly as performSync does (`repoPath`, else the source's
 * anchor). Best-effort: a probe failure means "applies", never a refusal.
 */
export async function syncContentDirectory(engine: BrainEngine, opts: { sourceId?: string; repoPath?: string }): Promise<SyncContentDirectory | null> {
  try {
    const root = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
    if (!root || !existsSync(root) || existsSync(join(root, '.git'))) return null;
    const sourceId = opts.sourceId ?? 'default';
    if (!underGbrainContent(root) && !(await ownedByContentReceipt(engine, sourceId, root))) return null;
    const keyless = loadConfig()?.embedding_disabled === true || (await engine.getConfig('embedding_disabled')) === 'true';
    return { sourceId, root, keyless };
  } catch {
    return null;
  }
}

/** The `sync_not_applicable` refusal: why, the import fix, and `git init` only after asking the user. */
export function syncNotApplicableError(dir: SyncContentDirectory): OperationError {
  return opError('sync_not_applicable',
    `Sync does not apply to source "${dir.sourceId}": ${dir.root} is a gbrain-owned content directory, not a Git checkout.`,
    `To add markdown files to this brain, import the directory that holds them. To sync this content directory from Git instead, ask the user first; if they agree, initialize Git in ${dir.root} and commit, and sync applies from then on.`,
    {
      reason: 'content_directory',
      why: 'gbrain created this directory for content it manages itself (skills, owned pages); memory lives in the database, so there are no Git commits to sync. gbrain never initializes Git on its own.',
      fix: {
        argv: ['gbrain', 'import', '<dir>', ...(dir.keyless ? ['--no-embed'] : []), '--source', dir.sourceId],
        inputs: [{ name: 'dir', how: 'The directory of markdown files the user wants in this brain (not the gbrain-owned content directory itself).' }],
        consent: [], actor: 'agent', requires_exclusive: true,
        why: `Import reads a directory of markdown files into source "${dir.sourceId}" without Git; pages and facts already in the brain are kept.`,
        verify: { argv: ['gbrain', 'sources', 'status', dir.sourceId] },
      },
    });
}

/**
 * #7630: the `sync_anchor_relative` refusal. A stored anchor (`sources.local_path` or `sync.repo_path`) that is a
 * relative path such as "." names whatever directory gbrain happens to run from, so it cannot say which folder is the
 * brain: from an unrelated folder, sync would treat that folder as the brain repo (Git init, a baseline commit of
 * everything in it, an import of its markdown). Refused before any Git probe, cost estimate or import.
 */
export function syncAnchorRelativeError(sourceId: string | undefined, anchor: string): OperationError {
  const foreign = posix.isAbsolute(anchor) || win32.isAbsolute(anchor);
  const why = foreign
    ? `The path is absolute only on another operating system (another host sharing this brain may have set it); on this host it would name a folder inside whatever directory gbrain runs from, so sync cannot use it here. Nothing was changed.`
    : `A relative path names whatever directory gbrain runs from, not a fixed folder, so it cannot prove which folder is the brain; syncing it from an unrelated folder would Git-initialize that folder, commit everything in it and import its markdown. Nothing was changed.`;
  if (!sourceId) {
    const named = foreign ? `sync.repo_path is "${anchor}", which is not an absolute path on this host` : `sync.repo_path is the relative path "${anchor}"`;
    return opError('sync_anchor_relative', `Sync refused: ${named}.`,
      'Ask the user which directory holds the brain repo, then set it as an absolute path: gbrain config set sync.repo_path <absolute-directory>.',
      { why, fix: { argv: ['gbrain', 'config', 'set', 'sync.repo_path', '<dir>'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
        inputs: [{ name: 'dir', how: 'The absolute path of the brain repo, from the user; never the current directory by default.' }],
        user_message: `gbrain's brain repo setting (${named}), so sync cannot tell which folder is the brain. Which directory holds your brain repo?`,
        why: 'Points sync.repo_path at an absolute directory; no file or page changes.', verify: { argv: ['gbrain', 'config', 'get', 'sync.repo_path'] } } });
  }
  if (foreign) {
    return opError('sync_anchor_relative', `Sync refused: source "${sourceId}" has the local_path "${anchor}", which is not an absolute path on this host.`,
      `Ask the user which directory on this host holds this source's files and run gbrain sources set-path ${sourceId} <absolute-directory>.`,
      { why, fix: { argv: ['gbrain', 'sources', 'set-path', sourceId, '<dir>'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
        inputs: [{ name: 'dir', how: "The absolute path on this host of the directory that holds this source's files, from the user; never the current directory by default." }],
        user_message: `Source "${sourceId}" has "${anchor}" as its directory, which is not an absolute path on this host, so sync refused. Which directory on this host holds its files? I'll point the source there (gbrain sources set-path ${sourceId} <absolute-directory>).`,
        why: 'Points the source at an absolute directory on this host; it only updates the pointer, no file or page changes.',
        verify: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] } } });
  }
  return opError('sync_anchor_relative', `Sync refused: source "${sourceId}" has the relative local_path "${anchor}".`,
    `Ask the user which directory holds this source's files and run gbrain sources set-path ${sourceId} <absolute-directory>, or clear the pointer with gbrain sources set-path ${sourceId} --clear.`,
    { why, fix: { argv: ['gbrain', 'sources', 'set-path', sourceId, '<dir>'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
      inputs: [{ name: 'dir', how: "The absolute path of the directory that holds this source's files, from the user; never the current directory by default." }],
      user_message: `Source "${sourceId}" has the relative path "${anchor}" as its directory, so sync cannot tell which folder it belongs to and refused. Which directory holds its files? I'll point the source there (gbrain sources set-path ${sourceId} <absolute-directory>). If it has no directory, I can clear the pointer instead (gbrain sources set-path ${sourceId} --clear).`,
      why: 'Points the source at an absolute directory; it only updates the pointer, no file or page changes. This works on a managed brain too, where --clear refuses a source with a canonical owner.',
      verify: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] } } });
}

/** #7630: refuse a sync whose root would be a relative stored anchor (an explicit absolute or different `repoPath` passes). */
export async function assertSyncAnchorAbsolute(engine: BrainEngine, opts: { sourceId?: string; repoPath?: string }): Promise<void> {
  if (opts.repoPath && isAbsolute(opts.repoPath)) return;
  const anchor = await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!anchor || isAbsolute(anchor) || (opts.repoPath && opts.repoPath !== anchor)) return;
  throw syncAnchorRelativeError(opts.sourceId, anchor);
}

/** Refuse a sync whose root is a relative stored anchor or a gbrain-owned content directory (no-op when sync applies). */
export async function assertSyncApplicable(engine: BrainEngine, opts: { sourceId?: string; repoPath?: string }): Promise<void> {
  await assertSyncAnchorAbsolute(engine, opts);
  const dir = await syncContentDirectory(engine, opts);
  if (dir) throw syncNotApplicableError(dir);
}
