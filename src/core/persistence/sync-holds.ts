/**
 * #5988: Git sync holds. A file whose content gbrain refuses deterministically
 * (unreadable or ambiguous frontmatter, a frontmatter slug naming another page,
 * over-size, an operator content reject) is held instead of blocking the sync:
 * the rest of the source imports, the checkpoint advances, and the hold stays
 * visible until the file changes, is deleted, or a newer gbrain can read it.
 *
 * Storage: one `op_checkpoints` row per hold (op `sync-hold`, fingerprint
 * `source:incarnation:path`) and one small per-source summary row (op
 * `sync-hold-summary`) holding the count (and `stale`, how many name an
 * existing page), so a sync that holds 20k files writes O(1) rows per hold and
 * neither a status read nor a search loads a source-wide list. Read paths find
 * a page's hold by page id through `op_checkpoints_sync_hold_page_idx`.
 * Managed and legacy sync write the same rows; they survive writer mode
 * changes and are exempt from the 7-day checkpoint purge.
 *
 * Writes are version-conditional on `observed_at` (the run's discovery time):
 * a run never replaces or clears a hold a newer run wrote. Every write locks the
 * source's summary row first, so concurrent cursors of one source serialize.
 * Rows carry key name, line, code and a location-only message, never a raw
 * frontmatter value. #6188 `invalid_fence` holds carry the fence, section,
 * reason, parsed row numbers and the file line, never a cell value; the
 * summary also counts them (`fences`) so every surface can route a source to
 * the right repair (`holdRepairSteps`, D6): the content-repair lane
 * (`gbrain repair content`, #6377) for fence and slug-conflict holds,
 * `gbrain repair frontmatter` for the rest. A fence hold's own fix depends on
 * its state (`fence-repair/hold-fix.ts`, D17). #6377
 * `frontmatter_slug_conflict` holds carry the content-repair lane's last
 * verdict (`meta.content_repair`: action, reason code, slugs, model, when it
 * is tried again; never the model's prose), written by
 * `recordContentHoldRepair` and kept across a re-screen of the same bytes;
 * their fix is that file's `gbrain repair content --only <path>` preview and,
 * for a recommended merge or an undecidable pair, a paragraph for a person.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { ContentRefusal } from '../import-screen.ts';
import { RECOVERY_VERSION, type InvalidFrontmatterReason } from '../markdown.ts';
import { ORIGIN_TWINS_AUTO_RESOLVE_KEY, originTwinsPreviewArgv, type OriginConflictReason } from './origin-twins.ts';
import { FENCE_REASONS, type FenceMessageLocation } from '../fence-repair/reasons.ts';
import type { FenceReason, FenceTier, GateLetter } from '../fence-repair/types.ts';
import { FENCE_VERSION } from '../fence-repair/refusal.ts';
import { fenceHoldFix, fenceHoldLocation, fencePreviewArgv, readFenceAutoRepair, type FenceAutoRepair, type FenceHoldLocation } from '../fence-repair/hold-fix.ts';
import { contentHoldDocs, contentHoldFix } from '../content-repair/hold-fix.ts';
import { STRUCTURED_WRITE_ADVICE, type FencesNormalized } from '../fence-repair/report.ts';
import type { SyncDiscovery, SyncRename } from './sync-discovery.ts';
import { isCodeFilePath, isImageFilePath, isMultimodalEnabled } from '../sync.ts';
import { VERSION } from '../../version.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { chunkerStamp } from '../chunkers/code.ts';
import { gitBlobOid, sha256 } from './digest.ts';
import { HOLD_ATTEMPTS_NEEDS_HUMAN, HOLD_ESCALATE_MS } from './sync-fault-class.ts';
import { retiredSyncSetting, type RetiredSyncKeyName } from '../sync-config-keys.ts';

export const GIT_HOLD_OP = 'sync-hold';
export const GIT_HOLD_SUMMARY_OP = 'sync-hold-summary';
export const GIT_HOLD_RETRY_OP = 'sync-hold-retry';
export const SYNC_IMPORT_PROVENANCE_OP = 'sync-import-provenance';
/** One row per source incarnation: the blocked requests recent managed syncs converted in place. */
export const SYNC_CONVERSION_OP = 'sync-conversions';
/** How many conversions the log keeps per source. */
export const SYNC_CONVERSION_KEEP = 20;
/** Default for `GBRAIN_SYNC_HOLD_CAP`: how many holds a result lists in detail. Storage is never capped. */
export const GIT_HOLD_CAP = 500;
export const GIT_HOLD_ESCALATE_COUNT = 50;
export const GIT_HOLD_ESCALATE_PCT = 5;
/** The percentage rule needs at least this many screened imports. */
export const GIT_HOLD_ESCALATE_MIN_SCREENED = 40;

type Exec = Pick<BrainEngine, 'executeRaw'>;

export type GitHoldCode = ContentRefusal['code'] | 'rename_held' | 'parser_regression' | 'managed_image_sync_unsupported' | 'concurrent_write' | 'preparation_stalled' | 'worktree_dirty' | 'file_drift'
  | 'legacy_slug_conflict' | 'write_interrupted' | 'origin_conflict';
/**
 * Flip lane C: the holds of a write that ran out of attempts, its preparation never settling (`preparation_stalled`)
 * or its statements ended by the database every time (`write_interrupted`). The file is not the problem: they route to
 * writer status and a re-screen, never a file repair.
 */
export const OUT_OF_ATTEMPTS_HOLDS: ReadonlySet<string> = new Set(['preparation_stalled', 'write_interrupted']);
export const outOfAttemptsHold = (code: string | null | undefined): boolean => OUT_OF_ATTEMPTS_HOLDS.has(code ?? '');
/** #6278: what the owner recorded about a preparation it gave up on (step names and vocabulary only, never content). */
export interface PreparationStallMeta {
  request_id: string;
  /** The last step the owner stamped (`claim_phase.step`), or null when it recorded none. */
  step: string | null;
  waiting_on: 'git' | 'fs' | 'db' | 'pool' | 'unknown' | null;
  attempts: number | null;
  /** The gbrain that wrote the hold; a different version re-screens it (`holdRescreenDue`). */
  gbrain_version: string;
  /** The `gbrain sync` arguments that resume the cursor with its stored options (after `sources retry-held`). */
  sync_argv: string[];
}
export type GitHoldReason = InvalidFrontmatterReason | 'rename_source_changed' | 'explicit_id_conflict' | FenceReason | OriginConflictReason;

export interface GitHoldMeta {
  reason?: GitHoldReason;
  key?: string;
  line?: number;
  /** The frontmatter reader version that refused it; an older one is re-screened by a newer gbrain. */
  recovery_version: number;
  /** #6188 `invalid_fence`: where the fence was refused (location-only); a prepare-time hold names the receipt's reason here. */
  fence?: FenceMessageLocation;
  /** #6188: the fence screen version that held it; an older one is re-screened by a newer gbrain. */
  fence_version?: number;
  /** Git-mode holds: the pinned blob, so discovery re-checks every hold with one `ls-tree`. */
  blob_oid?: string;
  /** The held bytes came from the working tree, not the pinned commit. */
  working?: boolean;
  /** The held file is a rename destination: the page it moves when the hold clears. */
  rename_from?: SyncRename;
  /** #6194 `concurrent_write`: the database-only request that wrote the page during the import, and the revision it wrote. */
  competing_request_id?: string;
  competing_operation?: string;
  page_revision?: string;
  /** #6712 PR 1 `file_drift`: which side moved since the page's last recorded import (`unknown`: no usable record); `page_revision` is the page's revision when held. */
  sides?: 'database' | 'both' | 'unknown';
  /** #6517 `file_drift`: the page survived a shared-origin delete that kept its file; the fix leads with importing the file. */
  shared_origin?: true;
  /** #6340 `concurrent_write`: the revision the entry was frozen against (the page's live revision is `page_revision`). */
  expected_revision?: string;
  /** #6340 `worktree_dirty`: sha256 of the uncommitted working-tree bytes the hold protected (`blob_oid` is the pinned blob). */
  working_hash?: string;
  /** #6340: how many times this path was held again with the same code since the hold was first written, plus (#6712 PR 2) the hold's safe actions that ran and failed; at `HOLD_ATTEMPTS_NEEDS_HUMAN` over `HOLD_ESCALATE_MS` the page keeps moving. */
  attempts?: number;
  /** #6712 PR 2: when this path was first held with its code (attempts count from it); `held_at` resets when the held bytes change. */
  first_held_at?: string;
  /** #6712 PR 2 `worktree_dirty`: when the uncommitted bytes last changed (`working_hash` moved); a recent edit is a live editor, never escalated. */
  edited_at?: string;
  /** #6712 PR 2: when the soak sweep counted this hold as needing a person (`soak-counters.ts`); kept across re-holds with the same code, so it counts once. */
  needs_human_at?: string;
  /** #6188: the last fence repair attempt (repair kind or maintenance phase) that left this hold in place; location and reason only. */
  fence_repair?: FenceHoldRepairState;
  /** #6377 `frontmatter_slug_conflict`: the content-repair lane's last verdict or attempt on this hold; codes and slugs only. */
  content_repair?: ContentHoldRepairState;
  /** #6278 `preparation_stalled`: the failed receipt's step, wait cause and attempt count. */
  stall?: PreparationStallMeta;
  /** #6278: the held entry is a deletion (the file is gone); discovery re-screens it on request or a gbrain change, not on its absence. */
  deleted?: true;
  /**
   * #6712 dependency edge: the path of an earlier entry of the same sync, sharing this entry's slug or page id, that was
   * held in that sync; this entry waits on it with the same code, and discovery re-screens it once that hold is gone.
   */
  blocked_on?: string;
  /** #6727 `legacy_slug_conflict`: the live pages without a recorded origin whose slugs fold to the file's slug. */
  legacy_slugs?: string[];
  /** #6948 `origin_conflict`: the live pages recording the file as their origin, by id (no `reason`: the sync-time heal resolves it). */
  origin_claimants?: Array<{ id: number; slug: string; revision: string }>;
  /** #6948 `origin_conflict`: the slug the file's path gives (the page that keeps the origin). */
  canonical_slug?: string;
}

