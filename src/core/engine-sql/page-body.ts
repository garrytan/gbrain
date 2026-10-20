/**
 * Segmented page storage (Wave B): one SQL implementation for both engines.
 * Segment texts, the generation-ranged body manifest, staged chunk rows, the
 * generation flip and garbage collection (docs: wave-b spec 1.2, 3.3-3.5, 4.2).
 *
 * Contracts the callers keep:
 * - Every staged manifest row's `staging_id` names a row `openBodyStaging`
 *   recorded; a staging is a GC root while it is open, sealed or prepared, or
 *   while a non-terminal persistence request's `intent.body_ref` names it.
 * - Manifest rows are staged before the chunk rows of their occurrences: a
 *   staged chunk row no live staging's manifest row owns is garbage.
 * - Insert-reference-before-GC: staging a text that already exists refreshes
 *   its `created_at` under the row lock (a concurrent sweep skips the locked
 *   row, then sees it inside the grace window), and the text sweep keeps every
 *   text touched since the oldest live staging of its source opened, so a
 *   text a preparation staged or deduped onto stays until its manifest row
 *   references it, however long publication waits.
 *
 * Statement sizes stay bounded whatever the page size: texts by
 * STAGE_BATCH_BYTES per engine, manifest and chunk rows by `jsonRowBatches`
 * under the same byte bound; the flip touches O(changed rows).
 */
import type { ManifestRow, ManifestRowInput, BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState,
  SegmentChunkInput, SegmentedPageMeta, SegmentSweepOptions, SegmentSweepResult, SegmentTextInput } from '../page-body/types.ts';
import type { ResolvedColumn } from '../types.ts';
import { BODY_STAGING_HARD_MS, BODY_STAGING_IDLE_MS, SEGMENT_TEXT_GC_GRACE_MS, STAGE_BATCH_BYTES } from '../page-body/limits.ts';
import { jsonRowBatches, sanitizeText } from '../batch-rows.ts';
import { normalizeEngineColumn, quoteIdentifier, resolveWriteColumnFromConfigRows, vectorCastSuffix } from '../search/embedding-column.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { validateSlug } from '../utils.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { joinFragments, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { compileRowNormalizer } from './normalize.ts';
import { stagingNeedsTextSql } from '../page-body/schema.ts';
import { RELEASE_STAGED_CTE } from '../persistence/limits.ts';

export const LIVE_STAGING_STATES = ['open', 'sealed', 'prepared'];
const TERMINAL_STAGING_STATES = ['committed', 'aborted', 'expired'];
const NON_TERMINAL_REQUEST_STATES = ['queued', 'running', 'recovering'];

const hex = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
const bytes = (value: unknown): Uint8Array => {
  const view = value as Uint8Array;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
};
const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const stageBatchBytes = (exec: SqlExecutor) => STAGE_BATCH_BYTES[exec.dialect];

/** The staging ids a sweep must keep: live stagings and those a non-terminal request's body_ref names. */
const liveStagingIds = sqlFragment`(SELECT s.id::text FROM page_body_stagings s WHERE s.state = ANY(${LIVE_STAGING_STATES}::text[])
    UNION SELECT r.intent->'body_ref'->>'staging_id' FROM persistence_requests r
     WHERE r.state = ANY(${NON_TERMINAL_REQUEST_STATES}::text[]) AND r.intent->'body_ref'->>'staging_id' IS NOT NULL)`;

export async function allocateBodyOccurrenceIds(exec: SqlExecutor, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const { rows } = await exec.run<{ id: unknown }>(sqlFragment`SELECT nextval('page_body_occurrence_id_seq') AS id FROM generate_series(1, ${count}::int)`);
  return rows.map(row => Number(row.id));
}

/**
 * With `stagingId`, each batch first records its texts under the staging (page_body_staging_texts), so a page purge
 * that runs while the write is unpublished keeps them; recorded before the upsert, a text a purge deleted in between is
 * inserted again by it.
 */
export async function stageSegmentTexts(exec: SqlExecutor, sourceId: string, texts: readonly SegmentTextInput[],
  opts: { stagingId?: string } = {}): Promise<{ inserted: number }> {
  const maxBytes = stageBatchBytes(exec);
  const maxRows = Math.floor(exec.capabilities.maxBindParamsPerStatement / 5);
  let inserted = 0;
  let batch: SqlFragment[] = [];
  let batchShas = new Set<string>();
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    if (opts.stagingId !== undefined) await exec.run(sqlFragment`INSERT INTO page_body_staging_texts (staging_id, source_id, sha256)
      SELECT ${opts.stagingId}::uuid, ${sourceId}, decode(h, 'hex') FROM unnest(${[...batchShas]}::text[]) AS h ON CONFLICT DO NOTHING`);
    const { rows } = await exec.run<{ inserted: boolean }>(sqlFragment`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
      VALUES ${joinFragments(batch, ', ')} ON CONFLICT (source_id, sha256) DO UPDATE SET created_at = now() RETURNING (xmax = 0) AS inserted`);
    inserted += rows.filter(row => row.inserted).length;
    batch = [];
    batchShas = new Set();
    batchBytes = 0;
    await yieldTurn();
  };
  for (const text of texts) {
    const sha = hex(text.sha256);
    if (batchShas.has(sha)) continue;
    if (batch.length > 0 && (batchBytes + text.body.byteLength > maxBytes || batch.length >= maxRows)) await flush();
    batchShas.add(sha);
    batch.push(sqlFragment`(${sourceId}, decode(${sha}, 'hex'), ${text.body.byteLength}::int, ${text.lineCount}::int,
      ${Buffer.from(text.body.buffer, text.body.byteOffset, text.body.byteLength)}::bytea)`);
    batchBytes += text.body.byteLength;
  }
  await flush();
  return { inserted };
}

