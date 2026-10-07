#!/usr/bin/env bun
/**
 * Tier 3 fence-repair eval runner (#6188 T4).
 *
 * Every mode takes `--fixtures <file>`: fixtures.jsonl (round 1, default) or
 * heldout.jsonl (round 2's held-out set).
 *
 * ORACLE mode ($0, no key):
 *   bun evals/fence-repair-tier3/harness.ts --oracle [--fixtures heldout.jsonl]
 * Runs every fixture through the production path with a scripted model that
 * answers with the hand-written ground truth (repairable, gate_limited) or
 * the adversarial probe. It proves each label: a repairable ground truth
 * passes every gate and comes out byte-identical; a gate-limited one is
 * rejected; an ambiguous probe is accepted (only the model can hold it); an
 * unrecoverable probe is rejected. Fixtures the free tiers settle are listed
 * as routing notes (see oracle.ts). Exit 1 on any violation.
 *
 * LIVE mode (spends tokens):
 *   bun evals/fence-repair-tier3/harness.ts --model <provider:model | default> --run <n> --out <results.jsonl>
 *     [--max-usd 10] [--only id1,id2]
 * One throwaway PGLite brain per invocation (fresh ledger and attempt
 * memo). `models.fence_repair` is set to the model (left unset for
 * `default`, so gbrain's own resolution picks it: the first measured model
 * with a provider key, refused when there is none), `pricing.overrides`
 * registers list prices gbrain's table lacks (as `gbrain pricing set`
 * would), and `fences.repair.max_usd_per_day` is set to --max-usd, which the
 * daily ledger enforces as a hard ceiling. The per-page cap stays at the
 * production default. Each fixture goes through `run-case.ts`. A
 * provider error (`llm_unavailable`) is retried twice after a pause, as the
 * next maintenance run would; anything else is the outcome.
 *
 * SCORE mode ($0):
 *   bun evals/fence-repair-tier3/harness.ts --score a.jsonl b.jsonl ... [--json summary.json]
 *
 * Exit codes: 0 done, 1 oracle violation, 2 infrastructure (no key, cap reached, fixture defect).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Fixture } from './generate-fixtures.ts';
import type { ResultRow } from './score.ts';

const here = import.meta.dir;
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };

/**
 * List prices (USD per 1M tokens) registered on the eval brain like `gbrain pricing set`, only for a model gbrain's own price table lacks.
 * Empty: every model this eval runs is in the table (round 1 registered `openai:gpt-6.1-sol` at $2/$10 before it joined the table).
 */
export const REGISTERED_PRICES: Record<string, { input: number; output: number; source: string }> = {};

export const CALL_TIMEOUT_MS = Number(process.env.GBRAIN_FENCE_REPAIR_CALL_TIMEOUT_MS) > 0 ? Number(process.env.GBRAIN_FENCE_REPAIR_CALL_TIMEOUT_MS) : 90_000;

/** `--fixtures <file>`: round 1's fixtures.jsonl by default, or heldout.jsonl; a bare name resolves next to this file. */
export const FIXTURES_FILE = (() => { const f = flag('--fixtures') ?? 'fixtures.jsonl'; return f.includes('/') ? f : join(here, f); })();

