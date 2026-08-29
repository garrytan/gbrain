// Guard self-test fixture (known-GOOD, D3 extension): the sanctioned spellings
// for JSON payloads bound into known-JSONB columns.
declare const engine: { executeRaw: <T>(sql: string, params?: unknown[]) => Promise<T[]> };
declare const existingTakes: unknown[];
declare const x: Record<string, unknown>;

// The fix: text-hop cast — binds as text, the cast parses it server-side.
export async function goodInsertTextHop(): Promise<void> {
  await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12)
     RETURNING id`,
    ['default', 'slug', 'ch', 'pv', 'run', 'claim', 'fact', 'brain', 0, null, JSON.stringify(existingTakes), 'model'],
  );
}

// Uncast bind into a jsonb column is fine when JSON.stringify feeds a
// DIFFERENT param (the jsonb column receives a raw object).
export async function goodOtherParam(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO t (note, edge_metadata) VALUES ($1, $2)`,
    [JSON.stringify(x), x],
  );
}
