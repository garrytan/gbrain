/**
 * Chunk reads: the code-symbol lookups of code-def, code-refs and the recursive code walk, the code-graph readiness
 * probes, three doctor chunk counts, withdrawal's chunk scan and chunk delete, the contextual-mode repair plan and
 * evidence delivery's frozen-hit resolution, which ran through `engine.executeRaw`, once for both engines.
 *
 * Every statement here ran on master from the caller named on its function. They keep master's predicates and run on
 * master's raw path (`exec.executeRaw`) unscoped, as before. A statement with a scope or a value is built with
 * `sqlFragment`, so each value is a bound parameter (the definition-type list binds as `= ANY(...)` instead of an
 * inlined `IN` list). The one change in meaning is an `ORDER BY` on `listQualifiedSymbolNames`, whose master text had
 * none (its rows came back in plan order). A caller that swallowed a database error still does; a refused capability
 * is never swallowed (engine-capability-refusal.ts).
 */
import { DEF_TYPES } from '../chunkers/def-types.ts';
import type { CodeReadScope } from '../code-intel/read-scope.ts';
import { SAFE_FENCE_CHUNKER_VERSION, chunkGenerationFilter, requiresSafeChunks, safeChunksFilter, servedTextProjectionFilter } from '../search/safe-chunks.ts';
import type { PageReadScope } from '../types.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { readFilter, rows } from './search-reads.ts';

/** The code-symbol lookup options of code-def and code-refs: a language, a row limit and the code read scope. */
export type CodeSymbolQuery = { limit?: number; language?: string } & CodeReadScope;

export interface CodeDefinitionRow {
  slug: string; source_id: string; file: string | null; language: string | null;
  symbol_type: string | null; start_line: number | null; end_line: number | null; chunk_text: string;
}

export interface CodeRefChunkRow extends CodeDefinitionRow { symbol_name: string | null }

/** The definition types code-def reads: `DEF_TYPES` plus `export statement`. */
const DEFINITION_TYPES = [...DEF_TYPES, 'export statement'];

/** `codeReadFilter(params, scope)` (code-intel/read-scope.ts) as a fragment: the source clause is bound. */
function codeFilter(scope: CodeReadScope): SqlFragment {
  const policy = scope.allSources && scope.sourceIds === undefined ? { ...scope, sourceId: undefined } : scope;
  const none = trustedSql(scope.sourceIds?.length === 0 ? 'FALSE' : 'TRUE');
  const safe = requiresSafeChunks(scope) ? sqlFragment` AND ${trustedSql(safeChunksFilter('p'))}` : sqlFragment``;
  return sqlFragment`${readFilter('p', policy, true)} AND ${none} AND ${trustedSql(servedTextProjectionFilter('p'))}${safe}`;
}

/** `cc.language` when one is named, plus the code read filter (code-def / code-refs). */
function symbolFilters(opts: CodeSymbolQuery): SqlFragment {
  const lang = opts.language ? sqlFragment`AND cc.language = ${opts.language}` : sqlFragment``;
  return sqlFragment`${lang}
       AND ${codeFilter(opts)}`;
}

/**
 * Definition chunks named `symbol` on code pages in scope: definition types first (function, class, interface,
 * type, enum, struct, then the rest), then slug, start line and source, at most `limit` (default 20) (code-def).
 */
export async function findCodeDefinitions(exec: LegacyUnscopedRead, symbol: string, opts: CodeSymbolQuery = {}): Promise<CodeDefinitionRow[]> {
  const limit = opts.limit ?? 20;
  return rows<CodeDefinitionRow>(exec,
    // chunk-visibility-ok: master's code-def lookup, every stored row of a served code page (codeReadFilter)
    sqlFragment`SELECT p.slug, p.source_id, (p.frontmatter->>'file') AS file, cc.language, cc.symbol_type,
            cc.start_line, cc.end_line, cc.chunk_text
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE cc.symbol_name = ${symbol}
       ${symbolFilters(opts)}
       AND p.page_kind = 'code'
       AND cc.symbol_type = ANY(${DEFINITION_TYPES}::text[])
     ORDER BY
       CASE cc.symbol_type
         WHEN 'function' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
         WHEN 'type' THEN 4 WHEN 'enum' THEN 5 WHEN 'struct' THEN 6
         ELSE 7
       END,
       p.slug COLLATE "C", cc.start_line, p.source_id COLLATE "C", cc.id
     LIMIT ${limit}`,
  );
}

