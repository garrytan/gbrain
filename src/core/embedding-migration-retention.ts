import type { BrainEngine } from './engine.ts';
import { currentSpaceChunkPredicate, falseStampPageWhere } from './embedding-invalidation.ts';
import { readMigrationState, type EmbeddingMigrationPlan, type MigrationState } from './embedding-migration.ts';
import { eligibleFactEmbedding, retainedFactEmbedding } from './facts/embedding-identity.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { quoteIdentifier, resolveWriteColumnFromConfigRows } from './search/embedding-column.ts';
import { countArchivedEmbeddingWork } from './embedding-readiness.ts';

export async function assertRetainedEmbeddingRebuildability(tx: BrainEngine, dimensions: number, model?: string, plan?: Pick<EmbeddingMigrationPlan, 'from_model' | 'from_dims'>): Promise<boolean> {
  let counts: { pages: number; facts: number; takes: number };
  let clearCompanions = false;
  let archivedWork = 0;
  try {
    await tx.executeRaw('LOCK TABLE sources, pages, content_chunks, facts, fact_withdrawals, takes, config IN SHARE MODE');
    const registry = await tx.executeRaw<{ key: string; value: string }>("SELECT key,value FROM config WHERE key IN ('search_embedding_column','embedding_columns')");
    if (!Array.isArray(registry) || registry.some(row => typeof row.key !== 'string' || typeof row.value !== 'string')) throw new Error('Unknown embedding registry');
    const embeddingColumnsJson = registry.find(row => row.key === 'embedding_columns')?.value;
    if (embeddingColumnsJson) {
      const parsed = JSON.parse(embeddingColumnsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid embedding registry');
    }
    const active = resolveWriteColumnFromConfigRows({
      searchEmbeddingColumn: registry.find(row => row.key === 'search_embedding_column')?.value, embeddingColumnsJson,
    }).name;
    const columns = await tx.executeRaw<{ name: string; type: string }>(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type
      FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attnum>0 AND NOT attisdropped`);
    if (!Array.isArray(columns) || !columns.some(c => c.name === 'page_id') || columns.some(c => typeof c.name !== 'string' || typeof c.type !== 'string')) throw new Error('Unknown chunk schema');
    const primary = columns.find(c => c.name === 'embedding');
    const width = primary ? Number(primary.type.match(/^(?:vector|halfvec)\((\d+)\)$/)?.[1]) : null;
    if (primary && (!Number.isSafeInteger(width) || width! <= 0)) throw new Error('Unknown stored dimensions');
    const activeExists = columns.some(c => c.name === active);
    if (!activeExists && active !== 'embedding') throw new Error('Missing configured embedding column');
    const column = quoteIdentifier(active);
    const legacyVector = primary ? 'cc.embedding' : 'NULL::vector';
    const activeVector = activeExists ? `cc.${column}` : 'NULL::vector';
    const current = activeExists ? currentSpaceChunkPredicate(column, 4, 5)
      : 'COALESCE(cc.model=$4::text AND vector_dims(NULL::vector)=$5::int,false)';
    if (model !== undefined) {
      const prior = await readMigrationState(tx);
      const storedModel = await tx.getConfig('embedding_model');
      const state: Pick<MigrationState, 'from_model' | 'from_dims' | 'companion_vectors_invalidated'> =
        prior.state?.to_model === model && prior.state.to_dims === dimensions ? prior.state
          : { from_model: plan?.from_model ?? storedModel ?? 'unrecorded', from_dims: plan?.from_dims ?? width ?? 0 };
      clearCompanions = !state.companion_vectors_invalidated
        && (state.from_model !== model || state.from_dims !== dimensions || storedModel !== model);
    }
    const factColumns = await tx.executeRaw<{ type: string }>(`SELECT format_type(atttypid,atttypmod) AS type
      FROM pg_attribute WHERE attrelid='facts'::regclass AND attname='embedding' AND attnum>0 AND NOT attisdropped`);
    if (!Array.isArray(factColumns) || factColumns.length !== 1 || typeof factColumns[0].type !== 'string') throw new Error('Unknown fact schema');
    const factWidth = Number(factColumns[0].type.match(/^(?:vector|halfvec)\((\d+)\)$/)?.[1]);
    if (!Number.isSafeInteger(factWidth) || factWidth <= 0) throw new Error('Unknown fact dimensions');
    const schemaRebuild = model === undefined || width !== dimensions;
    const unavailablePage = `(s.archived IS DISTINCT FROM false OR p.deleted_at IS NOT NULL
      OR COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip'
      OR (p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
        AND (p.page_kind IS NULL OR NOT (p.page_kind=ANY($1::text[])))))`;
    const [row] = await tx.executeRaw<{ pages: number; facts: number; takes: number }>(`SELECT
      (SELECT count(*)::int FROM content_chunks cc LEFT JOIN pages p ON p.id=cc.page_id
        LEFT JOIN sources s ON s.id=p.source_id
        WHERE ${unavailablePage} AND (${legacyVector} IS NOT NULL OR ${activeVector} IS NOT NULL)
          AND ($3::boolean OR (p.deleted_at IS NULL
            AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
            AND p.text_projection_revision=p.knowledge_revision
            AND (p.embedding_signature IS DISTINCT FROM $6 OR (${activeExists ? falseStampPageWhere(column, 6, 4) : 'false'}))
            AND ${activeVector} IS NOT NULL AND NOT ${current}))) AS pages,
      (SELECT count(*)::int FROM facts f WHERE $7::boolean AND f.embedding IS NOT NULL
        AND (${retainedFactEmbedding}) IS DISTINCT FROM false
        AND (${eligibleFactEmbedding}) IS DISTINCT FROM true) AS facts,
      (SELECT count(*)::int FROM takes t LEFT JOIN pages p ON p.id=t.page_id
        LEFT JOIN sources s ON s.id=p.source_id
        WHERE $8::boolean AND t.embedding IS NOT NULL AND t.active AND t.superseded_by IS NULL AND ${unavailablePage}) AS takes`,
    [['markdown', 'code'], [...AUDIT_ROW_SOURCES], schemaRebuild, model ?? '', dimensions, `${model ?? ''}:${dimensions}`,
      schemaRebuild || factWidth !== dimensions || clearCompanions, clearCompanions]);
    if (!row || (['pages', 'facts', 'takes'] as const).some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) {
      throw new Error('Unknown retained-vector census');
    }
    counts = row;
    if (model !== undefined) archivedWork = await countArchivedEmbeddingWork(tx,
      { signature: `${model}:${dimensions}`, includeNullSignature: true, includeUnsealed: true }, activeExists ? active : null);
  } catch {
    throw new Error('retained_vector_check_failed: Cannot determine whether retained vectors can be rebuilt; migration mutations refused. Inspect the selected brain and database/schema access before retrying.');
  }
  if (counts.pages + counts.facts + counts.takes + archivedWork > 0) {
    throw new Error(`retained_vectors_blocked: ${counts.pages} page chunk(s), ${counts.facts} fact(s), ${counts.takes} take(s) cannot be rebuilt by this migration; ${archivedWork} archived page(s) have blocked embedding work. No invalidation is permitted. Inspect the blockers: archived sources require deliberate gbrain sources restore <id>; embed_skip, importer-only media, and deleted pages require an explicit retention/recovery decision. No source or page is restored automatically. See docs/guides/embedding-migration.md#recovery.`);
  }
  return clearCompanions;
}
