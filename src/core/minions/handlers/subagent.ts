/**
 * Subagent LLM-loop handler (v0.15).
 *
 * Runs one Anthropic Messages API conversation with tool use. The loop is
 * crash-resumable: subagent_messages + subagent_tool_executions together
 * are the single source of truth about where the conversation is. On
 * resume after a worker kill, we load all committed rows, trust any tool
 * execution marked 'complete' or 'failed', and re-run 'pending' ones only
 * for idempotent tools.
 *
 * Safety rails:
 *   - rate leases around every LLM call (acquire → call → release). Mid-
 *     call renewal with backoff. Persistent renewal failure aborts as a
 *     renewable error so the worker re-claims.
 *   - dual-signal abort wiring (ctx.signal + ctx.shutdownSignal) drains
 *     the in-flight call and commits whatever turns are already persisted.
 *   - Anthropic prompt cache markers on system + tools blocks.
 *   - token rollup via ctx.updateTokens per turn.
 *
 * NOT in v0.15: refusal detection, stop_reason=max_tokens partial
 * recovery, parallel tool-use dispatch (runs tools sequentially; the
 * Messages API allows parallel tool_use blocks and the replay tolerates
 * them, but v1 dispatches serially for simplicity). All three are tracked
 * as P2 items in the plan file.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { MinionJobContext, MinionJob } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type {
  ContentBlock,
  SubagentHandlerData,
  SubagentResult,
  SubagentStopReason,
  ToolDef,
} from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { loadConfig } from '../../config.ts';
import { buildBrainTools, filterAllowedTools } from '../tools/brain-allowlist.ts';
import {
  acquireLease,
  releaseLease,
  renewLeaseWithBackoff,
} from '../rate-leases.ts';
import {
  logSubagentSubmission,
  logSubagentHeartbeat,
} from './subagent-audit.ts';
import { resolveModel, supportsSubagentLoopProvider, TIER_DEFAULTS } from '../../model-config.ts';
import {
  chat as gatewayChat,
  type ChatBlock,
  type ChatMessage,
  type ChatOpts,
  type ChatResult,
  type ChatToolDef,
} from '../../ai/gateway.ts';

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RATE_KEY = 'anthropic:messages';
const DEFAULT_MAX_CONCURRENT = Number(process.env.GBRAIN_ANTHROPIC_MAX_INFLIGHT ?? '8');
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_SYSTEM = 'You are a helpful assistant running as a gbrain subagent.';

// ── Injectable surfaces (for tests) ─────────────────────────

/**
 * Anthropic Messages client. The real Anthropic SDK implements this
 * structurally; tests can substitute a mock without the SDK import.
 */
export interface MessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export type SubagentChatTransport = (opts: ChatOpts) => Promise<ChatResult>;

export interface SubagentDeps {
  /** Engine for DB-backed ops (tools + message persistence + rate leases). */
  engine: BrainEngine;
  /** Provider-neutral chat transport. Defaults to gateway.chat(). */
  chat?: SubagentChatTransport;
  /** Anthropic-shaped test compatibility client. Production defaults do not construct this. */
  client?: MessagesClient;
  /**
   * Anthropic SDK constructor. Defaults to `() => new Anthropic()`.
   * Overridable in tests so the factory default-client branch is
   * exercisable without an ANTHROPIC_API_KEY or a real API call.
   * When `deps.client` is provided, this is unused.
   */
  makeAnthropic?: () => Anthropic;
  /** Config (MCP, brain, etc.). Defaults to loadConfig(). */
  config?: GBrainConfig;
  /** Rate-lease key. Defaults to a provider-aware key derived from the resolved model. */
  rateLeaseKey?: string;
  /** Max concurrent inflight calls on that key. Defaults to GBRAIN_ANTHROPIC_MAX_INFLIGHT or 8. */
  maxConcurrent?: number;
  /** Lease TTL. Defaults to 120s. */
  leaseTtlMs?: number;
  /**
   * Override tool registry. When omitted, buildBrainTools is called with
   * the caller's subagentId at dispatch time.
   */
  toolRegistry?: ToolDef[];
}

