/**
 * `gbrain repair url-clone-fences` (#6946, GBRA-130 C-2): clear the local changes an
 * older gbrain left in a clone it owns (`sources add --url`), which block every
 * `git pull --ff-only` that touches the same file (`pull_blocked_local_changes`,
 * url-clone.ts). Current releases never write into such a clone on an unmanaged
 * brain; this kind exits the state the older fence writer left behind.
 *
 * The preview lists every tracked file of each owned clone in scope that differs
 * from HEAD and proves, per file, that the difference is only `## Facts` fence
 * rows gbrain appended: both sides' fences parse, HEAD's rows are an unchanged
 * prefix of the working copy's, and re-rendering HEAD's bytes with the working
 * fence reproduces the working copy byte for byte. Any other difference (a user
 * edit, a struck or changed row, a staged change, a deleted file) refuses that
 * file, names it in the preview with why, and leaves it untouched.
 *
 * Explicit-only, preview-bound and destructive: `--apply --expect <hash> --yes`
 * applies exactly the previewed files. The hash binds the source selection
 * (`--source`), each source's incarnation and canonical clone root and each
 * file's page, so an apply with another selection, or after the source was
 * relocated (`sources set-path`) or replaced under its id, refuses
 * `preview_changed` before anything is written. Per file, under the source
 * filesystem lock and the page lock, the apply rechecks that binding and the
 * index (a change staged since the preview: `preview_changed`), then the file
 * and HEAD against the preview (`changed_since_preview` otherwise), backs the working copy up under
 * ~/.gbrain/backups/url-clone-fences/, keeps the appended rows database-only in
 * one transaction (`row_num` and `source_markdown_slug` cleared, the shape every
 * database-only fact has; a fence row the database lost is inserted
 * database-only), imports HEAD's bytes as the page (the canonical import, as
 * sync would), and only then restores the file from HEAD. Each step is
 * idempotent, so a run stopped between them previews the same file again. Facts stay active and recallable. To
 * undo, copy the backup over the file. Unmanaged brains only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { gbrainPath } from '../config.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { createFrontmatterBackup, makeFrontmatterBackupRunId } from '../brain-writer.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../facts-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { importFromContent } from '../import-file.ts';
import { assertSourceFilesystemActive, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { OperationError } from '../ops/contract.ts';
import { withPageLock } from '../page-lock.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet, type ApprovedSetKey } from '../persistence/preview-approval.ts';
import { resolveSlugForPath } from '../sync.ts';
import { isOwnedClone, trackedChanges, urlCloneReadOnly, urlCloneRepairPreviewArgv } from '../url-clone.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan } from './core.ts';

const DOCS = 'docs/guides/repair.md#url-clone-fences';
/** preview-approval's command union predates this kind; the store keys on the string alone. */
const APPROVAL = { command: 'url-clone-fences' as ApprovedSetKey['command'] };

/**
 * One previewed file whose difference from HEAD is only appended fence rows, bound to the source incarnation, the
 * canonical clone root and the page the preview read, and to the preview's source selection.
 */
interface ClonedFile { source_id: string; incarnation: string; root: string; path: string; slug: string; page_id: number | null;
  head_sha256: string; work_sha256: string; rows: number[]; selection: string[] }
type FileItem = RepairItem & { file: ClonedFile; hash?: string; last?: boolean };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const preview = (sourceId: string | undefined) => sourceId ? urlCloneRepairPreviewArgv(sourceId).join(' ') : 'gbrain repair url-clone-fences';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) as string;
}

/** HEAD's bytes of a root-relative path; null when HEAD has no such file. */
function headBytes(root: string, path: string): string | null {
  try { return git(root, ['show', `HEAD:${path}`]); } catch { return null; }
}

type Proof = { ok: true; added: ParsedFact[] } | { ok: false; class: string; reason: string };

/** Whether `work` is `head` with fence rows appended and nothing else (see the module header). */
export function proveFenceRowsOnly(head: string | null, work: string | null): Proof {
  if (work === null) return { ok: false, class: 'deleted', reason: 'the file is deleted in the checkout' };
  if (head === null) return { ok: false, class: 'not_in_head', reason: 'HEAD has no such file' };
  const before = parseFactsFence(head);
  const after = parseFactsFence(work);
  if (before.warnings.length || after.warnings.length) return { ok: false, class: 'unparsed_fence', reason: 'a facts fence does not parse cleanly' };
  const prefix = before.facts.length < after.facts.length && before.facts.every((row, i) => JSON.stringify(row) === JSON.stringify(after.facts[i]));
  if (!prefix || replaceOrInsertFactsFence(head, renderFactsTable(after.facts)) !== work) {
    return { ok: false, class: 'non_fence_edit', reason: 'the file differs from HEAD by more than appended fence rows' };
  }
  return { ok: true, added: after.facts.slice(before.facts.length) };
}

