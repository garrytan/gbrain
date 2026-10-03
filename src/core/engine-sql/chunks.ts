/**
 * Content chunks: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/chunks.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md).
 *
 * The engine resolves everything this module must not: the source scope
 * (`sourceIds` > `sourceId` > 'default'), the registry-ACTIVE embedding
 * column for the stale / invalidate / read plane (passed as its bare name and
 * quoted here), the RLS scope transaction, `upsertChunks`'s retry + transaction
 * wrapper, the page-state guards (`lockPageKeys` / `readPageSnapshot`, passed
 * in as `ChunkPageGuards`) and the invalidations' `engine.transaction()`.
 * Reads that ran inside `withScopedReadTransaction` on master take
 * `ScopedRead`; the rest take `LegacyUnscopedRead` (EO4 inventory).
 *
 * Driver paths follow master per statement: tagged templates -> `run`
 * (prepared, extended protocol), direct `conn.unsafe` -> `unsafe`, engine
 * `executeRaw` -> `executeRaw`.
 */
import type { PageKey, PageSnapshot, PageSnapshotOptions } from '../page-state/types.ts';
import { assertPageRevision } from '../page-state/types.ts';
import type { BrainEngine } from '../engine.ts';
import type { Chunk, ChunkInput, ChunklessPageRow, ResolvedColumn, StaleChunkRow } from '../types.ts';
import { rowToChunk, tryParseEmbedding, validateSlug } from '../utils.ts';
import { sanitizeText } from '../batch-rows.ts';
import {
  normalizeEngineColumn,
  vectorCastSuffix,
  resolveWriteColumnFromConfigRows,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from '../search/embedding-column.ts';
import { chunkWriteInvalidation, currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { splitEmbeddingSignature, lockEmbeddingSources } from '../embedding-invalidation.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from '../embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { mapChunkWindowRows, type ChunkWindowOpts, type ChunkWindowPage, type ChunkWindowRequest } from '../search/chunk-windows.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead, ScopedRead } from './brands.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** The engine's page-state guards, run on the same (transaction) engine. */
export interface ChunkPageGuards {
  lockPageKeys(keys: readonly PageKey[]): Promise<void>;
  readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null>;
}

/**
 * The engine's `transaction()`. The invalidations run their source lock and
 * UPDATE through the transaction clone's own `executeRaw`, exactly as master
 * did (raw gauge, and the clone's `executeRaw` is the seam callers observe).
 */
export type ChunkTransactionRunner = <T>(fn: (tx: Pick<BrainEngine, 'executeRaw'>) => Promise<T>) => Promise<T>;

type StaleChunkOpts = { sourceId?: string; signature?: string; includeNullSignature?: boolean };

export async function upsertChunksOnce(
  exec: SqlExecutor,
  guards: ChunkPageGuards,
  slug: string,
  chunks: ChunkInput[],
  opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string },
): Promise<void> {
    // Normalize the same way putPage does — pages.slug is stored lowercased,
    // so a raw mixed-case slug here would miss the row it just wrote (#430).
    slug = validateSlug(slug);
    // Compare and persist the same canonical body bytes. JSONB rejects raw
    // NUL/lone surrogates before the INSERT can sanitize them; identity fields
    // remain untouched so malformed identifiers still reject the transaction.
    chunks = chunks.map(chunk => ({ ...chunk, chunk_text: sanitizeText(chunk.chunk_text) }));
    const sourceId = opts?.sourceId ?? 'default';
    await guards.lockPageKeys([{ sourceId, slug }]);
    if (opts?.expectedRevision !== undefined) assertPageRevision(
      await guards.readPageSnapshot(slug, { sourceId }), { expectedRevision: opts.expectedRevision });

    // Source-scope the page-id lookup. Without this filter, multi-source
    // brains where the slug exists in 2+ sources return >1 row and the
    // chunk replacement targets the wrong page (or fans out across pages).
    const pages = (await exec.run<{ id: number }>(sqlFragment`SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId} FOR UPDATE`)).rows;
    if (pages.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const pageId = pages[0].id;

    // A fragment write cannot certify the full-body fence boundary. Import seals
    // only after its complete replacement succeeds in the same transaction.
    const invalidation = chunkWriteInvalidation(pageId, chunks);
    await exec.unsafe(invalidation.sql, invalidation.params);

    // Remove chunks that no longer exist (chunk_index beyond new count)
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      await exec.run(sqlFragment`DELETE FROM content_chunks WHERE page_id = ${pageId} AND chunk_index != ALL(${newIndices})`);
    } else {
      await exec.run(sqlFragment`DELETE FROM content_chunks WHERE page_id = ${pageId}`);
      return;
    }

    // Batch upsert: build a single multi-row INSERT ON CONFLICT statement.
    // v0.19.0: includes language/symbol_name/symbol_type/start_line/end_line
    // so code chunks carry tree-sitter metadata into the DB. Markdown chunks
    // pass NULL for all five.
    // v0.20.0 Cathedral II Layer 6: adds parent_symbol_path / doc_comment /
    // symbol_name_qualified so nested-chunk emission (A3) can round-trip
    // scope metadata through upserts.
    // v0.27.1 (Phase 8): added `modality` + `embedding_image` to the column
    // list. Image chunks pass embedding=null + embedding_image=Float32Array.
    //
    // #1262: the text-embedding column is registry-resolved, not the literal
    // `embedding`. A caller-resolved descriptor wins; otherwise the DB-plane
    // registry rows route the write to the SAME active column the read side
    // searches (a Voyage-routed brain must not fail every write with a
    // dimension mismatch against the legacy 1536d column). Config-table read
    // failure (pre-v36 brain mid-migration) falls back to the legacy column;
    // an unregistered `search_embedding_column` throws the resolver's loud
    // paste-ready hint.
    // Resolution MUST stay on this executor's handle: callers (import-file)
    // invoke this inside their own transaction — re-entering the engine's
    // public surface via resolveActiveEmbeddingColumnFromEngine deadlocks
    // the connection path (PGLite's single connection). Same rows, same pure
    // resolver, no re-entrancy.
    let writeCol: ResolvedColumn;
    if (opts?.embeddingColumn) {
      writeCol = normalizeEngineColumn(opts.embeddingColumn);
    } else {
      let searchEmbeddingColumn: string | null = null;
      let embeddingColumnsJson: string | null = null;
      try {
        const cfgRows = (await exec.run<{ key: string; value: string }>(sqlFragment`SELECT key, value FROM config WHERE key IN ('search_embedding_column', 'embedding_columns')`)).rows;
        for (const r of cfgRows) {
          if (r.key === 'search_embedding_column') searchEmbeddingColumn = r.value;
          else if (r.key === 'embedding_columns') embeddingColumnsJson = r.value;
        }
      } catch {
        // config table unreadable — legacy column via the resolver default.
      }
      writeCol = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn, embeddingColumnsJson });
    }
    const writeColId = quoteIdentifier(writeCol.name);
    const writeCast = vectorCastSuffix(writeCol);
    const col = trustedSql(writeColId);

    // #4246: embedded_text_hash records md5(chunk_text) AT EMBED TIME so a
    // later text rewrite that keeps the vector is detectable as content
    // drift (invalidateContentDriftEmbeddings). NULL when no embedding lands.
    const cols = `(page_id, chunk_index, chunk_text, chunk_source, ${writeColId}, model, token_count, embedded_at, embedded_text_hash, embedding_input_hash, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified, modality, embedding_image)`;
    const rows: SqlFragment[] = [];

    let resolvedModel: string | null = null;
    try {
      // Keep the gateway lazy so module-load failure remains inside this soft
      // fallback boundary; eager evaluation would bypass the config-row fallback.
      const gw = await import('../ai/gateway.ts'); // engine-dynamic-import-ok
      resolvedModel = gw.getEmbeddingModelProvenance();
    } catch {}
    if (!resolvedModel) {
      try {
        const cfg = (await exec.run<{ value?: string }>(sqlFragment`SELECT value FROM config WHERE key = 'embedding_model'`)).rows;
        resolvedModel = cfg[0]?.value ?? null;
      } catch {}
    }
    resolvedModel = writeCol.embeddingModel || resolvedModel;
    if (!resolvedModel && chunks.some(chunk => chunk.embedding && !chunk.model)) {
      throw new Error('Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.');
    }
    if (!resolvedModel) resolvedModel = 'unconfigured';

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;
      const embeddingImageStr = chunk.embedding_image
        ? '[' + Array.from(chunk.embedding_image).join(',') + ']'
        : null;
      const parentPath = chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0
        ? chunk.parent_symbol_path
        : null;
      const modality = chunk.modality ?? 'text';
      // Already normalized before the seal snapshot. Both storage and the
      // embedded_text_hash input must use those same canonical bytes.
      const sanitizedChunkText = chunk.chunk_text;

      const embeddingPh = embeddingStr ? sqlFragment`${embeddingStr}${trustedSql(writeCast)}` : sqlFragment`NULL`;
      const embeddedAtPh = trustedSql(embeddingStr ? 'now()' : 'NULL');
      const embeddingImagePh = embeddingImageStr ? sqlFragment`${embeddingImageStr}::vector` : sqlFragment`NULL`;
      // #4246: hash in SQL (not JS) so stamp + drift comparison share ONE
      // md5 implementation. Binds chunk_text a second time.
      const embeddedTextHashPh = embeddingStr ? sqlFragment`md5(${sanitizedChunkText})` : sqlFragment`NULL`;
      // #5553: embedding-input provenance travels only with the vector it describes.
      const embeddingInputHash = embeddingStr ? chunk.embedding_input_hash ?? null : null;
      const embeddingInputHashPh = embeddingInputHash ? sqlFragment`${embeddingInputHash}` : sqlFragment`NULL`;

      rows.push(sqlFragment`(${pageId}, ${chunk.chunk_index}, ${sanitizedChunkText}, ${chunk.chunk_source}, ${embeddingPh}, ${chunk.model || resolvedModel}, ${chunk.token_count || null}, ${embeddedAtPh}, ${embeddedTextHashPh}, ${embeddingInputHashPh}, ${chunk.language || null}, ${chunk.symbol_name || null}, ${chunk.symbol_type || null}, ${chunk.start_line ?? null}, ${chunk.end_line ?? null}, ${parentPath}::text[], ${chunk.doc_comment || null}, ${chunk.symbol_name_qualified || null}, ${modality}, ${embeddingImagePh})`);
    }

    // Single statement upsert: preserves existing embeddings via COALESCE when new value is NULL.
    // CONSISTENCY: when chunk_text changes and no new embedding is supplied, BOTH embedding AND
    // embedded_at must reset to NULL so 'embed --stale' correctly picks up the row for re-embedding.
    // Without this, embedded_at lies (says "embedded" while embedding=NULL), and any staleness
    // predicate on embedded_at would silently skip the row. This is why the egress fix predicates
    // on 'embedding IS NULL' rather than `embedded_at IS NULL` — and it's why we now keep both
    // columns honest at write time.
    //
    // v0.40.3.0 D24 NULL→non-NULL race fix (TODOS.md v0.35.x item).
    // Two writers racing on the same chunk (e.g., autopilot sync + manual
    // 'embed --stale' + contextual reindex) previously raced last-write-wins
    // via `COALESCE(EXCLUDED.embedding, content_chunks.embedding)`. With
    // per-chunk Haiku synopsis the cost of an overwrite jumped from
    // ~$0.000001 to ~$0.0003. New rule for the text-unchanged branch:
    //   - existing is NULL → take new (cold path, no race)
    //   - new is fresher (embedded_at > existing.embedded_at) → take new
    //   - otherwise → keep existing (slower writer with stale embedding loses)
    // Pinned by test/e2e/concurrent-embed-race.test.ts.
    //
    // Code-chunk metadata columns (language / symbol_name / symbol_type / line range /
    // parent_symbol_path / doc_comment / symbol_name_qualified) follow the SAME chunk_text-gated
    // CASE pattern as `embedding` (#769). Re-chunk (chunk_text changed) trusts EXCLUDED outright;
    // pure re-embed (chunk_text unchanged) COALESCEs so a caller that only carries embedding
    // doesn't clobber metadata to NULL. Without this, every embed --stale pass nuked code-def's
    // primary index for thousands of chunks at once.
    //
    // #3461: `model` mirrors the `embedding` CASE branch-for-branch — the label must
    // describe whichever vector WINS the upsert. The old COALESCE(EXCLUDED.model, …)
    // relabeled preserved (older-model) vectors with the current gateway model on every
    // partial re-embed, corrupting provenance without changing the vector.
    //
    // Master's raw path (it was `unsafe` on both engines). No bind batching:
    // master PGLite never split this statement.
    const { text, params } = renderFragment(sqlFragment`INSERT INTO content_chunks ${trustedSql(cols)} VALUES ${joinFragments(rows, ', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         ${col} = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.${col}
           WHEN content_chunks.${col} IS NULL THEN EXCLUDED.${col}
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.${col}
           ELSE content_chunks.${col}
         END,
         model = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.model
           WHEN content_chunks.${col} IS NULL THEN EXCLUDED.model
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.model
           ELSE content_chunks.model
         END,
         token_count = EXCLUDED.token_count,
         embedded_at = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text AND EXCLUDED.${col} IS NULL THEN NULL
           WHEN content_chunks.${col} IS NULL AND EXCLUDED.${col} IS NOT NULL THEN EXCLUDED.embedded_at
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_at
           ELSE content_chunks.embedded_at
         END,
         embedded_text_hash = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedded_text_hash
           WHEN content_chunks.${col} IS NULL THEN EXCLUDED.embedded_text_hash
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_text_hash
           ELSE content_chunks.embedded_text_hash
         END,
         embedding_input_hash = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedding_input_hash
           WHEN content_chunks.${col} IS NULL THEN EXCLUDED.embedding_input_hash
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedding_input_hash
           ELSE content_chunks.embedding_input_hash
         END,
         language = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.language ELSE COALESCE(EXCLUDED.language, content_chunks.language) END,
         symbol_name = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_name ELSE COALESCE(EXCLUDED.symbol_name, content_chunks.symbol_name) END,
         symbol_type = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_type ELSE COALESCE(EXCLUDED.symbol_type, content_chunks.symbol_type) END,
         start_line = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.start_line ELSE COALESCE(EXCLUDED.start_line, content_chunks.start_line) END,
         end_line = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.end_line ELSE COALESCE(EXCLUDED.end_line, content_chunks.end_line) END,
         parent_symbol_path = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.parent_symbol_path ELSE COALESCE(EXCLUDED.parent_symbol_path, content_chunks.parent_symbol_path) END,
         doc_comment = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.doc_comment ELSE COALESCE(EXCLUDED.doc_comment, content_chunks.doc_comment) END,
         symbol_name_qualified = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_name_qualified ELSE COALESCE(EXCLUDED.symbol_name_qualified, content_chunks.symbol_name_qualified) END,
         modality = EXCLUDED.modality,
         embedding_image = COALESCE(EXCLUDED.embedding_image, content_chunks.embedding_image)`);
    await exec.unsafe(text, params);
  }