/** #6188: why the last fence repair left a hold in place, and when the maintenance run tries it again (null: it does not). */
export interface FenceHoldRepairState {
  reason: FenceReason;
  tier: FenceTier;
  at: string;
  next_attempt_after: string | null;
  gate?: GateLetter;
  rows?: number[];
}

/**
 * #6377: what the content-repair lane last decided about a `frontmatter_slug_conflict` hold. `action` is the verdict
 * (`remove_slug` recorded only when the edit could not be written; `merge_into` and `needs_human` wait for a person;
 * `pending` when no verdict was reached: the model tier was off, unavailable, unpriced or over budget). `reason` is the
 * code behind it (`merge_recommended`, `content_repair_needs_human`, `llm_unavailable`, `budget_exhausted`, ...).
 * `canonical` and `named` are slugs; `next_attempt_after` null means nothing retries it until the file changes.
 */
export interface ContentHoldRepairState {
  action: 'remove_slug' | 'merge_into' | 'needs_human' | 'pending';
  reason: string;
  /** `merge_into`: the slug that keeps the page. */
  canonical?: string;
  /** The slug the held file's `slug:` line resolved to (when a page has it). */
  named?: string;
  /** The named page's type, for the rendered paragraph. */
  type?: string;
  model?: string;
  at: string;
  next_attempt_after: string | null;
  /** #6865: the content-repair lane version that recorded this verdict (absent: before versioning); an older one is rechecked once. */
  lane_version?: number;
  /** #6865 `still_invalid`: the other frontmatter fix codes removing the slug: line alone leaves. */
  other_codes?: string[];
  /** #6865: the named page has no file (a database-only page). */
  named_db_only?: true;
}

export interface GitHoldRecord {
  version: 1;
  source_id: string;
  incarnation: string;
  /** Source-root-relative file path (the hold key). */
  path: string;
  /** The page origin the file maps to. */
  source_path: string;
  slug: string | null;
  /** The page the held file would update (stale); null when the file is new (missing). */
  page_id: number | null;
  code: GitHoldCode;
  /** Location-only: key, line and cause, never a frontmatter value. */
  message: string;
  /** sha256 of the exact content sync would import; null when the content was never read (over-size). */
  upstream_version: string | null;
  /** Discovery time of the run that wrote it; a run never replaces a hold a newer run wrote. */
  observed_at: string;
  held_at: string;
  updated_at: string;
  run_id: string | null;
  mode: 'managed' | 'legacy';
  meta: GitHoldMeta;
}

export interface GitSourceHolds { sourceId: string; incarnation: string; count: number; holds: GitHoldRecord[] }

/** One hold as every surface shows it: what, where, and the exact next command. */
export interface GitHoldItem {
  path: string;
  code: GitHoldCode;
  reason?: GitHoldReason;
  key?: string;
  line?: number;
  /** #6188 `invalid_fence` (D16): reason, fence, section, rows, columns, section line, classes, planned tier, auto_retry and next_attempt_after. */
  fence?: FenceHoldLocation;
  /** #6377 `frontmatter_slug_conflict`: the content-repair lane's last verdict or attempt (codes and slugs). */
  content_repair?: ContentHoldRepairState;
  message: string;
  slug: string | null;
  /** True when a page exists and keeps its last good revision; false when the file's page is missing. */
  stale: boolean;
  held_since: string;
  fix: Action;
  docs: string;
}

export function gitHoldFingerprint(sourceId: string, incarnation: string, path: string): string {
  return `${sourceId}:${incarnation}:${path}`;
}

const summaryFingerprint = (sourceId: string, incarnation: string) => `${sourceId}:${incarnation}`;

/** Locks the source's summary row (creating it), so hold writes of one source serialize. */
async function lockSummary(tx: Exec, sourceId: string, incarnation: string): Promise<number> {
  const [row] = await tx.executeRaw<{ count: number | string }>(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()
    RETURNING COALESCE((completed_keys->0->>'count')::int,0) AS count`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), sourceId, incarnation]);
  return Number(row?.count ?? 0);
}

/**
 * `count` is every hold; `stale` the holds of files whose page exists (the rest are missing pages);
 * `images` the #5493 unsupported-image holds, which never escalate; `fences` the #6188 `invalid_fence` holds;
 * `concurrent` the #6194 `concurrent_write` holds; `stalled` the #6278 `preparation_stalled` holds; `dirty` the #6340 `worktree_dirty` holds;
 * `drift` the #6712 `file_drift` holds, which never escalate (each is a database edit a person decides on, not a generator fault).
 */
const SUMMARY_COUNTERS = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift'] as const;
type SummaryWeights = Record<typeof SUMMARY_COUNTERS[number], number>;
async function adjustSummary(tx: Exec, sourceId: string, incarnation: string, delta: number, weights: SummaryWeights): Promise<void> {
  const pairs = SUMMARY_COUNTERS.map((name, i) => `'${name}',GREATEST(0,COALESCE((completed_keys->0->>'${name}')::int,0)+$${i + 4}::int)`).join(',');
  await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),${pairs})),updated_at=now() WHERE op=$1 AND fingerprint=$2`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), delta, ...SUMMARY_COUNTERS.map(name => weights[name])]);
}

const staleWeight = (record: Pick<GitHoldRecord, 'page_id'> | null) => record && record.page_id !== null ? 1 : 0;
const imageWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'managed_image_sync_unsupported' ? 1 : 0;
const fenceWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'invalid_fence' ? 1 : 0;
const concurrentWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'concurrent_write' ? 1 : 0;
const stalledWeight = (record: Pick<GitHoldRecord, 'code'> | null) => outOfAttemptsHold(record?.code) ? 1 : 0;
const dirtyWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'worktree_dirty' ? 1 : 0;
const driftWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'file_drift' ? 1 : 0;
const weightsOf = (record: Pick<GitHoldRecord, 'code' | 'page_id'>, sign = 1): SummaryWeights => ({ stale: sign * staleWeight(record), images: sign * imageWeight(record),
  fences: sign * fenceWeight(record), concurrent: sign * concurrentWeight(record), stalled: sign * stalledWeight(record), dirty: sign * dirtyWeight(record), drift: sign * driftWeight(record) });

async function readRow(tx: Exec, sourceId: string, incarnation: string, path: string): Promise<GitHoldRecord | null> {
  const [row] = await tx.executeRaw<{ record: GitHoldRecord }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path)]);
  return row?.record ?? null;
}

/**
 * Records or replaces a hold. Call it inside the transaction that advances the
 * run past the file. Idempotent on (path, upstream_version); returns `skipped`
 * when a newer run already wrote this path's hold.
 */
export async function writeGitHold(tx: Exec, input: Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'>): Promise<'inserted' | 'updated' | 'skipped'> {
  await lockSummary(tx, input.source_id, input.incarnation);
  const existing = await readRow(tx, input.source_id, input.incarnation, input.path);
  if (existing && existing.observed_at > input.observed_at) return 'skipped';
  const now = new Date().toISOString();
  // #6340: a path held again with the same code counts an attempt, so a page that keeps moving can be named.
  const attempts = existing && existing.code === input.code ? (existing.meta.attempts ?? 1) + 1 : 1;
  // #6188/#6377: a re-screen of the same bytes under the same code keeps the last repair verdict; a changed file drops it.
  const sameBytes = existing && existing.code === input.code && existing.upstream_version === input.upstream_version;
  const kept = sameBytes ? { ...(existing.meta.fence_repair && !input.meta.fence_repair ? { fence_repair: existing.meta.fence_repair } : {}),
    ...(existing.meta.content_repair && !input.meta.content_repair ? { content_repair: existing.meta.content_repair } : {}) } : {};
  const record: GitHoldRecord = { version: 1, ...input, meta: { ...kept, ...input.meta, attempts, ...escalationStamps(existing, input, now) },
    held_at: existing && existing.upstream_version === input.upstream_version && existing.code === input.code ? existing.held_at : now, updated_at: now };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [GIT_HOLD_OP, gitHoldFingerprint(input.source_id, input.incarnation, input.path), JSON.stringify([record])]);
  if (existing) {
    const next = weightsOf(input), prior = weightsOf(existing);
    if (SUMMARY_COUNTERS.some(name => next[name] !== prior[name])) {
      await adjustSummary(tx, input.source_id, input.incarnation, 0, Object.fromEntries(SUMMARY_COUNTERS.map(name => [name, next[name] - prior[name]])) as SummaryWeights);
    }
    return 'updated';
  }
  await adjustSummary(tx, input.source_id, input.incarnation, 1, weightsOf(input));
  return 'inserted';
}

/** #6712 PR 2: the first-held time of the code's attempt count, the soak count's stamp, and a `worktree_dirty` hold's last edit (a changed `working_hash`). */
function escalationStamps(existing: GitHoldRecord | null, input: Pick<GitHoldRecord, 'code' | 'meta'>, now: string): Pick<GitHoldMeta, 'first_held_at' | 'edited_at' | 'needs_human_at'> {
  const same = existing?.code === input.code ? existing : null;
  const kept = { first_held_at: same ? same.meta.first_held_at ?? same.held_at : now, ...(same?.meta.needs_human_at ? { needs_human_at: same.meta.needs_human_at } : {}) };
  if (input.code !== 'worktree_dirty') return kept;
  return { ...kept, edited_at: same && same.meta.working_hash === input.meta.working_hash ? same.meta.edited_at ?? same.held_at : now };
}

