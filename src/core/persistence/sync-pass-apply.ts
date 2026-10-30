/**
 * #6712 PR 4b (design v3.2 §2.3 rows 6, 9, 13, 15, 17-19; §2.5; §2.6; §2.7; §3.1; §4): what a live pass does with a classified
 * round besides admitting imports and deletes (sync-pass-run.ts). `applyPassRound` runs once per round, after the level is
 * read and before the round's candidates are partitioned, and settles in place the paths it finishes:
 *
 * - **Marker retirement** (§2.5, full rounds): a deletion marker is retired by compare-and-delete when its origin is
 *   independently absent from the pinned `T` and from disk, whatever the mode, or a live page claims the origin again. An
 *   untracked copy in committed mode keeps it, and a working-mode `L = absent` alone retires nothing.
 * - **The mass-delete valve** (§2.6): the round's deletes go through #2828's `planReconcileDeletes`. A trip writes one
 *   `sync-deletes-withheld` record (refreshed each pass) and settles those deletes `withheld`; imports and the stamp
 *   proceed and no per-page hold is written. A cleared trip deletes the record. Only `GBRAIN_ALLOW_MASS_RECONCILE=1` in the
 *   owner host's environment applies the deletes; a remote caller never does.
 * - **Holds** (rows 6, 9; §3.1 settle mismatch; #6948): a path several live pages record as their origin is an
 *   `origin_conflict` hold of that path alone, with the shared verdict (origin-twins.ts) the sync-time heal acts on;
 *   `delete_drift` is a `file_drift` hold with side `deleted`, state
 *   `file_gone`; `deleted_edited` one with state `tombstone_edited` or `purged_differs` (purged holds carry the slug the
 *   marker names); a path that settled in three consecutive passes at one level without classifying settled is a
 *   `settle_mismatch` hold (`needs_human`). Each is written at level `L` under the drain lease, so it is `held` (row 1)
 *   and the rest of the source stamps. Row 11's unsettled `dirty` and row 19's `drift` are held by the batch freeze
 *   (sync-run.ts: the publication screen's `worktree_dirty`, the `sameContentAtOrigin` no-op or `file_drift`).
 * - **Adoption** (row 13): one fenced, batched record write `{blob_oid, disk_blob_oid, revision}` per round, keeping
 *   `r.parser`; arm 1 adopts by revision alone on `fileSame` with no record revision.
 * - **The legacy sweep** (§2.7): `legacy_unverified` pages run the read-only `sameContentAtOrigin` screen (every page in
 *   the incarnation's first full round, then at most `PASS_LEGACY_SWEEP_MAX` per pass); an equal page gets a record
 *   `{blob_oid, disk_blob_oid, revision, parser: fp}` and is `matched`, so a later edit imports with no Decision.
 * - **keep_db** (rows 15, 18; §4): a clean committed keep_db path is frozen to the bytes of `T[p]` and admitted as a
 *   DB-wins reconcile of the pass (keep-db-policy.ts) under the drain lease, at most `PASS_KEEP_DB_MAX` per pass; the
 *   rest are `keep_db_pending` (settled, owned by sync, taken first next pass). An admitted path is `in_flight` until its
 *   Git effect writes, then row 11 settles it `published` and row 13 adopts it after the commit. A refused one is row 19.
 *
 * A remote caller (`remote: true`) writes nothing here: no hold, marker, record, withheld record or keep_db write.
 */
import { VERSION } from '../../version.ts';
import type { BrainEngine } from '../engine.ts';
import { resolveSlugForPath } from '../sync.ts';
import { massReconcileAllowed, planReconcileDeletes, readSyncDeleteCaps, syncDeleteTrip } from '../sync-reconcile.ts';
import { filterYielding, loopYield } from './sync-yield.ts';
import { admitKeepDbReconcile, driftSkippedSlugs, freezeKeepDbReconcile, releaseMatchedDriftSkips } from '../repair/keep-db-policy.ts';

const KEEP_DB_CAPACITY_REFUSALS = new Set(['capacity', 'write_capacity_backpressure', 'queue_capacity', 'write_quota_exhausted', 'writer_busy', 'writer_pool_capacity']);
import type { SyncProcessingOptions } from './sync-authority.ts';
import type { SyncClassified } from './sync-classify.ts';
import { readOnlySameContentScreen, type ConvergenceScreen } from './sync-convergence.ts';
import type { ManagedSyncContext } from './sync-discovery.ts';
import { sha256 } from './digest.ts';
import { readBlobs } from './sync-git-stream.ts';
import { faultPoint } from './fault-points.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { readSyncImportProvenances, recordSyncImportProvenances, syncImportParserFor, writeGitHold,
  type GitHoldCode, type GitHoldMeta, type SyncImportProvenance } from './sync-holds.ts';
import { assertDrainLease, inFencedSlices } from './sync-lease.ts';
import { clearDeletesWithheld, deleteSetHash, readDeletesWithheld, readOriginDeletedMarker, retireOriginDeletedMarker, writeDeletesWithheld, type DeletesWithheld } from './sync-markers.ts';
import { isCompactMatched, type ShadowLevel, type ShadowPath } from './sync-pass.ts';
import { SETTLE_MISMATCH_STREAK, type ManagedSyncPassValue, type PassRoundSummary } from './sync-pass-row.ts';
import { syncClassAction, type SyncClassAction } from './sync-classify.ts';
import type { SyncAdmission } from './sync-admission.ts';
import type { Action } from '../agent-output.ts';
import { slugUnderBoundPrefixes } from '../ops/context.ts';
import { syncOriginPath } from './sync-origin.ts';
import { decideOriginTwins, readOriginClaimants, slugPathOccupied, type OriginConflict } from './origin-twins.ts';
import { originConflictHold } from './sync-screen.ts';
import { readSyncFile } from './sync-discovery.ts';
import { frontmatterIdentity } from '../sync-rename-identity.ts';
import { applyHeldDeletions, newHeldDeletionState, type HeldDeletionState } from './sync-held-deletions.ts';

