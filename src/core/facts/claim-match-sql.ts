/**
 * The claim-match SQL fragment the fact purge shares: facts/purge.ts, its
 * verifier facts/purge-verify.ts (which re-exports it), facts/fence-fact-append.ts
 * and the engine-sql purge members. It is a leaf module with no imports, so
 * engine-sql/facts-purge.ts can use it without reaching purge-verify.ts's import
 * closure, which loads the tree-sitter WASM asset
 * (test/openclaw-compact-node-loadable.test.ts).
 */

/**
 * A page or page-version row (alias `a`) still states the claim: in its body,
 * timeline, title or frontmatter. `$n` is the lowercased claim, `$n+1` its
 * JSON-escaped form (frontmatter is matched as JSON text).
 */
export const carriesClaimSql = (a: string, n: number) => `(strpos(lower(${a}.compiled_truth),$${n})>0 OR strpos(lower(COALESCE(${a}.timeline,'')),$${n})>0
  OR strpos(lower(COALESCE(${a}.title,'')),$${n})>0 OR strpos(lower(COALESCE(${a}.frontmatter::text,'')),$${n + 1})>0)`;