/**
 * #6712 PR 2 (L4): what escalation reads from a hold: its failed attempts, how long since it was first held with its code,
 * and whether a `worktree_dirty` hold's uncommitted bytes changed within `HOLD_ESCALATE_MS` (someone is still editing).
 */
export function holdEscalation(record: Pick<GitHoldRecord, 'code' | 'meta' | 'held_at'>, now = Date.now()): { attempts: number; held_for_ms: number; live_editor: boolean } {
  const since = (at: string | undefined) => Math.max(0, now - Date.parse(at ?? record.held_at));
  return { attempts: record.meta.attempts ?? 1, held_for_ms: since(record.meta.first_held_at),
    live_editor: record.code === 'worktree_dirty' && since(record.meta.edited_at) < HOLD_ESCALATE_MS };
}

/**
 * #6712 PR 2 (L4): a hold's safe action ran and the hold stands (`sync unblock --apply` found the edit still uncommitted, or
 * its repair left the file held): one more failed attempt, and for `worktree_dirty` the uncommitted bytes it saw now
 * (`workingHash`), so a changed edit restarts the live-editor clock. A no-op when the path holds another code by now.
 */
export function recordHoldAttempt(tx: Exec, input: { sourceId: string; incarnation: string; path: string; code: GitHoldCode; workingHash?: string }): Promise<boolean> {
  return rewriteHoldMeta(tx, input, existing => ({ ...edit(existing, input.workingHash), attempts: (existing.meta.attempts ?? 1) + 1 })).then(record => record !== null);
}

/** #6712 PR 2 (L4): a `worktree_dirty` hold whose uncommitted bytes changed since it last looked: a live editor (no attempt counted). */
export function noteHoldEdit(tx: Exec, input: { sourceId: string; incarnation: string; path: string; workingHash: string }): Promise<GitHoldRecord | null> {
  return rewriteHoldMeta(tx, { ...input, code: 'worktree_dirty' }, existing => existing.meta.working_hash === input.workingHash ? null : edit(existing, input.workingHash));
}

function edit(existing: GitHoldRecord, workingHash: string | undefined): Partial<GitHoldMeta> {
  return workingHash !== undefined && workingHash !== existing.meta.working_hash ? { working_hash: workingHash, edited_at: new Date().toISOString() } : {};
}

/**
 * Rewrites one hold's meta when it still holds `code`, guarded on the exact record it read: a hold another run replaced
 * or re-held meanwhile is left as that run wrote it (the update matches no row), so this never restores an obsolete record.
 */
async function rewriteHoldMeta(tx: Exec, input: { sourceId: string; incarnation: string; path: string; code: GitHoldCode }, change: (existing: GitHoldRecord) => Partial<GitHoldMeta> | null): Promise<GitHoldRecord | null> {
  const existing = await readRow(tx, input.sourceId, input.incarnation, input.path);
  if (!existing || existing.code !== input.code) return null;
  const meta = change(existing);
  if (!meta) return null;
  const now = new Date().toISOString();
  const record: GitHoldRecord = { ...existing, meta: { ...existing.meta, ...escalationStamps(existing, existing, now), ...meta }, updated_at: now };
  const rows = await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`,
  [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path), JSON.stringify([record]), JSON.stringify([existing])]);
  return rows.length ? record : null;
}

/**
 * Clears a path's hold. Call it only inside the transaction that commits the
 * file's import, deletion or no-op; `observedAt` is the discovery time of the
 * run doing it, so an older run never clears a newer hold.
 */
export async function clearGitHold(tx: Exec, input: { sourceId: string; incarnation: string; path: string; observedAt: string }): Promise<boolean> {
  const [any] = await tx.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path)]);
  if (!any) return false;
  await lockSummary(tx, input.sourceId, input.incarnation);
  const existing = await readRow(tx, input.sourceId, input.incarnation, input.path);
  if (!existing || existing.observed_at > input.observedAt) return false;
  await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path)]);
  await adjustSummary(tx, input.sourceId, input.incarnation, -1, weightsOf(existing, -1));
  return true;
}

/** #5984: which of these paths have a hold row (one indexed read), so a batched waiver run clears only those. */
export async function heldGitPaths(tx: Exec, sourceId: string, incarnation: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const byPrint = new Map(paths.map(path => [gitHoldFingerprint(sourceId, incarnation, path), path]));
  const rows = await tx.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])', [GIT_HOLD_OP, [...byPrint.keys()]]);
  return new Set(rows.map(row => byPrint.get(row.fingerprint)!));
}
/**
 * #6188: records on a fence hold why the last repair left it held (the repair kind and the maintenance phase call it),
 * without touching its observation time or counts. False when the hold is gone or is not a fence hold.
 */
export async function recordFenceHoldRepair(engine: Exec, input: { sourceId: string; incarnation: string; path: string; state: FenceHoldRepairState }): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,fence_repair}',$3::text::jsonb),updated_at=now()
    WHERE op=$1 AND fingerprint=$2 AND completed_keys->0->>'code'='invalid_fence' RETURNING 1`,
  [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path), JSON.stringify(input.state)]);
  return rows.length === 1;
}

/**
 * #6377: records on a `frontmatter_slug_conflict` hold what the content-repair lane last decided, conditional on the
 * bytes it judged (`upstreamVersion`, the hold's `upstream_version`): a hold re-written for changed bytes is left alone.
 * Observation time and counts are untouched. False when the hold is gone, holds other bytes or has another code.
 */