/** Legacy pages the sweep screens per pass after the incarnation's first full round (design §2.7, [estimated]). */
export const PASS_LEGACY_SWEEP_MAX = 500;
/** GBRA-108: legacy pages one sweep slice screens and records before the next is screened. */
export const LEGACY_SWEEP_SLICE = 100;
/** keep_db DB-wins writes a pass admits (design §4, [estimated]). */
export const PASS_KEEP_DB_MAX = 200;
/** The bootstrap Decision gate (design §2.7, [estimated]): file_drift Decisions per 10,000 pages. */
export const BOOTSTRAP_DECISIONS_PER_10K = 5;
const LEVEL_BLOB_MAX_BYTES = 8 * 1024 * 1024;

/** What a pass applied across its rounds (kept in memory; its counts go into the pass row's telemetry). */
export interface PassApplyState {
  markersRetired: number;
  holds: { file_gone: number; tombstone_edited: number; purged_differs: number; settle_mismatch: number; origin_conflict: number; page_identity_changed: number; uncommitted: number };
  settleMismatch: string[];
  adopted: number;
  /** `paths`: what this pass screened, so a later round of the pass never screens a page again (#7189). */
  swept: { screened: number; recorded: number; paths: Set<string> };
  /** The first full round of the incarnation swept every legacy page (the pass records it in `obligations.legacy_sweep`). */
  sweptAll: boolean;
  withheld: DeletesWithheld | null;
  /** Deletes the valve withheld in the newest round. */
  withheldCount: number;
  keepDb: { admitted: number; pending: number; paused: number; refused: Record<string, number> };
  /** keep_db paths admitted in this pass: never admitted twice. */
  keepDbTaken: string[];
  /** #6948: paths this pass held `origin_conflict` (GBRA-130: or `page_identity_changed`; re-screen due, so a later round reads them again): held once per pass. */
  originHeld: Set<string>;
  matchedSlugs: Set<string>;
  /** The newest round's classes and summary (design §9), after this module settled what it finished. */
  classes: Record<string, { count: number; action: SyncClassAction }>;
  summary: PassRoundSummary | null;
  /**
   * The pages whose import record the newest round wrote: here, or in its batches (an import, or a waiver of an unchanged
   * page). The next round's confirm proof attributes those records to the pass.
   */
  recorded: Set<number>;
  /** GBRA-133: the held committed deletions `sync.apply_held_deletions` screened this pass (sync-held-deletions.ts). */
  heldDeletions: HeldDeletionState;
}

export function newPassApplyState(): PassApplyState {
  return { markersRetired: 0, holds: { file_gone: 0, tombstone_edited: 0, purged_differs: 0, settle_mismatch: 0, origin_conflict: 0, page_identity_changed: 0, uncommitted: 0 }, settleMismatch: [], adopted: 0,
    swept: { screened: 0, recorded: 0, paths: new Set() }, sweptAll: false, withheld: null, withheldCount: 0, keepDb: { admitted: 0, pending: 0, paused: 0, refused: {} }, keepDbTaken: [], originHeld: new Set(), matchedSlugs: new Set(), classes: {}, summary: null, recorded: new Set(), heldDeletions: newHeldDeletionState() };
}

export interface PassApplyInput {
  passId: string;
  observedAt: string;
  remote: boolean;
  admission: SyncAdmission;
  /** The round reads every path (a full pass); marker retirement runs only then. */
  fullRound: boolean;
  /** The pass row's obligations as pinned (`mismatch`, `legacy_sweep`). */
  obligations: ManagedSyncPassValue['obligations'];
  context: ManagedSyncContext;
  processingOptions: SyncProcessingOptions;
  /** A remote caller's slug-prefix grant (null: source-wide): paths outside it are left unsettled and never counted (design §5). */
  grantPrefixes?: readonly string[] | null;
  /** Test seam: the read-only same-content screen (default `readOnlySameContentScreen`). */
  screen?: ConvergenceScreen;
  /** GBRA-108: after each committed legacy-sweep slice (the pass saves its row and reports progress). */
  onSwept?: () => Promise<void>;
  /** GBRA-133: `sync.apply_held_deletions` is on for the source (read once per pass, sync-held-deletions.ts). */
  heldDeletions?: boolean;
}

/** The source-relative path (`SyncEntry.path`, the hold key) and the recorded origin of a level path. */
export function passEntryPaths(level: Pick<ShadowLevel, 'scope' | 'slugMode'>, gitPath: string): { path: string; sourcePath: string } {
  const path = level.scope ? gitPath.slice(level.scope.length + 1) : gitPath;
  return { path, sourcePath: level.slugMode === 'source-root' && level.scope ? path : gitPath };
}

const settleAs = (entry: ShadowPath, patch: Partial<SyncClassified>) => { entry.result = { ...entry.result, inFlight: false, ...patch }; };

/** The hold meta that pins a hold to the path's level `L` in its own domain (sync-pass.ts `holdAtLevel`). */
function levelMeta(level: ShadowLevel, entry: ShadowPath): Partial<GitHoldMeta> {
  if (entry.state.level === null) return { deleted: true };
  if (level.mode === 'working') return { working: true, ...(entry.state.levelSha256 ? { working_hash: entry.state.levelSha256 } : {}) };
  return { blob_oid: entry.state.level };
}

