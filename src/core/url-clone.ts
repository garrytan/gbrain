/**
 * gbrain-owned `gbrain sources add --url` clones (#6946, GBRA-130 C-2).
 *
 * gbrain pulls an owned clone with `git pull --ff-only` on every sync, so a
 * local modification in its checkout blocks every pull that touches the same
 * file, forever. On an unmanaged brain gbrain therefore writes nothing into an
 * owned clone's checkout: `urlCloneReadOnly` is the one predicate the fence
 * writer, the page and timeline write-throughs, unfenced-fact fencing and the
 * page publication (through `sourceMirrorReadOnly`) consult, and each keeps the
 * write database-only, the way `mirror_read_only` does for a managed source.
 * A managed brain decides this through `gbrain sources mirror-readonly`.
 *
 * A clone an older release already dirtied gets a typed exit:
 * `urlClonePullBlock` names the files with local changes as
 * `pull_blocked_local_changes`, whose fix asks the user before
 * `gbrain repair url-clone-fences` (repair/url-clone-fences.ts) moves the fence
 * rows gbrain appended database-only and restores those files from HEAD.
 */
import { resolve } from 'node:path';
import { gbrainPath } from './config.ts';
import { execFileSync } from './spawn.ts';
import { gitChildEnv } from './git-env.ts';
import type { Action } from './agent-output.ts';
import { agentBlock } from './agent-markers.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import type { SqlEngine } from './persistence/model.ts';

/** Default clone dir for a remote-URL source: $GBRAIN_HOME/clones/<id>/ */
export function defaultCloneDir(id: string): string {
  return gbrainPath('clones', id);
}

/**
 * Did gbrain CREATE this clone (so re-clone/delete is safe)? Ownership, NOT
 * path-containment — a user-supplied working tree is NEVER owned, even if it
 * happens to sit under $GBRAIN_HOME. This is the #1881 guard: recloneIfMissing
 * deletes local_path, so it must only ever fire on a clone gbrain owns.
 *
 * Ownership is proven by either:
 *   1. config.managed_clone === true — written by addSource's --url path
 *      (covers both default-location and --clone-dir clones), OR
 *   2. local_path === defaultCloneDir(id) — back-compat for clones created
 *      before the marker existed (gbrain's default location), via exact
 *      normalized-path equality (symlink-free, so none of isPathContained's
 *      symlinked-parent / lexical-escape edge cases apply).
 *
 * Everything else is fail-closed (NOT owned → refuse to touch): the bug's
 * federated row (remote_url + a user tree), and pre-marker --clone-dir clones
 * (rare, local-only) which are byte-for-byte indistinguishable from it. Those
 * must be re-added to regain auto-reclone — the correct trade-off when ownership
 * is unprovable.
 */
export function isOwnedClone(src: {
  id: string;
  local_path: string | null;
  config: unknown;
}): boolean {
  if (!src.local_path) return false;
  const cfg =
    typeof src.config === 'string'
      ? (JSON.parse(src.config) as Record<string, unknown>)
      : ((src.config ?? {}) as Record<string, unknown>);
  if (cfg.managed_clone === true) return true;
  return resolve(src.local_path) === resolve(defaultCloneDir(src.id));
}

/** The source row `urlCloneReadOnly` reads; callers that already hold it pass it in. */
export interface CloneSourceRow { local_path: string | null; config: unknown }

/** An unmanaged brain's owned clone: gbrain writes nothing into its checkout. */
export async function urlCloneReadOnly(engine: SqlEngine, sourceId: string, row?: CloneSourceRow): Promise<boolean> {
  const source = row ?? (await engine.executeRaw<CloneSourceRow>('SELECT local_path, config FROM sources WHERE id = $1', [sourceId]))[0];
  if (!source || !isOwnedClone({ id: sourceId, ...source })) return false;
  return !await managedPersistenceEnabled(engine);
}

