/**
 * `foresights repair uncommitted-deletions --source <id>` (#7130): restore soft-deleted pages whose recorded file Git never
 * held (`.gitignore` excludes it, or no commit holds it and it is not on the disk), which a managed sync deleted before
 * #7130 because it read the absent file as a deletion. Such a tombstone may hold the only copy of its page, and the
 * purge removes it for good after its retention window.
 *
 * Explicit-only, preview-bound and consented: the preview (`scanUncommittedDeletions`, on the source's canonical owner
 * host only, `not_owner_host` elsewhere) lists each page with its slug, recorded path, deletion time, evidence and who
 * deleted it, binds the set to the owner it ran under and saves it under its hash; the default set is the pages a sync
 * deleted, and `--include-ambiguous` adds the ones another writer deleted. `--apply --expect <hash> --yes` restores
 * exactly that set, one coordinated `restore_page` with `detach: true` per page, published database-only: the page
 * comes back live, forgets its recorded file (`database_only_reason='detached'`, `detached-pages.ts`) and no file is
 * written, so the next sync has no file to read as missing and never deletes it again. A page that changed since the
 * preview is skipped `changed_since_preview`; one whose file is back in the checkout is skipped `file_restored` (sync
 * reads it); one purged in between is skipped `purged`. Pages already purged cannot be restored by this command; only
 * a backup can bring them back. One preview reads one bounded window of tombstones (descending page id); a truncated
 * preview prints `next_after`, and `--after <page id>` previews the next window (the hash covers it). Never runs on upgrade
 * or from a maintenance cycle.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { sourceContext, type GhostOwner } from '../ghost-pages.ts';
import { absentRecordedFile } from '../persistence/detached-pages.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { PURGED_NOTE, scanUncommittedDeletions, type UncommittedDeletion } from '../uncommitted-deletions.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

/** Pages one preview lists; a larger set is restored in rounds (preview, apply, preview again). */
export const UNCOMMITTED_DELETIONS_LIMIT = 1000;
/** Recorded files whose Git evidence one preview reads. */
const PATH_LIMIT = 5000;
const DOCS = 'docs/guides/repair.md#uncommitted-deletions';

export const uncommittedDeletionsPreviewCommand = (sourceId: string) => `foresights repair uncommitted-deletions --source ${sourceId}`;
const previewFix = (sourceId: string) => readFix('Previews the restorable soft-deleted pages of the source again; writes nothing.',
  { argv: ['gbrain', 'repair', 'uncommitted-deletions', '--source', sourceId, '--json'] });

/** The consent payload of `--apply --expect <hash>` (registry `consentText`). */
export const UNCOMMITTED_DELETIONS_CONSENT_TEXT = {
  what: 'Restore the previewed soft-deleted pages whose recorded file Git never held, as database-only pages',
  why: 'The preview listed each page with its recorded path and the evidence that Git never committed that file (or .gitignore excludes it), so the tombstone may hold the only copy and the purge would remove it for good.',
  risk: 'Each page comes back live and detached: it forgets its recorded file path (database_only_reason=detached) and no file is written, so sync never deletes it again; a file put at that path later is not linked to it. '
    + `Undo one with foresights delete <slug>. ${PURGED_NOTE}`,
  user_message: 'Restore the previewed pages that a sync deleted without Git evidence? They come back live as database-only pages; no file is written',
};

interface Selection { source_ids: string[]; include_ambiguous: boolean; after: number | null }
interface ApprovedDeletion extends UncommittedDeletion { owner: GhostOwner; selection: Selection }
interface DeletionItem extends RepairItem { page: UncommittedDeletion; hash: string; last: boolean }

const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;