/** The distinct `symbol_type`s (NULL included, NULL last) of chunks named `symbol` on code pages in scope, at most 20 (code-def's #3789 probe). */
export async function listSymbolTypesForName(exec: LegacyUnscopedRead, symbol: string, opts: Omit<CodeSymbolQuery, 'limit'> = {}): Promise<Array<string | null>> {
  const found = await rows<{ symbol_type: string | null }>(exec,
    // chunk-visibility-ok: master's code-def probe, every stored row of a served code page (codeReadFilter)
    sqlFragment`SELECT DISTINCT cc.symbol_type COLLATE "C"
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE cc.symbol_name = ${symbol}
       ${symbolFilters(opts)}
       AND p.page_kind = 'code'
     ORDER BY cc.symbol_type COLLATE "C"
     LIMIT 20`,
  );
  return found.map(r => r.symbol_type);
}

/** Code-page chunks whose text contains `symbol` (ILIKE, unescaped), by slug, start line and source, at most `limit` (default 50) (code-refs). */
export async function findCodeRefChunks(exec: LegacyUnscopedRead, symbol: string, opts: CodeSymbolQuery = {}): Promise<CodeRefChunkRow[]> {
  const limit = opts.limit ?? 50;
  return rows<CodeRefChunkRow>(exec,
    // chunk-visibility-ok: master's code-refs scan, every stored row of a served code page (codeReadFilter)
    sqlFragment`SELECT p.slug, p.source_id, (p.frontmatter->>'file') AS file, cc.language,
            cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
            cc.chunk_text
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE p.page_kind = 'code'
       AND cc.chunk_text ILIKE ${`%${symbol}%`}
       ${symbolFilters(opts)}
     ORDER BY p.slug COLLATE "C", cc.start_line NULLS LAST, p.source_id COLLATE "C", cc.id
     LIMIT ${limit}`,
  );
}

/**
 * Live pages an older gbrain marked `embed_skip.reason: oversized` whose body now fits in `maxBytes`, and how many of
 * them have no chunk row at all (doctor oversized_pages).
 */
export async function countOversizedEmbedSkips(exec: LegacyUnscopedRead, maxBytes: number): Promise<{ marked: number; chunkless: number }> {
  // chunk-visibility-ok: counts pages with no chunk row at all (any generation), the chunk safety net's own test
  const [row] = await rows<{ n: number; chunkless: number }>(exec, sqlFragment`SELECT COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id))::int AS chunkless FROM pages p
       WHERE p.deleted_at IS NULL AND p.frontmatter->'embed_skip'->>'reason' = 'oversized'
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) <= ${maxBytes}`);
  return { marked: Number(row?.n ?? 0), chunkless: Number(row?.chunkless ?? 0) };
}

/** Chunk rows whose page no longer exists (doctor child_table_orphans, the content_chunks target). */
export async function countOrphanChunks(exec: LegacyUnscopedRead): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(
    // chunk-visibility-ok: counts rows of any generation whose page is gone, the orphan check's own test
    'SELECT COUNT(*)::int AS n FROM content_chunks WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id)',
  );
  return Number(row?.n ?? 0);
}

