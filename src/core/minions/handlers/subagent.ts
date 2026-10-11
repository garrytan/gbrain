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

import Anthropic from '@anthropic-ai/sdk';
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
import { entityIngestTools, verifyIngestResult, validateIngestCompletion, checkIngestCallBudget, ingestFinalPrompt,finalizeBeforeIngestBudget,ingestAbortKind } from '../../pmbrain-adapters/entity-ingest-workflow.ts';
import {
  acquireLease,
  releaseLease,
  renewLeaseWithBackoff,
} from '../rate-leases.ts';
import {
  logSubagentSubmission,
  logSubagentHeartbeat,
} from './subagent-audit.ts';
import { resolveModel, isAnthropicProvider, TIER_DEFAULTS } from '../../model-config.ts';
import { buildSystemPrompt, DEFAULT_SUBAGENT_SYSTEM } from '../system-prompt.ts';
import { toolLoop as gatewayToolLoop, chat as gatewayChat } from '../../ai/gateway.ts';
import type { ChatToolDef, ChatMessage, ChatBlock, ChatResult, ToolHandler } from '../../ai/gateway.ts';
import { classifyCapabilities } from '../../ai/capabilities.ts';
import { randomUUIDv7 } from 'bun';
import { createHash } from 'node:crypto';
import { parseLlmJson } from '../../llm-json.ts';
import {defaultMaxOutputTokens} from '../../ai/model-compatibility.ts';
import {isToolCallingRejection,classifyChatError} from '../../ai/errors.ts';

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RATE_KEY = 'anthropic:messages';

/**
 * Resolve the rate-lease cap from the env var.
 *
 *   undefined       → 32 (default; was 8 pre-v0.41, starved 10-concurrency batches)
 *   "unlimited"     → POSITIVE_INFINITY (Azure / Bedrock / self-hosted with no upstream cap)
 *   "none"          → POSITIVE_INFINITY (alias)
 *   positive number → that number
 *   anything else   → throws (NaN / "0" / negative / typo — fail loud, NOT silent uncap)
 *
 * Codex pass-1 #7 caught the original `=0` and `NaN` silently uncapping;
 * "0 means disabled" is the universal convention, so we use an explicit
 * `unlimited` sentinel instead. Misconfig fails at startup with a hint.
 */
export function resolveLeaseCap(raw: string | undefined): number {
  if (raw === undefined) return 32;
  if (raw === 'unlimited' || raw === 'none') return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  throw new Error(
    `GBRAIN_ANTHROPIC_MAX_INFLIGHT="${raw}" is invalid. ` +
    `Use a positive integer, "unlimited" (or "none"), or omit for default 32.`,
  );
}
const DEFAULT_MAX_CONCURRENT = resolveLeaseCap(process.env.GBRAIN_ANTHROPIC_MAX_INFLIGHT);
const DEFAULT_LEASE_TTL_MS = 120_000;
// v0.41 Approach C: DEFAULT_SUBAGENT_SYSTEM lives in ./system-prompt.ts
// so the renderer and the handler share one source of truth. Kept as
// a re-export alias here for back-compat with any external importer.
const DEFAULT_SYSTEM = DEFAULT_SUBAGENT_SYSTEM;

// ── Injectable surfaces (for tests) ─────────────────────────

/**
 * Anthropic Messages client. The real Anthropic SDK implements this
 * structurally; tests can substitute a mock without the SDK import.
 */
export interface MessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export interface SubagentDeps {
  /** Engine for DB-backed ops (tools + message persistence + rate leases). */
  engine: BrainEngine;
  /** Anthropic client. Defaults to the SDK-constructed client. */
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
  /** Rate-lease key. Defaults to `anthropic:messages`. */
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
 * worker startup. Always registered — `ANTHROPIC_API_KEY` is the natural
 * cost gate and `PROTECTED_JOB_NAMES` gates submission.
 */
export function makeSubagentHandler(deps: SubagentDeps) {
  const engine = deps.engine;
  // sdk.messages IS the MessagesClient-shaped object. The v0.16.0 bug was
  // casting new Anthropic() (top level) to MessagesClient, but .create()
  // lives at sdk.messages.create. Assigning sdk.messages directly gets the
  // right object; JS method-call semantics preserve `this` at the call
  // site (subagent.ts invokes client.create(...) with client === sdk.messages).
  const makeAnthropic = deps.makeAnthropic ?? (() => new Anthropic());
  const client: MessagesClient = deps.client ?? makeAnthropic().messages;
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as GBrainConfig);
  const rateLeaseKey = deps.rateLeaseKey ?? DEFAULT_RATE_KEY;
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return async function subagentHandler(ctx: MinionJobContext): Promise<SubagentResult> {
    const data = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('subagent job data.prompt is required (string)');
    }

    // v0.38 (S1.5 + S1.7) — capability-based gate replaces the v0.31.12
    // Anthropic-only check. The handler now routes between two paths:
    //   1. Gateway path (gateway.toolLoop, provider-agnostic) — opt in via
    //      `gbrain config set agent.use_gateway_loop true`
    //   2. Legacy Anthropic-direct path (existing code below)
    // Default is the legacy path so v0.38 patch releases ship the same
    // behavior as v0.37. Users dogfood the gateway path by flipping the flag.
    //
    // Refuse-at-handler-entry when the model literally lacks tool calling
    // OR is from an unknown provider. The queue.ts gate already catches this
    // for queue-submitted jobs; the check here covers direct `gbrain agent run`
    // invocations and any code path that bypasses the queue's capability check.
    if (data.model) {
      const verdict = classifyCapabilities(data.model);
      if (verdict === 'unusable:no_tools' && !data.ingest_context) {
        throw new Error(
          `subagent job rejected: data.model "${data.model}" lacks native tool calling. ` +
          `The subagent loop dispatches brain ops via tool calls — without tool support the loop has no way to run.`,
        );
      }
      if (verdict === 'unknown') {
        throw new Error(
          `subagent job rejected: data.model "${data.model}" references an unknown provider. ` +
          `Use format provider:model where provider matches a recipe in src/core/ai/recipes/.`,
        );
      }
    }
    const model = data.model
      ?? await resolveModel(engine, {
        tier: 'subagent',
        configKey: 'models.subagent',
        fallback: TIER_DEFAULTS.subagent,
      });
    const maxTurns = data.max_turns ?? DEFAULT_MAX_TURNS;
    // v0.41 Approach C: systemPrompt is now built AFTER toolDefs (a few
    // lines below) so the renderer can splice a tool-usage preamble
    // listing each available tool's usage_hint. The renderer is
    // deterministic so the Anthropic prompt-cache marker on the system
    // block stays a hit across turns.

