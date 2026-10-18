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
import type { EmbeddingState, EmbeddingStateCounts, EmbeddingStateRow } from '../embedding-state.ts';
import type { Chunk, ChunkInput, ChunklessPageRow, ResolvedColumn, StaleChunkRow } from '../types.ts';
import { rowToChunk, validateSlug } from '../utils.ts';
import { createHash } from 'node:crypto';
import { jsonRowBatches, sanitizeText } from '../batch-rows.ts';
import {
  normalizeEngineColumn,
  vectorCastSuffix,
  resolveWriteColumnFromConfigRows,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from '../search/embedding-column.ts';
import { chunkDocumentOrder, chunkGenerationFilter, chunkManifestJoin, chunkVisibleFilter, chunkWriteInvalidations, currentTextProjectionFilter, movableChunkSql, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { splitEmbeddingSignature, lockEmbeddingSources } from '../embedding-invalidation.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from '../embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import { pageBudgetLimitedFilter } from '../page-size-policy.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { mapChunkWindowRows, type ChunkWindowOpts, type ChunkWindowPage, type ChunkWindowRequest } from '../search/chunk-windows.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead, ScopedRead } from './brands.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { pipelined } from '../page-state/transactions.ts';
import { compileRowNormalizer } from './normalize.ts';

/** The engine's page-state guards, run on the same (transaction) engine. */
export interface ChunkPageGuards {
  lockPageKeys(keys: readonly PageKey[]): Promise<void>;
  readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null>;
  /** #5984: shares a config read across one page transaction (the engine's `transactionMemo`). */
  memo?<T>(key: string, read: () => Promise<T>): Promise<T>;
}

/**
 * The engine's `transaction()`. The invalidations run their source lock and
 * UPDATE through the transaction clone's own `executeRaw`, exactly as master
 * did (raw gauge, and the clone's `executeRaw` is the seam callers observe).
 */
export type ChunkTransactionRunner = <T>(fn: (tx: Pick<BrainEngine, 'executeRaw'>) => Promise<T>) => Promise<T>;

type StaleChunkOpts = { sourceId?: string; signature?: string; includeNullSignature?: boolean };

/** Held or capped large pages (page-embedding-budget.ts) leave the embedding queue while the hold applies. */
const budgetLimited = trustedSql(pageBudgetLimitedFilter('p'));

export async function upsertChunksOnce(
  exec: SqlExecutor,
  guards: ChunkPageGuards,
  slug: string,
  chunks: ChunkInput[],
  opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true },
): Promise<void> {
    const memo = guards.memo ?? (<T>(_key: string, read: () => Promise<T>) => read());
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
    // #5984: `sealChunkerVersion` is a complete replacement: the caller deleted
    // every chunk of the page earlier in this transaction, so nothing stale can
    // remain, and the seal (which also locks the page row and yields its id)
    // commits only together with the insert below.
    // #5984: a seal whose caller knows the page id (`pageId`, its own write of the page in
    // this transaction) is sent in one pipeline with the insert and checked after both ran.
    const seal = opts?.sealChunkerVersion;
    // The config reads the insert below needs go out with the page lookup (one round trip on Postgres).
    let gatewayModel: string | null = null;
    try {
      // Keep the gateway lazy so module-load failure remains inside this soft
      // fallback boundary; eager evaluation would bypass the config-row fallback.
      const gw = await import('../ai/gateway.ts'); // engine-dynamic-import-ok
      gatewayModel = gw.getEmbeddingModelProvenance();
    } catch {}
    const writesRows = chunks.length > 0;
    // #6712 L6: the column and model keys are one statement (a round trip where pipelining is off).
    const configRows = writesRows && (!opts?.embeddingColumn || !gatewayModel) ? memo('config:embedding-write', async () =>
      (await exec.run<{ key: string; value: string }>(sqlFragment`SELECT key, value FROM config WHERE key IN ('search_embedding_column', 'embedding_columns', 'embedding_model')`)).rows)
      .then(rows => rows, () => null) : undefined;
    const columnRows = opts?.embeddingColumn ? undefined : configRows;
    const modelRows = gatewayModel ? undefined : configRows?.then(rows => rows && rows.filter(row => row.key === 'embedding_model'));
    const sealed = seal !== undefined && opts?.pageId !== undefined && chunks.length > 0 ? opts.pageId : undefined;
    const sealPage = () => exec.run<{ id: number }>(sqlFragment`UPDATE pages SET chunker_version = ${seal} WHERE slug = ${slug} AND source_id = ${sourceId} RETURNING id`);
    const pages = sealed !== undefined ? [{ id: sealed }] : (await (seal === undefined
      ? exec.run<{ id: number }>(sqlFragment`SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId} FOR UPDATE`)
      : sealPage())).rows;
    if (pages.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const pageId = pages[0].id;

    if (seal === undefined) {
      // A fragment write cannot certify the full-body fence boundary. Import seals
      // only after its complete replacement succeeds in the same transaction.
      for (const invalidation of chunkWriteInvalidations(pageId, chunks)) {
        if ((await exec.unsafe(invalidation.sql, invalidation.params)).rows.length > 0) break;
      }
      if (chunks.length === 0) {
        await exec.run(sqlFragment`DELETE FROM content_chunks WHERE page_id = ${pageId}`);
        return;
      }
    } else if (chunks.length === 0) return;

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
      // A null read (config table unreadable) leaves the legacy column via the resolver default.
      for (const r of await columnRows ?? []) {
        if (r.key === 'search_embedding_column') searchEmbeddingColumn = r.value;
        else if (r.key === 'embedding_columns') embeddingColumnsJson = r.value;
      }
      writeCol = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn, embeddingColumnsJson });
    }
    const writeColId = quoteIdentifier(writeCol.name);
    const writeCast = vectorCastSuffix(writeCol);
    const col = trustedSql(writeColId);
    // Prune once, before any insert batch: a later batch never deletes an earlier one.
    if (seal === undefined) await moveDisplacedChunksAndPrune(exec, pageId, chunks, writeColId);

    // #4246: embedded_text_hash records md5(chunk_text) AT EMBED TIME so a
    // later text rewrite that keeps the vector is detectable as content
    // drift (invalidateContentDriftEmbeddings). NULL when no embedding lands.
    const cols = `(page_id, chunk_index, chunk_text, chunk_source, ${writeColId}, model, token_count, embedded_at, embedded_text_hash, embedding_input_hash, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified, modality, embedding_image, embedding_pending_since, projected_byte_start, projected_byte_end)`;
    let resolvedModel: string | null = gatewayModel;
    if (!resolvedModel) resolvedModel = (await modelRows)?.[0]?.value ?? null;
    resolvedModel = writeCol.embeddingModel || resolvedModel;
    if (!resolvedModel && chunks.some(chunk => chunk.embedding && !chunk.model)) {
      throw new Error('Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.');
    }
    if (!resolvedModel) resolvedModel = 'unconfigured';

    // #5984: one statement text per brain whatever the chunk count (each batch binds as one
    // JSON document), so a prepared connection pays no describe round trip per page.
    // A3: rows are encoded one bounded batch at a time (jsonRowBatches), never the whole page.
    const batches = jsonRowBatches(chunks, chunk => {
      const embedding = chunk.embedding ? '[' + Array.from(chunk.embedding).join(',') + ']' : null;
      return {
        chunk_index: chunk.chunk_index,
        // Already normalized before the seal snapshot. Both storage and the
        // embedded_text_hash input must use those same canonical bytes.
        chunk_text: chunk.chunk_text,
        chunk_source: chunk.chunk_source ?? null,
        embedding,
        model: chunk.model || resolvedModel,
        token_count: chunk.token_count || null,
        // #5553: embedding-input provenance travels only with the vector it describes.
        embedding_input_hash: embedding ? chunk.embedding_input_hash ?? null : null,
        language: chunk.language || null,
        symbol_name: chunk.symbol_name || null,
        symbol_type: chunk.symbol_type || null,
        start_line: chunk.start_line ?? null,
        end_line: chunk.end_line ?? null,
        parent_symbol_path: chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0 ? chunk.parent_symbol_path : null,
        doc_comment: chunk.doc_comment || null,
        symbol_name_qualified: chunk.symbol_name_qualified || null,
        modality: chunk.modality ?? 'text',
        embedding_image: chunk.embedding_image ? '[' + Array.from(chunk.embedding_image).join(',') + ']' : null,
        projected_byte_start: chunk.projected_byte_start ?? null,
        projected_byte_end: chunk.projected_byte_end ?? null,
      };
    });

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
    // #4246: embedded_text_hash is md5(chunk_text) in SQL (not JS) so stamp + drift
    // comparison share ONE md5 implementation; it, embedded_at and the input hash
    // are set only when the row carries a vector.
    //
    // embedding_pending_since follows the vector that wins: NULL when one
    // lands, kept while the row stays without one, now() when this write
    // NULLs it (doctor ages the embedding backlog from it).
    const insertBatch = (json: string) => renderFragment(sqlFragment`INSERT INTO content_chunks ${trustedSql(cols)}
       SELECT ${pageId}::int, c.chunk_index, c.chunk_text, c.chunk_source, c.embedding${trustedSql(writeCast)}, c.model, c.token_count,
         CASE WHEN c.embedding IS NULL THEN NULL ELSE now() END,
         CASE WHEN c.embedding IS NULL THEN NULL ELSE md5(c.chunk_text) END,
         c.embedding_input_hash, c.language, c.symbol_name, c.symbol_type, c.start_line, c.end_line,
         c.parent_symbol_path, c.doc_comment, c.symbol_name_qualified, c.modality, c.embedding_image::vector,
         CASE WHEN c.embedding IS NULL THEN now() ELSE NULL END,
         c.projected_byte_start, c.projected_byte_end
       FROM jsonb_to_recordset(${json}::text::jsonb) AS c(chunk_index int, chunk_text text, chunk_source text,
         embedding text, model text, token_count int, embedding_input_hash text, language text, symbol_name text, symbol_type text,
         start_line int, end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text, modality text, embedding_image text,
         projected_byte_start bigint, projected_byte_end bigint)
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
         projected_byte_start = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.projected_byte_start ELSE COALESCE(EXCLUDED.projected_byte_start, content_chunks.projected_byte_start) END,
         projected_byte_end = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.projected_byte_end ELSE COALESCE(EXCLUDED.projected_byte_end, content_chunks.projected_byte_end) END,
         embedding_image = COALESCE(EXCLUDED.embedding_image, content_chunks.embedding_image),
         embedding_pending_since = CASE
           WHEN EXCLUDED.${col} IS NOT NULL THEN NULL
           WHEN content_chunks.${col} IS NULL THEN COALESCE(content_chunks.embedding_pending_since, now())
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN now()
           ELSE content_chunks.embedding_pending_since
         END`);
    const write = (json: string) => { const { text, params } = insertBatch(json); return exec.query(text, params); };
    // Every batch runs in the caller's transaction, so a failure in any batch rolls back the whole replacement.
    const first = batches.next().value as string;
    if (sealed === undefined || opts?.deferSeal) await write(first);
    else {
      const [{ rows }] = await pipelined({ kind: exec.dialect }, [sealPage, () => write(first)]) as [{ rows: Array<{ id: number }> }];
      if (rows.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
      if (Number(rows[0]!.id) !== Number(sealed)) throw new Error(`Page ${slug} (source=${sourceId}) is not the page this transaction wrote`);
    }
    for (const json of batches) await write(json);
  }