// ── Types for internal state ────────────────────────────────

interface PersistedMessage {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

interface PersistedToolExec {
  message_idx: number;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

// ── Public handler factory ──────────────────────────────────

/**
 * Build a subagent handler bound to a specific engine. `registerBuiltin
 * Handlers` wires this up as `worker.register('subagent', handler)` at
 * worker startup. Always registered — provider auth is resolved by
 * gateway.chat() and `PROTECTED_JOB_NAMES` gates submission.
 */
export function makeSubagentHandler(deps: SubagentDeps) {
  const engine = deps.engine;
  const chatTransport: SubagentChatTransport = deps.chat
    ?? (deps.client
      ? anthropicClientToChatTransport(deps.client)
      : deps.makeAnthropic
      ? anthropicClientToChatTransport(deps.makeAnthropic().messages)
      : gatewayChat);
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as GBrainConfig);
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return async function subagentHandler(ctx: MinionJobContext): Promise<SubagentResult> {
    const data = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('subagent job data.prompt is required (string)');
    }

    if (data.model && !supportsSubagentLoopProvider(data.model)) {
      throw new Error(
        `subagent job rejected: data.model "${data.model}" does not support the subagent tool loop. ` +
        `Pass a supported chat model (e.g. openai-codex:gpt-5.5 or anthropic:claude-sonnet-4-6) or omit data.model to use the configured default.`,
      );
    }
    const model = data.model
      ?? await resolveModel(engine, {
        tier: 'subagent',
        configKey: 'models.subagent',
        fallback: TIER_DEFAULTS.subagent,
      });
    const rateLeaseKey = deps.rateLeaseKey ?? rateLeaseKeyForModel(model);
    const maxTurns = data.max_turns ?? DEFAULT_MAX_TURNS;
    const systemPrompt = data.system ?? DEFAULT_SYSTEM;

    // Build the tool registry bound to THIS job as the owning subagent.
    // brain_id (per-call brain override; children inherit parent's unless
    // they set their own) and allowed_slug_prefixes (v0.23 trusted-workspace
    // allow-list — flows through buildBrainTools → the put_page schema
    // description AND the OperationContext, so the model's tool schema and
    // the server-side check stay in sync).
    const registry = deps.toolRegistry ?? buildBrainTools({
      subagentId: ctx.id,
      engine,
      config,
      brainId: data.brain_id,
      allowedSlugPrefixes: data.allowed_slug_prefixes,
    });
    const toolDefs = data.allowed_tools && data.allowed_tools.length > 0
      ? filterAllowedTools(registry, data.allowed_tools)
      : registry;

    logSubagentSubmission({
      caller: 'worker',
      remote: true,
      job_id: ctx.id,
      model,
      tools_count: toolDefs.length,
      allowed_tools: toolDefs.map(t => t.name),
    });

    // ── Load prior state (replay) ───────────────────────────
    const priorMessages = await loadPriorMessages(engine, ctx.id);
    const priorTools = await loadPriorTools(engine, ctx.id);
    const priorToolByUseId = new Map(priorTools.map(t => [t.tool_use_id, t]));

    // Rebuild provider-neutral chat messages from persisted rows. The
    // conversion accepts both legacy Anthropic block names and new gateway
    // block names so crash replay survives upgrades.
    const chatMessages: ChatMessage[] = priorMessages.length > 0
      ? priorMessages.map(persistedToChatMessage)
      : [{ role: 'user', content: data.prompt }];

    // If we had no prior messages, persist the seed user message.
    let nextMessageIdx = priorMessages.length;
    if (priorMessages.length === 0) {
      await persistMessage(engine, ctx.id, {
        message_idx: 0,
        role: 'user',
        content_blocks: [{ type: 'text', text: data.prompt }],
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      });
      nextMessageIdx = 1;
    }

