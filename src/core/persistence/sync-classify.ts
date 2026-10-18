/**
 * #6712 PR 4 (design v3.2 §2.3): the level classifier of a managed source. Pure (no I/O, no engine), total, ordered and
 * first-match: every path of a pass's domain gets exactly one class, which says whether the path is settled and what the
 * pass would do about it. PR 4a runs it read-only (`gbrain sync --dry-run --json`, `sync status --detail`'s
 * `convergence`); nothing it returns is acted on yet.
 *
 * The inputs are facts the pass read (sync-pass.ts): the level `L` (committed mode `T[p]`; working mode the physical
 * bytes' blob id), presence on disk, the candidate dirtiness `Dp`, the page and its import record, the attestation of
 * its current revision, its hold, deletion marker, baseline blob and open work. Definitions (v3.1 §2.3, v3.2 §2.3):
 * `fileSame := L ∈ {r.blob_oid, r.disk_blob_oid}`, `dbSame := r.revision = page.revision`, `proof := dbSame ∨ att(R)`,
 * `obligation := ¬sameParser ∨ origin ≠ page.source_path ∨ episodeUnsatisfied`.
 */

/** Candidate dirtiness of a committed-mode path in `T` (sync-git-stream.ts `probeDirtiness`). */
export type SyncDirtiness = 'clean' | 'clean_eol' | 'clean_lfs' | 'modified' | 'deleted' | 'staged' | 'untracked' | 'unknown';

export const SYNC_CLASSES = ['held', 'spelling', 'untracked', 'kept', 'delete', 'delete_drift', 'gone', 'deleted_same', 'deleted_edited', 'legacy_same',
  'dirty', 'matched', 'adopt', 'reparse', 'db_ahead', 'import', 'legacy_unverified', 'keep_db', 'drift'] as const;
export type SyncClass = typeof SYNC_CLASSES[number];
/** Who finishes a class: nothing to do, sync by itself (`owner`), or a person (`repair`) (design v3.2 §9 glossary). */
export type SyncClassAction = 'none' | 'owner' | 'repair';
/** What the pass does with the path (PR 4b admits these; PR 4a only predicts them). */
export type SyncPathAction = 'none' | 'refuse' | 'delete' | 'hold' | 'adopt' | 'import' | 'reparse' | 'keep_db';

export interface SyncPathState {
  mode: 'committed' | 'working';
  /** `T[p]`: the blob id at the pinned target, null when `p ∉ T`. */
  tree: string | null;
  /** `L(p)`: committed mode `T[p]`; working mode the physical bytes' blob id (CRLF-folded / LFS-resolved to `T[p]` when clean); null = absent. */
  level: string | null;
  /** `workingTreeFilePresent`. */
  present: boolean;
  /** Committed mode, `p ∈ T`: the candidate dirtiness; null when the pass did not probe it (only paths settled without it). */
  dirty: SyncDirtiness | null;
  /** The blob id of the bytes on disk, when read. */
  diskOid: string | null;
  /** The page whose origin is `p`: live, a soft-deleted tombstone, or none. */
  page: { live: boolean; revision: string; originMatches: boolean } | null;
  /** The page's import record (none, or one written before PR 0 without a revision). */
  record: { blobOids: readonly string[]; revision: string | null; parserSame: boolean } | null;
  /** `att(R)`: the page's current revision is file-backed; `hash` is the attested bytes' sha256 when an effect recorded one; `arm1` a committed sync request wrote it. */
  attested: { hash: string | null; arm1: boolean } | null;
  /** sha256 of `L`'s bytes, when the pass read them (adoption by hash). */
  levelSha256: string | null;
  /** `published`: the disk bytes hash to the attested publication's `expected_hash`, or the disk is absent after a deleting publication. */
  published: boolean;
  /** An active hold at `p`: whether it is at level `L` in its own domain, re-screen due, or in the retry set. */
  hold: { atLevel: boolean; rescreenDue: boolean; retried: boolean } | null;
  /** A deletion marker at the origin: `deleted` (with the blob ids it held) or `legacy` (the baseline blob). */
  marker: { kind: 'deleted' | 'legacy'; blobOids: readonly string[] } | null;
  /** `T[p]` at the pass row's `baseline_commit` (null: absent there, or no baseline). */
  baseline: string | null;
  /** Another live origin differs from `p` only by case or separator. */
  spelling: boolean;
  /** An open full episode has not re-imported this page yet. */
  episodeUnsatisfied: boolean;
  /** Under a `storage.keep_db` prefix, on a source that is not mirror-read-only. */
  keepDb: boolean;
  /** Open work on the page or path (a queued/running/recovering request, a pending Git effect). */
  openWork: boolean;
}

