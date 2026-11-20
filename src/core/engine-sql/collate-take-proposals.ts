/**
 * The failure tombstones of `take_proposals` that the propose_takes phase wrote and listed through `engine.executeRaw`
 * (src/core/cycle/propose-takes-failures.ts), now typed members so a Rust brain answers them from its store
 * (rust/docs/store/collate-take-proposals.md). The statements are the ones the phase ran, except that the insert now
 * returns the id it inserted so the caller knows whether it did.
 */

/** The engine's `executeRaw` (bound). */
export type TakeProposalsRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** What a failure tombstone names; its kind, holder, weight, domain and status are fixed (`fact`, `brain`, 0, none, `rejected`). */
export interface FailureTombstoneInput {
  sourceId: string; slug: string; contentHash: string; promptVersion: string; proposalRunId: string; claimText: string; modelId: string;
}

/** One tombstone as listed; `proposed_at` is the column's `::text` form. */
export interface FailureTombstoneRow { page_slug: string; claim_text: string; prompt_version: string; proposed_at: string }

/** The phase's tombstone insert: a claim already recorded for the page, content hash and prompt version is left alone. */
export const RECORD_FAILURE_TOMBSTONE_SQL = `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'fact', 'brain', 0, NULL, '[]'::jsonb, $7, 'rejected')
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING RETURNING id`;

/** Inserts the `rejected` tombstone row; true when it inserted, false when the claim was already recorded. */
export async function recordFailureTombstone(raw: TakeProposalsRaw, p: FailureTombstoneInput): Promise<boolean> {
  const rows = await raw(RECORD_FAILURE_TOMBSTONE_SQL, [p.sourceId, p.slug, p.contentHash, p.promptVersion, p.proposalRunId, p.claimText, p.modelId]);
  return rows.length > 0;
}

/** The statement `listFailedProposals` ran: the source's unacted `rejected` proposals whose claim text starts with the prefix, by slug bytes. */
export const LIST_FAILURE_TOMBSTONES_SQL = `SELECT page_slug AS slug, claim_text, prompt_version, proposed_at::text AS proposed_at FROM take_proposals
      WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2) ORDER BY page_slug COLLATE "C"`;

/** The source's failure tombstones, by page slug bytes. */
export async function listFailureTombstones(raw: TakeProposalsRaw, sourceId: string, claimPrefix: string): Promise<FailureTombstoneRow[]> {
  const rows = await raw<{ slug: string; claim_text: string; prompt_version: string; proposed_at: string }>(LIST_FAILURE_TOMBSTONES_SQL, [sourceId, claimPrefix]);
  return rows.map(r => ({ page_slug: r.slug, claim_text: r.claim_text, prompt_version: r.prompt_version, proposed_at: r.proposed_at }));
}