export async function readSegmentTexts(exec: LegacyUnscopedRead, sourceId: string, sha256s: readonly Uint8Array[]): Promise<Map<string, Uint8Array>> {
  if (sha256s.length === 0) return new Map();
  const { rows } = await exec.run<{ sha: string; body: unknown }>(sqlFragment`
    SELECT encode(t.sha256, 'hex') AS sha, t.body FROM page_segment_texts t
     WHERE t.source_id = ${sourceId} AND t.sha256 = ANY(SELECT decode(h, 'hex') FROM unnest(${sha256s.map(hex)}::text[]) AS h)`);
  return new Map(rows.map(row => [row.sha, bytes(row.body)]));
}

export async function stageManifestRows(exec: SqlExecutor, rows: readonly ManifestRowInput[]): Promise<void> {
  const batches = jsonRowBatches(rows, row => ({
    page_id: row.pageId, occurrence_id: row.occurrenceId, gen_from: row.genFrom, seq: row.seq, region: row.region,
    source_id: row.sourceId, sha256: hex(row.sha256), byte_start: row.byteStart, byte_len: row.byteLen,
    line_start: row.lineStart, line_count: row.lineCount, cut_kind: row.cutKind, entry_state: row.entryState,
    protected_regions: row.protectedRegions, facts_slots: row.factsSlots, static_proj_bytes: row.staticProjBytes,
    static_proj_lines: row.staticProjLines, outline: row.outline, date_min: row.dateMin, date_max: row.dateMax,
    hash_state: hex(row.hashState), staging_id: row.stagingId,
  }), stageBatchBytes(exec));
  for (const json of batches) {
    await exec.run(sqlFragment`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256,
        byte_start, byte_len, line_start, line_count, cut_kind, entry_state, protected_regions, facts_slots, static_proj_bytes,
        static_proj_lines, outline, date_min, date_max, hash_state, staging_id)
      SELECT m.page_id, m.occurrence_id, m.gen_from, m.seq, m.region, m.source_id, decode(m.sha256, 'hex'), m.byte_start, m.byte_len,
        m.line_start, m.line_count, m.cut_kind, m.entry_state, m.protected_regions, m.facts_slots, m.static_proj_bytes,
        m.static_proj_lines, m.outline, m.date_min, m.date_max, decode(m.hash_state, 'hex'), m.staging_id
      FROM jsonb_to_recordset(${json}::text::jsonb) AS m(page_id int, occurrence_id bigint, gen_from bigint, seq int, region text,
        source_id text, sha256 text, byte_start bigint, byte_len int, line_start bigint, line_count int, cut_kind text,
        entry_state jsonb, protected_regions jsonb, facts_slots jsonb, static_proj_bytes bigint, static_proj_lines int,
        outline jsonb, date_min date, date_max date, hash_state text, staging_id uuid)`);
    await yieldTurn();
  }
}

const normalizeManifestRow = compileRowNormalizer<Record<string, unknown>>({
  occurrence_id: 'bigint', gen_from: 'bigint', gen_to: 'bigint', byte_start: 'bigint', line_start: 'bigint', static_proj_bytes: 'bigint',
  entry_state: 'jsonb', protected_regions: 'jsonb', facts_slots: 'jsonb', outline: 'jsonb',
});

