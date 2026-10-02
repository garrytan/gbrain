/**
 * System One S9 (`conflict`) sweep on PGLite through the real call sites with
 * a fixture decide transport (no provider is called).
 *
 * Protects: the inline fact write path (writeSingleFact) and the sweep never
 * supersede anything; the first run only records the watermark; the
 * watermark only advances past facts older than 60 s (interleaved commits);
 * each pair is judged independently (a duplicate does not suppress a
 * supersede proposal against another neighbour); unordered pairs are judged
 * once within and across sweeps; proposals carry sweep_id and a unique pair
 * index and are written only in `on` mode (shadow: receipts only); no_entity
 * and no_embedding skips write receipts, no_embedding and provider failures
 * defer with an attempt cap; timeout, 429, 5xx, budget exhausted, model drift
 * and egress refusal produce no proposal; receipts carry hashes only; the
 * extract_facts cycle phase output is byte-identical with the slot off and
 * carries the sweep counts with it on.
 * Serial: mutates GBRAIN_HOME and the process-global gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { getSweepWatermark, setSweepWatermark } from '../../src/core/ai/decide/proposals-store.ts';
import { runConflictSweep } from '../../src/core/ai/decide/sweep.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { runSweepCommand } from '../../src/commands/decide/proposals.ts';
import { expectGolden, defineNormalizer } from '../helpers/golden.ts';
import { withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let brainDir: string;
const SLUG = 'people/alice-example';
const DIM = 1536;
const LATER = () => Date.now() + 120_000;

/** `[gN]` picks a direction, `[vM]` a small offset: two variants of one group have cosine ~0.86 (candidates, below the 0.95 write-path dedup). */
function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const g = /\[g(\d+)\]/.exec(text);
  const m = /\[v(\d+)\]/.exec(text);
  if (!g) { v[1000 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 400)] = 1; return v; }
  v[Number(g[1]) * 20] = 1;
  if (m) v[Number(g[1]) * 20 + 1 + Number(m[1])] = 0.4;
  return v;
}

type Probs = { duplicate: number; supersede: number; independent: number };
let bodies: any[] = [];
function transport(judge: (fact: string, candidate: string) => Probs, model = 'jev-1.13.0') {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const probabilities = judge(body.state.fact, q.instructions.candidate);
      const choice = (Object.entries(probabilities) as Array<[string, number]>).sort((a, b) => b[1] - a[1])[0]![0];
      return [id, { type: 'choice', choice, confidence: probabilities[choice as keyof Probs], probabilities }];
    }));
    return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 50, output_tokens: 5 } }));
  });
}
const P = (duplicate: number, supersede: number, independent: number): Probs => ({ duplicate, supersede, independent });

const ON = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'on', 'decide.slots.conflict.threshold': '0.8',
  'decide.egress.typesafe.facts': 'allow', 'decide.egress.private': 'allow',
};
async function setConfig(kv: Record<string, string>) { for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v); }

async function remember(fact: string, entity: string | null = SLUG): Promise<number> {
  const r = await writeSingleFact(engine, 'default', { fact, provenance: 'test', entity, kind: 'fact' });
  expect(r.status).toBe('inserted');
  return r.id;
}