export async function recordContentHoldRepair(engine: Exec, input: { sourceId: string; incarnation: string; path: string; upstreamVersion: string | null; state: ContentHoldRepairState }): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,content_repair}',$3::text::jsonb),updated_at=now()
    WHERE op=$1 AND fingerprint=$2 AND completed_keys->0->>'code'='frontmatter_slug_conflict' AND completed_keys->0->>'upstream_version' IS NOT DISTINCT FROM $4 RETURNING 1`,
  [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path), JSON.stringify(input.state), input.upstreamVersion]);
  return rows.length === 1;
}

export async function readGitHold(engine: Exec, sourceId: string, incarnation: string, path: string): Promise<GitHoldRecord | null> {
  return readRow(engine, sourceId, incarnation, path);
}

/** #5493: unsupported-image holds per source's current incarnation (sources with none are absent); they never escalate. */
export async function readGitImageHoldCounts(engine: Exec, sourceIds: string[]): Promise<Map<string, number>> {
  if (!sourceIds.length) return new Map();
  const rows = await engine.executeRaw<{ source_id: string; images: number | string }>(`SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`, [GIT_HOLD_SUMMARY_OP, sourceIds]);
  return new Map(rows.map(row => [row.source_id, Number(row.images)]));
}

/** Outstanding holds of the source's current incarnation (one indexed read). */
export async function countGitHolds(engine: Exec, sourceId: string, incarnation: string): Promise<number> {
  const [row] = await engine.executeRaw<{ count: number | string }>("SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2",
    [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation)]);
  return Number(row?.count ?? 0);
}

/**
 * Git-source holds of each source's current incarnation (sources with none are
 * omitted). Connector holds are read by `readAllSourceHolds`; only `sources
 * status` and `sources retry-held` merge the two.
 */
export async function readGitSourceHolds(engine: Exec, opts: { sourceIds?: string[]; runId?: string } = {}): Promise<GitSourceHolds[]> {
  const rows = await engine.executeRaw<{ record: GitHoldRecord }>(`SELECT h.completed_keys->0 AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id,h.fingerprint`, [GIT_HOLD_OP, opts.sourceIds ?? null, opts.runId ?? null]);
  const out = new Map<string, GitSourceHolds>();
  for (const { record } of rows) {
    const entry = out.get(record.source_id) ?? { sourceId: record.source_id, incarnation: record.incarnation, count: 0, holds: [] };
    entry.holds.push(record); entry.count++;
    out.set(record.source_id, entry);
  }
  return [...out.values()];
}

/**
 * A bounded listing for status views: each listed source's outstanding count
 * (its summary row) and its first `limit` holds in path order, limited in SQL
 * so a source with 20k holds never loads them all.
 */
export async function readGitHoldListing(engine: Exec, sourceIds: string[], limit: number): Promise<GitSourceHolds[]> {
  if (!sourceIds.length) return [];
  const rows = await engine.executeRaw<{ source_id: string; incarnation: string; count: number | string; record: GitHoldRecord | null }>(`SELECT s.id AS source_id,
      s.incarnation::text AS incarnation, COALESCE((sm.completed_keys->0->>'count')::int,0) AS count, h.record
    FROM sources s
    JOIN op_checkpoints sm ON sm.op=$1 AND sm.fingerprint=s.id||':'||s.incarnation::text
    LEFT JOIN LATERAL (SELECT x.fingerprint, x.completed_keys->0 AS record FROM op_checkpoints x
      WHERE x.op=$2 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
      ORDER BY x.fingerprint LIMIT $4) h ON true
    WHERE s.id=ANY($3::text[]) AND COALESCE((sm.completed_keys->0->>'count')::int,0)>0
    ORDER BY s.id, h.fingerprint`, [GIT_HOLD_SUMMARY_OP, GIT_HOLD_OP, sourceIds, Math.max(0, Math.floor(limit))]);
  const out = new Map<string, GitSourceHolds>();
  for (const row of rows) {
    const entry = out.get(row.source_id) ?? { sourceId: row.source_id, incarnation: row.incarnation, count: Number(row.count), holds: [] };
    if (row.record) entry.holds.push(row.record);
    out.set(row.source_id, entry);
  }
  return [...out.values()];
}

/**
 * #6712: the held paths whose verdict rests on something that has since moved: a dependency-edge hold (`blocked_on`)
 * whose predecessor's hold is gone, and a deterministic `concurrent_write` hold whose page's revision moved (a
 * reconcile, an authorized delete). Discovery re-screens them like a changed file.
 */
export async function holdBasisMoved(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, holds: ReadonlyMap<string, Pick<GitHoldRecord, 'code' | 'page_id' | 'meta'>>,
  paths: readonly string[]): Promise<Set<string>> {
  const watched = paths.flatMap(path => { const hold = holds.get(path); return hold?.code === 'concurrent_write' && hold.page_id != null && hold.meta.page_revision ? [Number(hold.page_id)] : []; });
  const revisions = new Map(watched.length ? (await engine.executeRaw<{ id: number; revision: string }>('SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])',
    [sourceId, watched])).map(row => [Number(row.id), row.revision]) : []);
  return new Set(paths.filter(path => {
    const hold = holds.get(path);
    if (!hold) return false;
    if (hold.meta.blocked_on && !holds.has(hold.meta.blocked_on)) return true;
    return hold.code === 'concurrent_write' && hold.page_id != null && !!hold.meta.page_revision && revisions.get(Number(hold.page_id)) !== hold.meta.page_revision;
  }));
}

/**
 * #6188 (E23): the one re-screen predicate managed discovery and legacy sync
 * share, apart from the byte comparison each makes its own way. A hold is
 * re-screened when `sources retry-held` asked, when its verdict depends on
 * database state or the working tree (slug conflicts, over-size, renames,
 * parser regressions), or when the gbrain that wrote it read frontmatter or
 * screened fences with an older version than this one. #6278: a
 * `preparation_stalled` hold re-screens when the gbrain version changed (the
 * stall was the owner's, not the file's), and #6712 on every sync until it
 * has been held `HOLD_ATTEMPTS_NEEDS_HUMAN` times (attempts count real
 * re-holds); past that it waits for `sources retry-held`. #6529: a `managed_image_sync_unsupported` hold
 * re-screens whenever multimodal embedding is on, since managed sync then
 * imports the image instead of holding it. #6712 PR 2: a `content_rejected`, `write_gate_rejected` or
 * `purged_content` hold rests on a setting, an allow rule or a tombstone its fix lets the user change, so it
 * re-screens on every sync too. #6727: so does a `legacy_slug_conflict` hold, which rests on the legacy pages a person removes. #6948: and an
 * `origin_conflict` hold, which rests on the twin pages the heal, the repair or a person removes.
 */
export function holdRescreenDue(record: Pick<GitHoldRecord, 'code' | 'meta'>, retried: boolean): boolean {
  return retried || ['frontmatter_slug_conflict', 'file_too_large', 'rename_held', 'parser_regression', 'content_rejected', 'write_gate_rejected', 'purged_content', 'legacy_slug_conflict', 'origin_conflict'].includes(record.code)
    // #6712: a transient hold (the write owner stalled, not the file) is retried by every sync until it has been held HOLD_ATTEMPTS_NEEDS_HUMAN times.
    || (outOfAttemptsHold(record.code) && (record.meta.attempts ?? 1) < HOLD_ATTEMPTS_NEEDS_HUMAN)
    || (record.code === 'managed_image_sync_unsupported' && isMultimodalEnabled())
    || record.meta.recovery_version < RECOVERY_VERSION
    || (record.code === 'invalid_fence' && (record.meta.fence_version ?? 0) < FENCE_VERSION)
    || (outOfAttemptsHold(record.code) && record.meta.stall?.gbrain_version !== VERSION);
}

/**
 * D6: which repairs a source's holds need. Fence and slug-conflict holds route
 * to the content-repair lane's preview (#6377), #6194 concurrent-write holds
 * to the reconcile preview and a re-screen, #6278 preparation-stalled holds to
 * writer status and a re-screen (never a file repair), every other hold to the
 * frontmatter repair preview; a source with several kinds names each.
 */
export interface HoldRepairRoute { fences: number; others: number; concurrent?: number; stalled?: number; dirty?: number;
  /** #6712 `file_drift` holds: a database edit sync would have overwritten; each routes to `gbrain repair file-drift`. */
  drift?: number;
  /** #6377 `frontmatter_slug_conflict` holds, counted apart from `others` by callers that read codes (summary counts leave them in `others`). */
  slug_conflicts?: number }

/** `gbrain repair content --source <id> [--only <path>]`: the content-repair lane's read-only preview (#6377; no model call). */
export function contentRepairArgv(sourceId: string, path?: string): string[] {
  return ['gbrain', 'repair', 'content', '--source', sourceId, ...(path ? ['--only', path] : [])];
}

/** #6278: the three commands that clear a source's `preparation_stalled` holds, in order (no file repair applies). */
export function stalledHoldSteps(sourceId: string, syncArgv?: string[]): { status: string[]; retry: string[]; sync: string[] } {
  return { status: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], retry: ['gbrain', 'sources', 'retry-held', sourceId],
    sync: ['gbrain', 'sync', ...(syncArgv ?? ['--source', sourceId, '--no-pull'])] };
}

/**
 * The source-level next step every surface prints for `route` (sync results,
 * doctor, read notices, the banner, retry-held). `auto`, when the caller read
 * it, says whether the maintenance run repairs the content holds (fence and
 * slug-conflict) by itself; their preview is the content-repair lane's.
 */
export function holdRepairSteps(sourceId: string, route: HoldRepairRoute, auto?: FenceAutoRepair): { argv: string[]; commands: string[]; text: string } {
  const content = (route.fences ?? 0) + (route.slug_conflicts ?? 0);
  const fences = contentRepairArgv(sourceId);
  const frontmatter = ['gbrain', 'repair', 'frontmatter', '--source', sourceId];
  const automatic = !auto ? '' : auto.active ? 'the next maintenance run repairs the fence and slug-conflict holds it can by itself; '
    : `nothing repairs the fence and slug-conflict holds by itself (${auto.enabled ? 'no maintenance run is active' : 'fences.repair.enabled is false'}), so `;
  const fenceText = `${automatic}preview the content repairs with ${fences.join(' ')} `
    + '(read-only, no model call: it lists each held file with its planned repair or the exact edit, kind by kind, and prints the apply command with --expect <hash>[,<hash>])'
    + (auto?.active ? '' : ', then run the apply command it prints');
  const frontmatterText = `preview the frontmatter and other fixes with ${frontmatter.join(' ')} (writes nothing until a hash-bound apply)`;
  const concurrentText = `for each concurrent-write hold, preview the reconciliation with gbrain sources reconcile ${sourceId} <slug> --preview `
    + `(gbrain sources status ${sourceId} names each slug and the database write that raced the import), resolve and apply it, then run gbrain sources retry-held ${sourceId} and gbrain sync --source ${sourceId} --no-pull`;
  const stalled = stalledHoldSteps(sourceId);
  const stalledText = `the ${route.stalled ?? 0} preparation-stalled hold(s) are not file problems and need no repair: inspect the writer with ${stalled.status.join(' ')} (read-only), `
    + `fix what it names or upgrade gbrain, then run ${stalled.retry.join(' ')} and the same sync again (${stalled.sync.join(' ')} with the run's options)`;
  const unblock = ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply'];
  const dirtyText = `the ${route.dirty ?? 0} worktree-dirty hold(s) are uncommitted edits in the checkout that sync would not overwrite: commit them (gbrain sources status ${sourceId} names each file), `
    + `then run ${unblock.join(' ')}, which re-screens every held file that is now committed, and the same sync`;
  const driftText = `for each file-drift hold, preview the resolution with gbrain repair file-drift --source ${sourceId} --slug <slug> --prefer database (or --prefer file) `
    + `(gbrain sources status ${sourceId} names each slug and the database write sync did not overwrite), decide with the user, apply it with the plan hash, then run gbrain sync --source ${sourceId} --no-pull`;
  if (route.stalled && !route.others && !content && !route.concurrent && !route.dirty && !route.drift) {
    return { argv: stalled.status, commands: [stalled.status.join(' '), stalled.retry.join(' '), stalled.sync.join(' ')], text: stalledText };
  }
  if (route.dirty && !route.others && !content && !route.concurrent && !route.stalled && !route.drift) {
    return { argv: unblock, commands: [`gbrain sources status ${sourceId} --json`, unblock.join(' '), `gbrain sync --source ${sourceId} --no-pull`], text: dirtyText };
  }
  if (route.concurrent || route.stalled || route.dirty || route.drift) {
    const parts = [...(route.others ? [frontmatterText] : []), ...(content ? [fenceText] : []), ...(route.concurrent ? [concurrentText] : []), ...(route.stalled ? [stalledText] : []),
      ...(route.dirty ? [dirtyText] : []), ...(route.drift ? [driftText] : [])];
    const commands = [...(route.others ? [frontmatter.join(' ')] : []), ...(content ? [fences.join(' ')] : []),
      ...(route.stalled ? [stalled.status.join(' ')] : []), `gbrain sources status ${sourceId} --json`, ...(route.dirty ? [unblock.join(' ')] : []), `gbrain sources retry-held ${sourceId}`, `gbrain sync --source ${sourceId} --no-pull`];
    return { argv: route.others ? frontmatter : content ? fences : route.concurrent || route.drift ? ['gbrain', 'sources', 'status', sourceId, '--json'] : route.stalled ? stalled.status : unblock, commands, text: parts.join('; ') };
  }
  if (content && !route.others) return { argv: fences, commands: [fences.join(' ')], text: fenceText };
  if (content) return { argv: frontmatter, commands: [frontmatter.join(' '), fences.join(' ')], text: `${frontmatterText}; ${fenceText}` };
  return { argv: frontmatter, commands: [frontmatter.join(' ')], text: frontmatterText };
}

/**
 * The exact next step for one hold: the repair preview for frontmatter, the
 * split or exclude for size, and for a fence hold the step its state calls
 * for (`fenceHoldFix`: that file's `gbrain repair fences --only <path>`
 * preview, then the apply, the edit or the paid setting). `auto` is what the
 * caller read about the maintenance run (undefined: unknown).
 */