export async function getChunks(
  exec: ScopedRead,
  column: string,
  slug: string,
  scope: { sourceIds?: string[]; sourceId: string },
  opts?: { includeEmbedding?: boolean; excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean },
): Promise<Chunk[]> {
      const colId = trustedSql(quoteIdentifier(column));
      const includeEmbedding = opts?.includeEmbedding === true;
      const scopeSql = scope.sourceIds
        ? sqlFragment`p.source_id = ANY(${scope.sourceIds}::text[])`
        : sqlFragment`p.source_id = ${scope.sourceId}`;
      // #2544: explicit non-vector column list — most callers discard
      // embeddings, so `cc.*` shipped every vector over the wire only to be
      // thrown away. `includeEmbedding` adds it back for the callers that
      // consume it (embed-reuse.ts); it selects the registry-ACTIVE column
      // (aliased AS embedding) so a reused vector always matches the column
      // upsertChunks writes.
      // embedding_is_null: boolean truth of the stored vector (a schema
      // rebuild NULLs vectors without touching embedded_at). S2: it reports
      // the registry-ACTIVE column's truth — `embed <page>` filters on it.
      const embedCol = includeEmbedding ? sqlFragment`, cc.${colId} AS embedding` : sqlFragment``;
      const { rows } = await exec.run(sqlFragment`
        SELECT cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
               cc.model, cc.token_count, cc.embedded_at, cc.language,
               cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
               cc.parent_symbol_path, cc.doc_comment, cc.symbol_name_qualified, cc.modality,
               (cc.${colId} IS NULL) AS embedding_is_null, p.source_id
               ${embedCol}
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = ${slug} AND ${scopeSql}
          ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('p')}`) : sqlFragment``}
          ${opts?.includeUnsealed ? sqlFragment`` : trustedSql(`AND ${currentTextProjectionFilter('p')}`)}
          ${requiresSafeChunks(opts) ? trustedSql(`AND ${safeChunksFilter('p')}`) : sqlFragment``}
        ORDER BY cc.chunk_index
      `);
      return rows.map((r) => rowToChunk(r, includeEmbedding));
  }

/**
 * Stale-chunk WHERE clause over the registry-ACTIVE embedding column
 * (`cc."<name>"`, S2 unification — a registry-routed brain's staleness
 * lives in the active column, never the literal legacy `cc.embedding`).
 * embed_skip always excluded. `signature` widens "stale" to include
 * embedding_signature drift (NULL grandfathered). `includeNullSignature`
 * (#3391) lifts the grandfather clause so pre-stamp pages count as stale
 * too (provider-migration paths). Shared by countStaleChunks +
 * sumStaleChunkChars so they can't drift.
 */
function staleChunkWhere(column: string, opts?: StaleChunkOpts): SqlFragment {
  const staleColRef = trustedSql(`cc.${quoteIdentifier(column)}`);
  const conds: SqlFragment[] = [sqlFragment`p.deleted_at IS NULL`];
  if (opts?.signature !== undefined) {
    conds.push(
      opts.includeNullSignature
        ? sqlFragment`(${staleColRef} IS NULL OR p.embedding_signature IS NULL OR p.embedding_signature <> ${opts.signature})`
        : sqlFragment`(${staleColRef} IS NULL OR (p.embedding_signature IS NOT NULL AND p.embedding_signature <> ${opts.signature}))`,
    );
  } else {
    conds.push(sqlFragment`${staleColRef} IS NULL`);
  }
  conds.push(sqlFragment`NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
  if (opts?.sourceId !== undefined) conds.push(sqlFragment`p.source_id = ${opts.sourceId}`);
  return joinFragments(conds, ' AND ');
}