/** Runs the round's settle-side work (module header) and settles the paths it finished in `level.paths`. */
export async function applyPassRound(engine: BrainEngine, level: ShadowLevel, input: PassApplyInput, state: PassApplyState): Promise<void> {
  state.recorded.clear();
  if (input.fullRound && !input.remote) await retireMarkers(engine, level, state);
  if (input.remote && input.grantPrefixes) {
    const step = loopYield();
    for (const entry of level.paths) {
      if (step.due()) await step.pause();
      if (!grantSees(level, entry, input.grantPrefixes) && !entry.result.settled) settleAs(entry, { settled: true, action: 'none', classAction: 'none' });
    }
  }
  if (input.heldDeletions && !input.remote && input.admission === 'normal') await applyHeldDeletions(engine, level, input.context, state.heldDeletions);
  await applyDeleteValve(engine, level, input, state);
  if (input.remote) {
    // #6948: a remote pass writes no hold, so a path several live pages claim is left as it is for the owner's pass to hold.
    // GBRA-130: so is a path several tombstones record, and a spelling twin (A-17, B-3).
    for (const entry of level.paths) if ((entry.ambiguousOrigin || entry.result.cls === 'spelling') && !entry.result.settled && !entry.result.inFlight) settleAs(entry, { settled: true, action: 'none', classAction: 'repair' });
    summarizeRound(level, state);
    return;
  }
  await writePassHolds(engine, level, input, state);
  await adoptRecords(engine, level, state);
  // #7338: a round with imports or deletes sweeps after its batches drain (the pass calls sweepLegacy), so the bounded
  // sweep never delays the round's changes becoming visible.
  if (!roundHasWork(level)) await sweepLegacy(engine, level, input, state);
  await admitKeepDb(engine, level, input, state);
  // Only a matched page the concept side skipped for drift has a skip to release: a 600k level keeps no set of every slug.
  const skipped = await driftSkippedSlugs(engine, level.sourceId);
  const step = loopYield();
  for (const entry of skipped.size ? level.paths : []) {
    if (step.due()) await step.pause();
    if (entry.result.cls === 'matched' && entry.slug && skipped.has(entry.slug)) state.matchedSlugs.add(entry.slug);
  }
  summarizeRound(level, state);
}

/** The round's classes (`in_flight`, `keep_db_pending`, `deletes_withheld` and `paused_*` apart) and level summary (design §9). */
export function summarizeRound(level: ShadowLevel, state: PassApplyState): void {
  const RANK: Record<SyncClassAction, number> = { none: 0, owner: 1, repair: 2 };
  const classes: PassApplyState['classes'] = {};
  const summary: PassRoundSummary = { db_ahead: { pending: 0, db_only: 0, unproven: 0, by_prefix: {} }, full_skipped_db_ahead: 0, legacy_unverified: 0, legacy_pageless: 0 };
  for (const entry of level.paths) {
    const r = entry.result;
    const key = r.inFlight ? 'in_flight' : r.withheld ? 'deletes_withheld' : r.pending ? 'keep_db_pending' : r.paused ? 'paused_keep_db' : r.cls;
    const action: SyncClassAction = key === 'deletes_withheld' ? 'repair' : key === 'keep_db_pending' || key === 'paused_keep_db' || key === 'in_flight' ? 'owner' : r.classAction ?? syncClassAction(r.cls);
    const slot = classes[key] ?? (classes[key] = { count: 0, action });
    slot.count++;
    if (RANK[action] > RANK[slot.action]) slot.action = action;
    if (r.cls === 'db_ahead' && r.sub) {
      summary.db_ahead[r.sub]++;
      const prefix = entry.path.includes('/') ? `${entry.path.split('/')[0]}/` : '';
      summary.db_ahead.by_prefix[prefix] = (summary.db_ahead.by_prefix[prefix] ?? 0) + 1;
      if (r.fullSkipped) summary.full_skipped_db_ahead++;
    }
    if (r.cls === 'legacy_unverified') summary.legacy_unverified++;
    if (entry.legacyPageless) summary.legacy_pageless++;
  }
  state.classes = classes;
  state.summary = summary;
}

/** Design §2.5: retire markers whose origin left both `T` and the disk, or that a live page claims again (compare-and-delete). */
async function retireMarkers(engine: BrainEngine, level: ShadowLevel, state: PassApplyState): Promise<void> {
  const retire = await filterYielding(level.paths, entry => !isCompactMatched(entry) && entry.state.marker && !entry.legacyPageless
    && ((entry.state.tree === null && !entry.state.present) || entry.state.page?.live === true));
  await inFencedSlices(engine, level.sourceId, retire, async (tx, entry) => {
    const { sourcePath } = passEntryPaths(level, entry.path);
    const stored = await readStoredMarker(tx, level, sourcePath);
    if (!stored) return;
    const blobOids = Array.isArray(stored.blob_oids) ? stored.blob_oids : [];
    if ((stored.kind === 'legacy' ? 'legacy' : 'deleted') !== entry.state.marker!.kind || blobOids.join('\0') !== entry.state.marker!.blobOids.join('\0')) return;
    if (await retireOriginDeletedMarker(tx, { sourceId: level.sourceId, incarnation: level.incarnation, origin: sourcePath, expected: stored })) state.markersRetired++;
  });
}

async function readStoredMarker(exec: Pick<BrainEngine, 'executeRaw'>, level: ShadowLevel, origin: string): Promise<{ kind?: string; blob_oids?: string[]; slug?: string } | null> {
  return await readOriginDeletedMarker(exec, level.sourceId, level.incarnation, origin) as { kind?: string; blob_oids?: string[]; slug?: string } | null;
}

/**
 * Design §2.6: the round's deletes through #2828's valve; a trip withholds them all under one source-level record.
 * GBRA-133 rename storm: a delete whose recorded bytes arrive at a new path in the same round is a rename (batchEntries pairs
 * it), not a deletion, so it is neither counted nor withheld; a whole folder moved with git mv stays a move of each page.
 */
