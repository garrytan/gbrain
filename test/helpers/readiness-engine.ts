/**
 * A readiness-probe engine over a fake `executeRaw`: the two typed members the probe calls
 * (`readProjectionReadinessGeneration`, `readProjectionReadiness`) run the engine-sql statements
 * through `executeRaw`, as PGLite and Postgres do, so a test can count, rewrite or fail the
 * probe's statements. `executeRaw` stays on the object for callers that also read it directly
 * (the doctor check's segmented count).
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EngineRawRead } from '../../src/core/engine-sql/cli-reads-ops.ts';
import { readProjectionReadiness, readProjectionReadinessGeneration } from '../../src/core/engine-sql/retrieval-coverage.ts';

export type ReadinessEngine = Pick<BrainEngine, 'executeRaw' | 'readProjectionReadinessGeneration' | 'readProjectionReadiness'>;

export function readinessOver(executeRaw: (sql: string, params?: unknown[], opts?: { jitOff?: boolean }) => Promise<unknown[]>): ReadinessEngine {
  const raw = executeRaw as unknown as EngineRawRead;
  return {
    executeRaw: raw as BrainEngine['executeRaw'],
    readProjectionReadinessGeneration: () => readProjectionReadinessGeneration(raw),
    readProjectionReadiness: scope => readProjectionReadiness(raw, scope),
  };
}
