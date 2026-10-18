/**
 * `gbrain repair overwritten-edits [--source <id>] [--slug <slug>...]` (#6712 follow-up): restore database edits an
 * incremental managed sync published a committed file edit over, with no `file_drift` hold (the bug #6887 fixes, or any
 * other unguarded import). Detection is `persistence/overwritten-edits.ts`; only its `high` findings are restorable,
 * and `unknown` ones are listed with their reason.
 *
 * Explicit-only and preview-bound: the preview lists each page with the database edit's version, the request that wrote
 * it, the import that replaced it and a diff of the live page against the restored edit, and saves the set under its
 * hash. `--apply --expect <hash>` restores exactly that set: each page goes through `revert_version` of the archived
 * version (the normal coordinated write), bound to the page revision the preview saw (`expected_revision`), so a page
 * that moved since is `changed_since_preview`. The restore publishes to the database only (`databaseOnly:
 * 'overwrite_restore'`), so it never rewrites the committed file. When the committed file then differs from the restored
 * page, the file is held `file_drift` (sync never publishes it over the restored edit; `gbrain repair file-drift` is how a
 * person picks the winner).
 */
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { resolveSourceLocalFilePath, serializePageToMarkdown } from '../markdown.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { localHostId } from '../persistence/identity.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { fileMatchesSnapshot } from '../persistence/page-prepare.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { overwriteContent, overwriteDigest, scanOverwrittenEdits, type OverwrittenEdit } from '../persistence/overwritten-edits.ts';
import { readTreeBlobs, readBlobContents } from '../persistence/sync-blobs.ts';
import { syncGit, syncGitPath } from '../persistence/sync-discovery.ts';
import { readSyncImportProvenances, writeGitHold } from '../persistence/sync-holds.ts';
import { fileDriftHold } from '../persistence/sync-page-fault.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#overwritten-edits';
const COMMAND = 'gbrain repair overwritten-edits';
/** Diff lines kept per page in the preview details. */
const DIFF_LINES = 200;

type ApprovedEdit = Pick<OverwrittenEdit, 'source_id' | 'slug' | 'page_id' | 'version_id' | 'page_revision' | 'lost_digest' | 'db_request_id' | 'import_request_id'> & { selection: string[] };
interface EditItem extends RepairItem { edit: ApprovedEdit; hash: string; last: boolean }
interface PreviewEdit { source_id: string; slug: string; version_id: number; db_request_id: string; db_operation: string; import_request_id: string;
  imported_at: string | null; earlier: number; added: number; removed: number; diff: string }

const previewCommand = (scope: RepairScope, slugs: readonly string[]) =>
  [COMMAND, ...(scope.source_ids.length === 1 ? ['--source', scope.source_ids[0]!] : []), ...slugs.flatMap(slug => ['--slug', slug])].join(' ');
const selectionOf = (scope: RepairScope, slugs: readonly string[]) => [...scope.source_ids, '--', ...[...new Set(slugs)].sort()];
const hashOf = (scope: RepairScope, selection: string[], edits: Array<Pick<OverwrittenEdit, 'source_id' | 'slug' | 'version_id' | 'page_revision' | 'lost_digest'>>) =>
  previewHash({ kind: 'overwritten-edits-v1', brain_id: scope.brain_id, selection, edits: edits.map(edit => [edit.source_id, edit.slug, edit.version_id, edit.page_revision, edit.lost_digest]) });

async function scanScope(engine: BrainEngine, scope: RepairScope, slugs: readonly string[]) {
  const scans = [];
  for (const sourceId of scope.source_ids) scans.push(await scanOverwrittenEdits(engine, sourceId, { slugs }));
  return scans;
}