async function applyDeleteValve(engine: BrainEngine, level: ShadowLevel, input: PassApplyInput, state: PassApplyState): Promise<void> {
  const arriving = new Map<string, number>();
  for (const entry of await filterYielding(level.paths, entry => entry.result.action === 'import' && !entry.state.page && !!entry.state.level)) {
    arriving.set(entry.state.level!, (arriving.get(entry.state.level!) ?? 0) + 1);
  }
  const moving = (entry: ShadowPath) => {
    const oid = entry.state.record?.blobOids.find(blob => (arriving.get(blob) ?? 0) > 0);
    if (oid === undefined) return false;
    arriving.set(oid, arriving.get(oid)! - 1);
    return true;
  };
  const deletes = await filterYielding(level.paths, entry => entry.result.action === 'delete' && !entry.result.settled && !entry.result.inFlight && !moving(entry));
  // The valve plans over every live page only when the round deletes something (no delete never trips it).
  const plan = deletes.length ? await (async () => {
    const deleting = new Set(deletes.map(entry => entry.path));
    const live = await filterYielding(level.paths, entry => (isCompactMatched(entry) || entry.state.page?.live === true) && !!entry.slug);
    return planReconcileDeletes(live.map(entry => ({ slug: entry.slug!, source_path: entry.path })), live.filter(entry => !deleting.has(entry.path)).map(entry => entry.path), () => true);
  })() : null;
  // #7130: the absolute caps (sync.max_deletes, sync.max_delete_ratio) withhold too, below the 50% valve.
  const caps = plan ? await readSyncDeleteCaps(engine, level.sourceId) : null;
  const trip = plan && caps ? (plan.massDelete ? 'mass_ratio' as const : syncDeleteTrip(deletes.length, plan.reconcilableCount, caps)) : null;
  const tripped = trip !== null && (input.remote || !massReconcileAllowed());
  state.withheldCount = tripped ? deletes.length : 0;
  if (tripped) {
    for (const entry of deletes) settleAs(entry, { settled: true, action: 'none', withheld: true });
    if (input.remote) return;
    const paths = deletes.map(entry => entry.path).sort();
    await engine.transaction(async tx => {
      await assertDrainLease(tx, level.sourceId);
      state.withheld = await writeDeletesWithheld(tx, { sourceId: level.sourceId, incarnation: level.incarnation, target: level.head, count: deletes.length,
        reconcilable: plan!.reconcilableCount, ratio: plan!.reconcilableCount ? deletes.length / plan!.reconcilableCount : 1, set_hash: deleteSetHash(paths), samples: paths, trip: trip!, caps: caps! });
    });
    return;
  }
  if (input.remote || !await readDeletesWithheld(engine, level.sourceId, level.incarnation)) return;
  await engine.transaction(async tx => { await assertDrainLease(tx, level.sourceId); await clearDeletesWithheld(tx, level.sourceId, level.incarnation); });
  state.withheld = null;
}

