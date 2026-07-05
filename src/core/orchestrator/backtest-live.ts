/**
 * orchestrator/backtest-live.ts — wires the temporal backtest (backtest.ts) to the
 * real orchestrator, real skills, and the real patient timeline (Life Chronicle).
 *
 * Kept OUT of backtest.ts so that file stays DB/LLM-free and unit-testable. Two
 * exports:
 *   - `makeOrchestratorPredictor(ctx, opts)` → a `PredictNextStep` that, for each
 *     history slice, runs the orchestrator over ONLY the sliced history and returns
 *     the estimated next step. Crucially it feeds the slice history directly and
 *     does NOT call live retrieval — otherwise the backtest would leak future data
 *     the model isn't supposed to see yet.
 *   - `loadPatientTimeline(ctx, patientId, opts)` → pulls the patient's chronological
 *     events from the chronicle (`engine.getSince`) into a `PatientTimeline`.
 *
 * Execution posture: suggest-only by default (rank skills → estimate from the
 * rationale). With `execute: true` it runs the recommended skills as subagent jobs
 * (needs a worker + chat model) and folds their output into the estimate — the same
 * auto-run boundary as `orchestrate_run`.
 */

import type { OperationContext } from '../operations.ts';
import { chat } from '../ai/gateway.ts';
import { runOrchestrator, type OrchestratorDeps } from './run.ts';
import { orchestrateLoop } from './loop.ts';
import { makeLiveDeps } from './deps-live.ts';
import { selectSkillsLLM } from './select-llm.ts';
import { makeSubagentExecutor, makeQueueJobRunner } from './execute.ts';
import type {
  HistoryItem,
  OrchestratorContext,
  OrchestratorReport,
  SkillRecommendation,
} from './types.ts';
import type {
  NextStepPrediction,
  PatientTimeline,
  PredictNextStep,
  Slice,
  TimelineEvent,
} from './backtest.ts';

export interface PredictorOpts {
  /** false → deterministic v0 selector; true (default) → LLM selector. */
  useLlm?: boolean;
  /** true → actually run the recommended skills as subagent jobs (needs worker). */
  execute?: boolean;
  /** Model for the LLM selector / subagent (e.g. a local `openrouter:qwen/...`). */
  model?: string;
  /** Backstop rounds for the feedback loop when executing (default 2). */
  maxRounds?: number;
}

/**
 * Build the predicted-next-step free text from a routing report: the model's
 * per-skill rationale is where the clinical terms live (the skill NAME is just a
 * routing label). Prefixing with the role keeps it readable in the transcript.
 */
function synthesizeFromReport(report: OrchestratorReport): string {
  if (report.recommendations.length === 0) {
    return report.notes.join(' ') || 'no clinical skill recommended';
  }
  return report.recommendations
    .map((r: SkillRecommendation) => `${r.role}/${r.skill}: ${r.reason}`)
    .join('\n');
}

/** Map a slice's history events into the orchestrator's HistoryItem shape. */
function historyItems(events: TimelineEvent[]): HistoryItem[] {
  return events.map((e, i) => ({ id: e.id ?? String(i), snippet: e.text, score: undefined }));
}

/**
 * A PredictNextStep backed by the real orchestrator. For each slice it uses the
 * LAST history event as the "current input" and the earlier events as retrieved
 * history — then ranks skills (and optionally executes them) and returns the
 * estimated next step.
 */
export function makeOrchestratorPredictor(
  ctx: OperationContext,
  opts: PredictorOpts = {},
): PredictNextStep {
  const useLlm = opts.useLlm !== false;
  // Reuse the live catalog loader + gate; we only replace retrieveHistory so the
  // model sees the SLICE history, never the live DB (no lookahead leak).
  const base = makeLiveDeps(ctx, { useLlm });

  return async (slice: Slice, _timeline: PatientTimeline): Promise<NextStepPrediction> => {
    const history = slice.history;
    const current = history[history.length - 1];
    const priorHistory = history.slice(0, -1);

    const octx: OrchestratorContext = {
      input: { text: current.text },
      history: historyItems(priorHistory),
      now: new Date(),
      remote: false, // backtest is a trusted local eval
    };

    // Deps: real skills + gate, sliced history (NOT live retrieval), LLM/v0 selector.
    const deps: OrchestratorDeps = {
      loadCandidateSkills: base.loadCandidateSkills,
      retrieveHistory: async () => historyItems(priorHistory),
      select: useLlm ? (c, cust) => selectSkillsLLM(c, cust, chat) : undefined,
    };

    if (!opts.execute) {
      const report = await runOrchestrator(octx, deps);
      return {
        text: synthesizeFromReport(report),
        recommendations: report.recommendations,
        raw: report,
      };
    }

    // Execute mode: run the loop with a real subagent executor and fold the skills'
    // own output into the estimate (richer, but needs a worker + chat model).
    const executor = makeSubagentExecutor({
      runner: makeQueueJobRunner(ctx.engine),
      model: opts.model,
    });
    const loop = await orchestrateLoop(octx, deps, { executor, maxRounds: opts.maxRounds ?? 2 });
    const rationale = synthesizeFromReport(loop.finalReport);
    const outputs = loop.priorSkillOutputs.map((o) => `${o.skill}: ${o.summary}`).join('\n');
    return {
      text: [rationale, outputs].filter(Boolean).join('\n'),
      recommendations: loop.finalReport.recommendations,
      raw: loop,
    };
  };
}

export interface LoadTimelineOpts {
  /** Max events to pull (default 500). */
  limit?: number;
  /** Only events of this chronicle kind (optional). */
  kind?: string;
  /** Earliest date to include (ISO YYYY-MM-DD). Default: all of history. */
  since?: string;
}

/**
 * Load a patient's chronological timeline from the Life Chronicle
 * (`timeline_entries` via `engine.getSince`), scoped to the patient's source id.
 * Requires the chronicle to be populated for that source; if it isn't, the caller
 * gets an empty timeline (and the backtest reports 0 cuts) rather than a crash.
 */
export async function loadPatientTimeline(
  ctx: OperationContext,
  patientId: string,
  opts: LoadTimelineOpts = {},
): Promise<PatientTimeline> {
  const engine = ctx.engine as unknown as {
    getSince?: (
      date: string,
      o?: { limit?: number; kind?: string; sourceId?: string },
    ) => Promise<
      Array<{
        date: string;
        effective_date?: string | null;
        summary: string;
        detail?: string;
        kind?: string | null;
        page_id?: number;
        event_slug?: string | null;
      }>
    >;
  };
  if (typeof engine.getSince !== 'function') {
    throw new Error('loadPatientTimeline: engine.getSince is unavailable — chronicle timeline required.');
  }

  const rows = await engine.getSince(opts.since ?? '1900-01-01', {
    limit: opts.limit ?? 500,
    ...(opts.kind ? { kind: opts.kind } : {}),
    sourceId: patientId,
  });

  const events: TimelineEvent[] = rows.map((r) => ({
    at: r.effective_date || r.date,
    text: [r.summary, r.detail].filter(Boolean).join(' — '),
    kind: r.kind ?? undefined,
    id: r.event_slug ?? (r.page_id != null ? String(r.page_id) : undefined),
  }));

  return { patientId, events, label: patientId };
}
