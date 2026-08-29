// Guard self-test fixture (known-BAD, D3 extension): UNCAST positional $N
// into a known-JSONB column, fed JSON.stringify. No `::jsonb` token exists to
// grep for — Postgres resolves the param type from the target column and the
// driver double-encodes (the propose-takes dedup_against_fence_rows shape).
declare const engine: { executeRaw: <T>(sql: string, params?: unknown[]) => Promise<T[]> };
declare const existingTakes: unknown[];
declare const x: Record<string, unknown>;

// INSERT column-position mapping: $11 lands in dedup_against_fence_rows.
export async function badInsert(): Promise<void> {
  await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    ['default', 'slug', 'ch', 'pv', 'run', 'claim', 'fact', 'brain', 0, null, JSON.stringify(existingTakes), 'model'],
  );
}

// Assignment form: SET <jsonb col> = $N with no cast.
export async function badAssign(): Promise<void> {
  await engine.executeRaw(
    `UPDATE code_edges_chunk SET edge_metadata = $2 WHERE id = $1`,
    [1, JSON.stringify(x)],
  );
}