/** Rows 6 and 9 and the settle-mismatch streak (§3.1): holds at level `L`, written under the drain lease. */
async function writePassHolds(engine: BrainEngine, level: ShadowLevel, input: PassApplyInput, state: PassApplyState): Promise<void> {
  const pending: PendingHold[] = [];
  let spellings: Map<string, string[]> | undefined;
  // A held rename's origin waits for its destination's hold (#5988), whatever its page did meanwhile.
  const heldRenameOrigins = new Set(level.heldRenames.map(held => syncOriginPath(held.rename.sourcePath)));
  const step = loopYield();
  for (const entry of level.paths) {
    if (step.due()) await step.pause();
    const r = entry.result;
    if (r.inFlight) continue;
    const { path, sourcePath } = passEntryPaths(level, entry.path);
    // A level pass sees every claimed path, so a settled one (an unchanged file) is held too: the heal then resolves it.
    if (entry.ambiguousOrigin?.kind === 'several_live' && r.cls !== 'spelling' && r.cls !== 'held') {
      if (state.originHeld.has(entry.path)) { settleAs(entry, { cls: 'held', settled: true, action: 'none', classAction: 'repair' }); continue; }
      const held = originConflictHold({ path, sourcePath, working: level.mode === 'working', action: entry.state.level === null ? 'delete' : 'import',
        originConflict: await passOriginConflict(engine, level, entry, path, sourcePath) });
      pending.push({ entry, code: 'origin_conflict', slug: held.slug, kind: 'origin_conflict', meta: held.meta, message: held.message, pageId: null });
      continue;
    }
    if (r.settled) continue;
    // GBRA-130 A-17 / B-3: a path whose page identity sync cannot decide is held alone; discovery (a dry run, a company plan) still refuses.
    const identity = r.cls === 'spelling' ? 'spelling' as const : entry.ambiguousOrigin?.kind === 'several_tombstones' ? 'several_tombstones' as const : null;
    if (identity) {
      if (state.originHeld.has(entry.path)) { settleAs(entry, { cls: 'held', settled: true, action: 'none', classAction: 'repair' }); continue; }
      const others = identity === 'spelling' ? ((spellings ??= spellingGroups(level)).get(spellingKey(sourcePath)) ?? []).filter(other => other !== sourcePath) : [];
      pending.push(identity === 'spelling'
        ? { entry, code: 'page_identity_changed', kind: 'page_identity_changed', slug: entry.slug ?? resolveSlugForPath(sourcePath) ?? null, meta: { reason: 'spelling', identity_paths: others },
          message: `${path} and ${others.join(', ') || 'another file'} differ only by letter case or separator, which another platform treats as one file, so sync held them instead of guessing which is the page's; the rest of the source synced.` }
        : { entry, code: 'page_identity_changed', kind: 'page_identity_changed', slug: entry.slug ?? entry.ambiguousOrigin!.slugs[0] ?? null, pageId: null,
          meta: { reason: 'several_tombstones', identity_slugs: entry.ambiguousOrigin!.slugs },
          message: `Deleted pages ${entry.ambiguousOrigin!.slugs.join(', ')} all record ${path} as their origin, so sync held this file instead of guessing which page it is; the rest of the source synced.` });
      continue;
    }
    const streak = input.obligations.mismatch?.[entry.path];
    if (streak && streak.streak >= SETTLE_MISMATCH_STREAK && streak.level === entry.state.level) {
      pending.push({ entry, code: 'settle_mismatch', slug: entry.slug, kind: 'settle_mismatch', meta: { mismatch_streak: streak.streak },
        message: `${path}: sync settled this file at the same level in ${streak.streak} passes in a row, but the next round never classified it settled, so sync held it instead of re-importing it every pass; the rest of the source synced.` });
      continue;
    }
    if (r.cls === 'delete_drift' && heldRenameOrigins.has(syncOriginPath(passEntryPaths(level, entry.path).sourcePath))) continue;
    if (r.cls === 'delete_drift' && r.uncommitted === 'storage_invalid') {
      pending.push({ entry, code: 'file_drift', slug: entry.slug, kind: 'uncommitted', meta: { side: 'deleted', state: 'file_gone', reason: 'storage_invalid', ...(entry.revision ? { page_revision: entry.revision } : {}) },
        message: `${path}: the file is gone, but gbrain.yml's storage section is invalid or ambiguous about db_only (it does not load, declares db_only in a form that resolved no directory, or lists a deprecated supabase_only next to canonical keys), so sync cannot tell whether page ${entry.slug} is database-only; it held the path and kept the page instead of deleting it (#8007); the rest of the source synced.` });
    } else if (r.cls === 'delete_drift' && r.uncommitted) {
      const why = r.uncommitted === 'ignored' ? '.gitignore excludes it, so Git never kept it' : r.uncommitted === 'origin_unknown' ? 'Git could not show whether a commit held it (its history read did not finish)' : 'no commit in its history holds it';
      pending.push({ entry, code: 'file_drift', slug: entry.slug, kind: 'uncommitted', meta: { side: 'deleted', state: 'file_gone', reason: r.uncommitted, ...(entry.revision ? { page_revision: entry.revision } : {}) },
        message: `${path}: the file is gone, but ${why}, so its absence is no evidence that page ${entry.slug} was deleted; sync held it and kept the page instead of deleting it (#7130); the rest of the source synced.` });
    } else if (r.cls === 'delete_drift') {
      pending.push({ entry, code: 'file_drift', slug: entry.slug, kind: 'file_gone', meta: { side: 'deleted', state: 'file_gone', ...(entry.revision ? { page_revision: entry.revision } : {}),
        ...(r.heldDeletionRefused && entry.revision ? { held_deletion: { refused: r.heldDeletionRefused, page_revision: entry.revision } } : {}) },
        message: `${path}: the file is gone, but page ${entry.slug} changed in the database since the file was last imported, so sync held the deletion instead of deleting the page; the rest of the source synced.` });
    } else if (r.cls === 'deleted_edited') {
      const purged = r.state === 'purged_differs';
      const slug = purged ? (await readStoredMarker(engine, level, passEntryPaths(level, entry.path).sourcePath))?.slug ?? resolveSlugForPath(passEntryPaths(level, entry.path).sourcePath) ?? null : entry.slug;
      pending.push({ entry, code: 'file_drift', slug, kind: purged ? 'purged_differs' : 'tombstone_edited', meta: { side: 'deleted', state: purged ? 'purged_differs' : 'tombstone_edited' },
        message: purged ? `${path}: page ${slug ?? path} was purged, and the file differs from the bytes it held, so sync held the file instead of importing it as a new page; the rest of the source synced.`
          : `${path}: page ${slug} was deleted in the database, and the file changed since, so sync held the file instead of reviving the page; the rest of the source synced.` });
    }
  }
  await writeHolds(engine, level, input, state, pending);
}

/**
 * GBRA-130 B-4: holds the imports `batchEntries` found would take over a page at their slug whose frontmatter id differs
 * from the file's (another document), in the same shape as `writePassHolds`; discovery (a dry run, a company plan) still refuses.
 */
export async function holdPassIdentities(engine: BrainEngine, level: ShadowLevel, input: Pick<PassApplyInput, 'passId' | 'observedAt'>, state: PassApplyState,
  items: ReadonlyArray<{ entry: ShadowPath; slug: string; ids: { page: string; file: string } }>): Promise<void> {
  await writeHolds(engine, level, input, state, items.map(({ entry, slug, ids }) => ({ entry, code: 'page_identity_changed' as const, kind: 'page_identity_changed' as const, slug, pageId: null,
    meta: { reason: 'identity_differs' as const, identity_slugs: [slug], identity_ids: ids },
    message: `${passEntryPaths(level, entry.path).path} maps to page ${slug}, whose file is gone, but its frontmatter id '${ids.file}' differs from the page's id '${ids.page}', so it is a different document; sync held it and kept the page instead of giving the file that page's facts, links and history; the rest of the source synced.` })));
}

type PendingHold = { entry: ShadowPath; code: GitHoldCode; message: string; slug: string | null; meta: Partial<GitHoldMeta>; kind: keyof PassApplyState['holds']; pageId?: null };
const spellingKey = (sourcePath: string) => sourcePath.replaceAll('\\', '/').toLowerCase();
/** The level's spelling twins by their folded spelling (only built when a round has one). */
function spellingGroups(level: ShadowLevel): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of level.paths) if (entry.result.cls === 'spelling') {
    const { sourcePath } = passEntryPaths(level, entry.path);
    groups.set(spellingKey(sourcePath), [...groups.get(spellingKey(sourcePath)) ?? [], sourcePath]);
  }
  return groups;
}