    // Token rollup.
    const tokenTotals = { in: 0, out: 0, cache_read: 0, cache_create: 0 };
    for (const m of priorMessages) {
      if (m.tokens_in) tokenTotals.in += m.tokens_in;
      if (m.tokens_out) tokenTotals.out += m.tokens_out;
      if (m.tokens_cache_read) tokenTotals.cache_read += m.tokens_cache_read;
      if (m.tokens_cache_create) tokenTotals.cache_create += m.tokens_cache_create;
    }

    // Count assistant messages already persisted toward max_turns.
    let assistantTurns = priorMessages.filter(m => m.role === 'assistant').length;

    // ── Replay reconciliation ───────────────────────────────
    //
    // If the last persisted message is an assistant with tool_use blocks
    // AND no subsequent user message has been synthesized yet, we crashed
    // mid-tool-dispatch. Finish those tools now so the next LLM call sees
    // a consistent conversation.
    const last = priorMessages[priorMessages.length - 1];
    if (last && last.role === 'assistant') {
      const pendingToolUses = toolUsesFromContentBlocks(last.content_blocks);
      if (pendingToolUses.length > 0) {
        const synthesizedResults: ContentBlock[] = [];
        for (const use of pendingToolUses) {
          const prior = priorToolByUseId.get(use.id);
          if (prior?.status === 'complete') {
            synthesizedResults.push({
              type: 'tool-result',
              toolCallId: use.id,
              toolName: use.name,
              output: asStringIfNotObject(prior.output),
            } as ContentBlock);
            continue;
          }
          if (prior?.status === 'failed') {
            synthesizedResults.push({
              type: 'tool-result',
              toolCallId: use.id,
              toolName: use.name,
              output: prior.error ?? 'tool failed',
              isError: true,
            } as ContentBlock);
            continue;
          }
          // pending or no row yet — try to dispatch.
          const toolDef = toolDefs.find(t => t.name === use.name);
          if (!toolDef) {
            await persistToolExecFailed(
              engine, ctx.id, last.message_idx, use.id, use.name, use.input,
              `tool "${use.name}" is not in the registry for this subagent`,
            );
            synthesizedResults.push({
              type: 'tool-result', toolCallId: use.id, toolName: use.name,
              output: `tool "${use.name}" is not available`, isError: true,
            } as ContentBlock);
            continue;
          }
          if (prior?.status === 'pending' && !toolDef.idempotent) {
            throw new Error(`non-idempotent tool "${use.name}" pending on resume; cannot safely re-run`);
          }
          await persistToolExecPending(engine, ctx.id, last.message_idx, use.id, use.name, use.input);
          try {
            const output = await toolDef.execute(use.input, {
              engine, jobId: ctx.id, remote: true, signal: ctx.signal,
            });
            await persistToolExecComplete(engine, ctx.id, use.id, output);
            synthesizedResults.push({
              type: 'tool-result', toolCallId: use.id, toolName: use.name,
              output: asStringIfNotObject(output),
            } as ContentBlock);
          } catch (e) {
            const errText = e instanceof Error ? (e.stack ?? e.message) : String(e);
            await persistToolExecFailed(engine, ctx.id, last.message_idx, use.id, use.name, use.input, errText);
            synthesizedResults.push({
              type: 'tool-result', toolCallId: use.id, toolName: use.name,
              output: errText, isError: true,
            } as ContentBlock);
          }
        }
        // Persist the synthesized user turn so next-resume picks up here.
        const userIdx = nextMessageIdx++;
        await persistMessage(engine, ctx.id, {
          message_idx: userIdx,
          role: 'user',
          content_blocks: synthesizedResults,
          tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null,
        });
        chatMessages.push(persistedToChatMessage({
          message_idx: userIdx,
          role: 'user',
          content_blocks: synthesizedResults,
          tokens_in: null,
          tokens_out: null,
          tokens_cache_read: null,
          tokens_cache_create: null,
          model: null,
        }));
      }
    }

