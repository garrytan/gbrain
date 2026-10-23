/**
 * `gbrain repair file-drift --source <id> (--slug <s>... | --request <id>... | --all-drifted [--class <c>] [--since <ISO|7d>]) --prefer file|database`
 * (#6643 B2): resolve pages whose canonical file differs from their database row
 * (the `source_changed` / `file_database_drift` refusal) through canonical
 * reconciliation, preferring one side.
 *
 * The preferred side wins every ordinary field (title, type, body, timeline and
 * unprotected frontmatter; a key only the other side has is dropped) WITHIN
 * reconcile's existing protections: protected metadata (provenance, trust,
 * source and scan fields) stays as the database holds it, tags are the union of
 * both sides, and protected takes and private fact rows are kept as stored.
 * Each page's preview lists where its result differs from the preferred side
 * (`exceptions`) and why.
 *
 * Explicit-only and preview-bound: the preview checks each page live on the
 * canonical owner, preflights the CLI writer grant, prepares the reconcile
 * result, writes every page's resolved result and exceptions to a private
 * artifact under the gbrain config directory (`repair-previews/file-drift/
 * <hash>.json`, outside every canonical worktree) and saves the set under the
 * plan hash. `--apply --expect <hash>` applies exactly that set: each page goes
 * through the reconcile apply (its preimage checks and retained backups) under
 * a request id derived from the plan hash and slug, so an interrupted apply
 * resumes from the saved plan and replays the same requests. Outcomes per page:
 * `repaired`, `refused` (with the refusal code) or `changed_since_preview`.
 *
 * `--all-drifted` takes every page the conflict audit finds still drifted. It
 * refuses a selection that mixes drift classes unless `--class <name>` keeps
 * exactly one, so one `--prefer` never resolves differently shaped drift in bulk.
 * #6696 C7: repeatable `--only` / `--skip` over the canonical file path,
 * source-relative: an exact path, or a glob (`*` within a segment, `**` across
 * segments; `path-glob.ts`, file-drift being the only kind that takes globs),
 * narrow the selection before the class check, the bound and any preview
 * work; they are part of the selection digest (so of the plan hash) and of
 * every printed preview and apply command. #6712 PR 2: `--since` keeps the pages whose newest
 * drift conflict is at or after one concrete instant (the CLI resolves an age once, `since.ts`), part of
 * the selection digest and of every printed command. Trusted local CLI only.
 *
 * #6712 wave: a selected live page whose canonical file is gone from the last commit (a ghost whose deletion is
 * committed, such as a held deletion whose page moved) resolves too: `--prefer database` recreates the file from the
 * page through the same reconcile apply (its preview pins the observed absence, so a file that reappears is
 * `changed_since_preview`), and `--prefer file` soft-deletes exactly that page through the ghost-page retirement intent
 * (bound to its revision, path and owner; the mass-delete valve applies). A file deleted only in the worktree (still
 * committed at HEAD) is not drift: the preview lists it `deletion_uncommitted` with its route (commit the deletion, or
 * `gbrain repair ghost-pages`) and resolves nothing.
 *
 * #6712 PR 4b: `--held [--side both|unknown|deleted [--state tombstone_edited|purged_differs|file_gone]]` selects the
 * source's held `file_drift` pages of one Decision (design v3.2 §4). A selection of several sides or states is refused
 * (`file_drift_mixed_selection`) and a deleted side needs `--state` (`file_drift_state_required`), because the two
 * options do opposite things in each state. Both/unknown pages resolve as above, `file_gone` as the wave's file-gone
 * modes; `tombstone_edited` and `purged_differs` (a deleted page, or a deletion marker, at the origin of a file that
 * differs) resolve `--prefer database` by removing the file through a coordinated publication (`prepareDriftFileRemoval`;
 * the deletion stands) and `--prefer file` by importing the file's bytes through the managed file repair (the tombstone is
 * restored, or a new page created; a marker stays for sync to retire). The preview lists each page's action verb.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { validateSlug } from '../utils.ts';
import { matchesRepairPath } from './path-glob.ts';
import { shellQuote } from '../agent-output.ts';
import type { ParsedPage } from '../import-file.ts';
import { digest, stableJson } from '../persistence/digest.ts';
import { currentVerifiedLocalWriter, readLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';
import { auditDriftConflicts, DRIFT_CLASSES, driftClass, liveFileDrift, type DriftClass } from '../persistence/drift-conflicts.ts';
import { protectedReconcileKey, reconcileCanonical, RECONCILE_SCAN_KEYS, type ReconcileDecision } from '../persistence/reconcile-merge.ts';
import { ABSENT_FILE_HASH, canonicalDeletionState, missingFileRoute, readDeletedDriftTarget, readReconcileState, type DeletedDriftChange, type DeletedDriftTarget, type ReconcileArtifact } from '../persistence/reconcile-state.ts';
import { clearGitHold, fileDriftActionVerb, fileDriftSide, FILE_DRIFT_DELETED_STATES, FILE_DRIFT_SIDES, GIT_HOLD_OP, heldDriftPreviewArgv, type FileDriftDeletedState, type FileDriftSide, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../persistence/file-repair.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { resolveSlugForPath } from '../sync.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { gitDurabilityPolicy } from '../persistence/git-durability-policy.ts';
import { DETACHED_REASON } from '../persistence/detached-pages.ts';
import { DELETION_PROVENANCES, readDeletionProvenance, type DeletionProvenance } from '../persistence/sync-origin-evidence.ts';
import { ghostPageNow, scanGhostSource, type GhostOwner, type GhostPage } from '../ghost-pages.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { DATABASE_AHEAD_CODE, databaseAheadDetail, ghostFileBacked, GHOST_PURGE_FUSE_HOURS, GHOST_REPAIR_LIMIT, ghostScanRefusal, massGhosts, massRefusal, retireGhost } from './ghost-pages.ts';
import { prepareReconcileResult } from '../persistence/reconcile-prepare.ts';
import { canonicalOriginPage, originConflictMessage, originTwinsFix } from '../persistence/origin-guard.ts';
import { assertReconcileOutputPath, assertReconcileSize } from '../persistence/reconcile-backup.ts';
import { authorizeReconcile, runReconcileApply } from '../persistence/reconcile.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

export type DriftSide = 'file' | 'database';
/** Where a page's resolved result differs from the preferred side, and why. */
export interface DriftException { path: string; reason: 'protected_metadata' | 'scan_state' | 'tags_union' | 'protected_takes_or_private_facts' | 'canonical_import' }
interface ApprovedPage { source_id: string; slug: string; artifact_digest: string; selection: string }
interface DriftItem extends RepairItem { page: ApprovedPage; hash: string; last: boolean }
/** One page's prepared resolution: the ready reconcile preview its apply submits, and where it departs from the preferred side. */
export interface ArtifactPage { slug: string; prefer: DriftSide; class?: DriftClass; adopt_slug_path: boolean; exceptions: DriftException[]; result: ParsedPage; preview: ReconcileArtifact;
  /** #6712 wave: the canonical file is gone from the last commit and the apply recreates it from the page. */
  file_gone?: true }
/** #6712 wave: a page whose canonical file is gone from the last commit, resolved `--prefer file`: soft-delete exactly that page. */
export interface SoftDeletePage { slug: string; prefer: 'file'; exceptions: DriftException[]; soft_delete: { ghost: GhostPage; owner: GhostOwner } }
/**
 * #6712 PR 4b: what a held deleted-side resolution is bound to (design v3.2 §4): the file's bytes, the tombstone's id and
 * revision (`tombstone_edited`) or the deletion marker's value (`purged_differs`), and the hold it clears.
 */
export interface DeletedDriftPin { state: 'tombstone_edited' | 'purged_differs'; path: string; source_path: string; raw_file_hash: string;
  page_id: number | null; revision: string | null; marker_digest: string | null; observed_at: string }
/** #6712 PR 4b `--prefer database` on a deleted side: the deletion stands and the file is removed by a coordinated publication. */
export interface RemoveFilePage { slug: string; prefer: 'database'; exceptions: DriftException[]; remove_file: DeletedDriftPin }
/** #6712 PR 4b `--prefer file` on a deleted side: the file's bytes are imported (restoring the tombstone, or as a new page). */
export interface ImportFilePage { slug: string; prefer: 'file'; exceptions: DriftException[]; import_file: DeletedDriftPin & { result_digest: string } }
/**
 * GBRA-133 `--provenance never_committed --prefer database`: a live page whose held file no commit ever held keeps its content
 * database-only. The apply forgets the page's recorded file (`database_only_reason=detached`, as `restore --detach` does),
 * writes no file and clears the hold, bound to the page's id, revision and path and to the hold it observed.
 */
export interface DetachPin { path: string; page_id: number; revision: string; observed_at: string }
export interface DetachPage { slug: string; prefer: 'database'; exceptions: DriftException[]; detach_page: DetachPin }
type PlannedPage = ArtifactPage | SoftDeletePage | RemoveFilePage | ImportFilePage | DetachPage;
/** #6712 PR 4b: one held `file_drift` page a `--held` selection resolves. */
interface HeldTarget { hold: GitHoldRecord; side: FileDriftSide; state?: FileDriftDeletedState; provenance?: DeletionProvenance }

