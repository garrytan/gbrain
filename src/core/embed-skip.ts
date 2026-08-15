/**
 * Embed-skip predicate: the single source of truth for "should this
 * page be skipped during embedding?"
 *
 * Why a shared module (D4):
 *   gbrain has 5 sites that filter the stale-chunk / all-pages query
 *   for embedding:
 *
 *     1. src/commands/embed.ts:350 (--stale CLI path)
 *     2. src/commands/embed.ts:355 (--all CLI path) — D8 catches this
 *        too; the `--all` walk re-embeds every page from scratch and
 *        must honor the skip flag like `--stale` does.
 *     3. src/core/embed-stale.ts:90 (Minion helper)
 *     4. src/core/postgres-engine.ts (listStaleChunks/countStaleChunks)
 *     5. src/core/pglite-engine.ts equivalent
 *
 *   Inline-filtering across 5 sites is the exact bug class gbrain has
 *   been bitten by repeatedly — see CLAUDE.md `cjk.ts`, `sql-ranking.ts`,
 *   `audit-writer.ts` for sibling shared modules. Extracting the
 *   predicate here means the 5 sites all import from one place.
 *
 * Two surfaces:
 *   - JS predicate `isEmbedSkipped(frontmatter)` for callers that have
 *     in-memory page objects (CLI walk paths).
 *   - SQL fragment `EMBED_SKIP_FILTER_FRAGMENT` for callers that need
 *     to splice into a postgres-js / PGLite `sql\`...\`` template.
 *     Both engines use the standard JSONB `?` existence operator;
 *     PGLite (PostgreSQL 17.5 in WASM) supports the full JSONB
 *     operator set, so one fragment works for both.
 *
 * Frontmatter writer:
 *   - `buildEmbedSkipMarker(bytes)` produces the canonical marker
 *     object. Callers `Object.assign` it onto `parsed.frontmatter` so
 *     it persists into the page write. Stable schema means the JS
 *     predicate and the SQL existence check both target the same key
 *     name (`embed_skip`) — drift between writer and reader is the
 *     bug class we're preventing.
 *
 * Marker shape rationale:
 *   The marker is an OBJECT (not a bare bool) so the operator can see
 *   WHY the page was skipped + WHEN at a glance via `get_page`. The
 *   SQL existence check (`frontmatter ? 'embed_skip'`) hits regardless
 *   of marker contents — JSONB key-existence semantics — so future
 *   versions can extend the marker shape without invalidating the
 *   filter.
 *
 * v0.42 follow-up: promote to schema column `pages.embed_skipped_at`
 * + partial index. Single change site (this module). For v0.41 the
 * JSONB approach is acceptable because the skipped-page subset stays
 * small (operator surfaces via doctor and either splits or accepts).
 */

/** The frontmatter key name. Treat as a stable contract — renaming
 *  this means rewriting every consumer of the skip semantic. */
export const EMBED_SKIP_KEY = 'embed_skip';

/** SQL fragment that excludes pages with the embed-skip marker.
 *  Callers must already JOIN `pages` (aliased as `p`) — the bare
 *  `content_chunks` query has no access to frontmatter and needs the
 *  join added regardless.
 *
 *  Use via `sql.unsafe()` or equivalent fragment-splice:
 *
 *      const filter = EMBED_SKIP_FILTER_FRAGMENT;
 *      await sql`SELECT ... FROM content_chunks cc
 *                JOIN pages p ON p.id = cc.page_id
 *                WHERE cc.embedding IS NULL AND ${sql.unsafe(filter)}`;
 *
 *  The fragment uses the JSONB `?` existence operator: returns true
 *  when the JSONB object contains the key `'embed_skip'` at the top
 *  level. Works identically on Postgres (real) and PGLite (PostgreSQL
 *  17.5 in WASM). The `NOT` negates so we KEEP rows that DON'T have
 *  the marker. */
export const EMBED_SKIP_FILTER_FRAGMENT =
  `NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? '${EMBED_SKIP_KEY}')`;

export interface EmbedSkipMarker {
  /** Why the page was skipped. v0.41 ships only `'oversized'`; future
   *  reasons (e.g. `'chunk_token_limit'` from the deferred v0.42
   *  chunk-level quarantine) extend this enum. */
  reason: 'oversized';
  /** Body bytes at the time of assessment. Operator visibility: at a
   *  glance, see how oversized the page is. */
  bytes: number;
  /** ISO 8601 timestamp at assessment time. Tells the operator when
   *  the skip was first applied (page may have been edited later). */
  assessed_at: string;
}

/** Build the canonical marker object. Callers spread it onto the
 *  frontmatter before write:
 *
 *      parsed.frontmatter[EMBED_SKIP_KEY] = buildEmbedSkipMarker(bytes);
 *
 *  The marker is OBJECT-shaped (not bare true) so `get_page` shows
 *  the operator why + when at a glance. */
export function buildEmbedSkipMarker(bytes: number, now: Date = new Date()): EmbedSkipMarker {
  return {
    reason: 'oversized',
    bytes,
    assessed_at: now.toISOString(),
  };
}

/** JS-side predicate for in-memory page objects. Returns true when the
 *  frontmatter has the embed-skip key set to any non-null value.
 *
 *  Accepts `null`/`undefined` frontmatter (some paths construct page
 *  objects without one) and returns false — no frontmatter means no
 *  skip marker.
 *
 *  Mirrors the SQL fragment's semantics: key-existence is the trigger;
 *  marker contents are diagnostic, not functional. A future marker
 *  shape change doesn't break this predicate. */
export function isEmbedSkipped(frontmatter: Record<string, unknown> | null | undefined): boolean {
  if (!frontmatter) return false;
  const value = frontmatter[EMBED_SKIP_KEY];
  return value !== undefined && value !== null;
}

/** JS-side filter for arrays of in-memory page objects. Returns a new
 *  array with embed-skipped pages excluded. Mirrors the SQL filter
 *  for callers that walk pages JS-side (e.g. `gbrain embed --all`
 *  walks pages directly rather than going through listStaleChunks). */
export function filterOutEmbedSkipped<T extends { frontmatter?: Record<string, unknown> | null }>(
  pages: ReadonlyArray<T>,
): T[] {
  return pages.filter((p) => !isEmbedSkipped(p.frontmatter ?? null));
}