async function facts() {
  return (await engine.executeRaw<{ id: number; fact: string; expired_at: unknown; superseded_by: number | null }>(
    'SELECT id, fact, expired_at, superseded_by FROM facts ORDER BY id')).map((f) => ({ ...f, id: Number(f.id) }));
}
async function proposals() {
  return engine.executeRaw<Record<string, unknown>>('SELECT * FROM decide_proposals ORDER BY id');
}
async function receipts() {
  await flushDecideWrites();
  return engine.executeRaw<Record<string, unknown>>(`SELECT * FROM decision_receipts WHERE slot = 'conflict' ORDER BY id`);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-conflict-sweep-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  bodies = [];
  brainDir = mkdtempSync(join(tmpdir(), 'conflict-brain-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(embed) })) as never);
  const content = `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n`;
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(join(brainDir, `${SLUG}.md`), content);
  await importFromContent(engine, SLUG, content, { noEmbed: true, sourceId: 'default' });
});

afterEach(() => {
  __setDecideTransportForTests(null);
  rmSync(brainDir, { recursive: true, force: true });
});

describe('sweep scope', () => {
  test('first run records the current max fact id and sweeps nothing; --since sweeps earlier facts', async () => {
    const a = await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await setConfig(ON);
    transport(() => P(0.1, 0.8, 0.1));
    const first = await runConflictSweep(engine, { now: LATER });
    expect(first).toMatchObject({ first_run: true, facts: 0, watermark: { from: null, to: a + 1 } });
    expect(bodies).toHaveLength(0);
    const since = await runConflictSweep(engine, { since: 0, now: LATER });
    expect(since.facts).toBe(2);
    expect(since.proposals).toBe(1);
    expect(await getSweepWatermark(engine, 'default')).toBe(a + 1);
  });

  test('the watermark only advances past facts older than 60 s (interleaved commits)', async () => {
    const a = await remember('[g1][v1] Alice leads research');
    const b = await remember('[g2][v1] Alice lives in Lisbon');
    const c = await remember('[g3][v1] Alice owns a boat');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes' WHERE id IN ($1, $2)`, [a, c]);
    await setConfig(ON);
    await setSweepWatermark(engine, 'default', 0);
    transport(() => P(0.1, 0.1, 0.8));
    const r = await runConflictSweep(engine);
    expect(r.facts).toBe(1);
    expect(r.watermark).toEqual({ from: 0, to: a });
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes' WHERE id = $1`, [b]);
    const next = await runConflictSweep(engine);
    expect(next.facts).toBe(2);
    expect(next.watermark).toEqual({ from: a, to: c });
  });
});

describe('sweep outcomes', () => {
  test('each pair is judged independently: a duplicate does not suppress a supersede proposal', async () => {
    const dup = await remember('[g1][v1] Alice leads the research team');
    const old = await remember('[g1][v2] Alice leads research');
    const fresh = await remember('[g1][v3] Alice now leads design');
    await setConfig(ON);
    transport((_f, c) => (c.includes('research team') ? P(0.9, 0.05, 0.05) : P(0.1, 0.7, 0.2)));
    const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER });
    expect(r).toMatchObject({ facts: 1, pairs: 2, duplicates: 1, proposals: 1, independents: 0, skipped: 0 });
    const [p] = await proposals();
    expect({ ...p, new_fact_id: Number(p!.new_fact_id), old_fact_id: Number(p!.old_fact_id) }).toMatchObject({ new_fact_id: fresh, old_fact_id: old, status: 'pending', direction: 'new_supersedes_old', sweep_id: r.sweep_id, pair_index: 0 });
    expect(Number(p!.p_supersede)).toBeCloseTo(0.7, 5);
    expect(Number(p!.proposal_floor)).toBe(0.5);
    // Proposal-only: nothing was superseded by the sweep or the inline write path.
    expect((await facts()).every((f) => f.expired_at === null && f.superseded_by === null)).toBe(true);
    const rows = await receipts();
    expect(rows.map((x) => x.outcome).sort()).toEqual(['duplicate', 'proposal']);
    const dump = JSON.stringify(rows);
    for (const text of ['Alice', 'research', 'design']) expect(dump).not.toContain(text);
    expect(rows.every((x) => typeof x.subject_ref === 'string' && (x.subject_ref as string).length === 32 && x.lane === 'background' && x.call_site === 'sweep')).toBe(true);
    expect(dup).toBeLessThan(old);
  });

  test('the new fact is excluded from its own neighbours and ineligible rows never take a slot', async () => {
    const fresh = await remember('[g1][v1] Alice leads design');
    await remember('[g1][v2] Alice leads research', 'companies/acme-example');
    await writeSingleFact(engine, 'default', { fact: '[g1][v3] Alice leads marketing', provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
    await setConfig(ON);
    transport(() => P(0.1, 0.8, 0.1));
    const r = await runConflictSweep(engine, { since: fresh - 1, maxFacts: 1, now: LATER });
    expect(r).toMatchObject({ facts: 1, pairs: 0, proposals: 0 });
    expect(bodies).toHaveLength(0);
  });

  test('unordered pairs are judged once within a sweep and across sweeps', async () => {
    await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await setConfig(ON);
    transport(() => P(0.1, 0.2, 0.7));
    const r = await runConflictSweep(engine, { since: 0, now: LATER });
    expect(r).toMatchObject({ facts: 2, pairs: 1, independents: 1 });
    expect(bodies).toHaveLength(1);
    const again = await runConflictSweep(engine, { since: 0, now: LATER });
    expect(again.pairs).toBe(0);
    expect(bodies).toHaveLength(1);
  });

  test('shadow mode writes receipts only', async () => {
    await remember('[g1][v1] Alice leads research');
    const fresh = await remember('[g1][v2] Alice leads design');
    await setConfig({ ...ON, 'decide.slots.conflict.mode': 'shadow' });
    transport(() => P(0.1, 0.8, 0.1));
    const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER });
    expect(r).toMatchObject({ effective: 'shadow', proposals: 0, shadow_proposals: 1 });
    expect(await proposals()).toHaveLength(0);
    expect((await receipts()).map((x) => [x.mode, x.outcome])).toEqual([['shadow', 'proposal']]);
  });

  test('no_entity and no_embedding skip with receipts; no_embedding defers and retries up to the cap', async () => {
    await remember('[g1][v1] Alice leads research');
    const noEntity = await remember('[g9][v1] a subjectless fact', null);
    const noEmbedding = await remember('[g1][v2] Alice leads design');
    await engine.executeRaw('CREATE TEMP TABLE IF NOT EXISTS emb_backup AS SELECT id, embedding FROM facts WHERE false');
    await engine.executeRaw('INSERT INTO emb_backup SELECT id, embedding FROM facts WHERE id = $1', [noEmbedding]);
    await engine.executeRaw('UPDATE facts SET embedding = NULL WHERE id = $1', [noEmbedding]);
    await setConfig(ON);
    transport(() => P(0.1, 0.8, 0.1));
    const r = await runConflictSweep(engine, { since: noEntity - 1, now: LATER });
    expect(r).toMatchObject({ facts: 2, skipped: 2, deferred: 1, proposals: 0 });
    expect((await receipts()).map((x) => [x.outcome, x.error_reason]).sort()).toEqual([['skipped', 'no_embedding'], ['skipped', 'no_entity']]);
    const [deferred] = await engine.executeRaw<{ fact_id: string; attempts: number; reason: string }>('SELECT * FROM decide_sweep_deferred');
    expect({ ...deferred, fact_id: Number(deferred!.fact_id), attempts: Number(deferred!.attempts) }).toMatchObject({ fact_id: noEmbedding, attempts: 1, reason: 'no_embedding' });
    // Embedding backfilled; the retry is due.
    await engine.executeRaw('UPDATE facts f SET embedding = b.embedding FROM emb_backup b WHERE f.id = b.id');
    await engine.executeRaw(`UPDATE decide_sweep_deferred SET next_attempt_at = now() - interval '1 minute'`);
    const retry = await runConflictSweep(engine, { now: LATER });
    expect(retry).toMatchObject({ retried: 1, proposals: 1 });
    expect(await engine.executeRaw('SELECT * FROM decide_sweep_deferred')).toEqual([]);
    // At the attempt cap a deferred fact is no longer retried.
    await engine.executeRaw(`INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at) VALUES ('default', $1, 'conflict', 'timeout', 5, now() - interval '1 minute')`, [noEntity]);
    expect((await runConflictSweep(engine, { now: LATER })).retried).toBe(0);
  });
});