/** The coordinated removal `--prefer database` admits for a held file whose page is deleted (prepared by `prepareDriftFileRemoval`). */
export const FILE_DRIFT_REMOVE_INTENT = 'managed_maintenance_file_drift_remove';
/** GBRA-133: the database-only keep of a live page whose held file no commit ever held (`prepareDriftDetach`). */
export const FILE_DRIFT_DETACH_INTENT = 'managed_maintenance_file_drift_detach';
const DELETED_CHANGES: Record<DeletedDriftChange, string> = {
  file_gone: 'the file is gone now, so nothing is left to resolve',
  live_page: 'a live page records the file again, so it is no longer a deleted-side Decision',
  no_deletion: 'no deleted page or deletion marker is left at its origin; the next sync re-classifies it',
  deleted_same: 'the file holds the bytes the deleted page had, so the deletion already stands',
};

const ALL_DRIFTED_LIMIT = 1000;
/**
 * A `--held` preview covers one window of the selected holds, in held-path order after `--cursor`: at most this many pages,
 * and it starts no page after the window's time budget (or the run's deadline) has passed. Each page costs a few dozen
 * database round trips, so a whole large held set in one preview ran for an hour against a remote database with no output.
 */
const HELD_WINDOW_PAGES = 200;
const HELD_WINDOW_BUDGET_MS = 60_000;
const HELD_CURSOR_PREFIX = 'h1.';
const heldCursor = (path: string) => HELD_CURSOR_PREFIX + Buffer.from(path, 'utf8').toString('base64url');
function heldCursorPath(sourceId: string, cursor: string): string {
  const path = cursor.startsWith(HELD_CURSOR_PREFIX) ? Buffer.from(cursor.slice(HELD_CURSOR_PREFIX.length), 'base64url').toString('utf8') : '';
  if (!path || heldCursor(path) !== cursor) throw opError('invalid_params', `--cursor ${cursor} is not a cursor a held file-drift preview printed.`,
    `Nothing was previewed. Pass the next_cursor the previous preview printed, or drop --cursor to start from the first held file of '${sourceId}'.`);
  return path;
}
const TOP_FIELDS = ['title', 'type', 'compiled_truth', 'timeline'] as const;
const artifactDirectory = () => join(canonicalFilesystemPath(configDir()), 'repair-previews', 'file-drift');
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function previewCommand(sourceId: string, opts: RepairPlanOptions): string {
  const select = opts.held ? ` --held${opts.side ? ` --side ${opts.side}` : ''}${opts.state ? ` --state ${opts.state}` : ''}${opts.provenance ? ` --provenance ${opts.provenance}` : ''}${opts.cursor ? ` --cursor ${opts.cursor}` : ''}`
    : opts.allDrifted ? ` --all-drifted${opts.driftClass ? ` --class ${opts.driftClass}` : ''}${opts.since ? ` --since ${opts.since}` : ''}`
    : [...(opts.slugs ?? []).map(slug => ` --slug ${slug}`), ...(opts.requests ?? []).map(id => ` --request ${id}`)].join('');
  const globs = [...(opts.only ?? []).flatMap(glob => ['--only', glob]), ...(opts.skip ?? []).flatMap(glob => ['--skip', glob])];
  return `gbrain repair file-drift --source ${sourceId}${select}${globs.length ? ` ${shellQuote(globs)}` : ''} --prefer ${opts.prefer ?? '<file|database>'}`;
}

/** Whether a canonical file path passes the `--only` / `--skip` globs (no `--only`: every path; an unknown path only then). */
const selectedByGlobs = (path: string | undefined, opts: Pick<RepairPlanOptions, 'only' | 'skip'>) =>
  path === undefined ? !opts.only?.length && !opts.skip?.length
    : (!opts.only?.length || matchesRepairPath(path, opts.only)) && !matchesRepairPath(path, opts.skip);

/** #6712 PR 2: whether a page's newest drift conflict (`last_seen`) is at or after `--since` (no `--since`: every page). */
const sinceSelects = (lastSeen: string, since: string | undefined) => !since || Date.parse(lastSeen) >= Date.parse(since);

/** The reconcile decisions that make the preferred side win every field reconcile lets a decision choose. */
export function preferSideDecisions(file: ParsedPage, database: ParsedPage, prefer: DriftSide): ReconcileDecision[] {
  const take = prefer === 'file' ? 'take_file' : 'take_database';
  const [preferred, other] = prefer === 'file' ? [file, database] : [database, file];
  const decisions: ReconcileDecision[] = TOP_FIELDS.filter(key => digest(file[key] ?? '') !== digest(database[key] ?? '')).map(key => ({ path: `/${key}`, action: take }));
  const extraction = file.frontmatter.provenance === 'auto-extracted' || database.frontmatter.provenance === 'auto-extracted';
  for (const key of [...new Set([...Object.keys(preferred.frontmatter), ...Object.keys(other.frontmatter)])].sort()) {
    if (protectedReconcileKey(key) || extraction && key === 'status') continue;
    const has = Object.hasOwn(preferred.frontmatter, key);
    if (has && Object.hasOwn(other.frontmatter, key) && digest(preferred.frontmatter[key]) === digest(other.frontmatter[key])) continue;
    decisions.push({ path: `/frontmatter/${escapePointer(key)}`, action: has ? take : 'delete' });
  }
  return decisions;
}

/** Every path where the resolved result is not the preferred side, with the protection that kept it. */
export function driftExceptions(result: ParsedPage, preferred: ParsedPage): DriftException[] {
  const exceptions: DriftException[] = [];
  for (const key of TOP_FIELDS) {
    if (digest(result[key] ?? '') === digest(preferred[key] ?? '')) continue;
    exceptions.push({ path: `/${key}`, reason: key === 'compiled_truth' || key === 'timeline' ? 'protected_takes_or_private_facts' : 'canonical_import' });
  }
  if (digest([...result.tags].sort()) !== digest([...preferred.tags].sort())) exceptions.push({ path: '/tags', reason: 'tags_union' });
  for (const key of [...new Set([...Object.keys(result.frontmatter), ...Object.keys(preferred.frontmatter)])].sort()) {
    if (digest(result.frontmatter[key] ?? null) === digest(preferred.frontmatter[key] ?? null)) continue;
    exceptions.push({ path: `/frontmatter/${escapePointer(key)}`, reason: RECONCILE_SCAN_KEYS.includes(key) ? 'scan_state'
      : protectedReconcileKey(key) || key === 'status' ? 'protected_metadata' : 'canonical_import' });
  }
  return exceptions;
}

async function asLocalCli<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  const verified = currentVerifiedLocalWriter();
  if (verified) {
    if (verified.remote || verified.principal.kind !== 'local_cli') throw trustedCliRequired('gbrain repair file-drift runs only for the trusted local CLI.');
    return run();
  }
  return withVerifiedLocalRegistration(engine, await readLocalWriter(engine, 'cli'), run);
}

