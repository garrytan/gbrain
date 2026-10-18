/**
 * `gbrain repair frontmatter-keys [--source <id>]` (#6454): strip the
 * parser's reserved top-level keys (`type`, `title`, `tags`, `slug`) that
 * older imports stored inside `pages.frontmatter`. Since `comparableFrontmatter`
 * (markdown.ts) those keys are not drift and never render, so this sweep is
 * hygiene, not the fix. Explicit-only and preview-bound: the preview lists the
 * rows under a hash and `--apply --expect <hash>` sweeps exactly that set, in
 * source-scoped batches of up to 1,000 pages, each a coordinated maintenance
 * write (`withCoordinatedWrite`: a bare UPDATE is refused by the managed
 * writer guard) under the page key locks of the pages it touches. The
 * database's revision trigger advances `knowledge_revision` once per swept
 * row, so a client holding an older revision of a swept page gets one
 * `revision_conflict`; the preview says so. No journal admission, no file or
 * body change, no embedding.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

const BATCH = 1000;
const PAGE = 1000;
const SAMPLE = 20;

interface StaleRow { id: number; slug: string; keys: string[] }
interface Batch { source_id: string; selection: string[]; rows: StaleRow[] }
type BatchItem = RepairItem & { batch: Batch; hash: string; last: boolean };

export const REVISION_ADVANCE_WARNING = 'Each swept page advances its knowledge_revision once (the database revision trigger), so a client holding an '
  + 'older revision of a swept page gets one revision_conflict and re-reads; nothing else about the page changes.';

const previewCommand = (scope: RepairScope) => `gbrain repair frontmatter-keys${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;

async function staleRows(engine: BrainEngine, sourceId: string): Promise<StaleRow[]> {
  const rows: StaleRow[] = [];
  for (let afterId = 0; ;) {
    const page = await engine.listStaleFrontmatterKeyPages({ sourceId, afterId, limit: PAGE });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    afterId = page[page.length - 1].id;
  }
}

function item(batch: Batch, index: number, hash: string, last: boolean): BatchItem {
  const first = batch.rows[0], end = batch.rows[batch.rows.length - 1];
  return { cursor: { phase: 0, id: index + 1 }, source_id: batch.source_id, slug: `pages#${first.id}-${end.id}`, chars: 0, action: 'strip_reserved_frontmatter_keys',
    change: { from: `${batch.rows.length} page(s) carrying ${[...new Set(batch.rows.flatMap(row => row.keys))].sort().join(', ')}`, to: 'reserved keys removed' },
    batch, hash, last };
}

/** Rows grouped per source into batches of at most BATCH, in id order. */
function batches(scope: RepairScope, rowsBySource: Map<string, StaleRow[]>): Batch[] {
  const out: Batch[] = [];
  for (const [source_id, rows] of rowsBySource) {
    for (let start = 0; start < rows.length; start += BATCH) out.push({ source_id, selection: scope.source_ids, rows: rows.slice(start, start + BATCH) });
  }
  return out;
}

export const frontmatterKeysRepair: RepairHandler = {
  kind: 'frontmatter-keys',
  publication: 'projection',
  embeds: false,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const rowsBySource = new Map<string, StaleRow[]>();
      for (const sourceId of scope.source_ids) {
        const rows = await staleRows(engine, sourceId);
        if (rows.length) rowsBySource.set(sourceId, rows);
      }
      const planned = batches(scope, rowsBySource);
      const hash = previewHash({ kind: 'frontmatter-keys-v1', brain_id: scope.brain_id, selection: scope.source_ids,
        rows: planned.flatMap(batch => batch.rows.map(row => [batch.source_id, row.id, row.keys])) });
      if (planned.length) await saveApprovedSet<Batch>(engine, { command: 'frontmatter-keys', hash }, planned);
      const total = planned.reduce((sum, batch) => sum + batch.rows.length, 0);
      const byKey: Record<string, number> = {};
      for (const batch of planned) for (const row of batch.rows) for (const key of row.keys) byKey[key] = (byKey[key] ?? 0) + 1;
      return { items: planned.map((batch, index) => item(batch, index, hash, index === planned.length - 1)), preview_hash: hash, residuals: {},
        ...(total ? { warnings: [`${total} page(s) will have ${Object.entries(byKey).map(([key, n]) => `${key} (${n})`).join(', ')} removed from their stored frontmatter. ${REVISION_ADVANCE_WARNING}`] } : {}),
        listing: planned.map(batch => ({ item: `${batch.source_id}:pages#${batch.rows[0].id}-${batch.rows[batch.rows.length - 1].id}`, class: 'strip',
          detail: `${batch.rows.length} page(s); e.g. ${batch.rows.slice(0, 3).map(row => row.slug).join(', ')}` })),
        details: { total, by_key: byKey, sample: planned.flatMap(batch => batch.rows.map(row => ({ source_id: batch.source_id, slug: row.slug, keys: row.keys }))).slice(0, SAMPLE) } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair frontmatter-keys --apply sweeps only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`, 'docs/guides/repair.md#frontmatter-keys');
    }
    const approved = await loadApprovedSet<Batch>(engine, { command: 'frontmatter-keys', hash: opts.expect, previewCommand: command });
    if (approved.items.some(batch => JSON.stringify(batch.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map((batch, index) => item(batch, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { batch, hash, last } = entry as BatchItem;
    const stripped = await ctx.engine.transaction(async tx => {
      const managed = await readManagedMode(tx, { refusal: { subject: 'repair frontmatter-keys' } });
      const strip = async () => {
        await tx.lockPageKeys(batch.rows.map(row => ({ sourceId: batch.source_id, slug: row.slug })));
        return tx.stripStaleFrontmatterKeys({ sourceId: batch.source_id, ids: batch.rows.map(row => row.id) });
      };
      return managed ? withCoordinatedWrite(tx, [batch.source_id], strip, await maintenanceAttribution(tx)) : strip();
    });
    if (last) await clearApprovedSet(ctx.engine, { command: 'frontmatter-keys', hash });
    return stripped > 0 ? { applied: true, outcome: 'stripped', reason: `${stripped} of ${batch.rows.length} page(s)`, detail: { pages: stripped } }
      : { applied: false, outcome: 'already_clean', detail: { pages: 0 } };
  },
  render(details) {
    const sample = (details.sample ?? []) as Array<{ source_id: string; slug: string; keys: string[] }>;
    const total = Number(details.total ?? 0);
    const lines = sample.map(row => `  ${row.source_id}:${row.slug} carries ${row.keys.join(', ')}`);
    if (total > sample.length) lines.push(`  ... ${total - sample.length} more page(s) in the previewed set`);
    return lines;
  },
};