export interface SyncClassified {
  cls: SyncClass;
  settled: boolean;
  /** The overlay: an unsettled class whose page has open work is `in_flight` (skipped this round, blocks the stamp). */
  inFlight: boolean;
  action: SyncPathAction;
  /** `db_ahead`: `pending` (attested), `db_only` (moved off a recorded revision), `unproven` (no record revision). */
  sub?: 'pending' | 'db_only' | 'unproven';
  /** `drift` and `delete_drift`: the hold's side. `deleted_edited`: its state. */
  side?: 'both' | 'unknown' | 'deleted';
  state?: 'tombstone_edited' | 'purged_differs' | 'file_gone';
  /** `db_ahead` `db_only` under keep_db: also gets the DB-wins write. */
  keepDbWrite?: true;
  /** `db_ahead` `db_only`/`unproven` under an open full obligation: excluded and counted (`full_skipped_db_ahead`). */
  fullSkipped?: true;
}

const CLEAN = new Set<SyncDirtiness | null>(['clean', 'clean_eol', 'clean_lfs']);

/** The class's glossary action (`convergence.classes[c].action`). `in_flight` and `keep_db_pending` are `owner`. */
export function syncClassAction(cls: SyncClass | 'in_flight' | 'keep_db_pending' | 'deletes_withheld'): SyncClassAction {
  switch (cls) {
    case 'matched': case 'adopt': case 'kept': case 'untracked': case 'gone': case 'deleted_same': case 'legacy_same': case 'db_ahead':
      return 'none';
    case 'in_flight': case 'import': case 'reparse': case 'keep_db': case 'keep_db_pending': case 'legacy_unverified': case 'delete':
      return 'owner';
    case 'held': case 'spelling': case 'delete_drift': case 'deleted_edited': case 'dirty': case 'drift': case 'deletes_withheld':
      return 'repair';
  }
}

/** Rows 1-19 of v3.2 §2.3, tried in order; the first match wins. */
function firstMatch(s: SyncPathState): Omit<SyncClassified, 'inFlight'> {
  const live = s.page?.live === true;
  const tombstone = s.page !== null && !s.page.live;
  const fileSame = s.level !== null && !!s.record && s.record.blobOids.includes(s.level);
  const dbSame = !!s.page && !!s.record && s.record.revision !== null && s.record.revision === s.page.revision;
  const proof = dbSame || s.attested !== null;
  const obligation = !s.record?.parserSame || !s.page?.originMatches || s.episodeUnsatisfied;
  if (s.hold && s.hold.atLevel && !s.hold.rescreenDue && !s.hold.retried) return { cls: 'held', settled: true, action: 'none' };
  if (s.spelling) return { cls: 'spelling', settled: false, action: 'refuse' };
  if (s.mode === 'committed' && s.tree === null && !live) return { cls: 'untracked', settled: true, action: 'none' };
  if (live && s.level === null) {
    if (s.mode === 'committed' && s.present) return { cls: 'kept', settled: true, action: 'none' };
    if (!s.present) return proof ? { cls: 'delete', settled: false, action: 'delete' }
      : { cls: 'delete_drift', settled: false, action: 'hold', side: 'deleted', state: 'file_gone' };
  }
  if (!live && s.level === null) return { cls: 'gone', settled: true, action: 'none' };
  if (!live) {
    const deletedMarker = s.marker?.kind === 'deleted' ? s.marker : null;
    if ((tombstone && fileSame) || (deletedMarker && s.level !== null && deletedMarker.blobOids.includes(s.level))) return { cls: 'deleted_same', settled: true, action: 'none' };
    if ((tombstone || deletedMarker) && !s.published) return { cls: 'deleted_edited', settled: false, action: 'hold', side: 'deleted', state: tombstone ? 'tombstone_edited' : 'purged_differs' };
    if (s.marker?.kind === 'legacy' && s.level !== null && s.marker.blobOids.includes(s.level)) return { cls: 'legacy_same', settled: true, action: 'none' };
  }
  if (s.mode === 'committed' && s.tree !== null && !CLEAN.has(s.dirty)) {
    const absorbed = (s.tree !== null && !!s.record && s.record.blobOids.includes(s.tree)) || (s.diskOid !== null && !!s.record && s.record.blobOids.includes(s.diskOid));
    const settled = absorbed || s.published || (s.dirty === 'deleted' && !live);
    return { cls: 'dirty', settled, action: settled ? 'none' : 'hold' };
  }
  if (live) {
    if (fileSame && dbSame && !obligation) return { cls: 'matched', settled: true, action: 'none' };
    const byHash = s.attested?.hash != null && s.levelSha256 !== null && s.levelSha256 === s.attested.hash;
    const byRevision = fileSame && s.record?.revision === null && s.attested?.arm1 === true;
    if (!obligation && (byHash || byRevision)) return { cls: 'adopt', settled: true, action: 'adopt' };
    if (fileSame && dbSame) return { cls: 'reparse', settled: false, action: 'reparse' };
    if (fileSame) {
      const sub = s.attested ? 'pending' : s.record?.revision != null ? 'db_only' : 'unproven';
      const keepDbWrite = sub === 'db_only' && s.keepDb && s.mode === 'committed' && s.dirty === 'clean';
      return { cls: 'db_ahead', settled: true, action: keepDbWrite ? 'keep_db' : 'none', sub,
        ...(keepDbWrite ? { keepDbWrite: true as const } : {}), ...(s.episodeUnsatisfied && sub !== 'pending' ? { fullSkipped: true as const } : {}) };
    }
  }
  if ((!fileSame && proof && live) || !live) return { cls: 'import', settled: false, action: 'import' };
  if (live && s.record?.revision == null && s.level !== null && s.level === s.baseline) return { cls: 'legacy_unverified', settled: true, action: 'none' };
  if (live && s.keepDb && s.mode === 'committed' && s.dirty === 'clean') return { cls: 'keep_db', settled: false, action: 'keep_db' };
  return { cls: 'drift', settled: false, action: 'hold', side: s.record?.revision != null ? 'both' : 'unknown' };
}

