/**
 * #6694: the slug-root mode a managed-sync checkpoint publishes under, against the mode the source pins
 * (`sources.config.slug_root_mode`).
 *
 * A source whose root is its repository root (empty scope) gets the same slugs and origins in both modes, so its
 * checkpoint accepts either pin and keeps the one the source has. At a subdirectory the modes give different slugs:
 * a pin that differs from the run's mode is refused as `slug_root_mode_mismatch`, never as a concurrent-writer
 * `revision_conflict`. A checkpoint refused for its slug mode (or, from older releases, as `revision_conflict` with
 * the moved-checkpoint message) is revived by the next plain sync once the source's state admits it.
 */
import { realpathSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';

type SlugRootMode = 'git-root' | 'source-root';

/** The message of the checkpoint guard's refusal when `last_commit` moved; older releases also used it for a slug-mode pin. */
export const CHECKPOINT_MOVED_MESSAGE = 'The source checkpoint changed during this sync.';

/** Whether the source root is the repository root, where both slug-root modes produce identical slugs. */
export function emptySyncScope(root: string, gitRoot: string): boolean {
  return realpathSync.native(root) === realpathSync.native(gitRoot);
}

/** The source's pinned mode when it differs from `slugMode` (null when unpinned, equal, or the source row is gone). */
export async function pinnedSlugModeMismatch(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, incarnation: string, slugMode: SlugRootMode): Promise<string | null> {
  const [row] = await engine.executeRaw<{ mode: string | null }>("SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id=$1 AND incarnation=$2::uuid", [sourceId, incarnation]);
  return row?.mode != null && row.mode !== slugMode ? row.mode : null;
}

/** The refusal's cause and the decision it leaves to a person (the receipt appends the inspect command). */
export function slugModeMismatchCause(sourceId: string, pinned: string, slugMode: SlugRootMode): string {
  return `Source ${sourceId} pins slug_root_mode=${pinned}, but this sync ran under ${slugMode}; at a subdirectory the two modes give different slugs, so the checkpoint did not advance. `
    + `A person decides which mode the source keeps: set sources.config.slug_root_mode back to ${slugMode} and rerun gbrain sync --no-pull --source ${sourceId}, `
    + `or keep ${pinned}: preview gbrain repair managed-sync-orphans --source ${sourceId} (it lists this run's cursor as slug_mode_refused), apply it with the hash it prints, then rerun gbrain sync --no-pull --source ${sourceId}, which discovers the source again under ${pinned} (pages this run wrote keep their ${slugMode} slugs beside the new ones).`;
}

/**
 * #6834: whether a checkpoint was refused because `last_commit` moved, and it now stands at exactly this run's target:
 * another run of the source (an older gbrain's cursor under another key, or an older binary) checkpointed the same
 * commit. The run's pages all committed and the source is where the checkpoint would put it, so a fresh checkpoint marked
 * overtaken (#5522) finishes the cursor. A checkpoint moved anywhere else stays refused; `gbrain repair
 * managed-sync-orphans` retires that cursor (`checkpoint_moved`).
 */
export async function checkpointMovedToTarget(engine: Pick<BrainEngine, 'executeRaw'>, cursor: { sourceId: string; incarnation: string },
  intent: { from: string | null; target: string; slice?: { done?: boolean } },
  done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'recovery'>): Promise<boolean> {
  if (done.recovery || !['failed', 'conflict'].includes(done.state) || done.error_code !== 'revision_conflict' || done.error_message !== CHECKPOINT_MOVED_MESSAGE) return false;
  if (intent.slice && !intent.slice.done) return false;
  const [row] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1 AND incarnation=$2::uuid', [cursor.sourceId, cursor.incarnation]);
  return !!row && row.last_commit === intent.target && row.last_commit !== intent.from;
}

/**
 * Why a refused checkpoint can be revived: `'overtaken'` when `last_commit` moved to exactly the run's target
 * (`checkpointMovedToTarget`; the fresh checkpoint is marked overtaken), `'slug_mode'` when the source now admits its slug
 * mode (`slugModeCheckpointRevivable`), false when it still blocks.
 */
export async function checkpointRevival(engine: Pick<BrainEngine, 'executeRaw'>,
  cursor: { sourceId: string; incarnation: string; root: string; gitRoot: string },
  intent: { slugMode: SlugRootMode; from: string | null; target: string; slice?: { done?: boolean } },
  done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'recovery'>): Promise<'overtaken' | 'slug_mode' | false> {
  if (await checkpointMovedToTarget(engine, cursor, intent, done)) return 'overtaken';
  return await slugModeCheckpointRevivable(engine, cursor, intent, done) ? 'slug_mode' : false;
}

/**
 * Whether a failed checkpoint was refused for its slug mode and the source now admits it: its `last_commit` is still
 * where the run started, and the pin is unset, equal to the run's mode, or the scope is empty. A legacy
 * `revision_conflict` carrying the moved-checkpoint message qualifies under the same proof; any other refusal does not.
 */
export async function slugModeCheckpointRevivable(engine: Pick<BrainEngine, 'executeRaw'>,
  cursor: { sourceId: string; incarnation: string; root: string; gitRoot: string },
  intent: { slugMode: SlugRootMode; from: string | null },
  done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'recovery'>): Promise<boolean> {
  if (done.recovery || !['failed', 'conflict'].includes(done.state)) return false;
  if (done.error_code !== 'slug_root_mode_mismatch' && !(done.error_code === 'revision_conflict' && done.error_message === CHECKPOINT_MOVED_MESSAGE)) return false;
  const [row] = await engine.executeRaw<{ mode: string | null; last_commit: string | null }>(
    "SELECT config->>'slug_root_mode' AS mode, last_commit FROM sources WHERE id=$1 AND incarnation=$2::uuid", [cursor.sourceId, cursor.incarnation]);
  if (!row || (row.last_commit ?? null) !== (intent.from ?? null)) return false;
  return row.mode == null || row.mode === intent.slugMode || emptySyncScope(cursor.root, cursor.gitRoot);
}
