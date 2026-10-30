/**
 * #6712 PR 4a (design v3.2 §2.1-§2.2, §11 step 2): the read-only shadow of the level-triggered managed-sync pass.
 * It reads the level of one managed source and classifies every path of its domain with sync-classify.ts, and writes
 * and admits nothing: no hold, marker, record, pass row, cursor or request. `gbrain sync --dry-run --json` and
 * `gbrain sync status --detail --json` report the result as `convergence` (sync-convergence.ts); PR 4b turns the same
 * reads into the pass.
 *
 * Reads (each timed in `timings_ms`, with `context`, `setup` and the rest of the round): `T` (`ls-tree -r -z` at HEAD,
 * complete or refused), `X` (the index), `U` (working mode: untracked files), `Dp` (committed mode: candidates only;
 * working mode: every path, the full-round rehash), and the database: `I⋈P` (pages of the source with their import
 * records), `H` (holds and retry rows), `U_db` (open requests and pending Git effects), deletion markers, and `A` (the
 * attestation of the current revision) for the pages whose class needs a proof. The Git reads, the database snapshot and
 * the holds run concurrently (`reads` is their wall time). On Postgres the snapshot reads share one `REPEATABLE READ,
 * READ ONLY` transaction and `I⋈P` is one set-based statement read through a cursor; PGLite admits one transaction at a
 * time, so there they run as bounded statements of at most 2,000 rows with writers between them.
 */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitStream, hardenedStreamComplete, NulRecordSplitter } from '../hardened-git.ts';
