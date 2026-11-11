/**
 * GST-2468: the one door for an operator repair's label-only page write (`gbrain repair private-labels`, `gbrain repair
 * visibility`). The write authors nothing, so the page keeps its stored trust tier and files no `lower_page` proposal,
 * and its canonical file changes only in the label lines (persistence/label-edit.ts):
 *   - a managed brain publishes it through the maintenance door with keep_trust and the label edit (the Git door on a
 *     repo source; a repo-less managed source writes the database only);
 *   - a brain without managed persistence imports it in a maintenance transaction under the page lock and withTrustKeep,
 *     database only (the default keyless install has no file to keep). A page there whose file sits in its source's
 *     checkout is held by the caller (`filesInCheckout`): the next sync or re-import would undo a database-only edit.
 * An ordinary put_page, local or remote, stays an agent content write (trust/channel.ts): it is never used here.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { importFromContent } from '../import-file.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { withTrustKeep } from '../persistence/context.ts';
import type { LabelEdit } from '../persistence/label-edit.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';

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
  preview: string): Promise<string | null> {
  return maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    if ((await tx.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision !== revision) return null;
    const result = await withTrustKeep(tx, ['pages'], () => importFromContent(tx, page.slug, content, { sourceId: page.source_id, noEmbed: !embed, preserveGateMarkers: true }));
    if (result.status === 'error') throw opError('invalid_params', `${page.source_id}:${page.slug} was not written: ${result.error ?? 'the import refused it'}`,
      `Preview ${preview} again; the page is listed with its current state.`);
    return (await tx.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision ?? null;
  });
}

/**
 * One label-only page write at `revision`: the maintenance door on a managed brain (`authority`, from maintenancePreflight),
 * the import under the page lock otherwise. The revision it wrote; null when the page moved before an unmanaged import.
 */
export async function writeLabelPage(ctx: OperationContext, page: { source_id: string; slug: string }, write: { revision: string; content: string; edit: LabelEdit;
  requestId: string; embed: boolean; preview: string }, authority?: MaintenanceAuthority | null): Promise<string | null> {
  const door = authority === undefined ? await maintenancePreflight(ctx.engine, page.source_id) : authority;
  if (!door) return importAtRevision(ctx.engine, page, write.revision, write.content, write.embed, write.preview);
  await publishMaintenancePage(ctx.engine, door, page.slug, write.content, { expectedRevision: write.revision, requestId: write.requestId, keepTrust: true, labelEdit: write.edit });
  return (await ctx.engine.readPageSnapshot(page.slug, { sourceId: page.source_id }))?.revision ?? null;
}