/** Writes the round's holds at level `L` under the drain lease, counts them and settles their paths `held` as each slice commits. */
async function writeHolds(engine: BrainEngine, level: ShadowLevel, input: Pick<PassApplyInput, 'passId' | 'observedAt'>, state: PassApplyState, pending: PendingHold[]): Promise<void> {
  await inFencedSlices(engine, level.sourceId, pending, async (tx, hold) => {
    const { path, sourcePath } = passEntryPaths(level, hold.entry.path);
    await writeGitHold(tx, { source_id: level.sourceId, incarnation: level.incarnation, path, source_path: sourcePath, slug: hold.slug,
      page_id: hold.pageId !== undefined ? hold.pageId : hold.entry.state.page?.live ? hold.entry.pageId : null,
      code: hold.code, message: hold.message, upstream_version: hold.entry.state.levelSha256, observed_at: input.observedAt, run_id: input.passId, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, ...levelMeta(level, hold.entry), ...hold.meta } });
  }, slice => {
    for (const hold of slice) {
      state.holds[hold.kind]++;
      if (hold.code === 'settle_mismatch') state.settleMismatch.push(passEntryPaths(level, hold.entry.path).path);
      if (hold.code === 'origin_conflict' || hold.code === 'page_identity_changed') state.originHeld.add(hold.entry.path);
      settleAs(hold.entry, { cls: 'held', settled: true, action: 'none', classAction: 'repair' });
    }
  });
}

/**
 * #6948, as discovery's `originConflictOf`: the live claimants' verdict inputs and the shared verdict, with the file's
 * explicit id read at the path's level `L` (undefined, so the verdict holds `file_unreadable`, when there is no file or
 * it cannot be read).
 */
async function passOriginConflict(engine: BrainEngine, level: ShadowLevel, entry: ShadowPath, path: string, sourcePath: string): Promise<OriginConflict> {
  const claimants = await readOriginClaimants(engine, level.sourceId, entry.ambiguousOrigin!.ids);
  const oid = entry.state.level;
  const bytes = oid === null ? null : level.mode === 'working' ? readSyncFile(level.root, path)
    : (await readBlobs(level.gitRoot, [oid], LEVEL_BLOB_MAX_BYTES).catch(() => new Map<string, Buffer>())).get(oid) ?? null;
  let fileId: string | null | undefined;
  try { fileId = bytes === null ? undefined : frontmatterIdentity(bytes.toString('utf8')).id; } catch { fileId = undefined; }
  const verdict = decideOriginTwins({ sourcePath, claimants, fileId, slugPathOccupied: slugPathOccupied(level) });
  return { canonical: verdict.canonical, claimants: verdict.verdict === 'resolve' ? [verdict.survivor, ...verdict.twins] : verdict.claimants,
    ...(verdict.verdict === 'hold' ? { reason: verdict.reason } : {}) };
}

/** One page's import-record write of a round: the record to store and the page revision it must still be at. */
interface RecordWrite { pageId: number; revision: string; record: Omit<SyncImportProvenance, 'recorded_at' | 'validated'> }

/** The batched, fenced record write: a page whose revision moved since the round read it is left alone. Returns the pages written. */
async function writeRecords(engine: BrainEngine, level: ShadowLevel, writes: RecordWrite[], recorded: Set<number>): Promise<Set<number>> {
  if (!writes.length) return new Set();
  // Noted before the transaction: a commit whose acknowledgement is lost still names the pass as the records' writer.
  for (const write of writes) recorded.add(write.pageId);
  return engine.transaction(async tx => {
    await assertDrainLease(tx, level.sourceId);
    const rows = await tx.executeRaw<{ id: number | string; revision: string }>('SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id=ANY($2::int[]) FOR SHARE',
      [level.sourceId, writes.map(write => write.pageId)]);
    const current = new Map(rows.map(row => [Number(row.id), row.revision]));
    const fenced = writes.filter(write => current.get(write.pageId) === write.revision);
    await recordSyncImportProvenances(tx, fenced.map(write => write.record));
    return new Set(fenced.map(write => write.pageId));
  });
}

/** Row 13: adopt the level into the page's record, keeping `r.parser` (arm 1: revision only, on `fileSame`). */
async function adoptRecords(engine: BrainEngine, level: ShadowLevel, state: PassApplyState): Promise<void> {
  const adopt = await filterYielding(level.paths, entry => entry.result.cls === 'adopt' && entry.pageId !== null && entry.revision !== null && entry.state.level !== null);
  if (!adopt.length) return;
  const records = await readSyncImportProvenances(engine, level.sourceId, level.incarnation, adopt.map(entry => entry.pageId!));
  const writes = adopt.map((entry): RecordWrite => {
    const prior = records.get(entry.pageId!);
    const { sourcePath } = passEntryPaths(level, entry.path);
    const base: Omit<SyncImportProvenance, 'recorded_at' | 'validated'> = prior ? (({ recorded_at: _r, validated: _v, ...rest }) => rest)(prior)
      : { source_id: level.sourceId, incarnation: level.incarnation, page_id: entry.pageId!, origin: sourcePath, raw_sha256: entry.state.levelSha256 ?? '', gbrain_version: VERSION, working: level.mode === 'working' };
    return { pageId: entry.pageId!, revision: entry.revision!, record: { ...base, blob_oid: entry.state.level!, disk_blob_oid: entry.state.diskOid ?? prior?.disk_blob_oid ?? entry.state.level!, revision: entry.revision! } };
  });
  state.adopted += (await writeRecords(engine, level, writes, state.recorded)).size;
}

/**
 * Design §2.7: the bounded read-only legacy sweep; an equal page gets a record and is `matched`. A pass screens at most
 * PASS_LEGACY_SWEEP_MAX legacy pages, LEGACY_SWEEP_SLICE at a time (GBRA-108): each slice's records commit before the next
 * slice is screened and the slice is reported as progress (`onSwept`). #7189: the sweep goes in path order from
 * `obligations.legacy_sweep.cursor`, the last path a slice screened, which is saved with the slice. A page that differs
 * gets no record, so without the cursor a pass stopped mid-sweep kept nothing and the next one screened the same pages
 * again: a first full round that had to screen every page in one pass never finished, and the round's real changes behind
 * it were never imported. The incarnation's first full sweep goes once to the end and records `first_full_at`; later
 * sweeps wrap around to the start.
 */
