/**
 * orchestrator/execute.ts — the real SkillExecutor: runs a recommended clinical
 * skill as a SUBAGENT JOB.
 *
 * We use the `jobs submit subagent` path (minion queue), NOT `gbrain agent run` —
 * per hackathon_planning/LOCAL-MODELS-SETUP.md §5, the subagent-job path is what
 * works against the local LM Studio stack. Job submit + poll is behind an injected
 * `JobRunner` so the executor logic is unit-testable; `makeQueueJobRunner` wires the
 * real queue (needs a live DB + a running `gbrain jobs work` worker + a chat model —
 * validate on the local stack, it can't be exercised in a plain unit test).
 *
 * AUTO-RUN BOUNDARY: nothing here runs on its own. `orchestrate_input` stays
 * suggest-only; execution happens only when a caller explicitly builds this executor
 * and hands it to `orchestrateLoop` (or via the local-only `orchestrate_run` op).
 * Decision support, not autonomous diagnosis.
 */

import type { BrainEngine } from '../engine.ts';
import type { SkillRole } from '../skill-frontmatter.ts';
import type {
  OrchestratorContext,
  SkillExecutor,
  SkillOutput,
  SkillRecommendation,
} from './types.ts';

/** A subagent invocation. */
export interface SubagentSpec {
  prompt: string;
  model?: string;
  maxTurns?: number;
}

/** Terminal result of a subagent run. */
export interface SubagentResult {
  status: 'completed' | 'failed';
  text: string;
  error?: string;
}

/** Submits a subagent job and resolves with its terminal result. Injected. */
export type JobRunner = (spec: SubagentSpec) => Promise<SubagentResult>;

export interface SubagentExecutorOpts {
  runner: JobRunner;
  /** Model for the subagent (e.g. a local `openrouter:qwen/...`). Default: config. */
  model?: string;
  maxTurns?: number;
  /** Override how a skill invocation is phrased to the subagent. */
  buildPrompt?: (rec: SkillRecommendation, ctx: OrchestratorContext) => string;
  /**
   * Load the role-priming brief for a care role, prepended to the prompt so each
   * agent runs its skill IN its professional scope. Injected + cached per role;
   * the real wiring is `(role) => loadRoleBrief(rolesDir, role)`. Returns '' ⇒
   * no brief (base prompt only). Omit in tests that don't exercise priming.
   */
  loadBrief?: (role: SkillRole) => string;
}

const DEFAULT_MAX_TURNS = 8;

function defaultPrompt(rec: SkillRecommendation, ctx: OrchestratorContext): string {
  const stateLine =
    ctx.input.state && Object.keys(ctx.input.state).length
      ? `Current state: ${JSON.stringify(ctx.input.state)}`
      : '';
  return [
    `Run the clinical skill "${rec.skill}" (role: ${rec.role}) for this patient input.`,
    `First call get_skill to load "${rec.skill}", then follow its steps.`,
    `Patient input: ${ctx.input.text}`,
    stateLine,
    "Produce the skill's decision-support output. This is decision support, not diagnosis.",
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a SkillExecutor that runs each recommendation as a subagent job via the
 * injected `runner`. A failed job becomes a recorded (non-throwing) SkillOutput so
 * the feedback loop keeps going and the failure is visible in the transcript.
 */
export function makeSubagentExecutor(opts: SubagentExecutorOpts): SkillExecutor {
  const build = opts.buildPrompt ?? defaultPrompt;
  // Cache briefs per role — the loader hits the filesystem; a loop can run the
  // same role many times.
  const briefCache = new Map<SkillRole, string>();
  const briefFor = (role: SkillRole): string => {
    if (!opts.loadBrief) return '';
    let b = briefCache.get(role);
    if (b === undefined) {
      b = opts.loadBrief(role);
      briefCache.set(role, b);
    }
    return b;
  };
  return async (rec, ctx): Promise<SkillOutput> => {
    const base = build(rec, ctx);
    const brief = briefFor(rec.role);
    const prompt = brief
      ? `You are acting in this role. Stay within its scope.\n\n${brief}\n\n---\n\n${base}`
      : base;
    const res = await opts.runner({
      prompt,
      model: opts.model,
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    });
    if (res.status !== 'completed') {
      return { skill: rec.skill, summary: `[execution failed: ${res.error ?? 'unknown error'}]` };
    }
    return { skill: rec.skill, summary: res.text };
  };
}

/** Pull the human-readable text out of a subagent job's `result` record. */
export function extractResultText(result: Record<string, unknown> | null): string {
  if (!result) return '';
  for (const k of ['text', 'output', 'summary', 'content', 'final', 'result']) {
    const v = result[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return JSON.stringify(result);
}

export interface QueueRunnerOpts {
  pollMs?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Real JobRunner over the minion queue. Submits a `subagent` job and polls until a
 * terminal status. Requires a live engine + a running `gbrain jobs work` worker +
 * a chat model; exercise it on the local stack, not in unit tests.
 */
export function makeQueueJobRunner(engine: BrainEngine, opts: QueueRunnerOpts = {}): JobRunner {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);

  return async (spec: SubagentSpec): Promise<SubagentResult> => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(engine);
    const data: Record<string, unknown> = { prompt: spec.prompt };
    if (spec.model) data.model = spec.model;
    if (spec.maxTurns) data.max_turns = spec.maxTurns;

    const job = await queue.add('subagent', data, { max_stalled: 3 }, { allowProtectedSubmit: true });

    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const cur = await queue.getJob(job.id);
      if (cur && TERMINAL.has(cur.status)) {
        if (cur.status === 'completed') {
          return { status: 'completed', text: extractResultText(cur.result) };
        }
        return { status: 'failed', text: '', error: cur.error_text ?? cur.status };
      }
      await sleep(pollMs);
    }
    return { status: 'failed', text: '', error: `timeout after ${timeoutMs}ms` };
  };
}
