import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveConfig } from '../../../src/core/config.ts';
import {
  resetEmbeddingProviderForTests,
  setEmbeddingProviderForTests,
} from '../../../src/core/embedding.ts';
import type { BrainEngine } from '../../../src/core/engine.ts';
import {
  evaluateLiveRetrievalFixture,
  type RetrievalEvalReport,
} from '../../../src/core/evaluation/retrieval-eval.ts';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { runEmbeddingBackfill } from '../../../src/core/services/embedding-backfill-service.ts';
import { createProductionRetrieveContextDependencies } from '../../../src/core/services/production-retrieval-dependencies-service.ts';
import { SQLiteEngine } from '../../../src/core/sqlite-engine.ts';
import { loadP2GoldFixture, seedP2GoldCorpus } from './p2-gold-corpus.ts';
import {
  createStubEmbeddingProvider,
  STUB_EMBEDDING_MODEL,
  type StubEmbeddingStats,
} from './stub-embedding-provider.ts';

/**
 * EV-1c per-config P2 gold eval runner, shared by the live test suite
 * (test/retrieval-eval-service.test.ts) and the baseline regeneration script
 * (scripts/regen-retrieval-baselines.ts) so both always execute the identical
 * pipeline: fresh engine, seeded corpus, production retrieve_context
 * dependencies from a resolved config, and (for stub-embeddings configs) a
 * deterministic offline vector path.
 */

export type P2GoldEngineKind = 'sqlite' | 'pglite';
export type P2GoldEmbeddingsMode = 'none' | 'stub';

export interface P2GoldEvalConfig {
  /** Baseline file basename under test/fixtures/retrieval-eval/baselines/. */
  name: string;
  engine: P2GoldEngineKind;
  governedProbeHybrid: boolean;
  embeddings: P2GoldEmbeddingsMode;
}

export const P2_GOLD_EVAL_CONFIGS: readonly P2GoldEvalConfig[] = [
  { name: 'sqlite-governed-probe-on', engine: 'sqlite', governedProbeHybrid: true, embeddings: 'none' },
  { name: 'sqlite-governed-probe-off', engine: 'sqlite', governedProbeHybrid: false, embeddings: 'none' },
  { name: 'pglite-governed-probe-on', engine: 'pglite', governedProbeHybrid: true, embeddings: 'none' },
  { name: 'pglite-governed-probe-off', engine: 'pglite', governedProbeHybrid: false, embeddings: 'none' },
  { name: 'sqlite-stub-embeddings', engine: 'sqlite', governedProbeHybrid: true, embeddings: 'stub' },
  { name: 'pglite-stub-embeddings', engine: 'pglite', governedProbeHybrid: true, embeddings: 'stub' },
] as const;

export function p2GoldEmbeddingProviderLabel(config: P2GoldEvalConfig): string {
  return config.embeddings === 'stub' ? STUB_EMBEDDING_MODEL : 'none';
}

export interface P2GoldEvalRun {
  report: RetrievalEvalReport;
  /** Stub provider call stats; null for embeddings-off configs. */
  stub_stats: StubEmbeddingStats | null;
  /** Stub batch/text counts consumed by the corpus backfill alone. */
  stub_backfill_stats: StubEmbeddingStats | null;
}

async function createConfiguredEngine(kind: P2GoldEngineKind, dir: string): Promise<BrainEngine> {
  if (kind === 'pglite') {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    return engine;
  }
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return engine;
}

export async function runP2GoldEvalConfig(
  config: P2GoldEvalConfig,
  options: { fixtureId?: string } = {},
): Promise<P2GoldEvalRun> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-p2-gold-${config.name}-`));
  const engine = await createConfiguredEngine(config.engine, dir);
  const stub = config.embeddings === 'stub' ? createStubEmbeddingProvider() : null;
  let stubBackfillStats: StubEmbeddingStats | null = null;
  try {
    await seedP2GoldCorpus(engine);

    if (stub) {
      await runEmbeddingBackfill(engine, {
        staleOnly: true,
        provider: stub.provider,
        logger: { log: () => {}, error: () => {}, write: () => {} },
      });
      stubBackfillStats = { ...stub.stats };
      // Route query-time embedding (the bare getEmbeddingProvider() call in
      // hybridSearch's vector leg) through the same deterministic stub.
      setEmbeddingProviderForTests(stub.provider);
    }

    const resolved = resolveConfig({
      engine: config.engine,
      database_path: config.engine === 'pglite' ? dir : join(dir, 'brain.db'),
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
      retrieval: { governed_probe_hybrid: config.governedProbeHybrid },
    });

    const report = await evaluateLiveRetrievalFixture(
      engine,
      loadP2GoldFixture(options.fixtureId ?? 'p2-gold'),
      { retrieve_context_dependencies: createProductionRetrieveContextDependencies(engine, resolved) },
    );

    return {
      report,
      stub_stats: stub ? { ...stub.stats } : null,
      stub_backfill_stats: stubBackfillStats,
    };
  } finally {
    if (stub) resetEmbeddingProviderForTests();
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function p2GoldRouteMatchRate(report: RetrievalEvalReport): number {
  if (report.case_count === 0) return 0;
  return report.cases.filter((entry) => entry.route_match === true).length / report.case_count;
}