export async function sweepLegacy(engine: BrainEngine, level: ShadowLevel, input: PassApplyInput, state: PassApplyState): Promise<void> {
  const legacy = (await filterYielding(level.paths, entry => entry.result.cls === 'legacy_unverified' && entry.pageId !== null && entry.revision !== null && entry.state.level !== null && entry.slug))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sweep = input.obligations.legacy_sweep;
  // The pass that finishes the first full sweep does not wrap around in a later round.
  const firstFull = input.fullRound && (!sweep?.first_full_at || state.sweptAll);
  const cursor = sweep?.cursor;
  const from = cursor === undefined ? 0 : legacy.findIndex(entry => entry.path > cursor);
  const start = from < 0 ? legacy.length : from;
  const batch = [...legacy.slice(start), ...firstFull ? [] : legacy.slice(0, start)].filter(entry => !state.swept.paths.has(entry.path))
    .slice(0, Math.max(0, PASS_LEGACY_SWEEP_MAX - state.swept.screened));
  const screen = batch.length ? input.screen ?? readOnlySameContentScreen(engine, input.context, input.processingOptions) : null;
  for (let at = 0; screen && at < batch.length; at += LEGACY_SWEEP_SLICE) {
    await faultPoint('sync:legacy_slice', { sourceId: level.sourceId });
    const slice = batch.slice(at, at + LEGACY_SWEEP_SLICE);
    await sweepSlice(engine, level, slice, screen, state);
    input.obligations.legacy_sweep = { ...input.obligations.legacy_sweep, cursor: slice[slice.length - 1]!.path };
    await input.onSwept?.();
  }
  // A full round whose sweep reached the end (or found no legacy page left) has swept them all.
  if (firstFull && start + batch.length >= legacy.length) state.sweptAll = true;
  if (state.sweptAll && !input.obligations.legacy_sweep?.first_full_at) input.obligations.legacy_sweep = { ...input.obligations.legacy_sweep, first_full_at: new Date().toISOString() };
}

/** Whether the round has a path the pass will import or delete (sync-pass-run.ts `triageRound`). */
function roundHasWork(level: ShadowLevel): boolean {
  return level.paths.some(({ result: r }) => !r.settled && !r.inFlight && (r.action === 'delete' || r.action === 'import' || r.action === 'reparse' || r.cls === 'drift' || r.cls === 'dirty'));
}

/** One sweep slice: screen it, then record its equal pages (fenced on the revision the level read). */
async function sweepSlice(engine: BrainEngine, level: ShadowLevel, slice: ShadowPath[], screen: ConvergenceScreen, state: PassApplyState): Promise<void> {
  const verdicts = await screen(level, slice);
  state.swept.screened += slice.length;
  for (const entry of slice) state.swept.paths.add(entry.path);
  const same = slice.filter(entry => verdicts.get(entry.path) === 'same');
  if (!same.length) return;
  const blobs = level.mode === 'committed' ? await readBlobs(level.gitRoot, [...new Set(same.map(entry => entry.state.level!))], LEVEL_BLOB_MAX_BYTES) : new Map<string, Buffer>();
  const writes = same.flatMap((entry): RecordWrite[] => {
    const { path, sourcePath } = passEntryPaths(level, entry.path);
    const bytes = blobs.get(entry.state.level!);
    const raw = entry.state.levelSha256 ?? (bytes ? sha256(bytes) : null);
    if (!raw) return [];
    return [{ pageId: entry.pageId!, revision: entry.revision!, record: { source_id: level.sourceId, incarnation: level.incarnation, page_id: entry.pageId!, origin: sourcePath, raw_sha256: raw,
      blob_oid: entry.state.level!, disk_blob_oid: entry.state.diskOid ?? entry.state.level!, revision: entry.revision!, parser: syncImportParserFor(path, level.pack), gbrain_version: VERSION,
      working: level.mode === 'working' } }];
  });
  const written = await writeRecords(engine, level, writes, state.recorded);
  state.swept.recorded += written.size;
  for (const entry of same) if (written.has(entry.pageId!)) settleAs(entry, { cls: 'matched', settled: true, action: 'none', classAction: 'none' });
}

