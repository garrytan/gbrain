/**
 * Put one fact into an entity page's `## Facts` fence through the door (GBRA-190 G4).
 *
 * `prepareFenceFactAppend` prepares, inside a coordinator preparer, the page write and the facts row of one fact on
 * the request's page (`row.slug`). Git is the parent: the coordinator publishes the file before its publication
 * transaction opens, and `apply` (which runs in that transaction) writes the page row first and the facts row second,
 * so a facts row never exists for a fence row the file does not hold. The page write is prepared unprojected (the
 * helper writes the one facts row itself), whatever the request's operation, as remember's always was.
 *
 * Modes:
 * - `append` (default): renders the fact as a new fence row with `fenceRowOf` (the one renderer) at the next row
 *   number past both the fence and every facts row indexed from the page (a row the fence lost still owns its number,
 *   #6696 C9), optionally strikes the superseded row of the same page, and prepares the page write. The stored fence is
 *   normalized first (#6188); a fence that does not parse cleanly refuses typed (`target_fence_malformed`, #6385 R12).
 * - `index-existing`: the file already holds the row (a fence-guard hold names it by `payload.row_num`). The cell at
 *   that row number must read back as the fact (`fenceCellReadBackProblem`), else it refuses `fence_row_changed` and
 *   nothing is written. No file changes: the facts row derives from the cell (`extractFactsFromFenceText`, the row a
 *   re-import projects, so the reconciler keeps it) with the caller's embedding and session. The caller's
 *   PreparedMutation carries `snapshot.revision` as its observedRevision: the coordinator re-checks it under the page
 *   lock, so the cell read here is the cell at publication.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Action } from '../agent-output.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { factsFenceSection, fenceCellReadBackProblem, formatFenceDate, parseFactsFence, strikeFactRowInPage, upsertFactRow } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { pageBodyOverCeilingError } from '../page-body/page-shape.ts';
import { materializedPage, segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { normalizeTargetFences } from '../fence-repair/import-step.ts';
import { refuseUnparsedRewrite } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { withPendingFenceRows } from '../eligibility/fence-overlay.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import type { TrustTier } from '../trust/tier.ts';
import { extractFactsFromFenceText } from './extract-from-fence.ts';
import { fenceRowOf, type FenceRowInput } from './unfenced-facts.ts';

export type FenceFactAppendInput = {
  /** The facts row to publish; `row_num` and `source_markdown_slug` are the helper's. kind and visibility default as insertFacts does. */
  fact: NewFact & { valid_from: Date };
  /** The tier the new row's chunks are cut at until its facts row exists (`withPendingFenceRows`); append only. */
  pendingTier: TrustTier;
} & (
  | { mode?: 'append'; supersede?: { rowNum: number; validUntil: Date | null } }
  | { mode: 'index-existing'; rowNum: number }
);

export interface FenceFactAppend {
  /** The page write callers compose into their PreparedMutation (file, exclusiveSources, validate); null in index-existing. */
  prepared: PreparedMutation | null;
  /** The fence row the fact is indexed from. */
  rowNum: number;
  /** `{ fences_normalized }` for the receipt when this write normalized the stored fence; empty otherwise. */
  fencesNormalized: Record<string, unknown>;
  /** In the publication transaction: the page write (its tier kept, #5575 ENG-1), then the facts row at `rowNum`. */
  apply(tx: BrainEngine): Promise<{ id: number; pageReceipt?: Record<string, unknown> }>;
}

