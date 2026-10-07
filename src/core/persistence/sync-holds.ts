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
 * the right repair (`holdRepairSteps`, D6): `gbrain repair fences` for fence
 * holds, `gbrain repair frontmatter` for the rest. A fence hold's own fix
 * depends on its state (`fence-repair/hold-fix.ts`, D17).
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { ContentRefusal } from '../import-screen.ts';
import { RECOVERY_VERSION, type InvalidFrontmatterReason } from '../markdown.ts';
import { FENCE_REASONS, type FenceMessageLocation } from '../fence-repair/reasons.ts';
import type { FenceReason, FenceTier, GateLetter } from '../fence-repair/types.ts';
import { FENCE_VERSION } from '../fence-repair/refusal.ts';
import { fenceHoldFix, fenceHoldLocation, fencePreviewArgv, readFenceAutoRepair, type FenceAutoRepair, type FenceHoldLocation } from '../fence-repair/hold-fix.ts';
import { STRUCTURED_WRITE_ADVICE, type FencesNormalized } from '../fence-repair/report.ts';
import type { SyncRename } from './sync-discovery.ts';

export const GIT_HOLD_OP = 'sync-hold';
export const GIT_HOLD_SUMMARY_OP = 'sync-hold-summary';
export const GIT_HOLD_RETRY_OP = 'sync-hold-retry';
export const SYNC_IMPORT_PROVENANCE_OP = 'sync-import-provenance';
/** One row per source incarnation: the blocked requests recent managed syncs converted in place. */
export const SYNC_CONVERSION_OP = 'sync-conversions';
/** How many conversions the log keeps per source. */
export const SYNC_CONVERSION_KEEP = 20;
/** Default for `sync.hold_cap`: how many holds a result lists in detail. Storage is never capped. */
export const GIT_HOLD_CAP = 500;
export const GIT_HOLD_ESCALATE_COUNT = 50;
export const GIT_HOLD_ESCALATE_PCT = 5;
/** The percentage rule needs at least this many screened imports. */
export const GIT_HOLD_ESCALATE_MIN_SCREENED = 40;

type Exec = Pick<BrainEngine, 'executeRaw'>;

export type GitHoldCode = ContentRefusal['code'] | 'rename_held' | 'parser_regression' | 'managed_image_sync_unsupported' | 'concurrent_write';
export type GitHoldReason = InvalidFrontmatterReason | 'rename_source_changed' | FenceReason;

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
  /** #6188: the last fence repair attempt (repair kind or maintenance phase) that left this hold in place; location and reason only. */
  fence_repair?: FenceHoldRepairState;
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
 * `concurrent` the #6194 `concurrent_write` holds.
 */
