/**
 * Leaf module (no imports) holding the normalization used on BOTH sides of the
 * provenance re-coordinate adoption match — the marker's stored `claim_norm`/
 * `source_norm` and the fence row being inserted through `engine.insertFacts`.
 *
 * Lives apart from `recoordinate.ts` so the engine-live insert path
 * (`postgres-engine/facts.ts`, `pglite-engine/facts.ts`) can import the exact
 * same normalization WITHOUT pulling in `recoordinate.ts`'s markdown /
 * write-through / page-lock dependency graph (which would risk a cycle and
 * violate the engine-live import discipline).
 *
 * Deliberately minimal — trim only. The fence renderer/parser round-trips the
 * claim/source verbatim, so anything more aggressive would let a lookalike
 * fence row adopt the wrong orphan.
 */
export function normalizeClaim(s: string): string { return s.trim(); }
export function normalizeSource(s: string | null | undefined): string { return (s ?? '').trim(); }