function notOwnerHost(sourceId: string): OperationError {
  return opError('not_owner_host', `Soft-deleted pages of source ${sourceId} can only be checked and restored on its canonical owner host.`,
    `This host does not own source ${sourceId}'s active canonical worktree, so it cannot read whether Git ever held a page's file; nothing was listed or changed. Run ${uncommittedDeletionsPreviewCommand(sourceId)} in a terminal on the owner host (writer status names it).`,
    { fix: readFix('Shows the source\'s canonical binding and owner host, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }), docs: DOCS });
}

const hashParts = (scope: RepairScope, owner: GhostOwner | undefined, selection: Selection, pages: UncommittedDeletion[]) =>
  ({ kind: 'uncommitted-deletions-v1', brain_id: scope.brain_id, selection, owner: owner ?? null, pages });

const describeDeletion = (page: UncommittedDeletion) => `file ${page.source_path} ${page.evidence === 'ignored' ? 'is excluded by .gitignore' : 'was never committed'}; `
  + `deleted ${page.deleted_at} by ${page.deleted_by === 'sync' ? 'a managed sync' : 'another writer'}; revision ${page.revision}`;

function item(page: UncommittedDeletion, hash: string, index: number, last: boolean): DeletionItem {
  return { cursor: { phase: 1, id: index }, source_id: page.source_id, slug: page.slug, chars: 0, action: `restore_detached:${page.evidence}`, page, hash, last };
}

export const uncommittedDeletionsRepair: RepairHandler = {
  kind: 'uncommitted-deletions',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'foresights repair uncommitted-deletions needs --source <id>.',
        'Git evidence is read in each source\'s own checkout on its canonical owner host; name one source, e.g. foresights repair uncommitted-deletions --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = uncommittedDeletionsPreviewCommand(sourceId);
    const selection: Selection = { source_ids: scope.source_ids, include_ambiguous: opts?.includeAmbiguous === true, after: opts?.afterPage ?? null };
    if (opts?.apply) {
      if (!opts.expect) {
        throw opError('invalid_params', 'foresights repair uncommitted-deletions --apply restores only the set a preview printed.',
          `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`,
          { fix: previewFix(sourceId), docs: DOCS });
      }
      const context = await sourceContext(engine, sourceId);
      if (!context.ok && context.reason === 'not_owner_host') throw notOwnerHost(sourceId);
      const owner = context.ok ? context.owner : undefined;
      const approved = await loadApprovedSet<ApprovedDeletion>(engine, { command: 'uncommitted-deletions', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, owner, selection, [])) });
      if (approved.items.some(page => JSON.stringify(page.selection.source_ids) !== JSON.stringify(selection.source_ids) || page.selection.include_ambiguous !== selection.include_ambiguous
        || (page.selection.after ?? null) !== selection.after || !sameOwner(owner, page.owner))) throw previewChangedError(opts.expect, command);
      const items = approved.items.map(({ selection: _selection, owner: _owner, ...page }, index) => item(page, opts.expect!, index, index === approved.items.length - 1));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const scan = await scanUncommittedDeletions(engine, sourceId, { pathLimit: PATH_LIMIT, ...(selection.after !== null ? { after: selection.after } : {}) });
    if (scan.reason === 'not_owner_host') throw notOwnerHost(sourceId);
    const eligible = scan.pages.filter(page => selection.include_ambiguous || page.deleted_by === 'sync');
    const selected = eligible.slice(0, UNCOMMITTED_DELETIONS_LIMIT);
    const cut = eligible.length > selected.length ? selected[selected.length - 1]!.page_id : undefined;
    const next = cut ?? scan.next_after;
    const excluded = scan.pages.filter(page => !selection.include_ambiguous && page.deleted_by !== 'sync' && (cut === undefined || page.page_id > cut));
    const hash = previewHash(hashParts(scope, scan.owner, selection, selected));
    if (selected.length) await saveApprovedSet<ApprovedDeletion>(engine, { command: 'uncommitted-deletions', hash }, selected.map(page => ({ ...page, owner: scan.owner!, selection })));
    const warnings = [
      PURGED_NOTE,
      ...(scan.status !== 'known' ? [`Source ${sourceId} was not checked (${scan.reason}): ${scan.reason === 'not_managed' ? 'this brain has no managed sync, which is what deleted these pages'
        : scan.reason === 'mirror_read_only' ? 'a read-only mirror publishes no file' : 'its checkout or Git history could not be read on this host'}; nothing is listed.`] : []),
      ...(scan.unknown ? [`${scan.unknown} soft-deleted page(s) are not listed because Git could not answer for their file; fix the checkout and preview again.`] : []),
      ...(excluded.length ? [`${excluded.length} more soft-deleted page(s) with an uncommitted file were deleted by another writer, not by a sync; they are listed apart and restored only with --include-ambiguous.`] : []),
      ...(scan.truncated || cut !== undefined ? [`This preview read one bounded window of tombstones; more may qualify below page id ${next}. `
        + `After applying this set (or deciding not to), preview the next window: ${command} --after ${next}${selection.include_ambiguous ? ' --include-ambiguous' : ''}`] : []),
    ];
    return { warnings, items: selected.map((page, index) => item(page, hash, index, index === selected.length - 1)), preview_hash: hash,
      residuals: { tombstones: scan.tombstones, checked: scan.checked, committed: scan.committed, file_present: scan.file_present, unknown: scan.unknown, ...(excluded.length ? { deleted_by_other: excluded.length } : {}) },
      listing: [...selected.map(page => ({ item: `${page.source_id}:${page.slug}`, class: `restore:${page.evidence}`, detail: describeDeletion(page) })),
        ...excluded.map(page => ({ item: `${page.source_id}:${page.slug}`, class: 'excluded:deleted_by_other', detail: `${describeDeletion(page)}; restored only with --include-ambiguous` }))],
      details: { pages: selected.map(({ source_id, slug, source_path, deleted_at, evidence, deleted_by }) => ({ source_id, slug, source_path, deleted_at, evidence, deleted_by })),
        purged: PURGED_NOTE, undo: 'foresights delete <slug>', truncated: scan.truncated || cut !== undefined, ...(next !== undefined ? { next_after: next } : {}), docs: DOCS } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as DeletionItem;
    const outcome = await restoreDeletion(ctx, page);
    if (last) await clearApprovedSet(ctx.engine, { command: 'uncommitted-deletions', hash });
    return outcome;
  },
  render(details) {
    return [`  each restored page: live, database-only (detached), no file written; undo per slug: ${details.undo}; guide: ${details.docs}`, `  ${details.purged}`];
  },
};

const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });

/** Restores one approved tombstone database-only (`restore_page` with `detach`), after checking it is still the previewed one. */
async function restoreDeletion(ctx: OperationContext, page: UncommittedDeletion): Promise<RepairItemOutcome> {
  const engine: BrainEngine = ctx.engine;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id, includeDeleted: true });
  if (!snapshot) return { applied: false, outcome: 'purged', reason: `${page.slug} was purged after the preview. ${PURGED_NOTE}` };
  if (Number(snapshot.page.id) !== page.page_id || snapshot.revision !== page.revision || snapshot.page.source_path !== page.source_path) return changed('the page or its recorded file changed since the preview');
  if (!snapshot.page.deleted_at) return { applied: false, outcome: 'already_live' };
  if (!await absentRecordedFile(engine, page.source_id, snapshot.page)) {
    return { applied: false, outcome: 'file_restored', reason: `${page.source_path} is in the checkout again, so ${page.slug} was not detached; commit the file and run foresights sync --source ${page.source_id}, or restore it with foresights restore ${page.slug} --source-id ${page.source_id}.` };
  }
  const requestId = await repairRequestId(ctx, 'uncommitted-deletions', page, page.revision);
  try {
    await submitPageMutation({ ...ctx, sourceId: page.source_id }, { operation: 'restore_page', databaseOnly: 'detached',
      params: { slug: page.slug, source_id: page.source_id, detach: true, expected_revision: page.revision, request_id: requestId } });
  } catch (error) {
    if (error instanceof OperationError && ['revision_conflict', 'page_identity_changed', 'page_not_found'].includes(error.code)) return changed(error.message);
    throw error;
  }
  return { applied: true, outcome: 'restored_detached', detail: { request_id: requestId, evidence: page.evidence, deleted_by: page.deleted_by } };
}
