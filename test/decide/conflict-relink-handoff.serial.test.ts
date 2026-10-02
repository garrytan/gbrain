/**
 * #5836 conflict-sweep handoff for relinked facts, on PGLite with a fixture
 * decide transport (no provider is called).
 *
 * Protects: enqueueRelinked queues facts with attempts 0, due now, reason
 * `relinked`, inside the caller's transaction, and never touches an existing
 * deferred row; dueDeferred orders by due time so a large relinked backlog
 * never starves a transient retry; the sweep picks a relinked fact up through
 * the deferred path and judges it; when the swept fact is older than its
 * neighbour (valid_from, then created_at) the newer fact is presented as the
 * new claim, both timestamps ride in the evidence, and a proposal would
 * retire the older fact.
 * Serial: mutates the process-global gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { deferFact, dueDeferred, enqueueRelinked, maxFactId, setSweepWatermark } from '../../src/core/ai/decide/proposals-store.ts';
import { SWEEP_MAX_FACTS, runConflictSweep } from '../../src/core/ai/decide/sweep.ts';

let engine: PGLiteEngine;
const SLUG = 'people/alice-example';
const DIM = 1536;
const LATER = () => Date.now() + 120_000;

function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const g = /\[g(\d+)\]/.exec(text);
  const m = /\[v(\d+)\]/.exec(text);
  if (!g) { v[1000 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 400)] = 1; return v; }
  v[Number(g[1]) * 20] = 1;
  if (m) v[Number(g[1]) * 20 + 1 + Number(m[1])] = 0.4;
  return v;
}

let bodies: any[] = [];
function supersedeTransport() {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const probabilities = { duplicate: 0.1, supersede: 0.8, independent: 0.1 };
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'choice', choice: 'supersede', confidence: 0.8, probabilities }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 5 } }));
  });
}

const ON = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'on', 'decide.slots.conflict.threshold': '0.8',
  'decide.egress.typesafe.facts': 'allow', 'decide.egress.private': 'allow',
};

async function remember(fact: string, entity: string | null = SLUG): Promise<number> {
  const r = await writeSingleFact(engine, 'default', { fact, provenance: 'test', entity, kind: 'fact' });
  expect(r.status).toBe('inserted');
  return r.id;
}

async function deferredRows() {
  return (await engine.executeRaw<{ fact_id: string; reason: string; attempts: number; due: boolean }>(
    `SELECT fact_id, reason, attempts, next_attempt_at <= now() AS due FROM decide_sweep_deferred ORDER BY fact_id`))
    .map((r) => ({ fact_id: Number(r.fact_id), reason: r.reason, attempts: Number(r.attempts), due: r.due === true || (r.due as unknown) === 't' }));
}

/** A relinked fact: written without an entity (it never reached the sweep), backdated, then given its entity. */
async function relinkedFact(fact: string, daysOld: number): Promise<number> {
  const id = await remember(fact, null);
  await engine.executeRaw(
    `UPDATE facts SET entity_slug = $2, valid_from = now() - ($3::int * interval '1 day'), created_at = now() - ($3::int * interval '1 day') WHERE id = $1`,
    [id, SLUG, daysOld]);
  return id;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  bodies = [];
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(embed) })) as never);
  await importFromContent(engine, SLUG, `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n`, { noEmbed: true, sourceId: 'default' });
});

afterEach(() => { __setDecideTransportForTests(null); });

describe('enqueueRelinked', () => {
  test('queues attempts 0, due now, reason relinked; an existing row is left unchanged', async () => {
    await deferFact(engine, 'default', 7, 'no_embedding');
    const before = await engine.executeRaw('SELECT * FROM decide_sweep_deferred WHERE fact_id = 7');
    const queued = await engine.transaction((tx) => enqueueRelinked(tx, 'default', [5, 7, 9]));
    expect(queued).toBe(2);
    expect(await deferredRows()).toEqual([
      { fact_id: 5, reason: 'relinked', attempts: 0, due: true },
      { fact_id: 7, reason: 'no_embedding', attempts: 1, due: false },
      { fact_id: 9, reason: 'relinked', attempts: 0, due: true },
    ]);
    expect(await engine.executeRaw('SELECT * FROM decide_sweep_deferred WHERE fact_id = 7')).toEqual(before);
    expect((await dueDeferred(engine, 'default', 10)).map((d) => d.fact_id)).toEqual([5, 9]);
    expect(await enqueueRelinked(engine, 'default', [5, 9])).toBe(0);
    expect((await deferredRows()).filter((r) => r.reason === 'relinked').every((r) => r.attempts === 0)).toBe(true);
    expect(await enqueueRelinked(engine, 'default', [])).toBe(0);
  });

  test('rides the caller transaction: a rolled-back relink queues nothing', async () => {
    await expect(engine.transaction(async (tx) => {
      await enqueueRelinked(tx, 'default', [11, 12]);
      throw new Error('relink write failed');
    })).rejects.toThrow('relink write failed');
    expect(await deferredRows()).toEqual([]);
  });
});