    // ── Main loop ───────────────────────────────────────────
    let stopReason: SubagentStopReason = 'error';
    let finalText = '';

    while (true) {
      if (assistantTurns >= maxTurns) {
        stopReason = 'max_turns';
        break;
      }
      if (ctx.signal.aborted || ctx.shutdownSignal.aborted) {
        stopReason = 'error';
        throw new Error('subagent aborted before turn');
      }

      // 1. Acquire rate lease for the outbound call.
      const lease = await acquireLease(engine, rateLeaseKey, ctx.id, maxConcurrent, { ttlMs: leaseTtlMs });
      if (!lease.acquired) {
        // No slots — treat as a renewable error so the worker re-claims
        // the job later. Don't fail terminally.
        throw new RateLeaseUnavailableError(rateLeaseKey, lease.activeCount, lease.maxConcurrent);
      }

      let assistantMsg: ChatResult;
      const turnIdx = assistantTurns;
      const t0 = Date.now();
      logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: turnIdx });

      // Renewal is short-lived; for single-call turns the initial TTL
      // covers the whole request. A mid-call renewal loop would add
      // complexity; for v0.15 we lean on the 120s TTL + abort-on-signal.
      try {
        const params: ChatOpts = {
          model,
          maxTokens: 4096,
          system: systemPrompt,
          messages: chatMessages,
          tools: toolDefs.length > 0 ? toolDefs.map(toolDefToChatToolDef) : undefined,
          cacheSystem: true,
        };

        const combinedSignal = mergeSignals(ctx.signal, ctx.shutdownSignal);
        assistantMsg = await chatTransport({ ...params, abortSignal: combinedSignal });
      } catch (err) {
        // Release lease eagerly on error so we don't starve capacity.
        await releaseLease(engine, lease.leaseId!).catch(() => {});
        // Terminal classification: a 400 "prompt is too long" from Anthropic
        // is unrecoverable — retrying with the same prompt will always fail.
        // Convert to UnrecoverableError so the worker routes the job
        // straight to `dead`, bypassing max_stalled retries (the v0.30.x
        // dream-cycle queue-clog the chunking work was built to prevent).
        if (isPromptTooLongError(err)) {
          const origMsg = err instanceof Error ? err.message : String(err);
          throw new UnrecoverableError(`prompt_too_long: ${origMsg}`);
        }
        throw err;
      }

      // 2. Release lease as soon as the call returns. Tool execution runs
      //    outside the lease — tool calls use their own capacity.
      await releaseLease(engine, lease.leaseId!).catch(() => {});

      const ms = Date.now() - t0;
      const inTokens = assistantMsg.usage.input_tokens;
      const outTokens = assistantMsg.usage.output_tokens;
      const cacheRead = assistantMsg.usage.cache_read_tokens;
      const cacheCreate = assistantMsg.usage.cache_creation_tokens;

      tokenTotals.in += inTokens;
      tokenTotals.out += outTokens;
      tokenTotals.cache_read += cacheRead;
      tokenTotals.cache_create += cacheCreate;

      logSubagentHeartbeat({
        job_id: ctx.id,
        event: 'llm_call_completed',
        turn_idx: turnIdx,
        ms_elapsed: ms,
        tokens: { in: inTokens, out: outTokens, cache_read: cacheRead, cache_create: cacheCreate },
      });

      // Update job-level token rollup (best-effort; may throw if lock lost).
      await ctx.updateTokens({
        input: inTokens,
        output: outTokens,
        cache_read: cacheRead,
      });

      const blocks = chatBlocksToContentBlocks(assistantMsg.blocks);

      // 3. Persist the assistant message BEFORE tool dispatch so replay
      //    sees a consistent state.
      const assistantIdx = nextMessageIdx++;
      await persistMessage(engine, ctx.id, {
        message_idx: assistantIdx,
        role: 'assistant',
        content_blocks: blocks,
        tokens_in: inTokens,
        tokens_out: outTokens,
        tokens_cache_read: cacheRead,
        tokens_cache_create: cacheCreate,
        model: assistantMsg.model || model,
      });
      chatMessages.push({ role: 'assistant', content: assistantMsg.blocks });
      assistantTurns++;

