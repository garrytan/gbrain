import type { BrainEngine } from './engine.ts';
import { getEmbeddingModel, getEmbeddingDimensions, parseEmbeddingDimensions } from './embedding.ts';

export const EMBEDDING_DIMENSION_GUC = 'gbrain.embedding_dimensions';
export const EMBEDDING_MODEL_GUC = 'gbrain.embedding_model';

export function configuredEmbeddingDimensions(): number {
  return getEmbeddingDimensions();
}

export function configuredEmbeddingModel(): string {
  return getEmbeddingModel();
}

export function resolveConfiguredEmbeddingDimensions(): number {
  return parseEmbeddingDimensions(
    process.env.GBRAIN_EMBEDDING_DIMENSIONS || process.env.GBRAIN_OPENAI_EMBEDDING_DIMENSIONS,
    configuredEmbeddingDimensions(),
  );
}

export function resolveConfiguredEmbeddingModel(): string {
  return process.env.GBRAIN_EMBEDDING_MODEL || process.env.GBRAIN_OPENAI_EMBEDDING_MODEL || configuredEmbeddingModel();
}

export function schemaEmbeddingSettingsSql(): string {
  const dimensions = resolveConfiguredEmbeddingDimensions();
  const model = resolveConfiguredEmbeddingModel().replace(/'/g, "''");
  return `SET ${EMBEDDING_DIMENSION_GUC} = '${dimensions}'; SET ${EMBEDDING_MODEL_GUC} = '${model}';`;
}

export function realignEmbeddingDimensionSql(): string {
  return `
    DO $$
    DECLARE
      configured_dimensions INTEGER := COALESCE(NULLIF(current_setting('${EMBEDDING_DIMENSION_GUC}', true), '')::INTEGER, 1536);
      configured_model TEXT := COALESCE(NULLIF(current_setting('${EMBEDDING_MODEL_GUC}', true), ''), 'text-embedding-3-large');
      current_type TEXT;
    BEGIN
      IF configured_dimensions <= 0 THEN
        RAISE EXCEPTION 'Invalid embedding dimension: %', configured_dimensions;
      END IF;

      SELECT format_type(a.atttypid, a.atttypmod)
        INTO current_type
        FROM pg_attribute a
        WHERE a.attrelid = 'content_chunks'::regclass
          AND a.attname = 'embedding'
          AND NOT a.attisdropped;

      IF current_type IS NULL THEN
        RETURN;
      END IF;

      IF current_type IS DISTINCT FROM format('vector(%s)', configured_dimensions) THEN
        DROP INDEX IF EXISTS idx_chunks_embedding;
        UPDATE content_chunks
           SET embedding = NULL,
               embedded_at = NULL
         WHERE embedding IS NOT NULL;
        EXECUTE format('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(%s)', configured_dimensions);
        CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
      END IF;

      INSERT INTO config (key, value) VALUES
        ('embedding_model', configured_model),
        ('embedding_dimensions', configured_dimensions::TEXT)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    END $$;
  `;
}

export async function prepareEmbeddingSchemaSettings(engine: BrainEngine): Promise<void> {
  await engine.runMigration(0, schemaEmbeddingSettingsSql());
}
