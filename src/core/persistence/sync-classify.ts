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
 * `obligation := ¬sameParser ∨ origin ≠ page.source_path ∨ (episodeUnsatisfied ∧ ¬inPlace)`, where
 * `inPlace := fileSame ∧ dbSame ∧ derivedCurrent ∧ no hold`: a page the open full episode has not re-imported yet
 * satisfies it without a reparse when it already is the import of `L` and everything derived from it is current. The
 * waiver only lifts the episode's term, so it can turn a `reparse` into `matched` and nothing else: any state that keeps
 * a page from `matched` outside an episode (a stale parser, a moved origin, or any later force-import flag, which must
 * defeat `matched` to force anything) still reparses it.
 *
 * G3 of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md): for a strict source (`config.canonical = "git"`) the
 * classifier reads the commit alone and Git wins. The working tree is invisible (every path in `T` is clean, a path absent
 * from `T` is absent), a page Git moved past or never matched imports the committed blob over the database, and a live
 * page whose file a commit removed is deleted. A page Git never held stays as the database has it. Holds keep their rows
 * (a hold at its level settles, a re-screened one re-runs Git's verdict); conversion resolves a source's holds before it
 * turns strict. `gitWins` names the class the same path gets on a source that is not strict, so a preview can list what
 * Git overwrote.
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
  /** `workingTreeFilePresent`; committed mode, `L = absent`: false for a page whose import provenance is the Git blob (`keptWorkingTreePages`). */
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
  /**
   * A deletion marker at the origin: `deleted` (with the blob ids it held) or `legacy` (the baseline blob of a page deleted
   * before PR 4; `deletion` is the committed deleting request that proves it, and a legacy marker without one settles nothing).
   */
  marker: { kind: 'deleted' | 'legacy'; blobOids: readonly string[]; deletion?: string | null } | null;
  /** `T[p]` at the pass row's `baseline_commit` (null: absent there, or no baseline). */
  baseline: string | null;
  /**
   * Another live origin differs from `p` only by case or separator. `legacy`: a page-less spelling unchanged since the baseline
   * that no other claim refuses; master's discovery never claimed it (#6865), so it settles and stays reported for a person.
   */
  spelling: boolean | 'legacy';
  /** An open full episode has not re-imported this page yet. */
  episodeUnsatisfied: boolean;
  /**
   * Everything the page derives is current under this binary (sync-pass.ts `readPages`): an inline Markdown page chunked at
   * the current chunker version, its text projection at its revision and its contextual mode stamped, so a reparse of the
   * same bytes would change nothing. Absent: unknown, and an open episode reparses the page.
   */
  derivedCurrent?: boolean;
  /** `--full` or an open episode: every path, page-less ones included, owes a re-import (v3.1 §2.7). */
  fullObligation?: boolean;
  /** Under a `storage.keep_db` prefix, on a source that is not mirror-read-only. */
  keepDb: boolean;
  /**
   * #7324: a page under a declared `storage.db_only` dir: its database row is canonical, so an absent file is no deletion
   * evidence. #8007: `unknown` while gbrain.yml's storage section is invalid; an absent file is then held, never deleted.
   */
  dbOnly?: boolean | 'unknown';
  /** Open work on the page or path (a queued/running/recovering request, a pending Git effect). */
  openWork: boolean;
  /**
   * #7130 (sync-origin-evidence.ts): for a live page whose file is absent, whether Git ever committed the file. Read only
   * for those paths; undefined until read. Anything but `committed` is no deletion evidence, so the page is held.
   */
  originEvidence?: 'committed' | 'never_committed' | 'ignored' | 'unknown';
}