/** Chunks of live `type: code` pages with neither `symbol_name` nor `language`, and their pages (doctor code_chunk_metadata). */
export async function countCodeChunkPages(exec: LegacyUnscopedRead): Promise<{ chunks: number; pages: number }> {
  const [row] = await exec.executeRaw<{ chunks: string | number; pages: string | number }>(
    // chunk-visibility-ok: counts every stored chunk row of a code page, the metadata check's own test
    `SELECT COUNT(*)::text AS chunks, COUNT(DISTINCT c.page_id)::text AS pages
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.type = 'code' AND p.deleted_at IS NULL
          AND c.symbol_name IS NULL AND c.language IS NULL`,
  );
  return { chunks: Number(row?.chunks ?? 0), pages: Number(row?.pages ?? 0) };
}

function existsResult(rows: Array<{ e: unknown }>): boolean {
  if (typeof rows[0]?.e !== 'boolean') throw new Error('Invalid code readiness result');
  return rows[0].e;
}

/** Whether any chunk of a live code page in `{ ...policy, sourceId }` exists, served or not (code scope resolution). */
export async function codeChunksExist(exec: LegacyUnscopedRead, sourceId: string | undefined, policy: PageReadScope = {}): Promise<boolean> {
  const none = trustedSql(policy.sourceIds?.length === 0 ? 'AND FALSE' : '');
  return existsResult(await rows<{ e: boolean }>(exec,
    // chunk-visibility-ok: any stored chunk of a code page, served or not; readiness separates the two
    sqlFragment`SELECT EXISTS(
       SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.page_kind = 'code' AND ${readFilter('p', { ...policy, sourceId }, true)}
         ${none}
     ) AS e`,
  ));
}

/** The search filters `hasUnsealedPages` reads beside the page read scope. */
export type UnsealedPageScope = PageReadScope & { types?: string[]; excludeSlugPrefixes?: string[] };

/**
 * Whether a live page in scope is below the safe-chunk fence (search's remote safe-index notice): the same page
 * filters the search applied (`pageReadFilter`, the type list, the hard-excluded slug prefixes). The predicate is the
 * plain range `chunker_version < N`, not the COALESCE form of the read legs, so it matches the partial
 * `pages_safe_chunk_pending_idx`. `sourceIds: []` names no source and matches nothing.
 */
export async function hasUnsealedPages(exec: LegacyUnscopedRead, scope: UnsealedPageScope): Promise<boolean> {
  if (scope.sourceIds?.length === 0 || !Number.isFinite(SAFE_FENCE_CHUNKER_VERSION)) return false;
  const { types, excludeSlugPrefixes = [], ...policy } = scope;
  const typed = types ? sqlFragment` AND p.type = ANY(${types}::text[])` : sqlFragment``;
  const kept = excludeSlugPrefixes.reduce<SqlFragment>((acc, prefix) => sqlFragment`${acc} AND LEFT(p.slug, LENGTH(${prefix}::text)) <> ${prefix}`, sqlFragment``);
  return (await rows<{ one: number }>(exec,
    sqlFragment`SELECT 1 AS one FROM pages p
       WHERE ${readFilter('p', policy, true)}${typed}${kept}
         AND p.chunker_version < ${trustedSql(`${SAFE_FENCE_CHUNKER_VERSION}`)} LIMIT 1`,
  )).length > 0;
}

/** The code read scope keys `currentCodeChunksExist` reads; a caller passes these and no others. */
export type CodeChunkScope = Pick<CodeReadScope, 'sourceId' | 'sourceIds' | 'allSources' | 'excludePrivate' | 'requireSafeChunks' | 'minTrust' | 'suppressFlagged'>;

/**
 * Whether a served chunk of a live code page in scope exists: any chunk (`any`) or one with a `symbol_name`
 * (`with_symbol`) (code-graph readiness).
 */
