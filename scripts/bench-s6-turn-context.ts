#!/usr/bin/env bun
/**
 * System One S6 (recall_needed) turn-context latency benchmark.
 *
 *   bun scripts/bench-s6-turn-context.ts [--rounds 3] [--delays-ms 120,160,300] [--json]
 *
 * Seeds every BrainBench page (evals/brainbench, default source) into one
 * in-memory PGLite brain and replays every know-to-ask user turn through
 * assembleTurnContext — the handler `gbrain serve` registers for the hook's
 * turn_context IPC kind — with the hook's window (4 prior turns + the
 * prompt). Each round runs every turn with S6 off, then with S6 on against a
 * fixture TypeSafe transport whose per-request delay is drawn from a
 * measured Jev latency sample (below) or --delays-ms. Answers are a stable
 * hash of the prompt mapped to 0.02 / 0.3 / 0.9, so the fire, no_fire and
 * suppress paths all run. Reports p50/p95/p99 of the turn with S6 off and on,
 * the paired added latency per turn, the S6 outcome mix and the deadline
 * miss rate. No provider is called.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { configureGateway, __setDecideTransportForTests } from '../src/core/ai/gateway.ts';
import { flushDecideWrites } from '../src/core/ai/decide/store.ts';
import { drainShadow } from '../src/core/ai/decide/runtime.ts';
import { assembleTurnContext } from '../src/core/context/turn-context.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetDecideSearchCache } from '../src/core/search/decide-stage.ts';
import { loadCorpus } from '../src/eval/brainbench/fixtures.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';

/** Live Jev latency for S6-shaped requests (jev-1.13.0, 20 calls, 2026-09-30, one Capy cloud machine), ms. */
const MEASURED_JEV_MS = [123, 132, 135, 137, 146, 149, 149, 153, 156, 163, 166, 186, 187, 191, 194, 197, 201, 265, 269, 319];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const ROUNDS = Number(arg('--rounds') ?? 3);
const DELAYS = arg('--delays-ms')?.split(',').map(Number) ?? MEASURED_JEV_MS;
const json = process.argv.includes('--json');

const S6_ON: Record<string, string> = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.recall_needed.mode': 'on', 'decide.slots.recall_needed.threshold': '0.5',
  'decide.slots.recall_needed.force_on': 'true', 'decide.slots.recall_needed.suppress_below': '0.1',
  'decide.egress.typesafe.conversation': 'allow', 'decide.egress.private': 'allow', 'decide.budget.daily_usd': '1000',
};

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Number(s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(1)) : 0;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: pct(xs, 1) });

const engine = await createBenchmarkBrain();
const root = join(import.meta.dir, '../evals/brainbench');
const corpus = await loadCorpus(join(root, 'fixtures'), join(root, 'gold'));
const seeded = new Set<string>();
const turns: Array<{ window: Array<{ role: 'user' | 'assistant'; text: string }> }> = [];
for (const { fixture } of corpus.fixtures) {
  if (fixture.holdout) continue;
  for (const p of fixture.seed_pages ?? []) {
    if ((p.source_id ?? 'default') !== 'default' || seeded.has(p.slug)) continue;
    seeded.add(p.slug);
    await importFromContent(engine, p.slug, p.content, { noEmbed: true });
  }
  if (!fixture.suites.includes('know-to-ask')) continue;
  fixture.turns.forEach((t, i) => {
    if (t.role === 'user') turns.push({ window: fixture.turns.slice(Math.max(0, i - 4), i + 1).map((x) => ({ role: x.role, text: x.text })) });
  });
}

configureGateway({ env: { TYPESAFE_API_KEY: 'bench-fixture' } } as never);
let delayIndex = 0;
__setDecideTransportForTests(async (_url, init) => {
  const body = JSON.parse(init.body as string);
  const delay = DELAYS[delayIndex++ % DELAYS.length]!;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  });
  const h = createHash('sha256').update(String(body.state.prompt)).digest()[0]! % 3;
  const p = [0.02, 0.3, 0.9][h]!;
  const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: p }]));
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 340, output_tokens: 1 } }));
});

async function setMode(on: boolean) {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
  if (on) for (const [k, v] of Object.entries(S6_ON)) await engine.setConfig(k, v);
  resetDecideSearchCache();
}

const off: number[] = [];
const on: number[] = [];
const added: number[] = [];
const outcomes: Record<string, number> = {};
for (const t of turns.slice(0, 3)) await assembleTurnContext(engine, { sourceId: 'default', window: t.window, sessionId: 'warm' });
for (let round = 0; round < ROUNDS; round++) {
  const offMs: number[] = [];
  await setMode(false);
  for (const t of turns) {
    const t0 = performance.now();
    await assembleTurnContext(engine, { sourceId: 'default', window: t.window, sessionId: `bench-${round}` });
    offMs.push(performance.now() - t0);
  }
  await setMode(true);
  for (const [i, t] of turns.entries()) {
    const t0 = performance.now();
    const r = await assembleTurnContext(engine, { sourceId: 'default', window: t.window, sessionId: `bench-${round}` });
    const ms = performance.now() - t0;
    on.push(ms);
    off.push(offMs[i]!);
    added.push(ms - offMs[i]!);
    const m = r.decide?.recall_needed;
    const key = m?.outcomes ? Object.keys(m.outcomes)[0]! + (m.skipped ? `:${m.skipped}` : '') : `skipped:${m?.skipped ?? 'none'}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
}
await drainShadow(1000);
await flushDecideWrites();
const misses = Object.entries(outcomes).filter(([k]) => k.includes('timeout') || k.includes('late')).reduce((n, [, v]) => n + v, 0);
const result = {
  turns: turns.length, rounds: ROUNDS, delays_ms: summary(DELAYS),
  off_ms: summary(off), on_ms: summary(on), added_ms: summary(added),
  outcomes, deadline_miss_rate: Number((misses / on.length).toFixed(4)),
};
__setDecideTransportForTests(null);
await engine.disconnect();
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`S6 turn-context latency: ${result.turns} turns x ${ROUNDS} rounds; fixture Jev delay p50 ${result.delays_ms.p50} ms, p95 ${result.delays_ms.p95} ms`);
  console.log(`  S6 off: p50 ${result.off_ms.p50} ms, p95 ${result.off_ms.p95} ms, p99 ${result.off_ms.p99} ms`);
  console.log(`  S6 on : p50 ${result.on_ms.p50} ms, p95 ${result.on_ms.p95} ms, p99 ${result.on_ms.p99} ms, max ${result.on_ms.max} ms`);
  console.log(`  added (paired per turn): p50 ${result.added_ms.p50} ms, p95 ${result.added_ms.p95} ms, p99 ${result.added_ms.p99} ms`);
  console.log(`  outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}; deadline miss rate ${(result.deadline_miss_rate * 100).toFixed(1)}%`);
}
