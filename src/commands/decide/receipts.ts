/**
 * `gbrain decide receipts`: aggregate receipt statistics only (counts, outcome
 * mix, probability distribution, latency); never text. `--what-if-threshold`
 * recomputes the outcome mix a different threshold would have produced from
 * stored answers, protection, rank and min_keep, with no provider call, for
 * slots whose reducer is exactly reproducible from receipts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { whatIfEvidence } from '../../core/ai/decide/evidence.ts';
import { marginFor } from '../../core/ai/decide/policy.ts';
import { SLOT_SPECS } from '../../core/ai/decide/slots.ts';
import { receiptStats, replayReceipts } from '../../core/ai/decide/store.ts';
import { DECIDE_SLOTS, type DecideSlot } from '../../core/ai/decide/types.ts';
import { flagValue, loadDecideState } from '../decide.ts';

/** Slot lanes whose reducer replays exactly register it here (S7, S8). */
const whatIfReducers = new Map<DecideSlot, (receipts: Awaited<ReturnType<typeof replayReceipts>>, threshold: number, margin: number) => Record<string, number>>([
  ['evidence', whatIfEvidence],
]);

export function registerWhatIfReducer(slot: DecideSlot, reducer: (receipts: Awaited<ReturnType<typeof replayReceipts>>, threshold: number, margin: number) => Record<string, number>): void {
  whatIfReducers.set(slot, reducer);
}

function sinceHours(raw: string | undefined): number {
  if (!raw) return 24;
  const m = /^(\d+)([hd]?)$/.exec(raw.trim());
  if (!m) return 24;
  return Number(m[1]) * (m[2] === 'd' ? 24 : 1);
}

export async function runReceiptsCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const slotRaw = flagValue(args, '--slot');
  if (slotRaw && !(DECIDE_SLOTS as readonly string[]).includes(slotRaw)) { console.error(`unknown slot ${slotRaw}`); return 1; }
  const slot = slotRaw as DecideSlot | undefined;
  const hours = sinceHours(flagValue(args, '--since'));
  const whatIf = flagValue(args, '--what-if-threshold');
  if (whatIf !== undefined) {
    const t = Number(whatIf);
    if (!slot || !Number.isFinite(t) || t < 0 || t > 1) { console.error('Usage: gbrain decide receipts --slot <slot> --what-if-threshold <0..1>'); return 1; }
    const reducer = whatIfReducers.get(slot);
    if (!reducer || !SLOT_SPECS[slot].whatIfReproducible) { console.error(`${slot}: not reproducible from receipts (its reducer depends on more than the stored answers)`); return 1; }
    const state = await loadDecideState(engine);
    const rows = await replayReceipts(engine, slot, hours);
    const actual: Record<string, number> = {};
    for (const r of rows) actual[r.outcome] = (actual[r.outcome] ?? 0) + 1;
    const mix = reducer(rows, t, marginFor(state.cfg.marginFloor));
    const out = { slot, since_hours: hours, receipts: rows.length, threshold: t, actual, what_if: mix };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(`${slot} over ${hours} h (${rows.length} receipts): actual ${JSON.stringify(actual)} → at threshold ${t}: ${JSON.stringify(mix)}`);
    return 0;
  }
  const stats = await receiptStats(engine, { slot, sinceHours: hours });
  if (json) { console.log(JSON.stringify({ since_hours: hours, rows: stats }, null, 2)); return 0; }
  if (stats.length === 0) { console.log(`No receipts in the last ${hours} h${slot ? ` for ${slot}` : ''}.`); return 0; }
  console.log(`Receipts, last ${hours} h (aggregates only; no text is stored):`);
  for (const s of stats) {
    const p = s.avg_value === null ? '' : ` mean answer ${s.avg_value.toFixed(3)}`;
    const lat = s.p50_latency === null ? '' : ` latency p50 ${Math.round(s.p50_latency)} ms p95 ${Math.round(s.p95_latency ?? 0)} ms`;
    console.log(`  ${s.slot} ${s.mode} ${s.outcome}${s.error_reason ? ` (${s.error_reason})` : ''}: ${s.n}${p}${lat}`);
  }
  return 0;
}