export function gitHoldFix(record: Pick<GitHoldRecord, 'source_id' | 'path' | 'code' | 'meta'> & Partial<Pick<GitHoldRecord, 'slug' | 'page_id'>>, auto?: FenceAutoRepair): Action {
  const source = record.source_id;
  const repair = (ambiguous: boolean, why: string): Action => ({ argv: ['gbrain', 'repair', 'frontmatter', '--source', source, ...(ambiguous ? ['--include-ambiguous'] : [])],
    consent: [], actor: 'agent', requires_exclusive: false, why,
    verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } });
  switch (record.code) {
    case 'invalid_fence':
      return fenceHoldFix(record, auto);
    case 'worktree_dirty': {
      const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
      return { argv: ['gbrain', 'sync', 'unblock', '--source', source, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/write-refusals.md#worktree_dirty',
        why: `${record.path} has uncommitted working-tree bytes that match neither the pinned commit nor the current page, so sync held it instead of overwriting the local edit; the rest of the source kept syncing. `
          + `Whoever edits that file (an agent writing to the checkout) should commit it. unblock checks whether the bytes are committed at HEAD now: if so it schedules the re-screen and prints the sync to run, `
          + `if not it refuses still_dirty and the file stays held. A later commit that changes the file re-screens the hold on its own. Do not discard or normalize the local bytes.`,
        then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `Re-imports ${record.path} once it is scheduled (unblock prints this command with the cursor's own options); a file that is still dirty stays held without blocking the rest.` },
        verify };
    }
    case 'concurrent_write': {
      const slug = record.slug ?? '<slug>';
      const by = record.meta.competing_request_id ? `${record.meta.competing_operation ?? 'a database'} request ${record.meta.competing_request_id} wrote page ${slug} straight to the database`
        : `page ${slug} changed in the database${record.meta.page_revision ? ` (revision ${record.meta.page_revision})` : ''} after the sync enumerated it`;
      // #6712 wave: a held deletion has no file left to reconcile; repair file-drift resolves a page whose file is gone from the commit.
      if (record.meta.deleted) {
        const preview = (prefer: 'database' | 'file') => ['gbrain', 'repair', 'file-drift', '--source', source, '--slug', slug, '--prefer', prefer];
        const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
        return { argv: preview('database'), consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/repair.md#deleted-canonical-files',
          why: `${record.path} was deleted in Git while ${by}, so sync held the deletion instead of removing a page that changed. This preview (writes nothing) keeps the page and recreates its file; `
            + `${preview('file').join(' ')} previews the deletion instead (soft-deletes exactly that page). Decide with the user, run the apply command the preview prints, then sync again. The rest of the source is not blocked.`,
          then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
            why: `Re-screens ${record.path} after the repair (a changed file or page revision re-screens it by itself).` },
          verify };
      }
      return { argv: ['gbrain', 'sources', 'reconcile', source, slug, '--preview'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `${record.path} changed in Git while ${by}, so the two versions diverge and neither was overwritten. `
          + `The reconcile preview shows both and writes nothing; resolve it with the user, apply it, then re-screen the file with gbrain sources retry-held ${source} and gbrain sync --source ${source} --no-pull. The rest of the source is not blocked.`,
        then: { argv: ['gbrain', 'sources', 'retry-held', source], consent: [], actor: 'agent', requires_exclusive: false,
          why: `Schedules ${record.path} for a re-screen on the next sync, after the page is reconciled.`, verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } },
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    }
    case 'file_drift': {
      const slug = record.slug ?? '<slug>';
      const by = record.meta.competing_request_id ? `${record.meta.competing_operation ?? 'a database'} request ${record.meta.competing_request_id} wrote page ${slug} straight to the database`
        : `page ${slug} changed in the database${record.meta.page_revision ? ` (revision ${record.meta.page_revision})` : ''}`;
      const preview = (prefer: 'database' | 'file') => ['gbrain', 'repair', 'file-drift', '--source', source, '--slug', slug, '--prefer', prefer];
      const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
      const held = `${by} since ${record.path} was last imported, so sync held the file instead of overwriting the database version (${record.meta.sides === 'database' ? 'the file did not change in Git'
        : record.meta.sides === 'both' ? 'the file changed too' : 'no import record says which side changed'}). `;
      const decide = 'Decide with the user which version wins, run the apply command the preview prints, then sync again. The rest of the source is not blocked.';
      // #6517: a shared-origin delete kept the file for this surviving page, and its receipt names importing the file.
      const shared = record.meta.shared_origin === true;
      return { argv: preview(shared ? 'file' : 'database'), consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/write-refusals.md#file_drift',
        why: shared ? `${held}Page ${slug} survived a shared-origin delete that kept ${record.path} for it. This preview (writes nothing) imports the file into the page, as the delete's receipt says; `
          + `${preview('database').join(' ')} previews keeping the database copy and rewriting the file instead. ${decide}`
          : `${held}This preview (writes nothing) keeps the database copy and rewrites the file; ${preview('file').join(' ')} previews importing the file instead. ${decide}`,
        then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `Re-screens ${record.path} after the repair (a changed file or page revision re-screens it by itself).` },
        verify };
    }
    case 'preparation_stalled':
    case 'write_interrupted': {
      const stall = record.meta.stall;
      const steps = stalledHoldSteps(source, stall?.sync_argv);
      const where = stall?.step ? ` at step ${stall.step}${stall.waiting_on && stall.waiting_on !== 'unknown' ? ` (waiting on ${stall.waiting_on})` : ''}` : '';
      const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
      const interrupted = record.code === 'write_interrupted';
      const kind = record.meta.deleted ? 'deletion' : 'import';
      const cause = interrupted ? `the database ended its ${kind}'s statements before they finished (a statement timeout or cancel) ${stall?.attempts ?? 'the allowed number of'} time(s)`
        : `its ${kind} could not finish preparing${where}: the write owner gave up after ${stall?.attempts ?? 'the allowed'} attempt(s)`;
      return { argv: steps.status, consent: [], actor: 'agent', requires_exclusive: false, docs: gitHoldDocs(record.code),
        why: `${record.path} is held because ${cause} (request ${stall?.request_id ?? '(unknown)'}) and the rest of the source kept syncing. The file itself is not the problem, so no `
          + `frontmatter or fence repair applies. Writer status (read-only) shows the owner process, its gbrain version${interrupted ? ', the load on its pool' : ''} and any write still stuck; fix what it names or upgrade `
          + `gbrain, then schedule the re-screen and rerun the same sync.`,
        then: { argv: steps.retry, consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `Schedules ${record.path} for a re-screen on the next sync of ${source}; nothing runs now.`,
          then: { argv: steps.sync, consent: [], actor: 'agent', requires_exclusive: false, verify,
            why: `Re-imports ${record.path} with the run's own options (a different sync command would start another cursor); a write that runs out of attempts again is held again without blocking the rest.` } },
        verify };
    }
    case 'file_too_large':
      return { argv: ['gbrain', 'config', 'get', 'sync.exclude'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `${record.path} is over the page size limit. The size limit is fixed, and every page under it syncs and is searchable. Leave the file out of the source: read the current sync.exclude list, then run gbrain config set sync.exclude '<current list>,${record.path}'; or, if it must be in the brain, split it into files under the limit and commit. The next gbrain sync --source ${source} --no-pull clears the hold.`,
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    case 'purged_content':
      return { argv: ['gbrain', 'pages', 'purges', 'list', '--source', source], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `${record.path} carries the content of a page the owner purged, so sync holds it. Delete or edit the file and commit; or, only if the purge was a mistake, clear it with gbrain pages unpurge <slug> --source ${source} on the brain host.`,
        why: 'Purged content stays out of the brain until the owner clears its tombstone; the next sync re-screens the file, so an edit (a new content hash) or a cleared tombstone imports it normally.',
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    case 'content_rejected':
      return { argv: ['gbrain', 'config', 'get', 'content_sanity'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `${record.path} was rejected by the content-sanity gate because junk_disposition is reject. Remove the matched junk from the file, or decide whether to switch junk_disposition back to quarantine.`,
        why: 'The operator chose to reject junk; changing that setting is a user decision. The next sync re-screens the file: an edit committed, or the setting switched, clears the hold.' };
    case 'write_gate_rejected':
      return { argv: ['gbrain', 'config', 'get', 'write_gate.external_mode'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `${record.path} was refused by the write gate: its source is untrusted and it reads like an instruction to an agent, and write_gate.external_mode is reject. Decide whether to edit the file or switch the setting back to quarantine.`,
        why: 'The operator chose to reject external instruction-like content; changing that setting is a user decision. The next sync re-screens the file: an edit committed, the setting switched, or an owner allow rule (gbrain trust allow) for the file clears the hold.' };
    case 'managed_image_sync_unsupported':
      return { argv: ['gbrain', 'config', 'get', 'sync.exclude'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `Multimodal embedding is off, so managed sync holds ${record.path} and the rest of source ${source} keeps syncing. Keeping images held is fine; to import them, set GBRAIN_EMBEDDING_MULTIMODAL=true for the gbrain process (image embeddings can cost money) and sync again; to stop holding them, leave images out of the source with sync.exclude.`,
        why: 'Whether images are embedded is the user\'s call (it costs provider calls). With GBRAIN_EMBEDDING_MULTIMODAL=true the next sync imports every held image; the hold also clears when the file is deleted or excluded, and is re-screened when it changes or on gbrain sources retry-held.',
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    case 'parser_regression':
      return { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `gbrain refuses ${record.path}, whose exact bytes imported under an earlier version. This is a gbrain bug: report it with the gbrain version, the file and the code, then upgrade or pin the last good version.`,
        why: 'The same bytes imported before, so only gbrain changed; sync holds the file under GBRAIN_SYNC_PARSER_REGRESSION=hold.' };
    case 'legacy_slug_conflict': {
      const slugs = record.meta.legacy_slugs ?? [];
      const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
      return { argv: verify.argv, consent: [], actor: 'user', requires_exclusive: false, docs: gitHoldDocs(record.code, record.meta.reason),
        user_message: record.meta.reason === 'explicit_id_conflict'
          ? `${record.path} folds to page ${JSON.stringify(slugs[0] ?? '')}, which an older gbrain imported without recording its file, but the file's frontmatter id differs from that page's, so it is a different document and sync held it rather than give it that page's facts, links and history. `
            + `If it is the same document, give the file the page's id; if not, rename the file to a name that folds to another slug (it imports as a new page), or remove the old page with gbrain delete --source ${source} -- '${slugs[0] ?? '<slug>'}' (recoverable for 72 h); then run gbrain sync --source ${source} --no-pull.`
          : slugs.length > 1
          ? `${record.path} belongs to one of the pages ${slugs.map(slug => JSON.stringify(slug)).join(', ')}, which an older gbrain imported without recording their file, so sync held it rather than guess or create another page. `
            + `Pick the page that is this file's and remove each other one with gbrain delete --source ${source} -- '<slug>' (recoverable for 72 h), or rename the file if none of them is its page, then run gbrain sync --source ${source} --no-pull.`
          : `${record.path} matches page ${JSON.stringify(slugs[0] ?? '')}, which an older gbrain imported without recording its file under a slug with capitals that sync cannot write and no gbrain command can address yet, so sync held the file rather than create a second page. `
            + `Keep the file held (the rest of the source syncs), or rename it to a name that folds to another slug, which imports it as a new page beside the old one (the old page keeps its links), then run gbrain sync --source ${source} --no-pull.`,
        why: 'Which page a file is cannot be decided from the slugs alone, and sync never writes a slug it would have to change. Once one writable page is left, the next sync imports the file into it (same page id, links and history) and records the file as its origin; until then the rest of the source keeps syncing.',
        then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `Re-screens ${record.path} after the other pages are removed (this hold is re-screened on every sync).` },
        verify };
    }
    case 'origin_conflict': {
      const claimants = record.meta.origin_claimants ?? [];
      const canonical = record.meta.canonical_slug ?? '<slug>';
      const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
      const then: Action = { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `Re-screens ${record.path} once one page records it (this hold is re-screened on every sync); the file then imports into that page.` };
      const named = claimants.map(page => page.slug).join(', ');
      if (!record.meta.reason) {
        return { argv: originTwinsPreviewArgv(source), consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/write-refusals.md#origin_conflict',
          why: `Pages ${named} all record ${record.path} as their origin and hold the same content, and ${canonical} is the page its path names, so the next managed sync resolves them by itself `
            + `(${ORIGIN_TWINS_AUTO_RESOLVE_KEY}, on by default): each other page's links move to ${canonical}, its slug becomes an alias of ${canonical}, and it is soft-deleted without touching the file (restorable for 72 h). `
            + `This preview writes nothing; its apply does the same now. The rest of the source is not blocked.`, then, verify };
      }
      const keep = claimants.find(page => page.slug === canonical);
      const soft = claimants.filter(page => page !== keep).map(page => `gbrain delete --source-id ${source} --expected-revision ${page.revision} -- '${page.slug}'`);
      return { argv: ['gbrain', 'get', '--source', source, '--', claimants[0]?.slug ?? canonical], consent: [], actor: 'user', requires_exclusive: false, docs: 'docs/guides/write-refusals.md#origin_conflict',
        user_message: `Pages ${named} all record ${record.path} as their origin, and sync cannot prove they are one document (${record.meta.reason}), so it held only this file; the rest of the source keeps syncing. `
          + `Read each page (gbrain get --source ${source} -- '<slug>'), pick the one that is this file's page and soft-delete each other one (the file stays, restorable for 72 h)`
          + (soft.length ? `, for example: ${soft.join('; ')}` : '') + `; then run gbrain sync --source ${source} --no-pull. gbrain repair origin-twins --source ${source} lists the group and its commands.`,
        why: 'Which page owns a file cannot be decided when the pages differ, carry different frontmatter ids, or none is the page the path names; sync never deletes a page it cannot prove is a duplicate.', then, verify };
    }
    case 'rename_held':
      return repair(true, `The page that ${record.path} renames changed after the rename was recorded, so it was not moved; the preview proposes re-binding the rename to the current page for approval.`);
    case 'frontmatter_slug_conflict':
      return contentHoldFix(record);
    default:
      return record.meta.reason === 'needs_interpretation'
        ? repair(true, `Reading ${record.path} needs an interpretation (folded lines, a duplicate key or an unclosed list); the preview shows the exact proposal for approval.`)
        : repair(false, `Previews the minimal line fix for ${record.path} (or names the line to fix by hand); nothing is written until a hash-bound apply.`);
  }
}

export function gitHoldDocs(code: GitHoldCode, reason?: GitHoldReason, meta?: Pick<GitHoldMeta, 'content_repair'>): string {
  // #6188: fence reasons carry their own anchors (`#fence-<reason>`).
  if (code === 'invalid_fence') return reason && reason in FENCE_REASONS ? FENCE_REASONS[reason as FenceReason].docs : 'docs/guides/write-refusals.md#invalid_fence';
  // #6377: a judged slug conflict points at its verdict's anchor.
  if (code === 'frontmatter_slug_conflict') return contentHoldDocs(meta?.content_repair);
  if (outOfAttemptsHold(code)) return `docs/guides/write-refusals.md#${code}`;
  if (code === 'worktree_dirty') return 'docs/guides/write-refusals.md#worktree_dirty';
  return `docs/guides/write-refusals.md#${reason ? `${code}-${reason}` : code}`;
}

/** One hold as surfaces list it; `auto` (what the caller read about the maintenance run) decides a fence hold's fix and `auto_retry`. */
export function gitHoldItem(record: GitHoldRecord, auto?: FenceAutoRepair): GitHoldItem {
  const fence = record.code === 'invalid_fence' ? fenceHoldLocation(record.meta, auto) : undefined;
  return { path: record.path, code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}),
    ...(record.meta.key ? { key: record.meta.key } : {}), ...(record.meta.line !== undefined ? { line: record.meta.line } : {}),
    ...(fence ? { fence } : {}),
    ...(record.code === 'frontmatter_slug_conflict' && record.meta.content_repair ? { content_repair: record.meta.content_repair } : {}),
    message: record.message, slug: record.slug, stale: record.page_id !== null, held_since: record.held_at,
    fix: gitHoldFix(record, auto), docs: gitHoldDocs(record.code, record.meta.reason, record.meta) };
}

/** What the maintenance run does about fence holds, read only when some of these holds are fence holds. */
export async function fenceAutoRepairFor(engine: Exec, records: ReadonlyArray<Pick<GitHoldRecord, 'code'>>): Promise<FenceAutoRepair | undefined> {
  return records.some(record => record.code === 'invalid_fence') ? readFenceAutoRepair(engine) : undefined;
}

/** A blocked sync request a run converted in place: held (the file is refused) or re-frozen (the file now imports). */
export interface SyncConversion { request_id: string; path: string | null; slug: string | null; run_id: string; outcome: 'held' | 'refrozen'; converted_at: string }

/** Appends a conversion to the source's log (newest first, bounded); call it in the transaction that saves the converted cursor. */
export async function recordSyncConversion(tx: Exec, sourceId: string, incarnation: string, conversion: Omit<SyncConversion, 'converted_at'>): Promise<void> {
  const entry = JSON.stringify([{ ...conversion, converted_at: new Date().toISOString() }]);
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'conversions',$5::text::jsonb)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object('conversions',
      (SELECT COALESCE(jsonb_agg(c ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements($5::text::jsonb||COALESCE(op_checkpoints.completed_keys->0->'conversions','[]'::jsonb))
        WITH ORDINALITY AS e(c,n) WHERE n<=$6))),updated_at=now()`,
  [SYNC_CONVERSION_OP, summaryFingerprint(sourceId, incarnation), sourceId, incarnation, entry, SYNC_CONVERSION_KEEP]);
}

/** The conversion log of each listed source's current incarnation, newest first (sources with none are absent). */
export async function readSyncConversions(engine: Exec, sourceIds: string[], limit: number): Promise<Map<string, SyncConversion[]>> {
  const out = new Map<string, SyncConversion[]>();
  if (!sourceIds.length || limit <= 0) return out;
  const rows = await engine.executeRaw<{ source_id: string; conversions: SyncConversion[] | null }>(`SELECT s.id AS source_id, c.completed_keys->0->'conversions' AS conversions
    FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text WHERE s.id=ANY($2::text[])`, [SYNC_CONVERSION_OP, sourceIds]);
  for (const row of rows) if (Array.isArray(row.conversions) && row.conversions.length) out.set(row.source_id, row.conversions.slice(0, limit));
  return out;
}

/** `sources retry-held` on a Git source: the next sync re-screens these paths even if Git did not touch them. */
export async function requestGitHoldRetry(engine: Exec, sourceId: string, incarnation: string, paths: string[]): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,'paths',$4::text::jsonb,'requested_at',now())))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,
      'paths',(SELECT COALESCE(jsonb_agg(DISTINCT p),'[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(COALESCE(op_checkpoints.completed_keys->0->'paths','[]'::jsonb)) AS p
        UNION SELECT jsonb_array_elements_text($4::text::jsonb)) paths),
      'requested_at',now())),updated_at=now()`,
  [GIT_HOLD_RETRY_OP, summaryFingerprint(sourceId, incarnation), sourceId, JSON.stringify(paths), incarnation]);
}

export async function readGitHoldRetryPaths(engine: Exec, sourceId: string, incarnation: string): Promise<string[]> {
  const [row] = await engine.executeRaw<{ completed_keys: Array<{ paths?: unknown }> }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [GIT_HOLD_RETRY_OP, summaryFingerprint(sourceId, incarnation)]);
  const paths = row?.completed_keys?.[0]?.paths;
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
}

