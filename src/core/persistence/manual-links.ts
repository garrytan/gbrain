import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { wholeBodySnapshot } from './segmented-apply.ts';
import { pageIdentityError } from './page-identity.ts';
import { preparePageMutation } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { LINKS_FENCE_ORIGIN_FIELD, LinksFenceRewriteRefusal, MANAGED_LINK_SOURCES, linksFenceSection, removeLinksFenceRows,
  upsertLinksFenceRow } from '../links-fence.ts';
import { linksFenceProjectionRows, projectLinksFence } from '../links-fence-projection.ts';
import { removeManualTransitions } from '../link-temporal-apply.ts';
import { writeManualTransitions } from '../link-temporal-apply.ts';
import type { OperationContext } from '../ops/contract.ts';
import { assertExplicitSourceLive, assertSourceInCallerWriteScope, federatedSearchScope, parseSourceIdParam, readPolicyOpts, requireWritablePage } from '../ops/context.ts';
import { coordinatedDatabaseWrite } from './database-write.ts';
import { maintenanceTransaction } from './attribution.ts';

/** Qualified references are database-only: a same-source links fence cannot represent their identity. */
export async function sourceQualifiedManualLink(ctx: OperationContext, operation: 'add_link' | 'remove_link',
  p: Record<string, unknown>, linkType = '', dates?: { validFrom?: string; validUntil?: string } | null): Promise<Record<string, unknown>> {
  const qualified = String(p.to);
  const colon = qualified.indexOf(':');
  const targetSource = parseSourceIdParam(qualified.slice(0, colon), operation)!;
  const to = qualified.slice(colon + 1);
  if (!targetSource || !to || to.includes(':')) throw opError('invalid_params', 'Expected to as source-id:slug.', 'Supply one source ID and one page slug.');
  const scope = federatedSearchScope(ctx, targetSource);
  await assertExplicitSourceLive(ctx, targetSource);
  const policy = await readPolicyOpts(ctx, scope);
  const from = String(p.from);
  const sourceId = ctx.sourceId ?? 'default';
  assertSourceInCallerWriteScope(ctx, sourceId);
  await requireWritablePage(ctx, from, operation, 'from');
  const target = await ctx.engine.getPage(to, policy);
  if (!target) throw opError('page_not_found', 'The link target is not readable.', 'Select an existing target in a readable source.');
  const keys = [{ sourceId, slug: from }, { sourceId: targetSource, slug: to }];
  const sources = [...new Set(keys.map(key => key.sourceId))].sort();
  const observedSources = await ctx.engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation FROM sources WHERE id=ANY($1::text[]) AND NOT archived ORDER BY id', [sources]);
  const snapshots = await Promise.all(keys.map(key => ctx.engine.readPageSnapshot(key.slug, { sourceId: key.sourceId })));
  if (observedSources.length !== sources.length || snapshots.some(snapshot => !snapshot)) {
    throw opError('source_changed', 'A link endpoint changed.', 'Read both endpoints again before retrying.');
  }
  const provenance = ((p.link_source as string) || 'manual').trim();
  if (MANAGED_LINK_SOURCES.includes(provenance)) throw opError('invalid_params', 'This provenance is reconciliation-managed.', 'Use manual or a custom provenance.');
  if (ctx.dryRun) return { dry_run: true, action: operation, from: p.from, to: p.to };
  const write = async (tx: BrainEngine) => {
    const currentSources = await tx.executeRaw<{ id: string; incarnation: string }>(
      'SELECT id, incarnation FROM sources WHERE id=ANY($1::text[]) AND NOT archived ORDER BY id FOR SHARE', [sources]);
    if (currentSources.length !== observedSources.length || currentSources.some((source, i) => source.id !== observedSources[i].id || source.incarnation !== observedSources[i].incarnation)) {
      throw opError('source_changed', 'A link source changed before commit.', 'Read both endpoints again before retrying.');
    }
    await tx.lockPageKeys([...keys].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.slug.localeCompare(b.slug)));
    // Hold endpoint rows as well as publication keys: legacy writers also take row locks.
    await tx.executeRaw('SELECT id FROM pages WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE', [snapshots.map(snapshot => snapshot!.page.id)]);
    for (let i = 0; i < keys.length; i++) {
      const current = await tx.readPageSnapshot(keys[i].slug, { sourceId: keys[i].sourceId });
      if (!current || current.page.id !== snapshots[i]!.page.id || current.revision !== snapshots[i]!.revision) {
        throw opError('revision_conflict', 'A link endpoint changed before commit.', 'Read both endpoints again before retrying.');
      }
    }
    if (!await tx.getPage(to, policy)) throw opError('page_not_found', 'The link target is no longer readable.', 'Select a readable target.');
    const opts = { fromSourceId: sourceId, toSourceId: targetSource, originSourceId: sourceId };
    const rel = { from, to, sourceId, toSourceId: targetSource, linkType };
    if (operation === 'add_link') {
      await tx.addLink(from, to, String(p.context ?? ''), linkType, provenance, undefined, undefined, opts); // gbrain-allow-direct-insert: explicit source-qualified manual edge
      if (dates) await writeManualTransitions(tx, rel, dates);
      return { status: 'ok' };
    }
    const removed = await tx.removeLink(from, to, optional(p.link_type), optional(p.link_source), opts);
    if (removed && (!p.link_source || p.link_source === 'manual')) await removeManualTransitions(tx, { ...rel, linkType: optional(p.link_type) });
    return { status: 'ok', removed };
  };
  const coordinated = await coordinatedDatabaseWrite(ctx, operation, from, [from], write, undefined, [keys[1]]);
  return coordinated ? coordinated.value : maintenanceTransaction(ctx.engine, write);
}