export async function currentCodeChunksExist(exec: LegacyUnscopedRead, scope: CodeChunkScope, predicate: 'any' | 'with_symbol'): Promise<boolean> {
  const where = trustedSql(predicate === 'with_symbol' ? 'cc.symbol_name IS NOT NULL' : 'TRUE');
  return existsResult(await rows<{ e: boolean }>(exec,
    // chunk-visibility-ok: the served projection filter of codeReadFilter is the readiness test
    sqlFragment`SELECT EXISTS(
       SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.page_kind = 'code' AND ${codeFilter(scope)} AND ${where}
     ) AS e`,
  ));
}

/**
 * The distinct qualified symbol names on served live pages of `sourceId`, in name order, at most `limit`: names whose
 * bare or qualified name equals `symbol` (`exact`), or whose qualified name contains it (ILIKE, unescaped) (`contains`)
 * (the recursive code walk's disambiguation).
 */
export async function listQualifiedSymbolNames(
  exec: LegacyUnscopedRead, sourceId: string, symbol: string, opts: { match: 'exact' | 'contains'; limit: number },
): Promise<string[]> {
  const where = opts.match === 'exact'
    ? sqlFragment`AND (symbol_name = ${symbol} OR symbol_name_qualified = ${symbol})`
    : sqlFragment`AND symbol_name_qualified ILIKE ${`%${symbol}%`}`;
  const found = await rows<{ symbol_name_qualified: string }>(exec,
    // Byte order (COLLATE "C") whatever the server locale, as PGLite and the Rust store sort.
    // chunk-visibility-ok: the served projection filter of codeReadFilter is master's visibility test here
    sqlFragment`SELECT DISTINCT symbol_name_qualified COLLATE "C" AS symbol_name_qualified
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = ${sourceId} AND ${codeFilter({})}
          AND symbol_name_qualified IS NOT NULL
          ${where}
        ORDER BY symbol_name_qualified
        LIMIT ${opts.limit}`,
  );
  return found.map(r => r.symbol_name_qualified);
}

/**
 * The distinct languages of the chunks of served live pages of `sourceId` that define `qualified`, in byte order
 * (the recursive code walk's language gate). Not only code pages: a namesake in any served page counts.
 */
export async function listSymbolLanguages(exec: LegacyUnscopedRead, sourceId: string, qualified: string): Promise<string[]> {
  const found = await rows<{ language: string }>(exec,
    // Byte order (COLLATE "C"), as PGLite and the Rust store sort; master's text had no ORDER BY (its caller only asks
    // whether some language is supported, so the order never changed an answer).
    // chunk-visibility-ok: the served projection filter of codeReadFilter is master's visibility test here
    sqlFragment`SELECT DISTINCT content_chunks.language COLLATE "C" AS language
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = ${sourceId} AND ${codeFilter({})}
          AND content_chunks.symbol_name_qualified = ${qualified}
          AND content_chunks.language IS NOT NULL
        ORDER BY language`,
  );
  return found.map(r => r.language);
}

/**
 * Which of the chunks `chunkIds` are written in one of `languages`, in id order (the walk keeps only edges whose origin
 * chunk is in a supported language). Any stored chunk row, as master's read: the edges named them.
 */
export async function listSupportedChunkIds(exec: LegacyUnscopedRead, chunkIds: readonly number[], languages: readonly string[]): Promise<number[]> {
  if (chunkIds.length === 0 || languages.length === 0) return [];
  const found = await rows<{ id: number | string }>(exec,
    // chunk-visibility-ok: reads the language of chunk ids an edge read already returned, as master did
    sqlFragment`SELECT id FROM content_chunks WHERE id = ANY(${[...chunkIds]}::int[]) AND language = ANY(${[...languages]}::text[]) ORDER BY id`,
  );
  return found.map(r => Number(r.id));
}

/** How many chunk ids one two-pass symbol lookup returns (master's `LIMIT 50`, the walk's per-hop neighbor cap). */
export const SYMBOL_CHUNK_LOOKUP_LIMIT = 50;