/** Removes the paths a run took into its manifest; paths requested meanwhile stay. */
export async function clearGitHoldRetryPaths(engine: Exec, sourceId: string, incarnation: string, taken: string[]): Promise<void> {
  if (!taken.length) return;
  const fingerprint = summaryFingerprint(sourceId, incarnation);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,paths}',
      (SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM jsonb_array_elements_text(completed_keys->0->'paths') p WHERE NOT (p = ANY($3::text[])))),
      updated_at=now() WHERE op=$1 AND fingerprint=$2`, [GIT_HOLD_RETRY_OP, fingerprint, taken]);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND jsonb_array_length(completed_keys->0->'paths')=0`, [GIT_HOLD_RETRY_OP, fingerprint]);
}

/**
 * #6712 PR 2: a discovery that found nothing to write still releases the held paths that left the source (excluded by
 * sync.exclude, an image while multimodal embedding is off) and consumes the re-screens it took, inside the run's
 * freshness write. Before, those waited for the next commit, so a printed exit (exclude the file, then sync) did not
 * clear its hold.
 */
export async function releaseDiscoveredHolds(tx: Exec, discovery: Pick<SyncDiscovery, 'sourceId' | 'incarnation' | 'discoveredAt' | 'releasedHolds' | 'retryTaken'>): Promise<void> {
  const observedAt = discovery.discoveredAt ?? new Date().toISOString();
  for (const path of discovery.releasedHolds ?? []) await clearGitHold(tx, { sourceId: discovery.sourceId, incarnation: discovery.incarnation, path, observedAt });
  await clearGitHoldRetryPaths(tx, discovery.sourceId, discovery.incarnation, discovery.retryTaken ?? []);
}