/** The archived version's content rendered as `revert_version` renders it, or null when it is no longer the previewed edit. */
async function versionMarkdown(engine: BrainEngine, edit: Pick<OverwrittenEdit, 'page_id' | 'version_id' | 'lost_digest'>, page: Parameters<typeof serializePageToMarkdown>[0]): Promise<string | null> {
  const [row] = await engine.executeRaw<{ body_storage: string | null; title: string | null; type: string | null; compiled_truth: string | null; timeline: string | null; frontmatter: Record<string, unknown> | null; tags: unknown }>(
    'SELECT body_storage, title, type, compiled_truth, timeline, frontmatter, tags FROM page_versions WHERE id=$1 AND page_id=$2', [edit.version_id, edit.page_id]);
  const content = row ? overwriteContent(row) : null;
  if (!content || overwriteDigest(content) !== edit.lost_digest) return null;
  return serializePageToMarkdown({ ...page, title: content.title, type: content.type, compiled_truth: content.compiled_truth, timeline: content.timeline, frontmatter: content.frontmatter }, content.tags);
}

async function previewEdit(engine: BrainEngine, edit: OverwrittenEdit): Promise<PreviewEdit | null> {
  const snapshot = await engine.readPageSnapshot(edit.slug, { sourceId: edit.source_id });
  if (!snapshot || snapshot.revision !== edit.page_revision) return null;
  const restored = await versionMarkdown(engine, edit, snapshot.page);
  if (restored === null) return null;
  const diff = unifiedDiff(serializePageToMarkdown(snapshot.page, snapshot.tags), restored, { oldPath: `${edit.slug} (live page, from the sync import)`, newPath: `${edit.slug} (database edit, version ${edit.version_id})` });
  const lines = diff.split('\n');
  return { source_id: edit.source_id, slug: edit.slug, version_id: edit.version_id, db_request_id: edit.db_request_id, db_operation: edit.db_operation,
    import_request_id: edit.import_request_id, imported_at: edit.imported_at, earlier: edit.earlier,
    added: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length, removed: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length,
    diff: lines.length > DIFF_LINES ? [...lines.slice(0, DIFF_LINES), `... ${lines.length - DIFF_LINES} more diff line(s)`].join('\n') : diff };
}

const item = (edit: ApprovedEdit, index: number, hash: string, last: boolean): EditItem => ({ cursor: { phase: 0, id: index + 1 }, source_id: edit.source_id,
  slug: edit.slug, chars: 0, action: `restore_version:${edit.version_id}`, edit, hash, last });