function toManifestRow(raw: Record<string, unknown>): ManifestRow {
  const r = normalizeManifestRow(raw);
  return {
    pageId: r.page_id as number, occurrenceId: r.occurrence_id as number, genFrom: r.gen_from as number, genTo: (r.gen_to as number | null) ?? null,
    seq: r.seq as number, region: r.region as BodyRegion, sourceId: r.source_id as string, sha256: bytes(r.sha256),
    byteStart: r.byte_start as number, byteLen: r.byte_len as number, lineStart: r.line_start as number, lineCount: r.line_count as number,
    cutKind: r.cut_kind as ManifestRow['cutKind'], entryState: r.entry_state as ManifestRow['entryState'],
    protectedRegions: r.protected_regions as unknown[], factsSlots: r.facts_slots as unknown[], staticProjBytes: r.static_proj_bytes as number,
    staticProjLines: r.static_proj_lines as number, outline: r.outline as unknown[], dateMin: (r.date_min as string | null) ?? null,
    dateMax: (r.date_max as string | null) ?? null, hashState: bytes(r.hash_state), stagingId: (r.staging_id as string | null) ?? null,
  };
}

export async function readManifest(exec: LegacyUnscopedRead, pageId: number,
  opts: { generation?: number; stagingId?: string; region?: BodyRegion; lastN?: number } = {}): Promise<ManifestRow[]> {
  const rowsOf = opts.stagingId !== undefined
    ? sqlFragment`m.staging_id = ${opts.stagingId}::uuid`
    : sqlFragment`m.staging_id IS NULL AND m.gen_from <= g.gen AND (m.gen_to IS NULL OR m.gen_to > g.gen)`;
  const region = opts.region ? sqlFragment`AND m.region = ${opts.region}` : sqlFragment``;
  const tail = opts.lastN !== undefined ? sqlFragment`ORDER BY m.seq DESC LIMIT ${opts.lastN}::int` : sqlFragment`ORDER BY m.seq`;
  const { rows } = await exec.run<Record<string, unknown>>(sqlFragment`
    SELECT m.page_id, m.occurrence_id, m.gen_from, m.gen_to, m.seq, m.region, m.source_id, m.sha256, m.byte_start, m.byte_len,
           m.line_start, m.line_count, m.cut_kind, m.entry_state, m.protected_regions, m.facts_slots, m.static_proj_bytes,
           m.static_proj_lines, m.outline, to_char(m.date_min, 'YYYY-MM-DD') AS date_min, to_char(m.date_max, 'YYYY-MM-DD') AS date_max,
           m.hash_state, m.staging_id::text AS staging_id
      FROM page_body_manifest m
      CROSS JOIN (SELECT COALESCE(${opts.generation ?? null}::bigint, (SELECT body_generation FROM pages WHERE id = ${pageId})) AS gen) g
     WHERE m.page_id = ${pageId} AND ${rowsOf} ${region}
     ${tail}`);
  const out = rows.map(toManifestRow);
  return opts.lastN !== undefined ? out.reverse() : out;
}

/** The write column and model label the chunk rows carry, resolved on this executor's handle (as upsertChunks does). */
async function resolveChunkWrite(exec: SqlExecutor, chunks: readonly SegmentChunkInput[], embeddingColumn?: ResolvedColumn): Promise<{ column: ResolvedColumn; model: string }> {
  const { rows } = await exec.run<{ key: string; value: string }>(sqlFragment`SELECT key, value FROM config
    WHERE key IN ('search_embedding_column', 'embedding_columns', 'embedding_model')`);
  const config = new Map(rows.map(row => [row.key, row.value]));
  const column = embeddingColumn ? normalizeEngineColumn(embeddingColumn) : resolveWriteColumnFromConfigRows({
    searchEmbeddingColumn: config.get('search_embedding_column') ?? null, embeddingColumnsJson: config.get('embedding_columns') ?? null });
  const model = column.embeddingModel || config.get('embedding_model') || null;
  if (!model && chunks.some(chunk => chunk.embedding && !chunk.model)) {
    throw new Error('Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.');
  }
  return { column, model: model ?? 'unconfigured' };
}