export interface SyncHoldPolicy {
  /** `fail` restores fail-closed blocking: a content refusal blocks the sync as before holds existed. */
  mode: 'hold' | 'fail';
  cap: number;
  escalateCount: number;
  escalatePct: number;
  /** What a refusal of bytes that imported before does: stop the run (default) or hold it as `parser_regression`. */
  parserRegression: 'stop' | 'hold';
}

/**
 * `sync.holds` is the brain's choice (fail-closed or hold). The cap, the escalation thresholds and the
 * parser-regression stop retired as config keys in #6712 PR 2: their `GBRAIN_SYNC_*` environment variables
 * (`RETIRED_SYNC_KEYS`) tune them for the process that syncs, and a stored key is not applied.
 */
export async function readSyncHoldPolicy(engine: Pick<BrainEngine, 'getConfig'>, env: NodeJS.ProcessEnv = process.env): Promise<SyncHoldPolicy> {
  const mode = (await engine.getConfig('sync.holds').catch(() => null))?.trim().toLowerCase() || null;
  const number = (key: RetiredSyncKeyName, fallback: number) => {
    const parsed = Number(retiredSyncSetting(key, env));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return { mode: mode === 'fail' ? 'fail' : 'hold', cap: Math.floor(number('sync.hold_cap', GIT_HOLD_CAP)), escalateCount: number('sync.hold_escalate_count', GIT_HOLD_ESCALATE_COUNT),
    escalatePct: number('sync.hold_escalate_pct', GIT_HOLD_ESCALATE_PCT), parserRegression: retiredSyncSetting('sync.parser_regression', env).toLowerCase() === 'hold' ? 'hold' : 'stop' };
}

/** More holds than the source should carry, or too large a share of this run's screened imports. */
export function holdsEscalated(policy: Pick<SyncHoldPolicy, 'escalateCount' | 'escalatePct'>, outstanding: number, run: { held: number; screened: number }): boolean {
  return outstanding > policy.escalateCount
    || (run.screened >= GIT_HOLD_ESCALATE_MIN_SCREENED && run.held * 100 > policy.escalatePct * run.screened);
}

/**
 * Import provenance of a page synced from a file: the exact bytes it imported
 * and the gbrain that validated them. The parser-regression stop fires only
 * when a newer gbrain refuses bytes this record says imported validated.
 */
export interface SyncImportProvenance {
  source_id: string;
  incarnation: string;
  page_id: number;
  origin: string;
  raw_sha256: string;
  blob_oid?: string;
  /** #5459 (P4.5): true when the bytes came from the working tree (an untracked or uncommitted file), false from the pinned Git blob; absent on records written before the stamp. */
  working?: boolean;
  gbrain_version: string;
  validated: true;
  recovery?: Array<{ kind: string; key: string; line: number; recovery_version: number }>;
  recorded_at: string;
  /**
   * #6712 PR 0 (write-only until a reader lands): the bytes the publish left on disk, the canonical writeback when it
   * wrote one, else the file as admitted; null when no file was on disk. `disk_blob_oid` is their Git blob id, comparable
   * with `git ls-tree` without reading the file. Absent on records written before the stamp (PR 1 adds them to code, image and repair records).
   */
  disk_sha256?: string | null;
  disk_blob_oid?: string | null;
  /** The page revision the publish produced. Absent on older records. */
  revision?: string;
  /** What parsed the bytes: the import parser version, the Markdown chunker and the schema pack in effect (null for none). Absent on older records. */
  parser?: SyncImportParser;
}

/**
 * The version of the Markdown import's reading of a file: the frontmatter recovery rules and the fence screen, plus a
 * leading import counter to bump when the import's own parsing or canonical form changes. It deliberately leaves out the
 * release, so a parser fingerprint holds across releases that change no parsing.
 */
export const SYNC_IMPORT_PARSER_VERSION = `import=1;frontmatter=${RECOVERY_VERSION};fence=${FENCE_VERSION}`;

/** The provenance a preparation knows before its page is written; page id, revision and disk bytes come from the publication or the waiver that settles it. */
export type SyncImportProvenanceBase = Omit<SyncImportProvenance, 'page_id' | 'revision' | 'disk_sha256' | 'disk_blob_oid' | 'recorded_at' | 'validated'>;

export interface SyncImportParser { parser_version: string; markdown_chunker: number; schema_pack: string | null }

/** The disk half of an import provenance record for `bytes` (null: no file on disk), in the object format of `target`'s commit id. */
export function syncDiskProvenance(bytes: Uint8Array | null, target: string | null): Pick<SyncImportProvenance, 'disk_sha256' | 'disk_blob_oid'> {
  if (!bytes) return { disk_sha256: null, disk_blob_oid: null };
  return { disk_sha256: sha256(bytes), disk_blob_oid: gitBlobOid(bytes, target?.length === 64 ? 'sha256' : 'sha1') };
}

export function syncImportParser(schemaPack: string | null): SyncImportParser {
  return { parser_version: SYNC_IMPORT_PARSER_VERSION, markdown_chunker: MARKDOWN_CHUNKER_VERSION, schema_pack: schemaPack };
}

/**
 * #6712 PR 1: the parser fingerprint an import of `path` records and the discovery prescreen expects: a code page names
 * the code chunker and its grammars (`chunkerStamp`), an image the image importer, a Markdown page `syncImportParser`.
 */
export function syncImportParserFor(path: string, schemaPack: string | null): SyncImportParser {
  if (isImageFilePath(path)) return { parser_version: 'image=1', markdown_chunker: MARKDOWN_CHUNKER_VERSION, schema_pack: null };
  if (isCodeFilePath(path)) return { parser_version: `code=1;chunker=${chunkerStamp()}`, markdown_chunker: MARKDOWN_CHUNKER_VERSION, schema_pack: null };
  return syncImportParser(schemaPack);
}

const provenanceFingerprint = (sourceId: string, incarnation: string, pageId: number) => `${sourceId}:${incarnation}:${pageId}`;

export async function recordSyncImportProvenance(tx: Exec, value: Omit<SyncImportProvenance, 'recorded_at' | 'validated'>): Promise<void> {
  const record: SyncImportProvenance = { ...value, validated: true, recorded_at: new Date().toISOString() };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [SYNC_IMPORT_PROVENANCE_OP, provenanceFingerprint(value.source_id, value.incarnation, value.page_id), JSON.stringify([record])]);
}

/** Several pages' provenance in one statement (a waiver run); the last value for a page wins. */
export async function recordSyncImportProvenances(tx: Exec, values: ReadonlyArray<Omit<SyncImportProvenance, 'recorded_at' | 'validated'>>): Promise<void> {
  if (!values.length) return;
  const recorded_at = new Date().toISOString();
  const rows = new Map(values.map(value => [provenanceFingerprint(value.source_id, value.incarnation, value.page_id), { ...value, validated: true, recorded_at }]));
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1, entry->>'fingerprint', jsonb_build_array(entry->'record') FROM jsonb_array_elements($2::text::jsonb) AS entry
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [SYNC_IMPORT_PROVENANCE_OP, JSON.stringify([...rows].map(([fingerprint, record]) => ({ fingerprint, record })))]);
}

/** The provenance of several pages in one statement, keyed by page id; pages without a record are absent. */
export async function readSyncImportProvenances(engine: Exec, sourceId: string, incarnation: string, pageIds: readonly number[]): Promise<Map<number, SyncImportProvenance>> {
  if (!pageIds.length) return new Map();
  const rows = await engine.executeRaw<{ record: SyncImportProvenance }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[])',
    [SYNC_IMPORT_PROVENANCE_OP, pageIds.map(id => provenanceFingerprint(sourceId, incarnation, id))]);
  return new Map(rows.map(row => [Number(row.record.page_id), row.record]));
}

