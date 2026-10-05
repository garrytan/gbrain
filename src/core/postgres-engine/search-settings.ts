/**
 * Session settings for the Postgres search statements (#6039).
 *
 * JIT off. The search statements (keyword, keyword chunks, CJK, title,
 * vector candidates and the vector `hasMore` witness) are short interactive
 * reads, but their correlated visibility subplans inflate the planner's cost
 * estimate past `jit_above_cost` (100k by default) and, on the vector and
 * common-term statements, past the inlining and optimization thresholds
 * (500k). Postgres then compiles the statement with LLVM on every call, and
 * compilation, not execution, dominates its latency: on a 20k-page brain the
 * remote keyword statement spent 58 of 61 ms compiling and the remote vector
 * candidate statement 990 of 1,394 ms. JIT never pays back on a statement
 * that executes in milliseconds.
 *
 * `SET LOCAL` ends with a top-level transaction. Inside a caller's
 * transaction the search runs in a savepoint, and a released savepoint keeps
 * the setting, so the caller's value is restored afterwards; a failed search
 * rolls the savepoint back, which reverts it too.
 *
 * Postgres only: PGLite has no JIT provider, and its engine uses neither
 * setting.
 */
import type postgres from '#postgres';

// engine-sql-ok: jit is a Postgres server setting; PGLite has no JIT provider
export async function withSearchJitOff<T>(tx: ReturnType<typeof postgres>, nested: boolean, run: () => Promise<T>): Promise<T> {
  const previous = nested ? await tx`SELECT current_setting('jit') AS jit` : [];
  await tx`SET LOCAL jit = off`;
  const result = await run();
  if (nested) await tx`SELECT set_config('jit', ${previous[0]!.jit}, true)`;
  return result;
}

/**
 * Planner settings for the vector candidate statement (`withVectorSettings`
 * sets and restores them with the hnsw settings).
 *
 * The visibility filter's selectivity is a product of defaults (1/3 for
 * `COALESCE(chunker_version, 0) >= n`, 1/2 for each correlated
 * private-lineage CASE), so on a remote scope the planner expects about a
 * twelfth of the pages it really gets. It then joins the HNSW candidates
 * against a Materialize of every visible page under `Join Filter: p.id =
 * cc.page_id`, comparing each candidate with every page: on a 20k-page brain,
 * 250 candidates removed 5M rows and took ~0.5 s. With Materialize off it
 * looks each candidate's page up through a Memoize over `pages_pkey` in
 * under 10 ms. The local (unscoped) plan already looks pages up that way;
 * there only a two-row `sources` Materialize becomes a `sources_pkey` lookup,
 * at the same latency.
 */
export const VECTOR_CANDIDATE_PLANNER_SETTINGS: Record<string, string> = { enable_material: 'off' };