/** Rows 15 and 18 under keep_db (§4): freeze to `T[p]`'s bytes and admit the DB-wins reconcile of the pass, bounded per pass. */
async function admitKeepDb(engine: BrainEngine, level: ShadowLevel, input: PassApplyInput, state: PassApplyState): Promise<void> {
  const taken = new Set(state.keepDbTaken);
  const want = await filterYielding(level.paths, entry => !entry.result.inFlight && ((entry.result.cls === 'keep_db' && !entry.result.settled) || (entry.result.cls === 'db_ahead' && entry.result.keepDbWrite === true))
    && !taken.has(entry.path) && entry.pageId !== null && entry.revision !== null && entry.slug && entry.state.level !== null);
  if (!want.length) return;
  if (input.admission !== 'normal') {
    for (const entry of want) { state.keepDb.paused++; settleAs(entry, { settled: true, action: 'none', paused: 'keep_db' }); }
    return;
  }
  const room = Math.max(0, PASS_KEEP_DB_MAX - state.keepDb.admitted);
  const now = want.slice(0, room), later = want.slice(room);
  for (const entry of later) { state.keepDb.pending++; settleAs(entry, { settled: true, action: 'none', pending: 'keep_db' }); }
  if (!now.length) return;
  const blobs = await readBlobs(level.gitRoot, [...new Set(now.map(entry => entry.state.level!))], LEVEL_BLOB_MAX_BYTES);
  for (const entry of now) {
    const bytes = blobs.get(entry.state.level!);
    const refuse = (reason: string) => {
      state.keepDb.refused[reason] = (state.keepDb.refused[reason] ?? 0) + 1;
      if (KEEP_DB_CAPACITY_REFUSALS.has(reason)) { state.keepDb.pending++; settleAs(entry, { settled: true, action: 'none', pending: 'keep_db' }); return; }
      if (entry.result.cls === 'keep_db') settleAs(entry, { cls: 'drift', settled: false, action: 'hold', side: entry.state.record?.revision != null ? 'both' : 'unknown', classAction: 'repair' });
    };
    if (!bytes) { refuse('bytes_unreadable'); continue; }
    const frozen = await freezeKeepDbReconcile(engine, { sourceId: level.sourceId, slug: entry.slug!, pageId: entry.pageId!, revision: entry.revision!, path: passEntryPaths(level, entry.path).path,
      frozenBytes: bytes, classified: entry.result, mode: entry.state.mode, dirty: entry.state.dirty });
    if ('refused' in frozen) { refuse(frozen.refused); continue; }
    const admitted = await admitKeepDbReconcile(engine, frozen.artifact, { passId: input.passId, remote: false, inTx: tx => assertDrainLease(tx, level.sourceId) });
    if ('refused' in admitted) {
      if (admitted.refused === 'admission_paused') { state.keepDb.paused++; settleAs(entry, { settled: true, action: 'none', paused: 'keep_db' }); continue; }
      refuse(admitted.refused); continue;
    }
    state.keepDb.admitted++;
    state.keepDbTaken.push(entry.path);
    settleAs(entry, { settled: false, inFlight: true, action: 'keep_db' });
  }
}

/** Whether a slug-prefix grant sees the path's page (its live slug, else the slug its origin imports to). */
function grantSees(level: ShadowLevel, entry: ShadowPath, prefixes: readonly string[]): boolean {
  const slug = entry.slug ?? resolveSlugForPath(passEntryPaths(level, entry.path).sourcePath);
  return !!slug && slugUnderBoundPrefixes(prefixes, slug);
}

/** Why a remote caller left a visible path unsettled (design §5). */
export type RemoteUnsettledReason = 'drift' | 'bootstrap' | 'unproven_delete' | 'grant_scope';
export interface RemoteReconcile { committed: number; unsettled: Partial<Record<RemoteUnsettledReason, number>>; fix: Action }

/**
 * Design §5: a remote caller's ending. It admitted the one-sided work it could (`committed`), and leaves to the owner host
 * what only the host settles: two-sided paths (`drift`), legacy pages the host's sweep checks (`bootstrap`), deletions
 * without a proof (`unproven_delete`), and, for a slug-fenced grant, the stamp itself (`grant_scope`). Counts cover only
 * pages the grant sees; nothing here implies another writer.
 */
export function remoteReconcile(level: ShadowLevel, input: { committed: number; grantPrefixes: readonly string[] | null }): RemoteReconcile {
  const unsettled: RemoteReconcile['unsettled'] = {};
  const bump = (reason: RemoteUnsettledReason) => { unsettled[reason] = (unsettled[reason] ?? 0) + 1; };
  for (const entry of level.paths) {
    if (input.grantPrefixes && !grantSees(level, entry, input.grantPrefixes)) continue;
    const r = entry.result;
    if (r.cls === 'legacy_unverified') { bump('bootstrap'); continue; }
    if (r.settled || r.inFlight) continue;
    if (r.cls === 'delete_drift') bump('unproven_delete');
    else if (['drift', 'keep_db', 'deleted_edited', 'dirty', 'spelling', 'held'].includes(r.cls)) bump('drift');
  }
  if (input.grantPrefixes) unsettled.grant_scope = 1;
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', level.sourceId, '--json'] };
  return { committed: input.committed, unsettled, fix: { argv: ['gbrain', 'sync', '--source', level.sourceId], consent: [], actor: 'user', requires_exclusive: false, verify,
    user_message: `Run gbrain sync --source ${level.sourceId} on the brain host that owns this source: it settles what a remote caller cannot (${Object.keys(unsettled).join(', ') || 'the converged stamp'}).`,
    why: `This remote sync committed ${input.committed} one-sided write(s). Holds, deletion markers, keep_db writes and the converged stamp are written only by the owner host's own sync, so the source is not stamped until it runs there.` } };
}

/** Once per pass: release the concept drift skips of pages the pass classified `matched` (§4). */
export async function finishPassApply(engine: BrainEngine, sourceId: string, state: PassApplyState): Promise<number> {
  return state.matchedSlugs.size ? releaseMatchedDriftSkips(engine, sourceId, state.matchedSlugs) : 0;
}

/** The pass row's telemetry counts of what the rounds applied. */
export function passApplyCounts(state: PassApplyState): Record<string, number> {
  const refused = Object.values(state.keepDb.refused).reduce((a, b) => a + b, 0);
  return { markers_retired: state.markersRetired, holds_file_gone: state.holds.file_gone, holds_tombstone_edited: state.holds.tombstone_edited,
    holds_purged_differs: state.holds.purged_differs, holds_settle_mismatch: state.holds.settle_mismatch, holds_origin_conflict: state.holds.origin_conflict, holds_page_identity_changed: state.holds.page_identity_changed, holds_uncommitted: state.holds.uncommitted, adopted: state.adopted, legacy_swept: state.swept.screened,
    legacy_recorded: state.swept.recorded, deletes_withheld: state.withheldCount, keep_db_admitted: state.keepDb.admitted, keep_db_pending: state.keepDb.pending,
    paused_keep_db: state.keepDb.paused, keep_db_refused: refused, held_deletions_applied: state.heldDeletions.applied, held_deletions_refused: state.heldDeletions.refused };
}