export const overwrittenEditsRepair: RepairHandler = {
  kind: 'overwritten-edits',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts) {
    const slugs = opts?.slugs ?? [];
    const command = previewCommand(scope, slugs);
    const selection = selectionOf(scope, slugs);
    if (!opts?.apply) {
      const scans = await scanScope(engine, scope, slugs);
      const previews: PreviewEdit[] = [], approved: ApprovedEdit[] = [], unknown: OverwrittenEdit[] = [];
      const residuals: Record<string, number> = {};
      for (const edit of scans.flatMap(scan => scan.edits)) {
        if (edit.confidence !== 'high') { unknown.push(edit); residuals[`unknown_${edit.reason}`] = (residuals[`unknown_${edit.reason}`] ?? 0) + 1; continue; }
        const preview = await previewEdit(engine, edit);
        if (!preview) { residuals.changed_during_preview = (residuals.changed_during_preview ?? 0) + 1; continue; }
        previews.push(preview);
        approved.push({ source_id: edit.source_id, slug: edit.slug, page_id: edit.page_id, version_id: edit.version_id, page_revision: edit.page_revision,
          lost_digest: edit.lost_digest, db_request_id: edit.db_request_id, import_request_id: edit.import_request_id, selection });
      }
      for (const scan of scans) if (scan.truncated) residuals.scan_truncated = (residuals.scan_truncated ?? 0) + 1;
      const hash = hashOf(scope, selection, approved);
      if (approved.length) await saveApprovedSet<ApprovedEdit>(engine, { command: 'overwritten-edits', hash }, approved);
      return { items: approved.map((edit, index) => item(edit, index, hash, index === approved.length - 1)), preview_hash: hash, residuals,
        listing: [...previews.map(edit => ({ item: `${edit.source_id}:${edit.slug}`, class: 'restore_database_edit',
          detail: `version ${edit.version_id} (${edit.db_operation} request ${edit.db_request_id}) was replaced by sync import ${edit.import_request_id}${edit.imported_at ? ` at ${edit.imported_at}` : ''}; restoring it changes +${edit.added}/-${edit.removed} line(s)${edit.earlier ? `; ${edit.earlier} earlier overwrite(s) of this page are not restored` : ''}` })),
        ...unknown.map(edit => ({ item: `${edit.source_id}:${edit.slug}`, class: 'unknown', detail: `${edit.reason}: version ${edit.version_id}, replaced by sync import ${edit.import_request_id}; not restored automatically` }))],
        ...(approved.length ? { warnings: ['Each restore writes the database edit as a new page revision without touching the committed file. Only the host that owns the source\'s checkout compares the file and holds it file_drift when it differs; pick a side later with gbrain repair file-drift. On any other host the restore still applies but the file is left unheld (outcome restored_file_unheld), so a later sync that imports a change to that file can publish it over the edit again; run the apply on the owner host, or afterwards run gbrain repair file-drift --source <id> --slug <slug> --prefer database there. No command writes only the hold.'] } : {}),
        details: { docs: DOCS, edits: previews, unknown: unknown.map(edit => ({ source_id: edit.source_id, slug: edit.slug, version_id: edit.version_id, reason: edit.reason })) } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', `${COMMAND} --apply restores only the set a preview printed.`,
        `Preview first: ${command} — show the user both versions, then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        { fix: readFix('Previews the database edits a sync import overwrote; writes nothing.', { argv: command.split(' ').concat('--json') }), docs: DOCS });
    }
    const loaded = await loadApprovedSet<ApprovedEdit>(engine, { command: 'overwritten-edits', hash: opts.expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, selection, (await scanScope(engine, scope, slugs)).flatMap(scan => scan.edits).filter(edit => edit.confidence === 'high')) });
    if (loaded.items.some(edit => JSON.stringify(edit.selection) !== JSON.stringify(selection))) {
      throw previewChangedError(opts.expect, command);
    }
    const items = loaded.items.map((edit, index) => item(edit, index, opts.expect!, index === loaded.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { edit, hash, last } = entry as EditItem;
    try {
      return await restoreEdit(ctx, entry, edit);
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'overwritten-edits', hash });
    }
  },
  render(details) {
    const lines: string[] = [];
    for (const edit of (details.edits ?? []) as PreviewEdit[]) lines.push(`  ${edit.source_id}:${edit.slug}: live page (-) against the database edit it restores (+):`, ...edit.diff.split('\n').map(line => `    ${line}`));
    for (const edit of (details.unknown ?? []) as Array<{ source_id: string; slug: string; version_id: number; reason: string }>) {
      lines.push(`  unknown ${edit.source_id}:${edit.slug} (version ${edit.version_id}): ${edit.reason}; compare it with gbrain history ${edit.slug} --source-id ${edit.source_id} before restoring it by hand`);
    }
    lines.push(`  guide: ${details.docs}`);
    return lines;
  },
};

const ownerHostCommand = (edit: Pick<ApprovedEdit, 'source_id' | 'slug'>) => `gbrain repair file-drift --source ${edit.source_id} --slug ${edit.slug} --prefer database`;

const changed = (reason: string, detail: Record<string, unknown> = {}): RepairItemOutcome =>
  ({ applied: false, outcome: 'changed_since_preview', reason, detail: { ...detail, next: `run ${COMMAND} again for a new preview` } });

async function restoreEdit(ctx: OperationContext, entry: RepairItem, edit: ApprovedEdit): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const requestId = await repairRequestId(ctx, 'overwritten-edits', entry, edit.page_revision);
  const replayed = (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE request_id=$1::uuid AND operation='revert_version' AND state='committed'", [requestId])).length > 0;
  if (!replayed) {
    const snapshot = await engine.readPageSnapshot(edit.slug, { sourceId: edit.source_id });
    if (!snapshot || Number(snapshot.page.id) !== edit.page_id || snapshot.revision !== edit.page_revision) return changed('page_moved', { page_revision: snapshot?.revision ?? null });
    if (await versionMarkdown(engine, edit, snapshot.page) === null) return changed('version_changed');
  }
  try {
    await submitPageMutation({ ...ctx, sourceId: edit.source_id }, { operation: 'revert_version', databaseOnly: 'overwrite_restore',
      params: { slug: edit.slug, source_id: edit.source_id, version_id: edit.version_id, expected_revision: edit.page_revision, request_id: requestId } });
  } catch (error) {
    if (error instanceof OperationError && ['revision_conflict', 'page_identity_changed', 'page_not_found'].includes(error.code)) return changed(error.code, { request_id: requestId });
    throw error;
  }
  const hold = await holdDivergentFile(engine, edit, requestId);
  const unheld = hold.why === 'checkout_not_on_this_host' || hold.why === 'file_over_read_bound';
  return { applied: true, outcome: hold.held ? 'restored_file_held' : unheld ? 'restored_file_unheld' : 'restored',
    detail: { request_id: requestId, version_id: edit.version_id, ...(replayed ? { replayed } : {}), ...hold,
      ...(unheld ? { next: `the committed file was not compared or held; on the host that owns the checkout, preview ${ownerHostCommand(edit)} and apply it to write the restored edit to the file (no command writes only the hold)` } : {}) } };
}

/**
 * After a restore: when this host owns the source's checkout and the committed file at HEAD differs from the restored
 * page, hold it `file_drift` so no sync publishes it over the edit again. Identifiers and revisions only.
 */
async function holdDivergentFile(engine: BrainEngine, edit: ApprovedEdit, requestId: string): Promise<{ held: boolean; file?: string; why?: string; sides?: 'database' | 'both' }> {
  const snapshot = await engine.readPageSnapshot(edit.slug, { sourceId: edit.source_id });
  if (!snapshot?.page.source_path) return { held: false, why: 'no_recorded_file' };
  const binding = await getWorktreeBinding(engine, edit.source_id);
  if (!binding?.local_path || binding.owner_host_id !== localHostId()) return { held: false, why: 'checkout_not_on_this_host' };
  const root = join(binding.local_path, binding.relative_path);
  const mode = await scannerSlugRootMode(engine, edit.source_id, root);
  const target = resolveSourceLocalFilePath(root, snapshot.page.source_path, edit.slug, mode);
  if (!target) return { held: false, why: 'no_recorded_file' };
  const gitRoot = syncGit(root, ['rev-parse', '--show-toplevel']).trim();
  const relativePath = relative(root, target).split(sep).join('/');
  const gitPath = syncGitPath({ root, gitRoot }, relativePath);
  const blob = readTreeBlobs(gitRoot, 'HEAD', [gitPath]).get(gitPath);
  if (!blob) return { held: false, file: relativePath, why: 'file_not_committed' };
  const bytes = readBlobContents(gitRoot, [blob]).get(blob.oid);
  if (bytes === undefined) return { held: false, file: relativePath, why: 'file_over_read_bound' };
  if (await fileMatchesSnapshot(engine, edit.slug, bytes, snapshot, scannerSourcePath(root, target, mode))) return { held: false, file: relativePath, why: 'file_matches' };
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [edit.source_id]);
  const record = (await readSyncImportProvenances(engine, edit.source_id, source!.incarnation, [edit.page_id])).get(edit.page_id);
  const sides = record?.disk_blob_oid === blob.oid ? 'database' as const : 'both' as const;
  const held = fileDriftHold({ path: relativePath, sourcePath: snapshot.page.source_path, action: 'import', working: false }, edit.slug, edit.page_id,
    { content: bytes, blobOid: blob.oid }, { sides, revision: snapshot.revision, proof: { request_id: requestId, operation: 'revert_version', revision: snapshot.revision }, sharedOrigin: false });
  await engine.transaction(tx => writeGitHold(tx, { ...held, source_id: edit.source_id, incarnation: source!.incarnation, observed_at: new Date().toISOString(), run_id: null, mode: 'managed' }));
  return { held: true, file: relativePath, sides };
}