export async function stageSegmentChunks(exec: SqlExecutor, pageId: number, generation: number, chunks: readonly SegmentChunkInput[],
  opts: { embeddingColumn?: ResolvedColumn } = {}): Promise<number[]> {
  if (chunks.length === 0) return [];
  const { column, model } = await resolveChunkWrite(exec, chunks, opts.embeddingColumn);
  const col = quoteIdentifier(column.name);
  const cast = vectorCastSuffix(column);
  return exec.transaction(async tx => {
    if (tx.capabilities.transactionAdvisoryLocks) {
      // The page row first, as the projection's page guard takes it: the chunk insert's FK check would take it after the advisory lock.
      await tx.run(sqlFragment`SELECT 1 FROM pages WHERE id = ${pageId} FOR KEY SHARE`);
      // Lock-census: COMPLIANT — key is the page id, unique brain-wide.
      await tx.run(sqlFragment`SELECT pg_advisory_xact_lock(hashtextextended('gbrain:page-body-chunks:' || ${pageId}::text, 0))`);
    }
    // A preparation stages above the live generation and a projection at it, on a segmented page. Rows for a generation the
    // page has passed, or reached as an inline page, belong to a write that cannot publish. Read after the key-share lock:
    // a demotion holds the row FOR UPDATE (lockPageKeys) until it commits, so this read sees it.
    const { rows: pages } = await tx.run<{ body_generation: unknown; body_storage: string; slug: string }>(sqlFragment`
      SELECT body_generation, body_storage, slug FROM pages WHERE id = ${pageId}`);
    const live = Number(pages[0]?.body_generation);
    // At the live generation only occurrences its published manifest holds take rows: a preparation that lost the flip to
    // another write of the same generation still holds its own (unpublished) occurrences, and a row of one would be
    // searchable on the sealed page (chunkVisibleFilter reads the generation alone).
    const unpublished = pages[0]?.body_storage === 'segmented' && generation === live && (await tx.run(sqlFragment`
      SELECT 1 FROM unnest(${[...new Set(chunks.map(chunk => chunk.occurrence_id))]}::bigint[]) AS o(id)
       WHERE NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id = ${pageId} AND m.occurrence_id = o.id AND m.staging_id IS NULL
         AND m.gen_from <= ${generation}::bigint AND (m.gen_to IS NULL OR m.gen_to > ${generation}::bigint))
       LIMIT 1`)).rows.length > 0;
    if (!pages[0] || generation < live || (generation === live && pages[0].body_storage !== 'segmented') || unpublished) {
      throw opError('revision_changed', `Page ${pages[0]?.slug ?? pageId} moved to body generation ${pages[0] ? live : 'none'} while chunks for generation ${generation} were staged.`,
        'Another write published first. Read the page again and repeat this write against its current revision.',
        { legacy_error: 'invalid_params', detail: JSON.stringify({ staged_generation: generation, current_generation: pages[0] ? live : null }) });
    }
    // chunk-visibility-ok: chunk_index is never reused, so the next index is past every row, staged and retired included
    const { rows } = await tx.run<{ next: unknown }>(sqlFragment`SELECT COALESCE(MAX(chunk_index), -1) + 1 AS next FROM content_chunks WHERE page_id = ${pageId}`);
    const first = Number(rows[0]?.next ?? 0);
    const indexes = chunks.map((_, i) => first + i);
    const batches = jsonRowBatches(chunks.map((chunk, i) => ({ chunk, index: indexes[i]! })), ({ chunk, index }) => {
      const embedding = chunk.embedding ? '[' + Array.from(chunk.embedding).join(',') + ']' : null;
      return {
        chunk_index: index, chunk_text: sanitizeText(chunk.chunk_text), chunk_source: chunk.chunk_source ?? null, embedding,
        model: chunk.model || model, token_count: chunk.token_count || null,
        embedding_input_hash: embedding ? chunk.embedding_input_hash ?? null : null,
        language: chunk.language || null, symbol_name: chunk.symbol_name || null, symbol_type: chunk.symbol_type || null,
        start_line: chunk.start_line ?? null, end_line: chunk.end_line ?? null,
        parent_symbol_path: chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0 ? chunk.parent_symbol_path : null,
        doc_comment: chunk.doc_comment || null, symbol_name_qualified: chunk.symbol_name_qualified || null, modality: chunk.modality ?? 'text',
        embedding_image: chunk.embedding_image ? '[' + Array.from(chunk.embedding_image).join(',') + ']' : null,
        projected_byte_start: chunk.projected_byte_start ?? null, projected_byte_end: chunk.projected_byte_end ?? null,
        occurrence_id: chunk.occurrence_id, local_ordinal: chunk.local_ordinal, raw_byte_start: chunk.raw_byte_start, raw_byte_end: chunk.raw_byte_end,
      };
    }, stageBatchBytes(tx));
    for (const json of batches) {
      await tx.run(sqlFragment`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, ${trustedSql(col)}, model, token_count,
          embedded_at, embedded_text_hash, embedding_input_hash, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path,
          doc_comment, symbol_name_qualified, modality, embedding_image, embedding_pending_since, projected_byte_start, projected_byte_end,
          occurrence_id, local_ordinal, raw_byte_start, raw_byte_end, body_generation)
        SELECT ${pageId}::int, c.chunk_index, c.chunk_text, c.chunk_source, c.embedding${trustedSql(cast)}, c.model, c.token_count,
          CASE WHEN c.embedding IS NULL THEN NULL ELSE now() END,
          CASE WHEN c.embedding IS NULL THEN NULL ELSE md5(c.chunk_text) END,
          c.embedding_input_hash, c.language, c.symbol_name, c.symbol_type, c.start_line, c.end_line,
          c.parent_symbol_path, c.doc_comment, c.symbol_name_qualified, c.modality, c.embedding_image::vector,
          CASE WHEN c.embedding IS NULL THEN now() ELSE NULL END,
          c.projected_byte_start, c.projected_byte_end, c.occurrence_id, c.local_ordinal, c.raw_byte_start, c.raw_byte_end, ${generation}::bigint
        FROM jsonb_to_recordset(${json}::text::jsonb) AS c(chunk_index int, chunk_text text, chunk_source text,
          embedding text, model text, token_count int, embedding_input_hash text, language text, symbol_name text, symbol_type text,
          start_line int, end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text, modality text, embedding_image text,
          projected_byte_start bigint, projected_byte_end bigint, occurrence_id bigint, local_ordinal int, raw_byte_start bigint, raw_byte_end bigint)`);
      await yieldTurn();
    }
    return indexes;
  });
}

