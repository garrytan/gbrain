/**
 * `gbrain search|query --timings` (#7158): where one CLI call's time and
 * model-call money went. The op's stage timings (`SearchTimings`, the same
 * `_meta.retrieval.timings` MCP callers read) plus the CLI's own phases, and
 * the request's `cost` (search/search-cost.ts).
 *
 * `--json --timings` prints `{ results, timings_ms, cost }`; plain
 * `--json` keeps the bare result array (scripts written against it parse it
 * unchanged). Human output gets one stderr line. All times are integer
 * milliseconds on the process clock (`performance.now()` counts from process
 * start). A phase that did not run is absent; 0 means it ran in under 0.5 ms.
 * One op per CLI process, so module state is safe.
 */
import type { SearchTimingsMeta } from '../core/search/stage-timings.ts';
import type { SearchCostMeta } from '../core/search/search-cost.ts';
import { getCliOptions } from '../core/cli-options.ts';

type CliPhase = 'connect' | 'context' | 'remote';
const phases = new Map<CliPhase, number>();
let firstPhaseAt: number | null = null;

/** Time one CLI phase: `connect` (engine open), `context` (op context and source resolution), `remote` (a thin client's MCP round trip). */
export async function timeCliPhase<T>(phase: CliPhase, work: () => Promise<T>): Promise<T> {
  const at = performance.now();
  firstPhaseAt ??= at;
  try {
    return await work();
  } finally {
    phases.set(phase, (phases.get(phase) ?? 0) + performance.now() - at);
  }
}

export interface CliSearchTimings {
  /** Process start to this document. */
  total: number;
  /** Process start to the first phase: module load, config and argument parsing. */
  startup?: number;
  connect?: number;
  context?: number;
  remote?: number;
  /** The op handler; on a thin client this is the server's. */
  op?: number;
  /** The op's critical-path stages (`SearchTimings`); `other` is op time outside every stage. */
  stages?: Record<string, number>;
  /** Work that ran alongside the critical path (parallel lexical arms, the vector side before its join). */
  overlapped?: Record<string, number>;
  /** Sequential parts of a stage (`response`: evidence, trust, meta, keyword_count, feedback); the stage keeps its own total. */
  parts?: Partial<Record<string, Record<string, number>>>;
  /** CLI time in no phase: result normalization, notices, formatting. */
  cli_other: number;
}

export function cliSearchTimings(op: SearchTimingsMeta | undefined): CliSearchTimings {
  const total = performance.now();
  const ms = (v: number) => Math.round(v);
  const out: Partial<CliSearchTimings> = { total: ms(total) };
  if (firstPhaseAt !== null) out.startup = ms(firstPhaseAt);
  for (const [phase, spent] of phases) out[phase] = ms(spent);
  if (op) {
    out.op = op.total_ms;
    out.stages = { ...op.stages_ms, other: op.other_ms };
    if (op.overlapped_ms) out.overlapped = op.overlapped_ms;
    if (op.parts_ms) out.parts = op.parts_ms;
  }
  const accounted = (out.startup ?? 0) + [...phases.values()].reduce((sum, v) => sum + v, 0) + (out.remote === undefined ? op?.total_ms ?? 0 : 0);
  out.cli_other = Math.max(0, ms(total - accounted));
  return out as CliSearchTimings;
}

/** The search/query `--json` document: the bare rows, or `{ results, timings_ms, cost }` under `--timings`. */
export function searchTimingsDocument(results: unknown[], meta: Record<string, unknown> | null): unknown {
  if (!getCliOptions().timings) return results;
  return { results, timings_ms: cliSearchTimings(meta?.timings as SearchTimingsMeta | undefined), cost: (meta?.cost as SearchCostMeta | undefined) ?? { calls: 0 } };
}

/** The human `--timings` stderr line; empty without `--timings`. */
export function searchTimingsLine(meta: Record<string, unknown> | null): string {
  if (!getCliOptions().timings) return '';
  const t = cliSearchTimings(meta?.timings as SearchTimingsMeta | undefined);
  const parts = (['startup', 'connect', 'context', 'remote', 'op'] as const).flatMap(k => t[k] === undefined ? [] : [`${k} ${t[k]}`]);
  const stages = Object.entries(t.stages ?? {}).map(([k, v]) => `${k} ${v}`);
  const cost = (meta?.cost as SearchCostMeta | undefined) ?? { calls: 0 };
  const calls = (['embedding', 'rerank', 'expansion', 'chat', 'decide'] as const).flatMap(k => cost[k] ? [`${k} ${cost[k]!.calls} (${cost[k]!.input_tokens} tokens)`] : []);
  return `timings: ${t.total}ms total — ${[...parts, `cli_other ${t.cli_other}`].join(', ')}`
    + (stages.length ? ` | op stages: ${stages.join(', ')}` : '')
    + ` | cost: ${calls.length ? calls.join(', ') : 'no model calls'}${cost.estimated_usd !== undefined && cost.calls > 0 ? `, ~$${cost.estimated_usd}` : ''}\n`;
}

/** Test seam: forget the recorded phases. */
export function resetCliSearchTimingsForTests(): void {
  phases.clear();
  firstPhaseAt = null;
}
