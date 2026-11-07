/**
 * A completed facts-absorb chat call can use a fallback model without
 * producing an ingest failure. The health check must report that route drift.
 *
 * 1. Protects: usage rows for a different answering model warn and give the
 *    count, even when absorb logging contains only a non-failure row.
 * 2. Fails if facts_extraction_health only reads ingest_log and stays ok.
 * 3. Inserts the same per-call usage fields the gateway records and runs the
 *    real doctor entry against an isolated PGLite engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { factsExtractionEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
});

async function check(): Promise<Check> {
  const checks = await factsExtractionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  return checks.find(candidate => candidate.name === 'facts_extraction_health')!;
}

describe('facts_extraction_health reports fallback answers (#8653)', () => {
  test('counts successful facts-absorb calls answered by a different model', async () => {
    await engine.setConfig('facts.extraction_model', 'anthropic:configured-model');
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: 'notes/fallback',
      pages_updated: [], summary: 'write_pending_accepted: still publishing',
    });
    await engine.executeRaw(`INSERT INTO chat_usage_log (model, provider, phase)
      VALUES ('openai:fallback-model', 'openai', 'job:facts-absorb')`);

    const result = await check();

    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 facts-absorb call');
    expect(result.message).toContain('openai:fallback-model: 1');
    expect(result.message).toContain('anthropic:configured-model');
  });

  test('calls answered by the resolved extraction model do not warn', async () => {
    await engine.setConfig('facts.extraction_model', 'anthropic:configured-model');
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: 'notes/configured',
      pages_updated: [], summary: 'write_pending_accepted: still publishing',
    });
    await engine.executeRaw(`INSERT INTO chat_usage_log (model, provider, phase)
      VALUES ('anthropic:configured-model', 'anthropic', 'job:facts-absorb')`);

    const result = await check();

    expect(result.status).toBe('ok');
    expect(result.message).not.toContain('answered by models other than resolved extraction model');
  });
});
