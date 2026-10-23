/**
 * GBRA-161: the pure decision of one publication (no I/O). Given the live generation, the items as stored, the proposed
 * result and the settings, it returns what to write, retire and keep, or why the result is held (D4). publish.ts runs
 * it under the key lock and applies the answer in the activation transaction.
 *
 * Ownership: an item is the key's when the live generation recorded it, or when it carries the key's origin metadata and
 * either the result reproduces it or retained producer evidence shows it unedited (`evidence`, legacy adoption). Any other
 * live row with the key's origin metadata is protected: never retired, listed in the outcome.
 */
import type { GenerationsConfig } from './config.ts';
import type { HeldReason, InputState, ItemRow, ProposedItem } from './contract.ts';

/** The live generation as the ledger records it: owned item keys and their identity hashes at that generation. */
export interface LiveGeneration { id: number; generation: number; inputPin: string | null; inputSize: number | null; items: Map<string, string> }

/** Below this many retirements in one run window the ratio half of the valve does not apply (a small brain retiring a few items). */
export const VALVE_RATIO_MIN = 25;

export interface PlanInput {
  live: LiveGeneration | null;
  rows: ReadonlyMap<string, ItemRow>;
  proposal: readonly ProposedItem[];
  /** For an empty result: whether its empty-source proof held under the lock. */
  proofHolds: boolean;
  input: InputState | null;
  config: GenerationsConfig;
  modelProduced: boolean;
  strictOrder?: boolean;
  /** A partial result (input cut short): writes its items, retires nothing. */
  additive: boolean;
  evidence: ReadonlySet<string>;
  valve: { windowRetired: number; ownedTotal: number };
  /** The held reason an operator release overrides (`shrunk`, `valve`, `attempts_exhausted`). */
  release?: HeldReason;
}

export type Plan =
  | { kind: 'publish'; puts: ProposedItem[]; kept: string[]; adopted: string[]; retires: string[]; carried: string[]; protectedKeys: string[] }
  | { kind: 'held'; reason: HeldReason; context: Record<string, unknown> }
  | { kind: 'unchanged'; protectedKeys: string[] };

export function planGeneration(input: PlanInput): Plan {
  const { live, rows, proposal, config } = input;
  const proposed = new Map(proposal.map(item => [item.key, item]));
  const recorded = new Set([...(live?.items.keys() ?? [])].filter(key => rows.get(key)?.live));
  const unrecorded = [...rows.values()].filter(row => row.owned && row.live && !recorded.has(row.key));
  const adoptable = new Set(unrecorded.filter(row => proposed.has(row.key) || input.evidence.has(row.key)).map(row => row.key));
  const protectedKeys = unrecorded.filter(row => !adoptable.has(row.key)).map(row => row.key).sort();
  const ownedBefore = new Set([...recorded, ...adoptable]);
  const retires = input.additive ? [] : [...ownedBefore].filter(key => !proposed.has(key)).sort();
  const puts = proposal.filter(item => { const row = rows.get(item.key); return !row || !row.live || row.identityHash !== item.identityHash; });
  const same = proposal.filter(item => !puts.includes(item)).map(item => item.key);
  const kept = same.filter(key => recorded.has(key));
  const adopted = same.filter(key => !recorded.has(key));
  const carried = input.additive ? [...recorded].filter(key => !proposed.has(key)).sort() : [];
  const ratio = live?.inputSize && input.input ? Math.min(1, input.input.size / live.inputSize) : 1;
  const context = { owned: ownedBefore.size, result: proposal.length, puts: puts.length, retires: retires.length, floor: config.shrinkFloor,
    input_ratio: Number(ratio.toFixed(4)), input_size: input.input?.size ?? null, live_input_size: live?.inputSize ?? null, protected: protectedKeys.length };
  const held = (reason: HeldReason, extra: Record<string, unknown> = {}): Plan => ({ kind: 'held', reason, context: { ...context, ...extra } });

  const touched = [...puts.map(item => item.key), ...retires];
  if (touched.some(key => rows.get(key)?.segmented)) return held('segmented_unsupported');
  if (input.strictOrder) {
    const orders = proposal.map(item => item.order);
    const tied = orders.filter((order, index) => order === undefined || orders.indexOf(order) !== index);
    if (tied.length) return held('tie', { tied: tied.length });
  }
  if (!proposal.length && retires.length && !input.proofHolds) return held('no_proof');
  if (Math.max(puts.length, retires.length) > config.maxItems) return held('oversize', { max_items: config.maxItems });
  const shrinkReleased = input.release === 'shrunk' || input.release === 'attempts_exhausted';
  if (input.modelProduced && !input.additive && !shrinkReleased && proposal.length && retires.length && proposal.length < ownedBefore.size
    && proposal.length <= config.shrinkFloor * ownedBefore.size * ratio) return held('shrunk');
  if (retires.length) {
    const total = (input.release === 'valve' ? 0 : input.valve.windowRetired) + retires.length;
    const ratioLimit = config.valveMaxRatio * Math.max(input.valve.ownedTotal, ownedBefore.size);
    if (total > config.valveMaxPerRun || (input.release !== 'valve' && total > VALVE_RATIO_MIN && total > ratioLimit)) {
      return held('valve', { window_retired: input.valve.windowRetired, max_per_run: config.valveMaxPerRun, max_ratio: config.valveMaxRatio, owned_total: input.valve.ownedTotal });
    }
  }
  if (live && !puts.length && !retires.length && !adopted.length && !carried.length && sameKeys(recorded, proposed)) return { kind: 'unchanged', protectedKeys };
  return { kind: 'publish', puts, kept, adopted, retires, carried, protectedKeys };
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlyMap<string, unknown>): boolean {
  return a.size === b.size && [...a].every(key => b.has(key));
}
