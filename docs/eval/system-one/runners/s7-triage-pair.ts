/**
 * S7 triage matched pair: the production triage pass (runTriagePass, the
 * same function `gbrain dream` and `gbrain dream retriage` call) over the
 * EVAL half of the frozen S7 dataset, once with decide.slots.triage.mode off
 * (today: the configured LLM judge + passesTriageGate + rescue band) and once
 * with it on (Jev per-window probabilities, max window vs the qualified
 * calibration, margin_hold and incomplete coverage fall back to the LLM).
 * Same commit, same data, same brain, only the slot mode differs.
 *
 *   GBRAIN_HOME=<scratch brain with the S7 calibration> \
 *     bun docs/eval/system-one/runners/s7-triage-pair.ts --dataset <jsonl> --arm off|on --out <file> [--concurrency 4]
 *
 * One JSON row per transcript: label, worth (the gate decision), score,
 * path (llm | decide | decide→llm fallback), latency_ms, LLM tokens, decide
 * input tokens and cost.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig, toEngineConfig } from '../../../../src/core/config.ts';
import { createEngine } from '../../../../src/core/engine-factory.ts';
import { configureGateway } from '../../../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../../src/core/ai/build-gateway-config.ts';
import { parseDatasetJsonl } from '../../../../src/core/ai/decide/dataset.ts';
import { flushDecideWrites } from '../../../../src/core/ai/decide/store.ts';
import { loadSynthConfig, runTriagePass } from '../../../../src/core/cycle/synthesize.ts';
import { resolveTriageDecide } from '../../../../src/core/cycle/triage-decide.ts';
import { rescueConfigOf } from '../../../../src/core/cycle/triage-rescue.ts';
import { __testing } from '../../../../src/core/cycle/synthesize.ts';

const { priceChatUsd } = __testing;

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const datasetPath = flag('--dataset')!;
const arm = flag('--arm') as 'on' | 'off';
const out = flag('--out')!;
const concurrency = Number(flag('--concurrency') ?? 4);
if (!datasetPath || !out || (arm !== 'on' && arm !== 'off')) throw new Error('usage: --dataset <jsonl> --arm on|off --out <file>');

const cfg = loadConfig();
if (!cfg) throw new Error('no brain configured (set GBRAIN_HOME)');
configureGateway(buildGatewayConfig(cfg));
const engineCfg = toEngineConfig(cfg);
const engine = await createEngine(engineCfg);
await engine.connect(engineCfg);
await engine.setConfig('decide.slots.triage.mode', arm);

const items = parseDatasetJsonl(await Bun.file(datasetPath).text()).filter((i) => i.slot === 'triage' && i.split === 'eval');
const synth = await loadSynthConfig(engine);
const rows: Record<string, unknown>[] = [];
let next = 0;
const worker = async () => {
  while (next < items.length) {
    const it = items[next++]!;
    const content = it.inputs.transcript ?? '';
    const t = { filePath: `/eval/s7/${it.id}.txt`, contentHash: createHash('sha256').update(content).digest('hex'), content, basename: it.id, inferredDate: null };
    const decide = arm === 'on' ? await resolveTriageDecide(engine) : undefined;
    const started = performance.now();
    const pass = await runTriagePass(engine, [t], {
      model: synth.triage.model, maxChars: synth.triage.maxChars, maxTokens: synth.triage.maxTokens, threshold: synth.triage.threshold,
      concurrency: 1, maxMs: 0, force: true, rescue: rescueConfigOf(synth.triage), decide,
    });
    const latency = performance.now() - started;
    const r = pass.reports[0]!;
    const decided = decide?.stats;
    const viaDecide = (r.reasons ?? []).some((x) => x.startsWith('decide ') || x.startsWith('S7 '));
    const llmUsd = priceChatUsd(synth.triage.model, { in: pass.tokens.in, out: pass.tokens.out }) ?? 0;
    rows.push({
      id: it.id, label: it.label, slice: it.slice, arm, worth: r.worth, score: r.score, rescued: r.rescued === true, unreliable: r.unreliable ?? null,
      path: viaDecide ? 'decide' : decided && decided.judged > 0 ? 'decide->llm' : 'llm',
      decide_outcome: decided ? (decided.pass ? 'pass' : decided.reject ? 'reject' : decided.margin_hold ? 'margin_hold' : decided.incomplete ? 'incomplete' : null) : null,
      latency_ms: Math.round(latency), llm_tokens_in: pass.tokens.in, llm_tokens_out: pass.tokens.out, llm_usd: llmUsd,
      decide_input_tokens: decided?.input_tokens ?? 0, decide_usd: decided?.cost_usd ?? 0,
    });
    process.stderr.write(`${rows.length}/${items.length} ${it.id} worth=${r.worth} ${Math.round(latency)}ms\n`);
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
await flushDecideWrites().catch(() => {});
await engine.setConfig('decide.slots.triage.mode', 'off');
rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
await engine.disconnect();
process.exit(0);
