/**
 * SkillOpt rollout: execute a skill against one benchmark task.
 *
 * Per D2: uses `gateway.toolLoop` directly with NO persistence callbacks.
 * SkillOpt rollouts are transient eval data — they don't pollute
 * `subagent_messages` / `subagent_tool_executions`.
 *
 * Per D13: tool registry is the read-only subset of BRAIN_TOOL_ALLOWLIST.
 * Excluded ops: `put_page`, `submit_job`, `file_upload` (the latter two
 * aren't in BRAIN_TOOL_ALLOWLIST anyway, but documenting for clarity).
 * The optimizer's loop can call `search`, `query`, `get_page`, etc., but
 * cannot WRITE to the user's brain.
 *
 * Each rollout returns a `Trajectory` capturing the final assistant text,
 * tool calls (with inputs + outputs), token usage, and stop reason. The
 * caller (orchestrator) feeds the trajectory to the judge for scoring.
 */

import { chat as gatewayChat, toolLoop, type ChatMessage, type ChatToolDef, type ToolHandler } from '../ai/gateway.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../minions/tools/brain-allowlist.ts';
import { paramDefToSchema } from '../../mcp/tool-defs.ts';
import { operations, type OperationContext } from '../operations.ts';
import { loadConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import type { BenchmarkTask, Trajectory } from './types.ts';

/**
 * D13: which tools SkillOpt rollouts are allowed to call.
 *
 * Derived from BRAIN_TOOL_ALLOWLIST minus `put_page` (only mutating op in
 * the base set). New mutating ops MUST be added here AND BRAIN_TOOL_ALLOWLIST
 * mustn't be silently widened; the rollout test pins zero-write invariant.
 */
export const READ_ONLY_BRAIN_TOOLS: ReadonlySet<string> = new Set(
  [...BRAIN_TOOL_ALLOWLIST].filter((name) => name !== 'put_page'),
);

export interface RolloutOpts {
  engine: BrainEngine;
  skillText: string;
  task: BenchmarkTask;
  /** Provider:model string for the target model. */
  targetModel: string;
  /** Max agent turns. Default 20. */
  maxTurns?: number;
  /** AbortSignal for cooperative cancellation (e.g. budget exhausted). */
  abortSignal?: AbortSignal;
  /** F10: when true, enable write-capture (virtual put_page/submit_job/file_upload). */
  writeCapture?: boolean;
  /** Test seam — substitute the toolLoop call. */
  toolLoopFn?: typeof toolLoop;
  /** Test seam — substitute chat (currently unused; toolLoop wraps chat). */
  chatFn?: typeof gatewayChat;
}

/**
 * Run one rollout. Returns a Trajectory; never throws on agent-side failures
 * (max_turns, refusal, aborted) — those land in `trajectory.stop_reason` so
 * the caller can score them appropriately.
 *
 * Throws ONLY on infrastructure errors (no engine, unknown target model) or
 * BudgetExhausted (which propagates via gateway → MUST_ABORT_ERROR_TAGS).
 */
export async function runRollout(opts: RolloutOpts): Promise<Trajectory> {
  const { engine, skillText, task, targetModel } = opts;
  const startedAt = Date.now();

  // Build the tool handlers + defs. F10: when write-capture is on, swap
  // in the virtual-write registry (read-only base + virtual put_page /
  // submit_job / file_upload). Default: read-only allowlist only (D13).
  const ctx = buildOpContext(engine);
  let defs, handlers;
  if (opts.writeCapture) {
    const { buildWriteCaptureRegistry } = await import('./write-capture.ts');
    const registry = buildWriteCaptureRegistry(engine);
    defs = registry.defs;
    handlers = registry.handlers;
  } else {
    const r = buildReadOnlyToolRegistry(ctx);
    defs = r.defs;
    handlers = r.handlers;
  }

  // The skill text becomes the system prompt (D11: cacheSystem=true so the
  // candidate skill is cached across all rollouts in a single batch).
  const system = skillText;
  const initialMessages: ChatMessage[] = [{ role: 'user', content: task.task }];

  const toolLoopImpl = opts.toolLoopFn ?? toolLoop;

  // Capture tool calls as they fire. The toolLoop's callbacks fire in
  // ordering: onToolCallStart -> handler.execute -> onToolCallComplete|Failed.
  // We capture outputs in a Map keyed by gbrainToolUseId so we can stitch
  // them into the trajectory's tool_calls array (preserving call order).
  const toolCalls: Trajectory['tool_calls'] = [];
  const callsById = new Map<string, number>(); // gbrainToolUseId -> index in toolCalls
  let nextOrdinal = 0;

  const result = await toolLoopImpl({
    model: targetModel,
    system,
    initialMessages,
    tools: defs,
    toolHandlers: handlers,
    maxTurns: opts.maxTurns ?? 20,
    cacheSystem: true, // D11: candidate skill is stable for a step's batch.
    abortSignal: opts.abortSignal,
    onToolCallStart: async (_turnIdx, _messageIdx, _ordinal, toolName, input, providerToolCallId) => {
      const gbrainToolUseId = `skillopt-${nextOrdinal++}-${providerToolCallId}`;
      const idx = toolCalls.length;
      callsById.set(gbrainToolUseId, idx);
      toolCalls.push({ name: stripBrainPrefix(toolName), input });
      return { gbrainToolUseId };
    },
    onToolCallComplete: async (gbrainToolUseId, output) => {
      const idx = callsById.get(gbrainToolUseId);
      if (idx !== undefined && toolCalls[idx]) {
        toolCalls[idx]!.output = output;
      }
    },
    onToolCallFailed: async (gbrainToolUseId, error) => {
      const idx = callsById.get(gbrainToolUseId);
      if (idx !== undefined && toolCalls[idx]) {
        toolCalls[idx]!.failed = true;
        toolCalls[idx]!.output = { error };
      }
    },
  });

  // Final assistant text: concatenate text blocks from the last assistant message.
  const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
  let finalText = '';
  if (lastAssistant && typeof lastAssistant.content === 'string') {
    finalText = lastAssistant.content;
  } else if (lastAssistant && Array.isArray(lastAssistant.content)) {
    finalText = lastAssistant.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n')
      .trim();
  }

  return {
    task_id: task.task_id,
    task: task.task,
    final_text: finalText,
    tool_calls: toolCalls,
    usage: result.totalUsage,
    turns: result.totalTurns,
    stop_reason: result.stopReason,
    duration_ms: Date.now() - startedAt,
  };
}

// ─── Tool registry construction ──────────────────────────────────────────

function buildOpContext(engine: BrainEngine): OperationContext {
  const cfg = loadConfig();
  return {
    engine,
    config: cfg ?? ({} as never),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    dryRun: false,
    // SkillOpt rollouts ARE remote-equivalent (the optimizer chose what to call,
    // not the user) → set remote: true. Per-op trust gates that check `remote`
    // see this and apply remote-tightening rules. Read-only ops aren't affected.
    remote: true,
    // v0.34 D4: sourceId is required on OperationContext. SkillOpt rollouts
    // operate on the default source — the agent under test reads the brain
    // it would normally read.
    sourceId: 'default',
  };
}

interface ToolRegistry {
  defs: ChatToolDef[];
  handlers: Map<string, ToolHandler>;
}

/**
 * Build the read-only tool registry that SkillOpt rollouts call into.
 *
 * Tool names are prefixed `brain_` for Anthropic-name compliance (same
 * convention as the subagent handler's buildBrainTools).
 */
function buildReadOnlyToolRegistry(ctx: OperationContext): ToolRegistry {
  const defs: ChatToolDef[] = [];
  const handlers = new Map<string, ToolHandler>();
  for (const op of operations) {
    if (!READ_ONLY_BRAIN_TOOLS.has(op.name)) continue;
    const toolName = `brain_${op.name}`;
    defs.push({
      name: toolName,
      description: op.description,
      inputSchema: paramsToSchema(op.params),
    });
    handlers.set(toolName, {
      idempotent: true, // All read-only ops are idempotent by construction.
      execute: async (input: unknown) => {
        return op.handler(ctx, (input as Record<string, unknown>) ?? {});
      },
    });
  }
  return { defs, handlers };
}

function stripBrainPrefix(toolName: string): string {
  return toolName.startsWith('brain_') ? toolName.slice('brain_'.length) : toolName;
}

/**
 * Build a valid JSON Schema for a tool's params via the shared `paramDefToSchema`
 * (the single source of truth, also used by the stdio MCP + subagent registries).
 * The prior inline mapper dropped `items` on array params, producing an invalid
 * `{type:'array'}` that AI SDK v6's tool-schema validation rejects — every real
 * rollout crashed before this. Recursive on items/enum/default per param.
 */
function paramsToSchema(params: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, paramDefToSchema(v as never)]),
    ),
    required: Object.entries(params)
      .filter(([, v]) => (v as { required?: boolean }).required === true)
      .map(([k]) => k),
  };
}