/**
 * The two-pass walk's symbol chunk lookups (search/two-pass.ts): `near_symbol` reads the chunks defining the one
 * near-symbol name, `edge_targets` the chunks defining any unresolved edge target; each on pages of `sourceId` when one
 * is named, at most 50. Master's four statements, text and parameters unchanged (pinned by
 * test/refusal-swallow-sites-sql-pin.test.ts): there is no ORDER BY, so which rows come back past the limit, and their
 * order, is the plan's (unspecified, and on PGLite it can change once the statement's plan is cached). The Rust store
 * answers in id order (rust/docs/store/chunk_queries.md; the difference past the limit has a row in
 * test/rust-expected-divergence/two_pass.tsv).
 */
export async function listSymbolChunkIds(
  exec: LegacyUnscopedRead, lookup: 'near_symbol' | 'edge_targets', symbols: readonly string[], sourceId?: string,
): Promise<number[]> {
  if (symbols.length === 0) return [];
  let found: Array<{ id: number | string }>;
  if (lookup === 'near_symbol') {
    found = sourceId
      ? await exec.executeRaw<{ id: number | string }>(
          // chunk-visibility-ok: code symbol anchors: code pages are never segmented (chooseBodyStorage)
          `SELECT cc.id FROM content_chunks cc
             JOIN pages p ON p.id = cc.page_id
             WHERE cc.symbol_name_qualified = $1 AND p.source_id = $2
             LIMIT 50`,
          [symbols[0], sourceId],
        )
      : await exec.executeRaw<{ id: number | string }>(
          // chunk-visibility-ok: code symbol anchors: code pages are never segmented (chooseBodyStorage)
          `SELECT id FROM content_chunks WHERE symbol_name_qualified = $1 LIMIT 50`,
          [symbols[0]],
        );
  } else {
    found = sourceId
      ? await exec.executeRaw<{ id: number | string }>(
          // chunk-visibility-ok: code symbol targets: code pages are never segmented (chooseBodyStorage)
          `SELECT cc.id FROM content_chunks cc
                 JOIN pages p ON p.id = cc.page_id
                 WHERE cc.symbol_name_qualified = ANY($1::text[])
                   AND p.source_id = $2
                 LIMIT 50`,
          [[...symbols], sourceId],
        )
      : await exec.executeRaw<{ id: number | string }>(
          // chunk-visibility-ok: code symbol targets: code pages are never segmented (chooseBodyStorage)
          `SELECT id FROM content_chunks WHERE symbol_name_qualified = ANY($1::text[]) LIMIT 50`,
          [[...symbols]],
        );
  }
  return found.map(r => Number(r.id));
}

/** One withdrawal key: a subject slug (`*` for every page) and the LIKE patterns a chunk's lowered text must all match. */
export interface WithdrawalChunkKey { subject: string; patterns: string[] }
export interface WithdrawalChunkRow { id: number; page_id: number; slug: string; chunk_text: string }

/**
 * Chunks of `sourceId` after chunk id `after`, in id order, at most `limit`, on pages named in `subjects` (every page
 * when null) whose lowered text matches every pattern of some key for the page (withdrawal discovery).
 */
export async function listWithdrawalChunks(
  exec: LegacyUnscopedRead, sourceId: string, keys: WithdrawalChunkKey[], opts: { after: number; limit: number; subjects: string[] | null },
): Promise<WithdrawalChunkRow[]> {
  const keyText = JSON.stringify(keys.map(k => ({ subject: k.subject, patterns: k.patterns })));
  return rows<WithdrawalChunkRow>(exec,
    // chunk-visibility-ok: withdrawal strikes the claim from every stored chunk row, any generation
    sqlFragment`SELECT c.id,c.page_id,p.slug,c.chunk_text FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id=${sourceId} AND c.id>${opts.after} AND (${opts.subjects}::text[] IS NULL OR p.slug=ANY(${opts.subjects}::text[]))
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset(${keyText}::text::jsonb) k(subject text,patterns text[])
            WHERE (k.subject='*' OR k.subject=p.slug) AND lower(c.chunk_text) LIKE ALL(k.patterns))
        ORDER BY c.id LIMIT ${opts.limit}`);
}