function metaParams(meta: SegmentedPageMeta) {
  const ingested = meta.source_kind || meta.source_uri || meta.ingested_via;
  return {
    pageKind: meta.page_kind || 'markdown', title: sanitizeText(meta.title), frontmatter: jsonbParam(meta.frontmatter || {}),
    effectiveDate: meta.effective_date ?? null, effectiveDateSource: meta.effective_date_source ?? null, importFilename: meta.import_filename ?? null,
    chunkerVersion: meta.chunker_version === undefined || meta.chunker_version === null ? null : Math.min(meta.chunker_version, SAFE_FENCE_CHUNKER_VERSION - 1),
    sourcePath: meta.source_path ?? null, sourceKind: meta.source_kind ?? null, sourceUri: meta.source_uri ?? null, ingestedVia: meta.ingested_via ?? null,
    ingestedAt: ingested ? new Date() : null,
  };
}

export async function createSegmentedPageShell(exec: SqlExecutor, slug: string, meta: SegmentedPageMeta, opts: { sourceId: string }): Promise<{ id: number }> {
  const m = metaParams(meta);
  // origin-guard-ok: applySegmentedBody runs assertOriginUnclaimed in this transaction first
  const { rows } = await exec.run<{ id: number }>(sqlFragment`
    INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, updated_at, effective_date,
      effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at,
      body_storage, body_generation, body_bytes)
    VALUES (${opts.sourceId}, ${validateSlug(slug)}, ${meta.type}, ${m.pageKind}, ${m.title}, NULL, NULL, ${m.frontmatter}, now(), ${m.effectiveDate},
      ${m.effectiveDateSource}, ${m.importFilename}, ${m.chunkerVersion ?? 0}::smallint, ${m.sourcePath}, ${m.sourceKind}, ${m.sourceUri},
      ${m.ingestedVia}, ${m.ingestedAt}, 'segmented', 0, 0)
    RETURNING id`);
  return { id: Number(rows[0]!.id) };
}

/**
 * The generation flip (spec 3.4), in the caller's publication transaction (a
 * savepoint when nested). The page row is assigned `compiled_truth` and
 * `timeline` (NULL) on every flip, so `trg_pages_search_vector` (UPDATE OF
 * title,timeline) recomputes the page vector from `timeline_lead`.
 */