function requestIdFor(hash: string, page: Pick<ApprovedPage, 'source_id' | 'slug'>): string {
  const h = digest(['file-drift-request-v1', hash, page.source_id, page.slug]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function writeArtifact(hash: string, value: unknown): string {
  const directory = artifactDirectory();
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw opError('permission_denied', 'The file-drift preview directory must be a private real directory.',
    `Nothing was written. Make ${directory} a real directory owned by the user with mode 0700 (not a symlink), then preview again.`);
  const path = join(directory, `${hash}.json`);
  const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, stableJson(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  flushDirectory(directory);
  return path;
}

/**
 * The parsed artifact of the newest preview read, keyed by its path and file identity. An apply reads the artifact once per
 * page, and a preview of large pages writes hundreds of megabytes, so parsing it again for every page cost seconds each.
 */
let artifactMemo: { key: string; pages: Map<string, PlannedPage> } | null = null;

/** The preview artifact's pages by slug; the same parsed map while the file is unchanged. Exported for its test. */
export function readArtifact(hash: string, command: string): Map<string, PlannedPage> {
  const path = join(artifactDirectory(), `${hash}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    const key = `${path}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (artifactMemo?.key === key) return artifactMemo.pages;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pages?: PlannedPage[] };
    const pages = new Map((parsed.pages ?? []).map(page => [page.slug, page]));
    artifactMemo = { key, pages };
    return pages;
  } catch { throw previewChangedError(hash, command); }
}

/**
 * The slugs the selection names: exact slugs, the slugs of named conflict receipts, or every page the audit finds
 * still drifted. `--all-drifted` is narrowed here by the `--only` / `--skip` globs over each page's canonical file
 * path (`not_selected` counts the pages they leave out), before the class check and the bound; an exact selection
 * is narrowed by the plan from the same live check.
 */
async function selectSlugs(engine: BrainEngine, sourceId: string, opts: RepairPlanOptions): Promise<{ slugs: string[]; classes: Map<string, DriftClass>; notSelected: number; unknown: UnknownDrift[] }> {
  const classes = new Map<string, DriftClass>();
  const unknown: UnknownDrift[] = [];
  if (opts.allDrifted) {
    const drifted: string[] = [];
    let notSelected = 0;
    let cursor: string | undefined;
    do {
      const page = await auditDriftConflicts(engine, sourceId, { trusted: true, excludePrivate: false }, { limit: 100, cursor });
      for (const row of page.conflicts) {
        if (row.still_present.value === false) continue;
        if (!selectedByGlobs(row.path, opts) || !sinceSelects(row.last_seen, opts.since)) { notSelected++; continue; }
        if (row.still_present.value === null) { unknown.push({ slug: row.slug, reason: row.still_present.reason }); continue; }
        drifted.push(row.slug); classes.set(row.slug, row.class ?? 'error');
      }
      cursor = page.next ?? undefined;
    } while (cursor && drifted.length < ALL_DRIFTED_LIMIT);
    const counts = new Map<DriftClass, number>();
    for (const value of classes.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
    if (!opts.driftClass && counts.size > 1) {
      const listed = [...counts].map(([name, count]) => `${name}=${count}`).join(', ');
      throw opError('invalid_params', `The drifted pages of '${sourceId}' fall into ${counts.size} drift classes (${listed}); one --prefer must not resolve them in bulk.`,
        `Preview one class at a time: ${previewCommand(sourceId, { ...opts, driftClass: [...counts.keys()][0] })}, and so on for each class; or name pages with --slug.`,
        { fix: readFix('Lists the drifted pages with their drift class, read-only.', { argv: ['gbrain', 'sources', 'reconcile', sourceId, '--brain', 'host', '--audit', '--conflicts', '--json'] }) });
    }
    return { slugs: drifted.filter(slug => !opts.driftClass || classes.get(slug) === opts.driftClass), classes, notSelected, unknown };
  }
  const slugs = new Set(opts.slugs ?? []);
  if (opts.requests?.length) {
    const rows = await engine.executeRaw<{ request_id: string; slug: string }>(
      "SELECT request_id::text, slug FROM persistence_requests WHERE source_id=$1 AND request_id=ANY($2::uuid[]) AND state='conflict' AND error_code='source_changed'",
      [sourceId, opts.requests]);
    const missing = opts.requests.filter(id => !rows.some(row => row.request_id === id));
    if (missing.length) throw opError('invalid_params', `Request ${missing[0]} is not a source_changed conflict of source '${sourceId}'.`,
      `Pass the request id of a conflict receipt the audit lists (last_conflict_request_id), or select the page with --slug.`,
      { fix: readFix('Lists the conflict receipts of this source grouped by slug, read-only.', { argv: ['gbrain', 'sources', 'reconcile', sourceId, '--brain', 'host', '--audit', '--conflicts', '--json'] }) });
    for (const row of rows) slugs.add(row.slug);
  }
  return { slugs: [...slugs].sort(), classes, notSelected: 0, unknown };
}

/** #6991: a conflicted page the live check could not classify; it is listed and counted, never repaired. */
interface UnknownDrift { slug: string; reason: string }

function unknownDriftDetail(sourceId: string, { slug, reason }: UnknownDrift): string {
  const kept = 'Not classified or repaired.';
  if (reason === 'not_owner_host') return `${reason}: ${kept} Run the drift audit for source ${sourceId} on its active canonical owner host.`;
  if (reason === 'page_missing') return `${reason}: ${kept} The page is gone from the database; decide its content by hand, no --prefer applies to it.`;
  if (reason === 'canonical_file_missing') return `${reason}: ${kept} Its canonical file is missing; preview it alone with --slug ${slug} to choose a side.`;
  if (reason === 'error') return `${reason}: ${kept} The live check failed unexpectedly; rerun gbrain sources reconcile ${sourceId} --audit --conflicts --json.`;
  return `${reason}: ${kept} The live check refused; preview it alone with --slug ${slug} to see the refusal.`;
}

/**
 * #6712 PR 4b `--held`: the source's held `file_drift` pages of one side (and, for a deleted side, one state), narrowed by
 * the `--only` / `--skip` globs over the held file path. Without `--side` the narrowed holds must all be one Decision;
 * holds of several sides or states are refused (`file_drift_mixed_selection`), and a deleted side always needs `--state`
 * (`file_drift_state_required`): its two actions are opposite. Holds an older gbrain wrote with `sides: database` have
 * no side and are listed with their single-page route.
 */
async function selectHeld(engine: BrainEngine, sourceId: string, opts: RepairPlanOptions & { prefer: DriftSide }):
  Promise<{ targets: HeldTarget[]; before: number; notSelected: number; legacy: GitHoldRecord[]; otherProvenance: number; provenance?: Record<string, number> }> {
  const after = opts.cursor ? heldCursorPath(sourceId, opts.cursor) : null;
  const rows = await engine.executeRaw<{ record: GitHoldRecord; in_window: boolean }>(`SELECT h.completed_keys->0 AS record,
      ($3::text IS NULL OR (h.completed_keys->0->>'path') COLLATE "C" > $3::text) AS in_window FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND s.id=$2 AND h.completed_keys->0->>'code'='file_drift' ORDER BY (h.completed_keys->0->>'path') COLLATE "C"`, [GIT_HOLD_OP, sourceId, after]);
  const targets: Array<HeldTarget & { inWindow: boolean }> = [], legacy: GitHoldRecord[] = [];
  let notSelected = 0;
  for (const { record, in_window } of rows) {
    if (!selectedByGlobs(record.path, opts)) { notSelected++; continue; }
    const side = fileDriftSide(record.meta);
    if (!side || side === 'deleted' && !record.meta.state) { if (in_window) legacy.push(record); continue; }
    targets.push({ hold: record, side, ...(side === 'deleted' ? { state: record.meta.state } : {}), inWindow: in_window === true });
  }
  const key = (target: Pick<HeldTarget, 'side' | 'state'>) => target.state ? `${target.side}/${target.state}` : target.side;
  const groups = new Map<string, { side: FileDriftSide; state?: FileDriftDeletedState; count: number }>();
  for (const target of targets) {
    const group = groups.get(key(target)) ?? { side: target.side, ...(target.state ? { state: target.state } : {}), count: 0 };
    group.count++; groups.set(key(target), group);
  }
  const narrower = (group: { side: FileDriftSide; state?: FileDriftDeletedState }) => heldCommand(sourceId, group.side, group.state, opts.prefer, opts);
  const statusFix = readFix('Lists the held files of this source with their side and state, read-only.', { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] });
  if (!opts.side && groups.size > 1) {
    const listed = [...groups.entries()].map(([name, group]) => `${name}=${group.count}`).join(', ');
    throw opError('file_drift_mixed_selection', `The held file-drift pages of '${sourceId}' are ${groups.size} different Decisions (${listed}); one --prefer must not resolve them in bulk.`,
      `Nothing was previewed. Preview one Decision at a time: ${[...groups.values()].map(narrower).join('; ')}.`, { fix: statusFix });
  }
  const only = !opts.side && groups.size === 1 ? [...groups.values()][0]! : null;
  if (only?.side === 'deleted') throw stateRequired(sourceId, opts, [only.state!]);
  const selected = targets.filter(target => !opts.side || target.side === opts.side && (!opts.state || target.state === opts.state));
  let window = selected.filter(target => target.inWindow).map(({ inWindow: _inWindow, ...target }) => target);
  // GBRA-133: a gone file's provenance (sync-origin-evidence.ts), read for every held file a --provenance selection filters, else for one window.
  const gone = window.filter(target => target.state === 'file_gone').slice(0, opts.provenance ? undefined : HELD_WINDOW_PAGES);
  const provenance: Record<string, number> = Object.fromEntries([...DELETION_PROVENANCES, 'unknown'].map(kind => [kind, 0]));
  if (gone.length) {
    const binding = await getWorktreeBinding(engine, sourceId);
    // One walk of the history; a long one takes a while, so the preview says it is reading (stderr).
    opts.progress?.start('repair.file_drift.provenance', gone.length);
    let read: Map<string, DeletionProvenance>;
    try {
      read = await readDeletionProvenance(join(binding!.local_path!, binding!.relative_path), gone.map(target => target.hold.path),
        { onCommit: commits => opts.progress?.heartbeat(`read ${commits} commit(s) of history for ${gone.length} held file(s)`) });
    } finally { opts.progress?.finish(); }
    for (const target of gone) {
      target.provenance = read.get(target.hold.path) ?? { kind: 'unknown' };
      provenance[target.provenance.kind] = (provenance[target.provenance.kind] ?? 0) + 1;
    }
  }
  const otherProvenance = opts.provenance ? window.filter(target => target.provenance?.kind !== opts.provenance).length : 0;
  if (opts.provenance) window = window.filter(target => target.provenance?.kind === opts.provenance);
  return { targets: window, before: selected.filter(target => !target.inWindow).length, notSelected, legacy, otherProvenance, ...(gone.length ? { provenance } : {}) };
}

/** #6712 PR 4b: the `--held` preview of one Decision, keeping the run's `--only` / `--skip` globs. */
function heldCommand(sourceId: string, side: FileDriftSide, state: FileDriftDeletedState | undefined, prefer: DriftSide, opts: Pick<RepairPlanOptions, 'only' | 'skip'>): string {
  const argv = heldDriftPreviewArgv(sourceId, side, state, prefer);
  return shellQuote([...argv.slice(0, -2), ...(opts.only ?? []).flatMap(glob => ['--only', glob]), ...(opts.skip ?? []).flatMap(glob => ['--skip', glob]), ...argv.slice(-2)]);
}

/** #6712 PR 4b: `--side deleted` without `--state` (or a held selection that is all one deleted state) names the state to resolve. */
function stateRequired(sourceId: string, opts: RepairPlanOptions, states: readonly FileDriftDeletedState[]): OperationError {
  const prefer = opts.prefer ?? 'database';
  const commands = states.map(state => `${heldCommand(sourceId, 'deleted', state, prefer, opts)} (--prefer ${prefer}: ${fileDriftActionVerb('deleted', state, prefer)})`);
  return opError('file_drift_state_required', 'Resolving held deleted-side file drift needs --state: --prefer file and --prefer database do opposite things in each state.',
    `Nothing was previewed. Name the state: ${commands.join('; ')}.`,
    { fix: readFix('Lists the held files of this source with their side and state, read-only.', { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] }) });
}

function validateOptions(scope: RepairScope, opts: RepairPlanOptions | undefined): asserts opts is RepairPlanOptions & { prefer: DriftSide } {
  if (opts?.remote !== false) throw trustedCliRequired('gbrain repair file-drift runs only for the trusted local CLI on the brain host.');
  const usage = 'gbrain repair file-drift --source <id> (--slug <slug>... | --request <id>... | --all-drifted [--class <name>] [--since <ISO-8601|7d>] | --held [--side both|unknown|deleted [--state tombstone_edited|purged_differs|file_gone [--provenance never_committed|deleted_by_commit|deletion_uncommitted]]] [--cursor <next_cursor>]) [--only <glob>]... [--skip <glob>]... --prefer file|database';
  if (scope.source_ids.length !== 1) throw opError('invalid_params', 'gbrain repair file-drift needs exactly one --source.', `Name the source: ${usage}`);
  if (opts.prefer !== 'file' && opts.prefer !== 'database') throw opError('invalid_params', 'gbrain repair file-drift needs --prefer file or --prefer database.',
    `Choose the side whose content wins (protected metadata, tags union, protected takes and private facts are kept either way): ${usage}`);
  const modes = [opts.slugs?.length ? 1 : 0, opts.requests?.length ? 1 : 0, opts.allDrifted ? 1 : 0, opts.held ? 1 : 0].reduce((a, b) => a + b, 0);
  if (modes !== 1) throw opError('invalid_params', 'Select pages one way: --slug, --request, --all-drifted or --held.', `Pick one selection: ${usage}`);
  if ((opts.side || opts.state) && !opts.held) throw opError('invalid_params', '--side and --state only narrow --held.', `Drop them, or select the held pages with --held: ${usage}`);
  if (opts.cursor && !opts.held) throw opError('invalid_params', '--cursor only continues a --held preview.', `Drop --cursor, or continue the held preview that printed it: ${usage}`);
  if (opts.side && !(FILE_DRIFT_SIDES as readonly string[]).includes(opts.side)) throw opError('invalid_params', `Unknown file-drift side '${opts.side}'.`,
    `Pass --side ${FILE_DRIFT_SIDES.join(', --side ')}; gbrain sources status ${scope.source_ids[0]} --json lists each held file's side.`);
  if (opts.state && !(FILE_DRIFT_DELETED_STATES as readonly string[]).includes(opts.state)) throw opError('invalid_params', `Unknown deleted-side state '${opts.state}'.`,
    `Pass --state ${FILE_DRIFT_DELETED_STATES.join(', --state ')} with --side deleted; gbrain sources status ${scope.source_ids[0]} --json lists each held file's state.`);
  if (opts.state && opts.side !== 'deleted') throw opError('invalid_params', '--state only narrows --side deleted.', `Drop --state, or pass --side deleted with it: ${usage}`);
  if (opts.side === 'deleted' && !opts.state) throw stateRequired(scope.source_ids[0]!, opts, FILE_DRIFT_DELETED_STATES);
  if (opts.provenance && !(DELETION_PROVENANCES as readonly string[]).includes(opts.provenance)) throw opError('invalid_params', `Unknown deletion provenance '${opts.provenance}'.`,
    `Pass --provenance ${DELETION_PROVENANCES.join(', --provenance ')}; each page of a --held --side deleted --state file_gone preview names its provenance.`);
  if (opts.provenance && opts.state !== 'file_gone') throw opError('invalid_params', '--provenance only narrows --held --side deleted --state file_gone.',
    `Add --held --side deleted --state file_gone, or drop --provenance: ${usage}`);
  if (opts.provenance === 'never_committed' && opts.prefer === 'file') throw opError('invalid_params', 'A never-committed held file cannot be resolved --prefer file.',
    `Nothing was previewed. No commit ever held these files, so each page holds the only copy of its content and --prefer file would soft-delete it (purged after ${GHOST_PURGE_FUSE_HOURS} h). `
    + `Keep them database-only with --prefer database, or preview one page alone with --slug when its deletion is really intended.`);
  if (opts.driftClass && !opts.allDrifted) throw opError('invalid_params', '--class only narrows --all-drifted.', `Drop --class, or use it with --all-drifted: ${usage}`);
  if (opts.since && !opts.allDrifted) throw opError('invalid_params', '--since only narrows --all-drifted.', `Drop --since, or use it with --all-drifted: ${usage}`);
  if (opts.driftClass && !(DRIFT_CLASSES as readonly string[]).includes(opts.driftClass)) throw opError('invalid_params', `Unknown drift class '${opts.driftClass}'.`,
    `Pass one of ${DRIFT_CLASSES.join(', ')}; the conflict audit lists each drifted page's class.`);
  for (const slug of opts.slugs ?? []) {
    try { validateSlug(slug); } catch { throw opError('invalid_params', `Invalid page slug '${slug}'.`, 'Pass each page by its exact stored slug.'); }
  }
  for (const glob of [...(opts.only ?? []), ...(opts.skip ?? [])]) {
    try { validateSlug(glob); } catch {
      throw opError('invalid_params', `Invalid file path glob '${glob}'.`,
        `--only and --skip take a canonical file path relative to the source, without a leading / or .. segment: an exact path, or (file-drift only) a glob where * matches within one path segment and ** across segments (e.g. --only concepts/agi.md or --only 'concepts/**'). ${usage}`);
    }
  }
  if (opts.requests?.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw opError('invalid_params', '--request takes a conflict receipt request UUID.', 'Pass the request id the conflict audit lists (last_conflict_request_id).');
  }
}

/**
 * The bare `gbrain repair file-drift` (the explicit-only preview command doctor and `repair --all` print): a read-only
 * survey of the drifted pages per source with their drift class and the preview command for each class. Nothing to apply.
 */
async function survey(engine: BrainEngine, scope: RepairScope, opts: Pick<RepairPlanOptions, 'since'>): Promise<RepairPlan> {
  const listing: NonNullable<RepairPlan['listing']> = [];
  const residuals: Record<string, number> = {};
  const next: string[] = [];
  for (const sourceId of scope.source_ids) {
    const counts = new Map<DriftClass, number>();
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await auditDriftConflicts(engine, sourceId, { trusted: true, excludePrivate: false }, { limit: 100, cursor });
      for (const row of page.conflicts) {
        if (row.still_present.value === false || !sinceSelects(row.last_seen, opts.since)) continue;
        if (row.still_present.value === null) {
          residuals[`unknown_${row.still_present.reason}`] = (residuals[`unknown_${row.still_present.reason}`] ?? 0) + 1;
          listing.push({ item: `${sourceId}:${row.slug}`, class: 'unknown', detail: unknownDriftDetail(sourceId, { slug: row.slug, reason: row.still_present.reason }) });
          continue;
        }
        const kind = row.class ?? 'error';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        residuals[`drifted_${kind}`] = (residuals[`drifted_${kind}`] ?? 0) + 1;
        listing.push({ item: `${sourceId}:${row.slug}`, class: kind, detail: `${row.drift_receipts} conflict receipt(s)` });
      }
      seen += page.conflicts.length;
      cursor = page.next ?? undefined;
    } while (cursor && seen < ALL_DRIFTED_LIMIT);
    for (const kind of counts.keys()) next.push(previewCommand(sourceId, { apply: false, allDrifted: true, driftClass: kind, ...(opts.since ? { since: opts.since } : {}), prefer: 'file' }));
  }
  return { items: [], residuals, listing, details: { survey: true,
    next_actions: next.length ? [...next.map(command => `Preview: ${command} (or --prefer database)`), 'Or preview single pages with --slug <slug>.'] : [] } };
}