      // 4. Collect tool_use blocks. If none, we're done.
      const toolUses = toolUsesFromContentBlocks(blocks);
      if (toolUses.length === 0) {
        stopReason = 'end_turn';
        // Concatenate text blocks as the final answer.
        finalText = blocks
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n');
        break;
      }

      // 5. Dispatch each tool_use. Two-phase persist (pending → complete/failed).
      const toolResults: ContentBlock[] = [];
      for (const use of toolUses) {
        if (ctx.signal.aborted || ctx.shutdownSignal.aborted) {
          throw new Error('subagent aborted during tool dispatch');
        }

        const toolName = use.name;
        const toolDef = toolDefs.find(t => t.name === toolName);
        if (!toolDef) {
          // Model called a tool we didn't expose. Mark execution failed
          // with a clear error and feed the error back in the next turn.
          await persistToolExecFailed(
            engine, ctx.id, assistantIdx, use.id, toolName, use.input,
            `tool "${toolName}" is not in the registry for this subagent`,
          );
          toolResults.push({
            type: 'tool-result',
            toolCallId: use.id,
            toolName,
            output: `tool "${toolName}" is not available`,
            isError: true,
          } as ContentBlock);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_failed',
            turn_idx: turnIdx,
            tool_name: toolName,
            error: 'not in registry',
          });
          continue;
        }

        // Replay: if we already have a row for this tool_use_id, trust it
        // unless status='pending' and the tool is idempotent (re-run).
        const prior = priorToolByUseId.get(use.id);
        if (prior && prior.status === 'complete') {
          toolResults.push({
            type: 'tool-result',
            toolCallId: use.id,
            toolName,
            output: asStringIfNotObject(prior.output),
          } as ContentBlock);
          continue;
        }
        if (prior && prior.status === 'failed') {
          toolResults.push({
            type: 'tool-result',
            toolCallId: use.id,
            toolName,
            output: prior.error ?? 'tool failed',
            isError: true,
          } as ContentBlock);
          continue;
        }
        if (prior && prior.status === 'pending' && !toolDef.idempotent) {
          // Non-idempotent and we don't know the outcome — fail the job.
          throw new Error(`non-idempotent tool "${toolName}" pending on resume; cannot safely re-run`);
        }

        // Fresh or idempotent-replay dispatch.
        await persistToolExecPending(engine, ctx.id, assistantIdx, use.id, toolName, use.input);
        logSubagentHeartbeat({ job_id: ctx.id, event: 'tool_called', turn_idx: turnIdx, tool_name: toolName });

        const toolStart = Date.now();
        try {
          const output = await toolDef.execute(use.input, {
            engine,
            jobId: ctx.id,
            remote: true,
            signal: ctx.signal,
          });
          await persistToolExecComplete(engine, ctx.id, use.id, output);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_result',
            turn_idx: turnIdx,
            tool_name: toolName,
            ms_elapsed: Date.now() - toolStart,
          });
          toolResults.push({
            type: 'tool-result',
            toolCallId: use.id,
            toolName,
            output: asStringIfNotObject(output),
          } as ContentBlock);
        } catch (e) {
          const errText = e instanceof Error
            ? (e.stack ?? e.message)
            : String(e);
          await persistToolExecFailed(engine, ctx.id, assistantIdx, use.id, toolName, use.input, errText);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_failed',
            turn_idx: turnIdx,
            tool_name: toolName,
            ms_elapsed: Date.now() - toolStart,
            error: errText,
          });
          toolResults.push({
            type: 'tool-result',
            toolCallId: use.id,
            toolName,
            output: errText,
            isError: true,
          } as ContentBlock);
        }
      }

      // 6. Append the synthesized user turn (tool_result wrappers) to the
      //    conversation and persist it so replay picks it up.
      const userIdx = nextMessageIdx++;
      await persistMessage(engine, ctx.id, {
        message_idx: userIdx,
        role: 'user',
        content_blocks: toolResults,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      });
      chatMessages.push(persistedToChatMessage({
        message_idx: userIdx,
        role: 'user',
        content_blocks: toolResults,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      }));
    }

    return {
      result: finalText,
      turns_count: assistantTurns,
      stop_reason: stopReason,
      tokens: tokenTotals,
    };
  };
}

