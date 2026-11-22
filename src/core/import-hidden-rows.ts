import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import { parseFactsFenceFor, renderFactsTable, restoreHiddenFactRows, factsGapWarning, replaceOrInsertFactsFence } from './facts-fence.ts';
import { loadFenceChunkOverlay } from './eligibility/fence-overlay.ts';
import { fenceBody } from './page-body/page-shape.ts';

/**
 * #2044 / #4548: row-level, visibility-aware fence merge for one page
 * column on the remote write-back boundary. Restores non-'world' fence
 * rows that are missing from the incoming body (a remote get_page/fetch
 * stripped them before the caller ever saw them, so their absence is not
 * an intentional delete). World-visible rows are never restored — the
 * caller saw those in full, so an edit/deletion is honored as written.
 * See restoreHiddenFactRows() in facts-fence.ts for the merge rules
 * (stable rowNums, collision renumbering, idempotence, warnings gate).
 *
 * Returns the (possibly merged) body. Emits console.warn for the two
 * surfaced conditions: a caller-authored row renumbered off a hidden
 * rowNum, and the residual malformed-fence case where the merge could not
 * run and hidden rows are genuinely dropped (factsGapWarning).
 */
function mergeHiddenFactRowsIntoBody(
  slug: string,
  incomingBody: string,
  existingBody: string | null | undefined,
  held?: ReadonlySet<number>,
  kept?: { count: number; renumbered: number },
): string {
  if (!existingBody) return incomingBody;
  const incomingFacts = parseFactsFenceFor(incomingBody, { slug });
  const existingFacts = parseFactsFenceFor(existingBody, { slug });
  const merge = restoreHiddenFactRows(incomingFacts, existingFacts, held);
  if (merge) {
    if (kept) {
      const active = merge.restored.filter(f => f.visibility !== 'world' && f.active);
      kept.count += active.length;
      kept.renumbered += merge.renumbered.filter(r => active.some(f => f.rowNum === r.from)).length;
    }
    if (merge.renumbered.length > 0) {
      console.warn(
        `[gbrain] #2044 merge on ${slug}: ${merge.renumbered.length} incoming fact row(s) reused ` +
        `row number(s) belonging to privacy-hidden row(s) and were renumbered ` +
        `(${merge.renumbered.map((r) => `#${r.from}->#${r.to}`).join(', ')}); ` +
        `the hidden row(s) keep their original numbers.`,
      );
    }
    // Shared #4756 placement rule (the column is already split at the
    // sentinel here, so this is dedup, not a behaviour change for the importer).
    return replaceOrInsertFactsFence(incomingBody, renderFactsTable(merge.merged));
  }
  const gapWarning = factsGapWarning(slug, incomingFacts, existingFacts, false);
  if (gapWarning) console.warn(gapWarning);
  return incomingBody;
}

/**
 * The remote write-back merge of both page columns against the stored page (mergeHiddenFactRowsIntoBody), in place. With
 * `restoreHeld` (GST-2891: the writer's fact reads were world-only) the world rows held from it are restored too.
 * Returns the private rows kept as stored (left out or reworded) and the reworded rows renumbered beside them (GST-3064).
 */
export async function mergeHiddenFactRows(engine: BrainEngine, slug: string, parsed: { compiled_truth: string; timeline: string }, existing: Page,
  restoreHeld?: boolean): Promise<{ count: number; renumbered: number }> {
  const kept = { count: 0, renumbered: 0 };
  const stored = fenceBody(existing);
  const held = restoreHeld ? (await loadFenceChunkOverlay(engine, { sourceId: existing.source_id, slug, ...stored }, { hideHeld: true }))?.held : undefined;
  for (const column of ['compiled_truth', 'timeline'] as const) parsed[column] = mergeHiddenFactRowsIntoBody(slug, parsed[column], stored[column], held, kept);
  return kept;
}