/**
 * A4: content-keyed reuse for a write that replaces a page's chunks in place
 * (the rebuild paths), then the one prune of the write. A stored row follows
 * its exact chunk (source and text), not its index: each movable row whose
 * chunk the new set holds at another index, where that index does not already
 * hold it, moves there with its id, vector, metadata, timestamps and #5553
 * input provenance, so a top insert keeps the vectors (and code edges) of
 * shifted chunks instead of re-embedding them. A legacy vector without a text
 * hash never moves. Rows park at negative indices, rows that
 * left the set or sit on a move target are deleted, and the parked rows land;
 * the insert batches then find their text unchanged and keep the vector under
 * the D24 rule. Validity against the page context stays with the caller
 * (installPageProjection nulls vectors whose recorded input no longer matches
 * before it writes; the recorded input does not depend on the index).
 */
async function moveDisplacedChunksAndPrune(exec: SqlExecutor, pageId: number, chunks: ChunkInput[], writeColId: string): Promise<void> {
  const newIndices = chunks.map(c => c.chunk_index);
  // chunk-visibility-ok: inline projection write path (upsertChunks); segmented pages stage rows through stageSegmentChunks
  const { rows } = await exec.run<{ id: number; chunk_index: number; chunk_source: string | null; text_md5: string; movable: boolean }>(sqlFragment`
    SELECT id, chunk_index, chunk_source, md5(chunk_text) AS text_md5, ${trustedSql(movableChunkSql(writeColId))} AS movable
    FROM content_chunks WHERE page_id = ${pageId} ORDER BY chunk_index`);
  const key = (source: string | null | undefined, md5: string) => JSON.stringify([source ?? null, md5]);
  const incoming = new Map(rows.some(r => r.movable) ? chunks.map(c => [c.chunk_index, key(c.chunk_source, createHash('md5').update(c.chunk_text).digest('hex'))]) : []);
  const candidates = new Map<string, Array<{ id: number }>>();
  for (const row of rows.filter(r => r.movable)) {
    const own = key(row.chunk_source, row.text_md5);
    if (incoming.get(Number(row.chunk_index)) === own) continue;
    const queue = candidates.get(own);
    if (queue) queue.push({ id: Number(row.id) });
    else candidates.set(own, [{ id: Number(row.id) }]);
  }
  const held = new Map(rows.map(row => [Number(row.chunk_index), key(row.chunk_source, row.text_md5)]));
  const ids: number[] = [];
  const targets: number[] = [];
  for (const [index, wanted] of incoming) {
    if (held.get(index) === wanted) continue;
    const row = candidates.get(wanted)?.shift();
    if (row) { ids.push(row.id); targets.push(index); }
  }
  if (ids.length === 0) {
    await exec.run(sqlFragment`DELETE FROM content_chunks WHERE page_id = ${pageId} AND chunk_index != ALL(${newIndices})`);
    return;
  }
  await exec.run(sqlFragment`UPDATE content_chunks c SET chunk_index = -1 - m.target
    FROM unnest(${ids}::int[], ${targets}::int[]) AS m(id, target) WHERE c.page_id = ${pageId} AND c.id = m.id`);
  await exec.run(sqlFragment`DELETE FROM content_chunks WHERE page_id = ${pageId} AND chunk_index >= 0
    AND (chunk_index != ALL(${newIndices}) OR chunk_index = ANY(${targets}::int[]))`);
  await exec.run(sqlFragment`UPDATE content_chunks SET chunk_index = -1 - chunk_index WHERE page_id = ${pageId} AND chunk_index < 0`);
}