/** #6948: a page is repaired from a file only when it is that file's canonical page; a twin (or an ambiguous file) is refused `origin_conflict`. */
async function refuseForeignOrigin(engine: BrainEngine, sourceId: string, slug: string, origin: string): Promise<void> {
  const owner = await canonicalOriginPage(engine, sourceId, origin);
  if (!owner || !('ambiguous' in owner) && owner.slug === slug) return;
  throw opError('page_identity_changed', `Another live page of source ${sourceId} owns ${origin}, so ${slug} is not repaired from it.`,
    'ambiguous' in owner ? originConflictMessage(sourceId, origin, owner.ambiguous)
      : `Page ${owner.slug} is the canonical page of ${origin}; repair it with --slug ${owner.slug}, or preview gbrain repair origin-twins --source ${sourceId} to merge ${slug} into it.`,
    { detail: 'origin_conflict', fix: originTwinsFix(sourceId) });
}

/**
 * One drifted page resolved with `prefer` winning, as a ready reconcile preview: the preferred side's decisions over
 * reconcile's protections, the size check, and the exceptions. Throws `invalid_params` when a path still needs a
 * human decision. The caller runs it as the trusted local CLI and has checked the page is still drifted.
 */
export async function prepareDriftPage(engine: BrainEngine, sourceId: string, slug: string, prefer: DriftSide, assessmentAt: string,
  opts: { fileGone?: boolean } = {}): Promise<ArtifactPage> {
  const snapshotRow = await engine.readPageSnapshot(slug, { sourceId });
  if (snapshotRow?.page.source_path) await refuseForeignOrigin(engine, sourceId, slug, snapshotRow.page.source_path);
  const adopt = !opts.fileGone && !!snapshotRow && !snapshotRow.page.source_path && !snapshotRow.page.source_uri;
  const state = await readReconcileState(engine, sourceId, slug, assessmentAt, { adoptSlugPath: adopt, ...(opts.fileGone ? { fileGone: true } : {}) });
  if (opts.fileGone && state.pins.raw_file_hash !== ABSENT_FILE_HASH) throw opError('source_changed', 'The canonical file reappeared during the preview.',
    `Nothing was written. The canonical file of ${slug} in '${sourceId}' exists again; preview the page again.`);
  if (adopt && state.originSourcePath) await refuseForeignOrigin(engine, sourceId, slug, state.originSourcePath);
  const database = reconcileCanonical(state.snapshot.page, state.snapshot.tags);
  const file = reconcileCanonical(state.file, state.file.tags);
  const decisions = preferSideDecisions(state.file, database, prefer);
  const prepared = await prepareReconcileResult(engine, state, decisions);
  if (prepared.conflicts.length || !prepared.ready) throw opError('invalid_params', 'Some paths still need a decision.',
    `Preview ${slug} with gbrain sources reconcile ${sourceId} ${slug} --brain host --preview --out <file> and resolve it there.`);
  const preview: ReconcileArtifact = { format_version: 1, preview_id: randomUUID(), preconditions: state.pins,
    preimages: JSON.parse(stableJson({ file_base64: state.raw.toString('base64'), database: state.snapshot, stored_page: state.storedPage })),
    decisions, conflicts: [], result: prepared.result, result_digest: digest(prepared.result), status: 'ready' };
  await assertReconcileSize(engine, preview);
  return { slug, prefer, adopt_slug_path: adopt, exceptions: driftExceptions(prepared.result, prefer === 'file' ? file : database), result: prepared.result, preview,
    ...(opts.fileGone ? { file_gone: true as const } : {}) };
}