    // PMBrain keeps the stable Anthropic-direct path by default, but every
    // non-Anthropic provider is routed automatically through the canonical
    // gateway.toolLoop(). Ordinary users should not need to understand an
    // internal feature flag just to use a configured tool-capable model.
    const useGatewayLoopRaw = await engine.getConfig('agent.use_gateway_loop').catch(() => null);
    const gatewayLoopExplicit = typeof useGatewayLoopRaw === 'string' &&
      (useGatewayLoopRaw === 'true' || useGatewayLoopRaw === '1');
    // An injected Messages client is an explicit execution seam (tests and
    // embedders). Never bypass it because the host's ambient model config
    // happens to name a non-Anthropic provider.
    const useGatewayLoop = !deps.client && !deps.makeAnthropic
      && (gatewayLoopExplicit || !isAnthropicProvider(model)||!!data.ingest_context);

    // Build the tool registry bound to THIS job as the owning subagent.
    // brain_id (per-call brain override; children inherit parent's unless
    // they set their own) and allowed_slug_prefixes (v0.23 trusted-workspace
    // allow-list — flows through buildBrainTools → the put_page schema
    // description AND the OperationContext, so the model's tool schema and
    // the server-side check stay in sync).
    const baseRegistry = deps.toolRegistry ?? buildBrainTools({
      subagentId: ctx.id,
      engine,
      config,
      brainId: data.brain_id,
      allowedSlugPrefixes: data.allowed_slug_prefixes,
      sourceId: data.source_id,
      skillsDir: data.skills_dir,
      allowEntityLinks: !!data.ingest_context,
    });
    const scopedRegistry = data.ingest_context ? entityIngestTools(baseRegistry,data.ingest_context) : baseRegistry;
    const registry = data.discovery_profile === 'entity_capture'
      ? (await import('../../cycle/entity-capture-tools.ts')).boundedEntityCaptureTools(scopedRegistry)
      : scopedRegistry;
    const toolDefs = data.allowed_tools && data.allowed_tools.length > 0
      ? filterAllowedTools(registry, data.allowed_tools)
      : registry;

    // v0.41 Approach C: render the final system prompt now that toolDefs
    // is known. Splices a deterministic tool-usage preamble listing each
    // tool's usage_hint. Caller can opt out via data.system_no_tool_preamble.
    const systemPrompt = buildSystemPrompt(toolDefs, data.system, {
      no_tool_preamble: data.system_no_tool_preamble,
    });

    let oneshotFallbackReason: string | undefined;
    if (data.mode === 'oneshot') {
      const outcome = await tryRunOneshot({ engine, ctx, data, model, systemPrompt, toolDefs });
      if (outcome.kind === 'success') return outcome.result;
      oneshotFallbackReason = outcome.reason;
      logSubagentHeartbeat({
        job_id: ctx.id,
        event: 'llm_call_completed',
        turn_idx: 0,
        error: `oneshot fallback: ${outcome.reason}`,
      });
    }

    logSubagentSubmission({
      caller: 'worker',
      remote: true,
      job_id: ctx.id,
      model,
      tools_count: toolDefs.length,
      allowed_tools: toolDefs.map(t => t.name),
    });

    // v0.38 S1.5 — gateway path. Route here when the feature flag is on.
    if (useGatewayLoop) {
      const result = await runSubagentViaGateway({
        engine,
        ctx,
        data,
        model,
        systemPrompt,
        toolDefs,
        maxTurns,
      });
      return verifyIngestResult(engine,data,data.mode === 'oneshot'
        ? { ...result, synth_mode_used: 'agentic_fallback', fallback_reason: oneshotFallbackReason }
        : { ...result, synth_mode_used: 'agentic' },ctx.id);
    }

    // ── Load prior state (replay) ───────────────────────────
    const priorMessages = await loadPriorMessages(engine, ctx.id);
    const priorTools = await loadPriorTools(engine, ctx.id);
    const priorToolByUseId = new Map(priorTools.map(t => [t.tool_use_id, t]));

