/** `import`: load every corpus page, its chunks and its vectors through the write path, then (optionally) build the HNSW index. */
import type { BrainEngine } from '../../../../src/core/engine.ts';
import { chunkEmbeddingIndexSql } from '../../../../src/core/vector-index.ts';
import { withHnswBuildMemory } from '../../../../src/core/vector-index.ts';
import { chunkVector, type Corpus } from './corpus.ts';
import { EMBEDDING_DIMS, ensureSource } from './store.ts';
import { writePage, type PageSpec } from './write-path.ts';
import { r2 } from './stats.ts';

export type HnswMode = 'inline' | 'deferred' | 'skip';

export interface ImportStats {
  seconds: number;
  chunks_per_s: number;
  pages: number;
  chunks: number;
  workers: number;
  hnsw: HnswMode;
  analyze_seconds: number;
  hnsw_build_seconds: number | null;
  total_seconds: number;
  chunks_per_s_total: number;
  errors: number;
}

export function pageSpec(corpus: Corpus, pageIndex: number): PageSpec {
  const p = corpus.pages[pageIndex]!;
  return {
    slug: p.slug,
    sourceId: p.source_id,
    type: p.type,
    title: p.title,
    frontmatter: p.frontmatter,
    body: p.body,
    chunks: Array.from({ length: p.chunk_count }, (_, k) => ({
      text: corpus.chunks[p.chunk_start + k]!.text,
      vector: chunkVector(corpus, p.chunk_start + k),
    })),
  };
}

export async function hnswIndexInfo(engine: BrainEngine): Promise<{ present: boolean; valid: boolean | null; bytes: number | null }> {
  const rows = await engine.executeRaw<{ valid: boolean; bytes: number | string }>(
    `SELECT i.indisvalid AS valid, pg_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'idx_chunks_embedding' AND c.relkind = 'i'`);
  if (rows.length === 0) return { present: false, valid: null, bytes: null };
  return { present: true, valid: rows[0]!.valid === true, bytes: Number(rows[0]!.bytes) };
}

/** The HNSW build, sized and refused the way gbrain's own deferred build is (withHnswBuildMemory on PGLite). */
export async function buildHnswIndex(engine: BrainEngine): Promise<number> {
  const started = performance.now();
  const sql = chunkEmbeddingIndexSql(EMBEDDING_DIMS).replace(/;\s*$/, '');
  await withHnswBuildMemory(engine, 'content_chunks', 'embedding', () => engine.executeRaw(sql));
  return (performance.now() - started) / 1000;
}

export async function importCorpus(
  engine: BrainEngine, corpus: Corpus, opts: { workers: number; hnsw: HnswMode; log: (line: string) => void },
): Promise<ImportStats> {
  for (const source of corpus.manifest.sources) if (source !== 'default') await ensureSource(engine, source);
  if (opts.hnsw !== 'inline') await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');

  const total = corpus.pages.length;
  let next = 0, done = 0, errors = 0;
  const started = performance.now();
  let lastLog = started;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      try {
        await writePage(engine, pageSpec(corpus, i));
      } catch (error) {
        errors++;
        if (errors <= 3) opts.log(`import error on page ${i}: ${(error as Error).message}`);
      }
      done++;
      const now = performance.now();
      if (now - lastLog > 15_000) {
        lastLog = now;
        opts.log(`import: ${done}/${total} pages, ${r2(done / ((now - started) / 1000))} pages/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.workers }, worker));
  const seconds = (performance.now() - started) / 1000;

  const analyzeStarted = performance.now();
  await engine.executeRaw('ANALYZE');
  const analyze_seconds = (performance.now() - analyzeStarted) / 1000;

  let hnsw_build_seconds: number | null = null;
  if (opts.hnsw === 'deferred') {
    opts.log('import: building HNSW index');
    hnsw_build_seconds = await buildHnswIndex(engine);
    await engine.executeRaw('ANALYZE content_chunks');
  }
  const chunks = corpus.chunks.length;
  const total_seconds = seconds + analyze_seconds + (hnsw_build_seconds ?? 0);
  return {
    seconds: r2(seconds), chunks_per_s: r2(chunks / seconds), pages: total, chunks, workers: opts.workers, hnsw: opts.hnsw,
    analyze_seconds: r2(analyze_seconds), hnsw_build_seconds: hnsw_build_seconds === null ? null : r2(hnsw_build_seconds),
    total_seconds: r2(total_seconds), chunks_per_s_total: r2(chunks / total_seconds), errors,
  };
}
