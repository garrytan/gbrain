/**
 * `gbrain repair rows-behind --source <id> [--include-ambiguous] [--apply --expect <hash>]` (#8071): re-import the rows a
 * managed sync's checkpoint moved past (`persistence/rows-behind.ts`: the row holds an older version of its file than
 * `sources.last_commit`, with no hold), from the file as committed at the checkpoint.
 *
 * Explicit-only and preview-bound: the preview (on the source's canonical owner host only) lists each row with its path,
 * the checkpoint blob and what the apply does, saves the set under its hash and writes nothing. `reimport`: the checkpoint
 * bytes are imported through the managed file repair (`submitManagedFileRepair`: the same screen, preparation and
 * projections a managed sync import uses, bound to the page revision and the previewed result; the file on disk already
 * holds those bytes, so no file is written, and the import record is rewritten). `hold:<code>`: the import of the
 * checkpoint file is refused (or it is over the sync read bound), so the apply opens the hold sync would have opened, with
 * the code and message of the refusal the apply recomputes (not the one saved with the preview). Left out of the set and listed: rows with no import record (`excluded:unproven`, joined
 * by --include-ambiguous), rows whose working-tree file differs from the checkpoint blob (`excluded:worktree_differs`: an
 * uncommitted edit; commit it and sync), and rows whose import would keep page data the file does not carry
 * (`excluded:import_overlay`). `--apply --expect <hash>` applies exactly that set; a row whose page, checkpoint or file
 * changed since is `changed_since_preview`. Never runs on upgrade, from --all or from the remediation plan.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { sourceContext, type GhostOwner } from '../ghost-pages.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../persistence/file-repair.ts';
import { readBlobs } from '../persistence/git-gap.ts';
import { loadApprovedSet, previewChangedError, previewHash, retireAfterLastItem, saveApprovedSet } from '../persistence/preview-approval.ts';
import { ROWS_BEHIND_DOCS, rowRefusal, scanRowsBehind, type RowBehind } from '../persistence/rows-behind.ts';
import { SYNC_READ_BOUND } from '../persistence/sync-blobs.ts';
import { readGitHold, writeGitHold, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const rowsBehindPreviewCommand = (sourceId: string) => `gbrain repair rows-behind --source ${sourceId}`;
const previewFix = (sourceId: string) => readFix('Previews the rows behind the sync checkpoint again; writes nothing.', { argv: ['gbrain', 'repair', 'rows-behind', '--source', sourceId, '--json'] });

type Action = 'reimport' | 'hold';
interface Selection { source_ids: string[]; include_ambiguous: boolean }
interface ApprovedRow extends RowBehind { source_id: string; checkpoint: string; action: Action; owner: GhostOwner; selection: Selection }
interface RowItem extends RepairItem { row: ApprovedRow; hash: string; last: boolean }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sameOwner = (a: GhostOwner | undefined, b: GhostOwner) => !!a && a.host_id === b.host_id && a.worktree_id === b.worktree_id
  && a.owner_epoch === b.owner_epoch && a.source_incarnation === b.source_incarnation;

function notOwnerHost(sourceId: string): OperationError {
  return opError('not_owner_host', `Rows behind the sync checkpoint of source ${sourceId} can only be checked and re-imported on its canonical owner host.`,
    `This host does not own source ${sourceId}'s active canonical worktree, so it cannot read the checkpoint commit; nothing was listed or changed. Run ${rowsBehindPreviewCommand(sourceId)} on the owner host (writer status names it).`,
    { fix: readFix('Shows the source\'s canonical binding and owner host, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }), docs: ROWS_BEHIND_DOCS });
}

const hashParts = (scope: RepairScope, owner: GhostOwner | null, selection: Selection, checkpoint: string | null, rows: Array<Pick<ApprovedRow, 'slug' | 'revision' | 'blob' | 'action' | 'digest'>>) =>
  ({ kind: 'rows-behind-v1', brain_id: scope.brain_id, selection, owner, checkpoint, rows: rows.map(row => [row.slug, row.revision, row.blob, row.action, row.digest ?? null]) });

const item = (row: ApprovedRow, hash: string, index: number, last: boolean): RowItem =>
  ({ cursor: { phase: 0, id: index + 1 }, source_id: row.source_id, slug: row.slug, chars: 0, action: row.action === 'hold' ? `hold:${row.refusal!.code}` : 'reimport', row, hash, last });

/** The committed bytes of a blob, or null when Git cannot read it. */
async function blobBytes(root: string, row: Pick<RowBehind, 'blob' | 'size'>): Promise<Buffer | null> {
  return (await readBlobs(root, [{ oid: row.blob, size: row.size, mode: '100644' }]))?.get(row.blob) ?? null;
}

/** Whether the working-tree file holds exactly the checkpoint bytes. */
function worktreeMatches(root: string, path: string, bytes: Buffer): boolean {
  try { return sha256(readFileSync(join(root, path))) === sha256(bytes); } catch { return false; }
}

