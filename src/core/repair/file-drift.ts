/**
 * `gbrain repair file-drift --source <id> (--slug <s>... | --request <id>... | --all-drifted [--class <c>]) --prefer file|database`
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
 * Trusted local CLI only.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { validateSlug } from '../utils.ts';
import type { ParsedPage } from '../import-file.ts';
import { digest, stableJson } from '../persistence/digest.ts';
import { currentVerifiedLocalWriter, readLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';
import { auditDriftConflicts, DRIFT_CLASSES, driftClass, liveFileDrift, type DriftClass } from '../persistence/drift-conflicts.ts';
import { protectedReconcileKey, reconcileCanonical, RECONCILE_SCAN_KEYS, type ReconcileDecision } from '../persistence/reconcile-merge.ts';
import { readReconcileState, type ReconcileArtifact } from '../persistence/reconcile-state.ts';
import { prepareReconcileResult } from '../persistence/reconcile-prepare.ts';
import { assertReconcileOutputPath, assertReconcileSize } from '../persistence/reconcile-backup.ts';
import { authorizeReconcile, runReconcileApply } from '../persistence/reconcile.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

export type DriftSide = 'file' | 'database';
/** Where a page's resolved result differs from the preferred side, and why. */
export interface DriftException { path: string; reason: 'protected_metadata' | 'scan_state' | 'tags_union' | 'protected_takes_or_private_facts' | 'canonical_import' }
interface ApprovedPage { source_id: string; slug: string; artifact_digest: string; selection: string }
interface DriftItem extends RepairItem { page: ApprovedPage; hash: string; last: boolean }
interface ArtifactPage { slug: string; prefer: DriftSide; class?: DriftClass; adopt_slug_path: boolean; exceptions: DriftException[]; result: ParsedPage; preview: ReconcileArtifact }

const ALL_DRIFTED_LIMIT = 1000;
const TOP_FIELDS = ['title', 'type', 'compiled_truth', 'timeline'] as const;
const artifactDirectory = () => join(canonicalFilesystemPath(configDir()), 'repair-previews', 'file-drift');
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function previewCommand(sourceId: string, opts: RepairPlanOptions): string {
  const select = opts.allDrifted ? ` --all-drifted${opts.driftClass ? ` --class ${opts.driftClass}` : ''}`
    : [...(opts.slugs ?? []).map(slug => ` --slug ${slug}`), ...(opts.requests ?? []).map(id => ` --request ${id}`)].join('');
  return `gbrain repair file-drift --source ${sourceId}${select} --prefer ${opts.prefer ?? '<file|database>'}`;
}

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