/**
 * #6712 wave: the resolution of a selected page whose canonical file is gone (`canonical_file_missing`), or the reason it
 * is skipped. Only a deletion gone from HEAD is file-drift's; one still committed at HEAD routes elsewhere.
 */
async function fileGonePage(engine: BrainEngine, sourceId: string, slug: string, opts: RepairPlanOptions & { prefer: DriftSide }, assessmentAt: string, target?: HeldTarget):
  Promise<{ page: PlannedPage; detail: string } | { skip: string; detail: string }> {
  const now = await ghostPageNow(engine, sourceId, slug);
  if (!now.ghost) return { skip: `unknown_${now.reason}`, detail: now.reason };
  if (!opts.allDrifted && !opts.held && !selectedByGlobs(now.ghost.path, opts)) return { skip: 'not_selected', detail: now.ghost.path };
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = join(binding!.local_path!, binding!.relative_path);
  const deletion = canonicalDeletionState(root, join(root, ...now.ghost.path.split('/')));
  if (deletion !== 'gone') return { skip: deletion === 'in_head' ? 'deletion_uncommitted' : 'unknown_deletion_state', detail: missingFileRoute(sourceId, slug, now.ghost.path, deletion) };
  if (opts.provenance === 'never_committed' && target?.provenance?.kind === 'never_committed') {
    return { page: { slug, prefer: 'database', exceptions: [], detach_page: { path: now.ghost.path, page_id: now.ghost.page_id, revision: now.ghost.revision, observed_at: target.hold.observed_at } },
      detail: `keeps the page database-only: no commit ever held ${now.ghost.path}, so the page holds the only copy; no file is written and the page forgets that path` };
  }
  if (opts.prefer === 'file' && !await ghostFileBacked(engine, now.ghost, now.owner)) return { skip: DATABASE_AHEAD_CODE, detail: databaseAheadDetail(now.ghost) };
  if (opts.prefer === 'file') return { page: { slug, prefer: 'file', exceptions: [], soft_delete: { ghost: now.ghost, owner: now.owner } },
    detail: `soft-deletes the page: its file ${now.ghost.path} is gone from the last commit (purged after ${GHOST_PURGE_FUSE_HOURS} h; gbrain restore ${slug} --force undoes it until then)` };
  const page = await prepareDriftPage(engine, sourceId, slug, 'database', assessmentAt, { fileGone: true });
  if (page.preview.preconditions.revision !== now.ghost.revision || page.preview.preconditions.relative_path.split(sep).join('/') !== now.ghost.path) {
    throw opError('source_changed', 'The page or its canonical path changed during the preview.', `Nothing was written. Preview ${slug} in '${sourceId}' again.`);
  }
  return { page, detail: `recreates its missing file ${now.ghost.path} from the page` };
}

/**
 * #6712 PR 4b: the resolution of a held file whose page is deleted (design v3.2 §4): a tombstone at its origin
 * (`tombstone_edited`) or a deletion marker with no page row left (`purged_differs`). `--prefer database` keeps the
 * deletion and removes the file through a coordinated publication; `--prefer file` imports the file's bytes through the
 * managed file repair, which restores the tombstone or creates a new page and leaves the marker for sync to retire.
 */
async function deletedPage(engine: BrainEngine, sourceId: string, target: HeldTarget & { state: 'tombstone_edited' | 'purged_differs' }, prefer: DriftSide):
  Promise<{ page: PlannedPage; detail: string } | { skip: string; detail: string }> {
  const { hold, state } = target;
  const live = await readDeletedDriftTarget(engine, sourceId, { path: hold.path, sourcePath: hold.source_path, pageId: hold.page_id });
  if ('changed' in live) return { skip: `resolved_${live.changed}`, detail: DELETED_CHANGES[live.changed] };
  if (live.state !== state) return { skip: 'state_changed', detail: `it is ${live.state} now; preview it with ${shellQuote(heldDriftPreviewArgv(sourceId, 'deleted', live.state, prefer, hold.path))}` };
  const slug = live.tombstone?.slug ?? hold.slug ?? resolveSlugForPath(hold.source_path);
  const pin: DeletedDriftPin = { state, path: hold.path, source_path: hold.source_path, raw_file_hash: live.raw_file_hash, page_id: live.tombstone?.page_id ?? null,
    revision: live.tombstone?.revision ?? null, marker_digest: live.marker_digest, observed_at: hold.observed_at };
  const detail = `${fileDriftActionVerb('deleted', state, prefer)}: ${hold.path}`;
  if (prefer === 'database') return { page: { slug, prefer, exceptions: [], remove_file: pin }, detail };
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if ((snapshot ? Number(snapshot.page.id) : null) !== pin.page_id) {
    return { skip: 'slug_taken', detail: `page ${slug} already exists for another file, so ${hold.path} cannot be imported under that slug; give the file a slug: line of its own, commit it and sync` };
  }
  const content = live.raw.toString('utf8');
  if (!Buffer.from(content).equals(live.raw)) throw opError('invalid_params', 'The held file must contain valid UTF-8.', `Nothing changed. Re-save ${hold.path} in '${sourceId}' as UTF-8, then preview it again.`);
  const publication = await prepareRepairPublication(engine, { sourceId, slug, sourcePath: hold.source_path, path: hold.path, root: live.root, content, snapshot, base: snapshot,
    ...await repairScreenConfig(engine, sourceId) });
  if (publication.status !== 'ready') throw opError('invalid_params', `${hold.path} does not import as written (${publication.status === 'refused' ? publication.refusal.code : 'it would store a canonical overlay'}).`,
    `Nothing changed. Fix the file, commit it and sync, or preview --prefer database to keep the deletion: ${shellQuote(heldDriftPreviewArgv(sourceId, 'deleted', state, 'database', hold.path))}`);
  return { page: { slug, prefer, exceptions: [], import_file: { ...pin, result_digest: publication.digest } }, detail };
}