export async function flipBodyGeneration(exec: SqlExecutor, input: BodyFlipInput): Promise<BodyFlipResult> {
  if (input.newGeneration !== input.expectedGeneration + 1) throw new TypeError('newGeneration must be expectedGeneration + 1');
  return exec.transaction(async tx => {
    const { rows } = await tx.run<{ body_generation: unknown; slug: string; source_id: string }>(sqlFragment`
      SELECT body_generation, slug, source_id FROM pages WHERE id = ${input.pageId} FOR UPDATE`);
    const page = rows[0];
    if (!page) {
      throw opError('page_identity_changed', `Page ${input.pageId} was deleted while its segmented write was prepared.`,
        'The page was deleted or recreated while this write was prepared, so nothing was published. Read the page that holds the slug now, then write again.',
        { reason: 'page_deleted' });
    }
    const current = Number(page.body_generation);
    if (current !== input.expectedGeneration) {
      throw opError('revision_changed', `Page ${page.slug} moved to body generation ${current} while this write was prepared at ${input.expectedGeneration}.`,
        'Another write published first. Read the page again and repeat this write against its current revision.',
        { legacy_error: 'invalid_params', detail: JSON.stringify({ expected_generation: input.expectedGeneration, current_generation: current }),
          fix: readFix('Returns the current revision and size.', { argv: ['gbrain', 'get', '--source', page.source_id, '--', page.slug],
            mcp: { tool: 'get_page', arguments: { slug: page.slug, source_id: page.source_id, body: 'none' } } }) });
    }
    const { rows: stagings } = await tx.run<{ state: string }>(sqlFragment`SELECT state FROM page_body_stagings WHERE id = ${input.stagingId}::uuid FOR UPDATE`);
    if (!LIVE_STAGING_STATES.includes(stagings[0]?.state ?? '')) throw bodyStagingGoneError(page.slug, input.stagingId, stagings[0]?.state ?? null);
    const newLive = sqlFragment`(SELECT s.occurrence_id FROM page_body_manifest s WHERE s.page_id = ${input.pageId}
        AND (s.staging_id = ${input.stagingId}::uuid
          OR (s.staging_id IS NULL AND s.gen_to IS NULL AND NOT (s.occurrence_id = ANY(${[...input.closeOccurrences]}::bigint[])))))`;
    const retire = sqlFragment`c.page_id = ${input.pageId} AND (
        (c.occurrence_id = ANY(${[...input.retireChunkOccurrences]}::bigint[]) AND c.body_generation <= ${input.expectedGeneration}::bigint)
        OR (${input.retireInlineChunks === true}::boolean AND c.body_generation IS NULL)
        OR (c.body_generation = ${input.newGeneration}::bigint AND c.occurrence_id NOT IN ${newLive}))`;
    // chunk-visibility-ok: the flip itself selects the rows it retires, across generations
    const { rows: counted } = await tx.run<{ n: unknown }>(sqlFragment`SELECT count(*)::bigint AS n FROM content_chunks c WHERE ${retire}`);
    const toRetire = Number(counted[0]?.n ?? 0);
    const retireDeferred = toRetire > input.retireMaxRows;
    await tx.run(sqlFragment`UPDATE page_body_manifest SET gen_to = ${input.newGeneration}::bigint
      WHERE page_id = ${input.pageId} AND gen_to IS NULL AND staging_id IS NULL AND occurrence_id = ANY(${[...input.closeOccurrences]}::bigint[])`);
    // Retired rows are deleted, not marked (marking rewrote each row's HNSW entry). Their occurrences are closed above, so a
    // deferred retirement's rows are invisible to every reader (chunkGenerationFilter) before the projection job deletes them.
    const retired = retireDeferred || toRetire === 0 ? 0 : (await tx.run(sqlFragment`DELETE FROM content_chunks c WHERE ${retire}`)).affectedRows;
    await tx.run(sqlFragment`UPDATE page_body_manifest SET staging_id = NULL WHERE page_id = ${input.pageId} AND staging_id = ${input.stagingId}::uuid`);
    const m = metaParams(input.meta);
    const b = input.body;
    // origin-guard-ok: applySegmentedBody runs assertOriginUnclaimed in this transaction first
    await tx.run(sqlFragment`UPDATE pages SET
        body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_generation = ${input.newGeneration}::bigint,
        content_hash = ${b.content_hash}, body_bytes = ${b.body_bytes}::bigint, truth_bytes = ${b.truth_bytes}::bigint,
        body_lines = ${b.body_lines}::bigint, segment_count = ${b.segment_count}::int, segmenter_version = ${b.segmenter_version}::int,
        truth_lead = ${sanitizeText(b.truth_lead)}, timeline_lead = ${sanitizeText(b.timeline_lead)}, body_flags = ${jsonbParam(b.body_flags)},
        type = ${input.meta.type}, page_kind = ${m.pageKind}, title = ${m.title}, frontmatter = ${m.frontmatter}, updated_at = now(), deleted_at = NULL,
        effective_date = COALESCE(${m.effectiveDate}::timestamptz, effective_date),
        effective_date_source = COALESCE(${m.effectiveDateSource}::text, effective_date_source),
        import_filename = COALESCE(${m.importFilename}::text, import_filename),
        chunker_version = COALESCE(${m.chunkerVersion}::smallint, chunker_version),
        source_path = COALESCE(${m.sourcePath}::text, source_path), source_kind = COALESCE(${m.sourceKind}::text, source_kind),
        source_uri = COALESCE(${m.sourceUri}::text, source_uri), ingested_via = COALESCE(${m.ingestedVia}::text, ingested_via),
        ingested_at = COALESCE(${m.ingestedAt}::timestamptz, ingested_at)
      WHERE id = ${input.pageId}`);
    return { retiredChunks: retired, retireDeferred };
  });
}

/** A write's staging is no longer live, so the write publishes nothing: expired and collected, or aborted (a fact purge removed text it staged). */
export function bodyStagingGoneError(slug: string, stagingId: string, state: string | null) {
  return opError('body_staging_expired', `The staged body of this write to ${slug} is ${state ?? 'gone'}, so nothing was published.`,
    state === 'aborted'
      ? 'The staging was aborted (a fact purge removed text it staged, or its preparation failed). Send the write again; purged content is refused.'
      : 'The write waited past its staging deadline and its staged segments were collected. Send the write again.',
    { detail: JSON.stringify({ staging_id: stagingId, state }) });
}