/** Deletes every chunk of the pages with these ids; seals nothing (withdrawal). */
export async function deleteChunksForPages(exec: SqlExecutor, pageIds: readonly number[]): Promise<void> {
  await exec.executeRaw('DELETE FROM content_chunks WHERE page_id=ANY($1::integer[])', [[...pageIds]]);
}

export interface ContextualModeCandidate {
  id: number; source_id: string; slug: string; sealed: boolean | null; embed_skip: boolean; chars: number;
}

/**
 * Live markdown pages of `sourceIds` with no contextual retrieval mode, in id order: whether their text projection is
 * sealed (null with none), whether they carry `embed_skip`, and their chunks' total characters (repair contextual-mode).
 */
export async function listContextualModeCandidates(exec: LegacyUnscopedRead, sourceIds: string[]): Promise<ContextualModeCandidate[]> {
  // chunk-visibility-ok: sizes every stored chunk row of the page, the repair's own estimate
  const rows = await exec.executeRaw<ContextualModeCandidate>(`SELECT p.id,p.source_id,p.slug,
        (p.text_projection_revision = p.knowledge_revision) AS sealed, (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AS embed_skip,
        COALESCE((SELECT sum(length(c.chunk_text)) FROM content_chunks c WHERE c.page_id=p.id), 0)::int AS chars
      FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.page_kind='markdown'
        AND p.contextual_retrieval_mode IS NULL ORDER BY p.id`, [sourceIds]);
  return rows.map(r => ({ ...r, id: Number(r.id), chars: Number(r.chars) }));
}

/** One frozen hit: a page by source and slug, a chunk id (0 for the page's first chunk; not an int4 never matches) and its position. */
export interface FrozenHitKey { source_id: string; slug: string; chunk_id: number; ord: number }
export interface FrozenHitRow {
  ord: number; page_id: number; slug: string; source_id: string; title: string | null; type: string;
  effective_date: Date | string | null; effective_date_source: string | null;
  chunk_id: number | null; chunk_index: number | null; chunk_text: string | null; chunk_source: string | null;
}

/**
 * The page rows of frozen hits under `scope` (live, served, safe chunks when the scope requires them), each with the
 * named chunk of the live body generation when the page holds it (evidence delivery's frozen hits). `manifest` is
 * `chunkManifestReads(engine)`. Rows come in no set order; the caller keys them by `ord`.
 */
export async function resolveFrozenHits(exec: LegacyUnscopedRead, hits: FrozenHitKey[], scope: PageReadScope, manifest: boolean): Promise<FrozenHitRow[]> {
  if (hits.length === 0) return [];
  const safe = requiresSafeChunks(scope) ? sqlFragment`AND ${trustedSql(safeChunksFilter('p'))}` : sqlFragment``;
  return rows<FrozenHitRow>(exec,
    sqlFragment`SELECT h.ord, p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            p.effective_date, p.effective_date_source,
            cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM unnest(${hits.map(h => h.source_id)}::text[], ${hits.map(h => h.slug)}::text[], ${hits.map(h => h.chunk_id)}::int[], ${hits.map(h => h.ord)}::int[]) AS h(source_id, slug, chunk_id, ord)
       JOIN pages p ON p.source_id = h.source_id AND p.slug = h.slug
       LEFT JOIN content_chunks cc ON cc.page_id = p.id AND ${trustedSql(chunkGenerationFilter('p', 'cc', manifest))}
            AND CASE WHEN h.chunk_id > 0 THEN cc.id = h.chunk_id ELSE cc.chunk_index = 0 END
      WHERE ${readFilter('p', scope, true)} AND ${trustedSql(servedTextProjectionFilter('p'))} ${safe}`,
  );
}