export async function countStaleChunks(exec: ScopedRead, column: string, opts?: StaleChunkOpts): Promise<number> {
    // Always JOIN pages so the embed_skip + signature predicates apply.
    // D7: source_id scoping. v0.41.31: optional signature widens staleness
    // to embedding_signature drift (NULL grandfathered unless
    // includeNullSignature, #3391).
    const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS count
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE ${staleChunkWhere(column, opts)}`);
    const { rows } = await exec.unsafe<{ count?: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  }

export async function sumStaleChunkChars(exec: LegacyUnscopedRead, column: string, opts?: StaleChunkOpts): Promise<number> {
    // Sibling of countStaleChunks: same stale predicate, summing chunk_text
    // length for the sync cost preview. ::bigint guards int4 overflow.
    const { text, params } = renderFragment(sqlFragment`SELECT COALESCE(SUM(LENGTH(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE ${staleChunkWhere(column, opts)}`);
    const { rows } = await exec.unsafe<{ chars?: number | string }>(text, params);
    return Number(rows[0]?.chars ?? 0);
  }

export async function setPageEmbeddingSignature(exec: SqlExecutor, slug: string, opts: { sourceId?: string; signature: string }): Promise<void> {
    await exec.run(sqlFragment`
      UPDATE pages SET embedding_signature = ${opts.signature}
      WHERE slug = ${slug} AND source_id = ${opts.sourceId ?? 'default'}
    `);
  }

/**
 * `currentSpaceChunkPredicate` (embedding-invalidation.ts) as a fragment:
 * identical text, values bound in place of its hand-numbered `$model` /
 * `$dims`. `test/engine-sql-chunks.test.ts` pins the two against each other.
 */
export function currentSpaceChunkFragment(column: string, model: string, dims: number | null): SqlFragment {
  const colId = trustedSql(quoteIdentifier(column));
  return sqlFragment`COALESCE(cc.${colId} IS NOT NULL
              AND cc.model = ${model}
              AND cc.embedded_text_hash = md5(cc.chunk_text)
              AND vector_dims(cc.${colId}) = ${dims}::int, false)`;
}

export async function invalidateStaleSignatureEmbeddings(
  inTransaction: ChunkTransactionRunner,
  column: string,
  opts: { signature: string; sourceId?: string; includeNullSignature?: boolean },
): Promise<number> {
    const colId = trustedSql(quoteIdentifier(column));
    const { model, dims } = splitEmbeddingSignature(opts.signature);
    const srcClause = opts.sourceId !== undefined ? sqlFragment` AND p.source_id = ${opts.sourceId}` : sqlFragment``;
    const sigClause = opts.includeNullSignature
      ? sqlFragment`(p.embedding_signature IS NULL OR p.embedding_signature <> ${opts.signature})`
      : sqlFragment`p.embedding_signature IS NOT NULL
          AND p.embedding_signature <> ${opts.signature}`;
    return inTransaction(async tx => {
      const sources = await lockEmbeddingSources(tx, opts.sourceId);
      const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks cc
            SET ${colId} = NULL, embedded_at = NULL
           FROM pages p
          WHERE cc.page_id = p.id
            AND p.deleted_at IS NULL
            AND p.source_id=ANY(${sources}::text[])
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
            AND cc.${colId} IS NOT NULL
            AND NOT ${currentSpaceChunkFragment(column, model, dims)}
            AND ${sigClause}${srcClause}
          RETURNING cc.page_id`);
      return (await tx.executeRaw(text, params)).length;
    });
  }

