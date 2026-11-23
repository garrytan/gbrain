/**
 * The take proposal queue: what the propose_takes cycle step reads and writes (src/core/cycle/propose-takes.ts, its
 * failure ledger in propose-takes-failures.ts) and what `gbrain takes propose` lists, accepts and rejects
 * (src/core/take-proposals.ts). Each statement ran through `executeRaw`; SQL once for both engines, so a store that is
 * not SQL serves the same members (rust/docs/store/takes-reads.md, "Take proposals").
 *
 * Every function takes the engine (or transaction) it runs on. Ids, weights and row numbers come back as numbers.
 */
import type { BrainEngine } from '../engine.ts';
import { guestSourceExclusionSql } from '../guests/derived.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One row of the queue, as `gbrain takes propose --json` prints it. */
export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  status: string;
  proposed_at: string | Date;
  model_id: string;
  promoted_row_num: number | null;
}

const PROPOSAL_COLUMNS =
  'id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num';

/** Driver values to the numeric row contract. */
function proposalRow(row: TakeProposalRow): TakeProposalRow {
  return {
    ...row,
    id: Number(row.id),
    weight: Number(row.weight),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
  };
}

/** Pending proposals, newest first (`proposed_at`, then id), in one source or every source; `limit` is clamped to 1..500. */
export async function listPendingTakeProposals(tx: Raw, opts: { sourceId?: string; limit: number }): Promise<TakeProposalRow[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit)));
  const scope = opts.sourceId ? sqlFragment` AND source_id = ${opts.sourceId}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(PROPOSAL_COLUMNS)}
       FROM take_proposals
      WHERE status = 'pending'${scope}
      ORDER BY proposed_at DESC, id DESC
      LIMIT ${limit}`);
  return (await tx.executeRaw<TakeProposalRow>(text, params)).map(proposalRow);
}

/** One proposal by id, whatever its status, or null; with `sourceId`, a proposal of another source reads as null. */
export async function readTakeProposal(tx: Raw, id: number, sourceId?: string): Promise<TakeProposalRow | null> {
  const scope = sourceId ? sqlFragment` AND source_id = ${sourceId}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(PROPOSAL_COLUMNS)} FROM take_proposals WHERE id = ${id}${scope}`);
  const [row] = await tx.executeRaw<TakeProposalRow>(text, params);
  return row ? proposalRow(row) : null;
}

/** An accept's claim on a proposal: its id and when it was claimed. */
export interface TakeProposalClaim { id: number; acted_at: string | Date | null }

const claimRow = (row: { id: number | string; acted_at: string | Date | null } | undefined): TakeProposalClaim | null =>
  row ? { id: Number(row.id), acted_at: row.acted_at } : null;

/** Claims a pending proposal for an accept (status `accepted`, acted now, by `actedBy`); null when it is not pending. */
export async function claimTakeProposal(tx: Raw, id: number, actedBy: string): Promise<TakeProposalClaim | null> {
  const [row] = await tx.executeRaw<{ id: number | string; acted_at: string | Date | null }>(
    `UPDATE take_proposals
        SET status = 'accepted', acted_at = now(), acted_by = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING id, acted_at`,
    [id, actedBy],
  );
  return claimRow(row);
}

/** The claim of an accepted proposal whose take is not recorded yet, or null. */
export async function readStrandedTakeProposalClaim(tx: Raw, id: number): Promise<TakeProposalClaim | null> {
  const [row] = await tx.executeRaw<{ id: number | string; acted_at: string | Date | null }>(
    `SELECT id, acted_at FROM take_proposals WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL`, [id]);
  return claimRow(row);
}

/**
 * Puts a claimed proposal back to pending, only while it is still that claim: accepted, no take recorded, and claimed
 * at `claimedAt` (an ISO time, to the millisecond; null matches a claim with no time).
 */
export async function releaseTakeProposalClaim(tx: Raw, id: number, claimedAt: string | null): Promise<void> {
  await tx.executeRaw(
    `UPDATE take_proposals
        SET status = 'pending', acted_at = NULL, acted_by = NULL, promoted_row_num = NULL
      WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL
        AND date_trunc('milliseconds', acted_at) IS NOT DISTINCT FROM $2::timestamptz`,
    [id, claimedAt],
  );
}

