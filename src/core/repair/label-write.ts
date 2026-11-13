/**
 * GST-2468: the one door for an operator repair's label-only page write (`gbrain repair private-labels`, `gbrain repair
 * visibility`). The write authors nothing, so the page keeps its stored trust tier and files no `lower_page` proposal,
 * and its canonical file changes only in the label lines (persistence/label-edit.ts):
 *   - a managed brain publishes it through the maintenance door with keep_trust and the label edit (the Git door on a
 *     repo source; a repo-less managed source writes the database only);
 *   - a brain without managed persistence imports it in a maintenance transaction under the page lock and withTrustKeep:
 *     database only when the page has no file (the default keyless install); a caller whose page has a file in its
 *     source's checkout (`filesInCheckout`) calls writeLabelFile, which imports the file's own bytes with only the label
 *     lines edited and writes them back in that transaction, so the next sync reads the same page.
 * An ordinary put_page, local or remote, stays an agent content write (trust/channel.ts): it is never used here.
 * GST-2521: every label write raises the page's label guard (raisePageLabelGuard), so an agent write at the page's own
 * tier is held from widening what the owner set.
 */
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { importFromContent } from '../import-file.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { withTrustKeep } from '../persistence/context.ts';
import { existingHostIdFor } from '../persistence/identity.ts';
import type { LabelEdit } from '../persistence/label-edit.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { fileSnapshotDifference, labelEditFit, labelEditRefused, prepareFileTarget } from '../persistence/page-prepare.ts';
import { readSyncFile } from '../persistence/sync-discovery.ts';
import { maintenancePreflight, publishMaintenancePage, publishMaintenancePages, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import type { RepairItemOutcome } from './core.ts';
import { raisePageLabelGuard } from '../trust/page-write.ts';

const bounded = { timeoutMs: 120_000 };

/**
 * GST-2128 item 1: on a brain without managed persistence, the pages with a recorded file (`source_path`) in a source that
 * has a checkout (`local_path`, or `sync.repo_path` for the default source), by page id. A label write there writes only the
 * database, so the file would put the label back at the next sync or re-import. The core reads no filesystem
 * (GBRA-248), so a recorded file that is gone still counts, which only holds a page. Empty on a managed brain.
 */
export async function filesInCheckout(engine: BrainEngine, pageIds: number[]): Promise<Map<number, string>> {
  if (!pageIds.length || await managedPersistenceEnabled(engine)) return new Map();
  const rows = await engine.executeRaw<{ id: number; source_id: string; source_path: string; local_path: string | null }>(`SELECT p.id, p.source_id, p.source_path, s.local_path
    FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.id = ANY($1::integer[]) AND p.source_path IS NOT NULL`, [pageIds], bounded);
  const repoPath = rows.some(row => row.source_id === 'default' && !row.local_path) ? await engine.getConfig('sync.repo_path') : null;
  return new Map(rows.flatMap(row => (row.local_path ?? (row.source_id === 'default' ? repoPath : null)) ? [[Number(row.id), row.source_path] as const] : []));
}

/**
 * Unmanaged brains: the legacy maintenance import (an owner path: no write gate, no trust marker, gate markers kept),
 * under withTrustKeep so the page keeps its stored tier, bound to `revision` under the page lock. The revision it wrote;
 * null when the page moved. `preview` names the command whose preview lists the page again.
 */
export async function importAtRevision(engine: BrainEngine, page: { source_id: string; slug: string }, revision: string, content: string, embed: boolean,
  preview: string, afterImport?: (tx: BrainEngine) => Promise<void>): Promise<string | null> {
  return maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    if ((await tx.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision !== revision) return null;
    const result = await withTrustKeep(tx, ['pages'], () => importFromContent(tx, page.slug, content, { sourceId: page.source_id, noEmbed: !embed, preserveGateMarkers: true }));
    if (result.status === 'error') throw opError('invalid_params', `${page.source_id}:${page.slug} was not written: ${result.error ?? 'the import refused it'}`,
      `Preview ${preview} again; the page is listed with its current state.`);
    await raisePageLabelGuard(tx, page.source_id, page.slug);
    await afterImport?.(tx);
    return (await tx.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision ?? null;
  });
}

/**
 * T1: an unmanaged page whose file (`path`, from filesInCheckout) sits in its source's checkout. The file must still hold
 * the page (a file holding an edit the database lacks refuses `source_changed`); its own bytes with only the label lines
 * edited (labelEditFile, the managed brain's splice) are imported under withTrustKeep at `revision` and written back with
 * their preimage checked, in one transaction, so the file and the row agree and the tier is kept. A file edited between
 * the read and the write refuses `source_changed` and rolls the import back. A file this repair cannot write
 * (`sync.write_through` off, a clone gbrain pulls, an unresolvable target, a write error) is held `file_backed` with
 * nothing written, since a database-only write would come back from the file at the next sync. A page with no file on
 * purpose (no checkout configured, a non-canonical target) or whose recorded file is gone writes the database only.
 * The revision written; null when the page moved.
 */
export async function writeLabelFile(engine: BrainEngine, page: { source_id: string; slug: string }, write: { revision: string; content: string; edit: LabelEdit; embed: boolean;
  preview: string; path: string }): Promise<string | null | RepairItemOutcome> {
  const ref = `${page.source_id}:${page.slug}`;
  const held = (why: string): RepairItemOutcome => ({ applied: false, outcome: 'file_backed', detail: { path: write.path },
    reason: `${ref} has a file in its source's checkout (${write.path}) that this repair cannot write (${why}), and a database-only write would come back from the file `
      + `at the next sync. Make the change in that file by hand, commit it, then run: gbrain sync --source ${page.source_id}` });
  const { isWriteThroughDisabled, writePageThrough } = await import('../write-through.ts');
  if (await isWriteThroughDisabled(engine)) return held('sync.write_through is off');
  const { ownerRepairFile } = await import('../trust/page-handlers.ts');
  const file = await ownerRepairFile(engine, page.source_id, page.slug);
  if (!file.ok && file.reason !== 'file_database_drift') return held(file.reason);
  if (!file.ok) throw opError('source_changed', `${ref} was not written: its file in the source's checkout holds an edit the database lacks.`,
    `Run gbrain sync --source ${page.source_id}, then preview ${write.preview} again.`);
  const before = file.target?.expectedFileBytes ?? null;
  const snapshot = before === null ? null : await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (before === null || !snapshot) return importAtRevision(engine, page, write.revision, write.content, write.embed, write.preview);
  if (snapshot.revision !== write.revision) return null;
  const fit = labelEditFit(page.slug, Buffer.from(before, 'utf8'), write.content, write.edit, snapshot);
  if (typeof fit !== 'string') throw labelEditRefused(page, fit.keys, write.edit);
  const text = fit;
  let unwritable: string | undefined;
  try {
    return await importAtRevision(engine, page, write.revision, text, write.embed, write.preview, async tx => {
      const written = await writePageThrough(tx, page.slug, { sourceId: page.source_id, expectedFileBytes: before, fileText: text });
      if (written.written) return;
      if (written.skipped !== 'file_changed') unwritable = written.skipped ?? written.error ?? 'the write failed';
      throw opError('source_changed', `${ref} was not written: its file changed after it was read.`, `Preview ${write.preview} again; the page is listed with its current state.`);
    });
  } catch (error) {
    if (unwritable) return held(unwritable);
    throw error;
  }
}

/**
 * GST-2603: why the label write of `snapshot`'s page would not take its file, read now from the file's current bytes and
 * changing nothing; null when it would, or when the page has no file here (a repo-less brain, a database-only page, a file
 * this host does not own: the write decides those). `file_database_drift`: the file differs from the page (`error` is the
 * refusal the write throws); `label_edit_refused`: the file holds the page but cannot take the edit line by line. `keys` names
 * what differs or blocks (a frontmatter key, title, type, tags, body or timeline, never a stamp only the database holds); `next`
 * is the step that clears it. The managed write (page-prepare.ts prepareFileTarget, labelEditFile) and the unmanaged
 * checkout write (writeLabelFile) compare with the same rule.
 */
export interface LabelFileRefusal { reason: 'file_database_drift' | 'label_edit_refused'; keys: string[]; next: string; error: OperationError }
export async function labelFileRefusal(engine: BrainEngine, snapshot: PageSnapshot, content: string, edit: LabelEdit): Promise<LabelFileRefusal | null> {
  const { source_id: sourceId, slug } = snapshot.page;
  const drift = (keys: string[], next: string, error: OperationError): LabelFileRefusal => ({ reason: 'file_database_drift', keys, next, error });
  const read = (root: string, path: string) => { try { return readSyncFile(root, path); } catch { return null; } };
  let bytes: Buffer | null;
  if (await managedPersistenceEnabled(engine)) {
    const hostId = existingHostIdFor(engine);
    const binding = hostId ? await getWorktreeBinding(engine, sourceId, hostId) : null;
    if (!binding?.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return null;
    try {
      const target = await prepareFileTarget(engine, { source_id: sourceId, worktree_id: binding.worktree_id, slug }, snapshot, content, hostId!);
      bytes = target && target.content !== null ? read(target.root, target.path) : null;
    } catch (error) {
      if (!(error instanceof OperationError) || error.detail !== 'file_database_drift') return null;
      const local = (error as OperationError & { localEdit?: { root: string; path: string } }).localEdit;
      const text = local ? read(local.root, local.path) : null;
      const keys = local && text ? await fileSnapshotDifference(engine, slug, text.toString('utf8'), snapshot, relative(local.root, local.path).split(sep).join('/')) : [];
      return drift(keys, local ? `gbrain sources reconcile ${sourceId} ${slug} --preview` : error.suggestion ?? '', error);
    }
  } else {
    if (!(await filesInCheckout(engine, [Number(snapshot.page.id)])).has(Number(snapshot.page.id))) return null;
    const { ownerRepairFile } = await import('../trust/page-handlers.ts');
    const file = await ownerRepairFile(engine, sourceId, slug);
    if (!file.ok && file.reason === 'file_database_drift') {
      const { derivedFileTarget } = await import('../cycle/derived-write-through.ts');
      const target = await derivedFileTarget(engine, slug, sourceId);
      const text = target.ok ? read(target.target.writeRoot, target.target.filePath) : null;
      const keys = text ? await fileSnapshotDifference(engine, slug, text.toString('utf8'), snapshot, snapshot.page.source_path ?? `${slug}.md`) : [];
      return drift(keys, `gbrain sync --source ${sourceId}`, opError('source_changed', `${sourceId}:${slug} was not written: its file in the source's checkout holds an edit the database lacks.`,
        `Run gbrain sync --source ${sourceId}, then preview the repair again.`, { detail: 'file_database_drift' }));
    }
    if (!file.ok || !file.target?.expectedFileBytes) return null;
    bytes = Buffer.from(file.target.expectedFileBytes, 'utf8');
  }
  if (!bytes) return null;
  const fit = labelEditFit(slug, bytes, content, edit, snapshot);
  if (typeof fit === 'string') return null;
  const error = labelEditRefused(snapshot.page, fit.keys, edit);
  return { reason: 'label_edit_refused', keys: fit.keys, next: error.suggestion ?? '', error };
}

/**
 * One label-only page write at `revision`: the maintenance door on a managed brain (`authority`, from maintenancePreflight),
 * the import under the page lock otherwise. The revision it wrote; null when the page moved before an unmanaged import.
 * `batch` (GST-2476): the run's maintenance batch id, carried on the request so a run's writes can be counted with their Git
 * effects (repair/readers.ts readersGitCounts); the Git effect runner commits queued files together.
 */
export async function writeLabelPage(ctx: OperationContext, page: { source_id: string; slug: string }, write: { revision: string; content: string; edit: LabelEdit;
  requestId: string; embed: boolean; preview: string; batch?: string },
  authority?: MaintenanceAuthority | null): Promise<string | null> {
  const door = authority === undefined ? await maintenancePreflight(ctx.engine, page.source_id) : authority;
  if (!door) return importAtRevision(ctx.engine, page, write.revision, write.content, write.embed, write.preview);
  const options = { expectedRevision: write.revision, requestId: write.requestId, keepTrust: true as const, labelEdit: write.edit };
  if (write.batch) {
    const [settled] = await publishMaintenancePages(ctx.engine, door, [{ slug: page.slug, content: write.content, ...options }], { batch: write.batch });
    if ('error' in settled!) throw settled.error;
  } else await publishMaintenancePage(ctx.engine, door, page.slug, write.content, options);
  return (await ctx.engine.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision ?? null;
}