export async function readSyncImportProvenance(engine: Exec, sourceId: string, incarnation: string, pageId: number): Promise<SyncImportProvenance | null> {
  const [row] = await engine.executeRaw<{ record: SyncImportProvenance }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_IMPORT_PROVENANCE_OP, provenanceFingerprint(sourceId, incarnation, pageId)]);
  return row?.record ?? null;
}

export interface RecoveredFrontmatter {
  count: number;
  /** Up to 5 imported files; their common directory names the generator to fix. */
  sample_paths: string[];
  common_prefix: string;
  /** `title: #...`-style values YAML reads as a comment; imported, but repair can rescue them. */
  comment_values?: number;
  fix?: Action;
}

/** The common directory of the paths ('' when they share none). */
export function commonPathPrefix(paths: string[]): string {
  if (!paths.length) return '';
  const split = paths.map(path => path.split('/').slice(0, -1));
  const first = split[0];
  let length = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i++;
    length = i;
  }
  return first.slice(0, length).join('/');
}

/** Folds a run's recovered-frontmatter paths into the cursor's running total. */
export function addRecovered(previous: { count: number; sample_paths: string[]; comment_values?: number } | undefined,
  add: { paths?: string[]; commentValues?: number }): { count: number; sample_paths: string[]; comment_values?: number } {
  const paths = add.paths ?? [];
  const comment = (previous?.comment_values ?? 0) + (add.commentValues ?? 0);
  return { count: (previous?.count ?? 0) + paths.length, sample_paths: [...(previous?.sample_paths ?? []), ...paths].slice(0, 5),
    ...(comment ? { comment_values: comment } : {}) };
}

export function recoveredReport(sourceId: string, recovered: { count: number; sample_paths: string[]; comment_values?: number } | undefined): RecoveredFrontmatter | undefined {
  if (!recovered || (!recovered.count && !recovered.comment_values)) return undefined;
  const prefix = commonPathPrefix(recovered.sample_paths);
  return { ...recovered, common_prefix: prefix, fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${recovered.count} file(s)${prefix ? ` under ${prefix}/` : ''} imported only after quoting unquoted frontmatter values: whatever writes them emits YAML other tools refuse. Fix the generator to quote values (or write through put_page); the preview shows the on-disk quoting fix.` } };
}

/** #6188: the cursor's running total of files whose fences Tier 1 rewrote (classes and top directories only). */
export interface FencesTally { count: number; by_class: Record<string, number>; sample_paths: string[]; dirs: Record<string, number> }

/** Folds one normalized file into the cursor's running total. */
export function addFencesNormalized(previous: FencesTally | undefined, path: string, fixes: ReadonlyArray<{ class: string }>): FencesTally {
  const byClass = { ...(previous?.by_class ?? {}) };
  for (const fix of fixes) byClass[fix.class] = (byClass[fix.class] ?? 0) + 1;
  const dir = path.includes('/') ? `${path.split('/')[0]}/` : './';
  return { count: (previous?.count ?? 0) + 1, by_class: byClass, sample_paths: [...(previous?.sample_paths ?? []), path].slice(0, 5),
    dirs: { ...(previous?.dirs ?? {}), [dir]: (previous?.dirs?.[dir] ?? 0) + 1 } };
}

/**
 * The sync result's `fences_normalized` (D12): files rewritten and committed,
 * fixes per class, writers by top directory (a file has no receipt principal),
 * and for trusted local callers sample paths and their common directory.
 */
export function fencesNormalizedReport(sourceId: string, tally: FencesTally | undefined, remote: boolean): FencesNormalized | undefined {
  if (!tally?.count) return undefined;
  const prefix = commonPathPrefix(tally.sample_paths);
  const writers = Object.entries(tally.dirs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([writer, count]) => ({ writer, count }));
  return { count: tally.count, by_class: tally.by_class as FencesNormalized['by_class'], writers,
    ...(remote ? {} : { sample_paths: tally.sample_paths, common_prefix: prefix }),
    fix: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `${tally.count} file(s)${!remote && prefix ? ` under ${prefix}/` : ''} had a malformed facts or takes fence that sync rewrote losslessly and committed (claims and existing row numbers unchanged); whatever writes them emits fences gbrain has to repair. ${STRUCTURED_WRITE_ADVICE} Re-read a normalized page before editing it.` } };
}

/**
 * The hold fields of a sync result: this run's holds (detail capped), the
 * source's outstanding total, escalation, and the exact inspect and repair
 * commands. Remote callers get the counts and a relay instruction only.
 */
export async function buildHoldReport(engine: Exec, input: { sourceId: string; incarnation: string; runId: string; remote: boolean;
  policy: SyncHoldPolicy; screened: number; pendingScreen?: boolean }): Promise<Pick<import('../../commands/sync.ts').SyncResult,
  'held' | 'held_count' | 'holds_outstanding' | 'holds_escalated' | 'holds_truncated' | 'holds_pending_screen' | 'holds_fix'>> {
  const [summary] = await engine.executeRaw<{ count: number | string; images: number | string; fences: number | string; stalled: number | string; concurrent: number | string; dirty: number | string; drift: number | string }>(`SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'drift')::int,0) AS drift,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences, COALESCE((completed_keys->0->>'stalled')::int,0) AS stalled,
      COALESCE((completed_keys->0->>'concurrent')::int,0) AS concurrent, COALESCE((completed_keys->0->>'dirty')::int,0) AS dirty
    FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(input.sourceId, input.incarnation)]);
  const outstanding = Number(summary?.count ?? 0);
  const runHolds = (await readGitSourceHolds(engine, { sourceIds: [input.sourceId], runId: input.runId }))[0]?.holds ?? [];
  if (!outstanding && !runHolds.length) return {};
  const escalated = holdsEscalated(input.policy, outstanding - Number(summary?.images ?? 0) - Number(summary?.drift ?? 0),
    { held: runHolds.filter(hold => !imageWeight(hold) && !driftWeight(hold)).length, screened: input.screened });
  const fences = Math.max(Number(summary?.fences ?? 0), runHolds.filter(hold => fenceWeight(hold)).length);
  const stalled = Math.max(Number(summary?.stalled ?? 0), runHolds.filter(hold => stalledWeight(hold)).length);
  const concurrent = Math.max(Number(summary?.concurrent ?? 0), runHolds.filter(hold => concurrentWeight(hold)).length);
  const dirty = Math.max(Number(summary?.dirty ?? 0), runHolds.filter(hold => dirtyWeight(hold)).length);
  const drift = Math.max(Number(summary?.drift ?? 0), runHolds.filter(hold => driftWeight(hold)).length);
  // #6377: this run's slug-conflict holds route to the content lane; earlier runs' stay in `others` (the summary does not count them).
  const slugConflicts = runHolds.filter(hold => hold.code === 'frontmatter_slug_conflict').length;
  const auto = fences ? await readFenceAutoRepair(engine) : undefined;
  const steps = holdRepairSteps(input.sourceId, { fences, others: Math.max(0, outstanding - fences - stalled - concurrent - dirty - drift - slugConflicts), ...(stalled ? { stalled } : {}),
    ...(concurrent ? { concurrent } : {}), ...(dirty ? { dirty } : {}), ...(drift ? { drift } : {}), ...(slugConflicts ? { slug_conflicts: slugConflicts } : {}) }, auto);
  // #6278: the escalation text is routed by code: stalled holds point at the writer, not at a generator.
  const runStalled = runHolds.filter(hold => stalledWeight(hold)).length;
  const escalation = runStalled * 2 > runHolds.length
    ? ' Escalated: more files are held than a source should carry, and most of them stalled while preparing, so the write owner (not the files) is the likely cause; inspect it with writer status before the backlog grows.'
    : ' Escalated: more files are held than a source should carry, so a generator or a gbrain upgrade is likely writing or reading them wrong; fix the cause before the backlog grows.';
  const verify = { argv: ['gbrain', 'sources', 'status', input.sourceId, '--json'] };
  if (input.remote) return { held_count: runHolds.length, holds_fix: { argv: steps.argv, consent: [], actor: 'host_admin', requires_exclusive: false, verify,
    why: `${outstanding} file(s) in source ${input.sourceId} are held and not imported; only the brain host can inspect and repair them.`,
    user_message: `Some files in source ${input.sourceId} could not be imported. Please run 'gbrain sources status ${input.sourceId}' on the brain host, then: ${steps.text}.` } };
  const fix: Action = { argv: steps.argv, consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `${runHolds.length} file(s) held this run, ${outstanding} held in source ${input.sourceId}; they do not block sync. Inspect them with 'gbrain sources status ${input.sourceId}'; `
      + (fences || stalled || concurrent || dirty || drift || slugConflicts ? `then ${steps.text}.` : 'the repair preview proposes each fix and writes nothing.')
      + (escalated ? escalation : '') };
  return { held: runHolds.slice(0, input.policy.cap).map(hold => gitHoldItem(hold, auto)), held_count: runHolds.length, holds_outstanding: outstanding,
    ...(escalated ? { holds_escalated: true } : {}), ...(runHolds.length > input.policy.cap ? { holds_truncated: true } : {}),
    ...(input.pendingScreen ? { holds_pending_screen: true } : {}), holds_fix: fix };
}

/** The hold fields as the sync JSON envelopes carry them (snake_case already). */
export function syncHoldJsonFields(result: object): Record<string, unknown> {
  const fields = result as Record<string, unknown>;
  return Object.fromEntries(['held', 'held_count', 'holds_outstanding', 'holds_escalated', 'holds_truncated', 'holds_pending_screen', 'holds_fix',
    'converted_from_failed', 'recovered_frontmatter', 'fences_normalized', 'fence_issues', 'dry_run', 'would_hold', 'would_hold_count', 'would_normalize', 'would_normalize_count', 'screen_skipped', 'breaker', 'slug_lines_removed']
    .filter(key => fields[key] !== undefined).map(key => [key, fields[key]]));
}
