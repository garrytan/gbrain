/**
 * `gbrain decide calibrate | qualify | calibrations | dataset`.
 *
 * calibrate: runs the slot's production-shaped requests over the dataset's
 * calibrate half, picks the threshold, measures reliability/ECE, retest_sd
 * (items re-asked 3 times) and repack_sd (re-asked with resampled co-packed
 * neighbours, 3 draws), and stores a decide_calibrations row.
 * qualify: evaluates the newest calibration on the eval half through the
 * production action reducer, family-level Wilson bound, stores
 * action_precision_lb and per-slice results bound to the policy fingerprint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../../core/engine.ts';
import { meanItemSd, qualifyActions, reliability, requiredN, searchThreshold, type CalibrationTarget, type HarmfulAction, type LabelledValue } from '../../core/ai/decide/calibrate.ts';
import { datasetAdapter, datasetBuilder, datasetHash, datasetSources, families, idsHash, itemForCallSite, parseDatasetJsonl, splitHash, toJsonl, type DatasetItem } from '../../core/ai/decide/dataset.ts';
import { runDecide } from '../../core/ai/decide/index.ts';
import { runDecideUnpacked } from '../../core/ai/decide/unpacked.ts';
import { estimateContextTokens, planBatches } from '../../core/ai/decide/pack.ts';
import { lookupModel, marginFor, policyFingerprint } from '../../core/ai/decide/policy.ts';
import { refusalLine } from '../../core/ai/decide/outcomes.ts';
import { toWireQuestion } from '../../core/ai/decide/providers/typesafe.ts';
import { SLOT_SPECS } from '../../core/ai/decide/slots.ts';
import { getCalibration, insertCalibration, listCalibrations, setCalibrationRetired, storeQualification } from '../../core/ai/decide/store.ts';
import { DECIDE_SLOTS, DecideError, thresholdValue, type DecideAnswer, type DecideSlot } from '../../core/ai/decide/types.ts';
import { usageCostUsd } from '../../core/budget/reservation-cost.ts';
import { evidenceCoPackedSlots, resetDecideSearchCache } from '../../core/search/decide-stage.ts';
import { injectionQuestion } from '../../core/ai/decide/injection.ts';
import { flagValue, loadDecideState, slotPackShape } from '../decide.ts';
import '../../core/ai/decide/recall-needed.ts';

const REPEATS = 3;

function slotArg(args: string[]): DecideSlot | null {
  const slot = flagValue(args, '--slot');
  return slot && (DECIDE_SLOTS as readonly string[]).includes(slot) ? slot as DecideSlot : null;
}

function isPositive(item: DatasetItem): boolean {
  return item.label === true || (typeof item.label === 'string' && item.label !== 'false');
}

/**
 * The request production sends for a family. S3 carries S5's questions when
 * injection rides the S3 request, so the shape asked is the shape recorded
 * (pack_shape evidence+injection); the co-packed answers are not scored.
 */
export function productionRequest(slot: DecideSlot, fam: readonly DatasetItem[], cfg: Awaited<ReturnType<typeof loadDecideState>>['cfg']): ReturnType<NonNullable<ReturnType<typeof datasetAdapter>>['request']> {
  const req = datasetAdapter(slot)!.request(fam);
  if (slot !== 'evidence' || !evidenceCoPackedSlots(cfg).includes('injection')) return req;
  const coPacked = req.questions.map((q, i) => injectionQuestion(`injection:${i}`, q.rank ?? i, q.inputs!.candidate!, q.protected === true));
  return { ...req, questions: [...req.questions, ...coPacked] };
}