import { matchesAnyGlob, isSyncable, readMetafilePagesMode } from '../sync.ts';
import { levelMetafilePages } from '../sync-metafile-pages.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { resolveSlugForPath } from '../sync.ts';
import { join } from 'node:path';
import { hasUnresolvedDbOnlyDeclaration, isDeclaredDbOnlySlug, isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../company-brain/profile.ts';
import { sha256 } from './digest.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { colonFileRefusal, COLON_REFUSAL_MESSAGES, readSyncFile, resolveManagedSyncContext, syncExcludePatterns, syncGitAsync, type ManagedSyncContext, type SyncFileRefusal } from './sync-discovery.ts';
import { isWindowsColonTarget } from './native-file-target.ts';
import { confirmedSyncDelta } from '../sync-rename-identity.ts';
import { fileDriftSide, holdBasisMoved, holdRescreenDue, type DeletionCandidate, readGitHoldRetryPaths, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP, syncImportParser, syncImportParsers,
  type GitHoldRecord, type SyncImportParser, type SyncImportProvenance } from './sync-holds.ts';
import { movedDriftHolds, sameParser } from './sync-prescreen.ts';
import { sameSyncOrigin, selectOriginClaimant, syncOriginPath, type SyncOriginScope } from './sync-origin.ts';
import { hashWorkingLevel, probeDirtiness, readBlobs, readIndexDelta, readIndexLevel, readTreeLevel, workingChanged, type GitIndexEntry, type GitTreeEntry, type WorkingStatCache } from './sync-git-stream.ts';
import { readOriginEvidence } from './sync-origin-evidence.ts';
import { levelReuseVerify, readTreeLevelReusing, reportLevelReuseCheck, type TreeReuse } from './sync-tree-reuse.ts';
import { classifySyncPath, syncPassKind, type SyncClassified, type SyncIdleBlocker, type SyncPathState } from './sync-classify.ts';
import { buildConvergenceReceipt, readOnlySameContentScreen, type ConvergenceReceipt, type ConvergenceScreen } from './sync-convergence.ts';
import { readManagedMode } from './ownership.ts';
import { MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP, type SyncSelection } from './sync-pass-row.ts';
import { faultPoint } from './fault-points.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { filterYielding, loopYield, progressYield, sortYielding, turnYield, whileActive, type LoopYield } from './sync-yield.ts';
import { countsMatch, proveConfirm, readLevelMark, type ConfirmProof, type LevelMark } from './sync-pass-confirm.ts';
import { domainCache, levelDomain, narrowedWalk, walkAttestations, type LevelDomainCache } from './sync-pass-narrow.ts';

export { MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP };

/** What a live pass feeds the level read (sync-pass-run.ts): its episode, the retry paths it already re-screened, and its selection. */
export interface PassLevelInput {
  /**
   * The open episode's `full_id`: a live page whose record carries another is `episodeUnsatisfied` (a current one satisfies it
   * in place, sync-classify.ts `inPlace`, and keeps its record). Null: no full obligation.
   */
  episodeFullId: string | null;
  /** Hold paths (source-relative) whose retry row this pass already re-screened: no longer `retried` in its later rounds. */
  retryConsumed?: ReadonlySet<string>;
  exclude?: readonly string[];
  includeHidden?: readonly string[];
  strategy?: string;
  /**
   * The incarnation's first pass (no pass row yet): a page-less path whose level equals its baseline blob and whose slug a
   * committed deletion names reads a virtual `legacy` marker, which the pass then writes (design §2.7, b1). After it, only
   * stored markers count.
   */
  bootstrap?: boolean;
  /** The pass imports without the schema pack (`no-schema-pack` or an episode carrying it): its parser expects no pack. */
  noSchemaPack?: boolean;
  /** #6694: the slug-root mode an unstamped pass of this source admitted under (`obligations.slug_mode`); a subdirectory source reads under it, not its pin. */
  slugMode?: 'git-root' | 'source-root';
  /** The pass's own cache (it dies with the pass): the eligible tree of the commit and selection its last round read. */
  cache?: PassLevelCache;
  /** `sync.level_reuse` (read once per pass): the round may patch the `T` listing the last pass of this process kept (sync-tree-reuse.ts). */
  levelReuse?: boolean;
  /** The pass's id: a round after the first reuses the cached `I⋈P` when its writes are all the database changed (sync-pass-confirm.ts). */
  passId?: string;
  /** The pages whose import record the pass's previous round wrote (sync-pass-apply.ts `recorded`). */
  recorded?: ReadonlySet<number>;
  /** #7355: called while the read works (its loops' pauses, at most once a second, and the origin history walk), so the drain sees progress before the first commit. */
  onProgress?: () => void;
  /** Throws once the pass must stop (a job deadline, a lost drain lease): checked at the read's pauses and while its origin history walk runs. */
  assertActive?: () => void;
}
/** PGLite's keyset page size (design v3.2 §2.1). */
const PGLITE_KEYSET_ROWS = 2_000;
/**
 * Rows per `FETCH` of Postgres's `I⋈P` cursor, `POSTGRES_FETCHES_AHEAD` in flight. The driver decodes every row that
 * reached the socket in one read as one stretch the event loop cannot break (about 4.4 µs a row), and the read's decode is
 * slower than the server, so the results in flight arrive together: their rows bound the stretch. 16k rows in flight
 * decode in about 70 ms (4 × 8k held timers for 135 ms at 600k pages and 5 ms RTT) and still take longer to decode than a
 * 57 ms round trip, so the queued fetches keep the round trips off the read's critical path.
 */
const POSTGRES_FETCH_ROWS = 4_000, POSTGRES_FETCHES_AHEAD = 4;
/** Blob bytes read for adoption by hash and the screen, per blob. */
const LEVEL_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_WRITE_KINDS = ['managed_sync_import', 'managed_sync_delete'];

/** What one pass reuses between its rounds: a commit's tree never changes, so the next round at the same commit and selection reads it from here. */
export interface PassLevelCache {
  tree?: { key: string; tree: Map<string, GitTreeEntry>; colon: string[] };
  /**
   * The last committed-mode round's `I⋈P` and its mark (S1), keyed by source, incarnation, worktree, HEAD and expected parser;
   * `across`: the last pass's, kept by its process (sync-tree-reuse.ts), keyed without HEAD (`acrossKey`).
   */
  pages?: { key: string; acrossKey: string; mark: LevelMark; table: PageTable; across?: true };
  /** The last committed-mode round's classified paths, keyed by every level-wide input the classifier reads (`classifiedKey`). */
  classified?: { key: string; treeKey: string; paths: ShadowPath[] };
  /** The last committed-mode round's origin domain, which a taken confirm round at its tree patches (sync-pass-narrow.ts). */
  domain?: LevelDomainCache;
}

/**
 * Classifier results never change once made (a settle replaces the object), so equal ones are one object: a 600k-path
 * level holds a handful instead of one per path. Bounded; a result past the bound stays its own.
 */
const SHARED_RESULTS = new Map<string, SyncClassified>();
/**
 * The last shared result of each class with its keys in order: most paths of a level repeat it, and a match on the same
 * keys in the same order with the same primitive values (what `JSON.stringify` would key alike) allocates nothing.
 */
const LAST_SHARED = new Map<string, { result: SyncClassified; keys: string[] }>();
const sameFlat = (last: { result: SyncClassified; keys: string[] }, b: SyncClassified): boolean => {
  const a = last.result as unknown as Record<string, unknown>, other = b as unknown as Record<string, unknown>;
  let i = 0;
  for (const key in other) {
    const value = other[key];
    if (last.keys[i++] !== key || value === undefined || typeof value === 'object' && value !== null || a[key] !== value) return false;
  }
  return i === last.keys.length;
};
const rememberShared = (result: SyncClassified) => LAST_SHARED.set(result.cls, { result, keys: Object.keys(result) });
function sharedResult(result: SyncClassified): SyncClassified {
  const last = LAST_SHARED.get(result.cls);
  if (last && sameFlat(last, result)) return last.result;
  const key = JSON.stringify(result);
  const shared = SHARED_RESULTS.get(key);
  if (shared) { rememberShared(shared); return shared; }
  if (SHARED_RESULTS.size < 256) { SHARED_RESULTS.set(key, Object.freeze(result) as SyncClassified); rememberShared(result); }
  return result;
}

/** One classified path of the shadow level. */
export interface ShadowPath { path: string; slug: string | null; pageId: number | null; revision: string | null; state: SyncPathState; result: SyncClassified;
  /** A page-less path unchanged since the baseline whose page a committed request deleted: the bootstrap writes it a `legacy` marker (`legacy_pageless`). */
  legacyPageless?: true;
  /** #6517 (`selectOriginClaimant`): several live pages, or no live page and several tombstones, record this origin. */
  ambiguousOrigin?: { kind: 'several_live' | 'several_tombstones'; slugs: string[]; ids: number[] } }

/**
 * A `matched` path whose state is the converged one (a live page whose record proves the level's blob and revision, nothing
 * held, marked, owed or open): it keeps the few fields that vary and rebuilds the same `SyncPathState` on read. Most paths
 * of a large converged source are these; a level of 600k holds them in about a fifth of a full entry's memory.
 */
class MatchedPath implements ShadowPath {
  constructor(public path: string, public slug: string | null, public pageId: number | null, public revision: string, public result: SyncClassified,
    readonly treeOid: string | null, readonly levelOid: string, private readonly dirty: SyncPathState['dirty'], private readonly diskRecorded: boolean,
    private readonly shared: { mode: SyncPathState['mode']; fullObligation: boolean }) {}

  /** Whether `state` is the one `state` would rebuild for a page at `revision`. */
  static fits(state: SyncPathState, revision: string | null, shared: MatchedPath['shared']): revision is string {
    return revision !== null && state.mode === shared.mode && state.fullObligation === shared.fullObligation && state.level !== null && state.present
      && state.diskOid === null && state.levelSha256 === null && !state.published && state.attested === null && state.hold === null && state.marker === null
      && state.baseline === null && !state.spelling && !state.episodeUnsatisfied && !state.keepDb && !state.openWork
      && state.page?.live === true && state.page.revision === revision && state.page.originMatches
      && state.record?.revision === revision && state.record.parserSame && state.record.blobOids.length <= 2 && state.record.blobOids.length > 0
      && state.record.blobOids.every(oid => oid === state.level);
  }

  get state(): SyncPathState {
    return { mode: this.shared.mode, tree: this.treeOid, level: this.levelOid, present: true, dirty: this.dirty, diskOid: null,
      page: { live: true, revision: this.revision, originMatches: true }, record: { blobOids: this.diskRecorded ? [this.levelOid, this.levelOid] : [this.levelOid], revision: this.revision, parserSame: true },
      attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false, episodeUnsatisfied: false,
      fullObligation: this.shared.fullObligation, keepDb: false, openWork: false };
  }

  set state(value: SyncPathState) {
    Object.defineProperty(this, 'state', { value, writable: true, enumerable: true, configurable: true });
  }
}

/** Whether `entry` is a compact converged `matched` path: its state is a live page at its level, with no marker, hold or open work. */
export const isCompactMatched = (entry: ShadowPath): boolean => entry instanceof MatchedPath;

/**
 * A taken confirm round's classification reuse: the previous round's compact `matched` path, kept when nothing the
 * classifier reads for it can have changed; any other path is classified again. The level-wide inputs are the cache key
 * (`classified.key`: the commit and selection, the mode, the episode and full obligation, mirror and keep_db, the schema
 * pack, the baseline commit, the bootstrap and the ':' refusals). The per-path inputs are `unchanged`'s test, each read
 * from this round (`matchedUnchanged`). The entry's result must be the classifier's own (frozen; one the previous round's
 * apply settled over is not). The walk follows both rounds' sorted order.
 */
function reusableMatched(prior: ShadowPath[], unchanged: (entry: MatchedPath) => boolean): (path: string) => MatchedPath | undefined {
  let k = 0;
  return path => {
    while (k < prior.length && prior[k]!.path < path) k++;
    const entry = prior[k];
    return entry instanceof MatchedPath && entry.path === path && Object.isFrozen(entry.result) && entry.result.cls === 'matched' && unchanged(entry) ? entry : undefined;
  };
}

/**
 * The per-path inputs of a reused `matched` path, as this round read them:
 * - `I⋈P`: the confirm round did not re-read the origin's page (`changed`: a rewritten page's old and new origin, a new
 *   page's), the origin has one claimant and it is the entry's page, and this round's `A` read nothing for it;
 * - `T`: the tree entry is the entry's (the same commit, so it is; checked anyway);
 * - `X`: the index does not differ from `T` at the path (a staged path is a dirtiness candidate);
 * - `U_db`: no open request or pending Git effect names the page or the origin;
 * - holds and markers: none at the path or its origin (a hold's re-screen, retry and moved basis come with it);
 * - spelling: the path is no spelling twin and no settled legacy spelling.
 * A `matched` path has no attestation, disk bytes, baseline or withheld delete, and its episode, keep_db and parser
 * verdicts come from its page and the key.
 */
function matchedUnchanged(level: { pages: PageTable; tree: Map<string, GitTreeEntry>; byOrigin: Map<string, number>; claimants: Map<string, number[]>; changed: Set<string>;
  holds: Map<string, unknown>; markers: Map<string, unknown>; open: { pageIds: Set<number>; origins: Set<string> }; indexDelta: Map<string, unknown> | null;
  spelled: (path: string) => boolean; originOf: (path: string) => string }): (entry: MatchedPath) => boolean {
  return entry => {
    const path = entry.path, at = level.byOrigin.get(path);
    if (at === undefined || Number(level.pages.id[at]) !== entry.pageId || level.pages.attested.has(at) || level.claimants.has(path) || level.changed.has(path)) return false;
    if (level.tree.get(path)?.oid !== entry.levelOid || entry.treeOid !== entry.levelOid) return false;
    if (level.holds.has(path) || level.indexDelta?.has(path) || level.spelled(path) || level.open.pageIds.has(entry.pageId!)) return false;
    if (!level.markers.size && !level.open.origins.size) return true;
    const origin = level.originOf(path);
    return !level.markers.has(origin) && !level.open.origins.has(origin);
  };
}

/**
 * `matchedUnchanged`'s tests a narrowed round runs on every entry it keeps (sync-pass-narrow.ts `narrowedWalk`): the ones
 * on the entry and the round's open work and markers. The rest are tests on paths, which the round classifies again.
 */
function keptUnread(open: { pageIds: Set<number>; origins: Set<string> }, markers: Map<string, unknown>, originOf: (path: string) => string): (entry: ShadowPath) => boolean {
  return entry => entry instanceof MatchedPath && Object.isFrozen(entry.result) && entry.result.cls === 'matched' && entry.treeOid === entry.levelOid && !open.pageIds.has(entry.pageId!)
    && ((!markers.size && !open.origins.size) || (!markers.has(originOf(entry.path)) && !open.origins.has(originOf(entry.path))));
}

/** The origins (`keyOf`) whose page a confirm round re-read: a rewritten page's previous and current one, and each new page's. */
function confirmChangedPaths(pages: PageTable, changed: { rewritten: Array<{ slot: number; sourcePath: string; slug: string }>; from: number }, keyOf: (sourcePath: string, slug: string) => string): Set<string> {
  const paths = new Set<string>();
  for (const row of changed.rewritten) { paths.add(keyOf(row.sourcePath, row.slug)); paths.add(keyOf(pages.sourcePath[row.slot]!, pages.slug[row.slot]!)); }
  for (let i = changed.from; i < pages.length; i++) paths.add(keyOf(pages.sourcePath[i]!, pages.slug[i]!));
  return paths;
}

/** The path's level `L`: committed mode's tree blob, working mode's probe verdict (design v3.2 §2.1). */
function levelReader(mode: 'committed' | 'working', tree: Map<string, GitTreeEntry>, root: string, scope: string) {
  return (path: string, probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): string | null => {
    const committed = tree.get(path) ?? null;
    return mode === 'committed' ? committed?.oid ?? null
      : !probe || probe.dp === 'deleted' ? null
      : ['clean', 'clean_eol', 'clean_lfs'].includes(probe.dp) ? committed?.oid ?? probe.rawOid
      // A path in neither T nor the index (untracked) or only staged has no `deleted` verdict: no bytes and no file is absent.
      : probe.rawOid ?? (probe.rawSha256 === null && !readPresent(root, path, scope) ? null : `unreadable:${path}`);
  };
}

export interface ShadowLevel {
  sourceId: string; incarnation: string; root: string; gitRoot: string; scope: string; slugMode: 'git-root' | 'source-root';
  mode: 'committed' | 'working'; head: string; baselineCommit: string | null; full: boolean;
  /** G3: the source is strict (`config.canonical = "git"`): the level is the commit alone and Git wins (sync-classify.ts). */
  strict: boolean;
  kind: 'idle' | 'hold_only' | 'full'; kindBlockers: SyncIdleBlocker[];
  paths: ShadowPath[];
  /** The schema pack in effect (the pass's `pack` fingerprint) and the selection the level read (design §6). */
  pack: string | null;
  selection: SyncSelection;
  /** Re-screen-due hold paths (Git-root paths): a hold-only round's candidates. */
  rescreenDue: string[];
  /** Held renames (#5988), by the held destination's Git path: the destination still owes its page the move, and the origin's deletion waits for the hold. */
  heldRenames: Array<{ path: string; rename: { sourcePath: string; slug: string; pageId: number; revision: string } }>;
  /** Holds on paths outside the level's domain (no file at L, no page, or no longer eligible): the stamp releases them, as discovery did (#6278 B7). */
  releasableHolds: string[];
  /**
   * GBRA-133: deleted-side `file_drift` holds whose file is gone from `L` and the disk. The stamp releases each whose page is
   * no longer live (`settledDeletionHolds`): a soft delete, a purge or the file's removal decided it.
   */
  deletionCandidates: DeletionCandidate[];
  /** Working mode: the stat cache this round's rehash left (`hashWorkingLevel`); the stamp's round is the one a pass remembers. */
  workingCache: WorkingStatCache | null;
  /** Live file-backed pages whose origin is eligible: the mass-delete valve's denominator (#2828). */
  reconcilable: number;
  /** #5032: Windows-unstorable ':' paths this level left out, each with its named refusal (`SyncResult.fileRefusals`). */
  fileRefusals?: SyncFileRefusal[];
  timings_ms: Record<string, number>;
  statements: number;
  /** A round after a pass's first: whether it reused the previous round's `I⋈P` (`rows` re-read), or why it read it whole. */
  confirm?: { taken: boolean; reason: string | null; rows: number; across?: true;
    /** A taken confirm round: `taken` when it patched the previous round's domain and classification, else why it built them whole. */
    narrow?: string };
  /** A taken confirm round: the paths whose previous-round classification it kept (`reusableMatched`). */
  reused?: number;
  /** How a round that listed `T` got it (sync-tree-reuse.ts): read whole, the last pass's listing at the same commit, or that listing patched. */
  treeReuse?: TreeReuse;
}

/** A page of the source with the import-record fields the classifier reads; `arm1` / `attested_hash` (`A`) are filled for the pages that need a proof. */
interface PageRow { id: number | string; slug: string; source_path: string; revision: string; deleted: boolean; request_id: string | null;
  record: (Pick<SyncImportProvenance, 'origin' | 'blob_oid' | 'disk_blob_oid' | 'revision' | 'parser' | 'working'> & { full_episode?: string | null }) | null; arm1: boolean | null; attested_hash: string | null }

/** The record's blob ids; one equal to `level` is `level`'s own string, so a converged page keeps one copy of its blob id. */
const recordOids = (record: PageRow['record'], level?: string | null): string[] => {
  const oids: string[] = [];
  for (const oid of record ? [record.blob_oid, record.disk_blob_oid] : []) if (typeof oid === 'string' && oid.length > 0) oids.push(oid === level ? level : oid);
  return oids;
};

/** Whether the record names `oid` among its blob ids (`recordOids(record).includes(oid)` without the array). */
const recordNames = (record: PageRow['record'], oid: string | null): boolean => !!record && typeof oid === 'string' && oid.length > 0
  && (record.blob_oid === oid || record.disk_blob_oid === oid);

const PAGE_DELETED = 1, PAGE_RECORD = 2, PAGE_REVISION_NULL = 4, PAGE_PARSER_EXPECTED = 8, PAGE_WORKING = 16, PAGE_WORKING_TRUE = 32, PAGE_DERIVED_CURRENT = 64;

/**
 * `I⋈P` as columns, one slot per page, instead of a `PageRow` and a record object per page (about 200 B a page at 600k). A
 * record field that differs from its usual value (origin = source_path, disk = blob, revision = the page's, the expected
 * parser) is kept only for the pages where it does; `row` rebuilds the `PageRow` the classifier reads.
 */
export class PageTable {
  readonly id: Array<number | string> = []; readonly slug: string[] = []; readonly sourcePath: string[] = []; readonly revision: string[] = [];
  readonly requestId: Array<string | null> = []; readonly bits: number[] = []; readonly blobOid: Array<string | undefined> = []; readonly fullEpisode: Array<string | null> = [];
  readonly origin = new Map<number, string>(); readonly diskBlobOid = new Map<number, string | null>(); readonly recordRevision = new Map<number, string>();
  readonly parser = new Map<number, SyncImportProvenance['parser']>(); readonly attested = new Map<number, { arm1: boolean; hash: string | null }>();
  constructor(private readonly expected: SyncImportParser) {}
  get length(): number { return this.id.length; }
  deleted(i: number): boolean { return (this.bits[i]! & PAGE_DELETED) !== 0; }
  hasRecord(i: number): boolean { return (this.bits[i]! & PAGE_RECORD) !== 0; }
  /** `SyncPathState.derivedCurrent`: the page's chunks, text projection and contextual mode are current (`readPages`). */
  derivedCurrent(i: number): boolean { return (this.bits[i]! & PAGE_DERIVED_CURRENT) !== 0; }
  /** The record's fields `row(i).record` would carry (undefined without a record), read without building it: the classifier's per-path reads. */
  diskBlobOidOf(i: number): string | null | undefined { return !this.hasRecord(i) ? undefined : this.diskBlobOid.has(i) ? this.diskBlobOid.get(i)! : this.blobOid[i] ?? null; }
  recordRevisionOf(i: number): string | undefined { return !this.hasRecord(i) || this.bits[i]! & PAGE_REVISION_NULL ? undefined : this.recordRevision.get(i) ?? this.revision[i]!; }
  workingOf(i: number): boolean | undefined { return this.hasRecord(i) && this.bits[i]! & PAGE_WORKING ? (this.bits[i]! & PAGE_WORKING_TRUE) !== 0 : undefined; }
  parserOf(i: number): SyncImportProvenance['parser'] | undefined { return !this.hasRecord(i) ? undefined : this.bits[i]! & PAGE_PARSER_EXPECTED ? this.expected : this.parser.get(i); }
  /** `recordOids(row(i).record, level)` / `recordNames(row(i).record, oid)`. */
  oids(i: number, level?: string | null): string[] {
    const oids: string[] = [];
    if (!this.hasRecord(i)) return oids;
    const blob = this.blobOid[i], disk = this.diskBlobOidOf(i);
    if (typeof blob === 'string' && blob.length > 0) oids.push(blob === level ? level : blob);
    if (typeof disk === 'string' && disk.length > 0) oids.push(disk === level ? level : disk);
    return oids;
  }
  names(i: number, oid: string | null): boolean { return this.hasRecord(i) && typeof oid === 'string' && oid.length > 0 && (this.blobOid[i] === oid || this.diskBlobOidOf(i) === oid); }
  row(i: number): PageRow {
    const bits = this.bits[i]!, revision = this.revision[i]!, blob = this.blobOid[i], attested = this.attested.get(i);
    return { id: this.id[i]!, slug: this.slug[i]!, source_path: this.sourcePath[i]!, revision, deleted: (bits & PAGE_DELETED) !== 0, request_id: this.requestId[i]!,
      arm1: attested ? attested.arm1 : null, attested_hash: attested ? attested.hash : null,
      record: bits & PAGE_RECORD ? { origin: this.origin.get(i) ?? this.sourcePath[i]!, blob_oid: blob, disk_blob_oid: this.diskBlobOid.has(i) ? this.diskBlobOid.get(i)! : blob ?? null,
        revision: bits & PAGE_REVISION_NULL ? undefined : this.recordRevision.get(i) ?? revision, parser: bits & PAGE_PARSER_EXPECTED ? this.expected : this.parser.get(i),
        full_episode: this.fullEpisode[i]!, ...(bits & PAGE_WORKING ? { working: (bits & PAGE_WORKING_TRUE) !== 0 } : {}) } : null };
  }
}

type Exec = Pick<BrainEngine, 'executeRaw'>;

/**
 * Runs `fn` over the round's database reads: one `REPEATABLE READ, READ ONLY` snapshot on Postgres; on PGLite (one
 * connection, one transaction at a time) each statement runs on its own so writers and lease renewals interleave.
 */
async function withRoundSnapshot<T>(engine: BrainEngine, fn: (exec: Exec) => Promise<T>): Promise<T> {
  if (engine.kind === 'pglite') return fn(engine);
  return engine.transaction(async tx => {
    const isolation = tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const read = fn(tx);
    try { await isolation; } catch (error) { read.catch(() => undefined); throw error; }
    return read;
  });
}

/**
 * `I⋈P`: every page of the source with a recorded origin and the fields of its import record the classifier reads. Postgres
 * plans it as one set-based statement inside the round's snapshot (the planner hash-joins pages with their records; a
 * keyset with a per-row primary-key probe made the 61k read plan-bound, about 1.7 s of server time) and reads it through a
 * cursor, `POSTGRES_FETCH_ROWS` at a time with `POSTGRES_FETCHES_AHEAD` in flight: one result of 600k rows decoded in a single
 * stretch of about a second and held every raw row at once. `cursor_tuple_fraction = 1` keeps the whole-result plan.
 * PGLite reads bounded keyset statements so writers interleave.
 */
async function readPages(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string, expected: SyncImportParser,
  only?: { table: PageTable; ids: string[]; slots: Map<string, number> }, step: LoopYield = loopYield()): Promise<{ pages: PageTable; statements: number } | null> {
  // A record's fields usually repeat the page's (origin = source_path, disk = blob, revision = the page's), so those come back
  // as a flag instead of a second copy of the string, and so does the parser when it is the Markdown one the level expects
  // (`expected`, the same object for every such page; any other comes as text parsed once per distinct value): a 600k-page
  // read then holds about one string per field per page and decodes no parser text per page.
  // The record's fields come out of its JSON once, in a subquery. On Postgres `OFFSET 0` keeps it unflattened, so the hash
  // join builds over those few text columns instead of the whole record (600k: about 3.1 s of serial server time to 2.0 s);
  // PGLite's keyset statements and a confirm round's few rows need it flattened, so each probes the record by primary key.
  const select = `SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
      p.revision_write_request_id::text AS request_id, c.fingerprint IS NOT NULL AS has_record,
      c.origin IS NOT DISTINCT FROM p.source_path AS rec_origin_same,
      CASE WHEN c.origin IS DISTINCT FROM p.source_path THEN c.origin END AS rec_origin,
      c.blob_oid AS rec_blob_oid,
      c.disk_blob_oid IS NOT DISTINCT FROM c.blob_oid AS rec_disk_same,
      CASE WHEN c.disk_blob_oid IS DISTINCT FROM c.blob_oid THEN c.disk_blob_oid END AS rec_disk_blob_oid,
      c.revision IS NULL AS rec_revision_null,
      NULLIF(c.revision, p.knowledge_revision::text) AS rec_revision,
      CASE WHEN c.parser IS DISTINCT FROM $4::jsonb THEN c.parser::text END AS rec_parser, c.parser = $4::jsonb AS rec_parser_expected,
      c.full_episode AS rec_full_episode, c.working AS rec_working,
      (p.page_kind = 'markdown' AND p.chunker_version = ${MARKDOWN_CHUNKER_VERSION} AND p.body_storage IS DISTINCT FROM 'segmented'
        AND p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AND p.contextual_retrieval_mode IS NOT NULL) AS derived_current
    FROM pages p LEFT JOIN (SELECT fingerprint, completed_keys->0->>'origin' AS origin, completed_keys->0->>'blob_oid' AS blob_oid,
        completed_keys->0->>'disk_blob_oid' AS disk_blob_oid, completed_keys->0->>'revision' AS revision,
        completed_keys->0->'parser' AS parser, completed_keys->0->>'full_episode' AS full_episode, (completed_keys->0->'working')::text AS working
      FROM op_checkpoints WHERE op=$2${kind === 'postgres' && !only ? ' OFFSET 0' : ''}) c ON c.fingerprint=$3||p.id::text
    WHERE p.source_id=$1 AND p.source_path IS NOT NULL`;
  const params = [sourceId, SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${incarnation}:`, JSON.stringify(expected)];
  type Raw = Omit<PageRow, 'record' | 'arm1' | 'attested_hash'> & { has_record: boolean; rec_origin_same: boolean; rec_origin: string | null; rec_blob_oid: string | null;
    rec_disk_same: boolean; rec_disk_blob_oid: string | null; rec_revision_null: boolean; rec_revision: string | null; rec_parser: string | null; rec_parser_expected: boolean | null; rec_full_episode: string | null; rec_working: string | null; derived_current: boolean | null };
  const pages = only?.table ?? new PageTable(expected);
  const parsers = new Map<string, SyncImportProvenance['parser'] | undefined>(), episodes = new Map<string, string>();
  const parserOf = (text: string | null) => {
    if (text === null) return undefined;
    if (!parsers.has(text)) parsers.set(text, JSON.parse(text) ?? undefined);
    return parsers.get(text);
  };
  /** Writes `raw` to slot `i`: the next one, or (a confirm round) the slot of a page the pass rewrote. */
  const put = (raw: Raw, i: number) => {
    const working = raw.rec_working === 'true' || raw.rec_working === 'false';
    pages.id[i] = raw.id; pages.slug[i] = raw.slug; pages.sourcePath[i] = raw.source_path; pages.revision[i] = raw.revision; pages.requestId[i] = raw.request_id;
    pages.bits[i] = (raw.deleted ? PAGE_DELETED : 0) | (raw.has_record ? PAGE_RECORD : 0) | (raw.rec_revision_null ? PAGE_REVISION_NULL : 0)
      | (raw.rec_parser_expected ? PAGE_PARSER_EXPECTED : 0) | (working ? PAGE_WORKING : 0) | (raw.rec_working === 'true' ? PAGE_WORKING_TRUE : 0)
      | (raw.derived_current ? PAGE_DERIVED_CURRENT : 0);
    const episode = raw.has_record ? raw.rec_full_episode : null;
    if (typeof episode === 'string' && !episodes.has(episode)) episodes.set(episode, episode);
    pages.blobOid[i] = raw.has_record ? raw.rec_blob_oid ?? undefined : undefined; pages.fullEpisode[i] = typeof episode === 'string' ? episodes.get(episode)! : episode;
    if (only) for (const sparse of [pages.origin, pages.diskBlobOid, pages.recordRevision, pages.parser]) sparse.delete(i);
    if (!raw.has_record) return;
    if (!raw.rec_origin_same) pages.origin.set(i, raw.rec_origin ?? '');
    if (!raw.rec_disk_same) pages.diskBlobOid.set(i, raw.rec_disk_blob_oid);
    if (raw.rec_revision !== null) pages.recordRevision.set(i, raw.rec_revision);
    const parser = raw.rec_parser_expected ? undefined : parserOf(raw.rec_parser);
    if (parser !== undefined) pages.parser.set(i, parser);
  };
  const take = (page: Raw[]) => { for (const raw of page) put(raw, pages.length); };
  // A result in hand waits a turn when the turn already ran the budget (`step` is the level's, shared with its Git reads):
  // its rows are not taken right after a Git chunk, or after a decode that spent the turn.
  const turn = async () => { await faultPoint('sync:level_result'); if (step.over()) await step.pause(); await faultPoint('sync:level_take'); };
  if (only) {
    // A confirm round: the previous round's rows, with the pages the pass wrote re-read into their slots (a new page last,
    // as the keyset would read it). A rewritten page that left `I⋈P` cannot be patched: the caller reads it whole.
    const rows = await exec.executeRaw<Raw>(`${select} AND p.id = ANY($5::bigint[]) ORDER BY p.id`, [...params, only.ids]);
    const read = new Set(rows.map(raw => String(raw.id)));
    if ([...only.slots.keys()].some(id => !read.has(id))) return null;
    for (const raw of rows) put(raw, only.slots.get(String(raw.id)) ?? pages.length);
    return { pages, statements: 1 };
  }
  let statements = 0;
  if (kind === 'postgres') {
    const declared = Promise.all([exec.executeRaw('SET LOCAL cursor_tuple_fraction = 1'), exec.executeRaw(`DECLARE sync_pass_pages NO SCROLL CURSOR FOR ${select}`, params)]);
    declared.catch(() => undefined);
    statements += 2;
    // A queued fetch is awaited in turn; its own catch only keeps a failure behind an earlier one from going unhandled.
    const fetch = () => { statements++; const page = exec.executeRaw<Raw>(`FETCH ${POSTGRES_FETCH_ROWS} FROM sync_pass_pages`); page.catch(() => undefined); return page; };
    const ahead = Array.from({ length: POSTGRES_FETCHES_AHEAD }, fetch);
    await declared;
    for (;;) {
      const page = await ahead.shift()!;
      const more = page.length === POSTGRES_FETCH_ROWS;
      if (more) ahead.push(fetch());
      await turn();
      take(page);
      if (!more) { for (const queued of ahead) await queued; return { pages, statements }; }
      await step.pause();
    }
  }
  let after = 0;
  for (;;) {
    statements++;
    const page = await exec.executeRaw<Raw>(`${select} AND p.id>$5 ORDER BY p.id LIMIT ${PGLITE_KEYSET_ROWS}`, [...params, after]);
    await turn();
    take(page);
    if (page.length < PGLITE_KEYSET_ROWS) return { pages, statements };
    after = Number(page[page.length - 1]!.id);
  }
}

/**
 * `A` for the given pages: whether the page's current revision came from a committed sync write of this incarnation (arm 1)
 * and the hash its Git effect expects, or (a managed file import of the canonical file itself, `inputHash = targetHash`) the
 * hash of the file bytes it imported: either way the revision is file-backed. A committed request and its effect never change, so this reads by the request id
 * the snapshot returned, after the level is known; the answer is the one the snapshot would have given.
 */
async function readAttestations(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string, pages: PageTable, rows: number[]): Promise<number> {
  const size = kind === 'postgres' ? 10_000 : PGLITE_KEYSET_ROWS;
  const byId = new Map(rows.map(row => [Number(pages.id[row]), row]));
  let statements = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    statements++;
    const found = await readRevisionAttestations(exec, sourceId, incarnation, chunk.map(row => ({ pageId: Number(pages.id[row]), requestId: pages.requestId[row] ?? null,
      revision: pages.revision[row]!, sourcePath: pages.sourcePath[row] ?? null })));
    for (const hit of found) pages.attested.set(byId.get(Number(hit.page_id))!, { arm1: hit.arm1, hash: hit.attested_hash });
  }
  return statements;
}

/** `A` for one statement's pages, by the request that wrote each page's current revision (see `readAttestations`); a page with no committed request has no row. */
export async function readRevisionAttestations(exec: Exec, sourceId: string, incarnation: string,
  rows: ReadonlyArray<{ pageId: number; requestId: string | null; revision: string; sourcePath: string | null }>): Promise<Array<{ page_id: number; arm1: boolean; attested_hash: string | null }>> {
  return exec.executeRaw<{ page_id: number; arm1: boolean; attested_hash: string | null }>(`SELECT x.page_id,
        (r.intent->>'kind' = ANY($3::text[]) AND r.source_incarnation::text=$2 AND (r.page_id IS NULL OR r.page_id=x.page_id)) AS arm1,
        COALESCE((SELECT e.data->>'expected_hash' FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=x.revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=x.source_path OR right(e.data->>'relative_path', length(x.source_path)+1)='/'||x.source_path) LIMIT 1),
          CASE WHEN r.intent->>'kind'='managed_file_import' AND r.intent->>'sourcePath'=x.source_path AND r.intent->>'inputHash'=r.intent->>'targetHash' THEN r.intent->>'targetHash' END) AS attested_hash
      FROM unnest($4::int[], $5::uuid[], $6::uuid[], $7::text[]) AS x(page_id, request_id, revision, source_path)
      JOIN persistence_requests r ON r.id=x.request_id AND r.state='committed' AND r.source_id=$1`,
      [sourceId, incarnation, SYNC_WRITE_KINDS, rows.map(row => row.pageId), rows.map(row => row.requestId), rows.map(row => row.revision), rows.map(row => row.sourcePath)]);
}

/** `U_db`: open requests of the worktree (the `persistence_requests_pending` index) and pending Git effects of the source. */
async function readOpenWork(exec: Exec, sourceId: string, incarnation: string, worktreeId: string): Promise<{ pageIds: Set<number>; origins: Set<string>; statements: number }> {
  // A write admitted with sync.write_through=false carries no worktree (page-mutations.ts), so the incarnation's
  // worktree-less requests are open work too.
  const [requests, effects] = await Promise.all([exec.executeRaw<{ page_id: number | null; source_path: string | null; path: string | null }>(`SELECT page_id, intent->>'sourcePath' AS source_path, intent->>'path' AS path
    FROM persistence_requests WHERE state IN ('queued','running','recovering') AND source_id=$2 AND (worktree_id=$1 OR worktree_id IS NULL AND source_incarnation=$3::uuid)`,
    [worktreeId, sourceId, incarnation]),
  exec.executeRaw<{ page_id: number | null; path: string | null }>(`SELECT r.page_id, e.data->>'relative_path' AS path
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id
    WHERE r.worktree_id=$1 AND r.source_id=$2 AND e.kind='git' AND e.state IN ('queued','running')`, [worktreeId, sourceId])]);
  const pageIds = new Set<number>(), origins = new Set<string>();
  for (const row of [...requests, ...effects]) if (row.page_id != null) pageIds.add(Number(row.page_id));
  for (const row of requests) for (const origin of [row.source_path, row.path]) if (origin && !isWindowsColonTarget(origin)) origins.add(syncOriginPath(origin));
  for (const row of effects) if (row.path && !isWindowsColonTarget(row.path)) origins.add(syncOriginPath(row.path));
  return { pageIds, origins, statements: 2 };
}

/** Deletion markers of the incarnation (a primary-key range read); none exist before PR 4b. */
async function readMarkers(exec: Exec, sourceId: string, incarnation: string): Promise<Map<string, { kind: 'deleted' | 'legacy'; blobOids: string[]; deletion: string | null }>> {
  const prefix = `${sourceId}:${incarnation}:`;
  // `starts_with`, not a range: under a linguistic collation (en_US) a `< prefix || U+FFFF` bound matches nothing.
  const rows = await exec.executeRaw<{ fingerprint: string; value: { kind?: string; blob_oids?: unknown; deletion?: unknown } | null }>(
    'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)',
    [SYNC_ORIGIN_DELETED_OP, prefix]);
  return new Map(rows.filter(row => !isWindowsColonTarget(row.fingerprint.slice(prefix.length))).map(row => [syncOriginPath(row.fingerprint.slice(prefix.length)), {
    kind: row.value?.kind === 'legacy' ? 'legacy' as const : 'deleted' as const,
    blobOids: Array.isArray(row.value?.blob_oids) ? (row.value!.blob_oids as unknown[]).filter((oid): oid is string => typeof oid === 'string') : [],
    deletion: typeof row.value?.deletion === 'string' ? row.value.deletion : null }]));
}

/**
 * Design §2.7 with the parent's b1 ruling: a page-less path unchanged since the baseline is a page deleted before PR 4 only
 * when a committed deleting request of this incarnation names the slug its path imports to (the newest one is the proof). A
 * file sync refused before it ever had a page has none, so it imports.
 */
async function readLegacyDeletions(exec: Exec, sourceId: string, incarnation: string, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const rows = await exec.executeRaw<{ slug: string; id: string }>(`SELECT DISTINCT ON (slug) slug, id::text AS id FROM persistence_requests
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='committed' AND slug=ANY($3::text[])
      AND (operation='delete_page' OR intent->>'kind'='managed_sync_delete') ORDER BY slug, sequence DESC`, [sourceId, incarnation, slugs]);
  return new Map(rows.map(row => [row.slug, row.id]));
}

/** The pass row of the incarnation (PR 4b writes it); null in PR 4a. */
async function readPassRow(exec: Exec, sourceId: string, incarnation: string): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<{ value: Record<string, unknown> | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [MANAGED_SYNC_PASS_OP, `${sourceId}:${incarnation}`]);
  return row?.value ?? null;
}

/** HEAD's commit and whether HEAD is detached (master's rule, sync-discovery.ts: a detached HEAD forces working mode). */
async function readLevelHead(gitRoot: string, sourceId: string): Promise<{ head: string; detached: boolean }> {
  const abbrev = syncGitAsync(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  abbrev.catch(() => undefined);
  const head = await revParse(gitRoot, 'HEAD');
  if (!head) throw new Error(`source ${sourceId}: HEAD does not name a commit, so there is no level to read`);
  return { head, detached: (await abbrev).trim() === 'HEAD' };
}

/** A commit id, through a child process the event loop keeps running beside (a synchronous spawn held timers for 200+ ms on a loaded host). */
async function revParse(gitRoot: string, rev: string): Promise<string | null> {
  const chunks: Buffer[] = [];
  const out = await hardenedGitStream(gitRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeoutMs: 10_000, maxBytes: 4096, onChunk: chunk => { chunks.push(chunk); } });
  return out.ok ? Buffer.concat(chunks).toString('utf8').trim() || null : null;
}

/**
 * #6712 PR 4b (design v3.2 §2.2): a working-mode idle tick's check. Every path the cache vouches for, plus `U` (untracked)
 * and the index's paths in scope, is re-stat'd (`workingChanged`); no cache (a cold process) reads as changed.
 */
export async function workingIdleChange(context: Pick<ManagedSyncContext, 'root' | 'gitRoot'>, cache: WorkingStatCache | null): Promise<{ changed: boolean; cache: WorkingStatCache | null }> {
  if (!cache) return { changed: true, cache: null };
  const scope = relative(realpathSync.native(context.gitRoot), realpathSync.native(context.root)).split(sep).join('/');
  const [untracked, index] = await Promise.all([readUntracked(context.gitRoot, scope), readIndexLevel(context.gitRoot)]);
  const inScope = (path: string) => !scope || path.startsWith(`${scope}/`);
  const checked = workingChanged(cache, [...untracked, ...[...index.keys()].filter(inScope)]);
  return { changed: checked.cache === null || checked.changed.length > 0, cache: checked.cache };
}

/** Working mode's `U`: untracked, not ignored files (index and exclude files only; no worktree conversion). */
async function readUntracked(gitRoot: string, scope: string): Promise<string[]> {
  const paths: string[] = [];
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(gitRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--', scope === '' ? '.' : scope],
    { timeoutMs: 120_000, onChunk: chunk => { for (const record of splitter.push(chunk)) paths.push(record.toString('utf8')); } });
  if (!hardenedStreamComplete(result) || !splitter.atRecordBoundary) throw new Error('git ls-files --others did not finish a complete read');
  return paths;
}

const timer = () => { const started = performance.now(); return () => Math.round((performance.now() - started) * 10) / 10; };

/** #7130: an absent file is deletion evidence only when Git once committed it (sync-origin-evidence.ts); read for those paths alone. */
async function reclassifyByOrigin(gitRoot: string, tips: Array<string | null | undefined>, paths: ShadowPath[], step: LoopYield, strict: boolean, pass?: PassLevelInput): Promise<boolean> {
  const absent = await filterYielding(paths, entry => (entry.result.cls === 'delete' || entry.result.cls === 'delete_drift') && entry.state.originEvidence === undefined, step);
  if (!absent.length) return false;
  // A stopped pass leaves the shared walk running: the next pass joins it, or reads the history it cached.
  pass?.assertActive?.();
  const evidence = await whileActive(readOriginEvidence(gitRoot, tips, absent.map(entry => entry.path), { onCommit: pass?.onProgress }), pass?.assertActive);
  for (const entry of absent) {
    const state = { ...entry.state, originEvidence: evidence.get(entry.path) ?? 'unknown' as const };
    Object.assign(entry, { state, result: classifySyncPath(state, { strict }) });
  }
  return true;
}

/** GBRA-133: the deleted-side `file_drift` holds whose file is gone (`gone`, on the Git path); the stamp releases those whose page is no longer live. */
function deletionCandidates(holds: readonly GitHoldRecord[], gone: (path: string) => boolean, toGit: (path: string) => string): DeletionCandidate[] {
  return holds.filter(hold => hold.code === 'file_drift' && fileDriftSide(hold.meta) === 'deleted' && gone(toGit(hold.path)))
    .map(hold => ({ path: hold.path, page_id: hold.page_id ?? null, slug: hold.slug ?? null }));
}

/**
 * The shadow level of a managed source: every path classified, nothing written. Null for a company-brain source, which
 * keeps its frozen manifest (design v3.2 §3.6).
 */
export async function readShadowLevel(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; context?: ManagedSyncContext; pass?: PassLevelInput }): Promise<ShadowLevel | null> {
  const total = timer();
  const timings: Record<string, number> = {};
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  const { sourceId, incarnation, root, gitRoot } = context;
  const engineKind = engine.kind === 'pglite' ? 'pglite' : 'postgres';
  const nativeRoot = realpathSync.native(root), nativeGitRoot = realpathSync.native(gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  t = timer();
  const settings = await readLevelSettings(engine, context, scope, input);
  timings.setup = t();
  if (!settings) return null;
  const { slugMode, exclude, pack, mirror, strategy, includeHidden, keepDbPrefixes, storage, dbOnlyUnknown, workingConfig, metafilePages, strict } = settings;
  const sourceRelative = (gitPath: string) => (scope ? gitPath.slice(scope.length + 1) : gitPath);
  let metafilePage: (gitPath: string) => boolean = () => false;
  // Eligibility of a path outside the cached tree (every path of the tree is eligible); origins validate per call: a
  // 600k-path level keeps no per-path memo of either.
  const selected = (gitPath: string) => (!scope || gitPath.startsWith(`${scope}/`)) && !matchesAnyGlob(sourceRelative(gitPath), exclude)
    && !isReservedSkillBundlePath(slugMode === 'source-root' ? sourceRelative(gitPath) : gitPath) && isSyncable(gitPath, { strategy: strategy as 'markdown', includeHidden, metafilePage });
  // #5032: a Windows-unstorable ':' path, and the other side of a rename touching one, take no part in the level.
  let colonRefused = new Set<string>();
  const eligible = (gitPath: string) => selected(gitPath) && !isWindowsColonTarget(gitPath) && !colonRefused.has(gitPath);
  const originPath = (path: string) => syncOriginPath(path);
  const originOf = (gitPath: string) => originPath(slugMode === 'source-root' && scope ? sourceRelative(gitPath) : gitPath);
  const gitPathOf = (origin: string) => { const o = originPath(origin); return slugMode === 'source-root' && scope ? `${scope}/${o}` : o; };
  // #5610: a source-root page whose stored origin is the legacy Git-root spelling (`<scope>/<origin>`) names `<origin>`, by
  // the one rule discovery and preparation use (sameSyncOrigin; it refuses an origin that could name two files).
  const originScope = { sourceId, root, scope, slugMode };
  const pageOrigin = (sourcePath: string, slug: string): string => scopedPageOrigin(originPath(sourcePath), slug, originScope);
  const step = progressYield(turnYield(), { onProgress: input.pass?.onProgress, assertActive: input.pass?.assertActive });

  t = timer();
  const { head, detached } = await readLevelHead(gitRoot, sourceId);
  // G3: a strict source's level is its commit, a detached HEAD's too; the working tree never enters it.
  const working = !strict && (detached || (input.workingTree ?? workingConfig === 'true'));
  const mode: 'committed' | 'working' = working ? 'working' : 'committed';
  timings.rev_parse = t();
  const levelMetafiles = levelMetafilePages(metafilePages, gitRoot, [head, context.source.last_commit], working ? nativeGitRoot : null, scope);
  metafilePage = levelMetafiles.metafilePage;

  // A commit's tree never changes: the pass's next round at the same commit and selection reuses the eligible tree.
  const treeKey = JSON.stringify([gitRoot, head, scope, slugMode, strategy, exclude, includeHidden, metafilePages, mode]);
  const cache = input.pass?.cache;
  // The previous round's classification leaves the cache before anything can fail (only a complete round's is stored).
  let priorClassified = cache?.classified?.treeKey === treeKey ? cache.classified : undefined;
  const priorDomain = cache?.domain;
  if (cache) { cache.classified = undefined; cache.domain = undefined; }
  let treeReuse: TreeReuse | undefined;
  // The tree's ':' paths (#5032) are kept apart: they are refused, never part of the level.
  const eligibleTree = async (): Promise<{ tree: Map<string, GitTreeEntry>; colon: string[] }> => {
    if (cache?.tree?.key === treeKey) return cache.tree;
    if (cache) cache.tree = undefined;
    const { tree, colon, reuse } = await eligibleListing(gitRoot, head, scope, { key: [sourceId, incarnation], canonical: strict ? 'git' : 'mixed', allowed: input.pass?.levelReuse === true, step, eligible,
      prime: listing => levelMetafiles.primeTree(listing) });
    treeReuse = reuse;
    if (cache) cache.tree = { key: treeKey, tree, colon };
    return { tree, colon };
  };
  // The Git level, the database snapshot and the holds are independent reads: they overlap, so each key times its own
  // read and `reads` is the wall time of the three together.
  const timed = async <T>(key: string, read: () => Promise<T>): Promise<T> => { const st = timer(); try { return await read(); } finally { timings[key] = st(); } };
  t = timer();
  const [gitLevel, snapshot, held] = await Promise.all([
    // Working mode reads the whole index (its paths join the domain); committed mode only where it differs from T, read
    // after T so the two are never held whole together.
    Promise.all([timed('T', eligibleTree).then(async ({ tree, colon }) => ({ tree, colon, indexDelta: mode === 'committed' ? await timed('X', () => readIndexDelta(gitRoot, tree, step)) : null })),
      mode === 'working' ? timed('X', () => readIndexLevel(gitRoot, step)) : Promise.resolve(new Map<string, GitIndexEntry>()),
      timed('U', async () => (mode === 'working' ? (await readUntracked(gitRoot, scope)).filter(eligible) : []))]),
    // Issued together, the snapshot's statements pipeline on its one connection (PGLite runs them in turn).
    timed('I⋈P', () => readRoundSnapshot(engine, { kind: engineKind, sourceId, incarnation, worktreeId: context.binding.worktree_id, parser: syncImportParser(pack?.identity ?? null), step,
      reuse: cache && input.pass?.passId ? { cache, passId: input.pass.passId, recorded: input.pass.recorded, working: mode === 'working', head } : undefined }, timed)),
    timed('H', () => readLevelHolds(engine, sourceId, incarnation, input.pass?.retryConsumed)),
  ]);
  timings.reads = t();
  const [{ tree: eligibleT, colon: colonTree, indexDelta }, index, untrackedPaths] = gitLevel;
  const colon = await windowsColonRefusals(engine, { sourceId, gitRoot, from: context.source.last_commit, head, colonTree, pages: snapshot.pages, selected,
    gitPathOf: origin => slugMode === 'source-root' && scope ? `${scope}/${origin}` : origin, sourcePathOf: gitPath => (slugMode === 'source-root' ? sourceRelative(gitPath) : gitPath) });
  colonRefused = colon.paths;
  // A rename's other side refused with a ':' path leaves the level too (a copy: the cached tree is the commit's).
  const tree = colonRefused.size ? new Map([...eligibleT].filter(([path]) => !colonRefused.has(path))) : eligibleT;
  // Committed mode: the index entry of a tree path, its own where it differs from T, else T's at stage 0 (undefined: absent).
  const indexed = (path: string): GitIndexEntry | undefined => {
    if (!indexDelta) return index.get(path);
    const delta = indexDelta.get(path);
    if (delta !== undefined) return delta ?? undefined;
    const committed = tree.get(path);
    return committed ? { ...committed, stage: 0 } : undefined;
  };
  const inLevel = (path: string) => tree.has(path) || eligible(path);
  const untracked = new Set(untrackedPaths);
  const { open, markers, passRow, statements, confirm } = snapshot;
  const { holds, retry } = held;
  const toGit = (holdPath: string) => (scope ? `${scope}/${holdPath}` : holdPath);
  const holdByGitPath = new Map<string, GitHoldRecord>(holds.map(hold => [toGit(hold.path), hold]));
  const moved = new Set(held.moved.map(toGit));

  t = timer();
  const pages = snapshot.pages, keyOf = (i: number) => gitPathOf(pageOrigin(pages.sourcePath[i]!, pages.slug[i]!));
  // A taken confirm round at the cached tree patches the previous round's domain at the origins the pass wrote (sync-pass-narrow.ts).
  const narrow = !snapshot.changed ? null : !priorDomain ? 'cache' : mode !== 'committed' || priorDomain.treeKey !== treeKey || priorDomain.table !== pages ? 'key' : process.platform === 'win32' ? 'platform'
    : colonRefused.size ? 'colon' : input.pass?.bootstrap ? 'bootstrap' : await faultPoint('sync:level_narrow', { sourceId }).then(() => 'taken', () => 'forced');
  const levelD = await levelDomain({ pages, tree, keyOf, inLevel, extra: [...untracked, ...(mode === 'working' ? [...index.keys()].filter(inLevel) : [])], markerPaths: [...markers.keys()].map(gitPathOf),
    isFile: path => tree.has(path) || (mode === 'working' && (untracked.has(path) || index.has(path))), originOf, step,
    ...(narrow === 'taken' ? { prior: { cache: priorDomain!, changed: snapshot.changed!, oldKey: (sourcePath: string, slug: string) => gitPathOf(pageOrigin(sourcePath, slug)) } } : {}) });
  const { byOrigin, claimants, domain, twins, twinGroups } = levelD, reconcilable = byOrigin.size - levelD.unreconciled.size;
  const rowAt = (path: string): PageRow | undefined => { const i = byOrigin.get(path); return i === undefined ? undefined : pages.row(i); };
  timings.domain = t();

  // Working mode rehashes every path (the full round's unconditional rehash); committed mode probes candidates only.
  t = timer();
  const hashed = mode === 'working' ? await hashWorkingLevel(root, gitRoot, [...domain], tree) : null;
  const probes = hashed?.probes ?? new Map();
  timings.Dp = t();

  const levelOf = levelReader(mode, tree, root, scope);
  // `A` only matters where the file or the database moved (no row settles on `fileSame ∧ dbSame` with a proof): read it
  // for those pages alone, so a converged source reads none. The same walk finds whether any path needs the baseline tree.
  t = timer();
  const { rows: unproven, wantBaseline } = await walkAttestations(levelD, (path, i) => {
    const level = levelOf(path, probes.get(path)), deleted = pages.deleted(i), revision = pages.recordRevisionOf(i), names = pages.names(i, level);
    return { baseline: !deleted && revision == null && level !== null && !names && inLevel(path),
      unproven: pages.requestId[i] !== null && (deleted || level === null || !names || revision == null || String(revision) !== pages.revision[i]) };
  }, step);
  const attestationStatements = unproven.length ? await readAttestations(engine, engineKind, sourceId, incarnation, pages, unproven) : 0;
  timings.A = t();

  const baselineCommit = (context.source.last_commit && await revParse(gitRoot, context.source.last_commit)) || null;
  // The baseline tree, read once when a page needs it (no record revision; design §2.3) or the bootstrap's legacy walk does,
  // so the classification itself never waits.
  let baselineTree: Map<string, GitTreeEntry> | null | undefined;
  const loadBaseline = async () => {
    if (baselineTree !== undefined || !baselineCommit) return;
    const bt = timer();
    baselineTree = await readTreeLevel(gitRoot, baselineCommit, scope).catch(() => null);
    timings.baseline = bt();
  };
  if (wantBaseline) await loadBaseline();
  const baselineOf = (path: string): string | null => baselineTree?.get(path)?.oid ?? null;
  // A page-less spelling twin unchanged since the baseline (#6865): see `settleUnchangedSpellings`.
  const legacySpelling = await settleUnchangedSpellings(twinGroups, twins, async path => {
    const live = rowAt(path);
    const level = levelOf(path, probes.get(path));
    if ((live && !live.deleted) || level === null) return false;
    await loadBaseline();
    return level === baselineOf(path);
  });

  const parserFor = syncImportParsers(pack?.identity ?? null);
  const fp = (path: string) => parserFor(sourceRelative(path));
  // The page's fields come straight from `pages` (no `PageRow` per path); `at` is its slot, undefined for a page-less path.
  const stateOf = (path: string, dirty: SyncPathState['dirty'], probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): { state: SyncPathState; at?: number; legacyPageless?: true } => {
    const committed = tree.get(path) ?? null;
    const at = byOrigin.get(path), row = at !== undefined;
    const level = levelOf(path, probe);
    const origin = originOf(path);
    // Presence decides only rows 4-6 (a level of absent); a committed path in T is not read here (Dp covers it).
    const record = row && pages.hasRecord(at), working = row ? pages.workingOf(at) : undefined, recordRevision = row ? pages.recordRevisionOf(at) : undefined;
    // #5459 (`keptWorkingTreePages`): a page whose import provenance is the pinned Git blob follows Git, so a lingering
    // untracked copy of its file does not keep it.
    const fromGit = working === false || (working === undefined && record && !!pages.blobOid[at]);
    const presentNow = mode === 'working' ? level !== null : level === null ? !fromGit && readPresent(root, path, scope) : true;
    const recordBlobOids = row ? pages.oids(at, level) : [];
    const proof = row ? pages.attested.get(at) : undefined;
    const attested = proof && (proof.arm1 || proof.hash) ? { hash: proof.hash ?? null, arm1: proof.arm1 === true } : null;
    const hold = holdByGitPath.get(path);
    const marker = markers.get(origin) ?? null;
    const deletion = !row && !marker && level !== null ? legacyDeletions.get(path) : undefined;
    const virtualMarker: SyncPathState['marker'] = deletion ? { kind: 'legacy', blobOids: [level!], deletion } : null;
    const legacyPageless = deletion ? true as const : undefined;
    const live = row && !pages.deleted(at!);
    const needsBaseline = live && recordRevision == null && level !== null && !recordBlobOids.includes(level);
    const state: SyncPathState = {
      mode, tree: committed?.oid ?? null, level, present: presentNow, dirty, diskOid: probe?.rawOid ?? null,
      page: row ? { live, revision: pages.revision[at!]!, originMatches: record && originPath(pages.origin.get(at!) ?? pages.sourcePath[at!]!) === pageOrigin(pages.sourcePath[at!]!, pages.slug[at!]!) } : null,
      record: record ? { blobOids: recordBlobOids, revision: recordRevision != null ? String(recordRevision) : null, parserSame: sameParser(pages.parserOf(at!), fp(path)) } : null,
      attested, levelSha256: probe?.rawSha256 ?? null,
      published: !!attested?.hash && probe?.rawSha256 === attested.hash,
      hold: hold ? { atLevel: holdAtLevel(hold, level, probe?.rawSha256 ?? null) && !moved.has(path), rescreenDue: holdRescreenDue(hold, retry.has(hold.path)), retried: retry.has(hold.path) } : null,
      marker: marker ?? virtualMarker, baseline: needsBaseline ? baselineOf(path) : null,
      spelling: legacySpelling.has(path) ? 'legacy' : twins.has(path),
      episodeUnsatisfied: input.pass ? !!input.pass.episodeFullId && live && (record ? pages.fullEpisode[at!] : undefined) !== input.pass.episodeFullId
        : input.full === true && live,
      derivedCurrent: live && pages.derivedCurrent(at!), fullObligation: input.pass ? !!input.pass.episodeFullId : input.full === true,
      keepDb: !mirror && keepDbPrefixes.length > 0 && row && isKeepDbSlug(pages.slug[at!]!, keepDbPrefixes), dbOnly: row && (isDeclaredDbOnlySlug(pages.slug[at!]!, storage) || (dbOnlyUnknown ? 'unknown' : false)),
      openWork: row && open.pageIds.has(Number(pages.id[at!])) || open.origins.has(origin),
    };
    return { state, ...(row ? { at } : {}), ...(legacyPageless ? { legacyPageless } : {}) };
  };

  // Bootstrap (the incarnation's first pass; for a read-only level, no pass row yet): page-less paths at their baseline blob
  // whose slug a committed deletion names get a `legacy` marker (§2.7, b1).
  t = timer();
  const legacyDeletions = baselineCommit && (input.pass ? input.pass.bootstrap === true : !passRow)
    ? await bootstrapLegacyDeletions(engine, { sourceId, incarnation, domain, step }, async path => {
      if (byOrigin.has(path) || markers.has(originOf(path))) return null;
      const level = levelOf(path, probes.get(path));
      if (level === null) return null;
      await loadBaseline();
      return level === baselineOf(path) ? resolveSlugForPath(originOf(path)) || null : null;
    }).then(found => { timings.legacy = t(); return found; })
    : new Map<string, string>();

  const classifiedKey = JSON.stringify([treeKey, mode, strict, input.pass?.episodeFullId ?? null, input.full === true, mirror, keepDbPrefixes, storage?.db_only ?? [], dbOnlyUnknown, pack?.identity ?? null, baselineCommit, !!input.pass?.bootstrap, [...colonRefused].sort()]);
  const reuse = snapshot.changed && priorClassified?.key === classifiedKey ? reusableMatched(priorClassified.paths, matchedUnchanged({ pages, tree, byOrigin, claimants, holds: holdByGitPath, markers, open,
    changed: confirmChangedPaths(pages, snapshot.changed, (sourcePath, slug) => gitPathOf(pageOrigin(sourcePath, slug))), indexDelta, spelled: path => twins.has(path) || legacySpelling.has(path), originOf })) : null;
  // A round that reuses nothing lets the previous round's paths go before it builds its own: one level held, not two.
  if (!reuse) priorClassified = undefined;
  t = timer();
  const paths: ShadowPath[] = [];
  let reused = 0;
  const candidates: string[] = [], candidateAt: number[] = [];
  const settledBeforeDirtiness = new Set(['held', 'spelling', 'untracked', 'kept', 'delete', 'delete_drift', 'gone', 'deleted_same', 'deleted_edited', 'legacy_same', 'matched']);
  const shared = { mode, fullObligation: input.pass ? !!input.pass.episodeFullId : input.full === true };
  // The cached claims stay whole for the next round. A narrowed round classifies again the paths whose entry `matchedUnchanged`
  // can fail on (`again`, and the entries `keptUnread` refuses); every other entry of the previous round stays as it is.
  const keepClaims = !!cache && mode === 'committed';
  const walk = narrow === 'taken' && reuse ? narrowedWalk(priorClassified!.paths, domain, new Set([...levelD.touched!, ...claimants.keys(), ...holdByGitPath.keys(), ...indexDelta?.keys() ?? [],
    ...twins, ...legacySpelling, ...[...pages.attested.keys()].map(keyOf)]), keptUnread(open, markers, originOf)) : await sortYielding([...domain], step);
  for (const item of walk) {
    if (step.due()) await step.pause();
    if (typeof item !== 'string') { paths.push(item); reused++; continue; }
    const path = item, kept = reuse?.(path);
    if (kept) { if (!keepClaims) byOrigin.delete(path); paths.push(kept); reused++; continue; }
    const probe = probes.get(path);
    const { state, at, legacyPageless } = stateOf(path, mode === 'committed' && tree.has(path) ? 'clean' : null, probe);
    const result = sharedResult(classifySyncPath(state, { strict }));
    // Rows 1-10 precede row 11 and `matched` settles either way, so only the rest are Dp candidates (design v3.2 §2.1).
    const staged = mode === 'committed' && tree.has(path) && !!indexDelta?.has(path) && (indexed(path)?.oid !== tree.get(path)!.oid || (indexed(path)?.stage ?? 0) !== 0);
    const revision = at === undefined ? null : pages.revision[at] ?? null;
    const claimed = claimants.get(path);
    const { ambiguous } = claimed ? selectOriginClaimant(claimed.map(page => ({ deleted_at: pages.deleted(page) ? true : null }))) : { ambiguous: null };
    const named = ambiguous ? claimed!.filter(page => ambiguous === 'several_tombstones' || !pages.deleted(page)) : [], ambiguousOrigin = ambiguous ? { kind: ambiguous, slugs: named.map(page => pages.slug[page]!), ids: named.map(page => Number(pages.id[page])) } : undefined;
    if (mode === 'committed' && tree.has(path) && (!settledBeforeDirtiness.has(result.cls) || staged)) { candidates.push(path); candidateAt.push(paths.length); }
    else {
      // The row's fields the level keeps are copied onto the entry; only a candidate's row is read again (its dirtiness re-classifies it).
      if (!keepClaims) byOrigin.delete(path);
      if (result.cls === 'matched' && !legacyPageless && !ambiguousOrigin && MatchedPath.fits(state, revision, shared)) {
        paths.push(new MatchedPath(path, pages.slug[at!]!, Number(pages.id[at!]), revision, result, state.tree, state.level!, state.dirty, state.record!.blobOids.length === 2, shared));
        continue;
      }
    }
    paths.push({ path, slug: at === undefined ? null : pages.slug[at] ?? null, pageId: at === undefined ? null : Number(pages.id[at]), revision, state, result, ...(legacyPageless ? { legacyPageless } : {}), ...(ambiguousOrigin ? { ambiguousOrigin } : {}) });
  }
  timings.classify = t();
  if (candidates.length && !strict) {
    t = timer();
    const candidateIndex = new Map<string, GitIndexEntry>();
    for (const path of candidates) { if (step.due()) await step.pause(); const entry = indexed(path); if (entry) candidateIndex.set(path, entry); }
    const probed = await probeDirtiness(root, gitRoot, candidates, tree, candidateIndex, { step, persist: input.pass?.levelReuse === true,
      ...(levelReuseVerify() ? { verify: (reused: number, differs: string | null) => { if (reused) reportLevelReuseCheck('dirtiness probes', `${reused} reused`, differs); } } : {}) });
    timings.Dp = (timings.Dp ?? 0) + t();
    t = timer();
    for (const [k, path] of candidates.entries()) {
      if (step.due()) await step.pause();
      const probe = probed.get(path);
      const i = candidateAt[k]!;
      const { state } = stateOf(path, (probe?.dp ?? 'unknown') as SyncPathState['dirty'], probe);
      paths[i] = { ...paths[i]!, state, result: sharedResult(classifySyncPath(state, { strict })) };
    }
    timings.classify += t();
  }

  t = timer();
  if (await reclassifyByOrigin(gitRoot, [head, baselineCommit], paths, step, strict, input.pass)) timings.origin = t();

  // Adoption by hash needs the level's bytes: committed mode reads the blobs of the candidates that could adopt.
  const needBytes = await filterYielding(paths, entry => !['matched', 'held', 'dirty'].includes(entry.result.cls) && entry.state.levelSha256 === null && entry.state.level !== null
    && entry.state.attested?.hash && entry.state.page?.live, step);
  if (needBytes.length) {
    t = timer();
    const blobs = await readBlobs(gitRoot, [...new Set(needBytes.map(entry => entry.state.level!))], LEVEL_BLOB_MAX_BYTES);
    for (const entry of needBytes) {
      const bytes = blobs.get(entry.state.level!);
      if (!bytes) continue;
      const state = { ...entry.state, levelSha256: sha256(bytes) };
      Object.assign(entry, { state, result: classifySyncPath(state, { strict }) });
    }
    timings.level_bytes = t();
  }

  const kind = syncPassKind({ converged: null, head, parserFp: '', pack: pack?.identity ?? null, selectionFp: '', now: Date.now(), openEpisode: input.full === true, owedTail: false,
    retryRow: retry.size > 0, notConvergedStreak: 0, mismatchStreak: 0, requestNewer: false, openAtStampFinished: false, workingChange: false,
    rescreenDueHold: holds.some(hold => holdRescreenDue(hold, retry.has(hold.path))), full: input.full === true });
  timings.total = total();
  if (cache && mode === 'committed') {
    cache.classified = { key: classifiedKey, treeKey, paths };
    if (!colonRefused.size) cache.domain = domainCache(levelD, treeKey);
  }
  return { sourceId, incarnation, root, gitRoot, scope, slugMode, mode, strict, head, baselineCommit, full: input.full === true, kind: kind.kind, kindBlockers: kind.blockers,
    heldRenames: holds.flatMap(hold => hold.meta.rename_from ? [{ path: toGit(hold.path), rename: hold.meta.rename_from }] : []),
    releasableHolds: holds.filter(hold => !domain.has(toGit(hold.path)) || (!dbOnlyUnknown && hold.code === 'file_drift' && hold.meta.reason === 'storage_invalid')).map(hold => hold.path),
    deletionCandidates: deletionCandidates(holds, path => domain.has(path) && !tree.has(path)
      && !(mode === 'working' && (untracked.has(path) || index.has(path))) && !readPresent(root, path, scope), toGit),
    paths, reconcilable, ...(colon.refusals.size ? { fileRefusals: [...colon.refusals.values()] } : {}), timings_ms: timings, statements: statements + attestationStatements + 3,
    ...(confirm ? { confirm: narrow ? { ...confirm, narrow: narrow === 'taken' && !reuse ? 'classified' : narrow } : confirm } : {}), ...(reuse ? { reused } : {}), ...(treeReuse ? { treeReuse } : {}), pack: pack?.identity ?? null,
    selection: { exclude: [...exclude].sort(), includeHidden: [...includeHidden].sort(), strategy, srcSubpath: scope || null, mode },
    rescreenDue: holds.filter(hold => holdRescreenDue(hold, retry.has(hold.path))).map(hold => toGit(hold.path)), workingCache: hashed?.cache ?? null };
}

/** A recorded page origin as the level names it: a source-root page's legacy Git-root spelling loses its scope (#5610). */
function scopedPageOrigin(recorded: string, slug: string, originScope: SyncOriginScope): string {
  const { scope, slugMode } = originScope;
  if (slugMode !== 'source-root' || !scope || !recorded.startsWith(`${scope}/`)) return recorded;
  const stripped = recorded.slice(scope.length + 1);
  return sameSyncOrigin(recorded, stripped, originScope, slug) ? stripped : recorded;
}

/** The level's settings, one round trip each and all in flight together; null for a company-brain source. */
/** `T`'s eligible entries and its ':' paths (#5032: refused, never part of the level), walked from the listing the last pass may have kept (sync-tree-reuse.ts). */
async function eligibleListing(gitRoot: string, head: string, scope: string, opts: { key: string[]; canonical: string; allowed: boolean; step: LoopYield; eligible: (path: string) => boolean;
  prime: (listing: Map<string, GitTreeEntry>) => Map<string, GitTreeEntry> }): Promise<{ tree: Map<string, GitTreeEntry>; colon: string[]; reuse: TreeReuse }> {
  const listed = await readTreeLevelReusing(gitRoot, head, scope, { key: opts.key, canonical: opts.canonical, allowed: opts.allowed, shared: opts.step });
  const tree = new Map<string, GitTreeEntry>(), colon: string[] = [];
  for (const [path, entry] of opts.prime(listed.tree)) {
    if (isWindowsColonTarget(path)) colon.push(path);
    else if (opts.eligible(path)) tree.set(path, entry);
    if (opts.step.due()) await opts.step.pause();
  }
  listed.keep();
  return { tree, colon, reuse: listed.reuse };
}

async function readLevelSettings(engine: BrainEngine, context: ManagedSyncContext, scope: string, input: { workingTree?: boolean; pass?: PassLevelInput }) {
  const { sourceId, root } = context;
  const [company, slugModeRead, excludeRead, includeHiddenRead, workingRead, packRead, mirrorRead, metafilePagesRead] = await Promise.allSettled([
    currentCompanyBrainSync(sourceId) ? Promise.resolve(true) : getCompanyBrainProfile(engine, sourceId).then(profile => !!profile),
    scope && input.pass?.slugMode ? Promise.resolve(input.pass.slugMode) : scope ? resolveSlugRootMode(engine, { sourceId, explicitGitRoot: false, slugPrefix: resolveSlugForPath(join(scope, 'x.md')).slice(0, -2), dryRun: true }) : Promise.resolve('git-root' as const),
    syncExcludePatterns(engine, [...input.pass?.exclude ?? []]),
    engine.getConfig('sync.include_hidden'),
    input.workingTree === undefined ? engine.getConfig('sync.include_working_tree') : Promise.resolve(null),
    input.pass?.noSchemaPack ? Promise.resolve(null) : loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null),
    sourceMirrorReadOnly(engine, sourceId),
    readMetafilePagesMode(engine),
  ]);
  const settled = <T>(read: PromiseSettledResult<T>): T => { if (read.status === 'rejected') throw read.reason; return read.value; };
  if (settled(company)) return null;
  let storageInvalid = false;
  const storage = (() => { try { return loadStorageConfig(root); } catch { storageInvalid = true; return null; } })();
  return { slugMode: settled(slugModeRead), exclude: settled(excludeRead), pack: settled(packRead), mirror: settled(mirrorRead), workingConfig: settled(workingRead),
    metafilePages: settled(metafilePagesRead), strict: context.source.config?.canonical === 'git', strategy: input.pass?.strategy ?? (context.source.config?.strategy as string | undefined) ?? 'markdown',
    includeHidden: [...new Set([...input.pass?.includeHidden ?? [], ...(settled(includeHiddenRead) ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))],
    keepDbPrefixes: storage?.keep_db ?? [], storage, dbOnlyUnknown: storageInvalid || storage?.deprecated_db_only_ignored === true || hasUnresolvedDbOnlyDeclaration(root, storage) };
}

/** A failed mark, proof or delta read: the round reads again without them (it aborted a Postgres snapshot). */
class ConfirmFailure extends Error {}
const confirmGuard = <T>(read: Promise<T>) => read.catch((error: unknown) => { throw new ConfirmFailure(String(error)); });

/**
 * The round's database snapshot (`I⋈P`, `U_db`, the markers and the pass row); issued together, its statements pipeline on
 * its one connection (PGLite runs them in turn). A pass round (`reuse`) also marks the snapshot, and a later round at the
 * same key reuses the last `I⋈P` when sync-pass-confirm.ts proves it (else reads it whole). The proof never throws: a
 * failed mark, proof or delta read reads the round again, whole and unmarked.
 */
async function readRoundSnapshot(engine: BrainEngine, input: { kind: 'postgres' | 'pglite'; sourceId: string; incarnation: string; worktreeId: string; parser: SyncImportParser; step: LoopYield;
  reuse?: { cache: PassLevelCache; passId: string; recorded?: ReadonlySet<number>; working: boolean; head: string } }, timed: <T>(key: string, read: () => Promise<T>) => Promise<T>) {
  const { kind, sourceId, incarnation, worktreeId, reuse } = input;
  // Reused only at the same commit (a pass's own rounds; across passes any), worktree and parser, in committed mode: working mode always reads `I⋈P` whole.
  const key = JSON.stringify([sourceId, incarnation, worktreeId, reuse?.head, input.parser]), acrossKey = JSON.stringify([sourceId, incarnation, worktreeId, input.parser]);
  const cached = reuse?.cache.pages, across = cached?.across;
  const unkeyed = cached && (reuse!.working || cached.key !== (across ? acrossKey : key)) ? { taken: false, reason: reuse!.working ? 'working' : 'key', rows: 0, ...(across ? { across } : {}) } : undefined;
  let prior = reuse && !unkeyed ? reuse.cache.pages : undefined;
  const confirming = prior !== undefined;
  if (reuse) reuse.cache.pages = undefined;
  const round = (marking: boolean) => withRoundSnapshot(engine, async exec => {
    const base = marking ? prior?.mark : undefined;
    const proof = base ? confirmGuard(timed('confirm', () => proveConfirm(exec, { sourceId, incarnation, passId: reuse!.passId, base, recorded: reuse!.recorded, postgres: kind === 'postgres', parallel: true,
      ...(across ? { across } : {}) }))) : null;
    const marked = marking && !base ? confirmGuard(readLevelMark(exec, sourceId, incarnation)) : null;
    // PGLite has no snapshot: the mark (or the proof, the next round's mark) runs before the reads it vouches for.
    if (kind === 'pglite') await (proof ?? marked)?.catch(() => undefined);
    const others = Promise.all([timed('open_work', () => readOpenWork(exec, sourceId, incarnation, worktreeId)), timed('markers', () => readMarkers(exec, sourceId, incarnation)),
      timed('pass_row', () => readPassRow(exec, sourceId, incarnation))]);
    others.catch(() => undefined);
    const confirmed = proof ? await confirmPages(exec, { kind, sourceId, incarnation, parser: input.parser, prior: prior!, proof }, timed) : null;
    // Read whole, the round holds one `I⋈P`, not the reused one beside it.
    if (!confirmed?.read) prior = undefined;
    // A failed mark fails what was pipelined after it: the mark's failure is the one to report.
    const read = confirmed?.read ?? await timed('pages', () => readPages(exec, kind, sourceId, incarnation, input.parser, undefined, input.step)).catch(async (error: unknown) => { await marked; throw error; });
    const mark = confirmed?.mark ?? (marked ? await marked : null);
    if (confirmed?.read && levelReuseVerify()) await verifyReusedPages(exec, { kind, sourceId, incarnation, parser: input.parser, table: confirmed.read.pages, how: across ? 'across passes' : 'in a pass' });
    const [work, markers, passRow] = await others;
    if (reuse && mark) reuse.cache.pages = { key, acrossKey, mark, table: read!.pages };
    const confirm = confirmed?.confirm ?? unkeyed;
    return { pages: read!.pages, open: work, markers, passRow, statements: read!.statements + work.statements + 2 + (marked ? 1 : proof ? (kind === 'postgres' ? 6 : 1) : 0), ...(confirm ? { confirm } : {}),
      ...(confirmed?.read ? { changed: confirmed.changed } : {}) };
  });
  if (!reuse || reuse.working) return round(false);
  try { return await round(true); } catch (error) {
    if (!(error instanceof ConfirmFailure)) throw error;
    prior = undefined;
    return { ...await round(false), ...(confirming ? { confirm: { taken: false, reason: 'error', rows: 0, ...(across ? { across } : {}) } } : {}) };
  }
}

/**
 * A confirm round's `I⋈P`: with the proof (S2's mark) in hand, the previous round's rows with the pages the pass wrote
 * re-read into them, when the counts then account for every row (no deletion); else `read: null` and the caller reads
 * whole. Either way S2's mark is the next round's.
 */
/** Pages a cross-pass delta may re-read whatever the table's size. */
const LEVEL_REUSE_DELTA_MIN = 2_000;

/** GBRAIN_SYNC_LEVEL_REUSE_VERIFY: the reused `I⋈P` against a whole read in the same snapshot, page by page (sync-tree-reuse.ts). */
async function verifyReusedPages(exec: Exec, input: { kind: 'postgres' | 'pglite'; sourceId: string; incarnation: string; parser: SyncImportParser; table: PageTable; how: string }): Promise<void> {
  const whole = (await readPages(exec, input.kind, input.sourceId, input.incarnation, input.parser))!.pages;
  const rows = (table: PageTable) => new Map(Array.from({ length: table.length }, (_, i) => {
    const { arm1: _a, attested_hash: _h, ...row } = table.row(i);
    return [String(row.id), JSON.stringify(row)] as const;
  }));
  const reused = rows(input.table), fresh = rows(whole);
  reportLevelReuseCheck('I⋈P', input.how, reused.size !== fresh.size ? `${reused.size} pages, whole read ${fresh.size}`
    : [...fresh].find(([id, row]) => reused.get(id) !== row)?.[0]);
}

async function confirmPages(exec: Exec, input: { kind: 'postgres' | 'pglite'; sourceId: string; incarnation: string; parser: SyncImportParser;
  prior: NonNullable<PassLevelCache['pages']>; proof: Promise<ConfirmProof> }, timed: <T>(key: string, read: () => Promise<T>) => Promise<T>) {
  const proof = await input.proof, { table } = input.prior, across = input.prior.across ? { across: input.prior.across } : {};
  if (!proof.ok) return { read: null, mark: proof.mark, confirm: { taken: false, reason: proof.reason, rows: 0, ...across } };
  // Across passes a delta past a quarter of the table (and LEVEL_REUSE_DELTA_MIN pages) reads whole: cheaper, and no larger a risk.
  if (proof.across && proof.pages.length > Math.max(LEVEL_REUSE_DELTA_MIN, table.length / 4)) return { read: null, mark: proof.mark, confirm: { taken: false, reason: 'delta_large', rows: 0, ...across } };
  const want = new Set(proof.pages), slots = new Map<string, number>();
  const step = loopYield();
  for (let i = 0; i < table.length && slots.size < want.size; i++) {
    if (want.has(String(table.id[i]))) slots.set(String(table.id[i]), i);
    if (step.due()) await step.pause();
  }
  // An import record the pass wrote for a page that had none in S1 is a new row; one it rewrote was counted in S1.
  const newRecords = [...proof.records].filter(id => !slots.has(id) || !table.hasRecord(slots.get(id)!)).length;
  // `A` is the round's own read (readAttestations, after this): the previous round's proofs leave with it.
  table.attested.clear();
  // What the re-read replaces, for the classification reuse: the rewritten slots' previous origins, and where new slots start.
  const changed = { rewritten: [...slots.values()].map(slot => ({ slot, sourcePath: table.sourcePath[slot]!, slug: table.slug[slot]! })), from: table.length };
  const read = proof.pages.length ? await confirmGuard(timed('pages', () => readPages(exec, input.kind, input.sourceId, input.incarnation, input.parser, { table, ids: proof.pages, slots })))
    : { pages: table, statements: 0 };
  if (!read) return { read: null, mark: proof.mark, confirm: { taken: false, reason: 'page_left_level', rows: 0, ...across } };
  if (!countsMatch(input.prior.mark, proof, { pages: read.pages.length, newRecords })) return { read: null, mark: proof.mark, confirm: { taken: false, reason: 'counts', rows: 0, ...across } };
  return { read, mark: proof.mark, confirm: { taken: true, reason: null, rows: proof.pages.length, ...across }, changed };
}

/**
 * #6926, folded into 4b: what a folded checkpoint needs of the round's `I⋈P` (S1): its mark, its page count and its largest
 * page id (a page past it is one the pass created). Null when the round left no marked `I⋈P` (working mode, a failed mark).
 */
export function passFoldBase(cache: PassLevelCache): { mark: LevelMark; pages: number; maxId: string } | null {
  const table = cache.pages?.table;
  if (!table || !cache.pages) return null;
  let maxId = 0;
  for (let i = 0; i < table.length; i++) maxId = Math.max(maxId, Number(table.id[i]));
  return { mark: cache.pages.mark, pages: table.length, maxId: String(maxId) };
}

/**
 * #6926, folded into 4b: whether every page a pass's round wrote (`ids`) classifies `matched` at the level its request froze,
 * read inside the folded checkpoint's transaction. The state is the one `readShadowLevel` builds for a committed-mode path
 * in `T` at that level; the classifier reaches `matched` before it reads a hold, marker, attestation, baseline, keep_db or
 * open work (sync-classify.ts), and the fold refuses on any hold or open request beside it. A legacy-spelled origin, which
 * the level resolves with `sameSyncOrigin`, is not matched here: that fold takes the stamp path.
 */
export async function passWritesMatched(exec: Exec, input: { kind: 'postgres' | 'pglite'; sourceId: string; incarnation: string; pack: string | null; scope: string;
  slugMode: 'git-root' | 'source-root'; episodeFullId: string | null; ids: string[] }): Promise<boolean> {
  const parser = syncImportParser(input.pack);
  const read = await readPages(exec, input.kind, input.sourceId, input.incarnation, parser, { table: new PageTable(parser), ids: input.ids, slots: new Map() });
  if (!read || read.pages.length !== input.ids.length) return false;
  const writers = new Map((await exec.executeRaw<{ id: string; level: string | null; path: string | null }>(`SELECT p.id::text AS id, r.intent->>'level' AS level, r.intent->>'path' AS path
    FROM pages p JOIN persistence_requests r ON r.id=p.revision_write_request_id WHERE p.source_id=$1 AND p.id = ANY($2::bigint[])`, [input.sourceId, input.ids])).map(row => [row.id, row]));
  const pages = read.pages, parserFor = syncImportParsers(input.pack);
  for (let i = 0; i < pages.length; i++) {
    const writer = writers.get(String(pages.id[i])), level = writer?.level ?? null, sourcePath = pages.sourcePath[i]!;
    if (!writer?.path || level === null || pages.deleted(i) || !pages.hasRecord(i)) return false;
    if (input.slugMode === 'source-root' && input.scope && sourcePath.startsWith(`${input.scope}/`)) return false;
    const recordRevision = pages.recordRevisionOf(i);
    const state: SyncPathState = { mode: 'committed', tree: level, level, present: true, dirty: 'clean', diskOid: null,
      page: { live: true, revision: pages.revision[i]!, originMatches: syncOriginPath(pages.origin.get(i) ?? sourcePath) === syncOriginPath(sourcePath) },
      record: { blobOids: pages.oids(i, level), revision: recordRevision != null ? String(recordRevision) : null, parserSame: sameParser(pages.parserOf(i), parserFor(writer.path)) },
      attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false,
      episodeUnsatisfied: !!input.episodeFullId && pages.fullEpisode[i] !== input.episodeFullId, derivedCurrent: pages.derivedCurrent(i), fullObligation: !!input.episodeFullId,
      keepDb: false, openWork: false };
    if (classifySyncPath(state).cls !== 'matched') return false;
  }
  return true;
}

/** `H`: the source's holds of this incarnation, the retry set less what the pass consumed, and the holds whose basis or drift moved. */
async function readLevelHolds(engine: BrainEngine, sourceId: string, incarnation: string, retryConsumed: ReadonlySet<string> | undefined) {
  const [sourceHolds, retryPaths] = await Promise.all([readGitSourceHolds(engine, { sourceIds: [sourceId] }), readGitHoldRetryPaths(engine, sourceId, incarnation)]);
  const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  const holdByPath = new Map(holds.map(hold => [hold.path, hold]));
  const [basisMoved, driftMoved] = await Promise.all([holdBasisMoved(engine, sourceId, holdByPath, [...holdByPath.keys()]), movedDriftHolds(engine, sourceId, holds)]);
  return { holds, retry: new Set(retryPaths.filter(path => !retryConsumed?.has(path))), moved: [...basisMoved, ...driftMoved] };
}

/**
 * Master refuses a spelling only among the files its sync claims (sync-discovery.ts:538-541): the live page's origin and the
 * page-less spellings that changed since the cursor. A page-less spelling unchanged since the baseline was never claimed
 * (#6865), so unless the claimed spellings still collide it settles as `legacy` (returned) and the others leave `twins`
 * to classify on their own.
 */
async function settleUnchangedSpellings(twinGroups: string[][], twins: Set<string>, unchangedPageless: (path: string) => Promise<boolean>): Promise<Set<string>> {
  const legacySpelling = new Set<string>();
  for (const group of twinGroups) {
    const unchanged: string[] = [];
    for (const path of group) if (await unchangedPageless(path)) unchanged.push(path);
    if (group.length - unchanged.length > 1) continue;
    for (const path of group) twins.delete(path);
    for (const path of unchanged) legacySpelling.add(path);
  }
  return legacySpelling;
}

/**
 * Bootstrap (the incarnation's first pass; for a read-only level, no pass row yet): page-less paths at their baseline blob
 * (`pagelessSlug` names their slug) whose slug a committed deletion names get a `legacy` marker (§2.7, b1).
 */
async function bootstrapLegacyDeletions(engine: BrainEngine, input: { sourceId: string; incarnation: string; domain: Set<string>; step: LoopYield },
  pagelessSlug: (path: string) => Promise<string | null>): Promise<Map<string, string>> {
  const pageless: Array<{ path: string; slug: string }> = [];
  for (const path of input.domain) {
    if (input.step.due()) await input.step.pause();
    const slug = await pagelessSlug(path);
    if (slug) pageless.push({ path, slug });
  }
  const bySlug = await readLegacyDeletions(engine, input.sourceId, input.incarnation, [...new Set(pageless.map(entry => entry.slug))]);
  const found = new Map<string, string>();
  for (const { path, slug } of pageless) { const id = bySlug.get(slug); if (id) found.set(path, id); }
  return found;
}

/**
 * #5032, as discovery refuses them: on Windows a ':' path has no file. Each selected one gets a named refusal and leaves
 * the level: a file at the target is skipped, a live page whose file left keeps its page, and a Git rename (last_commit to
 * HEAD) touching one is refused on both sides, so the page keeps its identity until the change syncs from macOS or Linux.
 * Off Windows, or with no ':' path, nothing is read.
 */
async function windowsColonRefusals(engine: BrainEngine, input: { sourceId: string; gitRoot: string; from: string | null; head: string; colonTree: string[];
  pages: PageTable; selected: (gitPath: string) => boolean; gitPathOf: (origin: string) => string; sourcePathOf: (gitPath: string) => string }): Promise<{ refusals: Map<string, SyncFileRefusal>; paths: Set<string> }> {
  const refusals = new Map<string, SyncFileRefusal>(), paths = new Set<string>();
  const colonPages: string[] = [];
  for (let row = 0; row < input.pages.length; row++) {
    const path = input.pages.sourcePath[row]!;
    if (!input.pages.deleted(row) && isWindowsColonTarget(path)) colonPages.push(input.gitPathOf(path.replaceAll('\\', '/')));
  }
  if (!input.colonTree.length && !colonPages.length) return { refusals, paths };
  const refuse = (path: string, message: string) => { paths.add(path); if (input.selected(path)) refusals.set(path, colonFileRefusal(input.sourceId, path, message)); };
  const delta = input.from && input.from !== input.head ? await confirmedSyncDelta(engine, input.gitRoot, input.from, input.head, { sourceId: input.sourceId, sourcePathOf: input.sourcePathOf }) : null;
  for (const rename of delta?.status === 'ok' ? delta.manifest.renamed : []) {
    if (!isWindowsColonTarget(rename.from) && !isWindowsColonTarget(rename.to)) continue;
    for (const path of [rename.from, rename.to]) refuse(path, COLON_REFUSAL_MESSAGES.rename(path, rename.from, rename.to));
  }
  for (const path of input.colonTree) if (!paths.has(path)) refuse(path, COLON_REFUSAL_MESSAGES.import(path));
  for (const path of colonPages) if (!paths.has(path)) refuse(path, COLON_REFUSAL_MESSAGES.delete(path));
  return { refusals, paths };
}

/** `workingTreeFilePresent` (sync-discovery.ts) for a Git-root path: a file that exists, or one that cannot be read (fail closed). */
function readPresent(root: string, gitPath: string, scope: string): boolean {
  const path = scope ? gitPath.slice(scope.length + 1) : gitPath;
  try { return readSyncFile(root, path) !== null; } catch { return true; }
}

/** Whether a hold still describes the path at level `L`, in the hold's own domain (a pinned blob, working bytes, or a deletion). */
function holdAtLevel(hold: GitHoldRecord, level: string | null, diskSha256: string | null): boolean {
  if (hold.meta.deleted) return level === null;
  if (level === null) return false;
  if (hold.meta.working) return diskSha256 === null || diskSha256 === (hold.meta.working_hash ?? hold.upstream_version);
  return hold.meta.blob_oid ? hold.meta.blob_oid === level : true;
}

/**
 * The read-only convergence receipt of a source (design v3.1 §11 step 2): the shadow level, its predicted decisions after
 * a read-only screen (dry runs only), and the delete valve's verdict. Null for a company-brain source.
 */
export async function shadowConvergence(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; redactPaths?: boolean; sampleCap?: number;
  screen?: ConvergenceScreen | false; context?: ManagedSyncContext }): Promise<ConvergenceReceipt | null> {
  const level = await readShadowLevel(engine, input);
  if (!level) return null;
  return buildConvergenceReceipt(engine, level, { redactPaths: input.redactPaths === true, sampleCap: input.sampleCap ?? 20, screen: input.screen ?? false });
}

/**
 * The idle tick's reads (design v3.2 §2.2): `rev-parse`, the per-source request probe above the converged watermark
 * (a range on the unique `sequence` index), the open-set probe (`persistence_requests_pending`, plus
 * `persistence_requests_database_pending` for the source's write-through-off requests, which carry no worktree) and the
 * pass row; both request probes count those requests too. PR 4a
 * writes no pass row, so a real tick is never idle yet; `assumeConverged` lets the bench time the reads PR 4b's idle
 * tick will make, with `request_hwm` at the current maximum.
 */
export async function idleTickProbe(engine: BrainEngine, input: { sourceId: string; assumeConverged?: { target: string; requestHwm: number }; context?: ManagedSyncContext }):
  Promise<{ idle: boolean; reasons: SyncIdleBlocker[]; timings_ms: Record<string, number>; rows: number }> {
  const timings: Record<string, number> = {};
  const total = timer();
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  t = timer();
  const head = await revParse(context.gitRoot, 'HEAD');
  timings.rev_parse = t();
  // The pass row, the request probe above its watermark and the open-set probe are one statement (one round trip).
  t = timer();
  const probe = await passIdleProbe(engine, { sourceId: context.sourceId, incarnation: context.incarnation, worktreeId: context.binding.worktree_id,
    requestHwm: input.assumeConverged?.requestHwm ?? null, openAtStamp: [] });
  timings.probes = t();
  const row = probe.passRow;
  const stored = (row?.obligations as { converged?: { target: string; request_hwm: string } } | undefined)?.converged;
  const converged = input.assumeConverged ?? (stored ? { target: String(stored.target), requestHwm: Number(stored.request_hwm) } : null);
  const newer = probe.newer, pending = probe.pending;
  const kind = syncPassKind({ converged: converged ? { target: converged.target, parserFp: '', pack: null, selectionFp: '', passesSinceFull: 0, lastFullAt: Date.now() } : null,
    head: head ?? '', parserFp: '', pack: null, selectionFp: '', now: Date.now(), openEpisode: false, owedTail: false, retryRow: false, notConvergedStreak: 0, mismatchStreak: 0,
    requestNewer: newer, openAtStampFinished: pending && !input.assumeConverged, writebackOpen: probe.writebackOpen && !input.assumeConverged, workingChange: false, rescreenDueHold: false, full: false });
  timings.total = total();
  return { idle: kind.kind === 'idle', reasons: kind.blockers, timings_ms: timings, rows: (newer ? 1 : 0) + (pending ? 1 : 0) + (row ? 1 : 0) };
}

/**
 * #6712 PR 4b (design v3.2 §2.2): the idle tick's database reads in one statement: the pass row, whether a request of the
 * worktree is newer than the converged watermark (a range on the unique `sequence` index; `requestHwm` overrides the
 * row's), whether any request is open (`persistence_requests_pending`), and how many of the ids recorded in
 * `converged.open_at_stamp` are still open (`r:<request>` requests, `e:<effect>` Git effects; `openAtStamp` null reads the
 * row's, so the probe needs no earlier read of the row), and whether a writeback in `converged.writeback` has an uncommitted Git effect.
 */
export async function passIdleProbe(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; worktreeId: string;
  requestHwm: string | number | null; openAtStamp: readonly string[] | null }): Promise<{ passRow: Record<string, unknown> | null; newer: boolean; pending: boolean; stillOpen: number; writebackOpen: boolean }> {
  const [probe] = await engine.executeRaw<{ pass_row: Record<string, unknown> | null; newer: boolean; pending: boolean; still_open: number | string; writeback_open: boolean }>(`WITH pass AS (
      SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2),
    stamp AS (SELECT unnest(COALESCE($5::text[], ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(value->'obligations'->'converged'->'open_at_stamp')='array'
      THEN value->'obligations'->'converged'->'open_at_stamp' ELSE '[]'::jsonb END) FROM pass))) AS id)
    SELECT (SELECT value FROM pass) AS pass_row,
      EXISTS (SELECT 1 FROM persistence_requests WHERE sequence > COALESCE($3::bigint, ((SELECT value FROM pass)->'obligations'->'converged'->>'request_hwm')::bigint, 0)
        AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS newer,
      EXISTS (SELECT 1 FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)) AS pending,
      (SELECT count(*) FROM persistence_requests WHERE state IN ('queued','running','recovering') AND (worktree_id = $4 OR worktree_id IS NULL AND source_id = $6 AND source_incarnation = $7::uuid)
        AND 'r:'||request_id::text IN (SELECT id FROM stamp))
        + (SELECT count(*) FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
            WHERE r.worktree_id = $4 AND e.kind = 'git' AND e.state IN ('queued','running') AND 'e:'||e.id::text IN (SELECT id FROM stamp)) AS still_open,
      EXISTS (SELECT 1 FROM persistence_effects e WHERE e.kind = 'git' AND e.state <> 'committed' AND NOT (e.data ? 'settled') AND e.request_id IN (SELECT id::uuid FROM pass,
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(value->'obligations'->'converged'->'writeback')='array' THEN value->'obligations'->'converged'->'writeback' ELSE '[]'::jsonb END) AS w(id))) AS writeback_open`,
    [MANAGED_SYNC_PASS_OP, `${input.sourceId}:${input.incarnation}`, input.requestHwm, input.worktreeId, input.openAtStamp ? [...input.openAtStamp] : null, input.sourceId, input.incarnation]);
  return { passRow: probe?.pass_row ?? null, newer: probe?.newer === true, pending: probe?.pending === true, stillOpen: Number(probe?.still_open ?? 0), writebackOpen: probe?.writeback_open === true };
}

/**
 * `gbrain sync --dry-run --json`'s `convergence` for one source: the receipt with the read-only screen, undefined
 * on a brain that is not managed or for a company-brain source; a read that cannot run reports why instead of failing
 * the dry run.
 */
export async function dryRunConvergence(engine: BrainEngine, input: { sourceId: string; full: boolean; workingTree?: boolean; redactPaths: boolean;
  noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean }): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | undefined> {
  if (!await readManagedMode(engine)) return undefined;
  try {
    const context = await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
    return await shadowConvergence(engine, { sourceId: input.sourceId, full: input.full, workingTree: input.workingTree, redactPaths: input.redactPaths, context,
      screen: readOnlySameContentScreen(engine, context, { noEmbed: input.noEmbed, noExtract: input.noExtract, noSchemaPack: input.noSchemaPack }) }) ?? undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** \`sync status --detail\`'s \`convergence\`: the receipt without the screen (status never prepares an import). */
export async function statusConvergence(engine: BrainEngine, sourceId: string): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | null> {
  if (!await readManagedMode(engine)) return null;
  try {
    return await shadowConvergence(engine, { sourceId, screen: false });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}
