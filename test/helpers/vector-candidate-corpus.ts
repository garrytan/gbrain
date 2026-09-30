import type { BrainEngine } from '../../src/core/engine.ts';
import { expect } from 'bun:test';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';

export const candidateColumn = { name: 'embedding_candidate_fixture', type: 'vector' as const, dimensions: 8, embeddingModel: '' };
export const candidateVector = new Float32Array([1, 0, 0.1, 0, 0, 0, 0, 0]);

export async function seedVectorCandidateCorpus(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('ann-allowed', 'ann-allowed'), ('ann-other', 'ann-other')`);
  await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_candidate_fixture vector(8)`);
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version)
    SELECT 'notes/ann-' || i, CASE WHEN i % 10 = 1 THEN 'ann-allowed' ELSE 'ann-other' END,
      'note', 'Candidate ' || i, 'candidate fixture',
      CASE WHEN i % 100 = 1 THEN '{"visibility":"private"}'::jsonb ELSE '{}'::jsonb END,
      '00000000-0000-4000-8000-000000000001'::uuid,
      CASE WHEN i % 20 = 0 THEN '00000000-0000-4000-8000-000000000002'::uuid ELSE '00000000-0000-4000-8000-000000000001'::uuid END, 4
    FROM generate_series(1, 6000) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_type, embedding_candidate_fixture)
    SELECT p.id, c, 'candidate ' || repeat(md5((p.id * 10 + c)::text), 32), 'compiled_truth', 'typescript', 'function',
      ARRAY[cos((p.id * 10 + c) * 2.399963229728653)::real, sin((p.id * 10 + c) * 2.399963229728653)::real, 0.1, 0, 0, 0, 0, 0]::vector
    FROM pages p CROSS JOIN generate_series(0, 9) c WHERE p.slug LIKE 'notes/ann-%'`);
  await engine.transaction(async tx => {
    if (engine.kind === 'postgres') await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
    await tx.executeRaw(`CREATE INDEX IF NOT EXISTS idx_chunks_candidate_fixture ON content_chunks USING hnsw (embedding_candidate_fixture vector_cosine_ops)`);
  });
  await engine.executeRaw('ANALYZE content_chunks');
  await engine.executeRaw('ANALYZE pages');
  await engine.executeRaw('ANALYZE sources');
  await refreshProjectionStatistics(engine);
}

export async function verifyVectorCapabilityRetry(engine: BrainEngine): Promise<void> {
  const original = engine.executeRaw;
  const capability = engine as unknown as { vectorIterativeScan?: Promise<boolean> };
  capability.vectorIterativeScan = undefined;
  let probes = 0;
  engine.executeRaw = (async (sql, params) => {
    if (sql.includes("extname = 'vector'")) {
      probes++;
      if (probes === 1) throw new Error('synthetic transient capability failure');
    }
    return original.call(engine, sql, params);
  }) as typeof engine.executeRaw;
  try {
    await expect(engine.searchVector(candidateVector, { limit: 1, embeddingColumn: candidateColumn })).rejects.toThrow('synthetic transient capability failure');
    expect(await engine.searchVector(candidateVector, { limit: 1, embeddingColumn: candidateColumn })).toHaveLength(1);
    if (engine.kind === 'pglite') await engine.connect({});
    expect(await engine.searchVector(candidateVector, { limit: 1, embeddingColumn: candidateColumn })).toHaveLength(1);
    expect(probes).toBe(2);
  } finally {
    engine.executeRaw = original;
  }
}
