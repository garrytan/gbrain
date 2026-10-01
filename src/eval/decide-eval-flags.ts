/**
 * `--decide` eval plumbing shared by `gbrain eval longmemeval`, `eval
 * brainbench` and `eval retrieval-quality` (System One matched runs: arms
 * differ only in the slot under test).
 *
 *   --decide <slot>=<off|on|shadow>   repeatable; merged over an inherited
 *                                     GBRAIN_DECIDE_SLOTS (flags win), then
 *                                     set for the process with the eval
 *                                     override enabled
 *   --decide-provider <id>            default typesafe:jev-1.13.0
 *   --decide-calibration <file|ref:<id>>   `decide calibrate --json` /
 *                                     `decide calibrations list --json` output
 *                                     (object, array or JSONL) or a reference id
 *   --decide-threshold <slot>=<x>     operator override (the gate still applies)
 *   --decide-force-on <slot>          bypass the action-precision gate (loud)
 *   --decide-dataset <jsonl>          the frozen labelled split: calibrations
 *                                     must match its split_hash and be
 *                                     calibrate-only (else split_mismatch)
 *
 * Throwaway benchmark brains (LongMemEval, BrainBench) are configured so the
 * slot can act: provider, consent for the slot's egress classes,
 * decide.egress.private=allow (public benchmark data only), awaited shadow,
 * thresholds, force_on, and the supplied calibrations inserted and adopted.
 * retrieval-quality runs on the operator's brain: nothing is written there;
 * a missing provider, key or consent refuses with the catalogued line.
 *
 * All-off contract: with no non-off slot (flags and inherited env combined),
 * prepareDecideEval returns null and the command's output is byte-identical.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import {
  DEFAULT_TYPESAFE_PROVIDER, enableDecideEvalOverride, isValidProvider, parseEvalSlots, readDecideConfig,
} from '../core/ai/decide/config.ts';
import { parseDatasetJsonl, splitHash, type DatasetItem } from '../core/ai/decide/dataset.ts';
import { hasTypesafeKey } from '../core/ai/decide/index.ts';
import { percentile } from '../core/ai/decide/judge-agreement.ts';
import { refusalLine } from '../core/ai/decide/outcomes.ts';
import { REFERENCE_CALIBRATIONS } from '../core/ai/decide/reference-calibrations.ts';
import { SLOT_SPECS } from '../core/ai/decide/slots.ts';
import { flushDecideWrites, insertCalibration, storeQualification, type NewCalibration } from '../core/ai/decide/store.ts';
import { DECIDE_SLOTS, type DecideMode, type DecideSlot } from '../core/ai/decide/types.ts';
import { usageCostUsd } from '../core/budget/reservation-cost.ts';
import { resetDecideSearchCache, type DecideSearchMeta, type DecideSlotMeta } from '../core/search/decide-stage.ts';

export interface DecideEvalOptions {
  slots: Partial<Record<DecideSlot, DecideMode>>;
  provider?: string;
  calibrations: string[];
  thresholds: Partial<Record<DecideSlot, number>>;
  forceOn: DecideSlot[];
  datasetPath?: string;
}

export function newDecideEvalOptions(): DecideEvalOptions {
  return { slots: {}, calibrations: [], thresholds: {}, forceOn: [] };
}

/** Flag table (name, value placeholder, help lines) each command renders in its own help. */
export const DECIDE_EVAL_FLAGS: ReadonlyArray<{ name: string; arg: string; help: string[] }> = [
  { name: '--decide', arg: 'SLOT=MODE', help: [
    'System One arm: set a decide slot to off|on|shadow for this run (repeatable;',
    'flags win over an inherited GBRAIN_DECIDE_SLOTS). Slots: ' + DECIDE_SLOTS.join(', ') + '.'] },
  { name: '--decide-provider', arg: 'ID', help: [`Decide provider for the run (default ${DEFAULT_TYPESAFE_PROVIDER}).`] },
  { name: '--decide-calibration', arg: 'FILE|ref:ID', help: [
    'Calibration(s) for on slots: `gbrain decide calibrate --slot X --json` output',
    '(object, array or JSONL) or a reference id (repeatable).'] },
  { name: '--decide-threshold', arg: 'SLOT=X', help: ['Operator threshold override (the action-precision gate still applies).'] },
  { name: '--decide-force-on', arg: 'SLOT', help: ['Bypass the action-precision gate for SLOT (recorded in run_config).'] },
  { name: '--decide-dataset', arg: 'JSONL', help: [
    'Frozen labelled dataset (gbrain decide dataset): calibrations must match its',
    'split_hash and be calibrate-only (else split_mismatch, exit 1).'] },
];