export async function openBodyStaging(exec: SqlExecutor, input: BodyStagingInput): Promise<void> {
  await exec.run(sqlFragment`INSERT INTO page_body_stagings (id, kind, principal_kind, principal_id, client_request_id, source_id,
      source_incarnation, slug, page_id, mode, base_revision, base_generation, declared_bytes, declared_sha256, reserved_bytes,
      idle_expires_at, hard_expires_at)
    VALUES (${input.id}::uuid, ${input.kind}, ${input.principalKind}, ${input.principalId}, ${input.clientRequestId}::uuid, ${input.sourceId},
      ${input.sourceIncarnation}::uuid, ${input.slug}, ${input.pageId}::int, ${input.mode}, ${input.baseRevision}::uuid, ${input.baseGeneration}::bigint,
      ${input.declaredBytes}::bigint, decode(${input.declaredSha256 ? hex(input.declaredSha256) : null}::text, 'hex'), ${input.reservedBytes}::bigint,
      ${input.idleExpiresAt}, ${input.hardExpiresAt})`);
}

/** Moving a staging to a live state restarts its idle deadline (never past its hard one). */
export async function setBodyStagingState(exec: SqlExecutor, id: string, state: BodyStagingState, opts: { commitRequestId?: string | null } = {}): Promise<void> {
  await exec.run(sqlFragment`UPDATE page_body_stagings SET state = ${state}, updated_at = now(),
      idle_expires_at = CASE WHEN ${state} = ANY(${LIVE_STAGING_STATES}::text[])
        THEN LEAST(hard_expires_at, now() + (${BODY_STAGING_IDLE_MS}::bigint * interval '1 millisecond')) ELSE idle_expires_at END,
      commit_request_id = COALESCE(${opts.commitRequestId ?? null}::uuid, commit_request_id)
    WHERE id = ${id}::uuid`);
}

/**
 * Garbage collection (spec 3.5). Roots: each segmented page's live generation,
 * every generation a page_versions row references, and staged rows of live
 * stagings (`liveStagingIds`). Deletes staged chunk rows (above the page's
 * generation) no live staging owns, manifest rows outside every root, and
 * unreferenced texts older than the grace window and older than every live
 * staging of their source, that no live staging recorded
 * (page_body_staging_texts: a create that deduped onto an older text holds it
 * until it publishes); a text a concurrent writer is referencing is row-locked
 * by its FK check or its refresh and skipped. A page-scoped sweep
 * (`pageId`) considers only the texts its own manifest deletes released, so
 * its cost is the page's, not the source's; the source-wide sweep collects the
 * rest. Rows of retired occurrences are deleted by the flip or, deferred, by
 * the projection job; until then no reader sees them. With
 * `expireStagings`, stagings past a deadline (and not request-held) become
 * `expired` (an upload session's reserved bytes released in the same
 * statement, limits.ts RELEASE_STAGED_CTE), every non-live staging loses its parts, and terminal stagings
 * (committed, aborted, expired) are deleted once BODY_STAGING_HARD_MS has
 * passed since their last change: until then a replayed begin or commit finds
 * its row and an expired upload answers `upload_expired`. Staged rows of
 * non-live stagings go whether or not this sweep expired them.
 */