async function pageOf(engine: BrainEngine, sourceId: string, path: string): Promise<{ slug: string; page_id: number | null }> {
  const [row] = await engine.executeRaw<{ id: number; slug: string }>(
    'SELECT id, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL ORDER BY id LIMIT 1', [sourceId, path]);
  return row ? { slug: row.slug, page_id: Number(row.id) } : { slug: resolveSlugForPath(path), page_id: null };
}

const canonicalRoot = (path: string | null): string | null => path && existsSync(path) ? realpathSync(path) : null;

/** Why the source or page of a previewed file is no longer the one its preview read, or null when it still is. */
async function identityChange(engine: BrainEngine, file: ClonedFile): Promise<string | null> {
  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null }>(
    'SELECT incarnation::text AS incarnation, local_path FROM sources WHERE id = $1', [file.source_id]);
  if (!source || source.incarnation !== file.incarnation) return `source ${file.source_id} was removed or replaced since the preview`;
  if (canonicalRoot(source.local_path) !== file.root) return `source ${file.source_id} now points at ${source.local_path ?? 'no checkout'}, not the clone the preview read (${file.root})`;
  const page = await pageOf(engine, file.source_id, file.path);
  if (page.slug !== file.slug || page.page_id !== file.page_id) return `${file.path} now belongs to another page than the preview read`;
  return null;
}

/** Every changed file of every owned clone in scope, proven or refused. */
async function survey(engine: BrainEngine, sourceIds: string[]): Promise<{ files: ClonedFile[]; listing: RepairListing[] }> {
  const files: ClonedFile[] = [];
  const listing: RepairListing[] = [];
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; config: unknown }>(
    'SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [sourceIds]);
  for (const source of sources) {
    const root = canonicalRoot(source.local_path);
    if (!root || !isOwnedClone(source)) continue;
    let paths: string[];
    let staged: Set<string>;
    try {
      paths = trackedChanges(root);
      staged = new Set(git(root, ['diff', '--cached', '--name-only', '--relative', '-z', 'HEAD', '--']).split('\0').filter(Boolean));
    } catch (error) {
      listing.push({ item: `${source.id}:.`, class: 'unreadable_checkout', detail: `git cannot read the checkout (${(error as Error).message.split('\n')[0]}); fix the checkout, then preview again: ${preview(source.id)}` });
      continue;
    }
    for (const path of paths) {
      const item = `${source.id}:${path}`;
      const work = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
      const head = headBytes(root, path);
      const proof: Proof = staged.has(path) ? { ok: false, class: 'staged_change', reason: 'the file has a staged change, which gbrain never makes' } : proveFenceRowsOnly(head, work);
      if (!proof.ok) {
        listing.push({ item, class: proof.class, detail: `${proof.reason}, so it is left as it is. Keep or remove that change yourself (git -C ${root} diff HEAD -- ${path} shows it), then preview again: ${preview(source.id)}` });
        continue;
      }
      const { slug, page_id } = await pageOf(engine, source.id, path);
      files.push({ source_id: source.id, incarnation: source.incarnation, root, path, slug, page_id, head_sha256: sha256(head!), work_sha256: sha256(work!),
        rows: proof.added.map(row => row.rowNum), selection: sourceIds });
      listing.push({ item, class: 'fence_rows_only', detail: `${proof.added.length} fence row(s) gbrain appended to ${slug}: kept database-only, then the file is restored from HEAD` });
    }
  }
  return { files, listing };
}

const toItem = (file: ClonedFile, index: number, hash?: string, last?: boolean): FileItem => ({ cursor: { phase: 0, id: index + 1 }, source_id: file.source_id,
  slug: file.slug, chars: 0, action: 'restore_from_head', file, ...(hash ? { hash, last } : {}) });

/** One transaction: the appended rows become database-only rows (a row the database lost is inserted database-only). */
async function keepRowsDatabaseOnly(engine: BrainEngine, file: ClonedFile, added: ParsedFact[]): Promise<{ moved: number; inserted: number }> {
  return maintenanceTransaction(engine, async tx => {
    let moved = 0;
    let inserted = 0;
    for (const row of added) {
      const updated = await tx.executeRaw<{ id: number }>(
        'UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num = $3 RETURNING id',
        [file.source_id, file.slug, row.rowNum]);
      moved += updated.length;
      if (updated.length) continue;
      const kept = await tx.executeRaw<{ id: number }>(
        'SELECT id FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL AND fact = $3 LIMIT 1', [file.source_id, file.slug, row.claim]);
      if (kept.length) continue;
      const { row_num: _row, source_markdown_slug: _slug, superseded_by_row: _superseded, ...fact } = extractFactsFromFenceText([row], file.slug, file.source_id)[0]!;
      await tx.insertFact(fact, { source_id: file.source_id }); // gbrain-allow-direct-insert: url-clone-fences keeps a fence row the database lost as a database-only row before its file is restored
      inserted++;
    }
    return { moved, inserted };
  });
}