const isSlot = (s: string): s is DecideSlot => (DECIDE_SLOTS as readonly string[]).includes(s);

function slotEq(flag: string, value: string): [DecideSlot, string] {
  const eq = value.indexOf('=');
  const slot = eq > 0 ? value.slice(0, eq).trim() : '';
  if (!isSlot(slot)) throw new Error(`${flag} takes SLOT=VALUE with SLOT one of ${DECIDE_SLOTS.join(', ')} (got: ${value})`);
  return [slot, value.slice(eq + 1).trim()];
}

/** Apply one decide flag; returns false when `flag` is not a decide flag. Throws on an invalid value. */
export function applyDecideEvalFlag(o: DecideEvalOptions, flag: string, value: string): boolean {
  switch (flag) {
    case '--decide': {
      const [slot, mode] = slotEq(flag, value);
      if (mode !== 'off' && mode !== 'on' && mode !== 'shadow') throw new Error(`--decide ${slot} mode must be off|on|shadow (got: ${mode})`);
      o.slots[slot] = mode;
      return true;
    }
    case '--decide-provider':
      if (!isValidProvider(value) || value === 'none') throw new Error(`--decide-provider must be typesafe:<model> or llm:<provider:model> (got: ${value})`);
      o.provider = value;
      return true;
    case '--decide-calibration':
      o.calibrations.push(value);
      return true;
    case '--decide-threshold': {
      const [slot, raw] = slotEq(flag, value);
      const x = Number(raw);
      if (!raw || !Number.isFinite(x) || x < 0 || x > 1) throw new Error(`--decide-threshold ${slot} must be a number from 0 to 1 (got: ${raw})`);
      if (!SLOT_SPECS[slot].thresholded) throw new Error(`--decide-threshold: ${slot} has no threshold`);
      o.thresholds[slot] = x;
      return true;
    }
    case '--decide-force-on':
      if (!isSlot(value)) throw new Error(`--decide-force-on takes a slot: ${DECIDE_SLOTS.join(', ')} (got: ${value})`);
      if (!o.forceOn.includes(value)) o.forceOn.push(value);
      return true;
    case '--decide-dataset':
      o.datasetPath = value;
      return true;
    default:
      return false;
  }
}

/** For hand-rolled parsers: split decide flags (and their values) out of argv. */
export function extractDecideEvalFlags(argv: readonly string[]): { decide: DecideEvalOptions; rest: string[] } {
  const decide = newDecideEvalOptions();
  const rest: string[] = [];
  const names = new Set(DECIDE_EVAL_FLAGS.map((f) => f.name));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (!names.has(name)) { rest.push(a); continue; }
    const value = name !== a ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (name === a && value.startsWith('--'))) throw new Error(`${name} requires a value`);
    applyDecideEvalFlag(decide, name, value);
  }
  return { decide, rest };
}

// ---------------------------------------------------------------------------
// Run preparation (validation, env, calibrations, split holdout)
// ---------------------------------------------------------------------------

/** A refused run: print `message` and exit non-zero. */
export class DecideEvalRefusal extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'DecideEvalRefusal';
  }
}

export interface EvalCalibration {
  /** Where it came from: `ref:<id>` or `<file basename>#<n>`. */
  id: string;
  ref?: string;
  row?: NewCalibration & { action_precision_lb?: number | null; qualification?: string | null; policy_fingerprint?: string | null };
  slot: DecideSlot;
  call_site: string;
  provider: string;
  model_resolved: string;
  threshold: number;
  split_hash: string | null;
  calibrate_only: boolean;
}

