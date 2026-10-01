/**
 * Ask a labelled decide dataset through the slot's production request shape
 * (the registered dataset adapter, the same one `gbrain decide calibrate`
 * and `qualify` use) and record the per-item answer, per-request latency and
 * input tokens. Offline analysis scripts then apply the slot's production
 * reducer at the calibrated threshold, so no verdict needs a second paid run.
 *
 *   GBRAIN_HOME=<scratch brain> bun docs/eval/system-one/runners/ask-dataset.ts \
 *     --slot <slot> --dataset <jsonl> --out <file> [--split eval|calibrate|all] [--repeat N] [--concurrency 8]
 *
 * Output rows: {id, family, split, label, slice, protected, rep, value, choice?, probabilities?, latency_ms, input_tokens, model, error?}
 * (latency and tokens are per family request, repeated on each of its items).
 */
import { writeFileSync } from 'node:fs';
import { loadConfig, toEngineConfig } from '../../../../src/core/config.ts';
import { createEngine } from '../../../../src/core/engine-factory.ts';
import { configureGateway } from '../../../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../../src/core/ai/build-gateway-config.ts';
import { readDecideConfig } from '../../../../src/core/ai/decide/config.ts';
import { datasetAdapter, families, parseDatasetJsonl } from '../../../../src/core/ai/decide/dataset.ts';
import { runDecide } from '../../../../src/core/ai/decide/index.ts';
import { runDecideUnpacked } from '../../../../src/core/ai/decide/unpacked.ts';
import { flushDecideWrites } from '../../../../src/core/ai/decide/store.ts';
import { loadConfigSnapshot } from '../../../../src/core/config-snapshot.ts';
import { thresholdValue, type DecideSlot } from '../../../../src/core/ai/decide/types.ts';
import { loadDecideLanes } from '../../../../src/commands/decide.ts';
import { productionRequest } from '../../../../src/commands/decide/calibrate.ts';
import '../../../../src/core/ai/decide/recall-needed.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const slot = flag('--slot') as DecideSlot;
const datasetPath = flag('--dataset')!;
const out = flag('--out')!;
const split = flag('--split') ?? 'eval';
const repeat = Number(flag('--repeat') ?? 1);
const concurrency = Number(flag('--concurrency') ?? 8);

const cfgFile = loadConfig();
if (!cfgFile) throw new Error('no brain configured (set GBRAIN_HOME)');
configureGateway(buildGatewayConfig(cfgFile));
const engineCfg = toEngineConfig(cfgFile);
const engine = await createEngine(engineCfg);
await engine.connect(engineCfg);
await loadDecideLanes();

const adapter = datasetAdapter(slot);
if (!adapter) throw new Error(`no dataset adapter for ${slot}`);
const base = readDecideConfig(await loadConfigSnapshot(engine));
const cfg = { ...base, consent: { query: true, candidates: true, facts: true, conversation: true }, egressPrivate: 'allow' as const };
const provider = cfg.slots[slot].provider;
const items = parseDatasetJsonl(await Bun.file(datasetPath).text()).filter((i) => i.slot === slot && (split === 'all' || i.split === split));
const fams = [...families(items).values()];
const jobs = Array.from({ length: repeat }, (_, rep) => fams.map((f) => ({ rep, fam: f }))).flat();

const rows: Record<string, unknown>[] = [];
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const { rep, fam } = jobs[next++]!;
    const req = productionRequest(slot, fam, cfg);
    const reqBase = { slot, callSite: adapter.callSite, state: req.state, questions: req.questions, provider, lane: 'background' as const };
    const started = performance.now();
    try {
      const r = adapter.unpacked
        ? await runDecideUnpacked(reqBase, { engine, config: cfg }, { deadlineAt: Date.now() + 60_000, concurrency: 4 })
        : await runDecide({ ...reqBase, deadlineMs: 60_000 }, { engine, config: cfg });
      const latency = Math.round(performance.now() - started);
      const perItem = new Map<string, Array<{ v: number | null; a: unknown }>>();
      for (const q of req.questions) {
        const a = r.answers[q.id];
        const target = req.itemFor[q.id];
        if (!target) continue;
        const id = target.id;
        perItem.set(id, [...(perItem.get(id) ?? []), { v: a ? thresholdValue(a) : null, a }]);
      }
      for (const it of fam) {
        const list = perItem.get(it.id) ?? [];
        const value = adapter.aggregate === 'max' ? (list.some((x) => x.v === null) ? null : Math.max(...list.map((x) => x.v as number))) : list[list.length - 1]?.v ?? null;
        const a = list[list.length - 1]?.a as { choice?: string; probabilities?: Record<string, number> } | undefined;
        rows.push({
          id: it.id, family: it.family, split: it.split, label: it.label, slice: it.slice ?? null, protected: it.protected === true, rep, value,
          ...(a?.choice ? { choice: a.choice, probabilities: a.probabilities } : {}),
          latency_ms: latency, input_tokens: r.usage.input_tokens, cost_usd: r.cost_usd, model: r.model_resolved,
        });
      }
    } catch (err) {
      for (const it of fam) rows.push({ id: it.id, family: it.family, split: it.split, label: it.label, rep, value: null, error: String((err as { reason?: string }).reason ?? err) });
    }
    if (rows.length % 50 < fam.length) process.stderr.write(`${rows.length} rows\n`);
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
await flushDecideWrites().catch(() => {});
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
process.stderr.write(`done: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors, provider ${provider}\n`);
await engine.disconnect();
process.exit(0);
