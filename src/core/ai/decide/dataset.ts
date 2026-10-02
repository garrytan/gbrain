/**
 * Labelled decide datasets: one JSONL schema for every slot, a frozen
 * calibrate/eval split by independent family (stable hash of the family id,
 * default 50/50), and per-slot adapters that turn a family of items into the
 * SAME request shape production sends (so calibration, evals and production
 * share one pack_shape).
 *
 * Line schema: {"id","family","slot","split":"calibrate"|"eval","slice"?,
 *   "state":{name:text}, "inputs":{name:text}, "label":true|false|"<choice>",
 *   "rank"?:n, "protected"?:bool}
 *
 * Builders (`gbrain decide dataset --from <source>`) and adapters register per
 * slot; slot lanes add theirs next to their slot code.
 */
import { createHash } from 'node:crypto';
import { evidenceQuestion, reduceEvidence } from './evidence.ts';
import type { DecideAnswer, DecideQuestion, DecideSlot, EvidenceItem } from './types.ts';

export interface DatasetItem {
  id: string;
  family: string;
  slot: DecideSlot;
  split: 'calibrate' | 'eval';
  slice?: string;
  state: Record<string, string>;
  inputs: Record<string, string>;
  label: boolean | string;
  rank?: number;
  protected?: boolean;
}

export function stableSplit(family: string, calibrateShare = 0.5): 'calibrate' | 'eval' {
  const h = createHash('sha256').update(family).digest();
  return h.readUInt32BE(0) / 0xffffffff < calibrateShare ? 'calibrate' : 'eval';
}