/** `gbrain repair url-clone-fences --source <id>`, the read-only preview. */
export function urlCloneRepairPreviewArgv(sourceId: string): string[] {
  return ['gbrain', 'repair', 'url-clone-fences', '--source', sourceId];
}

export interface UrlClonePullBlock {
  code: 'pull_blocked_local_changes';
  source_id: string;
  /** Tracked files of the checkout that differ from HEAD (root-relative). */
  paths: string[];
  message: string;
  fix: Action;
}

/** Tracked files of `root` whose index or working copy differs from HEAD. */
export function trackedChanges(root: string): string[] {
  const out = execFileSync('git', ['-C', root, 'diff', '--name-only', '-z', 'HEAD', '--'], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
  return out.split('\0').filter(Boolean).sort();
}

/**
 * Why an owned clone's pull cannot fast-forward, when the reason is local
 * changes in its checkout: null for a clean checkout, a source that is not an
 * unmanaged brain's owned clone, or a checkout git cannot read.
 */
export async function urlClonePullBlock(engine: SqlEngine, sourceId: string): Promise<UrlClonePullBlock | null> {
  const [row] = await engine.executeRaw<CloneSourceRow>('SELECT local_path, config FROM sources WHERE id = $1', [sourceId]);
  if (!row?.local_path || !await urlCloneReadOnly(engine, sourceId, row)) return null;
  let paths: string[];
  try { paths = trackedChanges(row.local_path); } catch { return null; }
  if (!paths.length) return null;
  const preview = urlCloneRepairPreviewArgv(sourceId);
  const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', …' : '');
  return {
    code: 'pull_blocked_local_changes',
    source_id: sourceId,
    paths,
    message: `Source "${sourceId}" is a gbrain-owned clone (sources add --url) and its checkout has local changes in ${paths.length} file(s) (${shown}), `
      + 'so git pull --ff-only cannot fast-forward it and every sync stops at the pull. Older gbrain releases appended ## Facts fence rows to clone files; '
      + 'current releases keep facts about a clone database-only.',
    fix: {
      ask_user: true,
      argv: preview,
      preview_argv: preview,
      consent: ['destructive'],
      actor: 'agent',
      requires_exclusive: false,
      why: 'The preview lists each changed file and proves whether its difference from HEAD is only fence rows gbrain appended; '
        + 'the apply (with the preview hash and the user\'s consent) backs each proven file up, keeps its fact rows database-only and restores it from HEAD.',
      user_message: `gbrain left local changes in ${paths.length} file(s) of the "${sourceId}" clone, so it stopped pulling upstream. `
        + 'Preview a repair that keeps those facts in the database and restores the files from the last pulled commit?',
      verify: { argv: [...preview, '--json'] },
      docs: 'docs/guides/repair.md#url-clone-fences',
    },
  };
}

/** The cycle's sync-phase summary for a pull an owned clone's local changes blocked. */
export function urlClonePullBlockSummary(block: UrlClonePullBlock): string {
  return `git pull blocked (${block.code}): ${block.paths.length} file(s) of the clone have local changes; ask the user, then preview ${block.fix.argv!.join(' ')}`;
}

/** The stderr lines sync prints for a pull an owned clone's local changes blocked. */
export function formatUrlClonePullBlock(block: UrlClonePullBlock): string {
  const preview = block.fix.argv!.join(' ');
  return `[gbrain] ${block.code}: ${block.message}\n` + agentBlock({
    ask: block.fix.user_message,
    why: block.fix.why,
    risk: 'Each restored file is backed up under ~/.gbrain/backups/url-clone-fences/ first; a file with any other local edit is listed and left untouched.',
    consent: 'destructive',
    actor: 'user',
    next: 'ask_user',
    if_yes: `Run ${preview}, then the apply command it prints (--apply --expect <hash> --yes), then gbrain sync --source ${block.source_id}.`,
    if_no: 'Every sync of this source keeps stopping at the pull; its pages stay at the last pulled commit.',
    verify: block.fix.verify!.argv!.join(' '),
  });
}