export interface DecideEvalRun {
  /** Non-off slots and their modes (flags over inherited env). */
  slots: Partial<Record<DecideSlot, DecideMode>>;
  /** The GBRAIN_DECIDE_SLOTS value set for this process. */
  envValue: string;
  provider: string;
  calibrations: EvalCalibration[];
  thresholds: Partial<Record<DecideSlot, number>>;
  forceOn: DecideSlot[];
  /** Frozen dataset: its eval-half families and per-slot split hashes. */
  dataset: { name: string; evalFamilies: Set<string>; splitHashes: Partial<Record<DecideSlot, string>> } | null;
  /** search.* pins the run adds (`--decide rerank=on` pins the Jev reranker). */
  searchPins: Record<string, string>;
  /** The run-metadata block (run_config.decide / result.decide). */
  runConfig: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse calibration JSON: one object, an array, or JSONL. */
export function parseCalibrationText(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  try {
    const whole = JSON.parse(t) as unknown;
    return (Array.isArray(whole) ? whole : [whole]) as Record<string, unknown>[];
  } catch {
    return t.split('\n').filter((l) => l.trim()).map((l, n) => {
      try { return JSON.parse(l) as Record<string, unknown>; } catch { throw new Error(`calibration line ${n + 1}: not JSON`); }
    });
  }
}

function calibrationFromJson(raw: Record<string, unknown>, id: string): EvalCalibration {
  const slot = str(raw.slot);
  const threshold = numOrNull(raw.threshold);
  const need = { call_site: str(raw.call_site), provider: str(raw.provider), model_resolved: str(raw.model_resolved), pack_shape: str(raw.pack_shape) };
  if (!slot || !isSlot(slot)) throw new Error(`calibration ${id}: slot must be one of ${DECIDE_SLOTS.join(', ')}`);
  for (const [k, v] of Object.entries(need)) if (!v) throw new Error(`calibration ${id}: ${k} is required (use gbrain decide calibrate --json output)`);
  if (threshold === null || threshold < 0 || threshold > 1) throw new Error(`calibration ${id}: threshold must be a number from 0 to 1`);
  const row: EvalCalibration['row'] = {
    slot, call_site: need.call_site!, provider: need.provider!, model_resolved: need.model_resolved!, threshold,
    min_keep: numOrNull(raw.min_keep), metric: str(raw.metric) ?? 'f1', metric_value: numOrNull(raw.metric_value), ece: numOrNull(raw.ece),
    retest_sd: numOrNull(raw.retest_sd), repack_sd: numOrNull(raw.repack_sd), n: numOrNull(raw.n) ?? 0,
    dataset_hash: str(raw.dataset_hash), split_hash: str(raw.split_hash), calibrate_ids_hash: str(raw.calibrate_ids_hash),
    calibrate_only: raw.calibrate_only === true, pack_shape: need.pack_shape!, notes: `eval import ${id}`,
    action_precision_lb: numOrNull(raw.action_precision_lb), qualification: str(raw.qualification), policy_fingerprint: str(raw.policy_fingerprint),
  };
  return { id, row, slot, call_site: row.call_site, provider: row.provider, model_resolved: row.model_resolved, threshold, split_hash: row.split_hash, calibrate_only: row.calibrate_only };
}

function loadCalibrations(specs: readonly string[]): EvalCalibration[] {
  return specs.flatMap((spec) => {
    if (spec.startsWith('ref:')) {
      const r = REFERENCE_CALIBRATIONS.find((x) => x.id === spec.slice(4));
      if (!r) throw new Error(`--decide-calibration ${spec}: unknown reference calibration (this build ships ${REFERENCE_CALIBRATIONS.length})`);
      return [{ id: spec, ref: spec, slot: r.slot, call_site: r.call_site, provider: r.provider, model_resolved: r.model_resolved, threshold: r.threshold, split_hash: r.split_hash, calibrate_only: true }];
    }
    const rows = parseCalibrationText(readFileSync(spec, 'utf8'));
    if (rows.length === 0) throw new Error(`--decide-calibration ${spec}: no calibration rows`);
    return rows.map((raw, n) => calibrationFromJson(raw, `${basename(spec)}#${n + 1}`));
  });
}

/**
 * Validate the flags, merge them over an inherited GBRAIN_DECIDE_SLOTS, set
 * the env and opt this process in, load calibrations and enforce the split
 * holdout. Null when no slot is on or shadow (the all-off path). Throws Error
 * on bad flags and DecideEvalRefusal on split_mismatch.
 */
export function prepareDecideEval(o: DecideEvalOptions, opts: { command: string; throwaway: boolean }): DecideEvalRun | null {
  const inherited = process.env.GBRAIN_DECIDE_SLOTS || null;
  const merged = { ...parseEvalSlots(inherited ?? undefined), ...o.slots };
  const slots = Object.fromEntries(DECIDE_SLOTS.filter((s) => merged[s] && merged[s] !== 'off').map((s) => [s, merged[s]!])) as Partial<Record<DecideSlot, DecideMode>>;
  const active = Object.keys(slots) as DecideSlot[];
  const extras = o.calibrations.length > 0 || Object.keys(o.thresholds).length > 0 || o.forceOn.length > 0 || o.datasetPath !== undefined || o.provider !== undefined;
  if (active.length === 0) {
    if (extras) throw new Error(`--decide-* options need at least one --decide <slot>=on|shadow`);
    return null;
  }
  if (!opts.throwaway && (o.calibrations.length > 0 || Object.keys(o.thresholds).length > 0 || o.forceOn.length > 0)) {
    throw new Error(`${opts.command} runs on your connected brain and never writes its config: --decide-calibration, --decide-threshold and --decide-force-on are for benchmark brains (calibrate/adopt with gbrain decide instead)`);
  }
  const provider = o.provider ?? DEFAULT_TYPESAFE_PROVIDER;
  const calibrations = loadCalibrations(o.calibrations);
  let dataset: DecideEvalRun['dataset'] = null;
  if (o.datasetPath) {
    const items: DatasetItem[] = parseDatasetJsonl(readFileSync(o.datasetPath, 'utf8'));
    const splitHashes = Object.fromEntries(DECIDE_SLOTS.filter((s) => items.some((i) => i.slot === s)).map((s) => [s, splitHash(items.filter((i) => i.slot === s))])) as Partial<Record<DecideSlot, string>>;
    dataset = { name: basename(o.datasetPath), evalFamilies: new Set(items.filter((i) => i.split === 'eval').map((i) => i.family)), splitHashes };
  }
  for (const c of calibrations) {
    const expected = dataset?.splitHashes[c.slot];
    if (!c.calibrate_only || (dataset && c.split_hash !== expected)) {
      const why = !c.calibrate_only ? 'calibrate_only is false' : `split_hash ${c.split_hash ?? 'none'} differs from ${dataset!.name} (${expected ?? `no ${c.slot} items`})`;
      throw new DecideEvalRefusal('split_mismatch', `${opts.command}: calibration ${c.id} refused: ${why}.\n${refusalLine('split_mismatch', c.slot)}`);
    }
    if (c.provider !== provider) process.stderr.write(`[decide] WARN calibration ${c.id} is for ${c.provider}, the run uses ${provider}: it will not resolve a threshold\n`);
  }
  if (calibrations.length > 0 && !dataset) process.stderr.write(`[decide] WARN split holdout not verified: pass --decide-dataset <jsonl> so calibrations are checked against the eval split\n`);
  for (const s of o.forceOn) process.stderr.write(`[decide] WARN force_on ${s}: the action-precision gate is BYPASSED for this eval run (recorded in run_config)\n`);
  const envValue = active.map((s) => `${s}=${slots[s]}`).join(',');
  process.env.GBRAIN_DECIDE_SLOTS = envValue;
  enableDecideEvalOverride();
  const rerankModel = provider.startsWith('typesafe:') ? provider : DEFAULT_TYPESAFE_PROVIDER;
  const searchPins: Record<string, string> = slots.rerank === 'on' ? { 'search.reranker.enabled': 'true', 'search.reranker.model': rerankModel } : {};
  const runConfig: Record<string, unknown> = {
    slots, gbrain_decide_slots: envValue, inherited_env: inherited, provider,
    calibrations: calibrations.map((c) => ({ id: c.id, slot: c.slot, call_site: c.call_site, provider: c.provider, model_resolved: c.model_resolved, threshold: c.threshold, split_hash: c.split_hash })),
    thresholds: o.thresholds, force_on: o.forceOn,
    dataset: dataset ? { name: dataset.name, split_hash: dataset.splitHashes, eval_families: dataset.evalFamilies.size } : null,
    split_verified: calibrations.length === 0 ? null : dataset !== null,
    ...(slots.rerank === 'on' ? { rerank_pinned: rerankModel } : {}),
    ...(opts.throwaway ? { shadow_wait: active.some((s) => slots[s] === 'shadow') } : {}),
  };
  return { slots, envValue, provider, calibrations, thresholds: o.thresholds, forceOn: o.forceOn, dataset, searchPins, runConfig };
}

/** Config keys a throwaway benchmark brain needs so every active slot can act. */
export function benchmarkBrainConfig(run: DecideEvalRun, opts: { includeSearchPins?: boolean } = {}): Array<[string, string]> {
  const writes: Array<[string, string]> = [['decide.provider', run.provider], ['decide.egress.private', 'allow']];
  for (const slot of Object.keys(run.slots) as DecideSlot[]) {
    for (const c of SLOT_SPECS[slot].egressClasses) writes.push([`decide.egress.typesafe.${c}`, 'allow']);
    if (run.slots[slot] === 'shadow') writes.push([`decide.slots.${slot}.shadow_wait`, 'on'], [`decide.slots.${slot}.shadow_sample`, '1']);
  }
  for (const [slot, x] of Object.entries(run.thresholds)) writes.push([`decide.slots.${slot}.threshold`, String(x)]);
  for (const slot of run.forceOn) writes.push([`decide.slots.${slot}.force_on`, 'true']);
  if (opts.includeSearchPins) writes.push(...Object.entries(run.searchPins));
  return [...new Map(writes).entries()];
}

/** Configure one throwaway benchmark brain: config keys, then insert and adopt the calibrations. */
export async function configureDecideBrain(engine: BrainEngine, run: DecideEvalRun, opts: { includeSearchPins?: boolean } = {}): Promise<void> {
  for (const [k, v] of benchmarkBrainConfig(run, opts)) await engine.setConfig(k, v);
  for (const c of run.calibrations) {
    if (c.ref) { await engine.setConfig(`decide.slots.${c.slot}.calibration`, c.ref); continue; }
    const { action_precision_lb, qualification, policy_fingerprint, ...row } = c.row!;
    const id = await insertCalibration(engine, row);
    if (action_precision_lb !== null && action_precision_lb !== undefined) {
      await storeQualification(engine, id, { action_precision_lb, qualification: qualification ?? '{}', policy_fingerprint: policy_fingerprint ?? '' });
    }
    await engine.setConfig(`decide.slots.${c.slot}.calibration`, `local:${id}`);
  }
  resetDecideSearchCache();
}

/**
 * retrieval-quality on the operator's brain: the catalogued refusal line when
 * an active slot has no provider, key or consent (config is never written).
 */
export function operatorBrainRefusal(snapshot: Record<string, string>, run: DecideEvalRun): string | null {
  const cfg = readDecideConfig(snapshot, { evalSlots: run.envValue });
  for (const slot of Object.keys(run.slots) as DecideSlot[]) {
    const provider = slot === 'rerank' ? cfg.provider : cfg.slots[slot].provider;
    if (provider === 'none') return refusalLine('no_provider', slot);
    if ((provider.startsWith('typesafe:') || slot === 'rerank') && !hasTypesafeKey()) return refusalLine('no_key', slot);
    if (slot === 'rerank' || !provider.startsWith('typesafe:')) continue;
    if (SLOT_SPECS[slot].egressClasses.some((c) => !cfg.consent[c])) return refusalLine('egress_class_denied', slot);
    if (SLOT_SPECS[slot].egressClasses.includes('conversation') && cfg.egressPrivate !== 'allow' && cfg.egressFallback === 'none') return refusalLine('egress_private_denied', slot);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipts: per row / per turn / per query, and the run-level roll-up
// ---------------------------------------------------------------------------

export type DecideSpend = Partial<Record<DecideSlot, { input_tokens: number; cost_usd: number; requests: number }>>;

/** decide_spend totals by slot in `engine` (flushes buffered rows first). */
export async function decideSpendTotals(engine: BrainEngine): Promise<DecideSpend> {
  await flushDecideWrites();
  const rows = await engine.executeRaw<{ slot: DecideSlot; tokens: number | string; cost: number | string; n: number | string }>(
    'SELECT slot, COALESCE(SUM(input_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n FROM decide_spend GROUP BY slot',
  ).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.slot, { input_tokens: Number(r.tokens), cost_usd: Number(r.cost), requests: Number(r.n) }]));
}