export async function invalidateContentDriftEmbeddings(
  inTransaction: ChunkTransactionRunner,
  column: string,
  opts?: { sourceId?: string },
): Promise<number> {
    // #4246: NULL embeddings whose stored embed-time hash no longer matches
    // md5(chunk_text) — the vector was computed from a PREVIOUS content
    // revision. Feeds the NULL-embedding cursor (mirrors the signature
    // invalidation above). GRANDFATHER: NULL hash (pre-v133 rows) untouched
    // so upgrades don't trigger a corpus-wide re-embed spike. embed_skip
    // pages excluded — the stale selectors can't re-embed them, so NULLing
    // would strand them (same never-NULL-what-nothing-re-embeds rule as
    // embedding-invalidation.ts). S2: keyed on the registry-ACTIVE column
    // (the engine resolves it with the loud resolver).
    const colId = trustedSql(quoteIdentifier(column));
    const srcClause = opts?.sourceId !== undefined ? sqlFragment` AND p.source_id = ${opts.sourceId}` : sqlFragment``;
    return inTransaction(async tx => {
      const sources = await lockEmbeddingSources(tx, opts?.sourceId);
      const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks cc
            SET ${colId} = NULL, embedded_at = NULL, embedded_text_hash = NULL
           FROM pages p
          WHERE cc.page_id = p.id
            AND p.source_id=ANY(${sources}::text[])
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
            AND p.deleted_at IS NULL
            AND cc.${colId} IS NOT NULL
            AND cc.embedded_text_hash IS NOT NULL
            AND cc.embedded_text_hash <> md5(cc.chunk_text)
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')${srcClause}
          RETURNING cc.page_id`);
      return (await tx.executeRaw(text, params)).length;
    });
  }

export async function listStaleChunks(exec: ScopedRead, column: string, opts?: {
  batchSize?: number;
  afterPageId?: number;
  afterChunkIndex?: number;
  sourceId?: string;
  orderBy?: 'page_id' | 'updated_desc';
  afterUpdatedAt?: string | null;
}): Promise<StaleChunkRow[]> {
    const limit = opts?.batchSize ?? 2000;
    const afterPid = opts?.afterPageId ?? 0;
    const afterIdx = opts?.afterChunkIndex ?? -1;
    const orderBy = opts?.orderBy ?? 'page_id';
    // S2: stale = NULL in the registry-ACTIVE column (resolved by the engine
    // BEFORE the scoped transaction, falling back to legacy on a broken registry).
    const staleColId = trustedSql(quoteIdentifier(column));
    const read = async (fragment: SqlFragment) => (await exec.run(fragment)).rows as unknown as StaleChunkRow[];

      // v0.41.18.0 (A13, codex #9): --priority recent path. Composite cursor
      // (updated_at DESC NULLS LAST, page_id ASC, chunk_index ASC). Backed by
      // idx_pages_updated_at_desc + content_chunks_stale_idx partial.
      if (orderBy === 'updated_desc') {
        const afterUpdated = opts?.afterUpdatedAt ?? null;
        const isFirstPage = afterUpdated === null && afterPid === 0;
        if (opts?.sourceId === undefined) {
          return isFirstPage ? read(sqlFragment`
            SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                   cc.model, cc.token_count, p.source_id, cc.page_id,
                   p.updated_at
            FROM content_chunks cc
            JOIN pages p ON p.id = cc.page_id
            WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT ${limit}
          `) : read(sqlFragment`
            SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                   cc.model, cc.token_count, p.source_id, cc.page_id,
                   p.updated_at
            FROM content_chunks cc
            JOIN pages p ON p.id = cc.page_id
            WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
              AND (
                p.updated_at < ${afterUpdated}::timestamptz
                OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id > ${afterPid})
                OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id = ${afterPid} AND cc.chunk_index > ${afterIdx})
              )
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT ${limit}
          `);
        }
        return isFirstPage ? read(sqlFragment`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id,
                 p.updated_at
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
            AND p.source_id = ${opts.sourceId}
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT ${limit}
        `) : read(sqlFragment`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id,
                 p.updated_at
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
            AND p.source_id = ${opts.sourceId}
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (
              p.updated_at < ${afterUpdated}::timestamptz
              OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id > ${afterPid})
              OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id = ${afterPid} AND cc.chunk_index > ${afterIdx})
            )
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT ${limit}
        `);
      }
      // orderBy === 'page_id' — legacy stable cursor.
      if (opts?.sourceId === undefined) {
        return read(sqlFragment`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (cc.page_id, cc.chunk_index) > (${afterPid}, ${afterIdx})
          ORDER BY cc.page_id, cc.chunk_index
          LIMIT ${limit}
        `);
      }
      return read(sqlFragment`
        SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
               cc.model, cc.token_count, p.source_id, cc.page_id
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
          AND p.source_id = ${opts.sourceId}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          AND (cc.page_id, cc.chunk_index) > (${afterPid}, ${afterIdx})
        ORDER BY cc.page_id, cc.chunk_index
        LIMIT ${limit}
      `);
  }

/**
 * Shared chunkless-page-with-content predicate. Excludes quarantined +
 * embed_skip pages — both are intentionally chunkless by design, not drift
 * the safety net should repair.
 */
function chunklessPagesWhere(opts?: { sourceId?: string }): SqlFragment {
  const conds: SqlFragment[] = [
    sqlFragment`p.deleted_at IS NULL`,
    // healChunklessPages chunks BOTH compiled_truth and timeline (mirrors
    // embedPage) — a timeline-only page (rare but schema-legal) has
    // something to heal even with compiled_truth = ''.
    sqlFragment`(p.compiled_truth <> '' OR p.timeline <> '')`,
    sqlFragment`${trustedSql(EMBED_SKIP_FILTER_FRAGMENT)}`,
    sqlFragment`${trustedSql(QUARANTINE_FILTER_FRAGMENT)}`,
    sqlFragment`NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)`,
  ];
  if (opts?.sourceId) conds.push(sqlFragment`p.source_id = ${opts.sourceId}`);
  return joinFragments(conds, ' AND ');
}

export async function countChunklessPagesWithContent(exec: ScopedRead, opts?: { sourceId?: string }): Promise<number> {
    const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS count FROM pages p WHERE ${chunklessPagesWhere(opts)}`);
    const { rows } = await exec.unsafe<{ count?: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  }