/** Ask every family once (production shape); returns value per item id and the resolved model. */
async function askFamilies(engine: BrainEngine, slot: DecideSlot, provider: string, fams: DatasetItem[][], cfgOverride: Awaited<ReturnType<typeof loadDecideState>>['cfg']): Promise<{ values: Record<string, number | null>; answers: Record<string, DecideAnswer | undefined>; model: string }> {
  const adapter = datasetAdapter(slot)!;
  const values: Record<string, number | null> = {};
  const answers: Record<string, DecideAnswer | undefined> = {};
  const models = new Set<string>();
  for (const fam of fams) {
    const req = productionRequest(slot, fam, cfgOverride);
    const base = { slot, callSite: adapter.callSite, state: req.state, questions: req.questions, provider, lane: 'background' as const };
    const r = adapter.unpacked
      ? await runDecideUnpacked(base, { engine, config: cfgOverride }, { deadlineAt: Date.now() + 60_000, concurrency: cfgOverride.backgroundConcurrency })
      : await runDecide({ ...base, deadlineMs: 60_000 }, { engine, config: cfgOverride });
    if (r.model_resolved) models.add(r.model_resolved);
    const perItem = new Map<string, Array<number | null>>();
    for (const q of req.questions) {
      const item = req.itemFor[q.id];
      if (!item) continue;
      const a = r.answers[q.id];
      perItem.set(item.id, [...(perItem.get(item.id) ?? []), a ? (adapter.calibrationValue ? adapter.calibrationValue(a) : thresholdValue(a)) : null]);
      answers[item.id] = a;
    }
    for (const [id, list] of perItem) {
      values[id] = adapter.aggregate === 'max'
        ? (list.some((v) => v === null) ? null : Math.max(...(list as number[])))
        : list[list.length - 1] ?? null;
    }
  }
  if (models.size > 1) throw new DecideError('mixed_model', `calibration answered by ${models.size} different models`);
  return { values, answers, model: [...models][0] ?? '' };
}

function sample<T>(items: readonly T[], n: number, seed: string): T[] {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, n);
}

