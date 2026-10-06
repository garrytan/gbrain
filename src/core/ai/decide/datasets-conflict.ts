/**
 * S9 `conflict` dataset adapter and the `facts-fixtures` builder.
 *
 * The adapter builds the production request shape: state = the new fact
 * (class `facts`), one `choice` question per candidate (duplicate | supersede
 * | independent). Conflict is not a harmful-direction slot (v1 only writes
 * proposals). Its harmful-action reducer serves the review lane's acting call
 * sites: `gbrain decide qualify --slot conflict --call-site review_withdraw`
 * bounds the precision of the withdrawals it would propose.
 *
 * `gbrain decide dataset --slot conflict --from facts-fixtures <path>` reads
 * labelled fact pairs, one JSON object per line:
 *   {"id":"p1","family":"alice-example-role","fact":"<new fact>","candidate":"<older fact>",
 *    "label":"duplicate"|"supersede"|"independent","slice"?:"<name>"}
 * `family` defaults to `id` (pairs sharing a new fact should share a family
 * so they pack together). The calibrated number is the duplicate threshold,
 * so the dataset label is `true` exactly for `duplicate`; the choice label is
 * kept as the slice unless one is given. Calibration also picks the proposal
 * floor on the supersede labels (stored in the row's notes; the sweep uses it
 * unless decide.slots.conflict.proposal_floor overrides it).
 */
import { searchThreshold } from './calibrate.ts';
import { conflictQuestion, reduceConflict, supersedeProbability } from './conflict.ts';
import { registerDatasetAdapter, registerDatasetBuilder, stableSplit, type DatasetItem } from './dataset.ts';
import { thresholdValue, type DecideAnswer } from './types.ts';

/** Supersede labels the proposal-floor calibration needs before it runs. */
export const MIN_SUPERSEDE_LABELS = 10;

/** Reducer-consistent duplicate value: the duplicate rule fires only when duplicate is the chosen label. */
export function duplicateValue(answer: DecideAnswer): number {
  return answer.kind === 'choice' && answer.choice === 'duplicate' ? thresholdValue(answer) : 0;
}

/**
 * Proposal floor on supersede labels (the choice label is the item's slice):
 * over the pairs the calibrated duplicate rule does not take, the F1-best
 * P(supersede) floor. Items whose slice is not a choice label are left out. Null when the dataset carries too few supersede labels.
 */
export function calibrateProposalFloor(items: readonly DatasetItem[], answers: Record<string, DecideAnswer | undefined>, threshold: number): Record<string, number> | null {
  const rest = items.flatMap((it) => {
    const a = answers[it.id];
    if (a?.kind !== 'choice' || !(CONFLICT_LABELS as readonly string[]).includes(it.slice ?? '') || reduceConflict(a, { threshold, proposalFloor: Infinity }) === 'duplicate') return [];
    return [{ value: supersedeProbability(a), label: it.slice === 'supersede' }];
  });
  const supersedes = rest.filter((r) => r.label).length;
  if (supersedes < MIN_SUPERSEDE_LABELS) return null;
  const c = searchThreshold(rest, 'f1');
  return c ? { proposal_floor: c.threshold, proposal_floor_precision: c.precision, proposal_floor_recall: c.recall, proposal_floor_n: rest.length, proposal_floor_supersedes: supersedes } : null;
}

export const CONFLICT_LABELS = ['duplicate', 'supersede', 'independent'] as const;

/** Registers the conflict adapter and the facts-fixtures builder (called by the write-path lane module). */
export function registerConflictDatasets(): void {
  registerDatasetAdapter({
    slot: 'conflict',
    callSite: 'sweep',
    request(family) {
      const itemFor: Record<string, DatasetItem> = {};
      const questions = family.map((it, i) => {
        const id = `conflict:${i}`;
        itemFor[id] = it;
        return conflictQuestion(id, it.rank ?? i, { id: i + 1, source_id: 'dataset', fact: it.inputs.candidate ?? '', visibility: 'world' });
      });
      const fact = family[0]?.state.fact ?? '';
      return { state: { fact: { text: fact, class: 'facts', fact_id: 0, source_id: 'dataset', visibility: 'world' } }, questions, itemFor };
    },
    calibrationValue: duplicateValue,
    calibrateExtra: calibrateProposalFloor,
    // The acting call sites (review_withdraw, review_duplicate_*) act on a duplicate at or above the threshold;
    // qualification counts each such action correct exactly when the pair is labelled duplicate.
    harmfulActions(family, values, policy) {
      return family.flatMap((it) => {
        const p = values[it.id];
        return p === null || p === undefined || p < policy.threshold ? [] : [{ item: it, correct: it.label === true }];
      });
    },
  });
  registerDatasetBuilder('facts-fixtures', async (path, opts) => parseConflictPairs(await Bun.file(path).text(), opts));
}

export function parseConflictPairs(text: string, opts: { calibrateShare?: number } = {}): DatasetItem[] {
  const ranks = new Map<string, number>();
  return text.split('\n').flatMap((line, n) => {
    if (!line.trim()) return [];
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line); } catch { throw new Error(`facts-fixtures line ${n + 1}: not JSON`); }
    const { id, fact, candidate, label } = raw;
    if (typeof id !== 'string' || typeof fact !== 'string' || typeof candidate !== 'string') throw new Error(`facts-fixtures line ${n + 1}: id, fact and candidate are required strings`);
    if (!(CONFLICT_LABELS as readonly unknown[]).includes(label)) throw new Error(`facts-fixtures line ${n + 1}: label must be one of ${CONFLICT_LABELS.join(', ')}`);
    const family = typeof raw.family === 'string' ? raw.family : id;
    const rank = ranks.get(family) ?? 0;
    ranks.set(family, rank + 1);
    return [{
      id, family, slot: 'conflict' as const, split: stableSplit(family, opts.calibrateShare), slice: typeof raw.slice === 'string' ? raw.slice : String(label),
      state: { fact }, inputs: { candidate }, label: label === 'duplicate', rank,
    }];
  });
}

