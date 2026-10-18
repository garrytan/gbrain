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
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
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
import { ABSENT_FILE_HASH, canonicalDeletionState, missingFileRoute, readReconcileState, type ReconcileArtifact } from '../persistence/reconcile-state.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { gitDurabilityPolicy } from '../persistence/git-durability-policy.ts';
import { ghostPageNow, scanGhostSource, type GhostOwner, type GhostPage } from '../ghost-pages.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { GHOST_PURGE_FUSE_HOURS, GHOST_REPAIR_LIMIT, ghostScanRefusal, massGhosts, massRefusal, retireGhost } from './ghost-pages.ts';
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
type PlannedPage = ArtifactPage | SoftDeletePage;

const ALL_DRIFTED_LIMIT = 1000;
const TOP_FIELDS = ['title', 'type', 'compiled_truth', 'timeline'] as const;
const artifactDirectory = () => join(canonicalFilesystemPath(configDir()), 'repair-previews', 'file-drift');
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function previewCommand(sourceId: string, opts: RepairPlanOptions): string {
  const select = opts.allDrifted ? ` --all-drifted${opts.driftClass ? ` --class ${opts.driftClass}` : ''}${opts.since ? ` --since ${opts.since}` : ''}`
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

function readArtifact(hash: string, command: string): Map<string, PlannedPage> {
  const path = join(artifactDirectory(), `${hash}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pages?: PlannedPage[] };
    return new Map((parsed.pages ?? []).map(page => [page.slug, page]));
  } catch { throw previewChangedError(hash, command); }
}

/**
 * The slugs the selection names: exact slugs, the slugs of named conflict receipts, or every page the audit finds
 * still drifted. `--all-drifted` is narrowed here by the `--only` / `--skip` globs over each page's canonical file
 * path (`not_selected` counts the pages they leave out), before the class check and the bound; an exact selection
 * is narrowed by the plan from the same live check.
 */
async function selectSlugs(engine: BrainEngine, sourceId: string, opts: RepairPlanOptions): Promise<{ slugs: string[]; classes: Map<string, DriftClass>; notSelected: number }> {
  const classes = new Map<string, DriftClass>();
  if (opts.allDrifted) {
    const drifted: string[] = [];
    let notSelected = 0;
    let cursor: string | undefined;
    do {
      const page = await auditDriftConflicts(engine, sourceId, { trusted: true, excludePrivate: false }, { limit: 100, cursor });
      for (const row of page.conflicts) {
        if (row.still_present.value !== true) continue;
        if (!selectedByGlobs(row.path, opts) || !sinceSelects(row.last_seen, opts.since)) { notSelected++; continue; }
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
    return { slugs: drifted.filter(slug => !opts.driftClass || classes.get(slug) === opts.driftClass), classes, notSelected };
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
  return { slugs: [...slugs].sort(), classes, notSelected: 0 };
}

function validateOptions(scope: RepairScope, opts: RepairPlanOptions | undefined): asserts opts is RepairPlanOptions & { prefer: DriftSide } {
  if (opts?.remote !== false) throw trustedCliRequired('gbrain repair file-drift runs only for the trusted local CLI on the brain host.');
  const usage = 'gbrain repair file-drift --source <id> (--slug <slug>... | --request <id>... | --all-drifted [--class <name>] [--since <ISO-8601|7d>]) [--only <glob>]... [--skip <glob>]... --prefer file|database';
  if (scope.source_ids.length !== 1) throw opError('invalid_params', 'gbrain repair file-drift needs exactly one --source.', `Name the source: ${usage}`);
  if (opts.prefer !== 'file' && opts.prefer !== 'database') throw opError('invalid_params', 'gbrain repair file-drift needs --prefer file or --prefer database.',
    `Choose the side whose content wins (protected metadata, tags union, protected takes and private facts are kept either way): ${usage}`);
  const modes = [opts.slugs?.length ? 1 : 0, opts.requests?.length ? 1 : 0, opts.allDrifted ? 1 : 0].reduce((a, b) => a + b, 0);
  if (modes !== 1) throw opError('invalid_params', 'Select pages one way: --slug, --request or --all-drifted.', `Pick one selection: ${usage}`);
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
        if (row.still_present.value !== true || !sinceSelects(row.last_seen, opts.since)) continue;
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
async function fileGonePage(engine: BrainEngine, sourceId: string, slug: string, opts: RepairPlanOptions & { prefer: DriftSide }, assessmentAt: string):
  Promise<{ page: PlannedPage; detail: string } | { skip: string; detail: string }> {
  const now = await ghostPageNow(engine, sourceId, slug);
  if (!now.ghost) return { skip: `unknown_${now.reason}`, detail: now.reason };
  if (!opts.allDrifted && !selectedByGlobs(now.ghost.path, opts)) return { skip: 'not_selected', detail: now.ghost.path };
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = join(binding!.local_path!, binding!.relative_path);
  const deletion = canonicalDeletionState(root, join(root, ...now.ghost.path.split('/')));
  if (deletion !== 'gone') return { skip: deletion === 'in_head' ? 'deletion_uncommitted' : 'unknown_deletion_state', detail: missingFileRoute(sourceId, slug, now.ghost.path, deletion) };
  if (opts.prefer === 'file') return { page: { slug, prefer: 'file', exceptions: [], soft_delete: { ghost: now.ghost, owner: now.owner } },
    detail: `soft-deletes the page: its file ${now.ghost.path} is gone from the last commit (purged after ${GHOST_PURGE_FUSE_HOURS} h; gbrain restore ${slug} --force undoes it until then)` };
  const page = await prepareDriftPage(engine, sourceId, slug, 'database', assessmentAt, { fileGone: true });
  if (page.preview.preconditions.revision !== now.ghost.revision || page.preview.preconditions.relative_path.split(sep).join('/') !== now.ghost.path) {
    throw opError('source_changed', 'The page or its canonical path changed during the preview.', `Nothing was written. Preview ${slug} in '${sourceId}' again.`);
  }
  return { page, detail: `recreates its missing file ${now.ghost.path} from the page` };
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
      ...(opts.since ? { since: opts.since } : {}), ...(only.length ? { only } : {}), ...(skip.length ? { skip } : {}) });
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
    const { slugs, classes, notSelected } = await selectSlugs(engine, sourceId, opts);
    const assessmentAt = new Date().toISOString();
    const pages: PlannedPage[] = [];
    const listing: NonNullable<RepairPlan['listing']> = [];
    const residuals: Record<string, number> = notSelected ? { not_selected: notSelected } : {};
    const count = (key: string) => { residuals[key] = (residuals[key] ?? 0) + 1; };
    await asLocalCli(engine, async () => {
      for (const slug of slugs) {
        try {
          await authorizeReconcile(engine, sourceId, slug);
          const live = await liveFileDrift(engine, sourceId, slug);
          if (live.reason === 'canonical_file_missing') {
            const gone = await fileGonePage(engine, sourceId, slug, opts, assessmentAt);
            if ('skip' in gone) {
              count(gone.skip);
              if (gone.skip !== 'not_selected') listing.push({ item: `${sourceId}:${slug}`, class: gone.skip.startsWith('unknown_') ? 'unknown' : gone.skip, detail: gone.detail });
              continue;
            }
            pages.push(gone.page);
            listing.push({ item: `${sourceId}:${slug}`, class: `prefer_${opts.prefer}`, detail: gone.detail });
            continue;
          }
          if (!opts.allDrifted && !selectedByGlobs(live.path, opts)) { count('not_selected'); continue; }
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
          listing.push({ item: `${sourceId}:${slug}`, class: 'refused', detail: `${error.code}: ${error.message}` });
        }
      }
    });
    const hash = previewHash({ kind: 'file-drift-v1', brain_id: scope.brain_id, source_id: sourceId, selection,
      pages: pages.map(page => 'soft_delete' in page ? [page.slug, page.soft_delete.ghost.revision, ABSENT_FILE_HASH, 'soft_delete']
        : [page.slug, page.preview.preconditions.revision, page.preview.preconditions.raw_file_hash, page.preview.result_digest]) });
    // #6712 wave: a recreated file stays only once committed; without Git durability the next sync imports the committed deletion again.
    const recreated = pages.flatMap(page => 'preview' in page && page.file_gone ? [page.preview.preconditions.relative_path] : []);
    let warnings: string[] = [];
    if (recreated.length) {
      const binding = await getWorktreeBinding(engine, sourceId);
      const root = join(binding!.local_path!, binding!.relative_path);
      if (!(await gitDurabilityPolicy(binding, root).catch(() => ({ durable: false }))).durable) {
        warnings = [`Git durability is off for ${sourceId}, so the apply leaves each recreated file uncommitted. Commit it afterwards (git -C ${root} add -- ${recreated.join(' ')} && git -C ${root} commit), or the next sync imports the committed deletion again.`];
      }
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
        pages: pages.map(page => 'soft_delete' in page ? { slug: page.slug, action: 'soft_delete', path: page.soft_delete.ghost.path, exceptions: page.exceptions }
          : { slug: page.slug, ...(page.file_gone ? { action: 'recreate_file' } : {}), ...(page.class ? { class: page.class } : {}), adopt_slug_path: page.adopt_slug_path, exceptions: page.exceptions, result_digest: page.preview.result_digest }),
        protections: 'Protected metadata stays as the database holds it, tags are the union of both sides, and protected takes and private fact rows are kept; exceptions lists each page\'s.' } };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as DriftItem;
    const command = `gbrain repair file-drift --source ${page.source_id}`;
    const artifact = readArtifact(hash, command).get(page.slug);
    if (!artifact || digest(artifact) !== page.artifact_digest) throw previewChangedError(opts?.expect ?? hash, command);
    const requestId = requestIdFor(hash, page);
    let outcome: RepairItemOutcome;
    if ('soft_delete' in artifact) {
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
    for (const action of (details.next_actions ?? []) as string[]) lines.push(`  ${action}`);
    if (typeof details.artifact === 'string') lines.push(`  private artifact (each page's resolved result and exceptions): ${details.artifact}`);
    if (typeof details.protections === 'string') lines.push(`  ${details.protections}`);
    for (const page of (details.pages ?? []) as Array<{ slug: string; exceptions: DriftException[] }>) {
      for (const exception of page.exceptions) lines.push(`  kept ${page.slug} ${exception.path}: ${exception.reason}`);
    }
    return lines;
  },
};