export const rowsBehindRepair: RepairHandler = {
  kind: 'rows-behind',
  embeds: true,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair rows-behind needs --source <id>.',
        'Rows are compared with the checkpoint commit in each source\'s own checkout on its canonical owner host; name one source, e.g. gbrain repair rows-behind --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: ROWS_BEHIND_DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const command = rowsBehindPreviewCommand(sourceId);
    const selection: Selection = { source_ids: scope.source_ids, include_ambiguous: opts?.includeAmbiguous === true };
    const context = await sourceContext(engine, sourceId);
    if (!context.ok && context.reason === 'not_owner_host') throw notOwnerHost(sourceId);
    const owner = context.ok ? context.owner : null;
    if (opts?.apply) {
      if (!opts.expect) {
        throw opError('invalid_params', 'gbrain repair rows-behind --apply re-imports only the set a preview printed.',
          `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`, { fix: previewFix(sourceId), docs: ROWS_BEHIND_DOCS });
      }
      const approved = await loadApprovedSet<ApprovedRow>(engine, { command: 'rows-behind', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, owner, selection, (await scanRowsBehind(engine, sourceId)).checkpoint, [])) });
      if (approved.items.some(row => JSON.stringify(row.selection) !== JSON.stringify(selection) || !owner || !sameOwner(owner, row.owner))) throw previewChangedError(opts.expect, command);
      const items = approved.items.map((row, index) => item(row, opts.expect!, index, index === approved.items.length - 1));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const scan = await scanRowsBehind(engine, sourceId);
    if (scan.status !== 'known' || !context.ok) {
      const hash = previewHash(hashParts(scope, owner, selection, scan.checkpoint, []));
      return { items: [], preview_hash: hash, residuals: {}, warnings: [`Source ${sourceId} was not compared (${scan.reason ?? 'not_applicable'}): ${scan.status === 'unknown'
        ? 'its checkout or the checkpoint commit could not be read on this host; fix the checkout and preview again'
        : 'it has no managed checkout with a sync checkpoint here (a repo-less source keeps its pages in the database, which is the record)'}; nothing is listed.`],
        details: { docs: ROWS_BEHIND_DOCS, status: scan.status, reason: scan.reason ?? null } };
    }
    const selected: ApprovedRow[] = [];
    const listing: NonNullable<RepairPlan['listing']> = [];
    const describe = (row: RowBehind) => `${row.path} at checkpoint ${scan.checkpoint!.slice(0, 12)} is blob ${row.blob.slice(0, 12)}; the page (revision ${row.revision}) holds an older version`;
    for (const row of [...scan.behind, ...scan.unproven]) {
      const entry = `${sourceId}:${row.slug}`;
      if (row.record === 'none' && !selection.include_ambiguous) { listing.push({ item: entry, class: 'excluded:unproven', detail: `${describe(row)}; no import record proves the database did not move since, so it joins only with --include-ambiguous` }); continue; }
      if (row.overlay) { listing.push({ item: entry, class: 'excluded:import_overlay', detail: `${describe(row)}; importing it would keep page data the file does not carry (tags, a withdrawal or sanitized text), so it is not re-imported here; gbrain repair file-drift --source ${sourceId} --slug ${row.slug} --prefer file resolves it` }); continue; }
      if (row.refusal) {
        selected.push({ ...row, source_id: sourceId, checkpoint: scan.checkpoint!, action: 'hold', owner: context.owner, selection });
        listing.push({ item: entry, class: `hold:${row.refusal.code}`, detail: `${describe(row)}; its import is refused (${row.refusal.code}: ${row.refusal.message}), so the apply holds the file as sync would` });
        continue;
      }
      const bytes = await blobBytes(context.root, row);
      if (!bytes || !worktreeMatches(context.root, row.path, bytes)) { listing.push({ item: entry, class: 'excluded:worktree_differs', detail: `${describe(row)}; the working-tree file differs from the committed one (an uncommitted edit): commit it and run gbrain sync --source ${sourceId}` }); continue; }
      selected.push({ ...row, source_id: sourceId, checkpoint: scan.checkpoint!, action: 'reimport', owner: context.owner, selection });
      listing.push({ item: entry, class: 'reimport', detail: `${describe(row)}; the apply imports the committed file through the managed import` });
    }
    const hash = previewHash(hashParts(scope, owner, selection, scan.checkpoint, selected));
    if (selected.length) await saveApprovedSet<ApprovedRow>(engine, { command: 'rows-behind', hash }, selected);
    const warnings = [
      ...(scan.truncated ? [`More rows are behind than one preview lists (${scan.behind_count} behind, ${scan.unproven_count} without a record); apply this set, then preview again for the rest.`] : []),
    ];
    return { items: selected.map((row, index) => item(row, hash, index, index === selected.length - 1)), preview_hash: hash, listing, ...(warnings.length ? { warnings } : {}),
      residuals: { ...scan.counts, pages: scan.pages, behind: scan.behind_count, unproven: scan.unproven_count },
      details: { docs: ROWS_BEHIND_DOCS, checkpoint: scan.checkpoint, head: scan.head, rows: selected.map(({ slug, path, blob, action, record, refusal }) => ({ slug, path, blob, action, record, ...(refusal ? { refusal: refusal.code } : {}) })) } };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    const { row, hash, last } = entry as RowItem;
    return retireAfterLastItem(ctx.engine, 'rows-behind', hash, last, () => applyRow(ctx, row, opts?.embed !== false));
  },
  render(details) {
    return [`  checkpoint ${String(details.checkpoint ?? '').slice(0, 12)}; each re-import goes through the managed import of the committed file (no file is written); guide: ${details.docs}`];
  },
};