async function adjustSummary(tx: Exec, sourceId: string, incarnation: string, delta: number, staleDelta: number, imageDelta: number, fenceDelta: number,
  concurrentDelta: number): Promise<void> {
  await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),
      'stale',GREATEST(0,COALESCE((completed_keys->0->>'stale')::int,0)+$4::int),
      'images',GREATEST(0,COALESCE((completed_keys->0->>'images')::int,0)+$5::int),
      'fences',GREATEST(0,COALESCE((completed_keys->0->>'fences')::int,0)+$6::int),
      'concurrent',GREATEST(0,COALESCE((completed_keys->0->>'concurrent')::int,0)+$7::int))),updated_at=now() WHERE op=$1 AND fingerprint=$2`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), delta, staleDelta, imageDelta, fenceDelta, concurrentDelta]);
}

const staleWeight = (record: Pick<GitHoldRecord, 'page_id'> | null) => record && record.page_id !== null ? 1 : 0;
const imageWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'managed_image_sync_unsupported' ? 1 : 0;
const fenceWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'invalid_fence' ? 1 : 0;
const concurrentWeight = (record: Pick<GitHoldRecord, 'code'> | null) => record?.code === 'concurrent_write' ? 1 : 0;

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
  const record: GitHoldRecord = { version: 1, ...input,
    held_at: existing && existing.upstream_version === input.upstream_version && existing.code === input.code ? existing.held_at : now, updated_at: now };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [GIT_HOLD_OP, gitHoldFingerprint(input.source_id, input.incarnation, input.path), JSON.stringify([record])]);
  if (existing) {
    if (staleWeight(input) !== staleWeight(existing) || imageWeight(input) !== imageWeight(existing) || fenceWeight(input) !== fenceWeight(existing)
      || concurrentWeight(input) !== concurrentWeight(existing)) {
      await adjustSummary(tx, input.source_id, input.incarnation, 0, staleWeight(input) - staleWeight(existing), imageWeight(input) - imageWeight(existing),
        fenceWeight(input) - fenceWeight(existing), concurrentWeight(input) - concurrentWeight(existing));
    }
    return 'updated';
  }
  await adjustSummary(tx, input.source_id, input.incarnation, 1, staleWeight(input), imageWeight(input), fenceWeight(input), concurrentWeight(input));
  return 'inserted';
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
  await adjustSummary(tx, input.sourceId, input.incarnation, -1, -staleWeight(existing), -imageWeight(existing), -fenceWeight(existing), -concurrentWeight(existing));
  return true;
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
 * #6188 (E23): the one re-screen predicate managed discovery and legacy sync
 * share, apart from the byte comparison each makes its own way. A hold is
 * re-screened when `sources retry-held` asked, when its verdict depends on
 * database state or the working tree (slug conflicts, over-size, renames,
 * parser regressions), or when the gbrain that wrote it read frontmatter or
 * screened fences with an older version than this one.
 */
export function holdRescreenDue(record: Pick<GitHoldRecord, 'code' | 'meta'>, retried: boolean): boolean {
  return retried || ['frontmatter_slug_conflict', 'file_too_large', 'rename_held', 'parser_regression'].includes(record.code)
    || record.meta.recovery_version < RECOVERY_VERSION
    || (record.code === 'invalid_fence' && (record.meta.fence_version ?? 0) < FENCE_VERSION);
}

/**
 * D6: which repairs a source's holds need. Fence holds route to the fence
 * repair preview, #6194 concurrent-write holds to the reconcile preview and a
 * re-screen, every other hold to the frontmatter repair preview; a source with
 * several kinds names each.
 */
export interface HoldRepairRoute { fences: number; others: number; concurrent?: number }

/**
 * The source-level next step every surface prints for `route` (sync results,
 * doctor, read notices, the banner, retry-held). `auto`, when the caller read
 * it, says whether the maintenance run repairs fence holds by itself.
 */
export function holdRepairSteps(sourceId: string, route: HoldRepairRoute, auto?: FenceAutoRepair): { argv: string[]; commands: string[]; text: string } {
  const fences = fencePreviewArgv(sourceId);
  const frontmatter = ['gbrain', 'repair', 'frontmatter', '--source', sourceId];
  const automatic = !auto ? '' : auto.active ? 'the next maintenance run repairs the fence holds it can by itself; '
    : `nothing repairs the fence holds by itself (${auto.enabled ? 'no maintenance run is active' : 'fences.repair.enabled is false'}), so `;
  const fenceText = `${automatic}preview the fence repairs with ${fences.join(' ')} `
    + '(read-only, no model call: it lists each held file with its planned repair or the exact edit, and prints the apply command with --expect <hash>)'
    + (auto?.active ? '' : ', then run the apply command it prints');
  const frontmatterText = `preview the frontmatter and other fixes with ${frontmatter.join(' ')} (writes nothing until a hash-bound apply)`;
  const concurrentText = `for each concurrent-write hold, preview the reconciliation with gbrain sources reconcile ${sourceId} <slug> --preview `
    + `(gbrain sources status ${sourceId} names each slug and the database write that raced the import), resolve and apply it, then run gbrain sources retry-held ${sourceId} and gbrain sync --source ${sourceId} --no-pull`;
  if (route.concurrent) {
    const parts = [...(route.others ? [frontmatterText] : []), ...(route.fences ? [fenceText] : []), concurrentText];
    const commands = [...(route.others ? [frontmatter.join(' ')] : []), ...(route.fences ? [fences.join(' ')] : []),
      `gbrain sources status ${sourceId} --json`, `gbrain sources retry-held ${sourceId}`, `gbrain sync --source ${sourceId} --no-pull`];
    return { argv: route.others ? frontmatter : route.fences ? fences : ['gbrain', 'sources', 'status', sourceId, '--json'], commands, text: parts.join('; ') };
  }
  if (route.fences && !route.others) return { argv: fences, commands: [fences.join(' ')], text: fenceText };
  if (route.fences) return { argv: frontmatter, commands: [frontmatter.join(' '), fences.join(' ')], text: `${frontmatterText}; ${fenceText}` };
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
    case 'concurrent_write': {
      const slug = record.slug ?? '<slug>';
      return { argv: ['gbrain', 'sources', 'reconcile', source, slug, '--preview'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `${record.path} changed in Git while ${record.meta.competing_operation ?? 'a database'} request ${record.meta.competing_request_id ?? '(unknown)'} wrote page ${slug} straight to the database, so the two versions diverge and neither was overwritten. `
          + `The reconcile preview shows both and writes nothing; resolve it with the user, apply it, then re-screen the file with gbrain sources retry-held ${source} and gbrain sync --source ${source} --no-pull. The rest of the source is not blocked.`,
        then: { argv: ['gbrain', 'sources', 'retry-held', source], consent: [], actor: 'agent', requires_exclusive: false,
          why: `Schedules ${record.path} for a re-screen on the next sync, after the page is reconciled.`, verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } },
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    }
    case 'file_too_large':
      return { argv: ['gbrain', 'config', 'get', 'sync.exclude'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `The size limit is fixed. Split ${record.path} into smaller files and commit, or leave it out of the source: read the current sync.exclude list, then run gbrain config set sync.exclude '<current list>,${record.path}'. The next gbrain sync --source ${source} --no-pull clears the hold.`,
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    case 'content_rejected':
      return { argv: ['gbrain', 'config', 'get', 'content_sanity'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `${record.path} was rejected by the content-sanity gate because junk_disposition is reject. Remove the matched junk from the file, or decide whether to switch junk_disposition back to quarantine.`,
        why: 'The operator chose to reject junk; changing that setting is a user decision. Editing the file and committing clears the hold on the next sync.' };
    case 'managed_image_sync_unsupported':
      return { argv: ['gbrain', 'config', 'get', 'sync.exclude'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `Managed sync does not import images yet, so ${record.path} is held and the rest of source ${source} keeps syncing. Keeping images held is fine; to stop holding them, leave images out of the source with sync.exclude or turn off multimodal embedding.`,
        why: 'Whether images stay in the source is the user\'s call. The hold clears when the file is deleted or excluded, and a held image is re-screened when it changes or on gbrain sources retry-held.',
        verify: { argv: ['gbrain', 'sources', 'status', source, '--json'] } };
    case 'parser_regression':
      return { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'user', requires_exclusive: false,
        user_message: `gbrain refuses ${record.path}, whose exact bytes imported under an earlier version. This is a gbrain bug: report it with the gbrain version, the file and the code, then upgrade or pin the last good version.`,
        why: 'The same bytes imported before, so only gbrain changed; sync holds the file under sync.parser_regression=hold.' };
    case 'rename_held':
      return repair(true, `The page that ${record.path} renames changed after the rename was recorded, so it was not moved; the preview proposes re-binding the rename to the current page for approval.`);
    case 'frontmatter_slug_conflict':
      return repair(true, `The frontmatter slug of ${record.path} names another page; the preview proposes removing that line for approval.`);
    default:
      return record.meta.reason === 'needs_interpretation'
        ? repair(true, `Reading ${record.path} needs an interpretation (folded lines, a duplicate key or an unclosed list); the preview shows the exact proposal for approval.`)
        : repair(false, `Previews the minimal line fix for ${record.path} (or names the line to fix by hand); nothing is written until a hash-bound apply.`);
  }
}

export function gitHoldDocs(code: GitHoldCode, reason?: GitHoldReason): string {
  // #6188: fence reasons carry their own anchors (`#fence-<reason>`).
  if (code === 'invalid_fence') return reason && reason in FENCE_REASONS ? FENCE_REASONS[reason as FenceReason].docs : 'docs/guides/write-refusals.md#invalid_fence';
  return `docs/guides/write-refusals.md#${reason ? `${code}-${reason}` : code}`;
}