async function restoreFile(engine: BrainEngine, file: ClonedFile, runId: string): Promise<RepairItemOutcome> {
  const changed = await identityChange(engine, file);
  if (changed) return { applied: false, outcome: 'preview_changed', reason: changed, detail: { path: file.path } };
  if (!await urlCloneReadOnly(engine, file.source_id)) return { applied: false, outcome: 'refused', reason: 'not_url_clone', detail: { path: file.path } };
  if (git(file.root, ['diff', '--cached', '--name-only', '--relative', '-z', 'HEAD', '--', file.path])) {
    return { applied: false, outcome: 'preview_changed', reason: `${file.path} has a staged change since the preview, which gbrain never makes`, detail: { path: file.path } };
  }
  const abs = join(file.root, file.path);
  const head = headBytes(file.root, file.path);
  const work = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  const proof = proveFenceRowsOnly(head, work);
  if (!proof.ok || sha256(head!) !== file.head_sha256 || sha256(work!) !== file.work_sha256) {
    return { applied: false, outcome: 'changed_since_preview', detail: { path: file.path } };
  }
  const backup = createFrontmatterBackup(abs, { sourcePath: file.root, backupRoot: gbrainPath('backups', 'url-clone-fences', runId) });
  const { moved, inserted } = await keepRowsDatabaseOnly(engine, file, proof.added);
  await importFromContent(engine, file.slug, head!, { sourceId: file.source_id, sourcePath: file.path, sourceRoot: file.root, noEmbed: true });
  assertSourceFilesystemActive();
  atomicWriteFileSync(abs, head!);
  return { applied: true, outcome: 'restored', detail: { path: file.path, slug: file.slug, backup, rows_moved: moved, rows_inserted: inserted } };
}

export const urlCloneFencesRepair: RepairHandler = {
  kind: 'url-clone-fences',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts = { apply: false }): Promise<RepairPlan> {
    const source = scope.source_ids.length === 1 ? scope.source_ids[0] : undefined;
    if (await managedPersistenceEnabled(engine)) {
      return { items: [], residuals: {}, warnings: ['This brain is managed: gbrain repair url-clone-fences applies to unmanaged brains. On a managed brain, gbrain sources mirror-readonly <id> keeps a clone\'s checkout unwritten.'] };
    }
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair url-clone-fences --apply needs the preview hash.',
        `Preview first: ${preview(source)} — then run the apply command it prints (--apply --expect <preview-hash> --yes).`, DOCS);
      const { items: files } = await loadApprovedSet<ClonedFile>(engine, { ...APPROVAL, hash: opts.expect, previewCommand: preview(source) });
      for (const file of files) {
        if (JSON.stringify(file.selection) !== JSON.stringify(scope.source_ids) || await identityChange(engine, file)) throw previewChangedError(opts.expect, preview(source));
      }
      const items = files.map((file, index) => toItem(file, index, opts.expect, index === files.length - 1)).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { ...APPROVAL, hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    const { files, listing } = await survey(engine, scope.source_ids);
    const residuals: Record<string, number> = {};
    for (const entry of listing) if (entry.class !== 'fence_rows_only') residuals[entry.class] = (residuals[entry.class] ?? 0) + 1;
    const hash = previewHash({ kind: 'url-clone-fences-v2', brain_id: scope.brain_id, selection: scope.source_ids,
      files: files.map(f => [f.source_id, f.incarnation, f.root, f.path, f.slug, f.page_id, f.head_sha256, f.work_sha256, f.rows]) });
    if (files.length) await saveApprovedSet<ClonedFile>(engine, { ...APPROVAL, hash }, files);
    return { items: files.map((file, index) => toItem(file, index)), residuals, listing, ...(files.length ? { preview_hash: hash } : {}), details: { listing } };
  },
  async apply(ctx, entry, opts) {
    const item = entry as FileItem;
    const { file } = item;
    const outcome = await withSourceFilesystemLock(ctx.engine, file.root,
      () => withPageLock(file.slug, () => restoreFile(ctx.engine, file, opts?.runId ?? makeFrontmatterBackupRunId()), { timeoutMs: 5_000 }));
    if (item.last && item.hash) await clearApprovedSet(ctx.engine, { ...APPROVAL, hash: item.hash });
    return outcome;
  },
  render(details) {
    return ((details as { listing?: RepairListing[] }).listing ?? []).map(entry => `  ${entry.class}: ${entry.item}: ${entry.detail ?? ''}`);
  },
};