export interface SyncClassified {
  cls: SyncClass;
  settled: boolean;
  /** The overlay: an unsettled class whose page has open work is `in_flight` (skipped this round, blocks the stamp). */
  inFlight: boolean;
  action: SyncPathAction;
  /** Who finishes this path (per path, not per class): a settled `dirty` path is `none`, an unsettled one `repair`; a re-screen-due hold is `owner`. */
  classAction: SyncClassAction;
  /** `held`: the hold is re-screen due (or no longer at its level), so the pass re-runs it. */
  rescreenDue?: true;
  /** `db_ahead`: `pending` (attested), `db_only` (moved off a recorded revision), `unproven` (no record revision). */
  sub?: 'pending' | 'db_only' | 'unproven';
  /** `drift` and `delete_drift`: the hold's side. `deleted_edited`: its state. */
  side?: 'both' | 'unknown' | 'deleted';
  state?: 'tombstone_edited' | 'purged_differs' | 'file_gone';
  /** #7130: a `delete_drift` whose file Git never committed (`never_committed`), `.gitignore` excludes, or whose history read did not answer (`origin_unknown`). */
  uncommitted?: 'never_committed' | 'ignored' | 'origin_unknown' | 'storage_invalid';
  /** `db_ahead` `db_only` under keep_db: also gets the DB-wins write. */
  keepDbWrite?: true;
  /** `db_ahead` `db_only`/`unproven` under an open full obligation: excluded and counted (`full_skipped_db_ahead`). */
  fullSkipped?: true;
  /** #6712 PR 4b (sync-pass-apply.ts): a delete the mass-delete valve withheld (design §2.6); settled while the trip lasts. */
  withheld?: true;
  /** #6712 PR 4b: a keep_db write over the pass cap (`keep_db_pending`, §4), settled and taken first next pass. */
  pending?: 'keep_db';
  /** #6712 PR 4b: a write `sync.admission` pauses (`paused_keep_db`, §8). */
  paused?: 'keep_db';
  /** GBRA-133 (sync-held-deletions.ts): a held committed deletion `sync.apply_held_deletions` proved, deleted with this receipt. */
  heldDeletion?: { commit: string; blob_oid: string };
  /** GBRA-133: why that proof refused this held deletion; its hold records it at the page's revision. */
  heldDeletionRefused?: string;
  /** G3, a strict source: the class this path gets on a source that is not strict, when Git's verdict differs from it. */
  gitWins?: SyncClass;
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

type Matched = Omit<SyncClassified, 'inFlight' | 'classAction'>;

/**
 * Rows 1-19 of v3.2 §2.3, tried in order; the first match wins. Garry's Q3 = A invariant: a settled path is matched, held or
 * in a class whose action says who finishes it. So a path with a hold row never settles in a later row (b2): unless the hold
 * is at its level and not re-screen due, the pass re-runs it (`held`, `rescreenDue`).
 */
function firstMatch(s: SyncPathState, strict = false): Matched {
  if (s.hold && s.hold.atLevel && !s.hold.rescreenDue && !s.hold.retried) return { cls: 'held', settled: true, action: 'none' };
  const rest = strict ? gitWins(s) : afterHold(s);
  // The re-run is the import the hold refused, where an import is what the level would get anyway (`import`) or changes
  // nothing (`matched`). A level that needs another action (a drift side, a delete proof, a reparse) keeps that class, so
  // its guard still applies; one that settles any other way (database ahead, a deleted page, an uncommitted edit, a legacy
  // page) must not be imported over, so the hold stands.
  if (s.hold && s.level !== null && (rest.cls === 'matched' || rest.cls === 'import')) return { cls: 'held', settled: false, action: 'import', rescreenDue: true };
  if (s.hold && rest.settled) return { cls: 'held', settled: true, action: 'none' };
  return rest;
}

function afterHold(s: SyncPathState): Matched {
  const live = s.page?.live === true;
  const tombstone = s.page !== null && !s.page.live;
  const fileSame = s.level !== null && !!s.record && s.record.blobOids.includes(s.level);
  const dbSame = !!s.page && !!s.record && s.record.revision !== null && s.record.revision === s.page.revision;
  const proof = dbSame || s.attested !== null;
  const inPlace = fileSame && dbSame && s.derivedCurrent === true && s.hold === null;
  const obligation = !s.record?.parserSame || !s.page?.originMatches || (s.episodeUnsatisfied && !inPlace);
  if (s.spelling) return { cls: 'spelling', settled: s.spelling === 'legacy', action: s.spelling === 'legacy' ? 'none' : 'refuse' };
  if (s.mode === 'committed' && s.tree === null && !live) return { cls: 'untracked', settled: true, action: 'none' };
  if (live && s.level === null) {
    if (s.mode === 'committed' && s.present) return { cls: 'kept', settled: true, action: 'none' };
    if (!s.present) {
      if (s.dbOnly === true) return { cls: 'kept', settled: true, action: 'none' };
      if (s.dbOnly === 'unknown') return { cls: 'delete_drift', settled: false, action: 'hold', side: 'deleted', state: 'file_gone', uncommitted: 'storage_invalid' };
      if (s.originEvidence && s.originEvidence !== 'committed') return { cls: 'delete_drift', settled: false, action: 'hold', side: 'deleted', state: 'file_gone',
        uncommitted: s.originEvidence === 'unknown' ? 'origin_unknown' : s.originEvidence };
      return proof ? { cls: 'delete', settled: false, action: 'delete' } : { cls: 'delete_drift', settled: false, action: 'hold', side: 'deleted', state: 'file_gone' };
    }
  }
  if (!live && s.level === null) return { cls: 'gone', settled: true, action: 'none' };
  if (!live) {
    const deletedMarker = s.marker?.kind === 'deleted' ? s.marker : null;
    if ((tombstone && fileSame) || (deletedMarker && s.level !== null && deletedMarker.blobOids.includes(s.level))) return { cls: 'deleted_same', settled: true, action: 'none' };
    if ((tombstone || deletedMarker) && !s.published) return { cls: 'deleted_edited', settled: false, action: 'hold', side: 'deleted', state: tombstone ? 'tombstone_edited' : 'purged_differs' };
    if (s.marker?.kind === 'legacy' && s.marker.deletion && !s.fullObligation && s.level !== null && s.marker.blobOids.includes(s.level)) return { cls: 'legacy_same', settled: true, action: 'none' };
  }
  if (s.mode === 'committed' && s.tree !== null && !CLEAN.has(s.dirty) && s.dirty !== 'deleted') {
    const absorbed = (s.tree !== null && !!s.record && s.record.blobOids.includes(s.tree)) || (s.diskOid !== null && !!s.record && s.record.blobOids.includes(s.diskOid));
    const settled = absorbed || s.published;
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

/**
 * G3: a strict source's path as the commit alone shows it. Committed mode only (a strict pass never reads a working level):
 * every path in `T` is clean with no disk bytes, a path absent from `T` is absent from disk, and keep_db does not apply.
 */
export function committedOnlyState(s: SyncPathState): SyncPathState {
  return { ...s, present: s.tree !== null, dirty: s.tree === null ? null : 'clean', diskOid: null, published: false, keepDb: false };
}

/**
 * G3: Git's verdict for a strict source, after its hold rows. Drift, a database version sync never saw (`db_ahead` that is
 * not a pending door write, or a page no import record proves: `legacy_unverified`), keep_db and an edited tombstone import
 * the committed blob. A live page whose file is absent
 * from `T` waits for its origin evidence (sync-pass.ts reads it for every delete candidate), then is deleted when a commit
 * held the file and left as the database has it otherwise.
 */
function gitWins(s: SyncPathState): Matched {
  const verdict = gitVerdict(committedOnlyState(s));
  const before = afterHold(s).cls;
  return verdict.cls === before ? verdict : { ...verdict, gitWins: before };
}

function gitVerdict(state: SyncPathState): Matched {
  const rest = afterHold(state);
  const wins = (match: Matched): Matched => match;
  switch (rest.cls) {
    // G8a: a page no import record proves (legacy_unverified, typically the unknown side of a held drift) takes the commit too.
    case 'drift': case 'keep_db': case 'deleted_edited': case 'legacy_unverified': return wins({ cls: 'import', settled: false, action: 'import' });
    case 'db_ahead': return rest.sub === 'pending' ? rest : wins({ cls: 'import', settled: false, action: 'import' });
    case 'delete': case 'delete_drift':
      if (state.originEvidence === undefined || rest.uncommitted === 'storage_invalid') return rest;
      if (state.originEvidence !== 'committed') return wins({ cls: 'kept', settled: true, action: 'none' });
      return rest.cls === 'delete' ? rest : wins({ cls: 'delete', settled: false, action: 'delete' });
    default: return rest;
  }
}

/** The class of one path (v3.2 §2.3), with the open-work overlay applied; `strict` is Git's verdict (G3). */
export function classifySyncPath(s: SyncPathState, opts: { strict?: boolean } = {}): SyncClassified {
  const match = firstMatch(s, opts.strict === true && s.mode === 'committed');
  const inFlight = !match.settled && s.openWork;
  const classAction: SyncClassAction = inFlight || match.rescreenDue ? 'owner' : match.cls === 'dirty' ? (match.settled ? 'none' : 'repair') : syncClassAction(match.cls);
  return { ...match, inFlight, classAction };
}

/** Why a pass is not idle (v3.2 §2.2); empty = idle. A hold-only round runs when `rescreen_due_hold` is the only reason. */
export type SyncIdleBlocker = 'no_converged_state' | 'target_moved' | 'open_episode' | 'owed_tail' | 'retry_row' | 'not_converged_streak' | 'mismatch_streak'
  | 'fingerprint_changed' | 'request_newer' | 'open_at_stamp_finished' | 'writeback_open' | 'working_change' | 'full_round_due' | 'rescreen_due_hold';

export interface SyncPassKindInput {
  converged: { target: string; parserFp: string; pack: string | null; selectionFp: string; passesSinceFull: number; lastFullAt: number } | null;
  head: string; parserFp: string; pack: string | null; selectionFp: string; now: number;
  openEpisode: boolean; owedTail: boolean; retryRow: boolean; notConvergedStreak: number; mismatchStreak: number;
  /** A request of this source newer than `converged.request_hwm`. */
  requestNewer: boolean;
  /** Some request or effect recorded in `converged.open_at_stamp` is no longer open (or the set overflowed its cap). */
  openAtStampFinished: boolean;
  /** A writeback recorded in `converged.writeback` has a Git effect that has not committed (queued, running, failed or parked). */
  writebackOpen?: boolean;
  /** Working mode: the stat cache saw a change. */
  workingChange: boolean;
  rescreenDueHold: boolean;
  /** `--full`. */
  full: boolean;
  /** #7866: a full round asked for without an episode (SyncOpts.fullRound). */
  fullRound?: boolean;
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
    if (input.fullRound || c.passesSinceFull >= SYNC_FULL_ROUND_MAX_PASSES || input.now - c.lastFullAt >= SYNC_FULL_ROUND_MAX_MS) blockers.push('full_round_due');
  }
  if (input.full || input.openEpisode) blockers.push('open_episode');
  if (input.owedTail) blockers.push('owed_tail');
  if (input.retryRow) blockers.push('retry_row');
  if (input.notConvergedStreak > 0) blockers.push('not_converged_streak');
  if (input.mismatchStreak > 0) blockers.push('mismatch_streak');
  if (input.requestNewer) blockers.push('request_newer');
  if (input.openAtStampFinished) blockers.push('open_at_stamp_finished');
  if (input.writebackOpen) blockers.push('writeback_open');
  if (input.workingChange) blockers.push('working_change');
  if (input.rescreenDueHold) blockers.push('rescreen_due_hold');
  const kind = !blockers.length ? 'idle' : blockers.every(b => b === 'rescreen_due_hold') ? 'hold_only' : 'full';
  return { kind, blockers };
}