describe('fail directions: no proposal, the fact stays as written', () => {
  const cases: Array<[string, () => void | Promise<void>, string, boolean]> = [
    ['timeout', () => __setDecideTransportForTests(async (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))), 'timeout', true],
    ['429', () => __setDecideTransportForTests(async () => new Response('slow down', { status: 429 })), 'rate_limited', true],
    ['5xx', () => __setDecideTransportForTests(async () => new Response('boom', { status: 503 })), 'provider_error', true],
    ['budget exhausted', async () => { await setConfig({ 'decide.budget.daily_usd': '0' }); transport(() => P(0.1, 0.9, 0)); }, 'budget_exhausted', true],
  ];
  for (const [name, setup, reason, deferred] of cases) {
    test(name, async () => {
      await remember('[g1][v1] Alice leads research');
      const fresh = await remember('[g1][v2] Alice leads design');
      await setConfig(ON);
      await setup();
      const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER, deadlineMs: 200 });
      expect(r).toMatchObject({ proposals: 0, skipped: 1, deferred: deferred ? 1 : 0 });
      expect(await proposals()).toHaveLength(0);
      expect((await receipts()).every((x) => x.outcome === 'error' && x.error_reason === reason)).toBe(true);
      expect((await facts()).every((f) => f.expired_at === null)).toBe(true);
      if (name === 'budget exhausted') expect(r.stopped).toBe('budget_exhausted');
    });
  }

  test('model drift runs with off behavior for that call (receipt model_drift)', async () => {
    await remember('[g1][v1] Alice leads research');
    const fresh = await remember('[g1][v2] Alice leads design');
    await setConfig({ ...ON, 'decide.slots.conflict.threshold': '' });
    await engine.unsetConfig('decide.slots.conflict.threshold');
    await insertCalibration(engine, {
      slot: 'conflict', call_site: 'sweep', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.8, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.05, retest_sd: 0.01, repack_sd: 0.01, n: 60, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('conflict'), notes: null,
    });
    transport(() => P(0.1, 0.9, 0), 'jev-1.14.0');
    const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER });
    expect(r).toMatchObject({ effective: 'on', proposals: 0, skipped: 1, deferred: 0 });
    expect((await receipts()).map((x) => [x.outcome, x.error_reason])).toEqual([['skipped', 'model_drift']]);
  });

  test('egress refused (private facts, decide.egress.private deny) sends nothing', async () => {
    await remember('[g1][v1] Alice leads research');
    const fresh = await remember('[g1][v2] Alice leads design');
    await setConfig({ ...ON, 'decide.egress.private': 'deny' });
    transport(() => P(0.1, 0.9, 0));
    const r = await runConflictSweep(engine, { since: fresh - 1, now: LATER });
    expect(r).toMatchObject({ proposals: 0, skipped: 1, deferred: 0 });
    expect(bodies).toHaveLength(0);
    expect((await receipts()).map((x) => [x.outcome, x.error_reason])).toEqual([['skipped', 'egress_private_denied']]);
  });

  test('decide.provider none stops the sweep (inactive, nothing sent, watermark untouched)', async () => {
    await remember('[g1][v1] Alice leads research');
    await setConfig({ ...ON, 'decide.provider': 'none' });
    transport(() => P(0.1, 0.9, 0));
    const r = await runConflictSweep(engine, { since: 0, now: LATER });
    expect(r).toMatchObject({ effective: 'off', inactive: 'no_provider', facts: 0 });
    expect(bodies).toHaveLength(0);
    expect(await getSweepWatermark(engine, 'default')).toBeNull();
  });
});

