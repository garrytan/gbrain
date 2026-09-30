/**
 * Per-model spend ledger behind `BudgetTracker.snapshot().models` and the
 * `models_used` receipt field (#5585). Rows key on (requested model, served
 * model, touchpoint, purpose) so a caller can see which model every gateway
 * touchpoint actually called — including engine-internal calls (query
 * expansion, embeddings, rerank) that no command flag names.
 *
 * `calls` counts gateway operations; `attempts` counts every recorded
 * provider round-trip. SDK-internal retries and a structured-output fallback
 * inside one operation are ONE call (the fallback adds an attempt). A row's
 * `cost_usd` is null when the served model is unpriced, and `cost_basis` is
 * `estimated` when any contributing record was priced from a heuristic token
 * count (char-estimated embed/rerank input, or a failed call's pessimistic
 * fallback) instead of provider-reported usage.
 */

export type ModelTouchpoint = 'chat' | 'expansion' | 'embedding' | 'rerank' | 'ocr' | 'other';

export interface ModelUsageRow {
  requested_model: string;
  /** Served (reported) model, pricing-canonicalized. */
  model: string;
  touchpoint: ModelTouchpoint;
  purpose: string | null;
  calls: number;
  attempts: number;
  failed_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  cost_basis: 'measured' | 'estimated';
}

export interface LedgerEntry {
  requestedModel: string;
  model: string;
  label?: string;
  purpose?: string;
  failed: boolean;
  countsAsCall: boolean;
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const TOUCHPOINT_ORDER: readonly ModelTouchpoint[] = ['chat', 'expansion', 'embedding', 'rerank', 'ocr', 'other'];

const LABEL_TOUCHPOINTS: ReadonlyArray<[string, ModelTouchpoint]> = [
  ['gateway.chat', 'chat'],
  ['gateway.expand', 'expansion'],
  ['gateway.embed', 'embedding'],
  ['gateway.rerank', 'rerank'],
  ['gateway.ocr', 'ocr'],
];

/** Map a gateway record label (`gateway.expand.failed`, …) to its touchpoint. */
export function touchpointForLabel(label: string | undefined): ModelTouchpoint {
  if (!label) return 'other';
  for (const [prefix, touchpoint] of LABEL_TOUCHPOINTS) {
    if (label === prefix || label.startsWith(`${prefix}.`)) return touchpoint;
  }
  return 'other';
}

function rowKey(r: Pick<ModelUsageRow, 'requested_model' | 'model' | 'touchpoint' | 'purpose'>): string {
  return JSON.stringify([r.requested_model, r.model, r.touchpoint, r.purpose]);
}

function combine(a: ModelUsageRow, b: ModelUsageRow): ModelUsageRow {
  return {
    ...a,
    calls: a.calls + b.calls,
    attempts: a.attempts + b.attempts,
    failed_calls: a.failed_calls + b.failed_calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cost_usd: a.cost_usd === null || b.cost_usd === null ? null : a.cost_usd + b.cost_usd,
    cost_basis: a.cost_basis === 'estimated' || b.cost_basis === 'estimated' ? 'estimated' : 'measured',
  };
}

function rowForEntry(e: LedgerEntry): ModelUsageRow {
  return {
    requested_model: e.requestedModel,
    model: e.model,
    touchpoint: touchpointForLabel(e.label),
    purpose: e.purpose ?? null,
    calls: e.countsAsCall ? 1 : 0,
    attempts: 1,
    failed_calls: e.failed && e.countsAsCall ? 1 : 0,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    cost_usd: e.costUsd,
    cost_basis: e.estimated ? 'estimated' : 'measured',
  };
}

function sortRows(rows: ModelUsageRow[]): ModelUsageRow[] {
  return rows.sort((a, b) =>
    TOUCHPOINT_ORDER.indexOf(a.touchpoint) - TOUCHPOINT_ORDER.indexOf(b.touchpoint)
    || (a.purpose ?? '').localeCompare(b.purpose ?? '')
    || a.model.localeCompare(b.model)
    || a.requested_model.localeCompare(b.requested_model));
}

/** In-memory aggregation of recorded usage; one instance per BudgetTracker. */
export class ModelLedger {
  private readonly rowsByKey = new Map<string, ModelUsageRow>();

  add(entry: LedgerEntry): void {
    const row = rowForEntry(entry);
    const key = rowKey(row);
    const prev = this.rowsByKey.get(key);
    this.rowsByKey.set(key, prev ? combine(prev, row) : row);
  }

  rows(): ModelUsageRow[] {
    return sortRows([...this.rowsByKey.values()].map(r => ({ ...r })));
  }
}

/** Merge row sets (e.g. prior resume segments + this segment) on the ledger key. */
export function mergeModelUsageRows(...sets: ModelUsageRow[][]): ModelUsageRow[] {
  const merged = new Map<string, ModelUsageRow>();
  for (const row of sets.flat()) {
    const key = rowKey(row);
    const prev = merged.get(key);
    merged.set(key, prev ? combine(prev, row) : { ...row });
  }
  return sortRows([...merged.values()]);
}

/**
 * Receipt-ready `models_used` rows from a tracker snapshot, merged with rows
 * persisted by earlier segments of the same run (resume).
 */
export function buildModelsUsed(snapshot: { models: ModelUsageRow[] }, priorRows: ModelUsageRow[] = []): ModelUsageRow[] {
  return mergeModelUsageRows(priorRows, snapshot.models);
}

/**
 * Fixed-width table lines (header first) for CLI summaries. `requested ->
 * served` shows only when they differ; `~` marks an estimated cost.
 */
export function formatModelsUsedTable(rows: ModelUsageRow[]): string[] {
  const header = ['touchpoint', 'purpose', 'model', 'calls', 'tokens in/out', 'cost'];
  const cells = rows.map(r => [
    r.touchpoint,
    r.purpose ?? 'engine',
    r.requested_model === r.model ? r.model : `${r.requested_model} -> ${r.model}`,
    `${r.calls}${r.attempts !== r.calls ? ` (${r.attempts} attempts)` : ''}${r.failed_calls > 0 ? `, ${r.failed_calls} failed` : ''}`,
    `${r.input_tokens}/${r.output_tokens}`,
    r.cost_usd === null ? 'unpriced' : `${r.cost_basis === 'estimated' ? '~' : ''}$${r.cost_usd.toFixed(4)}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map(c => c[i]!.length)));
  return [header, ...cells].map(c => c.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd());
}