/** Hash of the (id, split) assignment: calibrations and evals must agree on it. */
export function splitHash(items: readonly Pick<DatasetItem, 'id' | 'split'>[]): string {
  const lines = items.map((i) => `${i.id}:${i.split}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function idsHash(items: readonly Pick<DatasetItem, 'id'>[]): string {
  return createHash('sha256').update(items.map((i) => i.id).sort().join('\n')).digest('hex').slice(0, 16);
}

export function datasetHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function parseDatasetJsonl(text: string): DatasetItem[] {
  const items: DatasetItem[] = [];
  text.split('\n').forEach((line, n) => {
    if (!line.trim()) return;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line); } catch { throw new Error(`dataset line ${n + 1}: not JSON`); }
    const { id, family, slot, split, state, inputs, label } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || typeof family !== 'string' || typeof slot !== 'string') throw new Error(`dataset line ${n + 1}: id, family and slot are required strings`);
    if (split !== 'calibrate' && split !== 'eval') throw new Error(`dataset line ${n + 1}: split must be calibrate or eval (build with gbrain decide dataset)`);
    if (typeof label !== 'boolean' && typeof label !== 'string') throw new Error(`dataset line ${n + 1}: label must be a boolean or a choice label`);
    items.push({
      id, family, slot: slot as DecideSlot, split, label,
      state: (state ?? {}) as Record<string, string>, inputs: (inputs ?? {}) as Record<string, string>,
      ...(typeof raw.slice === 'string' ? { slice: raw.slice } : {}),
      ...(typeof raw.rank === 'number' ? { rank: raw.rank } : {}),
      ...(raw.protected === true ? { protected: true } : {}),
    });
  });
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(`dataset: duplicate id ${it.id}`);
    ids.add(it.id);
  }
  return items;
}

export function toJsonl(items: readonly DatasetItem[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
}

/** Group items by family, preserving rank order inside each family. */
export function families(items: readonly DatasetItem[]): Map<string, DatasetItem[]> {
  const out = new Map<string, DatasetItem[]>();
  for (const it of items) out.set(it.family, [...(out.get(it.family) ?? []), it]);
  for (const list of out.values()) list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (a.id < b.id ? -1 : 1));
  return out;
}

export interface SlotDatasetAdapter {
  slot: DecideSlot;
  callSite: string;
  /** Build one production-shaped request for a family; question ids map back to item ids. */
  request(family: readonly DatasetItem[]): { state: Record<string, EvidenceItem>; questions: DecideQuestion[]; itemFor: Record<string, DatasetItem> };
  /** Each question is its own request (S7 windows, S8 claim units), as in production. */
  unpacked?: boolean;
  /** Several questions answer one item: its value is their maximum, null when any is unanswered (S7 transcript = max window). */
  aggregate?: 'max';
  /** Harmful action the production reducer took on an item, and whether it was right (null: no harmful action). */
  harmfulActions?(family: readonly DatasetItem[], values: Record<string, number | null>, policy: { threshold: number; margin: number; minKeep: number; suppressBelow?: number }): Array<{ item: DatasetItem; correct: boolean }>;
  /** Choice slots: whether the answer is correct for the item (calibration label); default: the item label is true. */
  positive?(item: DatasetItem, answer: DecideAnswer | undefined): boolean;
  /** The number the production reducer thresholds, when it is not thresholdValue(answer) (S9: P(duplicate) only when duplicate is chosen). */
  calibrationValue?(answer: DecideAnswer): number;
  /** Extra knobs calibrated on the same answers, stored as JSON in the row's notes (S9: proposal_floor on supersede labels). */
  calibrateExtra?(items: readonly DatasetItem[], answers: Record<string, DecideAnswer | undefined>, threshold: number): Record<string, number> | null;
}

/** Items that carry `state.call_site` (one dataset, several call sites) belong to that call site only. */
export function itemForCallSite(item: Pick<DatasetItem, 'state'>, callSite: string): boolean {
  return item.state.call_site === undefined || item.state.call_site === callSite;
}

const adapters = new Map<DecideSlot, SlotDatasetAdapter>();

export function registerDatasetAdapter(adapter: SlotDatasetAdapter): void {
  adapters.set(adapter.slot, adapter);
}

export function datasetAdapter(slot: DecideSlot): SlotDatasetAdapter | undefined {
  return adapters.get(slot);
}

export type DatasetBuilder = (path: string, opts: { slot: DecideSlot; calibrateShare?: number; maxPerFamily?: number }) => Promise<DatasetItem[]>;

const builders = new Map<string, DatasetBuilder>();

export function registerDatasetBuilder(source: string, builder: DatasetBuilder): void {
  builders.set(source, builder);
}

export function datasetBuilder(source: string): DatasetBuilder | undefined {
  return builders.get(source);
}

export function datasetSources(): string[] {
  return [...builders.keys()].sort();
}

// ---------------------------------------------------------------------------
// S3 evidence adapter + builders (LongMemEval sessions; pre-labelled JSONL)
// ---------------------------------------------------------------------------

registerDatasetAdapter({
  slot: 'evidence',
  callSite: 'search',
  request(family) {
    const itemFor: Record<string, DatasetItem> = {};
    const questions = family.map((it, i) => {
      const id = `evidence:${i}`;
      itemFor[id] = it;
      return evidenceQuestion(id, it.rank ?? i, { text: it.inputs.candidate ?? '', class: 'candidates', slug: it.id, source_id: 'dataset' }, it.protected === true);
    });
    return { state: { query: { text: family[0]?.state.query ?? '', class: 'query' } }, questions, itemFor };
  },
  harmfulActions(family, values, policy) {
    // Same reducer as production: a pruned item is the harmful action; it was right when the item is not evidence.
    const outcomes = reduceEvidence(family.map((it, i) => ({ id: it.id, rank: it.rank ?? i, p: values[it.id] ?? null, protected: it.protected === true })), policy);
    return family.filter((it) => outcomes[it.id] === 'pruned').map((it) => ({ item: it, correct: it.label === false }));
  },
});

const CANDIDATE_CHAR_CAP = 6000;

function sessionText(turns: unknown): string {
  if (!Array.isArray(turns)) return '';
  return turns.map((t) => (t && typeof t === 'object' ? `${(t as { role?: string }).role ?? 'user'}: ${(t as { content?: string }).content ?? ''}` : '')).join('\n').slice(0, CANDIDATE_CHAR_CAP);
}

/** LongMemEval: family = question; candidates = haystack sessions; label = the session holds the answer. */
registerDatasetBuilder('longmemeval', async (path, opts) => {
  const raw = JSON.parse(await Bun.file(path).text()) as Array<Record<string, unknown>>;
  const maxPer = opts.maxPerFamily ?? 20;
  const items: DatasetItem[] = [];
  for (const q of raw) {
    const family = String(q.question_id ?? '');
    const sessions = (q.haystack_sessions as unknown[]) ?? [];
    const ids = ((q.haystack_session_ids as string[]) ?? sessions.map((_, i) => `s${i}`)).map(String);
    const answers = new Set(((q.answer_session_ids as string[]) ?? []).map(String));
    // A haystack can repeat a session id (same turns, another date): keep its first occurrence so item ids stay unique.
    const seen = new Set<string>();
    const order = ids.flatMap((id, i) => (seen.has(id) ? [] : (seen.add(id), [{ id, i, key: createHash('sha256').update(`${family}:${id}`).digest('hex') }])));
    const positives = order.filter((o) => answers.has(o.id));
    const negatives = order.filter((o) => !answers.has(o.id)).sort((a, b) => (a.key < b.key ? -1 : 1));
    const chosen = [...positives, ...negatives].slice(0, Math.max(maxPer, positives.length)).sort((a, b) => a.i - b.i);
    const split = stableSplit(family, opts.calibrateShare);
    chosen.forEach((o, rank) => items.push({
      id: `${family}:${o.id}`, family, slot: opts.slot, split, slice: String(q.question_type ?? 'all'),
      state: { query: String(q.question ?? '') }, inputs: { candidate: sessionText(sessions[o.i]) }, label: answers.has(o.id), rank,
    }));
  }
  return items;
});

/** Pre-labelled JSONL (split optional): assigns the frozen family split. */
registerDatasetBuilder('jsonl', async (path, opts) => {
  const lines = (await Bun.file(path).text()).split('\n').filter((l) => l.trim());
  return lines.map((line, n) => {
    const raw = JSON.parse(line) as Partial<DatasetItem>;
    if (!raw.id || !raw.family) throw new Error(`jsonl line ${n + 1}: id and family are required`);
    return { ...raw, slot: raw.slot ?? opts.slot, split: stableSplit(raw.family, opts.calibrateShare), state: raw.state ?? {}, inputs: raw.inputs ?? {}, label: raw.label ?? false } as DatasetItem;
  });
});
