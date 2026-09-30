import type { BrainEngine } from './engine.ts';

const PRIMARY_EMBEDDING_TABLES = ['content_chunks', 'facts', 'query_cache', 'takes'] as const;

export async function readPrimaryEmbeddingStores(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<Array<typeof PRIMARY_EMBEDDING_TABLES[number]>> {
  const rows = await engine.executeRaw<{ table_name: string }>(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'embedding'
      AND table_name = ANY($1::text[])
  `, [[...PRIMARY_EMBEDDING_TABLES]]);
  return PRIMARY_EMBEDDING_TABLES.filter(table => rows.some(row => row.table_name === table));
}

export async function readStoredEmbeddingIdentity(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>,
): Promise<{ model: string | null; dimensions: number } | null> {
  const rows = await engine.executeRaw<{ formatted: string | null }>(`
    SELECT format_type(a.atttypid, a.atttypmod) AS formatted
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'content_chunks'
      AND a.attname = 'embedding' AND NOT a.attisdropped
  `);
  if (rows.length === 0) {
    const tables = await engine.executeRaw<{ present: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'content_chunks') AS present
    `);
    if (tables[0]?.present === false) return null;
    throw new Error('Stored embedding column identity is unavailable. Run gbrain migrate embeddings --status before an explicit migration; the schema has not been resized.');
  }
  const dimensions = Number(rows[0].formatted?.match(/^(?:halfvec|vector)\((\d+)\)$/)?.[1]);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('Stored embedding dimensions are unknown. Run gbrain migrate embeddings --status; automatic schema resizing is refused.');
  }
  const model = await engine.getConfig('embedding_model').catch(() => null);
  return { model: model?.trim() || null, dimensions };
}
