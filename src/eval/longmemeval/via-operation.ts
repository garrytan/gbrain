/**
 * `gbrain eval longmemeval --via-operation query|search`: run each question
 * through the real `query` or `search` operation with the context an agent's
 * stdio MCP call gets (remote, stdio transport, the owner source id), instead
 * of calling hybridSearch from the core library. Each operation runs at its own
 * default limit and resolves the brain's search mode itself, so a receipt
 * reproduces from a tagged gbrain. `--op-expand on|off` passes `expand` to
 * `query`; without it the mode decides.
 *
 * Every row records the operation context, the `expand` sent, the expansion
 * outcome, model calls per touchpoint, operation latency and the CRAG
 * confidence grade. When the run expects expansion and a question did not
 * expand, the row carries the `expansion_not_applied` degraded stage, which
 * fails the run like `--expansion`'s `expansion_failed` (the arm is invalid
 * until a named repair).
 */
import { execFileSync } from '../../core/spawn.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import type { GBrainConfig } from '../../core/config.ts';
import type { HybridSearchMeta, SearchResult } from '../../core/types.ts';
import type { ModelTouchpoint } from '../../core/budget/models-used.ts';
import { BudgetTracker } from '../../core/budget/budget-tracker.ts';
import { withBudgetTracker } from '../../core/ai/gateway.ts';
import { operationsByName } from '../../core/operations.ts';
import { buildOperationContext } from '../../mcp/dispatch.ts';

export type ViaOperation = 'query' | 'search';

export interface ViaOperationOptions {
  op?: ViaOperation;
  /** `--op-expand on|off`: the `expand` param sent to `query`; undefined = unset (the mode decides). */
  expand?: boolean;
}

export function newViaOperationOptions(): ViaOperationOptions {
  return {};
}

/** The agent-shaped context every question runs under (recorded in the pins). */
export const VIA_OPERATION_CONTEXT = { remote: true, transport: 'stdio', source_id: 'default' } as const;

export const LME_VIA_OPERATION_FLAGS: Array<{ name: string; arg?: string; help: string[]; apply: (o: { viaOp: ViaOperationOptions }, value: string) => void }> = [
  { name: '--via-operation', arg: 'query|search', help: [
      'Run each question through the real `query` or `search` operation with an',
      'agent\'s stdio MCP context (remote, stdio, source `default`) at the',
      'operation\'s default limit, instead of the core-library hybridSearch call.',
      'Rows record the context, model calls, latency, expansion outcome and CRAG',
      'grade; run_config.via_operation_summary has p50/p95 latency per arm.'],
    apply: (o, v) => { if (v !== 'query' && v !== 'search') throw new Error(`--via-operation must be query|search (got: ${v})`); o.viaOp.op = v; } },
  { name: '--op-expand', arg: 'on|off', help: [
      'With --via-operation query: send `expand: true|false`. Omitted = unset, so',
      'the resolved search mode decides (on only in tokenmax). A run that expects',
      'expansion fails when any question did not expand (expansion_not_applied).'],
    apply: (o, v) => {
      const s = v.trim().toLowerCase();
      if (s !== 'on' && s !== 'off') throw new Error(`--op-expand must be on|off (got: ${v})`);
      o.viaOp.expand = s === 'on';
    } },
];

/** Refuse flag combinations the via-operation path would silently ignore. */
export function validateViaOperation(o: {
  viaOp: ViaOperationOptions; keywordOnly: boolean; expansion: boolean; expansionVariantBudget?: number | null; capturePool: boolean;
}): void {
  if (!o.viaOp.op) {
    if (o.viaOp.expand !== undefined) throw new Error('--op-expand needs --via-operation query');
    return;
  }
  if (o.viaOp.op === 'search' && o.viaOp.expand !== undefined) throw new Error('--op-expand applies to --via-operation query only (`search` never expands)');
  const ignored = [
    o.keywordOnly && '--keyword-only',
    o.expansion && '--expansion / --expansion-replay (use --op-expand)',
    o.expansionVariantBudget !== undefined && '--expansion-variant-budget (use --search-pin search.expansion_variant_budget=…)',
    o.capturePool && '--capture-pool',
  ].filter((x): x is string => typeof x === 'string');
  if (ignored.length > 0) throw new Error(`--via-operation cannot be combined with ${ignored.join(', ')}`);
}

/** The pin folded into retrieval_config_hash, so a resume never merges via-operation and direct rows. */
export function viaOperationPins(v: ViaOperationOptions): { via_operation?: Record<string, unknown> } {
  if (!v.op) return {};
  return { via_operation: { op: v.op, expand: v.expand ?? null, limit: 'operation_default', context: { ...VIA_OPERATION_CONTEXT } } };
}

export type ExpansionOutcome = 'applied' | 'failed' | 'not_attempted' | 'no_variants' | 'not_expected';

export interface ViaOperationRow {
  op: ViaOperation;
  expand: boolean | null;
  latency_ms: number;
  rows_returned: number;
  /** Recorded gateway calls by touchpoint (expansion / embedding / rerank / chat …) for this question. */
  model_calls: Partial<Record<ModelTouchpoint, number>>;
  failed_model_calls: number;
  expansion: { expected: boolean; outcome: ExpansionOutcome };
  crag_confidence: string | null;
}

export interface ViaOperationResult {
  results: SearchResult[];
  meta: HybridSearchMeta;
  row: ViaOperationRow;
}

let auditDir: string | null = null;

/**
 * One question through the operation. `expectExpansion` is the resolved
 * expectation for the run (op query and expand on, or unset with the mode's
 * expansion on). Never throws for a degraded call; an operation error throws.
 */