/** One hold as surfaces list it; `auto` (what the caller read about the maintenance run) decides a fence hold's fix and `auto_retry`. */
export function gitHoldItem(record: GitHoldRecord, auto?: FenceAutoRepair): GitHoldItem {
  const fence = record.code === 'invalid_fence' ? fenceHoldLocation(record.meta, auto) : undefined;
  return { path: record.path, code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}),
    ...(record.meta.key ? { key: record.meta.key } : {}), ...(record.meta.line !== undefined ? { line: record.meta.line } : {}),
    ...(fence ? { fence } : {}),
    message: record.message, slug: record.slug, stale: record.page_id !== null, held_since: record.held_at,
    fix: gitHoldFix(record, auto), docs: gitHoldDocs(record.code, record.meta.reason) };
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

export interface SyncHoldPolicy {
  /** `fail` restores fail-closed blocking: a content refusal blocks the sync as before holds existed. */
  mode: 'hold' | 'fail';
  cap: number;
  escalateCount: number;
  escalatePct: number;
  /** What a refusal of bytes that imported before does: stop the run (default) or hold it as `parser_regression`. */
  parserRegression: 'stop' | 'hold';
}

export async function readSyncHoldPolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<SyncHoldPolicy> {
  const read = async (key: string) => (await engine.getConfig(key).catch(() => null))?.trim().toLowerCase() || null;
  const number = (value: string | null, fallback: number) => {
    const parsed = value === null ? NaN : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  // Sequential: five point reads, without widening the caller's connection pool.
  const values: Array<string | null> = [];
  for (const key of ['sync.holds', 'sync.hold_cap', 'sync.hold_escalate_count', 'sync.hold_escalate_pct', 'sync.parser_regression']) values.push(await read(key));
  const [mode, cap, count, pct, regression] = values;
  return { mode: mode === 'fail' ? 'fail' : 'hold', cap: Math.floor(number(cap, GIT_HOLD_CAP)), escalateCount: number(count, GIT_HOLD_ESCALATE_COUNT),
    escalatePct: number(pct, GIT_HOLD_ESCALATE_PCT), parserRegression: regression === 'hold' ? 'hold' : 'stop' };
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
  gbrain_version: string;
  validated: true;
  recovery?: Array<{ kind: string; key: string; line: number; recovery_version: number }>;
  recorded_at: string;
}

const provenanceFingerprint = (sourceId: string, incarnation: string, pageId: number) => `${sourceId}:${incarnation}:${pageId}`;

export async function recordSyncImportProvenance(tx: Exec, value: Omit<SyncImportProvenance, 'recorded_at' | 'validated'>): Promise<void> {
  const record: SyncImportProvenance = { ...value, validated: true, recorded_at: new Date().toISOString() };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [SYNC_IMPORT_PROVENANCE_OP, provenanceFingerprint(value.source_id, value.incarnation, value.page_id), JSON.stringify([record])]);
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
  const [summary] = await engine.executeRaw<{ count: number | string; images: number | string; fences: number | string }>(`SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(input.sourceId, input.incarnation)]);
  const outstanding = Number(summary?.count ?? 0);
  const runHolds = (await readGitSourceHolds(engine, { sourceIds: [input.sourceId], runId: input.runId }))[0]?.holds ?? [];
  if (!outstanding && !runHolds.length) return {};
  const escalated = holdsEscalated(input.policy, outstanding - Number(summary?.images ?? 0),
    { held: runHolds.filter(hold => !imageWeight(hold)).length, screened: input.screened });
  const fences = Math.max(Number(summary?.fences ?? 0), runHolds.filter(hold => fenceWeight(hold)).length);
  const auto = fences ? await readFenceAutoRepair(engine) : undefined;
  const steps = holdRepairSteps(input.sourceId, { fences, others: Math.max(0, outstanding - fences) }, auto);
  const verify = { argv: ['gbrain', 'sources', 'status', input.sourceId, '--json'] };
  if (input.remote) return { held_count: runHolds.length, holds_fix: { argv: steps.argv, consent: [], actor: 'host_admin', requires_exclusive: false, verify,
    why: `${outstanding} file(s) in source ${input.sourceId} are held and not imported; only the brain host can inspect and repair them.`,
    user_message: `Some files in source ${input.sourceId} could not be imported. Please run 'gbrain sources status ${input.sourceId}' on the brain host, then: ${steps.text}.` } };
  const fix: Action = { argv: steps.argv, consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `${runHolds.length} file(s) held this run, ${outstanding} held in source ${input.sourceId}; they do not block sync. Inspect them with 'gbrain sources status ${input.sourceId}'; `
      + (fences ? `then ${steps.text}.` : 'the repair preview proposes each fix and writes nothing.')
      + (escalated ? ' Escalated: more files are held than a source should carry, so a generator or a gbrain upgrade is likely writing or reading them wrong; fix the cause before the backlog grows.' : '') };
  return { held: runHolds.slice(0, input.policy.cap).map(hold => gitHoldItem(hold, auto)), held_count: runHolds.length, holds_outstanding: outstanding,
    ...(escalated ? { holds_escalated: true } : {}), ...(runHolds.length > input.policy.cap ? { holds_truncated: true } : {}),
    ...(input.pendingScreen ? { holds_pending_screen: true } : {}), holds_fix: fix };
}

/** The hold fields as the sync JSON envelopes carry them (snake_case already). */
export function syncHoldJsonFields(result: object): Record<string, unknown> {
  const fields = result as Record<string, unknown>;
  return Object.fromEntries(['held', 'held_count', 'holds_outstanding', 'holds_escalated', 'holds_truncated', 'holds_pending_screen', 'holds_fix',
    'converted_from_failed', 'recovered_frontmatter', 'fences_normalized', 'fence_issues', 'dry_run', 'would_hold', 'would_hold_count', 'would_normalize', 'would_normalize_count', 'screen_skipped']
    .filter(key => fields[key] !== undefined).map(key => [key, fields[key]]));
}
