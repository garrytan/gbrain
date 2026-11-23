/**
 * The `gbrain embed --stale` statements of BrainEngine (SQL in engine-sql/embed-stale-work.ts and
 * engine-sql/embedding-provenance.ts): the reads and writes embedding-readiness.ts, embedding-invalidation.ts,
 * embed-stale.ts and content-drift-sweep.ts ran through executeRaw. `BrainEngine` extends this interface.
 */

export interface EmbedStaleMembers {
  /** Whether every visible chunk of the page holds a vector in `column` that is current for `model` at `dims` wide (engine-sql/embedding-provenance.ts; the embedding signature stamp). */
  readPageProvenanceComplete(slug: string, sourceId: string, model: string, dims: number | null, column: string): Promise<boolean>;
}
