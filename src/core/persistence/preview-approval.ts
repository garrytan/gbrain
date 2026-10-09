/**
 * Preview-bound approval (fix wave 5, ENG-O1), shared by every command whose
 * apply must touch exactly the set its preview showed: `gbrain jobs
 * authorize-legacy --select`, `gbrain jobs cancel --select`, `gbrain repair
 * stale-atoms` and `gbrain repair extractor-facts`.
 *
 * The flow is the same for all four:
 *
 *   1. The preview computes `previewHash(parts)` over everything the operator
 *      reviewed (brain and source identity, the listed items with their
 *      revisions or evidence, the selection options) and saves the items with
 *      `saveApprovedSet`. It prints the hash and the filled apply command.
 *   2. The apply passes the hash back (`--expect <hash>`). `loadApprovedSet`
 *      returns the saved items, or refuses with `preview_changed` when no set
 *      was saved under that hash or the set is older than the checkpoint purge
 *      window. A refused load never returns a partial set, so an apply either
 *      starts from the whole approved set or not at all.
 *   3. The apply replays the approved items (each with its own request id, so
 *      a resumed apply after a crash replays the same requests and reconciles
 *      their receipts before advancing), rechecking each item against the
 *      live state, and calls `clearApprovedSet` when it finishes.
 *
 * Sets live in `op_checkpoints` (`op='repair-approval'`, keyed by command and
 * hash), so no migration is needed. `purgeStaleCheckpoints` deletes rows older
 * than its TTL (7 days by default); `APPROVAL_MAX_AGE_DAYS` matches it, so a
 * set the purge may already have taken is never trusted.
 *
 * `previewHash` is SHA-256 over the same key-sorted JSON as
 * `authorityDigest` (`minions/submission-authority.ts`), so the existing
 * `authorizeLegacyJobs --ids` snapshot digest is byte-identical when computed
 * through this helper.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationError } from '../ops/contract.ts';
import { catalogueError } from '../error-catalogue.ts';
import { digest } from './digest.ts';

export const PREVIEW_APPROVAL_OP = 'repair-approval';

/** The default `purgeStaleCheckpoints` TTL; an older approved set may already be gone. */
export const APPROVAL_MAX_AGE_DAYS = 7;

export type PreviewApprovalCommand = 'authorize-legacy' | 'jobs-cancel' | 'stale-atoms' | 'extractor-facts' | 'conversation-labels' | 'captured-facts' | 'loop-facts' | 'ontology-facts' | 'failed-writes' | 'frontmatter' | 'fences' | 'slug-conflicts';

export interface ApprovedSetKey {
  command: PreviewApprovalCommand;
  /** The preview hash the operator passed with `--expect`. */
  hash: string;
  /** The read-only command that prints a fresh preview, filled with the caller's real flags. */
  previewCommand: string;
}

export interface ApprovedSet<T> {
  command: PreviewApprovalCommand;
  hash: string;
  items: T[];
  /** When the preview last saved this set (database clock, ISO 8601). */
  approved_at: string;
}

/** SHA-256 hex over key-sorted JSON of everything the preview showed. */
export function previewHash(parts: unknown): string {
  return digest(parts);
}

/** `preview_changed`: the hash no longer names a saved, fresh approved set. */
export function previewChangedError(hash: string, previewCommand: string): OperationError {
  return catalogueError('preview_changed', `The preview changed since ${hash}; re-run ${previewCommand} and use the new hash.`,
    `Re-run the preview: ${previewCommand}`);
}

function fingerprint(command: PreviewApprovalCommand, hash: string): string {
  return `${command}:${hash}`;
}

/** Saves (or re-confirms, restarting its age) the approved set a preview printed. */
export async function saveApprovedSet<T>(engine: BrainEngine, key: Omit<ApprovedSetKey, 'previewCommand'>, items: readonly T[]): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [PREVIEW_APPROVAL_OP, fingerprint(key.command, key.hash), JSON.stringify([{ command: key.command, hash: key.hash, items }])]);
}

/**
 * The whole approved set saved under `hash`, or `preview_changed` when it is
 * missing, malformed or older than `APPROVAL_MAX_AGE_DAYS`. Age is measured on
 * the database clock, the same clock the purge uses.
 */
export async function loadApprovedSet<T>(engine: BrainEngine, key: ApprovedSetKey): Promise<ApprovedSet<T>> {
  const [row] = await engine.executeRaw<{ completed_keys: Array<{ command?: string; hash?: string; items?: T[] }>; fresh: boolean; approved_at: string }>(
    `SELECT completed_keys, updated_at >= now() - ($3 || ' days')::interval AS fresh,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at
       FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
    [PREVIEW_APPROVAL_OP, fingerprint(key.command, key.hash), String(APPROVAL_MAX_AGE_DAYS)]);
  const saved = row?.completed_keys?.[0];
  if (!row || row.fresh !== true || saved?.command !== key.command || saved.hash !== key.hash || !Array.isArray(saved.items)) {
    throw previewChangedError(key.hash, key.previewCommand);
  }
  return { command: key.command, hash: key.hash, items: saved.items, approved_at: row.approved_at };
}

/** Drops an approved set once its apply finished. */
export async function clearApprovedSet(engine: BrainEngine, key: Omit<ApprovedSetKey, 'previewCommand'>): Promise<void> {
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [PREVIEW_APPROVAL_OP, fingerprint(key.command, key.hash)]);
}