/** #6712 PR 4b: the deleted-side pin as the preview hash and the publication read it again. */
async function assertDeletedPin(engine: BrainEngine, sourceId: string, pin: DeletedDriftPin): Promise<DeletedDriftTarget> {
  const live = await readDeletedDriftTarget(engine, sourceId, { path: pin.path, sourcePath: pin.source_path, pageId: pin.page_id });
  const why = 'changed' in live ? DELETED_CHANGES[live.changed] : live.state !== pin.state ? `it is ${live.state} now`
    : live.raw_file_hash !== pin.raw_file_hash ? 'the file bytes changed'
    : (live.tombstone?.page_id ?? null) !== pin.page_id || (live.tombstone?.revision ?? null) !== pin.revision ? 'the deleted page changed'
    : live.marker_digest !== pin.marker_digest ? 'its deletion marker changed' : null;
  if ('changed' in live || why !== null) throw opError('changed_since_preview', `${pin.path} changed since its file-drift resolution was previewed: ${why}.`,
    `Nothing was written for ${pin.path}. Preview again with ${shellQuote(heldDriftPreviewArgv(sourceId, 'deleted', pin.state, 'database', pin.path))} (or --prefer file) and apply its new hash.`,
    { fix: readFix('Lists the held files of this source with their side and state, read-only.', { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] }) });
  return live;
}

/**
 * #6712 PR 4b: the preparer of `managed_maintenance_file_drift_remove`, the coordinated removal of a held file whose page is
 * deleted. It re-reads the deleted side bound to the preview (file bytes, tombstone id and revision or marker value) here
 * and again under the publication guard, removes the file through the page file target (a recovery record, the Git
 * effect commits the removal) and clears the hold it resolves in the publishing transaction. The page row is untouched.
 */
export async function prepareDriftFileRemoval(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const pin = row.intent?.target as DeletedDriftPin | undefined;
  if (row.authority.remote || !pin || typeof pin.path !== 'string' || typeof pin.source_path !== 'string' || typeof pin.raw_file_hash !== 'string'
    || (pin.page_id ?? null) !== (row.page_id === null || row.page_id === undefined ? null : Number(row.page_id))) {
    throw opError('invalid_params', 'The file-drift removal intent does not name its held file.',
      `Request ${row.request_id} in source ${row.source_id} does not name the held file it removes, so nothing changed. Preview the repair again with gbrain repair file-drift --source ${row.source_id} --held --side deleted.`);
  }
  const live = await assertDeletedPin(engine, row.source_id, pin);
  return { observedRevision: pin.revision, file: { root: live.root, path: live.path, content: null, expectedBeforeHash: pin.raw_file_hash },
    validate: async tx => { await assertDeletedPin(tx, row.source_id, pin); },
    apply: async tx => ({ status: 'file_removed', slug: row.slug, source_id: row.source_id, path: pin.path, state: pin.state,
      hold_cleared: await clearGitHold(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, path: pin.path, observedAt: pin.observed_at }) }) };
}

/**
 * GBRA-133: the preparer of `managed_maintenance_file_drift_detach`. It re-checks, here and under the publication guard, that
 * the page is the previewed one (id, revision, recorded path), still live with its file missing, and that no commit of HEAD's
 * history holds the path. The apply clears the page's recorded file (`database_only_reason=detached`, so no sync reads the
 * missing file as a deletion again) and the hold it resolves in the publishing transaction; no file is written.
 */
export async function prepareDriftDetach(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const pin = row.intent?.target as DetachPin | undefined;
  if (row.authority.remote || !pin || typeof pin.path !== 'string' || typeof pin.revision !== 'string' || typeof pin.observed_at !== 'string'
    || pin.page_id !== (row.page_id === null || row.page_id === undefined ? null : Number(row.page_id))) {
    throw opError('invalid_params', 'The file-drift database-only intent does not name its page.',
      `Request ${row.request_id} in source ${row.source_id} does not name the held page it keeps, so nothing changed. Preview the repair again with gbrain repair file-drift --source ${row.source_id} --held --side deleted --state file_gone --provenance never_committed --prefer database.`);
  }
  const changed = (why: string) => opError('changed_since_preview', `${pin.path} changed since its database-only keep was previewed: ${why}.`,
    `Nothing was written for ${row.slug}. Preview again with gbrain repair file-drift --source ${row.source_id} --held --side deleted --state file_gone --provenance never_committed --prefer database and apply its new hash.`,
    { fix: readFix('Lists the held files of this source with their side and state, read-only.', { argv: ['gbrain', 'sources', 'status', row.source_id, '--json'] }) });
  const now = await ghostPageNow(engine, row.source_id, row.slug);
  if (!now.ghost) throw changed(`the page is no longer a live page whose file is missing (${now.reason})`);
  if (now.ghost.page_id !== pin.page_id || now.ghost.revision !== pin.revision || now.ghost.path !== pin.path) throw changed('the page, its revision or its recorded path changed');
  const binding = await getWorktreeBinding(engine, row.source_id);
  const found = (await readDeletionProvenance(join(binding!.local_path!, binding!.relative_path), [pin.path])).get(pin.path);
  if (found?.kind !== 'never_committed') throw changed(`its provenance is ${found?.kind ?? 'unknown'} now`);
  const locked = async (tx: BrainEngine) => {
    const [page] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id=$1 AND source_id=$2 AND slug=$3 AND deleted_at IS NULL AND source_path IS NOT NULL', [pin.page_id, row.source_id, row.slug]);
    if (!page) throw changed('the page was deleted, renamed or already forgot its file');
  };
  return { observedRevision: pin.revision, databaseOnlyReason: 'detached',
    validate: async tx => { await locked(tx); },
    apply: async tx => {
      await tx.executeRaw('UPDATE pages SET source_path=NULL, source_uri=NULL, database_only_reason=$2 WHERE id=$1', [pin.page_id, DETACHED_REASON]);
      return { status: 'detached', slug: row.slug, source_id: row.source_id, path: pin.path,
        hold_cleared: await clearGitHold(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, path: pin.path, observedAt: pin.observed_at }) };
    } };
}

/**
 * #6712 PR 4b: one held deleted-side page applied as previewed. `remove_file` admits the coordinated removal, bound to the
 * pin; `import_file` re-reads the pin and submits the managed file repair of the exact previewed bytes and result.
 */
async function applyDeletedSide(ctx: OperationContext, page: ApprovedPage, artifact: RemoveFilePage | ImportFilePage | DetachPage, requestId: string, embed: boolean): Promise<RepairItemOutcome> {
  const action = 'remove_file' in artifact ? 'remove_file' : 'import_file' in artifact ? 'import_file' : 'detach_page';
  try {
    if ('detach_page' in artifact) {
      const authority = await maintenancePreflight(ctx.engine, page.source_id);
      if (!authority) throw opError('owner_unavailable', 'Keeping a held page database-only needs the managed write path.',
        `Managed persistence is off for this brain, so ${artifact.detach_page.path} was not resolved. Held file-drift pages exist only on managed sources; check the source with gbrain sources status ${page.source_id} --json.`);
      // Database-only: no file is staged, so the missing file the page still records is not refused before admission.
      await submitDatabaseMaintenanceIntent(ctx.engine, authority, artifact.slug, { kind: FILE_DRIFT_DETACH_INTENT, expected_revision: artifact.detach_page.revision, target: artifact.detach_page }, requestId);
      return { applied: true, outcome: 'repaired', detail: { request_id: requestId, prefer: 'database', action } };
    }
    const pin = 'remove_file' in artifact ? artifact.remove_file : artifact.import_file;
    if ('remove_file' in artifact) {
      await assertDeletedPin(ctx.engine, page.source_id, pin);
      const authority = await maintenancePreflight(ctx.engine, page.source_id);
      if (!authority) throw opError('owner_unavailable', 'Removing a held file needs the managed write path.',
        `Managed persistence is off for this brain, so ${pin.path} was not removed. Held file-drift pages exist only on managed sources; check the source with gbrain sources status ${page.source_id} --json.`);
      await submitMaintenanceIntent(ctx.engine, authority, artifact.slug, { kind: FILE_DRIFT_REMOVE_INTENT, expected_revision: pin.revision,
        ...(pin.page_id !== null ? { deleted_page: true } : {}), target: pin }, requestId);
    } else {
      const live = await assertDeletedPin(ctx.engine, page.source_id, pin);
      await asLocalCli(ctx.engine, () => submitManagedFileRepair(ctx, { sourceId: page.source_id, requestId, slug: artifact.slug, path: pin.path, sourcePath: pin.source_path,
        content: live.raw.toString('utf8'), beforeHash: pin.raw_file_hash, resultDigest: artifact.import_file.result_digest, ...(pin.revision ? { expected_revision: pin.revision } : {}),
        noEmbed: !embed, holdObservedAt: pin.observed_at }));
    }
    return { applied: true, outcome: 'repaired', detail: { request_id: requestId, prefer: artifact.prefer, action, state: pin.state } };
  } catch (error) {
    if (acceptedPendingReceipt(error) || !(error instanceof OperationError) || ['owner_unavailable', 'writer_lock_unavailable', 'writer_busy', 'write_pending'].includes(error.code)) throw error;
    const changed = ['changed_since_preview', 'revision_conflict', 'page_identity_changed', 'page_not_found', 'source_changed'].includes(error.code);
    return { applied: false, outcome: changed ? 'changed_since_preview' : 'refused', reason: error.code, detail: { request_id: requestId, action, message: error.message } };
  }
}

