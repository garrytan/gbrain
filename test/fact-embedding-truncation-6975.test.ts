/**
 * #6975: embed() sends at most EMBED_MAX_CHARS (8000) UTF-16 code units of a fact, but the
 * vector is stamped with md5 of the whole fact. md5(fact) stays the freshness key (no stamp
 * change, no re-embed, no extra spend); doctor's fact_take_vectors reports such facts as
 * partially embedded instead of claiming full coverage. Both backends (Postgres through the
 * e2e twin).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { EMBED_MAX_CHARS } from '../src/core/ai/embed-batch-plan.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { factTakeVectorsEntry } from '../src/commands/doctor/checks/vector-coverage.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { readFactsEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { testBackends } from './helpers/test-backends.ts';

const SOURCE = 'truncation-6975';
const MODEL = 'openai:text-embedding-3-small';
const LONG = 'a'.repeat(EMBED_MAX_CHARS + 1);
// Exactly the cap, with characters a misparsed astral range would count.
const EXACT = 'a'.repeat(EMBED_MAX_CHARS - 3) + 'U1\\';
// 8000 code points but 8001 UTF-16 code units: embed() cuts it too.
const ASTRAL = 'a'.repeat(EMBED_MAX_CHARS - 1) + '\u{1F600}';
let calls: string[][] = [];
let DIMS = 0;

const doctor = async (engine: BrainEngine) =>
  (await factTakeVectorsEntry.run({ engine, orphanRatioSourceId: SOURCE, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0];

for (const backend of testBackends()) describe(`fact embedding truncation (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB, getEngine } = await import('./e2e/helpers.ts');
      await setupDB();
      engine = getEngine();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SOURCE]);
    DIMS = (await readFactsEmbeddingDim(engine)).dims!;
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIMS));
  });
  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [SOURCE]);
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
    if (backend === 'pglite') await engine.disconnect();
  });
  beforeEach(async () => {
    calls = [];
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test-key' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      calls.push([...values]);
      return { values, usage: { tokens: values.length }, warnings: [], embeddings: values.map(() => Array(DIMS).fill(0.25)) };
    }) as never);
    await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [SOURCE]);
  });

  test('a fact over the input cap embeds once, reports partially embedded, and stays fresh', async () => {
    for (const fact of [LONG, EXACT, ASTRAL, 'Alice example joined Acme example.']) {
      await engine.insertFact({ fact, kind: 'fact', confidence: 1, source: 'notes', visibility: 'world', notability: 'medium' }, { source_id: SOURCE });
    }
    const first = await embedStaleFacts(engine, { sourceId: SOURCE, yes: true, maxCostUsd: 1 });
    expect(first).toMatchObject({ embedded: 4, failures: 0, remaining: 0, stopped: 'complete' });
    expect(calls.flat().map(v => v.length).sort((x, y) => x - y)).toEqual([34, EMBED_MAX_CHARS - 1, EMBED_MAX_CHARS, EMBED_MAX_CHARS]);

    const check = await doctor(engine);
    expect(check).toMatchObject({ status: 'ok', details: { facts: { stale: 0, partially_embedded: 2 } } });
    expect(check.message).toContain('2 fact(s) are partially embedded');

    calls = [];
    const second = await embedStaleFacts(engine, { sourceId: SOURCE, yes: true, maxCostUsd: 1 });
    expect(second).toMatchObject({ total_stale: 0, embedded: 0, cost_usd: 0 });
    expect(calls).toEqual([]);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { facts: { partially_embedded: 2 } } });
  });

  test('facts without a current vector are stale, not partially embedded', async () => {
    await engine.insertFact({ fact: LONG, kind: 'fact', confidence: 1, source: 'notes', visibility: 'world', notability: 'medium' }, { source_id: SOURCE });
    expect(await doctor(engine)).toMatchObject({ status: 'warn', details: { facts: { stale: 1, missing: 1, partially_embedded: 0 } } });
    expect(calls).toEqual([]);
  });
});