export async function sweepSegments(exec: SqlExecutor, opts: SegmentSweepOptions = {}): Promise<SegmentSweepResult> {
  const now = opts.now ? sqlFragment`${opts.now}::timestamptz` : sqlFragment`now()`;
  const pageScope = joinFragments([
    opts.pageId !== undefined ? sqlFragment`p.id = ${opts.pageId}::int` : sqlFragment`TRUE`,
    opts.sourceId !== undefined ? sqlFragment`p.source_id = ${opts.sourceId}` : sqlFragment`TRUE`,
  ], ' AND ');
  let stagingsExpired = 0;
  if (opts.expireStagings) {
    const stagingScope = joinFragments([
      opts.pageId !== undefined ? sqlFragment`s.page_id = ${opts.pageId}::int` : sqlFragment`TRUE`,
      opts.sourceId !== undefined ? sqlFragment`s.source_id = ${opts.sourceId}` : sqlFragment`TRUE`,
    ], ' AND ');
    const { rows: expired } = await exec.run<{ n: number }>(sqlFragment`WITH gone AS (UPDATE page_body_stagings s SET state = 'expired', updated_at = ${now}
      WHERE s.state = ANY(${LIVE_STAGING_STATES}::text[]) AND ${stagingScope}
        AND (s.hard_expires_at <= ${now} OR s.idle_expires_at <= ${now} AND (s.kind <> 'upload' OR s.state = 'open'))
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state = ANY(${NON_TERMINAL_REQUEST_STATES}::text[])
                         AND r.intent->'body_ref'->>'staging_id' = s.id::text)
      RETURNING s.id, s.kind, s.principal_kind, s.principal_id, s.reserved_bytes), ${trustedSql(RELEASE_STAGED_CTE)}
      SELECT count(*)::int AS n FROM gone`);
    stagingsExpired = Number(expired[0]?.n ?? 0);
    await exec.run(sqlFragment`DELETE FROM page_body_staging_parts p USING page_body_stagings s
      WHERE p.staging_id = s.id AND ${stagingScope} AND s.id::text NOT IN ${liveStagingIds}`);
    await exec.run(sqlFragment`DELETE FROM page_body_stagings s
      WHERE s.state = ANY(${TERMINAL_STAGING_STATES}::text[]) AND s.updated_at <= ${now} - (${BODY_STAGING_HARD_MS}::bigint * interval '1 millisecond')
        AND ${stagingScope} AND s.id::text NOT IN ${liveStagingIds}`);
  }
  const { affectedRows: retiredChunksDeleted } = await exec.run(sqlFragment`DELETE FROM content_chunks c USING pages p
    WHERE c.page_id = p.id AND ${pageScope} AND c.body_generation IS NOT NULL AND c.body_generation > p.body_generation
      AND NOT EXISTS (SELECT 1 FROM page_body_manifest m
            WHERE m.page_id = c.page_id AND m.occurrence_id = c.occurrence_id AND m.staging_id::text IN ${liveStagingIds})`);
  // Rows at or below the live generation of an occurrence that only a dead staging owns: a preparation that lost the flip
  // to another write of its generation and staged a late batch before stageSegmentChunks refused one. Found through the
  // dead staging's manifest rows (deleted next), so the sweep's cost is the garbage's, not the page's.
  const { affectedRows: orphanedChunksDeleted } = await exec.run(sqlFragment`DELETE FROM content_chunks c USING page_body_manifest d, pages p
    WHERE d.page_id = p.id AND ${pageScope} AND d.staging_id IS NOT NULL AND d.staging_id::text NOT IN ${liveStagingIds}
      AND c.page_id = d.page_id AND c.occurrence_id = d.occurrence_id AND c.body_generation IS NOT NULL AND c.body_generation <= p.body_generation
      AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id = c.page_id AND m.occurrence_id = c.occurrence_id
            AND (m.staging_id IS NULL OR m.staging_id::text IN ${liveStagingIds}))`);
  const released = new Set<string>();
  const returning = opts.pageId !== undefined ? sqlFragment`RETURNING encode(m.sha256, 'hex') AS sha` : sqlFragment``;
  const { rows: stagedRows, affectedRows: stagedRowsDeleted } = await exec.run<{ sha: string }>(sqlFragment`DELETE FROM page_body_manifest m USING pages p
    WHERE m.page_id = p.id AND ${pageScope} AND m.staging_id IS NOT NULL AND m.staging_id::text NOT IN ${liveStagingIds} ${returning}`);
  const { rows: closedRows, affectedRows: closedRowsDeleted } = await exec.run<{ sha: string }>(sqlFragment`DELETE FROM page_body_manifest m USING pages p
    WHERE m.page_id = p.id AND ${pageScope} AND m.staging_id IS NULL
      AND NOT (p.body_storage = 'segmented' AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation))
      AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = m.page_id AND v.body_generation >= m.gen_from
                       AND (m.gen_to IS NULL OR v.body_generation < m.gen_to)) ${returning}`);
  for (const row of [...stagedRows, ...closedRows]) released.add(row.sha);
  const graceMs = opts.graceMs ?? SEGMENT_TEXT_GC_GRACE_MS;
  const textScope = opts.pageId !== undefined
    ? sqlFragment`AND t.source_id = (SELECT source_id FROM pages WHERE id = ${opts.pageId}::int)
        AND t.sha256 = ANY(SELECT decode(h, 'hex') FROM unnest(${[...released]}::text[]) AS h)`
    : opts.sourceId !== undefined ? sqlFragment`AND t.source_id = ${opts.sourceId}` : sqlFragment``;
  const textsDeleted = opts.pageId !== undefined && released.size === 0 ? 0 : (await exec.run(sqlFragment`DELETE FROM page_segment_texts d
    WHERE (d.source_id, d.sha256) IN (SELECT t.source_id, t.sha256 FROM page_segment_texts t
      WHERE t.created_at < ${now} - (${graceMs}::bigint * interval '1 millisecond') ${textScope}
        AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id = t.source_id AND m.sha256 = t.sha256)
        AND NOT EXISTS (SELECT 1 FROM page_body_stagings s WHERE s.source_id = t.source_id AND s.created_at <= t.created_at
                         AND s.id::text IN ${liveStagingIds})
        AND NOT ${trustedSql(stagingNeedsTextSql('t'))}
      FOR UPDATE SKIP LOCKED)`)).affectedRows;
  return { retiredChunksDeleted: retiredChunksDeleted + orphanedChunksDeleted, manifestRowsDeleted: stagedRowsDeleted + closedRowsDeleted, textsDeleted, stagingsExpired };
}