async function cmdCalibrate(engine: BrainEngine, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const slot = slotArg(args);
  const path = flagValue(args, '--dataset');
  if (!slot || !path) { console.error('Usage: gbrain decide calibrate --slot <slot> --dataset <jsonl> [--target precision|recall|f1] [--min <x>] [--call-site <site>] [--dry-run]'); return 1; }
  const adapter = datasetAdapter(slot);
  if (!adapter || !SLOT_SPECS[slot].thresholded) { console.error(refusalLine('slot_unavailable', slot)); return 1; }
  const text = readFileSync(path, 'utf8');
  const callSite = flagValue(args, '--call-site') ?? adapter.callSite;
  const all = parseDatasetJsonl(text).filter((i) => i.slot === slot && itemForCallSite(i, callSite));
  const calibrate = all.filter((i) => i.split === 'calibrate');
  if (calibrate.length === 0) { console.error('dataset has no calibrate-half items for this slot (build it with gbrain decide dataset)'); return 1; }
  const state = await loadDecideState(engine);
  const provider = state.cfg.slots[slot].provider;
  if (provider === 'none') { console.error(refusalLine('no_provider', slot)); return 1; }
  const fams = [...families(calibrate).values()];
  const retestN = Math.min(state.cfg.retestN, fams.length);
  const estimateTokens = fams.reduce((n, fam) => {
    const req = productionRequest(slot, fam, state.cfg);
    return n + planBatches(estimateContextTokens(Object.fromEntries(Object.entries(req.state).map(([k, v]) => [k, v.text]))), req.questions.map((q) => estimateContextTokens(toWireQuestion(q)))).reduce((m, b) => m + b.estimatedInputTokens, 0);
  }, 0);
  const totalTokens = estimateTokens * (1 + (retestN / Math.max(1, fams.length)) * (REPEATS - 1) * 2);
  const estUsd = usageCostUsd(provider, totalTokens, 0, 'decide');
  if (args.includes('--dry-run')) {
    const out = { slot, provider, families: fams.length, items: calibrate.length, retest_families: retestN, estimated_input_tokens: Math.round(totalTokens), estimated_usd: estUsd };
    console.log(json ? JSON.stringify(out, null, 2) : `Dry run: ${calibrate.length} items in ${fams.length} families, ~${Math.round(totalTokens)} input tokens, ~$${(estUsd ?? 0).toFixed(4)} with ${provider}.`);
    return 0;
  }
  // Calibration is an explicit local operation on a labelled dataset: consent for its classes is implied.
  const cfg = { ...state.cfg, consent: { query: true, candidates: true, facts: true, conversation: true }, egressPrivate: 'allow' as const };
  try {
    const first = await askFamilies(engine, slot, provider, fams, cfg);
    const labelled: LabelledValue[] = calibrate.filter((i) => first.values[i.id] !== null && first.values[i.id] !== undefined).map((i) => ({ value: first.values[i.id]!, label: adapter.positive ? adapter.positive(i, first.answers[i.id]) : isPositive(i) }));
    const target = (flagValue(args, '--target') ?? 'f1') as CalibrationTarget;
    const minRaw = flagValue(args, '--min');
    const choice = searchThreshold(labelled, target, minRaw === undefined ? undefined : Number(minRaw));
    if (!choice) { console.error(`no threshold meets --min ${minRaw} for ${target}`); return 1; }
    const rel = reliability(labelled);
    const extra = adapter.calibrateExtra?.(calibrate, first.answers, choice.threshold) ?? null;
    const retestFams = sample(fams, retestN, `${slot}:retest`);
    const retest = new Map<string, number[]>();
    const repack = new Map<string, number[]>();
    for (const fam of retestFams) for (const it of fam) { retest.set(it.id, [first.values[it.id] ?? 0]); repack.set(it.id, [first.values[it.id] ?? 0]); }
    for (let rep = 1; rep < REPEATS; rep++) {
      const again = await askFamilies(engine, slot, provider, retestFams, cfg);
      for (const [id, v] of Object.entries(again.values)) if (v !== null) retest.get(id)?.push(v);
      const pool = calibrate.filter((i) => !retestFams.some((f) => f.includes(i)));
      const repacked = retestFams.map((fam, fi) => [...fam, ...sample(pool, Math.min(3, pool.length), `${slot}:repack:${rep}:${fi}`).map((n, k) => ({ ...n, id: `${n.id}#neighbour${rep}.${k}`, family: fam[0]!.family, rank: 1000 + k }))]);
      const packed = await askFamilies(engine, slot, provider, repacked, cfg);
      for (const [id, v] of Object.entries(packed.values)) if (v !== null && repack.has(id)) repack.get(id)!.push(v);
    }
    const row = {
      slot, call_site: callSite, provider, model_resolved: first.model, threshold: choice.threshold,
      min_keep: SLOT_SPECS[slot].defaultMinKeep ?? null, metric: target, metric_value: choice.metric_value, ece: rel.ece,
      retest_sd: meanItemSd(retest), repack_sd: meanItemSd(repack), n: labelled.length, dataset_hash: datasetHash(text),
      split_hash: splitHash(all), calibrate_ids_hash: idsHash(calibrate), calibrate_only: true, pack_shape: slotPackShape(slot, state.cfg), notes: extra ? JSON.stringify(extra) : null,
    };
    const id = await insertCalibration(engine, row);
    resetDecideSearchCache();
    const out = { id, ...row, precision: choice.precision, recall: choice.recall, f1: choice.f1, reliability: rel.table, margin: marginFor(state.cfg.marginFloor, { retest_sd: row.retest_sd, repack_sd: row.repack_sd }) };
    if (json) { console.log(JSON.stringify(out, null, 2)); return 0; }
    console.log(`Calibration local:${id} for ${slot} (${callSite}) on ${provider} → ${first.model}: threshold ${choice.threshold.toFixed(3)} (${target} ${choice.metric_value.toFixed(3)}; precision ${choice.precision.toFixed(3)}, recall ${choice.recall.toFixed(3)}), n=${labelled.length}`);
    console.log(`ECE ${rel.ece.toFixed(3)}; retest_sd ${row.retest_sd.toFixed(3)}; repack_sd ${row.repack_sd.toFixed(3)}; margin ${out.margin.toFixed(3)}`);
    console.log('reliability (probability bin: n, mean probability, observed rate):');
    for (const b of rel.table) if (b.n) console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: ${b.n}, ${b.mean_p.toFixed(3)}, ${b.observed.toFixed(3)}`);
    console.log(`Next: gbrain decide qualify --slot ${slot} --dataset ${path}`);
    return 0;
  } catch (err) {
    console.error(`calibrate failed: ${refusalLine(err instanceof DecideError ? err.reason : 'provider_error')}${err instanceof DecideError ? '' : ` (${err instanceof Error ? err.message : err})`}`);
    return 1;
  }
}

async function cmdQualify(engine: BrainEngine, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const slot = slotArg(args);
  const path = flagValue(args, '--dataset');
  if (!slot || !path) { console.error('Usage: gbrain decide qualify --slot <slot> --dataset <jsonl> [--call-site <site>]'); return 1; }
  const adapter = datasetAdapter(slot);
  if (!adapter?.harmfulActions) { console.error(refusalLine('slot_unavailable', slot)); return 1; }
  const text = readFileSync(path, 'utf8');
  const callSite = flagValue(args, '--call-site') ?? adapter.callSite;
  const all = parseDatasetJsonl(text).filter((i) => i.slot === slot && itemForCallSite(i, callSite));
  const state = await loadDecideState(engine);
  const provider = state.cfg.slots[slot].provider;
  const model = lookupModel(provider, state.lastResolved);
  const rows = (await listCalibrations(engine, { slot })).filter((c) => c.call_site === callSite && c.provider === provider && (!model || c.model_resolved === model));
  const cal = rows[0];
  if (!cal) { console.error(refusalLine('no_calibration', slot)); return 1; }
  if (cal.split_hash !== splitHash(all) || !cal.calibrate_only) { console.error(refusalLine('split_mismatch', slot)); return 1; }
  const evalItems = all.filter((i) => i.split === 'eval');
  const cfg = { ...state.cfg, consent: { query: true, candidates: true, facts: true, conversation: true }, egressPrivate: 'allow' as const };
  const minKeep = state.cfg.slots[slot].minKeep ?? cal.min_keep ?? SLOT_SPECS[slot].defaultMinKeep ?? 0;
  const suppressBelow = state.cfg.slots[slot].suppressBelow;
  const policy = { threshold: state.cfg.slots[slot].threshold ?? cal.threshold, margin: marginFor(state.cfg.marginFloor, { retest_sd: cal.retest_sd ?? 0, repack_sd: cal.repack_sd ?? 0 }), minKeep, ...(suppressBelow !== undefined ? { suppressBelow } : {}) };
  try {
    const fams = [...families(evalItems).values()];
    const answered = await askFamilies(engine, slot, provider, fams, cfg);
    if (answered.model !== cal.model_resolved) { console.error(refusalLine('model_drift', slot)); return 1; }
    const actions: HarmfulAction[] = fams.flatMap((fam) => adapter.harmfulActions!(fam, answered.values, policy).map((a) => ({ family: a.item.family, correct: a.correct, slice: a.item.slice })));
    const minPrecision = state.cfg.slots[slot].minActionPrecision;
    const q = qualifyActions(actions, minPrecision);
    const fingerprint = policyFingerprint({ slot, callSite, threshold: policy.threshold, marginFloor: state.cfg.marginFloor, minKeep, packShape: cal.pack_shape, suppressBelow });
    await storeQualification(engine, cal.id, { action_precision_lb: q.action_precision_lb, qualification: JSON.stringify({ ...q, min_action_precision: minPrecision }), policy_fingerprint: fingerprint });
    resetDecideSearchCache();
    const out = { calibration: `local:${cal.id}`, ...q, min_action_precision: minPrecision, policy_fingerprint: fingerprint, next: q.status === 'qualified' ? `gbrain decide enable ${slot}` : null };
    if (json) { console.log(JSON.stringify(out, null, 2)); return q.status === 'qualified' ? 0 : 1; }
    console.log(`Qualification of local:${cal.id} (${slot}, ${callSite}): ${q.correct_families}/${q.families} families correct over ${q.actions} harmful actions; action_precision_lb ${q.action_precision_lb === null ? 'n/a' : q.action_precision_lb.toFixed(3)} (gate ${minPrecision})`);
    for (const [slice, s] of Object.entries(q.slices)) console.log(`  slice ${slice}: ${s.correct}/${s.families}, lb ${s.lb.toFixed(3)} (advisory)`);
    if (q.status === 'qualified') { console.log(`Qualified. Next: gbrain decide enable ${slot}`); return 0; }
    if (q.status === 'insufficient_n') console.error(`${refusalLine('insufficient_n', slot)} (need at least ${requiredN(minPrecision)} families with a harmful action; have ${q.families})`);
    else console.error(refusalLine('action_precision_low', slot));
    return 1;
  } catch (err) {
    console.error(`qualify failed: ${refusalLine(err instanceof DecideError ? err.reason : 'provider_error')}`);
    return 1;
  }
}

async function cmdCalibrations(engine: BrainEngine, args: string[]): Promise<number> {
  const action = args[0] ?? 'list';
  if (action === 'list') {
    const slot = slotArg(args) ?? undefined;
    const rows = await listCalibrations(engine, { slot, includeRetired: true });
    if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    if (rows.length === 0) { console.log('No local calibrations. Build one: gbrain decide calibrate --slot <slot> --dataset <jsonl>'); return 0; }
    for (const r of rows) {
      console.log(`local:${r.id}  ${r.slot}/${r.call_site}  ${r.provider} → ${r.model_resolved}  threshold ${r.threshold.toFixed(3)}  n=${r.n}  lb=${r.action_precision_lb === null ? 'unqualified' : r.action_precision_lb.toFixed(3)}${r.retired_at ? '  (retired)' : ''}`);
    }
    return 0;
  }
  const id = Number(String(args[1] ?? '').replace(/^local:/, ''));
  if (!Number.isInteger(id) || id <= 0) { console.error(`Usage: gbrain decide calibrations ${action} <id>`); return 1; }
  const row = await getCalibration(engine, id);
  if (!row) { console.error(`calibration local:${id} not found`); return 1; }
  if (action === 'adopt') {
    await engine.setConfig(`decide.slots.${row.slot}.calibration`, `local:${id}`);
    await setCalibrationRetired(engine, id, false);
    resetDecideSearchCache();
    console.log(`${row.slot} now uses local:${id} (threshold ${row.threshold.toFixed(3)} for ${row.model_resolved}).`);
    return 0;
  }
  if (action === 'retire' || action === 'restore') {
    await setCalibrationRetired(engine, id, action === 'retire');
    resetDecideSearchCache();
    console.log(`local:${id} ${action === 'retire' ? 'retired' : 'restored'}.`);
    return 0;
  }
  console.error('Usage: gbrain decide calibrations list|adopt|retire|restore');
  return 1;
}

async function cmdDataset(args: string[]): Promise<number> {
  const slot = slotArg(args);
  const source = flagValue(args, '--from');
  const path = source ? args[args.indexOf('--from') + 2] : undefined;
  if (!slot || !source || !path) { console.error(`Usage: gbrain decide dataset --slot <slot> --from <source> <path> [--out <file>]. Sources in this build: ${datasetSources().join(', ')}`); return 1; }
  const builder = datasetBuilder(source);
  if (!builder) { console.error(`dataset source '${source}' is not available in this build. Sources: ${datasetSources().join(', ')}`); return 1; }
  const items = await builder(path, { slot });
  const out = flagValue(args, '--out');
  const body = toJsonl(items);
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
  const fams = families(items);
  console.error(`${items.length} items in ${fams.size} families (calibrate ${items.filter((i) => i.split === 'calibrate').length}, eval ${items.filter((i) => i.split === 'eval').length}); split_hash ${splitHash(items)}`);
  return 0;
}

export async function runCalibrationSubcommand(engine: BrainEngine, sub: string, args: string[]): Promise<number> {
  if (sub === 'calibrate') return cmdCalibrate(engine, args);
  if (sub === 'qualify') return cmdQualify(engine, args);
  if (sub === 'calibrations') return cmdCalibrations(engine, args);
  return cmdDataset(args);
}