function readArtifact(hash: string, command: string): Map<string, ArtifactPage> {
  const path = join(artifactDirectory(), `${hash}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pages?: ArtifactPage[] };
    return new Map((parsed.pages ?? []).map(page => [page.slug, page]));
  } catch { throw previewChangedError(hash, command); }
}

/** The slugs the selection names: exact slugs, the slugs of named conflict receipts, or every page the audit finds still drifted. */
async function selectSlugs(engine: BrainEngine, sourceId: string, opts: RepairPlanOptions): Promise<{ slugs: string[]; classes: Map<string, DriftClass> }> {
  const classes = new Map<string, DriftClass>();
  if (opts.allDrifted) {
    const drifted: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await auditDriftConflicts(engine, sourceId, { trusted: true, excludePrivate: false }, { limit: 100, cursor });
      for (const row of page.conflicts) if (row.still_present.value === true) { drifted.push(row.slug); classes.set(row.slug, row.class ?? 'error'); }
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
    return { slugs: drifted.filter(slug => !opts.driftClass || classes.get(slug) === opts.driftClass), classes };
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
  return { slugs: [...slugs].sort(), classes };
}

function validateOptions(scope: RepairScope, opts: RepairPlanOptions | undefined): asserts opts is RepairPlanOptions & { prefer: DriftSide } {
  if (opts?.remote !== false) throw trustedCliRequired('gbrain repair file-drift runs only for the trusted local CLI on the brain host.');
  const usage = 'gbrain repair file-drift --source <id> (--slug <slug>... | --request <id>... | --all-drifted [--class <name>]) --prefer file|database';
  if (scope.source_ids.length !== 1) throw opError('invalid_params', 'gbrain repair file-drift needs exactly one --source.', `Name the source: ${usage}`);
  if (opts.prefer !== 'file' && opts.prefer !== 'database') throw opError('invalid_params', 'gbrain repair file-drift needs --prefer file or --prefer database.',
    `Choose the side whose content wins (protected metadata, tags union, protected takes and private facts are kept either way): ${usage}`);
  const modes = [opts.slugs?.length ? 1 : 0, opts.requests?.length ? 1 : 0, opts.allDrifted ? 1 : 0].reduce((a, b) => a + b, 0);
  if (modes !== 1) throw opError('invalid_params', 'Select pages one way: --slug, --request or --all-drifted.', `Pick one selection: ${usage}`);
  if (opts.driftClass && !opts.allDrifted) throw opError('invalid_params', '--class only narrows --all-drifted.', `Drop --class, or use it with --all-drifted: ${usage}`);
  if (opts.driftClass && !(DRIFT_CLASSES as readonly string[]).includes(opts.driftClass)) throw opError('invalid_params', `Unknown drift class '${opts.driftClass}'.`,
    `Pass one of ${DRIFT_CLASSES.join(', ')}; the conflict audit lists each drifted page's class.`);
  for (const slug of opts.slugs ?? []) {
    try { validateSlug(slug); } catch { throw opError('invalid_params', `Invalid page slug '${slug}'.`, 'Pass each page by its exact stored slug.'); }
  }
  if (opts.requests?.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw opError('invalid_params', '--request takes a conflict receipt request UUID.', 'Pass the request id the conflict audit lists (last_conflict_request_id).');
  }
}

/**
 * The bare `gbrain repair file-drift` (the explicit-only preview command doctor and `repair --all` print): a read-only
 * survey of the drifted pages per source with their drift class and the preview command for each class. Nothing to apply.
 */
async function survey(engine: BrainEngine, scope: RepairScope): Promise<RepairPlan> {
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
        if (row.still_present.value !== true) continue;
        const kind = row.class ?? 'error';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        residuals[`drifted_${kind}`] = (residuals[`drifted_${kind}`] ?? 0) + 1;
        listing.push({ item: `${sourceId}:${row.slug}`, class: kind, detail: `${row.drift_receipts} conflict receipt(s)` });
      }
      seen += page.conflicts.length;
      cursor = page.next ?? undefined;
    } while (cursor && seen < ALL_DRIFTED_LIMIT);
    for (const kind of counts.keys()) next.push(previewCommand(sourceId, { apply: false, allDrifted: true, driftClass: kind, prefer: 'file' }));
  }
  return { items: [], residuals, listing, details: { survey: true,
    next_actions: next.length ? [...next.map(command => `Preview: ${command} (or --prefer database)`), 'Or preview single pages with --slug <slug>.'] : [] } };
}

function item(page: ApprovedPage, index: number, hash: string, last: boolean, prefer: DriftSide): DriftItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: page.source_id, slug: page.slug, chars: 0, action: `prefer_${prefer}`, page, hash, last };
}