/** The class of one path (v3.2 §2.3), with the open-work overlay applied. */
export function classifySyncPath(s: SyncPathState): SyncClassified {
  const match = firstMatch(s);
  return { ...match, inFlight: !match.settled && s.openWork };
}

/** Why a pass is not idle (v3.2 §2.2); empty = idle. A hold-only round runs when `rescreen_due_hold` is the only reason. */
export type SyncIdleBlocker = 'no_converged_state' | 'target_moved' | 'open_episode' | 'owed_tail' | 'retry_row' | 'not_converged_streak' | 'mismatch_streak'
  | 'fingerprint_changed' | 'request_newer' | 'open_at_stamp_finished' | 'working_change' | 'full_round_due' | 'rescreen_due_hold';

export interface SyncPassKindInput {
  converged: { target: string; parserFp: string; pack: string | null; selectionFp: string; passesSinceFull: number; lastFullAt: number } | null;
  head: string; parserFp: string; pack: string | null; selectionFp: string; now: number;
  openEpisode: boolean; owedTail: boolean; retryRow: boolean; notConvergedStreak: number; mismatchStreak: number;
  /** A request of this source newer than `converged.request_hwm`. */
  requestNewer: boolean;
  /** Some request or effect recorded in `converged.open_at_stamp` is no longer open (or the set overflowed its cap). */
  openAtStampFinished: boolean;
  /** Working mode: the stat cache saw a change. */
  workingChange: boolean;
  rescreenDueHold: boolean;
  /** `--full`. */
  full: boolean;
}

/** Full rounds run at least this often (v3.2 §2.2, [estimated]). */
export const SYNC_FULL_ROUND_MAX_MS = 24 * 3600_000;
export const SYNC_FULL_ROUND_MAX_PASSES = 200;

/** The pass kind (v3.2 §2.2): `idle` when nothing disqualifies it, `hold_only` when a re-screen-due hold is the only reason, else `full`. */
export function syncPassKind(input: SyncPassKindInput): { kind: 'idle' | 'hold_only' | 'full'; blockers: SyncIdleBlocker[] } {
  const c = input.converged;
  const blockers: SyncIdleBlocker[] = [];
  if (!c) blockers.push('no_converged_state');
  else {
    if (c.target !== input.head) blockers.push('target_moved');
    if (c.parserFp !== input.parserFp || c.pack !== input.pack || c.selectionFp !== input.selectionFp) blockers.push('fingerprint_changed');
    if (c.passesSinceFull >= SYNC_FULL_ROUND_MAX_PASSES || input.now - c.lastFullAt >= SYNC_FULL_ROUND_MAX_MS) blockers.push('full_round_due');
  }
  if (input.full || input.openEpisode) blockers.push('open_episode');
  if (input.owedTail) blockers.push('owed_tail');
  if (input.retryRow) blockers.push('retry_row');
  if (input.notConvergedStreak > 0) blockers.push('not_converged_streak');
  if (input.mismatchStreak > 0) blockers.push('mismatch_streak');
  if (input.requestNewer) blockers.push('request_newer');
  if (input.openAtStampFinished) blockers.push('open_at_stamp_finished');
  if (input.workingChange) blockers.push('working_change');
  if (input.rescreenDueHold) blockers.push('rescreen_due_hold');
  const kind = !blockers.length ? 'idle' : blockers.every(b => b === 'rescreen_due_hold') ? 'hold_only' : 'full';
  return { kind, blockers };
}
