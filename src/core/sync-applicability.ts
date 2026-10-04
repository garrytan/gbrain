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
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

/** Refuse a sync whose root is a gbrain-owned content directory (no-op when sync applies). */
export async function assertSyncApplicable(engine: BrainEngine, opts: { sourceId?: string; repoPath?: string }): Promise<void> {
  const dir = await syncContentDirectory(engine, opts);
  if (dir) throw syncNotApplicableError(dir);
}