/** The by-slug chunk read predicate shared by getChunks and getChunkPage: scope, privacy, sealed text and live body generation, safe chunks. */
function chunkReadWhere(
  slug: string,
  scope: { sourceIds?: string[]; sourceId: string },
  opts?: { excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean; chunkManifest?: boolean },
): SqlFragment {
  const scopeSql = scope.sourceIds
    ? sqlFragment`p.source_id = ANY(${scope.sourceIds}::text[])`
    : sqlFragment`p.source_id = ${scope.sourceId}`;
  return sqlFragment`p.slug = ${slug} AND ${scopeSql}
          ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('p')}`) : sqlFragment``}
          AND ${trustedSql(opts?.includeUnsealed ? chunkGenerationFilter('p', 'cc', opts.chunkManifest ?? true) : chunkVisibleFilter('p', 'cc'))}
          ${requiresSafeChunks(opts) ? trustedSql(`AND ${safeChunksFilter('p')}`) : sqlFragment``}`;
}

export async function getChunks(
  exec: ScopedRead,
  column: string,
  slug: string,
  scope: { sourceIds?: string[]; sourceId: string },
  opts?: { includeEmbedding?: boolean; excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean; chunkManifest?: boolean; indexRange?: { from: number; to: number; ordinal?: boolean } },
): Promise<Chunk[]> {
      const colId = trustedSql(quoteIdentifier(column));
      const includeEmbedding = opts?.includeEmbedding === true;
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
      const columns = sqlFragment`cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
               cc.model, cc.token_count, cc.embedded_at, cc.language,
               cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
               cc.parent_symbol_path, cc.doc_comment, cc.symbol_name_qualified, cc.modality,
               cc.projected_byte_start, cc.projected_byte_end,
               (cc.${colId} IS NULL) AS embedding_is_null
               ${embedCol}`;
      const from = sqlFragment`FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        ${trustedSql(chunkManifestJoin('p', 'cc', 'm', opts?.chunkManifest ?? true))}
        WHERE ${chunkReadWhere(slug, scope, opts)}`;
      const order = trustedSql(chunkDocumentOrder('cc', 'm'));
      const range = opts?.indexRange;
      if (range?.ordinal) {
        const { rows } = await exec.run(sqlFragment`
          SELECT * FROM (
            SELECT ${columns},
                   (row_number() OVER (PARTITION BY cc.page_id ORDER BY ${order}) - 1)::int AS page_position,
                   row_number() OVER (ORDER BY ${order}) AS document_position
            ${from}
          ) r
          WHERE r.page_position >= ${range.from} AND r.page_position < ${range.to}
          ORDER BY r.document_position
        `);
        return rows.map((r) => rowToChunk(r, includeEmbedding));
      }
      const { rows } = await exec.run(sqlFragment`
        SELECT ${columns}
        ${from}
          ${range ? sqlFragment`AND cc.chunk_index >= ${range.from} AND cc.chunk_index < ${range.to}` : sqlFragment``}
        ORDER BY ${order}
      `);
      return rows.map((r) => rowToChunk(r, includeEmbedding));
  }

/**
 * One page of a page's chunks for get_chunks: the chunks whose chunk_index
 * falls in [fromIndex, fromIndex + limit) under the same predicate getChunks
 * applies, plus the count of every chunk that predicate admits and the
 * highest chunk_index, so the caller knows whether more remain. A range,
 * not a row LIMIT, so a slug that matches one page in each of two federated
 * sources never splits a chunk_index between two calls. A segmented page's
 * chunk_index is an insertion sequence, so its range is over positions in
 * document order instead (`fromIndex` and `max_chunk_index` are positions).
 */
export async function getChunkPage(
  exec: ScopedRead,
  column: string,
  slug: string,
  scope: { sourceIds?: string[]; sourceId: string },
  opts: { fromIndex: number; limit: number; excludePrivate?: boolean; requireSafeChunks?: boolean; chunkManifest?: boolean },
): Promise<{ chunks: Chunk[]; total_chunks: number; max_chunk_index: number | null }> {
      const { rows } = await exec.run<{ total: number | string; max_index: number | null; segmented: boolean | null; max_page_chunks: number | string | null }>(sqlFragment`
        SELECT COALESCE(sum(t.n), 0) AS total, max(t.max_index) AS max_index, bool_or(t.segmented) AS segmented, max(t.n) AS max_page_chunks
        FROM (
          SELECT count(*) AS n, max(cc.chunk_index) AS max_index, bool_or(cc.body_generation IS NOT NULL) AS segmented
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE ${chunkReadWhere(slug, scope, opts)}
          GROUP BY cc.page_id
        ) t
      `);
      const segmented = rows[0]?.segmented === true;
      const chunks = await getChunks(exec, column, slug, scope, { ...opts, indexRange: { from: opts.fromIndex, to: opts.fromIndex + opts.limit, ordinal: segmented } });
      const maxIndex = segmented ? Number(rows[0]?.max_page_chunks) - 1 : rows[0]?.max_index == null ? null : Number(rows[0].max_index);
      return { chunks, total_chunks: Number(rows[0]?.total ?? 0), max_chunk_index: maxIndex };
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
  const conds: SqlFragment[] = [sqlFragment`p.deleted_at IS NULL`, sqlFragment`${trustedSql(chunkGenerationFilter('p', 'cc'))}`];
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
  // Large pages held for approval or at their spend cap (page-embedding-budget.ts) leave the queue until it changes or the page is no longer large.
  conds.push(sqlFragment`NOT ${budgetLimited}`);
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
            SET ${colId} = NULL, embedded_at = NULL, embedding_pending_since = now()
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
            SET ${colId} = NULL, embedded_at = NULL, embedded_text_hash = NULL, embedding_pending_since = now()
           FROM pages p
          WHERE cc.page_id = p.id
            AND p.source_id=ANY(${sources}::text[])
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
            AND p.deleted_at IS NULL
            AND cc.${colId} IS NOT NULL
            AND cc.embedded_text_hash IS NOT NULL
            AND cc.embedded_text_hash <> md5(cc.chunk_text)
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}${srcClause}
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
    const generation = trustedSql(chunkGenerationFilter('p', 'cc'));

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
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT ${limit}
          `) : read(sqlFragment`
            SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                   cc.model, cc.token_count, p.source_id, cc.page_id,
                   p.updated_at
            FROM content_chunks cc
            JOIN pages p ON p.id = cc.page_id
            WHERE cc.${staleColId} IS NULL AND p.deleted_at IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
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
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
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
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
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
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
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
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}
              AND ${generation}
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
    // something to heal even with compiled_truth = ''. A segmented page's
    // body columns are NULL; its body_bytes says it has one.
    sqlFragment`(p.compiled_truth <> '' OR p.timeline <> '' OR (p.body_storage = 'segmented' AND p.body_bytes > 0))`,
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

/** Every embedding state, in report order (re-exported by src/core/embedding-state.ts). */
export const EMBEDDING_STATES: readonly EmbeddingState[] = ['embedded', 'pending', 'keyword_only', 'quarantined', 'empty', 'deleted_page_chunks', 'chunkless_healable'];

/**
 * #6696 B3 embedding-state classifier (contract in src/core/embedding-state.ts).
 * A chunk's state, by precedence: soft-deleted page, quarantined page, a
 * vector in the ACTIVE column, the embed job's own predicate
 * (`staleChunkWhere`, so `pending` can never drift from what `embed --stale`
 * selects), else a vector-less chunk on an embed_skip page.
 */
function chunkEmbeddingState(column: string): SqlFragment {
  const colRef = trustedSql(`cc.${quoteIdentifier(column)}`);
  return sqlFragment`CASE
      WHEN p.deleted_at IS NOT NULL THEN 'deleted_page_chunks'
      WHEN NOT ${trustedSql(QUARANTINE_FILTER_FRAGMENT)} THEN 'quarantined'
      WHEN ${colRef} IS NOT NULL THEN 'embedded'
      WHEN ${staleChunkWhere(column)} THEN 'pending'
      ELSE 'keyword_only' END`;
}

/** A live page with no chunk row: gated (quarantine, embed_skip), healable (`chunklessPagesWhere`), else empty. */
function chunklessPageState(): SqlFragment {
  return sqlFragment`CASE
      WHEN NOT ${trustedSql(QUARANTINE_FILTER_FRAGMENT)} THEN 'quarantined'
      WHEN NOT ${trustedSql(EMBED_SKIP_FILTER_FRAGMENT)} THEN 'keyword_only'
      WHEN ${chunklessPagesWhere()} THEN 'chunkless_healable'
      ELSE 'empty' END`;
}

function embeddingStateScope(sourceIds?: string[]): SqlFragment {
  return sourceIds ? sqlFragment` AND p.source_id = ANY(${sourceIds}::text[])` : sqlFragment``;
}

const NO_CHUNK_ROWS = sqlFragment`NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)`;
const MARKER_BYTES = sqlFragment`CASE WHEN jsonb_typeof(p.frontmatter -> 'embed_skip' -> 'bytes') = 'number'
      THEN (p.frontmatter -> 'embed_skip' ->> 'bytes')::numeric::bigint END`;

const normalizeStateCount = compileRowNormalizer<{ state: EmbeddingState; n: number; eligible: number; overdue: number; unstamped: number; unstamped_min: Date | null }>(
  { n: 'bigint', eligible: 'bigint', overdue: 'bigint', unstamped: 'bigint', unstamped_min: 'date' });
const normalizeEmbedSkip = compileRowNormalizer<{ pages: number; marker_bytes: number; chunkless: number }>({ pages: 'bigint', marker_bytes: 'bigint', chunkless: 'bigint' });

/**
 * Counts per embedding state. `full`: two exact aggregates (every chunk, every
 * chunkless live page). `ops`: only index-backed reads, and `basis: 'unknown'`
 * when no valid partial index on content_chunks has the predicate
 * `<active column> IS NULL` (never a slow scan): the vector-less chunks through
 * that index, quarantined and embed_skip pages through the frontmatter GIN
 * index, deleted pages through the purge index, and `embedded` as the
 * planner's row estimate; `empty` and `chunkless_healable` need an anti-join
 * over every live page and are omitted.
 */
export async function readEmbeddingStateCounts(exec: ScopedRead, column: string,
  opts: { mode: 'ops' | 'full'; sourceIds?: string[]; purgeWindowHours: number }): Promise<EmbeddingStateCounts> {
  const scope = embeddingStateScope(opts.sourceIds);
  const colRef = trustedSql(`cc.${quoteIdentifier(column)}`);
  let coveringIndex: string | null = null;
  if (opts.mode === 'ops') {
    const { rows } = await exec.run<{ name: string }>(sqlFragment`
      SELECT ic.relname AS name
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE t.relname = 'content_chunks' AND n.nspname = current_schema()
         AND i.indisvalid AND i.indpred IS NOT NULL
         AND pg_get_expr(i.indpred, i.indrelid) = '(' || quote_ident(${column}) || ' IS NULL)'
       ORDER BY ic.relname LIMIT 1`);
    coveringIndex = rows[0]?.name ?? null;
    if (!coveringIndex) {
      return { active_column: column, basis: 'unknown', covering_index: null, counts: {}, omitted: [], eligible_embedded: null,
        deleted_overdue: 0, embed_skip_pages: 0, embed_skip_marker_bytes: 0, unstamped_pending: 0, unstamped_created_at_min: null };
    }
  }
  const counts: Partial<Record<EmbeddingState, number>> = {};
  const add = (state: EmbeddingState, n: number) => { counts[state] = (counts[state] ?? 0) + n; };
  const overdue = sqlFragment`(p.deleted_at < now() - make_interval(hours => ${opts.purgeWindowHours}::int))`;
  const aggregate = (where: SqlFragment) => exec.run(sqlFragment`
      SELECT s.state, count(*)::bigint AS n, count(*) FILTER (WHERE s.eligible)::bigint AS eligible,
             count(*) FILTER (WHERE s.overdue)::bigint AS overdue,
             count(*) FILTER (WHERE s.unstamped)::bigint AS unstamped,
             min(s.created_at) FILTER (WHERE s.unstamped) AS unstamped_min
        FROM (SELECT ${chunkEmbeddingState(column)} AS state, ${trustedSql(EMBED_SKIP_FILTER_FRAGMENT)} AS eligible,
                     COALESCE(${overdue}, false) AS overdue, cc.embedding_pending_since IS NULL AS unstamped, cc.created_at
                FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
               WHERE ${where} AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}${scope}) s
       GROUP BY s.state`);
  const chunkRows = (await aggregate(opts.mode === 'ops' ? sqlFragment`${colRef} IS NULL` : sqlFragment`TRUE`)).rows.map(row => normalizeStateCount(row));
  let pendingUnstamped = 0;
  let unstampedMin: Date | null = null;
  let eligibleEmbedded = 0;
  let deletedOverdue = 0;
  for (const row of chunkRows) {
    if (row.state === 'pending') { pendingUnstamped = row.unstamped; unstampedMin = row.unstamped_min; }
    if (row.state === 'embedded') eligibleEmbedded = row.eligible;
    if (opts.mode === 'ops' && (row.state === 'quarantined' || row.state === 'deleted_page_chunks')) continue;
    if (row.state === 'deleted_page_chunks') deletedOverdue = row.overdue;
    add(row.state, row.n);
  }
  const embedSkip = normalizeEmbedSkip((await exec.run(sqlFragment`
      SELECT count(*)::bigint AS pages, COALESCE(sum(${MARKER_BYTES}), 0)::bigint AS marker_bytes,
             count(*) FILTER (WHERE ${NO_CHUNK_ROWS})::bigint AS chunkless
        FROM pages p
       WHERE p.frontmatter ? 'embed_skip' AND p.deleted_at IS NULL AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}${scope}`)).rows[0] ?? {});
  const base = { active_column: column, covering_index: coveringIndex, embed_skip_pages: embedSkip.pages ?? 0, embed_skip_marker_bytes: embedSkip.marker_bytes ?? 0,
    unstamped_pending: pendingUnstamped, unstamped_created_at_min: unstampedMin };
  if (opts.mode === 'full') {
    const { rows } = await exec.run(sqlFragment`
      SELECT s.state, count(*)::bigint AS n
        FROM (SELECT ${chunklessPageState()} AS state FROM pages p WHERE p.deleted_at IS NULL AND ${NO_CHUNK_ROWS}${scope}) s
       GROUP BY s.state`);
    for (const row of rows) add(row.state as EmbeddingState, Number(row.n));
    for (const state of EMBEDDING_STATES) counts[state] ??= 0;
    return { ...base, basis: 'exact', counts, omitted: [], eligible_embedded: eligibleEmbedded, deleted_overdue: deletedOverdue };
  }
  add('keyword_only', embedSkip.chunkless ?? 0);
  const quarantined = await exec.run(sqlFragment`
      SELECT COALESCE(sum(GREATEST((SELECT count(*) FROM content_chunks cc WHERE cc.page_id = p.id), 1)), 0)::bigint AS n
        FROM pages p
       WHERE p.frontmatter ? 'quarantine' AND p.deleted_at IS NULL${scope}`);
  counts.quarantined = Number(quarantined.rows[0]?.n ?? 0);
  const deleted = await exec.run(sqlFragment`
      SELECT count(*)::bigint AS n, count(*) FILTER (WHERE ${overdue})::bigint AS overdue
        FROM pages p JOIN content_chunks cc ON cc.page_id = p.id
       WHERE p.deleted_at IS NOT NULL${scope}`);
  counts.deleted_page_chunks = Number(deleted.rows[0]?.n ?? 0);
  const plan = await exec.run<{ 'QUERY PLAN': unknown }>(sqlFragment`
      EXPLAIN (FORMAT JSON) SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE ${colRef} IS NOT NULL AND p.deleted_at IS NULL AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}${scope}`);
  counts.embedded = plannerRows(plan.rows[0]?.['QUERY PLAN']);
  for (const state of ['pending', 'keyword_only'] as const) counts[state] ??= 0;
  return { ...base, basis: 'estimated', counts, omitted: ['empty', 'chunkless_healable'], eligible_embedded: null,
    deleted_overdue: Number(deleted.rows[0]?.overdue ?? 0) };
}

/** `EXPLAIN (FORMAT JSON)`'s top-level row estimate (postgres.js parses json; PGLite may hand back text). */
function plannerRows(plan: unknown): number {
  const parsed = typeof plan === 'string' ? JSON.parse(plan) as unknown : plan;
  const rows = Array.isArray(parsed) ? (parsed[0] as { Plan?: { 'Plan Rows'?: unknown } } | undefined)?.Plan?.['Plan Rows'] : undefined;
  return typeof rows === 'number' && Number.isFinite(rows) ? Math.max(0, Math.round(rows)) : 0;
}

const normalizeStateRow = compileRowNormalizer<EmbeddingStateRow>({ chunks: 'bigint', bytes: 'bigint', marker_bytes: 'bigint', deleted_at: 'date' });

/**
 * One row per (page, state) in `states`, ordered (state, source_id, slug):
 * a page whose chunks sit in two states (some embedded, some pending) yields
 * two rows; a page with no chunk row yields one row with `chunks: 0` and its
 * body bytes. Exact (full scan); the caller passes `limit` (one more than it
 * prints, to report completeness).
 */
export async function listEmbeddingStateRows(exec: ScopedRead, column: string,
  opts: { sourceIds?: string[]; states: readonly EmbeddingState[]; limit: number; purgeWindowHours: number }): Promise<EmbeddingStateRow[]> {
  const scope = embeddingStateScope(opts.sourceIds);
  const { rows } = await exec.run(sqlFragment`
    SELECT r.slug, r.source_id, r.state, r.chunks, r.bytes, r.embed_skip_reason, r.marker_bytes, r.quarantine_reason, r.deleted_at, r.overdue
      FROM (
        SELECT p.slug, p.source_id, ${chunkEmbeddingState(column)} AS state, count(*)::bigint AS chunks,
               COALESCE(sum(octet_length(cc.chunk_text)), 0)::bigint AS bytes,
               p.frontmatter -> 'embed_skip' ->> 'reason' AS embed_skip_reason, ${MARKER_BYTES} AS marker_bytes,
               p.frontmatter -> 'quarantine' ->> 'reason' AS quarantine_reason, p.deleted_at,
               COALESCE(p.deleted_at < now() - make_interval(hours => ${opts.purgeWindowHours}::int), false) AS overdue
          FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE ${trustedSql(chunkGenerationFilter('p', 'cc'))}${scope}
         GROUP BY p.id, 3
        UNION ALL
        SELECT p.slug, p.source_id, ${chunklessPageState()}, 0::bigint,
               (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')))::bigint,
               p.frontmatter -> 'embed_skip' ->> 'reason', ${MARKER_BYTES},
               p.frontmatter -> 'quarantine' ->> 'reason', p.deleted_at, false
          FROM pages p
         WHERE p.deleted_at IS NULL AND ${NO_CHUNK_ROWS}${scope}
      ) r
     WHERE r.state = ANY(${[...opts.states]}::text[])
     ORDER BY r.state, r.source_id, r.slug
     LIMIT ${opts.limit}`);
  return rows.map(row => normalizeStateRow(row));
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
 * Decodes pgvector's binary send format (`vector_send`): int16 dimensions,
 * int16 unused, then big-endian float4 values. Both drivers return the bytea
 * as a Uint8Array (postgres.js a Buffer). The float4 values are the stored
 * ones, bit for bit the Float32Array the text literal parses to
 * (`test/engine-sql-chunks.test.ts` pins it on a real engine); a malformed
 * value decodes to null and the row is skipped.
 */
export function decodeVectorSend(value: unknown): Float32Array | null {
  if (!(value instanceof Uint8Array) || value.byteLength < 4) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const dimensions = view.getInt16(0);
  if (value.byteLength !== 4 + 4 * dimensions) return null;
  const embedding = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) embedding[i] = view.getFloat32(4 + 4 * i);
  return embedding;
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
    // Binary transfer (`vector_send`, halfvec cast exactly to vector): the
    // text literal cost about 3x more in vector_out formatting, wire bytes and
    // parsing than the TOAST read itself, for the same float4 values.
    const quotedCol = trustedSql(quoteIdentifier(column));
    const { text, params } = renderFragment(sqlFragment`
      SELECT cc.id, vector_send(cc.${quotedCol}::vector) AS embedding FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE cc.id = ANY(${ids}::int[]) AND cc.${quotedCol} IS NOT NULL AND ${trustedSql(chunkVisibleFilter('p', 'cc'))}
    `);
    const { rows } = await exec.unsafe(text, params);
    const result = new Map<number, Float32Array>();
    for (const row of rows) {
      const embedding = decodeVectorSend(row.embedding);
      if (embedding) result.set(row.id as number, embedding);
    }
    return result;
  }

/**
 * The text-space cosine re-score in SQL (`search/cosine-rescore.ts`): one
 * `(id, cosine)` row per hydrated chunk, the rows `getEmbeddingsByChunkIds`
 * returns (same active column, halfvec read exactly as vector, same
 * visibility). A hydrated vector whose dimensions differ from the query's,
 * or a zero-norm vector or query, scores 0 without reaching the operator, as
 * `cosineSimilarity` does; an absent or invisible chunk returns no row.
 */
export function cosineByChunkIdsStatement(ids: number[], column: string, query: Float32Array): { text: string; params: unknown[] } {
  if (!COLUMN_NAME_REGEX.test(column)) throw new EmbeddingColumnNotRegisteredError(column, []);
  const col = trustedSql(`cc.${quoteIdentifier(column)}`);
  const q = `[${Array.from(query).join(',')}]`;
  return renderFragment(sqlFragment`
    SELECT cc.id, CASE WHEN vector_dims(${col}::vector) <> ${query.length}::int OR vector_norm(${col}::vector) = 0 OR vector_norm(${q}::vector) = 0
                       THEN 0::float8 ELSE 1 - (${col}::vector <=> ${q}::vector) END AS cosine
      FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
     WHERE cc.id = ANY(${ids}::int[]) AND ${col} IS NOT NULL AND ${trustedSql(chunkVisibleFilter('p', 'cc'))}
  `);
}

/**
 * Evidence delivery: ONE batched read of chunk_index windows, keyed by
 * page_id. Every requested page is re-authorized with the search legs'
 * visibility predicate (source scope, deleted, current text projection,
 * archived source, quarantine, private pages, safe chunks); pages that fail
 * are absent. Page rows of inline pages carry the raw body columns (the
 * assembler sanitizes them whole before slicing); a segmented page's row says
 * `segmented` and carries no body, and its chunk rows carry their occurrence
 * and segment-relative projected span, the references the assembler reads
 * windows around (page-body/read-range.ts). Chunk rows (sealed pages only)
 * anchor the hits. Page rows and chunk
 * rows come back in one UNION so the row cap never hides a page's
 * authorization.
 */
export async function getChunkWindows(exec: ScopedRead, requests: ChunkWindowRequest[], opts: ChunkWindowOpts, chunkManifest = true): Promise<ChunkWindowPage[]> {
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
      SELECT p.id, p.slug, p.source_id, p.type, p.knowledge_revision::text AS revision, p.compiled_truth, p.timeline, p.body_storage, p.body_generation,
             p.body_storage = 'segmented' AS segmented, (COALESCE(p.chunker_version, 0) >= ${SAFE_FENCE_CHUNKER_VERSION}) AS sealed,
             (SELECT MIN(req.prio) FROM req WHERE req.page_id = p.id) AS prio
        FROM pages p
        JOIN sources s ON s.id = p.source_id
       WHERE p.id = ANY(${[...new Set(requests.map(r => r.page_id))]}::int[]) ${scopeSql}
         AND p.deleted_at IS NULL AND ${trustedSql(currentTextProjectionFilter('p'))} AND NOT s.archived
         AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)} ${privateSql} ${safeSql}
    ), chunk_rows AS (
      SELECT cc.page_id, cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.projected_byte_start, cc.projected_byte_end, cc.occurrence_id, a.prio
        FROM auth a
        JOIN content_chunks cc ON cc.page_id = a.id
       WHERE a.sealed AND ${trustedSql(chunkGenerationFilter('a', 'cc', chunkManifest))}
         AND cc.chunk_source = ANY(${opts.chunkSources}::text[])
         AND COALESCE(cc.modality, 'text') = 'text'
         AND EXISTS (SELECT 1 FROM req r WHERE r.page_id = cc.page_id AND cc.chunk_index BETWEEN r.lo AND r.hi)
       ORDER BY a.prio, cc.page_id, cc.chunk_index
       LIMIT ${maxRows + 1}
    )
    SELECT 'page' AS kind, a.id AS page_id, a.slug, a.source_id, a.type, a.revision, a.sealed, a.segmented, a.prio,
           (SELECT MAX(c2.chunk_index) FROM content_chunks c2 WHERE c2.page_id = a.id AND ${trustedSql(chunkGenerationFilter('a', 'c2', chunkManifest))}) AS max_chunk_index,
           a.compiled_truth, a.timeline,
           NULL::int AS chunk_id, NULL::int AS chunk_index, NULL::text AS chunk_text, NULL::text AS chunk_source,
           NULL::bigint AS projected_byte_start, NULL::bigint AS projected_byte_end, NULL::bigint AS occurrence_id
      FROM auth a
    UNION ALL
    SELECT 'chunk' AS kind, c.page_id, NULL, NULL, NULL, NULL, NULL, NULL, c.prio,
           NULL, NULL, NULL, c.chunk_id, c.chunk_index, c.chunk_text, c.chunk_source, c.projected_byte_start, c.projected_byte_end, c.occurrence_id
      FROM chunk_rows c
  `);
  return mapChunkWindowRows(rows, maxRows);
}

export async function getChunksWithEmbeddings(exec: LegacyUnscopedRead, slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }): Promise<Chunk[]> {
    const sourceId = opts?.sourceId;
    const projection = trustedSql(opts?.includeUnsealed ? chunkGenerationFilter('p', 'cc') : chunkVisibleFilter('p', 'cc'));
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