export const fileDriftRepair: RepairHandler = {
  kind: 'file-drift',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === false && !opts.apply && !opts.prefer && !opts.slugs?.length && !opts.requests?.length && !opts.allDrifted && !opts.driftClass) return survey(engine, scope);
    validateOptions(scope, opts);
    const sourceId = scope.source_ids[0]!;
    const command = previewCommand(sourceId, opts);
    const selection = digest({ prefer: opts.prefer, slugs: opts.slugs ?? [], requests: opts.requests ?? [], all: opts.allDrifted === true, class: opts.driftClass ?? null });
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair file-drift --apply applies only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints with --expect <preview-hash>.`, 'docs/guides/repair.md#explicit-only-repair-kinds');
      const approved = await loadApprovedSet<ApprovedPage>(engine, { command: 'file-drift', hash: opts.expect, previewCommand: command });
      if (approved.items.some(page => page.selection !== selection || page.source_id !== sourceId)) throw previewChangedError(opts.expect, command);
      const items = approved.items.map((page, index) => item(page, index, opts.expect!, index === approved.items.length - 1, opts.prefer));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const { slugs, classes } = await selectSlugs(engine, sourceId, opts);
    const assessmentAt = new Date().toISOString();
    const pages: ArtifactPage[] = [];
    const listing: NonNullable<RepairPlan['listing']> = [];
    const residuals: Record<string, number> = {};
    const count = (key: string) => { residuals[key] = (residuals[key] ?? 0) + 1; };
    await asLocalCli(engine, async () => {
      for (const slug of slugs) {
        try {
          await authorizeReconcile(engine, sourceId, slug);
          const live = await liveFileDrift(engine, sourceId, slug);
          if (live.still_present !== true) {
            count(live.still_present === false ? 'no_drift' : `unknown_${live.reason}`);
            listing.push({ item: `${sourceId}:${slug}`, class: live.still_present === false ? 'no_drift' : 'unknown', detail: live.reason });
            continue;
          }
          const snapshotRow = await engine.readPageSnapshot(slug, { sourceId });
          const adopt = !!snapshotRow && !snapshotRow.page.source_path && !snapshotRow.page.source_uri;
          const state = await readReconcileState(engine, sourceId, slug, assessmentAt, { adoptSlugPath: adopt });
          const database = reconcileCanonical(state.snapshot.page, state.snapshot.tags);
          const file = reconcileCanonical(state.file, state.file.tags);
          const decisions = preferSideDecisions(state.file, database, opts.prefer);
          const prepared = await prepareReconcileResult(engine, state, decisions);
          if (prepared.conflicts.length || !prepared.ready) throw opError('invalid_params', 'Some paths still need a decision.',
            `Preview ${slug} with gbrain sources reconcile ${sourceId} ${slug} --brain host --preview --out <file> and resolve it there.`);
          const preview: ReconcileArtifact = { format_version: 1, preview_id: randomUUID(), preconditions: state.pins,
            preimages: JSON.parse(stableJson({ file_base64: state.raw.toString('base64'), database: state.snapshot, stored_page: state.storedPage })),
            decisions, conflicts: [], result: prepared.result, result_digest: digest(prepared.result), status: 'ready' };
          await assertReconcileSize(engine, preview);
          const exceptions = driftExceptions(prepared.result, opts.prefer === 'file' ? file : database);
          pages.push({ slug, prefer: opts.prefer, ...(classes.has(slug) ? { class: classes.get(slug) } : {}), adopt_slug_path: adopt, exceptions, result: prepared.result, preview });
          listing.push({ item: `${sourceId}:${slug}`, class: `prefer_${opts.prefer}`,
            detail: `${exceptions.length ? `kept: ${[...new Set(exceptions.map(e => e.reason))].join(', ')}` : 'exactly the preferred side'}${adopt ? '; adopts the file at its slug path' : ''}` });
        } catch (error) {
          if (!(error instanceof OperationError) || ['owner_unavailable', 'writer_registration_required'].includes(error.code)) throw error;
          count(`refused_${error.code}`);
          listing.push({ item: `${sourceId}:${slug}`, class: 'refused', detail: `${error.code}: ${error.message}` });
        }
      }
    });
    const hash = previewHash({ kind: 'file-drift-v1', brain_id: scope.brain_id, source_id: sourceId, selection,
      pages: pages.map(page => [page.slug, page.preview.preconditions.revision, page.preview.preconditions.raw_file_hash, page.preview.result_digest]) });
    let artifact: string | undefined;
    if (pages.length) {
      await assertReconcileOutputPath(engine, sourceId, artifactDirectory());
      artifact = writeArtifact(hash, { format_version: 1, kind: 'file-drift', hash, source_id: sourceId, prefer: opts.prefer, pages });
      await saveApprovedSet<ApprovedPage>(engine, { command: 'file-drift', hash }, pages.map(page => ({ source_id: sourceId, slug: page.slug,
        artifact_digest: digest(page), selection })));
    }
    return { items: pages.map((page, index) => item({ source_id: sourceId, slug: page.slug, artifact_digest: digest(page), selection }, index, hash, index === pages.length - 1, opts.prefer)),
      preview_hash: hash, residuals, listing,
      details: { prefer: opts.prefer, ...(artifact ? { artifact } : {}),
        pages: pages.map(page => ({ slug: page.slug, ...(page.class ? { class: page.class } : {}), adopt_slug_path: page.adopt_slug_path, exceptions: page.exceptions, result_digest: page.preview.result_digest })),
        protections: 'Protected metadata stays as the database holds it, tags are the union of both sides, and protected takes and private fact rows are kept; exceptions lists each page\'s.' } };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as DriftItem;
    const command = `gbrain repair file-drift --source ${page.source_id}`;
    const artifact = readArtifact(hash, command).get(page.slug);
    if (!artifact || digest(artifact) !== page.artifact_digest) throw previewChangedError(opts?.expect ?? hash, command);
    const requestId = requestIdFor(hash, page);
    let outcome: RepairItemOutcome;
    try {
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