describe('extract_facts cycle phase tail', () => {
  async function phase() {
    const report = await withEnv({ GBRAIN_HOME: home }, () => runCycle(engine, { brainDir: null, phases: ['extract_facts'] }));
    return report.phases.find((p) => p.phase === 'extract_facts')!;
  }

  test('slot off: phase output byte-identical to a keyless brain with no decide keys, and no decide work', async () => {
    await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes'`);
    transport(() => P(0.1, 0.9, 0));
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test' } });
    const baseline = await phase();
    expect(JSON.stringify(baseline.details)).not.toContain('decide_conflict');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
    await setConfig({ ...ON, 'decide.slots.conflict.mode': 'off' });
    const off = await phase();
    const strip = (p: typeof off) => JSON.stringify({ ...p, duration_ms: 0 });
    expect(strip(off)).toBe(strip(baseline));
    expect(JSON.stringify(off.details)).not.toContain('decide_conflict');
    expect(bodies).toHaveLength(0);
    expect(await receipts()).toHaveLength(0);
    expect(await getSweepWatermark(engine, 'default')).toBeNull();
  });

  test('key-aware default: a TypeSafe key and no decide keys sweeps with the reference calibration and sends private facts', async () => {
    await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes'`);
    await setSweepWatermark(engine, 'default', 0);
    transport(() => P(0.1, 0.8, 0.1));
    const on = await phase();
    expect((on.details as Record<string, unknown>).decide_conflict).toMatchObject({ effective: 'on', facts: 2, proposals: 1, skipped: 0 });
    expect(bodies.length).toBeGreaterThan(0);
    expect(await proposals()).toHaveLength(1);
    expect((await facts()).every((f) => f.expired_at === null)).toBe(true);
    expect(await engine.executeRaw(`SELECT key FROM config WHERE key LIKE 'decide.%'`)).toEqual([]);
  });

  test('key-aware default: decide disable conflict (mode off) wins', async () => {
    await remember('[g1][v1] Alice leads research');
    await setSweepWatermark(engine, 'default', 0);
    await setConfig({ 'decide.slots.conflict.mode': 'off' });
    transport(() => P(0.1, 0.8, 0.1));
    const off = await phase();
    expect(JSON.stringify(off.details)).not.toContain('decide_conflict');
    expect(bodies).toHaveLength(0);
  });

  test('slot on: the phase tail sweeps and reports proposals in the phase details', async () => {
    await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes'`);
    await setConfig(ON);
    await setSweepWatermark(engine, 'default', 0);
    transport(() => P(0.1, 0.8, 0.1));
    const on = await phase();
    expect((on.details as Record<string, unknown>).decide_conflict).toMatchObject({ effective: 'on', facts: 2, proposals: 1, duplicates: 0, skipped: 0 });
    expect(await proposals()).toHaveLength(1);
    expect((await facts()).every((f) => f.expired_at === null)).toBe(true);
  });
});

describe('gbrain decide sweep --json (golden)', () => {
  test('prints the counts', async () => {
    await remember('[g1][v1] Alice leads research');
    await remember('[g1][v2] Alice leads design');
    await engine.executeRaw(`UPDATE facts SET created_at = now() - interval '5 minutes'`);
    await setConfig(ON);
    transport(() => P(0.1, 0.8, 0.1));
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    let code: number;
    try { code = await runSweepCommand(engine, ['--slot', 'conflict', '--since', '0', '--json']); } finally { console.log = log; }
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.sweeps[0]).toMatchObject({ proposals: 1, facts: 2 });
    expectGolden('decide/sweep-conflict-json', json, defineNormalizer('decide-sweep-v1', (v: any) => ({
      sweeps: v.sweeps.map((s: any) => ({ ...s, sweep_id: '<sweep>', watermark: { from: s.watermark.from, to: s.watermark.to === null ? null : '<fact id>' } })),
    })));
  });
});