describe('deferred-queue fairness', () => {
  test('500 relinked rows and one transient retry: the transient drains within one sweep quota', async () => {
    await deferFact(engine, 'default', 10_000, 'timeout');
    await engine.executeRaw(`UPDATE decide_sweep_deferred SET next_attempt_at = now() - interval '1 minute' WHERE fact_id = 10000`);
    await enqueueRelinked(engine, 'default', Array.from({ length: 500 }, (_, i) => i + 1));
    const due = await dueDeferred(engine, 'default', SWEEP_MAX_FACTS);
    expect(due).toHaveLength(SWEEP_MAX_FACTS);
    expect(due[0]).toEqual({ fact_id: 10_000, attempts: 1 });
    expect(due.slice(1).map((d) => d.fact_id)).toEqual(Array.from({ length: SWEEP_MAX_FACTS - 1 }, (_, i) => i + 1));
  });
});

describe('sweep pickup and chronology', () => {
  test('a relinked fact with an embedding is picked up from the deferred queue and judged', async () => {
    const neighbour = await remember('[g1][v1] Alice leads research');
    const relinked = await relinkedFact('[g1][v2] Alice leads design', 0);
    await engine.executeRaw(`UPDATE facts SET valid_from = now() - interval '1 day', created_at = now() - interval '1 day' WHERE id = $1`, [neighbour]);
    const [row] = await engine.executeRaw<{ ok: boolean }>(`SELECT (embedding IS NOT NULL AND embedded_text_hash = md5(fact)) AS ok FROM facts WHERE id = $1`, [relinked]);
    expect(row!.ok).toBe(true);
    for (const [k, v] of Object.entries(ON)) await engine.setConfig(k, v);
    await setSweepWatermark(engine, 'default', await maxFactId(engine, 'default'));
    expect(await enqueueRelinked(engine, 'default', [relinked])).toBe(1);
    supersedeTransport();
    const r = await runConflictSweep(engine, { now: LATER });
    expect(r).toMatchObject({ retried: 1, facts: 1, pairs: 1, proposals: 1 });
    expect(bodies).toHaveLength(1);
    expect(await deferredRows()).toEqual([]);
    const [p] = await engine.executeRaw<{ new_fact_id: string; old_fact_id: string }>('SELECT new_fact_id, old_fact_id FROM decide_proposals');
    expect([Number(p!.new_fact_id), Number(p!.old_fact_id)]).toEqual([relinked, neighbour]);
  });

  test('an older relinked fact judged against a newer neighbour: the newer fact is the claim and the proposal retires the older one', async () => {
    const newer = await remember('[g1][v1] Alice now leads design');
    const older = await relinkedFact('[g1][v2] Alice leads research', 30);
    expect(older).toBeGreaterThan(newer);
    for (const [k, v] of Object.entries(ON)) await engine.setConfig(k, v);
    await setSweepWatermark(engine, 'default', await maxFactId(engine, 'default'));
    await enqueueRelinked(engine, 'default', [older]);
    supersedeTransport();
    const r = await runConflictSweep(engine, { now: LATER });
    expect(r).toMatchObject({ retried: 1, pairs: 1, proposals: 1 });
    const [p] = await engine.executeRaw<{ new_fact_id: string; old_fact_id: string; direction: string }>('SELECT new_fact_id, old_fact_id, direction FROM decide_proposals');
    expect({ new: Number(p!.new_fact_id), retires: Number(p!.old_fact_id) }).toEqual({ new: newer, retires: older });
    const [body] = bodies;
    expect(body.state.fact).toBe('[g1][v1] Alice now leads design');
    const [q] = Object.values(body.questions) as any[];
    expect(q.instructions.candidate).toBe('[g1][v2] Alice leads research');
    const [times] = await engine.executeRaw<{ newer_from: Date; older_from: Date }>(
      'SELECT n.valid_from AS newer_from, o.valid_from AS older_from FROM facts n, facts o WHERE n.id = $1 AND o.id = $2', [newer, older]);
    expect(body.state.fact_time).toContain(`valid from ${new Date(times!.newer_from).toISOString()}`);
    expect(q.instructions.candidate_time).toContain(`valid from ${new Date(times!.older_from).toISOString()}`);
  });

  test('a fact newer than its neighbours keeps the packed request with no timestamps (unchanged shape)', async () => {
    const old = await remember('[g1][v1] Alice leads research');
    await engine.executeRaw(`UPDATE facts SET valid_from = now() - interval '1 day', created_at = now() - interval '1 day' WHERE id = $1`, [old]);
    const fresh = await remember('[g1][v2] Alice now leads design');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes' WHERE id = $1`, [fresh]);
    for (const [k, v] of Object.entries(ON)) await engine.setConfig(k, v);
    supersedeTransport();
    const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER });
    expect(r).toMatchObject({ facts: 1, proposals: 1 });
    expect(Object.keys(bodies[0].state)).toEqual(['fact']);
    expect(Object.keys((Object.values(bodies[0].questions)[0] as any).instructions)).toEqual(['task', 'candidate']);
    const [p] = await engine.executeRaw<{ new_fact_id: string; old_fact_id: string }>('SELECT new_fact_id, old_fact_id FROM decide_proposals');
    expect([Number(p!.new_fact_id), Number(p!.old_fact_id)]).toEqual([fresh, old]);
  });
});