export function spendDelta(before: DecideSpend, after: DecideSpend): DecideSpend {
  const out: DecideSpend = {};
  for (const slot of Object.keys(after) as DecideSlot[]) {
    const a = after[slot]!, b = before[slot] ?? { input_tokens: 0, cost_usd: 0, requests: 0 };
    if (a.requests > b.requests) out[slot] = { input_tokens: a.input_tokens - b.input_tokens, cost_usd: a.cost_usd - b.cost_usd, requests: a.requests - b.requests };
  }
  return out;
}

export interface DecideSlotReceipt {
  mode: DecideMode;
  /** What the slot did on this row; null when its call site never ran (`skipped: not_reached`). */
  effective: DecideMode | null;
  skipped?: string;
  threshold?: number | null;
  outcomes?: Record<string, number>;
  latency_ms?: number;
  model_resolved?: string;
  judged?: number;
  answer?: string;
  input_tokens?: number;
  cost_usd?: number;
  /** S2: the answer arrived after decide.slots.intent.wait_ms (the regex label stood). */
  late?: boolean;
}

/** One receipt per active slot from the visible slot meta plus this row's decide_spend delta. */
export function decideRowReceipt(run: DecideEvalRun, meta: DecideSearchMeta | undefined, spend: DecideSpend): Partial<Record<DecideSlot, DecideSlotReceipt>> {
  const out: Partial<Record<DecideSlot, DecideSlotReceipt>> = {};
  for (const slot of Object.keys(run.slots) as DecideSlot[]) {
    const m: DecideSlotMeta | undefined = meta?.[slot];
    const s = spend[slot];
    const rerankTokens = slot === 'rerank' && m?.input_tokens !== undefined ? m.input_tokens : undefined;
    const tokens = s ? s.input_tokens + (rerankTokens ?? 0) : rerankTokens;
    const cost = (s?.cost_usd ?? 0) + (rerankTokens ? usageCostUsd(m?.provider ?? run.provider, rerankTokens, 0, 'rerank') ?? 0 : 0);
    out[slot] = {
      mode: run.slots[slot]!,
      effective: m?.effective ?? null,
      ...(m ? (m.skipped ? { skipped: m.skipped } : {}) : { skipped: 'not_reached' }),
      ...(m?.threshold !== undefined ? { threshold: m.threshold } : {}),
      ...(m?.outcomes ? { outcomes: m.outcomes } : {}),
      ...(m?.latency_ms !== undefined ? { latency_ms: m.latency_ms } : {}),
      ...(m?.model_resolved ? { model_resolved: m.model_resolved } : {}),
      ...(m?.judged !== undefined ? { judged: m.judged } : {}),
      ...(m?.answer ? { answer: m.answer } : {}),
      ...(tokens !== undefined ? { input_tokens: tokens, cost_usd: Number(cost.toFixed(8)) } : {}),
      ...(slot === 'intent' && m ? { late: m.skipped === 'late' } : {}),
    };
  }
  return out;
}

/** Run-level roll-up of per-row receipts: per slot rows reached, outcome tally, latency p50/p95, tokens, cost, S2 late rate. */
export function summarizeDecideReceipts(receipts: ReadonlyArray<Partial<Record<DecideSlot, DecideSlotReceipt>> | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const slot of DECIDE_SLOTS) {
    const rows = receipts.map((r) => r?.[slot]).filter((r): r is DecideSlotReceipt => r !== undefined);
    if (rows.length === 0) continue;
    const outcomes: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.outcomes ?? {})) outcomes[k] = (outcomes[k] ?? 0) + v;
      if (r.skipped) skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
    }
    const lat = rows.map((r) => r.latency_ms).filter((x): x is number => typeof x === 'number');
    const intentRows = rows.filter((r) => r.late !== undefined);
    out[slot] = {
      rows: rows.length, acted: rows.filter((r) => r.effective === 'on').length, outcomes, skipped,
      latency_ms: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95) },
      input_tokens: rows.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
      cost_usd: Number(rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0).toFixed(8)),
      ...(intentRows.length > 0 ? { late_rate: Number((intentRows.filter((r) => r.late).length / intentRows.length).toFixed(4)) } : {}),
    };
  }
  return out;
}