export async function runViaOperation(
  engine: BrainEngine,
  question: string,
  v: ViaOperationOptions & { op: ViaOperation },
  expectExpansion: boolean,
): Promise<ViaOperationResult> {
  const meta: Record<string, unknown> = {};
  const ctx = buildOperationContext(engine, {}, {
    remote: VIA_OPERATION_CONTEXT.remote, transport: VIA_OPERATION_CONTEXT.transport, sourceId: VIA_OPERATION_CONTEXT.source_id,
    config: { engine: 'pglite' } as GBrainConfig,
  });
  ctx.emitResponseMeta = (key, value) => { meta[key] = value; };
  const params: Record<string, unknown> = { query: question, ...(v.op === 'query' && v.expand !== undefined ? { expand: v.expand } : {}) };

  auditDir ??= mkdtempSync(join(tmpdir(), 'gbrain-lme-via-op-'));
  const tracker = new BudgetTracker({ label: 'longmemeval.via_operation', auditPath: join(auditDir, 'budget.jsonl') });
  const started = performance.now();
  const results = await withBudgetTracker(tracker, () => operationsByName[v.op].handler(ctx, params)) as SearchResult[];
  const latency_ms = Math.round(performance.now() - started);

  const modelCalls: Partial<Record<ModelTouchpoint, number>> = {};
  let failed = 0;
  let expansionCalls = 0;
  let expansionFailures = 0;
  for (const m of tracker.snapshot().models) {
    modelCalls[m.touchpoint] = (modelCalls[m.touchpoint] ?? 0) + m.calls;
    failed += m.failed_calls;
    if (m.touchpoint === 'expansion') { expansionCalls += m.calls; expansionFailures += m.failed_calls; }
  }

  const retrieval = (meta.retrieval ?? {}) as HybridSearchMeta & { crag?: { confidence?: string } };
  const applied = retrieval.expansion_applied === true;
  const outcome: ExpansionOutcome = !expectExpansion ? (applied ? 'applied' : 'not_expected')
    : applied ? 'applied'
    : expansionFailures > 0 ? 'failed'
    : expansionCalls === 0 ? 'not_attempted'
    : 'no_variants';
  const degraded = [...(retrieval.degraded ?? [])];
  // An eval-only stage (the outcome itself rides `via_operation.expansion`); resume.ts counts it as an expansion failure.
  if (expectExpansion && outcome !== 'applied') degraded.push({ stage: 'expansion_not_applied' } as never);

  return {
    results: Array.isArray(results) ? results : [],
    meta: { ...retrieval, vector_enabled: retrieval.vector_enabled ?? false, expansion_applied: applied, degraded } as HybridSearchMeta,
    row: {
      op: v.op,
      expand: v.op === 'query' ? v.expand ?? null : false,
      latency_ms,
      rows_returned: Array.isArray(results) ? results.length : 0,
      model_calls: modelCalls,
      failed_model_calls: failed,
      expansion: { expected: expectExpansion, outcome },
      crag_confidence: retrieval.crag?.confidence ?? null,
    },
  };
}

/** The operation's agent-facing rows never carry rerank_score, so a via-operation row's recorded rerank call is the evidence it was reranked. */
export function rerankCalled(row: ViaOperationRow): boolean {
  return (row.model_calls.rerank ?? 0) > 0;
}

/** The gbrain checkout this module runs from, not the caller's cwd (a driver may run the harness from another repository). */
export function gbrainBuild(): { tree: string; commit: string; dirty: boolean } {
  const git = (argv: string[], fallback: string) => {
    try { return execFileSync('git', argv, { cwd: join(import.meta.dir, '..', '..', '..'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback; } catch { return fallback; }
  };
  return { tree: git(['rev-parse', 'HEAD^{tree}'], 'unknown'), commit: git(['rev-parse', 'HEAD'], 'unknown'), dirty: git(['status', '--porcelain', '--untracked-files=no'], '') !== '' };
}

/** The run-end FAIL line when a run that expects expansion has rows that did not expand. */
export function expansionFailLine(rows: number): string {
  return `[longmemeval] FAIL --via-operation query (expansion expected): ${rows} row(s) did not expand (expansion_not_applied / expansion_failed); this arm is invalid until a named repair — expansion_failed_rows\n`;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The per-arm block on run_config: latency p50/p95, mean model calls per query by touchpoint, CRAG grades, expansion outcomes. */
export function summarizeViaOperation(rows: ReadonlyArray<Record<string, unknown>>, build: { tree: string; commit: string; dirty: boolean }): Record<string, unknown> {
  const via = rows.map(r => r.via_operation as ViaOperationRow | undefined).filter((x): x is ViaOperationRow => !!x && typeof x.latency_ms === 'number');
  const latencies = via.map(r => r.latency_ms).sort((a, b) => a - b);
  const calls: Record<string, number> = {};
  const crag: Record<string, number> = {};
  const expansion: Record<string, number> = {};
  for (const r of via) {
    for (const [t, n] of Object.entries(r.model_calls)) calls[t] = (calls[t] ?? 0) + (n ?? 0);
    const grade = r.crag_confidence ?? 'none';
    crag[grade] = (crag[grade] ?? 0) + 1;
    expansion[r.expansion.outcome] = (expansion[r.expansion.outcome] ?? 0) + 1;
  }
  const perQuery = Object.fromEntries(Object.entries(calls).sort().map(([t, n]) => [t, via.length ? Number((n / via.length).toFixed(3)) : 0]));
  return {
    tree: build.tree,
    commit: build.commit,
    dirty: build.dirty,
    questions: via.length,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    model_calls_per_query: perQuery,
    failed_model_calls: via.reduce((s, r) => s + r.failed_model_calls, 0),
    crag_confidence: crag,
    expansion_outcomes: expansion,
  };
}