const optional = (value: unknown) => typeof value === 'string' && value ? value : undefined;

/** Edges from $1 to the page $3 of source $2, optionally of one type ($5) and provenance ($6). */
const RELATIONSHIP = `l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6)`;
/** A database-only edge: not projected from a links fence, and of a provenance no reconciliation producer owns ($4). */
const DATABASE_ONLY = `l.origin_field IS DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AND l.link_source <> ALL($4::text[])`;
const FENCED = `l.origin_field='${LINKS_FENCE_ORIGIN_FIELD}' AND l.origin_page_id=$1`;

/**
 * `add_link` / `remove_link` on a managed brain (G5): the authored edge lives in the from page's links fence
 * (links-fence.ts), written through the page-mutation door like add_timeline_entry. The preparer upserts or
 * removes the fence row at the snapshot's revision (a segmented page is read back whole) and publishes the page.
 * The publication projects the fence (canonical-projections.ts) and the apply projects it once more, so a fence
 * the write left unchanged (an idempotent add) still has its edges. `add_link` drops the database-only twin of
 * the edge it fences (same endpoints, type and provenance, no origin). `remove_link` also deletes the matching
 * database-only edges written before the fence existed, with their manual dated statements, so a removal only
 * moves the database toward git; edges a reconciliation producer derives from the page text stay, and the result
 * names them (`derived_from_text`, with `derived_message` saying to edit the page text instead).
 */
export async function prepareManualLinkMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const stored = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!stored || stored.page.id !== row.page_id) throw pageIdentityError(stored != null, 'The accepted page was replaced by another page.');
  const p = row.intent!;
  const snapshot = (await wholeBodySnapshot(engine, stored, row.operation))!;
  const section = linksFenceSection(snapshot.page);
  const to = String(p.to).toLowerCase();
  const linkType = optional(p.link_type), linkSource = optional(p.link_source);
  const validFrom = optional(p.valid_from), validUntil = optional(p.valid_until);
  let body: string;
  try {
    body = row.operation === 'add_link'
      ? upsertLinksFenceRow(snapshot.page[section] ?? '', { to, type: linkType ?? '', source: linkSource ?? 'manual', context: String(p.context ?? ''),
        ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}) }).body
      : removeLinksFenceRows(snapshot.page[section] ?? '', { to, type: linkType, source: linkSource }).body;
  } catch (error) {
    if (!(error instanceof LinksFenceRewriteRefusal)) throw error;
    throw opError('invalid_params', error.message,
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} changed nothing. Fix the page's ## Links table with edit_page (one row per to, type and source; dates YYYY-MM-DD), then submit ${row.operation} again.`);
  }
  const page = { ...snapshot.page, [section]: body };
  const fence = await linksFenceProjectionRows(engine, row.source_id, page);
  const prepared = await preparePageMutation(engine, row, config, {
    expectedRevision: snapshot.revision, content: serializePageToMarkdown(page, snapshot.tags),
  }, undefined, { boundedChunkWrites: true });
  const origin = { id: stored.page.id, source_id: row.source_id };
  const pageId = Number(stored.page.id);
  if (row.operation === 'add_link') {
    return { ...prepared, apply: async tx => {
      const outcome = await prepared.apply(tx);
      await tx.executeRaw(`DELETE FROM links l USING pages t WHERE ${RELATIONSHIP} AND ${DATABASE_ONLY} AND l.origin_page_id IS NULL`,
        [pageId, row.source_id, to, MANAGED_LINK_SOURCES, linkType ?? '', linkSource ?? 'manual']);
      if (fence) await projectLinksFence(tx, origin, fence);
      return { ...outcome, status: 'ok' };
    } };
  }
  const params = [pageId, row.source_id, to, MANAGED_LINK_SOURCES, linkType ?? null, linkSource ?? null];
  return { ...prepared, apply: async tx => {
    const count = async () => Number((await tx.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM links l, pages t WHERE ${RELATIONSHIP} AND ((${DATABASE_ONLY}) OR (${FENCED}))`, params))[0]?.n ?? 0);
    const before = await count();
    // A page whose body dropped its whole fence keeps the fence's edges (an absent fence retires nothing), so
    // removing the relationship removes those orphans too: no row in git backs them.
    const dropped = await tx.executeRaw(`DELETE FROM links l USING pages t WHERE ${RELATIONSHIP}
      AND ((${DATABASE_ONLY}) OR ($7::boolean AND ${FENCED})) RETURNING l.id`, [...params, fence === null]);
    if (dropped.length && (!linkSource || linkSource === 'manual')) await removeManualTransitions(tx, { from: row.slug, to, linkType, sourceId: row.source_id });
    const outcome = await prepared.apply(tx);
    if (fence) await projectLinksFence(tx, origin, fence);
    const derived = await tx.executeRaw<{ link_type: string; link_source: string }>(`SELECT DISTINCT l.link_type, l.link_source FROM links l, pages t
      WHERE ${RELATIONSHIP} AND l.link_source = ANY($4::text[]) ORDER BY l.link_type, l.link_source`, params);
    return { ...outcome, status: 'ok', removed: before - await count(), ...(derived.length ? { derived_from_text: derived,
      derived_message: `${derived.length === 1 ? 'An edge' : `${derived.length} edges`} from ${row.slug} to ${to} ${derived.length === 1 ? 'comes' : 'come'} from the page text (links, wikilinks or frontmatter), so remove_link kept ${derived.length === 1 ? 'it' : 'them'}. Edit the text of ${row.slug} (edit_page) to remove ${derived.length === 1 ? 'it' : 'them'}.` } : {}) };
  } };
}
