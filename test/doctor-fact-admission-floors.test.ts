/**
 * fact_admission_floors doctor check (#6590): informational, names the
 * embedding model and the shared floors, never claims a measured floor for a
 * model without an eval, and is not applicable on a keyless brain. PGLite ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { factAdmissionFloorsEntry } from '../src/commands/doctor/checks/fact-admission-floors.ts';
import { FACT_COSINE_MIN } from '../src/core/search/facts-arm.ts';
import { FACTS_ARM_COSINE_MIN } from '../src/core/search/fact-relevance.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const run = async () => (await factAdmissionFloorsEntry.run({ engine, progress: { heartbeat() {} } } as never) as Check[])[0];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 60_000);

describe('fact_admission_floors (#6590)', () => {
  test('an unmeasured model is informational and names the model and both floors', async () => {
    configureGateway({ embedding_model: 'llama-server:embeddinggemma-2', embedding_dimensions: 768, env: {} });
    const check = await run();
    expect(check).toMatchObject({ name: 'fact_admission_floors', status: 'ok', severity: 'info', readiness_state: 'degraded',
      details: { key: 'llama-server:embeddinggemma-2@768', reserve_cosine_min: 0.5, facts_arm_cosine_min: 0.6, measured: false } });
    expect(check.message).toContain('not measured for llama-server:embeddinggemma-2@768');
    expect(categorizeCheck('fact_admission_floors')).toBe('brain');
  });

  test('the default model is not claimed as measured without an eval', async () => {
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'k' } });
    expect((await run()).details).toMatchObject({ key: 'voyage:voyage-4@1024', measured: false, evidence: null });
  });

  test('the query facts arm and the facts_arm admission rule share one floor', () => {
    expect(FACT_COSINE_MIN).toBe(FACTS_ARM_COSINE_MIN);
  });
});