// ── Internal: persistence ───────────────────────────────────

async function loadPriorMessages(engine: BrainEngine, jobId: number): Promise<PersistedMessage[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model
       FROM subagent_messages
      WHERE job_id = $1
      ORDER BY message_idx ASC`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    role: r.role as 'user' | 'assistant',
    content_blocks: (typeof r.content_blocks === 'string'
      ? JSON.parse(r.content_blocks as string)
      : r.content_blocks) as ContentBlock[],
    tokens_in: (r.tokens_in as number) ?? null,
    tokens_out: (r.tokens_out as number) ?? null,
    tokens_cache_read: (r.tokens_cache_read as number) ?? null,
    tokens_cache_create: (r.tokens_cache_create as number) ?? null,
    model: (r.model as string) ?? null,
  }));
}

async function loadPriorTools(engine: BrainEngine, jobId: number): Promise<PersistedToolExec[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, input, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    tool_use_id: r.tool_use_id as string,
    tool_name: r.tool_name as string,
    input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input,
    status: r.status as 'pending' | 'complete' | 'failed',
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output) : r.output),
    error: (r.error as string) ?? null,
  }));
}

async function persistMessage(engine: BrainEngine, jobId: number, msg: PersistedMessage): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     ON CONFLICT (job_id, message_idx) DO NOTHING`,
    [
      jobId,
      msg.message_idx,
      msg.role,
      JSON.stringify(msg.content_blocks),
      msg.tokens_in,
      msg.tokens_out,
      msg.tokens_cache_read,
      msg.tokens_cache_create,
      msg.model,
    ],
  );
}

async function persistToolExecPending(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  // Serialize to JSON string for the ::jsonb cast. When `input` is already a
  // string (e.g. pre-serialized), avoid double-encoding which produces a jsonb
  // scalar string instead of a jsonb object — breaking `input->>'key'` lookups.
  const jsonStr = typeof input === 'string' ? input : JSON.stringify(input);
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
     ON CONFLICT (job_id, tool_use_id) DO NOTHING`,
    [jobId, messageIdx, toolUseId, toolName, jsonStr],
  );
}

async function persistToolExecComplete(
  engine: BrainEngine,
  jobId: number,
  toolUseId: string,
  output: unknown,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE subagent_tool_executions
        SET status = 'complete', output = $3::jsonb, ended_at = now()
      WHERE job_id = $1 AND tool_use_id = $2`,
    [jobId, toolUseId, typeof output === 'string' ? output : JSON.stringify(output)],
  );
}