export function loadFixtures(): Fixture[] {
  return readFileSync(FIXTURES_FILE, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

async function newBrain() {
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return { engine, incarnation: src!.incarnation };
}

// ── score ─────────────────────────────────────────────────────────────────
if (args.includes('--score')) {
  const files = args.slice(args.indexOf('--score') + 1).filter(a => !a.startsWith('--') && a !== flag('--json'));
  const rows: ResultRow[] = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const { summarize, meetsRule, SCORER_VERSION } = await import('./score.ts');
  const summary = summarize(rows);
  const out = { scorer_version: SCORER_VERSION, files, models: summary.map(s => ({ ...s, meets_rule: meetsRule(s) })) };
  if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(out, null, 2) + '\n');
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log('model | runs | Tier 3 gate-pass | Tier 3 false-accept | end to end repaired / wrong | adversarial held | USD/repair | p50 s | p95 s | rule');
  for (const s of out.models) {
    console.log(`${s.model} | ${s.runs} | ${s.repairable.repaired}/${s.repairable.n} ${pct(s.repairable.gate_pass)} | ${s.repairable.false_accepts}/${s.repairable.n} ${pct(s.repairable.false_accept)} | `
      + `${s.end_to_end.repaired}/${s.end_to_end.n} / ${s.end_to_end.wrong_writes} | `
      + `${s.adversarial.held}/${s.adversarial.n} | ${s.cost.usd_per_repair?.toFixed(4) ?? 'n/a'} | ${((s.latency_ms.p50 ?? 0) / 1000).toFixed(1)} | ${((s.latency_ms.p95 ?? 0) / 1000).toFixed(1)} | ${s.meets_rule ? 'meets' : 'fails'}`);
  }
  process.exit(0);
}

const fixtures = loadFixtures();
const only = flag('--only')?.split(',');
const selected = only ? fixtures.filter(f => only.includes(f.id)) : fixtures;

const { runCase } = await import('./run-case.ts');
const { compareRepair } = await import('./score.ts');
const { dailyLedger, FENCE_REPAIR_LEDGER, chatCallUsd } = await import('../../src/core/budget/daily-ledger.ts');
const { attemptStore } = await import('../../src/core/fence-repair/attempts.ts');

// ── oracle ────────────────────────────────────────────────────────────────
if (args.includes('--oracle')) {
  const { oracleAnswers, runOracle } = await import('./oracle.ts');
  const { violations, notes } = await runOracle(selected, oracleAnswers);
  for (const n of notes) console.log(`ROUTING ${n}`);
  for (const v of violations) console.error(`VIOLATION ${v}`);
  console.log(`oracle: ${selected.length} fixture(s) from ${FIXTURES_FILE}, ${notes.length} routing note(s), ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}

// ── live ──────────────────────────────────────────────────────────────────
const modelArg = flag('--model');
const run = Number(flag('--run') ?? 1);
const outPath = flag('--out');
const maxUsd = Number(flag('--max-usd') ?? 10);
if (!modelArg || !outPath || !Number.isInteger(run) || !(maxUsd > 0)) {
  console.error('usage: harness.ts --model <provider:model|default> --run <n> --out <results.jsonl> [--max-usd 10] [--only ids]');
  process.exit(2);
}

const { configureEvalGateway } = await import('../../src/eval/shared/gateway-bootstrap.ts');
const { isAvailable } = await import('../../src/core/ai/gateway.ts');
const { registerChatUsageSink } = await import('../../src/core/ai/chat-usage.ts');
const { resolveFenceRepairModel } = await import('../../src/core/fence-repair/model.ts');
const { readFenceRepairCaps, FENCE_REPAIR_MAX_USD_PER_DAY_KEY } = await import('../../src/core/fence-repair/config.ts');
const { loadPricingOverrides } = await import('../../src/core/budget/budget-tracker.ts');
const { analyzeFences, tier3Estimate } = await import('../../src/core/fence-repair/repair-tiers.ts');
const { canonicalLookup } = await import('../../src/core/model-pricing.ts');
const { buildTier3Prompt, FENCE_REPAIR_PROMPT_VERSION } = await import('../../src/core/fence-repair/llm.ts');
const { fixtureTarget } = await import('./run-case.ts');

const { engine, incarnation } = await newBrain();
if (modelArg !== 'default') await engine.setConfig('models.fence_repair', modelArg);
const registered = Object.fromEntries(Object.entries(REGISTERED_PRICES).filter(([m]) => !canonicalLookup(m)));
await engine.setConfig('pricing.overrides', JSON.stringify(Object.fromEntries(Object.entries(registered).map(([m, p]) => [m, { input: p.input, output: p.output }]))));
await engine.setConfig(FENCE_REPAIR_MAX_USD_PER_DAY_KEY, String(maxUsd));
const resolved = await resolveFenceRepairModel(engine);
if (!resolved) { console.error('fence-repair-tier3: --model default resolves to no model: no measured fence-repair model has a provider key here. Set a key, or pass --model.'); process.exit(2); }
const model: string = resolved;
const overrides = await loadPricingOverrides(engine);
const caps = await readFenceRepairCaps(engine);
configureEvalGateway({ chatModel: model });
if (!isAvailable('chat', model)) {
  console.error(`fence-repair-tier3: no chat provider configured for ${model}; set its key. Refusing to run keyless.`);
  process.exit(2);
}

// Pre-run estimate: every page's first-call quotes, from the same estimator the per-page cap uses.
let estimate = 0;
for (const f of selected) {
  const analysis = await analyzeFences(engine, fixtureTarget(f), { pageId: null });
  if (analysis.status !== 'llm') continue;
  const quote = tier3Estimate(analysis.requests, { model, overrides, capSource: 'default' });
  if (quote.ok) estimate += quote.usd;
}
console.error(`fence-repair-tier3: ${selected.length} fixture(s) on ${model} (run ${run}); first-call ceiling estimate $${estimate.toFixed(4)}; daily ledger cap $${maxUsd}; per-page cap $${caps.perPageUsd}.`);
if (estimate > maxUsd) { console.error('Refusing: the estimate exceeds --max-usd.'); process.exit(2); }

// Observers (read-only): tokens from the chat usage sink, answer text and latency from the provider HTTP response.
const usage: Array<{ input_tokens: number; output_tokens: number }> = [];
registerChatUsageSink(record => { usage.push({ input_tokens: record.input_tokens, output_tokens: record.output_tokens }); });
const http: Array<{ latency_ms: number; status: number; stop: string | null; text: string | null }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const watched = /\/(messages|responses|chat\/completions)(\?|$)/.test(url);
  const t0 = performance.now();
  const res = await realFetch(input as RequestInfo, init);
  if (watched) {
    const record = { latency_ms: Math.round(performance.now() - t0), status: res.status, stop: null as string | null, text: null as string | null };
    http.push(record);
    res.clone().text().then(body => {
      try {
        const json = JSON.parse(body);
        if (Array.isArray(json.content)) {
          record.text = json.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
          record.stop = json.stop_reason ?? null;
        } else if (Array.isArray(json.output)) {
          record.text = json.output.filter((o: { type: string }) => o.type === 'message').flatMap((o: { content: Array<{ type: string; text: string }> }) => o.content.filter(c => c.type === 'output_text').map(c => c.text)).join('');
          record.stop = json.incomplete_details?.reason ?? json.status ?? null;
        } else if (Array.isArray(json.choices)) {
          record.text = json.choices[0]?.message?.content ?? null;
          record.stop = json.choices[0]?.finish_reason ?? null;
        }
      } catch { record.text = null; }
    }).catch(() => {});
  }
  return res;
}) as typeof fetch;

const promptDigest = createHash('sha256').update(buildTier3Prompt({ kind: 'facts', section: 'body', pageVisibility: 'private', layout: 'narrow', header: null, rows: [], issues: [] }).system).digest('hex');
const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: here }).stdout.toString().trim();
const harnessSha = createHash('sha256').update(['run-case.ts', 'harness.ts', 'score.ts', 'oracle.ts'].map(f => readFileSync(join(here, f), 'utf8')).join('\u0000')).digest('hex');
const meta = { model, model_arg: modelArg, run, started_at: new Date().toISOString(), gbrain_commit: commit, harness_sha256: harnessSha, bun: Bun.version, prompt_version: FENCE_REPAIR_PROMPT_VERSION,
  system_prompt_sha256: promptDigest, fixtures_file: FIXTURES_FILE.slice(FIXTURES_FILE.lastIndexOf('/') + 1), fixtures_sha256: createHash('sha256').update(readFileSync(FIXTURES_FILE)).digest('hex'),
  caps: { per_page_usd: caps.perPageUsd, per_day_usd: caps.perDayUsd }, registered_prices: registered, call_timeout_ms: CALL_TIMEOUT_MS };
writeFileSync(`${outPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
writeFileSync(outPath, '');

const deps = { ledger: dailyLedger(engine, FENCE_REPAIR_LEDGER), store: attemptStore(engine), model, overrides,
  capSource: caps.perPageSource === 'user' || caps.perDaySource === 'user' ? 'user' as const : 'default' as const,
  perPageUsd: caps.perPageUsd, perDayUsd: caps.perDayUsd, timeoutMs: CALL_TIMEOUT_MS, now: () => new Date() };

let spent = 0;
let stopped: string | null = null;
for (const f of selected) {
  let attempts = 0;
  let out;
  let calls: ResultRow['calls'] = [];
  let latency = 0;
  for (;;) {
    attempts++;
    usage.length = 0; http.length = 0;
    const t0 = performance.now();
    out = await runCase(engine, incarnation, f, deps);
    latency = Math.round(performance.now() - t0);
    await new Promise(r => setTimeout(r, 50));
    const ok = http.filter(h => h.status === 200);
    calls = out.ledger_calls.map((c, i) => ({ estimate_usd: c.estimate_usd, usd: c.usd, input_tokens: usage[i]?.input_tokens ?? null, output_tokens: usage[i]?.output_tokens ?? null,
      latency_ms: ok[i]?.latency_ms ?? null, stop: ok[i]?.stop ?? null, text: ok[i]?.text ?? null }));
    if (out.reason !== 'llm_unavailable' || attempts >= 3) break;
    console.error(`${f.id}: provider unavailable (attempt ${attempts}); retrying after a pause`);
    await new Promise(r => setTimeout(r, attempts * 20_000));
  }
  spent += out.spent_usd;
  if (out.tier1 === 'clean') {
    console.error(`${f.id}: fixture defect, the page already compiles.`);
    process.exitCode = 2;
  }
  const match = out.outcome === 'repaired' && f.expected ? compareRepair(out.after!, f.expected) : null;
  const unregistered = calls.every(c => c.input_tokens !== null)
    ? calls.reduce((s, c) => s + chatCallUsd(model, { inputTokens: c.input_tokens!, outputTokens: c.output_tokens! }).usd, 0) : null;
  const row = { model, run, id: f.id, set: f.set, adversarial: f.adversarial, cls: f.cls, kind: f.kind, tags: f.tags, tier1: out.tier1, tier: out.tier, residual: out.residual, requests: out.requests,
    outcome: out.outcome, reason: out.reason, gate: out.gate, rows: out.rows, match_cells: match ? match.cells : null, match_exact: match ? match.exact : null,
    calls, spent_usd: out.spent_usd, usd_unregistered: unregistered, latency_ms: latency, attempts, message: out.message, after: out.after };
  appendFileSync(outPath, JSON.stringify(row) + '\n');
  console.error(`${f.id}: ${out.tier ?? '-'} ${out.outcome}${out.gate ? ` gate ${out.gate}` : out.reason && out.outcome !== 'repaired' ? ` ${out.reason}` : ''}${match ? (match.cells ? ' match' : ' MISMATCH') : ''} calls=${calls.length} $${out.spent_usd.toFixed(4)} ${latency}ms`);
  if (out.reason === 'budget_exhausted' && /daily/.test(out.message ?? '')) { stopped = `the daily ledger cap ($${maxUsd}) was reached after $${spent.toFixed(4)}`; break; }
}
globalThis.fetch = realFetch;
await engine.disconnect();
writeFileSync(`${outPath}.meta.json`, JSON.stringify({ ...meta, finished_at: new Date().toISOString(), spent_usd: spent, stopped }, null, 2) + '\n');
console.error(`spend: $${spent.toFixed(4)} on ${model} (run ${run})${stopped ? `; STOPPED: ${stopped} (partial, not scored)` : ''}`);
process.exit(stopped ? 2 : process.exitCode ?? 0);