export async function listChunklessPagesWithContent(exec: ScopedRead, opts?: {
  batchSize?: number;
  afterPageId?: number;
  sourceId?: string;
}): Promise<ChunklessPageRow[]> {
    const afterClause = opts?.afterPageId != null ? sqlFragment` AND p.id > ${opts.afterPageId}` : sqlFragment``;
    // Small default (unlike the 2000-row chunk-metadata cursors elsewhere):
    // each row here carries a FULL page body. See engine.ts docstring.
    const limit = opts?.batchSize ?? 50;
    const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline
           FROM pages p
          WHERE ${chunklessPagesWhere(opts)}${afterClause}
          ORDER BY p.id
          LIMIT ${limit}`);
    const { rows } = await exec.unsafe(text, params);
    return rows.map(r => ({
      id: r.id as number,
      slug: r.slug as string,
      source_id: (r.source_id as string | undefined) ?? 'default',
      compiled_truth: (r.compiled_truth as string | null) ?? '',
      timeline: (r.timeline as string | null) ?? '',
    }));
  }

export async function deleteChunks(exec: SqlExecutor, slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    // Source-qualify the page-id subquery; slugs are only unique per source.
    await exec.run(sqlFragment`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId})
    `);
  }

/**
 * `tryParseEmbedding`'s result for every input, with a native fast path for
 * well-formed pgvector text. Both drivers return the vector as its text
 * literal; PGLite master decoded it with `JSON.parse`, Postgres master with
 * `tryParseEmbedding` (split + `Number`, about twice as slow per 1024-d row on
 * the hybrid rescoring path). JSON's number grammar is a subset of
 * `Number()`'s with the same values, so an all-finite numeric array decodes
 * identically; anything else (malformed, non-finite, not an array) takes
 * `tryParseEmbedding` and keeps its skip-and-warn contract.
 * `test/engine-sql-chunks.test.ts` pins the equivalence.
 */
export function decodeEmbedding(value: unknown): Float32Array | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) return Float32Array.from(parsed as number[]);
    } catch {
      // Not JSON: tryParseEmbedding decides (corrupt rows skip with one warning).
    }
  }
  return tryParseEmbedding(value);
}

export async function getEmbeddingsByChunkIds(exec: LegacyUnscopedRead, ids: number[], column: string): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    // v0.36 (D9): column parameter used by hybrid.cosineReScore so
    // rescoring rehydrates from the active column's embedding space,
    // not always 'embedding'. Engine has no resolver access; the
    // caller must pass a known column name. Identifier-quoted (D12
    // defense layer 2) plus a strict regex check (D12 defense layer 1)
    // so even a misconfigured caller can't smuggle a SQL fragment.
    if (!COLUMN_NAME_REGEX.test(column)) {
      throw new EmbeddingColumnNotRegisteredError(column, []);
    }
    const quotedCol = trustedSql(quoteIdentifier(column));
    const { text, params } = renderFragment(sqlFragment`
      SELECT cc.id, cc.${quotedCol} AS embedding FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE cc.id = ANY(${ids}::int[]) AND cc.${quotedCol} IS NOT NULL AND ${trustedSql(currentTextProjectionFilter('p'))}
    `);
    const { rows } = await exec.unsafe(text, params);
    const result = new Map<number, Float32Array>();
    for (const row of rows) {
      const embedding = decodeEmbedding(row.embedding);
      if (embedding) result.set(row.id as number, embedding);
    }
    return result;
  }

/**
 * Evidence delivery: ONE batched read of chunk_index windows, keyed by
 * page_id. Every requested page is re-authorized with the search legs'
 * visibility predicate (source scope, deleted, current text projection,
 * archived source, quarantine, private pages, safe chunks); pages that fail
 * are absent. Page rows carry the raw body columns (the assembler sanitizes
 * them whole before slicing); chunk rows (sealed pages only) anchor the hits
 * in that text. Page rows and chunk
 * rows come back in one UNION so the row cap never hides a page's
 * authorization.
 */
export async function getChunkWindows(exec: ScopedRead, requests: ChunkWindowRequest[], opts: ChunkWindowOpts): Promise<ChunkWindowPage[]> {
  if (requests.length === 0) return [];
  const maxRows = Math.max(0, Math.floor(opts.maxRows));
  const scopeSql = opts.sourceIds && opts.sourceIds.length > 0
    ? sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[])`
    : opts.sourceId ? sqlFragment`AND p.source_id = ${opts.sourceId}` : sqlFragment``;
  const privateSql = opts.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('p')}`) : sqlFragment``;
  const safeSql = requiresSafeChunks(opts) ? trustedSql(`AND ${safeChunksFilter('p')}`) : sqlFragment``;
  const { rows } = await exec.run(sqlFragment`
    WITH req AS (
      SELECT * FROM unnest(${requests.map(r => r.page_id)}::int[], ${requests.map(r => r.from_index)}::int[],
                           ${requests.map(r => r.to_index)}::int[], ${requests.map(r => r.priority)}::int[]) AS r(page_id, lo, hi, prio)
    ), auth AS (
      SELECT p.id, p.slug, p.source_id, p.type, p.knowledge_revision::text AS revision, p.compiled_truth, p.timeline,
             (COALESCE(p.chunker_version, 0) >= ${SAFE_FENCE_CHUNKER_VERSION}) AS sealed,
             (SELECT MIN(req.prio) FROM req WHERE req.page_id = p.id) AS prio
        FROM pages p
        JOIN sources s ON s.id = p.source_id
       WHERE p.id = ANY(${[...new Set(requests.map(r => r.page_id))]}::int[]) ${scopeSql}
         AND p.deleted_at IS NULL AND ${trustedSql(currentTextProjectionFilter('p'))} AND NOT s.archived
         AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)} ${privateSql} ${safeSql}
    ), chunk_rows AS (
      SELECT cc.page_id, cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source, a.prio
        FROM auth a
        JOIN content_chunks cc ON cc.page_id = a.id
       WHERE a.sealed
         AND cc.chunk_source = ANY(${opts.chunkSources}::text[])
         AND COALESCE(cc.modality, 'text') = 'text'
         AND EXISTS (SELECT 1 FROM req r WHERE r.page_id = cc.page_id AND cc.chunk_index BETWEEN r.lo AND r.hi)
       ORDER BY a.prio, cc.page_id, cc.chunk_index
       LIMIT ${maxRows + 1}
    )
    SELECT 'page' AS kind, a.id AS page_id, a.slug, a.source_id, a.type, a.revision, a.sealed, a.prio,
           (SELECT MAX(c2.chunk_index) FROM content_chunks c2 WHERE c2.page_id = a.id) AS max_chunk_index,
           a.compiled_truth, a.timeline,
           NULL::int AS chunk_id, NULL::int AS chunk_index, NULL::text AS chunk_text, NULL::text AS chunk_source
      FROM auth a
    UNION ALL
    SELECT 'chunk' AS kind, c.page_id, NULL, NULL, NULL, NULL, NULL, c.prio,
           NULL, NULL, NULL, c.chunk_id, c.chunk_index, c.chunk_text, c.chunk_source
      FROM chunk_rows c
  `);
  return mapChunkWindowRows(rows, maxRows);
}

export async function getChunksWithEmbeddings(exec: LegacyUnscopedRead, slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }): Promise<Chunk[]> {
    const sourceId = opts?.sourceId;
    const projection = trustedSql(opts?.includeUnsealed ? 'TRUE' : currentTextProjectionFilter('p'));
    const { rows } = sourceId
      ? await exec.run(sqlFragment`
          SELECT cc.* FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE ${projection} AND p.slug = ${slug} AND p.source_id = ${sourceId}
          ORDER BY cc.chunk_index
        `)
      : await exec.run(sqlFragment`
          SELECT cc.* FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE ${projection} AND p.slug = ${slug}
          ORDER BY cc.chunk_index
        `);
    return rows.map((r) => rowToChunk(r, true));
  }