/** Records the take row an accepted proposal became. */
export async function setTakeProposalPromotedRow(tx: Raw, id: number, rowNum: number): Promise<void> {
  await tx.executeRaw(`UPDATE take_proposals SET promoted_row_num = $2 WHERE id = $1`, [id, rowNum]);
}

/** Rejects a pending proposal (acted now, by `actedBy`); false when it is not pending. */
export async function rejectTakeProposal(tx: Raw, id: number, actedBy: string): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: number }>(
    `UPDATE take_proposals
        SET status = 'rejected', acted_at = now(), acted_by = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [id, actedBy],
  );
  return rows.length > 0;
}

/** The propose_takes cache key of one page: a page with any row under it was extracted at this content and prompt. */
export interface TakeProposalPageKey { sourceId: string; pageSlug: string; contentHash: string; promptVersion: string }

/** Whether any proposal, tombstone included, is stored under the page key. */
export async function takeProposalCached(tx: Raw, key: TakeProposalPageKey): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: number }>(
    `SELECT id FROM take_proposals
     WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3 AND prompt_version = $4
     LIMIT 1`,
    [key.sourceId, key.pageSlug, key.contentHash, key.promptVersion],
  );
  return rows.length > 0;
}

/** The claim texts an operator rejected on a page, at any content (a tombstone is never acted on, so never listed). */
export async function listRejectedTakeProposalClaims(tx: Raw, sourceId: string, pageSlug: string): Promise<string[]> {
  const rows = await tx.executeRaw<{ claim_text: string }>(
    `SELECT claim_text FROM take_proposals
      WHERE source_id = $1 AND page_slug = $2 AND status = 'rejected' AND acted_at IS NOT NULL`,
    [sourceId, pageSlug],
  );
  return rows.map(row => row.claim_text);
}

/** A proposal to store: a pending claim, or a `rejected` tombstone that only makes the page a cache hit. */
export interface TakeProposalInsert extends TakeProposalPageKey {
  proposalRunId: string;
  claimText: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  /** The page's fence rows the extractor was told about, stored as JSON. */
  dedupAgainst: unknown[];
  modelId: string;
  status?: 'pending' | 'rejected';
}

/**
 * Stores a proposal unless the same claim is already stored under its page key (the idempotency index folds the claim
 * in): the new id, or null when it was already there.
 */
export async function insertTakeProposal(tx: Raw, p: TakeProposalInsert): Promise<number | null> {
  const rejected = p.status === 'rejected';
  const { text, params } = renderFragment(sqlFragment`INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id${trustedSql(rejected ? ', status' : '')})
     VALUES (${p.sourceId}, ${p.pageSlug}, ${p.contentHash}, ${p.promptVersion}, ${p.proposalRunId}, ${p.claimText}, ${p.kind}, ${p.holder},
       ${p.weight}, ${p.domain}, ${JSON.stringify(p.dedupAgainst)}::text::jsonb, ${p.modelId}${trustedSql(rejected ? ", 'rejected'" : '')})
     ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING
     RETURNING id`);
  const rows = await tx.executeRaw<{ id: number | string }>(text, params);
  return rows[0] ? Number(rows[0].id) : null;
}

/** A failure tombstone: a rejected row never acted on whose claim starts with the tombstone prefix. */
export interface TakeProposalTombstone { id: number; slug: string; claim_text: string; prompt_version: string; proposed_at: string }

/** A source's failure tombstones (claims starting with `prefix`), by page slug; `proposed_at` is Postgres text. */
export async function listTakeProposalTombstones(tx: Raw, sourceId: string, prefix: string): Promise<TakeProposalTombstone[]> {
  const rows = await tx.executeRaw<TakeProposalTombstone>(
    `SELECT id, page_slug AS slug, claim_text, prompt_version, proposed_at::text AS proposed_at FROM take_proposals
      WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2) ORDER BY page_slug COLLATE "C", id`,
    [sourceId, prefix]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/** Deletes a source's failure tombstones, of one page or every page: the pages released, sorted, each once. */
export async function deleteTakeProposalTombstones(tx: Raw, sourceId: string, prefix: string, slug?: string): Promise<string[]> {
  const rows = await tx.executeRaw<{ slug: string }>(
    `DELETE FROM take_proposals WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2)
        AND ($3::text IS NULL OR page_slug = $3) RETURNING page_slug AS slug`, [sourceId, prefix, slug ?? null]);
  return [...new Set(rows.map(row => row.slug))].sort();
}

/** propose_takes candidate pages, newest first. A page is never a candidate when deleted, a receipt, an atom or generated. */
export interface ProposeTakesCandidateScope {
  /** A federated scope: these sources. Beats `sourceId`. */
  sourceIds?: string[];
  sourceId?: string;
  /** Only these page types (`cycle.propose_takes.types`); null for every type. */
  types: string[] | null;
  limit: number;
}

export interface ProposeTakesPageRow { slug: string; source_id: string; compiled_truth: string | null }

/**
 * The pages propose_takes reads, with a narrow projection: live, not an extract receipt or an atom, not written by the
 * dream cycle, the atom extractor or the concept synthesizer, not in a guest source, in scope and of a listed type.
 */
export async function listProposeTakesCandidatePages(tx: Raw, scope: ProposeTakesCandidateScope): Promise<ProposeTakesPageRow[]> {
  const parts = [
    sqlFragment`deleted_at IS NULL`,
    sqlFragment`type IS DISTINCT FROM 'extract_receipt'`,
    // #5211: an atom is a fragment of a page that is itself a candidate; a legacy atom carries no writer stamp.
    sqlFragment`type IS DISTINCT FROM 'atom'`,
    // #5212: never propose takes from the dream cycle's own output.
    sqlFragment`COALESCE(frontmatter->>'dream_generated', '') <> 'true'`,
    sqlFragment`COALESCE(frontmatter->>'extracted_by', '') NOT LIKE 'extract_atoms%'`,
    sqlFragment`COALESCE(frontmatter->>'synthesized_by', '') NOT LIKE 'synthesize_concepts%'`,
    sqlFragment`${trustedSql(guestSourceExclusionSql('propose_takes', 'pages'))}`,
  ];
  if (scope.sourceIds && scope.sourceIds.length > 0) parts.push(sqlFragment`source_id = ANY(${scope.sourceIds}::text[])`);
  else if (scope.sourceId) parts.push(sqlFragment`source_id = ${scope.sourceId}`);
  if (scope.types) parts.push(sqlFragment`type = ANY(${scope.types}::text[])`);
  const { text, params } = renderFragment(sqlFragment`SELECT slug, source_id, compiled_truth
       FROM pages
      WHERE ${joinFragments(parts, ' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${scope.limit}`);
  return tx.executeRaw<ProposeTakesPageRow>(text, params);
}

/** The one JSON document an op checkpoint row holds (its `completed_keys[0]`), or null when there is no row. */
export async function readOpCheckpointDoc(tx: Raw, op: string, fingerprint: string): Promise<unknown> {
  const [row] = await tx.executeRaw<{ doc: unknown }>(
    'SELECT completed_keys->0 AS doc FROM op_checkpoints WHERE op = $1 AND fingerprint = $2', [op, fingerprint]);
  if (!row) return null;
  return typeof row.doc === 'string' ? JSON.parse(row.doc) as unknown : row.doc ?? null;
}

/** Stores one JSON document as an op checkpoint row (`completed_keys = [doc]`), replacing the row's keys. */
export async function writeOpCheckpointDoc(tx: Raw, op: string, fingerprint: string, doc: unknown): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ($1, $2, $3::text::jsonb)
    ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
    [op, fingerprint, JSON.stringify([doc])]);
}

/** Every write request admitted under `requestId`, whichever principal admitted it (the journal keys requests per principal). */
export function listWriteRequestsByRequestId(tx: Raw, requestId: string): Promise<WriteRequest[]> {
  return tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id = $1::uuid', [requestId]);
}