/** Read-only fix naming a request's durable receipt (local CLI) or its source's writer status (remote). */
export function requestReceiptFix(row: WriteRequest): Action {
  return row.principal_kind === 'local_cli'
    ? readFix(`Reads request ${row.request_id}'s durable receipt: its state and outcome, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
    : readFix(`Shows source ${row.source_id}'s writer and requests in flight, including ${row.request_id}, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] });
}

export async function prepareFenceFactAppend(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, snapshot: PageSnapshot,
  input: FenceFactAppendInput, signal?: AbortSignal): Promise<FenceFactAppend> {
  const { fact } = input;
  const page = { sourceId: row.source_id, slug: row.slug };
  // Wave B: a segmented page is read back whole up to the single-string ceiling.
  if (segmentedOverCeiling(snapshot.page)) throw pageBodyOverCeilingError(snapshot.page, `${row.operation} facts fence write`);
  const base = await materializedPage(engine, snapshot.page);
  const insert = async (tx: BrainEngine, rowNum: number, indexed: NewFact) => {
    const inserted = await tx.insertFacts([{ ...indexed, row_num: rowNum, source_markdown_slug: row.slug }], { source_id: row.source_id }); // gbrain-allow-direct-insert: coordinator publication of a fence row this request's page file holds, after the file
    if (inserted.ids.length === 1) return inserted.ids[0];
    const [occupant] = await tx.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3', [row.source_id, row.slug, rowNum]);
    throw opError('storage_error', 'The new canonical fact row was not indexed.',
      `The fact row for request ${row.request_id} in source ${row.source_id} was not indexed, so its transaction rolled back.`
      + (occupant ? ` Row ${rowNum} of ${row.slug} is already held by fact ${occupant.id}.` : '')
      + ' Inspect the request before submitting it again; if it repeats, run gbrain doctor --json and report it to the user.',
      { fix: requestReceiptFix(row) });
  };

  if (input.mode === 'index-existing') {
    const { rowNum } = input;
    const cell = [base.compiled_truth, base.timeline ?? ''].flatMap(text => parseFactsFence(text).facts).find(f => f.rowNum === rowNum);
    const problem = fenceCellReadBackProblem(cell, { fact: fact.fact, visibility: fact.visibility ?? 'private' });
    if (problem || !cell) {
      const reason = problem ?? 'row_missing';
      throw opError('fence_row_changed', `Fence row ${rowNum} of ${row.slug} no longer reads back as the fact (${reason}).`,
        `Request ${row.request_id} indexes facts row ${rowNum} of ${row.slug} in source ${row.source_id}, but that fence row is now ${reason}, so nothing was written.`
        + ' Read the page to see the row as it stands; if the fact is still wanted, remember it again.',
        { reason, detail: JSON.stringify({ slug: row.slug, row_num: rowNum, problem: reason }),
          fix: readFix(`Reads ${row.slug} with its current facts fence, read-only.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
    }
    const [{ superseded_by_row: _superseded, ...derived }] = extractFactsFromFenceText([cell], row.slug, row.source_id);
    const indexed: NewFact = { ...derived, embedding: fact.embedding ?? null, embedding_model: fact.embedding_model ?? null, source_session: fact.source_session ?? null };
    return { prepared: null, rowNum, fencesNormalized: {}, apply: async tx => ({ id: await insert(tx, rowNum, indexed) }) };
  }

  // #6188 (D20): the stored fence is normalized in this same write; a residual refuses typed `target_fence_malformed`.
  const target = await normalizeTargetFences(engine, { sourceId: row.source_id, slug: row.slug, kind: 'facts', page: base });
  const fencesNormalized = target.fixes.length ? { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: target.fixes,
    writer: row.principal_kind, path: snapshot.page.source_path ?? null, remote: row.authority.remote }) } : {};
  // #6696 C9: a facts row the fence does not hold (extraction, a hand edit) still owns its row_num, so the new row numbers past both.
  const [indexedMax] = await engine.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
  // #6686: the fence is edited in the section it lives in (a lone timeline fence stays below the sentinel); the other section is kept byte for byte.
  const section = factsFenceSection(target.page);
  const fenced = { compiled_truth: target.page.compiled_truth, timeline: target.page.timeline ?? '' };
  const rowNum = Math.max(indexedMax?.n ?? 0, ...[fenced.compiled_truth, fenced.timeline].flatMap(text => parseFactsFence(text).facts.map(f => f.rowNum))) + 1;
  const cell = fenceRowOf({ kind: (fact.kind ?? 'fact') as FenceRowInput['kind'], visibility: fact.visibility ?? 'private', context: fact.context ?? null, valid_from: fact.valid_from,
    valid_until: fact.valid_until ?? null, source: fact.source, claim_metric: fact.claim_metric ?? null, claim_value: fact.claim_value ?? null,
    claim_unit: fact.claim_unit ?? null, claim_period: fact.claim_period ?? null, attributed_to: fact.attributed_to ?? null,
    notability: fact.notability ?? null, confidence: fact.confidence ?? null }, rowNum, fact.fact);
  // #6385 R12: an entity fence that does not parse cleanly refuses typed instead of losing the rows it skipped.
  const appended = refuseUnparsedRewrite(target.page, row.slug, row.source_id, () => upsertFactRow(fenced[section], cell));
  let next = { ...fenced, [section]: appended.body };
  if (input.supersede) next = strikeFactRowInPage(next, input.supersede.rowNum, rowNum, input.supersede.validUntil ? formatFenceDate(input.supersede.validUntil) : undefined);
  const content = serializePageToMarkdown({ ...base, ...next }, snapshot.tags);
  // The canonical parser/chunker and durable filesystem publication; the CAS binds this render to the snapshot.
  // #5575 ENG-1: the new row has no facts row yet; its chunks are cut at the append's tier.
  const prepared = await withPendingFenceRows({ ...page, rowNums: [rowNum], tier: input.pendingTier },
    () => preparePageMutation(engine, { ...row, intent: { ...row.intent, content, expected_revision: snapshot.revision, force: false } }, config, undefined, signal, { unprojected: true }));
  if (prepared.observedRevision !== snapshot.revision) {
    throw opError('revision_conflict', 'The entity page changed during preparation.',
      `Another write changed ${row.slug} in source ${row.source_id} while request ${row.request_id} was prepared, so it did not save. Check that request's receipt; once it shows conflict, nothing was saved and submitting it again is safe.`,
      { fix: requestReceiptFix(row) });
  }
  return { prepared, rowNum, fencesNormalized, apply: async tx => {
    const pageReceipt = await withPageTierKept(tx, page, () => prepared.apply(tx));
    return { id: await insert(tx, rowNum, fact), pageReceipt };
  } };
}