    // Rebuild the Anthropic messages array from persisted rows.
    const anthroMessages: Anthropic.MessageParam[] = priorMessages.length > 0
      ? priorMessages.map(m => ({ role: m.role, content: m.content_blocks as any }))
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
    //
    // v0.37.7.0 #1151: if the last persisted message is an assistant
    // with NO tool_use blocks, the prior run already reached terminal
    // end_turn. Sonnet 4.6+ rejects assistant-prefill, so calling
    // messages.create here would dead-letter the job despite the work
    // being already committed. Return immediately with the persisted
    // text as finalText. Mirrors the live-loop terminal logic below.
    const last = priorMessages[priorMessages.length - 1];
    if (last && last.role === 'assistant') {
      const pendingToolUses = last.content_blocks.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } & Record<string, unknown> =>
          b.type === 'tool_use',
      );
      if (pendingToolUses.length === 0) {
        const finalText = last.content_blocks
          .filter((b): b is { type: 'text'; text: string } & Record<string, unknown> =>
            b.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
          )
          .map(b => b.text)
          .join('\n');
        const correction=await validateIngestCompletion(engine,data,finalText,ctx.id,assistantTurns<maxTurns);
        if(correction){
          const blocks=[{type:'text',text:correction}] as ContentBlock[];
          await persistMessage(engine,ctx.id,{message_idx:nextMessageIdx++,role:'user',content_blocks:blocks,tokens_in:null,tokens_out:null,tokens_cache_read:null,tokens_cache_create:null,model:null});
          anthroMessages.push({role:'user',content:blocks as any});
        }else return verifyIngestResult(engine,data,{
          result: finalText,
          turns_count: assistantTurns,
          stop_reason: 'end_turn',
          tokens: tokenTotals,
        },ctx.id);
      }
      if (pendingToolUses.length > 0) {
        const synthesizedResults: ContentBlock[] = [];
        for (const use of pendingToolUses) {
          const prior = priorToolByUseId.get(use.id);
          if (prior?.status === 'complete') {
            synthesizedResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: asStringIfNotObject(prior.output),
            } as ContentBlock);
            continue;
          }
          if (prior?.status === 'failed') {
            synthesizedResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: prior.error ?? 'tool failed',
              is_error: true,
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
              type: 'tool_result', tool_use_id: use.id,
              content: `tool "${use.name}" is not available`, is_error: true,
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
              type: 'tool_result', tool_use_id: use.id,
              content: asStringIfNotObject(output),
            } as ContentBlock);
          } catch (e) {
            const errText = e instanceof Error ? (e.stack ?? e.message) : String(e);
            await persistToolExecFailed(engine, ctx.id, last.message_idx, use.id, use.name, use.input, errText);
            synthesizedResults.push({
              type: 'tool_result', tool_use_id: use.id,
              content: errText, is_error: true,
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
        anthroMessages.push({ role: 'user', content: synthesizedResults as any });
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
      //
      // A1 ORDERING (v0.37.x budget cathedral):
      //
      //   +----------------------------------+
      //   | gateway.chat() inside subagent   |
      //   +-----+----------------------------+
      //         |
      //   1. getCurrentBudgetTracker()?.reserve(...)
      //         |  (runs via the gateway's AsyncLocalStorage scope,
      //         |   set by the upstream caller of the subagent.
      //         |   On BudgetExhausted: throw BEFORE we touch the lease.)
      //         v
      //   2. acquireLease(...)  <-- the line below
      //         |  (only attempted if the budget gate passed)
      //         v
      //   3. provider HTTP call
      //         |
      //         v
      //   4. tracker.record(actual usage)
      //
      // The handler body intentionally does NOT thread `BudgetTracker`
      // explicitly. Gateway-layer composition (TX5) handles it. The
      // ordering is load-bearing: a budget throw must NOT consume a
      // lease slot, because the lease is the rate-limit pacer for the
      // entire fleet.
      const finalIngestTurn=!!data.ingest_context&&(assistantTurns===maxTurns-1||await finalizeBeforeIngestBudget(engine,ctx.id,data,systemPrompt,anthroMessages,toolDefs.map(t=>t.input_schema)));
      const callMessages=finalIngestTurn?[{role:'user' as const,content:await ingestFinalPrompt(engine,ctx.id,data)}]:anthroMessages;
      await checkIngestCallBudget(engine,ctx.id,data,systemPrompt,callMessages,finalIngestTurn?[]:toolDefs.map(t=>t.input_schema),finalIngestTurn);
      const lease = await acquireLease(engine, rateLeaseKey, ctx.id, maxConcurrent, { ttlMs: leaseTtlMs });
      if (!lease.acquired) {
        // No slots — treat as a renewable error so the worker re-claims
        // the job later. Don't fail terminally.
        throw new RateLeaseUnavailableError(rateLeaseKey, lease.activeCount, lease.maxConcurrent);
      }

      let assistantMsg: Anthropic.Message;
      const turnIdx = assistantTurns;
      const t0 = Date.now();
      logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: turnIdx });

      // Renewal is short-lived; for single-call turns the initial TTL
      // covers the whole request. A mid-call renewal loop would add
      // complexity; for v0.15 we lean on the 120s TTL + abort-on-signal.
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          // v0.41 Bug 3: strip `provider:` prefix at the SDK call site only.
          // `model` stays qualified everywhere else (persistence, recipe
          // lookup at recipeIdFromModel(), capability gate).
          model: stripProviderPrefix(model),
          max_tokens: Math.min(4096,data.usage_limits?.output??4096),
          system: [
            { type: 'text', text: finalIngestTurn?`${systemPrompt}\nThis is the final verification turn. Return the requested JSON receipt. Tools are unavailable.`:systemPrompt, cache_control: { type: 'ephemeral' } },
          ] as any,
          messages: callMessages,
          ...(toolDefs.length > 0 && !finalIngestTurn
            ? {
                tools: toolDefs.map((t, i) => {
                  const def: any = {
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                  };
                  // Cache only the last tool def — Anthropic treats cache_control
                  // as "cache everything up to and including this block".
                  if (i === toolDefs.length - 1) def.cache_control = { type: 'ephemeral' };
                  return def;
                }),
              }
            : {}),
        };

        const combinedSignal = mergeSignals(ctx.signal, ctx.shutdownSignal);
        assistantMsg = await client.create(params, { signal: combinedSignal });
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
      const inTokens = assistantMsg.usage?.input_tokens ?? 0;
      const outTokens = assistantMsg.usage?.output_tokens ?? 0;
      const cacheRead = (assistantMsg.usage as any)?.cache_read_input_tokens ?? 0;
      const cacheCreate = (assistantMsg.usage as any)?.cache_creation_input_tokens ?? 0;

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

      const blocks = assistantMsg.content as ContentBlock[];

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
        model,
      });
      anthroMessages.push({ role: 'assistant', content: blocks as any });
      assistantTurns++;

      // 4. Collect tool_use blocks. If none, we're done.
      const toolUses = blocks.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } & Record<string, unknown> =>
          b.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        stopReason = 'end_turn';
        // Concatenate text blocks as the final answer.
        finalText = blocks
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n');
        const correction=await validateIngestCompletion(engine,data,finalText,ctx.id,!finalIngestTurn&&assistantTurns<maxTurns);
        if(correction){
          const blocks=[{type:'text',text:correction}] as ContentBlock[];
          await persistMessage(engine,ctx.id,{message_idx:nextMessageIdx++,role:'user',content_blocks:blocks,tokens_in:null,tokens_out:null,tokens_cache_read:null,tokens_cache_create:null,model:null});
          anthroMessages.push({role:'user',content:blocks as any});
          continue;
        }
        break;
      }
      if(finalIngestTurn)throw new UnrecoverableError('ingest final receipt attempted more tools; unfinished document is resumable');

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
            type: 'tool_result',
            tool_use_id: use.id,
            content: `tool "${toolName}" is not available`,
            is_error: true,
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
            type: 'tool_result',
            tool_use_id: use.id,
            content: asStringIfNotObject(prior.output),
          } as ContentBlock);
          continue;
        }
        if (prior && prior.status === 'failed') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: prior.error ?? 'tool failed',
            is_error: true,
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
            type: 'tool_result',
            tool_use_id: use.id,
            content: asStringIfNotObject(output),
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
            type: 'tool_result',
            tool_use_id: use.id,
            content: errText,
            is_error: true,
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
      anthroMessages.push({ role: 'user', content: toolResults as any });
    }

    return verifyIngestResult(engine,data,{
      result: finalText,
      turns_count: assistantTurns,
      stop_reason: stopReason,
      tokens: tokenTotals,
      synth_mode_used: data.mode === 'oneshot' ? 'agentic_fallback' : 'agentic',
      ...(data.mode === 'oneshot' && oneshotFallbackReason ? { fallback_reason: oneshotFallbackReason } : {}),
    },ctx.id);
  };
}