const changed = (reason: string, detail: Record<string, unknown> = {}): RepairItemOutcome =>
  ({ applied: false, outcome: 'changed_since_preview', reason, detail: { ...detail, next: 'run gbrain repair rows-behind again for a new preview' } });

async function applyRow(ctx: OperationContext, row: ApprovedRow, embed: boolean): Promise<RepairItemOutcome> {
  const engine: BrainEngine = ctx.engine;
  const context = await sourceContext(engine, row.source_id);
  if (!context.ok || !sameOwner(context.owner, row.owner)) return changed('owner_changed');
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [row.source_id]);
  if (source?.last_commit !== row.checkpoint) return changed('checkpoint_moved', { checkpoint: source?.last_commit ?? null });
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (!snapshot || Number(snapshot.page.id) !== row.page_id || snapshot.revision !== row.revision || snapshot.page.deleted_at != null) return changed('page_moved');
  if (await readGitHold(engine, row.source_id, row.owner.source_incarnation, row.path)) return { applied: false, outcome: 'already_held' };
  const bytes = row.size > SYNC_READ_BOUND ? null : await blobBytes(context.root, row);
  const content = bytes?.toString('utf8') ?? null;
  const screen = await repairScreenConfig(engine, row.source_id);
  const publication = content === null ? null
    : await prepareRepairPublication(engine, { sourceId: row.source_id, slug: row.slug, sourcePath: row.source_path, path: row.path, root: context.root, content, snapshot, base: snapshot, ...screen });
  if (row.action === 'hold') {
    if (publication && publication.status !== 'refused') return changed('import_no_longer_refused');
    const refusal = publication?.status === 'refused' ? rowRefusal(publication.refusal) : row.refusal!;
    const held: Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'> = { source_id: row.source_id, incarnation: row.owner.source_incarnation, path: row.path, source_path: row.source_path,
      slug: row.slug, page_id: row.page_id, code: refusal.code as GitHoldRecord['code'], message: refusal.message, upstream_version: bytes ? sha256(bytes) : null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, ...(refusal.reason ? { reason: refusal.reason as GitHoldRecord['meta']['reason'] } : {}), ...(refusal.key ? { key: refusal.key } : {}), ...(refusal.line !== undefined ? { line: refusal.line } : {}), blob_oid: row.blob } };
    await engine.transaction(tx => writeGitHold(tx, held));
    return { applied: true, outcome: 'held', detail: { path: row.path, code: refusal.code, checkpoint: row.checkpoint, blob: row.blob } };
  }
  if (!bytes || !content || !worktreeMatches(context.root, row.path, bytes)) return changed('worktree_differs');
  if (publication?.status !== 'ready' || publication.digest !== row.digest) return changed('result_changed');
  const local = { ...ctx, remote: false, sourceId: row.source_id } as OperationContext;
  const requestId = await repairRequestId(local, 'rows-behind', { source_id: row.source_id, slug: row.slug }, `${row.revision}:${row.blob}`);
  try {
    const outcome = await submitManagedFileRepair(local, { sourceId: row.source_id, requestId, slug: row.slug, path: row.path, sourcePath: row.source_path, content,
      beforeHash: sha256(bytes), resultDigest: row.digest!, expected_revision: row.revision, noEmbed: !embed });
    return { applied: true, outcome: 'reimported', detail: { request_id: requestId, path: row.path, checkpoint: row.checkpoint, blob: row.blob, status: outcome.status, hold_cleared: outcome.hold_cleared === true } };
  } catch (error) {
    if (acceptedPendingReceipt(error) || !(error instanceof OperationError)) throw error;
    if (['changed_since_preview', 'revision_conflict', 'page_identity_changed', 'page_not_found', 'source_changed'].includes(error.code)) return changed(error.code, { request_id: requestId });
    if (error.code === 'sync_in_progress') return { applied: false, outcome: 'skipped', reason: 'sync_in_progress', detail: { request_id: requestId, message: error.message } };
    throw error;
  }
}
