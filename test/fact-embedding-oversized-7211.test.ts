/**
 * #7211: one fact longer than the embedding input limit must not wedge the
 * stale-fact backfill. Before, the loop threw "A fact exceeds the embedding
 * input limit; no batch was sent" for the whole batch, so every later run hit
 * the same row first and the facts behind it never embedded.
 *
 * Policy: no silent truncation. An oversized fact is skipped with a reported
 * refusal (run summary, doctor fact_take_vectors, embed --held), stays stale
 * with its text unchanged, and embeds once an edit makes it fit. Every other
 * fact progresses, and skipped facts do not use up --max-facts.
 * The cap is pinned low (GBRAIN_MAX_CHUNK_TOKENS=64) so short synthetic facts
 * cross it; the astral fact is under 64 characters but over 64 tokens.
 * Reported by @dyana1lyons-ai.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { estimateTokens } from '../src/core/chunkers/token-estimate.ts';
import { factTakeVectorsEntry } from '../src/commands/doctor/checks/vector-coverage.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { readFactsEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { heldEmbedArgv } from '../src/core/held-embedding.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'oversized-fact-7211';
const MODEL = 'openai:text-embedding-3-small';
const CAP = 64;
const LONG = Array.from({ length: 60 }, (_, i) => 'clause' + i).join(' ');
const ASTRAL = '\u{1F9EA}\u{1F52C}\u{1F9EC}'.repeat(15);
let calls: string[][] = [];
let DIMS = 0;

const doctor = async (engine: BrainEngine) =>
  (await factTakeVectorsEntry.run({ engine, orphanRatioSourceId: SOURCE, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0];
const approved = { sourceId: SOURCE, yes: true, maxCostUsd: 1 };
const capped = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_MAX_CHUNK_TOKENS: String(CAP) }, fn);

for (const backend of testBackends()) describe('oversized facts never wedge the fact backfill (' + backend + ')', () => {
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

  async function seed(...facts: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const fact of facts) {
      const row = await engine.insertFact({ fact, kind: 'fact', confidence: 1, source: 'notes', visibility: 'world', notability: 'medium' }, { source_id: SOURCE });
      ids.push(String(row.id));
    }
    return ids;
  }
  const texts = async () => (await engine.executeRaw<{ fact: string; embedded: boolean }>(
    'SELECT fact, embedding IS NOT NULL AS embedded FROM facts WHERE source_id = $1 ORDER BY id', [SOURCE])).map(r => [r.fact, r.embedded]);

  test('the fixtures cross the cap by tokens, not only by characters', () => {
    expect(estimateTokens(LONG)).toBeGreaterThan(CAP);
    expect([...ASTRAL].length).toBeLessThan(CAP);
    expect(estimateTokens(ASTRAL)).toBeGreaterThan(CAP);
  });

  test('normal facts embed, oversized facts are refused with their ids, and a second run does not wedge', async () => {
    const [, longId, , astralId] = await seed('Alice example joined Acme example.', LONG, 'Bob example leads Fund A.', ASTRAL, 'Carol example moved to Oslo.');
    const first = await capped(() => embedStaleFacts(engine, approved));
    expect(first).toMatchObject({ embedded: 3, attempted: 3, failures: 0, failure_samples: [], refused_oversized: 2, remaining: 0, stopped: 'complete' });
    expect(first.refused_samples.join('\n')).toContain('fact ' + longId);
    expect(first.refused_samples.join('\n')).toContain('fact ' + astralId);
    expect(first.refused_fix).toContain('foresights forget');
    expect(calls.flat()).not.toContain(LONG);
    expect(calls.flat()).not.toContain(ASTRAL);
    expect(await texts()).toEqual([['Alice example joined Acme example.', true], [LONG, false], ['Bob example leads Fund A.', true], [ASTRAL, false], ['Carol example moved to Oslo.', true]]);

    calls = [];
    const second = await capped(() => embedStaleFacts(engine, approved));
    expect(second).toMatchObject({ total_stale: 2, embedded: 0, failures: 0, refused_oversized: 2, remaining: 0, stopped: 'complete' });
    expect(calls).toEqual([]);
  });

  test('refused facts do not use up --max-facts', async () => {
    await seed(LONG, ASTRAL, 'Alice example joined Acme example.');
    const run = await capped(() => embedStaleFacts(engine, { ...approved, maxFacts: 1 }));
    expect(run).toMatchObject({ embedded: 1, attempted: 1, refused_oversized: 2, remaining: 0 });
  });

  test('an edit that makes the fact fit embeds it; an edit to an embedded fact makes it stale again', async () => {
    const [shortId, longId] = await seed('Alice example joined Acme example.', LONG);
    await capped(() => embedStaleFacts(engine, approved));
    await engine.executeRaw("UPDATE facts SET fact = 'Dave example founded Acme example.' WHERE id = $1::bigint", [longId]);
    await engine.executeRaw("UPDATE facts SET fact = 'Alice example left Acme example.' WHERE id = $1::bigint", [shortId]);
    calls = [];
    const run = await capped(() => embedStaleFacts(engine, approved));
    expect(run).toMatchObject({ total_stale: 2, embedded: 2, refused_oversized: 0, remaining: 0, stopped: 'complete' });
    expect(calls.flat().sort()).toEqual(['Alice example left Acme example.', 'Dave example founded Acme example.']);
  });

  test('the preview counts refused facts apart from the work it would do', async () => {
    await seed(LONG, 'Alice example joined Acme example.');
    const preview = await capped(() => embedStaleFacts(engine, { sourceId: SOURCE }));
    expect(preview).toMatchObject({ dryRun: true, total_stale: 2, would_embed: 1, refused_oversized: 1, stopped: 'preview' });
    expect(calls).toEqual([]);
  });

  test('doctor and embed --held name the refused facts and the fix', async () => {
    const [longId] = await seed(LONG);
    const check = await capped(() => doctor(engine));
    expect(check).toMatchObject({ status: 'warn', details: { facts: { stale: 1, oversized: 1 } } });
    expect(check.message).toContain('longer than the embedding input limit');
    expect(check.message).toContain('foresights forget');
    const said: string[] = [];
    const held = await capped(() => heldEmbedArgv(engine, ['--held', '--dry-run'], null, line => said.push(line)));
    expect(held).toMatchObject({ dryRun: true, oversized_facts: [{ id: longId, source_id: SOURCE }] });
    expect(said.join('\n')).toContain('fact ' + longId);
  });
});