/** GBRA-133: one held gone file's provenance, as the preview lists it. */
function provenanceText(found: DeletionProvenance): string {
  if (found.kind === 'deleted_by_commit') return `deleted by commit ${found.commit.slice(0, 12)} (${found.date}, ${found.author}: ${found.subject})`;
  return found.kind === 'never_committed' ? 'never committed: no commit held the file' : found.kind === 'deletion_uncommitted' ? 'deletion uncommitted: HEAD still holds the file'
    : 'provenance unknown: Git could not name the deleting commit';
}

function item(page: ApprovedPage, index: number, hash: string, last: boolean, prefer: DriftSide): DriftItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: page.source_id, slug: page.slug, chars: 0, action: `prefer_${prefer}`, page, hash, last };
}

export const fileDriftRepair: RepairHandler = {
  kind: 'file-drift',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === false && !opts.apply && !opts.prefer && !opts.slugs?.length && !opts.requests?.length && !opts.allDrifted && !opts.driftClass) return survey(engine, scope, opts);
    validateOptions(scope, opts);
    const sourceId = scope.source_ids[0]!;
    const command = previewCommand(sourceId, opts);
    const only = [...new Set(opts.only ?? [])].sort();
    const skip = [...new Set(opts.skip ?? [])].sort();
    const selection = digest({ prefer: opts.prefer, slugs: opts.slugs ?? [], requests: opts.requests ?? [], all: opts.allDrifted === true, class: opts.driftClass ?? null,
      ...(opts.since ? { since: opts.since } : {}), ...(only.length ? { only } : {}), ...(skip.length ? { skip } : {}),
      ...(opts.held ? { held: true, side: opts.side ?? null, state: opts.state ?? null } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) });
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair file-drift --apply applies only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints with --expect <preview-hash>.`, 'docs/guides/repair.md#explicit-only-repair-kinds');
      const approved = await loadApprovedSet<ApprovedPage>(engine, { command: 'file-drift', hash: opts.expect, previewCommand: command });
      if (approved.items.some(page => page.selection !== selection || page.source_id !== sourceId)) throw previewChangedError(opts.expect, command);
      // #6712 wave: soft deletes of pages whose file is gone honor the sync mass-delete valve, as `repair ghost-pages` does.
      if (opts.prefer === 'file' && approved.items.length > MASS_RECONCILE_MIN_PAGES * MASS_RECONCILE_RATIO) {
        const planned = readArtifact(opts.expect, command);
        const deletes = approved.items.filter(page => 'soft_delete' in (planned.get(page.slug) ?? {})).length;
        if (deletes > MASS_RECONCILE_MIN_PAGES * MASS_RECONCILE_RATIO) {
          const scan = await scanGhostSource(engine, sourceId, { candidateLimit: GHOST_REPAIR_LIMIT });
          const refusal = ghostScanRefusal(scan);
          if (refusal) throw refusal;
          if (massGhosts(deletes, scan.file_backed) && !massReconcileAllowed()) throw massRefusal(sourceId, deletes, scan.file_backed);
        }
      }
      const items = approved.items.map((page, index) => item(page, index, opts.expect!, index === approved.items.length - 1, opts.prefer));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const held = opts.held ? await selectHeld(engine, sourceId, opts) : null;
    const { slugs, classes, notSelected, unknown } = held
      ? { slugs: [], classes: new Map<string, DriftClass>(), notSelected: held.notSelected, unknown: [] as UnknownDrift[] } : await selectSlugs(engine, sourceId, opts);
    const assessmentAt = new Date().toISOString();
    const pages: PlannedPage[] = [];
    const listing: NonNullable<RepairPlan['listing']> = [];
    const residuals: Record<string, number> = { ...(notSelected ? { not_selected: notSelected } : {}), ...(held?.before ? { before_cursor: held.before } : {}),
      ...(held?.otherProvenance ? { other_provenance: held.otherProvenance } : {}) };
    const count = (key: string) => { residuals[key] = (residuals[key] ?? 0) + 1; };
    for (const hold of held?.legacy ?? []) {
      count('legacy_side');
      listing.push({ item: `${sourceId}:${hold.slug ?? hold.path}`, class: 'legacy_side',
        detail: `held before holds named a side; preview it alone with gbrain repair file-drift --source ${sourceId} --slug ${hold.slug ?? '<slug>'} --prefer ${opts.prefer}` });
    }
    for (const row of unknown) {
      count(`unknown_${row.reason}`);
      listing.push({ item: `${sourceId}:${row.slug}`, class: 'unknown', detail: unknownDriftDetail(sourceId, row) });
    }
    const targets: Array<{ slug: string | null; held?: HeldTarget }> = held ? held.targets.slice(0, HELD_WINDOW_PAGES).map(target => ({ slug: target.hold.slug, held: target })) : slugs.map(slug => ({ slug }));
    const windowEnd = Math.min(Date.now() + HELD_WINDOW_BUDGET_MS, opts.deadline ?? Infinity);
    let previewed = 0;
    opts.progress?.start('repair.file_drift.preview', targets.length);
    await asLocalCli(engine, async () => {
      for (const { slug: targetSlug, held: target } of targets) {
        if (held && previewed > 0 && Date.now() >= windowEnd) break;
        previewed++;
        opts.progress?.tick(1, targetSlug ?? target?.hold.path);
        const label = targetSlug ?? target?.hold.path ?? '';
        try {
          if (target?.state === 'tombstone_edited' || target?.state === 'purged_differs') {
            const resolved = await deletedPage(engine, sourceId, { ...target, state: target.state }, opts.prefer);
            if ('skip' in resolved) { count(resolved.skip); listing.push({ item: `${sourceId}:${label}`, class: resolved.skip, detail: resolved.detail }); continue; }
            await authorizeReconcile(engine, sourceId, resolved.page.slug);
            pages.push(resolved.page);
            listing.push({ item: `${sourceId}:${resolved.page.slug}`, class: `prefer_${opts.prefer}`, detail: resolved.detail });
            continue;
          }
          if (targetSlug === null) { count('no_page'); listing.push({ item: `${sourceId}:${label}`, class: 'no_page', detail: 'the hold names no page; the next sync re-classifies it' }); continue; }
          const slug = targetSlug;
          await authorizeReconcile(engine, sourceId, slug);
          const live = await liveFileDrift(engine, sourceId, slug);
          if (target && (target.state === 'file_gone') !== (live.reason === 'canonical_file_missing')) {
            count('side_changed');
            listing.push({ item: `${sourceId}:${slug}`, class: 'side_changed', detail: `its file is ${live.reason === 'canonical_file_missing' ? 'gone' : 'present'} now; gbrain sources status ${sourceId} --json shows its current Decision after the next sync` });
            continue;
          }
          if (live.reason === 'canonical_file_missing') {
            const gone = await fileGonePage(engine, sourceId, slug, opts, assessmentAt, target);
            if ('skip' in gone) {
              count(gone.skip);
              if (gone.skip !== 'not_selected') listing.push({ item: `${sourceId}:${slug}`, class: gone.skip.startsWith('unknown_') ? 'unknown' : gone.skip, detail: gone.detail });
              continue;
            }
            pages.push(gone.page);
            listing.push({ item: `${sourceId}:${slug}`, class: `prefer_${opts.prefer}`, detail: gone.detail });
            continue;
          }
          if (!opts.allDrifted && !opts.held && !selectedByGlobs(live.path, opts)) { count('not_selected'); continue; }
          if (live.still_present !== true) {
            count(live.still_present === false ? 'no_drift' : `unknown_${live.reason}`);
            listing.push({ item: `${sourceId}:${slug}`, class: live.still_present === false ? 'no_drift' : 'unknown', detail: live.reason });
            continue;
          }
          const page = await prepareDriftPage(engine, sourceId, slug, opts.prefer, assessmentAt);
          if (classes.has(slug)) page.class = classes.get(slug);
          pages.push(page);
          listing.push({ item: `${sourceId}:${slug}`, class: `prefer_${opts.prefer}`,
            detail: `${page.exceptions.length ? `kept: ${[...new Set(page.exceptions.map(e => e.reason))].join(', ')}` : 'exactly the preferred side'}${page.adopt_slug_path ? '; adopts the file at its slug path' : ''}` });
        } catch (error) {
          if (!(error instanceof OperationError) || ['owner_unavailable', 'writer_registration_required'].includes(error.code)) throw error;
          count(`refused_${error.code}`);
          listing.push({ item: `${sourceId}:${label}`, class: 'refused', detail: `${error.code}: ${error.message}` });
        }
      }
    });
    opts.progress?.finish();
    const remaining = held ? held.targets.length - previewed : 0;
    const nextCursor = remaining > 0 ? heldCursor(held!.targets[previewed - 1]!.hold.path) : undefined;
    const nextCommand = nextCursor ? previewCommand(sourceId, { ...opts, cursor: nextCursor }) : undefined;
    if (remaining > 0) residuals.after_window = remaining;
    const hash = previewHash({ kind: 'file-drift-v1', brain_id: scope.brain_id, source_id: sourceId, selection,
      pages: pages.map(page => 'soft_delete' in page ? [page.slug, page.soft_delete.ghost.revision, ABSENT_FILE_HASH, 'soft_delete']
        : 'detach_page' in page ? [page.slug, page.detach_page.revision, ABSENT_FILE_HASH, 'detach_page', page.detach_page.page_id, page.detach_page.observed_at]
        : 'remove_file' in page ? [page.slug, page.remove_file.revision, page.remove_file.raw_file_hash, 'remove_file', page.remove_file.state, page.remove_file.marker_digest]
        : 'import_file' in page ? [page.slug, page.import_file.revision, page.import_file.raw_file_hash, page.import_file.result_digest, page.import_file.state, page.import_file.marker_digest]
        : [page.slug, page.preview.preconditions.revision, page.preview.preconditions.raw_file_hash, page.preview.result_digest]) });
    // #6712 wave: a recreated file stays only once committed; without Git durability the next sync imports the committed deletion again.
    const recreated = pages.flatMap(page => 'preview' in page && page.file_gone ? [page.preview.preconditions.relative_path] : []);
    // #6712 PR 4b: a removed file is gone only once its deletion is committed; without Git durability the next sync finds the committed file held again.
    const removed = pages.flatMap(page => 'remove_file' in page ? [page.remove_file.path] : []);
    let warnings: string[] = nextCommand ? [`This preview covered ${previewed} of the ${held!.targets.length} selected held pages${opts.cursor ? ' after its cursor' : ''} (one window stops at ${HELD_WINDOW_PAGES} pages or ${HELD_WINDOW_BUDGET_MS / 1000} s); its hash and apply command cover only these. `
      + `After applying this window (or deciding not to), preview the next one: ${nextCommand}`] : [];
    let undoneBySync: { recreated: number; removed: number } | null = null;
    if (recreated.length || removed.length) {
      const binding = await getWorktreeBinding(engine, sourceId);
      const root = join(binding!.local_path!, binding!.relative_path);
      if (!(await gitDurabilityPolicy(binding, root).catch(() => ({ durable: false }))).durable) {
        if (removed.length) warnings.unshift(`The next sync undoes this repair unless the removals are committed: Git durability is off for ${sourceId}, so the apply leaves each removed file's deletion uncommitted (${removed.length} file(s)) and the next sync holds the committed file again. Commit them right after the apply: git -C ${root} add -- ${removed.join(' ')} && git -C ${root} commit`);
        if (recreated.length) warnings.unshift(`The next sync undoes this repair unless the recreated files are committed: Git durability is off for ${sourceId}, so the apply leaves each recreated file uncommitted (${recreated.length} file(s)) and the next sync imports their committed deletion again. Commit them right after the apply: git -C ${root} add -- ${recreated.join(' ')} && git -C ${root} commit`);
        undoneBySync = { recreated: recreated.length, removed: removed.length };
      }
    }
    const provenanceOf = new Map((held?.targets ?? []).flatMap(target => target.provenance && target.hold.slug ? [[target.hold.slug, target.provenance] as const] : []));
    for (const entry of listing) {
      const found = provenanceOf.get(entry.item.slice(sourceId.length + 1));
      if (found) entry.detail = `${entry.detail}; ${provenanceText(found)}`;
    }
    let artifact: string | undefined;
    if (pages.length) {
      await assertReconcileOutputPath(engine, sourceId, artifactDirectory());
      artifact = writeArtifact(hash, { format_version: 1, kind: 'file-drift', hash, source_id: sourceId, prefer: opts.prefer, pages });
      await saveApprovedSet<ApprovedPage>(engine, { command: 'file-drift', hash }, pages.map(page => ({ source_id: sourceId, slug: page.slug,
        artifact_digest: digest(page), selection })));
    }
    return { items: pages.map((page, index) => item({ source_id: sourceId, slug: page.slug, artifact_digest: digest(page), selection }, index, hash, index === pages.length - 1, opts.prefer)),
      preview_hash: hash, residuals, listing, ...(warnings.length ? { warnings } : {}),
      details: { prefer: opts.prefer, ...(artifact ? { artifact } : {}),
        ...(undoneBySync ? { undone_by_next_sync_unless_committed: undoneBySync } : {}),
        ...(held ? { window: { previewed, remaining, complete: remaining === 0, ...(nextCursor ? { next_cursor: nextCursor, next_command: nextCommand } : {}) } } : {}),
        ...(held?.provenance ? { provenance: held.provenance } : {}),
        pages: pages.map(page => ({ ...('soft_delete' in page ? { slug: page.slug, action: 'soft_delete', path: page.soft_delete.ghost.path, verb: fileDriftActionVerb('deleted', 'file_gone', 'file'), exceptions: page.exceptions }
          : 'detach_page' in page ? { slug: page.slug, action: 'detach_page', path: page.detach_page.path, verb: 'keep the page database-only (no file)', exceptions: page.exceptions }
          : 'remove_file' in page ? { slug: page.slug, action: 'remove_file', state: page.remove_file.state, path: page.remove_file.path, verb: fileDriftActionVerb('deleted', page.remove_file.state, 'database'), exceptions: page.exceptions }
          : 'import_file' in page ? { slug: page.slug, action: 'import_file', state: page.import_file.state, path: page.import_file.path, verb: fileDriftActionVerb('deleted', page.import_file.state, 'file'), exceptions: page.exceptions, result_digest: page.import_file.result_digest }
          : { slug: page.slug, ...(page.file_gone ? { action: 'recreate_file' } : {}), ...(page.class ? { class: page.class } : {}),
            verb: page.file_gone ? fileDriftActionVerb('deleted', 'file_gone', 'database') : fileDriftActionVerb('both', undefined, page.prefer),
            adopt_slug_path: page.adopt_slug_path, exceptions: page.exceptions, result_digest: page.preview.result_digest }),
          ...(provenanceOf.get(page.slug) ? { provenance: provenanceOf.get(page.slug) } : {}) })),
        protections: 'Protected metadata stays as the database holds it, tags are the union of both sides, and protected takes and private fact rows are kept; exceptions lists each page\'s.' } };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as DriftItem;
    const command = `gbrain repair file-drift --source ${page.source_id}`;
    const artifact = readArtifact(hash, command).get(page.slug);
    if (!artifact || digest(artifact) !== page.artifact_digest) throw previewChangedError(opts?.expect ?? hash, command);
    const requestId = requestIdFor(hash, page);
    let outcome: RepairItemOutcome;
    if ('remove_file' in artifact || 'import_file' in artifact || 'detach_page' in artifact) outcome = await applyDeletedSide(ctx, page, artifact, requestId, opts?.embed !== false);
    else if ('soft_delete' in artifact) {
      const retired = await retireGhost(ctx, artifact.soft_delete.ghost, artifact.soft_delete.owner, async () => requestId);
      outcome = retired.applied ? { applied: true, outcome: 'repaired', detail: { request_id: requestId, prefer: 'file', action: 'soft_delete' } }
        : { applied: false, outcome: 'changed_since_preview', reason: retired.outcome === 'file_restored' ? 'file_restored' : 'revision_conflict', detail: { request_id: requestId, message: retired.reason } };
    } else try {
      await asLocalCli(ctx.engine, () => runReconcileApply(ctx.engine, { source_id: page.source_id, slug: page.slug, preview: artifact.preview, request_id: requestId,
        ...(artifact.prefer === 'file' ? { keep_file_bytes: true } : {}) }));
      outcome = { applied: true, outcome: 'repaired', detail: { request_id: requestId, prefer: artifact.prefer } };
    } catch (error) {
      if (acceptedPendingReceipt(error) || !(error instanceof OperationError) || ['owner_unavailable', 'writer_lock_unavailable', 'writer_busy', 'write_pending'].includes(error.code)) throw error;
      const changed = error.code === 'revision_conflict' || error.code === 'page_identity_changed' || error.code === 'page_not_found'
        || error.code === 'source_changed' && error.message.startsWith('Reconciliation preview is stale');
      outcome = { applied: false, outcome: changed ? 'changed_since_preview' : 'refused', reason: error.code, detail: { request_id: requestId, message: error.message } };
    }
    if (last) {
      await clearApprovedSet(ctx.engine, { command: 'file-drift', hash });
      try { unlinkSync(join(artifactDirectory(), `${hash}.json`)); } catch { /* already gone */ }
    }
    return outcome;
  },
  render(details) {
    const lines: string[] = [];
    for (const page of (details.pages ?? []) as Array<{ slug: string; verb?: string; path?: string }>) if (page.verb) lines.push(`  ${page.slug}: ${page.verb}${page.path ? ` (${page.path})` : ''}`);
    for (const action of (details.next_actions ?? []) as string[]) lines.push(`  ${action}`);
    if (typeof details.artifact === 'string') lines.push(`  private artifact (each page's resolved result and exceptions): ${details.artifact}`);
    if (typeof details.protections === 'string') lines.push(`  ${details.protections}`);
    for (const page of (details.pages ?? []) as Array<{ slug: string; exceptions: DriftException[] }>) {
      for (const exception of page.exceptions) lines.push(`  kept ${page.slug} ${exception.path}: ${exception.reason}`);
    }
    return lines;
  },
};