// ── v0.38 Gateway-native subagent path ──────────────────────

interface GatewayRunArgs {
  engine: BrainEngine;
  ctx: MinionJobContext;
  data: SubagentHandlerData;
  model: string;
  systemPrompt: string;
  toolDefs: ToolDef[];
  maxTurns: number;
}

/**
 * v0.38 S1.5 — provider-agnostic subagent loop via `gateway.toolLoop()`.
 *
 * Adapts the existing brain-tool registry (anthropic-shaped ToolDef) to the
 * gateway's provider-neutral `ChatToolDef` + `ToolHandler` shapes, wires
 * persistence callbacks that use the v0.38 stable-ID columns (ordinal +
 * gbrain_tool_use_id from migration v81), and invokes the gateway loop.
 *
 * Replay semantics: loads prior `subagent_messages` + `subagent_tool_executions`,
 * builds a `ToolLoopReplayState` keyed by `gbrain_tool_use_id`. For pre-v81
 * legacy rows (ordinal NULL), the D5 read-time shim synthesizes a stable key
 * from `(job_id, message_idx, content_blocks index, tool_name)` so the
 * reconciler sees both shapes uniformly.
 */
async function runSubagentViaGateway(args: GatewayRunArgs): Promise<SubagentResult> {
  const { engine, ctx, data, model, systemPrompt, toolDefs, maxTurns } = args;

  // Map ToolDef → ChatToolDef (gateway shape). The gateway's chat() bridges
  // this to provider-specific tool definitions via the Vercel AI SDK.
  const chatTools: ChatToolDef[] = toolDefs.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as Record<string, unknown>,
  }));

  // Map ToolDef → ToolHandler (gateway shape). Each handler is a thin wrapper
  // that invokes the existing brain-tool dispatch.
  const toolHandlers = new Map<string, ToolHandler>();
  for (const t of toolDefs) {
    toolHandlers.set(t.name, {
      idempotent: t.idempotent === true,
      async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
        return await t.execute(input, {
          engine,
          jobId: ctx.id,
          remote: true,
          signal,
        });
      },
    });
  }

  // Load prior state (replay support via D5 shim for legacy v1 rows).
  const priorMessages = await loadPriorMessages(engine, ctx.id);
  const terminal = priorMessages.at(-1);
  if (data.ingest_context && terminal?.role === 'assistant'&&!terminal.content_blocks.some(block=>(block as any).truncated)) {
    const adapted = adaptContentBlocksToChatBlocks(terminal.content_blocks);
    const blocks = typeof adapted === 'string' ? [{type:'text' as const,text:adapted}] : adapted;
    if (!blocks.some(block => block.type === 'tool-call')) {
      const text = blocks.filter((block): block is {type:'text';text:string} => block.type === 'text').map(block => block.text).join('\n');
      const turns = priorMessages.filter(message => message.role === 'assistant'&&!message.content_blocks.some(block=>(block as any).truncated)).length;
      const correction = await validateIngestCompletion(engine,data,text,ctx.id,turns < maxTurns);
      if (!correction) return verifyIngestResult(engine,data,{
        result:text,turns_count:turns,stop_reason:'end_turn',tokens:{
          in:priorMessages.reduce((sum,message)=>sum+(message.tokens_in??0),0),
          out:priorMessages.reduce((sum,message)=>sum+(message.tokens_out??0),0),
          cache_read:priorMessages.reduce((sum,message)=>sum+(message.tokens_cache_read??0),0),
          cache_create:priorMessages.reduce((sum,message)=>sum+(message.tokens_cache_create??0),0),
        },
      },ctx.id);
      const feedback: PersistedMessage = {message_idx:priorMessages.length,role:'user',content_blocks:[{type:'text',text:correction}],tokens_in:null,tokens_out:null,tokens_cache_read:null,tokens_cache_create:null,model:null};
      await persistMessage(engine,ctx.id,feedback);
      priorMessages.push(feedback);
    }
  }
  const priorTools = await loadPriorToolsV2(engine, ctx.id);
  const priorToolsByStableKey = new Map<string, { status: 'pending' | 'complete' | 'failed'; output?: unknown; error?: string }>();
  for (const row of priorTools) {
    priorToolsByStableKey.set(row.stableKey, {
      status: row.status,
      output: row.output,
      error: row.error ?? undefined,
    });
  }

  // Convert prior Anthropic-shape messages → ChatMessage with ChatBlock content.
  // v1 rows store Anthropic content blocks ({type:'tool_use'|'tool_result'|...});
  // we adapt them to ChatBlock shape (type: 'tool-call' | 'tool-result' | 'text').
  const priorChatMessages: ChatMessage[] = priorMessages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: adaptContentBlocksToChatBlocks(m.content_blocks),
  }));
  await appendCompletedToolResultsOnReplay({
    engine,
    jobId: ctx.id,
    priorMessages,
    priorChatMessages,
    priorTools,
  });

  // Initial seed message if no prior state.
  const initialMessages: ChatMessage[] = priorChatMessages.length === 0
    ? [{ role: 'user', content: data.prompt }]
    : [];

  // Persist seed user message at idx 0 if fresh start.
  let nextMessageIdx = priorChatMessages.length;
  if (nextMessageIdx === 0) {
    await persistMessage(engine, ctx.id, {
      message_idx: 0,
      role: 'user',
      content_blocks: [{ type: 'text', text: data.prompt }] as ContentBlock[],
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      model: null,
    });
    nextMessageIdx = 1;
  }

  // Capability detection drives cache_control injection.
  const verdict = classifyCapabilities(model);
  const cacheSystem = verdict === 'ok' || verdict === 'degraded:no_parallel';

  // Heartbeat bridge.
  const heartbeat = (event: string, payload: Record<string, unknown>) => {
    logSubagentHeartbeat({
      job_id: ctx.id,
      event: event as any,
      ...payload,
    } as any);
  };

  // Run the loop.
  let result: Awaited<ReturnType<typeof gatewayToolLoop>>;
  try {
    result = await gatewayToolLoop({
    model,
    system: systemPrompt,
    initialMessages,
    tools: chatTools,
    toolHandlers,
    maxTurns,
    maxTokens: Math.min(defaultMaxOutputTokens(model),data.usage_limits?.output??Infinity),
    modelOutputLimit:data.model_output_limit,
    turnTimeoutMs:data.ingest_context?data.turn_timeout_ms??300_000:undefined,
    lengthRetryLimit:data.ingest_context?({messages,maxTokens,finalTurn})=>checkIngestCallBudget(engine,ctx.id,data,systemPrompt,messages,finalTurn?[]:chatTools,!!finalTurn,maxTokens,true):undefined,
    retryLength:!!data.ingest_context,
    jsonToolCalls:!!data.ingest_context&&(data.ingest_json_tools===true||classifyCapabilities(model)==='unusable:no_tools'),
    disableReasoning:!!data.ingest_context,
    finalizeOnLastTurn:!!data.ingest_context,
    prepareFinalMessages:data.ingest_context?async()=>[{role:'user',content:await ingestFinalPrompt(engine,ctx.id,data)}]:undefined,
    shouldFinalize:data.ingest_context?messages=>finalizeBeforeIngestBudget(engine,ctx.id,data,systemPrompt,messages,chatTools):undefined,
    validateCompletion:data.ingest_context?(text,canContinue)=>validateIngestCompletion(engine,data,text,ctx.id,canContinue):undefined,
    beforeModelCall: async ({messages,finalTurn,maxTokens})=>{await checkIngestCallBudget(engine,ctx.id,data,systemPrompt,messages,finalTurn?[]:chatTools,!!finalTurn,maxTokens);},
    reportLengthStop: !!data.ingest_context,
    abortSignal: AbortSignal.any([ctx.signal,ctx.shutdownSignal]),
    cacheSystem,
    // ALWAYS pass replayState (even on fresh runs) so the gateway loop's
    // messageIdx counter starts at `nextMessageIdx` (1 on fresh, after the
    // seed user write above). Without this, the loop defaults to messageIdx=0
    // on fresh runs and the first onAssistantTurn callback tries to write
    // role='assistant' at idx 0, colliding with the seed user message at idx 0
    // (unique constraint on (job_id, message_idx)). Pinned by
    // test/e2e/subagent-gateway-path.test.ts ("happy path 1-turn" + "write-
    // ordering invariant").
    replayState: {
      priorMessages: priorChatMessages,
      priorTools: priorToolsByStableKey,
      nextTurnIdx: priorChatMessages.filter(m => m.role === 'assistant'&&!(Array.isArray(m.content)&&m.content.some(block=>block.type==='text'&&block.truncated))).length,
      nextMessageIdx,
    },
    onAssistantTurn: async (turnIdx, messageIdx, blocks, usage, modelStr) => {
      // Convert ChatBlock[] back to ContentBlock-shaped JSONB for persistence.
      // Storing the gateway's provider-neutral shape is the v2 content_blocks
      // contract; the D5 shim handles legacy reads from v1 rows.
      await persistMessage(engine, ctx.id, {
        message_idx: messageIdx,
        role: 'assistant',
        content_blocks: blocks as unknown as ContentBlock[],
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        tokens_cache_read: usage.cache_read_tokens,
        tokens_cache_create: usage.cache_creation_tokens,
        model: modelStr,
      });
      await ctx.updateTokens({
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens,
      });
      heartbeat('llm_call_completed', { turn_idx: turnIdx, tokens: usage });
    },
    onToolCallStart: async (turnIdx, messageIdx, ordinal, toolName, input, providerToolCallId) => {
      // CRITICAL — read back the canonical gbrain_tool_use_id from RETURNING,
      // NOT the locally-generated UUID. On crash-replay the (job_id,
      // message_idx, ordinal) row already exists with the ORIGINAL UUID from
      // the pre-crash run; the ON CONFLICT DO UPDATE keeps it. If we
      // returned the freshly-generated `candidateId` instead, the gateway
      // loop's `replayState.priorTools.get(stableKey)` lookup would miss
      // because priorTools is keyed by the original UUID — the short-
      // circuit silently breaks and the tool re-executes. Pinned by
      // test/e2e/subagent-crash-replay-multi-provider.test.ts.
      const candidateId = randomUUIDv7();
      const rows = await engine.executeRaw<{ gbrain_tool_use_id: string }>(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, gbrain_tool_use_id, provider_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 2, $6, $7, $8)
         ON CONFLICT (job_id, message_idx, ordinal) DO UPDATE
           SET status = subagent_tool_executions.status
         RETURNING gbrain_tool_use_id::text AS gbrain_tool_use_id`,
        [ctx.id, messageIdx, providerToolCallId, toolName, JSON.stringify(input ?? null), ordinal, candidateId, recipeIdFromModel(model)],
      );
      const gbrainToolUseId = rows[0]?.gbrain_tool_use_id ?? candidateId;
      heartbeat('tool_called', { turn_idx: turnIdx, tool_name: toolName });
      return { gbrainToolUseId };
    },
    onToolCallComplete: async (gbrainToolUseId, output) => {
      await engine.executeRaw(
        `UPDATE subagent_tool_executions
           SET status = 'complete', output = $1::jsonb, ended_at = now()
         WHERE gbrain_tool_use_id::text = $2`,
        [JSON.stringify(output ?? null), gbrainToolUseId],
      );
    },
    onToolCallFailed: async (gbrainToolUseId, errorMsg) => {
      await engine.executeRaw(
        `UPDATE subagent_tool_executions
           SET status = 'failed', error = $1, ended_at = now()
         WHERE gbrain_tool_use_id::text = $2`,
        [errorMsg, gbrainToolUseId],
      );
    },
    onToolResultTurn: async (_turnIdx, messageIdx, blocks) => {
      await persistMessage(engine, ctx.id, {
        message_idx: messageIdx,
        role: 'user',
        content_blocks: blocks as unknown as ContentBlock[],
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      });
    },
    onHeartbeat: heartbeat,
    });
  } catch (error) {
    if(data.ingest_context&&(ctx.signal.aborted||ctx.shutdownSignal.aborted))throw new UnrecoverableError(`ingest_provider_${ctx.shutdownSignal.aborted?'service_shutdown':ingestAbortKind(ctx.signal)}: ${error instanceof Error?error.message:String(error)}`);
    if(data.ingest_context&&!data.ingest_json_tools&&isToolCallingRejection(error)){
      await engine.executeRaw("UPDATE minion_jobs SET data=(CASE WHEN jsonb_typeof(data)='string' THEN (data #>> '{}')::jsonb ELSE data END)||'{\"ingest_json_tools\":true}'::jsonb WHERE id=$1",[ctx.id]);
      return runSubagentViaGateway({...args,data:{...data,ingest_json_tools:true}});
    }
    const detail = promptTooLongDetail(error);
    if (detail !== null) {
      throw new UnrecoverableError(`prompt_too_long: ${detail}`);
    }
    if(data.ingest_context&&!ctx.signal.aborted){
      const kind=classifyChatError(error);
      if(kind==='parse')throw new UnrecoverableError(`ingest_provider_parse: ${error instanceof Error?error.message:String(error)}`);
      if(kind!=='failure')throw new Error(`ingest_provider_${kind}: ${error instanceof Error?error.message:String(error)}`);
    }
    throw error;
  }

  // A provider can terminate a reasoning-only turn with no text and no tool
  // calls. Treating that as "completed" makes Dream report success while
  // patterns/reflections were never written. Throw a retryable error instead;
  // jobs that executed at least one tool keep their existing completion rules.
  if (result.totalTurns === 1 && result.stopReason==='end' && result.finalText.trim() === '') {
    throw new Error(
      `subagent returned an empty first turn without calling a tool (${model}); retry with the configured fallback`,
    );
  }

  // Map gateway stop reason to SubagentStopReason. SubagentStopReason has
  // {end_turn, max_turns, refusal, error}; aborted maps to error.
  const stopReason: SubagentStopReason = result.stopReason === 'end'
    ? 'end_turn'
    : result.stopReason === 'max_turns'
      ? 'max_turns'
      : result.stopReason === 'refusal'
        ? 'refusal'
        : result.stopReason === 'content_filter'
          ? 'refusal'
          : result.stopReason === 'length'?'length'
          : result.stopReason === 'aborted'
            ? ctx.shutdownSignal.aborted?'service_shutdown':ingestAbortKind(ctx.signal)
            : 'end_turn';

  return {
    result: result.finalText,
    turns_count: result.totalTurns,
    stop_reason: stopReason,
    tokens: {
      in: priorMessages.reduce((sum, message) => sum + (message.tokens_in ?? 0), 0) + result.totalUsage.input_tokens,
      out: priorMessages.reduce((sum, message) => sum + (message.tokens_out ?? 0), 0) + result.totalUsage.output_tokens,
      cache_read: priorMessages.reduce((sum, message) => sum + (message.tokens_cache_read ?? 0), 0) + result.totalUsage.cache_read_tokens,
      cache_create: priorMessages.reduce((sum, message) => sum + (message.tokens_cache_create ?? 0), 0) + result.totalUsage.cache_creation_tokens,
    },
  };
}

function recipeIdFromModel(modelString: string): string {
  const idx = modelString.indexOf(':');
  return idx > 0 ? modelString.slice(0, idx) : 'anthropic';
}

/**
 * Strip the `provider:` prefix from a model string. Returns the bare
 * model id the Anthropic Messages API expects. Idempotent on already-bare
 * strings.
 *
 *   stripProviderPrefix('anthropic:claude-sonnet-4-6') === 'claude-sonnet-4-6'
 *   stripProviderPrefix('claude-sonnet-4-6') === 'claude-sonnet-4-6'
 *
 * v0.41 Bug 3 — pre-fix, `gbrain agent run --model anthropic:claude-sonnet-4-6`
 * sent the prefixed string straight into `client.messages.create()`, which
 * Anthropic rejects with "model not found." Omitting `--model` worked because
 * `resolveModel()` returns the bare id; explicit-model users hit the bug.
 *
 * Used ONLY at the SDK call site. The wider `model` variable stays
 * qualified everywhere else (persistence, recipe lookup, capability gate)
 * because those readers want the provider info.
 */
export function stripProviderPrefix(modelString: string): string {
  const idx = modelString.indexOf(':');
  return idx > 0 ? modelString.slice(idx + 1) : modelString;
}

/**
 * D5 — adapt v1 Anthropic content blocks to v2 ChatBlock shape on read.
 * Symmetric in the other direction is handled by persisting ChatBlock[] as-is
 * (the JSONB column accepts both shapes; v2 writes carry the new vocabulary).
 */
function adaptContentBlocksToChatBlocks(blocks: unknown): ChatBlock[] | string {
  const normalized = parsePersistedContentBlocks(blocks);
  if (typeof normalized === 'string') return normalized;
  if (!Array.isArray(normalized)) return [];
  const out: ChatBlock[] = [];
  for (const b of normalized) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text,...(block.truncated===true?{truncated:true,outputLimit:typeof block.outputLimit==='number'?block.outputLimit:undefined,lengthRetry:block.lengthRetry===true,finalVerification:block.finalVerification===true}:{}) });
    } else if (t === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      // v1 Anthropic shape
      out.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input ?? {},
      });
    } else if (t === 'tool-call' && typeof block.toolCallId === 'string' && typeof block.toolName === 'string') {
      // v2 gateway shape (re-read of own writes)
      out.push({
        type: 'tool-call',
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input ?? {},
      });
    } else if (t === 'tool_result' && typeof block.tool_use_id === 'string') {
      // v1 Anthropic shape — tool result block (no toolName in v1; synthesize)
      out.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: '__legacy__',
        output: block.content ?? null,
        isError: block.is_error === true,
      });
    } else if (t === 'tool-result' && typeof block.toolCallId === 'string') {
      out.push({
        type: 'tool-result',
        toolCallId: block.toolCallId,
        toolName: typeof block.toolName === 'string' ? block.toolName : '__legacy__',
        output: block.output ?? null,
        isError: block.isError === true,
      });
    }
  }
  return out;
}

function parsePersistedContentBlocks(blocks: unknown): unknown {
  let current = blocks;
  for (let i = 0; i < 2; i++) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{') && !trimmed.startsWith('"')) return current;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return current;
    }
  }
  return current;
}

interface PriorToolV2Row {
  stableKey: string;
  messageIdx: number;
  toolUseId: string;
  toolName: string;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/**
 * Load prior tool executions keyed by a stable key.
 *
 *   - v2 rows: gbrain_tool_use_id is the stable key (set at first observation
 *     by onToolCallStart).
 *   - v1 legacy rows: D5 shim synthesizes a stable key from
 *     (job_id, message_idx, ordinal-position-by-array-index, tool_name).
 *
 * Both forms resolve to the same Map<stableKey, outcome> the gateway loop
 * consults during replay.
 */
async function loadPriorToolsV2(engine: BrainEngine, jobId: number): Promise<PriorToolV2Row[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, ordinal, gbrain_tool_use_id::text AS gbrain_tool_use_id,
            status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
  return rows.map(r => {
    const gbrainId = r.gbrain_tool_use_id as string | null;
    const stableKey = gbrainId
      ? gbrainId
      // D5 legacy shim: derive a stable key from (job, msg_idx, tool_name, tool_use_id).
      // Pre-v81 rows don't have ordinal; the provider tool_use_id is stable
      // within a single Anthropic turn so it's safe as a fallback hash input.
      : `legacy:${jobId}:${r.message_idx}:${r.tool_use_id}:${r.tool_name}`;
    return {
      stableKey,
      messageIdx: Number(r.message_idx),
      toolUseId: String(r.tool_use_id ?? ''),
      toolName: String(r.tool_name ?? ''),
      status: r.status as 'pending' | 'complete' | 'failed',
      output: r.output,
      error: (r.error as string | null) ?? null,
    };
  });
}

// ── Internal: persistence ───────────────────────────────────

async function appendCompletedToolResultsOnReplay(args: {
  engine: BrainEngine;
  jobId: number;
  priorMessages: PersistedMessage[];
  priorChatMessages: ChatMessage[];
  priorTools: PriorToolV2Row[];
}): Promise<void> {
  const { engine, jobId, priorMessages, priorChatMessages, priorTools } = args;
  const lastIdx = priorChatMessages.length - 1;
  const last = priorChatMessages[lastIdx];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;

  const calls = last.content.filter(
    (b): b is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } =>
      b.type === 'tool-call',
  );
  if (calls.length === 0) return;

  const assistantMessageIdx = priorMessages[lastIdx]?.message_idx;
  if (assistantMessageIdx === undefined) return;

  const resultBlocks: ChatBlock[] = [];
  for (const call of calls) {
    const prior = priorTools.find(row =>
      row.messageIdx === assistantMessageIdx &&
      row.toolUseId === call.toolCallId &&
      row.toolName === call.toolName,
    );
    if (!prior || prior.status === 'pending') return;
    resultBlocks.push({
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: prior.status === 'complete' ? prior.output : (prior.error ?? 'tool failed'),
      isError: prior.status === 'failed',
    });
  }

  const messageIdx = priorMessages.length === 0
    ? 0
    : Math.max(...priorMessages.map(m => m.message_idx)) + 1;
  await persistMessage(engine, jobId, {
    message_idx: messageIdx,
    role: 'user',
    content_blocks: resultBlocks as unknown as ContentBlock[],
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_create: null,
    model: null,
  });
  priorChatMessages.push({ role: 'user', content: resultBlocks });
  priorMessages.push({
    message_idx: messageIdx,
    role: 'user',
    content_blocks: resultBlocks,
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_create: null,
    model: null,
  });
}

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
  return promptTooLongDetail(err) !== null;
}

type OneshotOutcome =
  | { kind: 'success'; result: SubagentResult }
  | { kind: 'fallback'; reason: string };

export function parseOneshotPayload(text: string, requiredSuffix?: string): {
  pages: Array<{ slug: string; content: string }>;
  skipReason: string | null;
} {
  const parsed = parseLlmJson<{ pages?: unknown; skip_reason?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.pages) || parsed.pages.length > 3) throw new Error('invalid_pages_shape');
  const pages = parsed.pages.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`invalid_page_${index}`);
    const page = value as { slug?: unknown; content?: unknown };
    if (typeof page.slug !== 'string' || !page.slug.trim()
        || typeof page.content !== 'string' || !page.content.trim()) {
      throw new Error(`invalid_page_${index}`);
    }
    if (requiredSuffix && !page.slug.endsWith(`-${requiredSuffix}`)) {
      throw new Error(`slug_suffix_mismatch_${index}`);
    }
    return { slug: page.slug, content: page.content };
  });
  const skipReason = typeof parsed.skip_reason === 'string' && parsed.skip_reason.trim()
    ? parsed.skip_reason.trim()
    : null;
  if (pages.length === 0 && !skipReason) throw new Error('empty_without_skip_reason');
  return { pages, skipReason };
}

async function tryRunOneshot(opts: {
  engine: BrainEngine;
  ctx: MinionJobContext;
  data: SubagentHandlerData;
  model: string;
  systemPrompt: string;
  toolDefs: ToolDef[];
}): Promise<OneshotOutcome> {
  const { engine, ctx, data, model, systemPrompt, toolDefs } = opts;
  const prefix = 'oneshot-';
  const prior = (await loadPriorTools(engine, ctx.id)).filter((row) => row.tool_use_id.startsWith(prefix));
  const committed = prior.filter((row) => row.status === 'complete');
  if (committed.length > 0) {
    const slugs = committed.flatMap((row) => {
      const input = row.input as { slug?: unknown } | null;
      return typeof input?.slug === 'string' ? [input.slug] : [];
    });
    return {
      kind: 'success',
      result: {
        result: `oneshot recovery: ${committed.length} committed write(s)`,
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 },
        synth_mode_used: 'oneshot',
        written_slugs: slugs,
      },
    };
  }
  const putPage = toolDefs.find((tool) => tool.name === 'brain_put_page');
  if (!putPage) return { kind: 'fallback', reason: 'no_put_page_tool' };

  let wroteAny = false;
  try {
    const signal = mergeSignals(
      mergeSignals(ctx.signal, ctx.shutdownSignal),
      AbortSignal.timeout(60_000),
    );
    const response = await gatewayChat({
      model,
      system: `${systemPrompt}\n\nONESHOT CONTRACT: Return JSON only: {"pages":[{"slug":"...","content":"complete markdown"}],"skip_reason":null}. Maximum 3 pages. Return pages:[] with a non-empty skip_reason when nothing meets the bar. Do not call tools.`,
      messages: [{ role: 'user', content: data.prompt }],
      maxTokens: 8192,
      abortSignal: signal,
    });
    const parsed = parseOneshotPayload(response.text, data.oneshot_slug_suffix);
    const pages = parsed.pages;
    const tokens = {
      in: response.usage.input_tokens,
      out: response.usage.output_tokens,
      cache_read: response.usage.cache_read_tokens,
      cache_create: response.usage.cache_creation_tokens,
    };
    if (pages.length === 0) {
      return {
        kind: 'success',
        result: {
          result: `oneshot: nothing met the bar — ${parsed.skipReason}`,
          turns_count: 1, stop_reason: 'end_turn', tokens,
          synth_mode_used: 'oneshot', written_slugs: [],
        },
      };
    }
    // Validate the complete write set before the first mutation. This avoids
    // a partially committed oneshot when a later slug is malformed or outside
    // the same namespace fence enforced by brain_put_page.
    const { validatePageSlug, matchesSlugAllowList } = await import('../../operations.ts');
    for (const page of pages) {
      validatePageSlug(page.slug);
      if (data.allowed_slug_prefixes && data.allowed_slug_prefixes.length > 0) {
        if (!matchesSlugAllowList(page.slug, data.allowed_slug_prefixes)) {
          throw new Error(`oneshot slug outside allowed prefixes: ${page.slug}`);
        }
      } else if (!page.slug.startsWith(`wiki/agents/${ctx.id}/`)) {
        throw new Error(`oneshot slug outside agent namespace: ${page.slug}`);
      }
    }
    const invocation = createHash('sha256').update(data.prompt).digest('hex').slice(0, 8);
    const written: string[] = [];
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!;
      const toolUseId = `${prefix}${invocation}-p${index}`;
      await persistToolExecPending(engine, ctx.id, index, toolUseId, putPage.name, page);
      try {
        await putPage.execute(page, { engine, jobId: ctx.id, remote: true, signal });
        await persistToolExecComplete(engine, ctx.id, toolUseId, { slug: page.slug });
        wroteAny = true;
        written.push(page.slug);
      } catch (error) {
        await persistToolExecFailed(
          engine, ctx.id, index, toolUseId, putPage.name, page,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
    await ctx.updateTokens({ input: tokens.in, output: tokens.out, cache_read: tokens.cache_read });
    return {
      kind: 'success',
      result: {
        result: `oneshot: wrote ${written.length} page(s): ${written.join(', ')}`,
        turns_count: 1, stop_reason: 'end_turn', tokens,
        synth_mode_used: 'oneshot', written_slugs: written,
      },
    };
  } catch (error) {
    // User/shutdown cancellation is terminal. Falling back to the agentic
    // loop would violate the same AbortSignal contract the oneshot uses.
    if (ctx.signal.aborted || ctx.shutdownSignal.aborted) throw error;
    // After a committed write, never fall into a second nondeterministic path.
    // Let the durable job retry recover from the ledger above.
    if (wroteAny) throw error;
    return { kind: 'fallback', reason: error instanceof Error ? error.message : 'oneshot_failed' };
  }
}

/** Provider-neutral prompt-too-long classifier with a bounded `.cause` walk. */
export function promptTooLongDetail(err: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const shaped = current as {
      message?: unknown;
      status?: unknown;
      error?: { message?: unknown; type?: unknown };
      cause?: unknown;
    };
    const candidates = [shaped.message, shaped.error?.message]
      .filter((value): value is string => typeof value === 'string');
    for (const candidate of candidates) {
      if (/prompt is too long|context length|context window|maximum context|too many tokens/i.test(candidate)) {
        return candidate;
      }
    }
    const type = shaped.error?.type;
    if (shaped.status === 400 && (type === 'invalid_request_error' || type === 'request_too_large')) {
      const detailed = candidates.find((candidate) => /too long|exceed|maximum/i.test(candidate));
      if (detailed) return detailed;
    }
    current = shaped.cause;
  }
  return null;
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
  // v0.38 Slice 1 D5 — read-time shim for crash-replay across the v1→v2
  // content_blocks shape boundary. Exposed for test/subagent-v1-v2-shim.test.ts
  // which pins legacy-row adaptation correctness.
  adaptContentBlocksToChatBlocks,
  loadPriorToolsV2,
};