async function persistToolExecFailed(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  error: string,
): Promise<void> {
  // INSERT-or-UPDATE to failed — covers both "no pending row yet" (tool
  // rejected upfront) and "pending row exists" (tool threw mid-execute).
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, error, ended_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'failed', $6, now())
     ON CONFLICT (job_id, tool_use_id) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, ended_at = now()`,
    [jobId, messageIdx, toolUseId, toolName, typeof input === 'string' ? input : JSON.stringify(input), error],
  );
}

// ── Internal: helpers ───────────────────────────────────────

interface NormalizedToolUse {
  id: string;
  name: string;
  input: unknown;
}

function providerPrefix(model: string): string {
  const trimmed = model.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) return trimmed.slice(0, colon).toLowerCase();
  if (trimmed.toLowerCase().startsWith('claude-')) return 'anthropic';
  return 'unknown';
}

function rateLeaseKeyForModel(model: string): string {
  const provider = providerPrefix(model);
  if (provider === 'anthropic') return DEFAULT_RATE_KEY;
  if (provider === 'openai-codex') return 'openai-codex:responses';
  return `${provider}:chat`;
}

function toolDefToChatToolDef(t: ToolDef): ChatToolDef {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  };
}

function contentBlockToChatBlock(block: ContentBlock): ChatBlock | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool-call') {
    const b = block as ContentBlock & { toolCallId?: unknown; toolName?: unknown; input?: unknown };
    if (typeof b.toolCallId === 'string' && typeof b.toolName === 'string') {
      return { type: 'tool-call', toolCallId: b.toolCallId, toolName: b.toolName, input: b.input };
    }
  }
  if (block.type === 'tool_use') {
    const b = block as ContentBlock & { id?: unknown; name?: unknown; input?: unknown };
    if (typeof b.id === 'string' && typeof b.name === 'string') {
      return { type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input };
    }
  }
  if (block.type === 'tool-result') {
    const b = block as ContentBlock & {
      toolCallId?: unknown;
      toolName?: unknown;
      output?: unknown;
      isError?: unknown;
    };
    if (typeof b.toolCallId === 'string') {
      return {
        type: 'tool-result',
        toolCallId: b.toolCallId,
        toolName: typeof b.toolName === 'string' ? b.toolName : '',
        output: b.output,
        isError: b.isError === true,
      };
    }
  }
  if (block.type === 'tool_result') {
    const b = block as ContentBlock & {
      tool_use_id?: unknown;
      name?: unknown;
      content?: unknown;
      is_error?: unknown;
    };
    if (typeof b.tool_use_id === 'string') {
      return {
        type: 'tool-result',
        toolCallId: b.tool_use_id,
        toolName: typeof b.name === 'string' ? b.name : '',
        output: b.content,
        isError: b.is_error === true,
      };
    }
  }
  return null;
}

function persistedToChatMessage(m: PersistedMessage): ChatMessage {
  const blocks = m.content_blocks
    .map(contentBlockToChatBlock)
    .filter((b): b is ChatBlock => b !== null);
  return {
    role: m.role,
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  };
}

function chatBlocksToContentBlocks(blocks: ChatBlock[]): ContentBlock[] {
  return blocks.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text } as ContentBlock;
    if (block.type === 'tool-call') {
      return {
        type: 'tool-call',
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
      } as ContentBlock;
    }
    return {
      type: 'tool-result',
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      output: block.output,
      isError: block.isError === true,
    } as ContentBlock;
  });
}

function toolUsesFromContentBlocks(blocks: ContentBlock[]): NormalizedToolUse[] {
  const out: NormalizedToolUse[] = [];
  for (const block of blocks) {
    const converted = contentBlockToChatBlock(block);
    if (converted?.type === 'tool-call') {
      out.push({ id: converted.toolCallId, name: converted.toolName, input: converted.input });
    }
  }
  return out;
}

function chatMessageToAnthropicParam(message: ChatMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content };
  }
  const content = message.content.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool-call') {
      return { type: 'tool_use', id: block.toolCallId, name: block.toolName, input: block.input };
    }
    return {
      type: 'tool_result',
      tool_use_id: block.toolCallId,
      content: asStringIfNotObject(block.output),
      is_error: block.isError === true,
    };
  });
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content: content as any };
}

function anthropicStopReason(stopReason: Anthropic.Message['stop_reason']): ChatResult['stopReason'] {
  const normalized = stopReason as string | null;
  if (normalized === 'tool_use') return 'tool_calls';
  if (normalized === 'max_tokens') return 'length';
  if (normalized === 'refusal') return 'refusal';
  return 'end';
}

function anthropicClientToChatTransport(client: MessagesClient): SubagentChatTransport {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    const model = opts.model?.startsWith('anthropic:')
      ? opts.model.slice('anthropic:'.length)
      : opts.model ?? DEFAULT_MODEL;
    const msg = await client.create({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system: [
        { type: 'text', text: opts.system ?? DEFAULT_SYSTEM, cache_control: { type: 'ephemeral' } },
      ] as any,
      messages: opts.messages.map(chatMessageToAnthropicParam),
      ...(opts.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t, i) => {
              const def: any = {
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              };
              if (i === opts.tools!.length - 1) def.cache_control = { type: 'ephemeral' };
              return def;
            }),
          }
        : {}),
    }, { signal: opts.abortSignal });

    const blocks: ChatBlock[] = [];
    for (const block of msg.content as ContentBlock[]) {
      const converted = contentBlockToChatBlock(block);
      if (converted) blocks.push(converted);
    }
    return {
      text: blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join(''),
      blocks,
      stopReason: anthropicStopReason(msg.stop_reason),
      usage: {
        input_tokens: msg.usage?.input_tokens ?? 0,
        output_tokens: msg.usage?.output_tokens ?? 0,
        cache_read_tokens: (msg.usage as any)?.cache_read_input_tokens ?? 0,
        cache_creation_tokens: (msg.usage as any)?.cache_creation_input_tokens ?? 0,
      },
      model: `anthropic:${model}`,
      providerId: 'anthropic',
    };
  };
}

function asStringIfNotObject(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Merge two AbortSignals into one. Fires when either source aborts. No-op
 * polyfill when AbortSignal.any isn't available yet (Node ≥ 20 has it).
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === 'function') return anyFn([a, b]) as AbortSignal;
  // Manual merge.
  const ac = new AbortController();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', () => ac.abort(), { once: true });
    b.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

/**
 * Error thrown when acquireLease returns acquired=false. The worker
 * treats this as a renewable error — job goes back to waiting with
 * backoff, no terminal fail.
 */
export class RateLeaseUnavailableError extends Error {
  constructor(public key: string, public active: number, public max: number) {
    super(`rate lease "${key}" full (${active}/${max})`);
    this.name = 'RateLeaseUnavailableError';
  }
}

/**
 * Detect Anthropic SDK errors that indicate the input prompt exceeded the
 * model's context window. Two recognized shapes:
 *   - `Anthropic.APIError` with `.status === 400` and message containing
 *     "prompt is too long" (current SDK wording, observed in production
 *     as `prompt is too long: 1707509 tokens > 1000000 maximum`).
 *   - Any error whose message includes "prompt is too long" (defensive
 *     against SDK-wrap shape changes).
 *
 * Case-insensitive on the phrase. Also matches `request_too_large` and
 * `invalid_request_error` types when accompanied by the same message.
 *
 * Exported for unit testing.
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (!err) return false;
  // Walk both `.message` and `.error?.message` shapes.
  const msg = (err as { message?: unknown })?.message;
  const inner = (err as { error?: { message?: unknown } })?.error?.message;
  const candidates = [msg, inner].filter((s): s is string => typeof s === 'string');
  for (const c of candidates) {
    if (/prompt is too long/i.test(c)) return true;
  }
  // Anthropic SDK wraps with .status; 400 + 'invalid_request_error' /
  // 'request_too_large' types both indicate the same class. Only treat
  // as terminal when the message actually says prompt-too-long; broader
  // 400s could be transient (e.g., malformed JSON from a test stub).
  const status = (err as { status?: unknown })?.status;
  const errType = (err as { error?: { type?: unknown } })?.error?.type;
  if (status === 400 && (errType === 'invalid_request_error' || errType === 'request_too_large')) {
    for (const c of candidates) {
      if (/too long|exceed|maximum/i.test(c)) return true;
    }
  }
  return false;
}

// ── Testing surface ─────────────────────────────────────────

export const __testing = {
  loadPriorMessages,
  loadPriorTools,
  persistMessage,
  persistToolExecPending,
  persistToolExecComplete,
  persistToolExecFailed,
  asStringIfNotObject,
  DEFAULT_MODEL,
};
