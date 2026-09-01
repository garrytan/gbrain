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
import { loadConfig, isConfigTruthy } from '../../config.ts';
import { buildBrainTools, filterAllowedTools } from '../tools/brain-allowlist.ts';
import {
  acquireLease,
  releaseLease,
  RateLeaseUnavailableError,
  renewLeaseWithBackoff,
} from '../rate-leases.ts';
import {
  logSubagentSubmission,
  logSubagentHeartbeat,
} from './subagent-audit.ts';
import { resolveModel, isAnthropicProvider, isOpenRouterSubagentFamily, TIER_DEFAULTS } from '../../model-config.ts';
import { splitProviderModelId, normalizeModelId } from '../../model-id.ts';
import { resolveAnthropicKey } from '../../ai/anthropic-key.ts';
import { buildSystemPrompt, DEFAULT_SUBAGENT_SYSTEM } from '../system-prompt.ts';
import { toolLoop as gatewayToolLoop, isThinkingByDefaultModel, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../ai/gateway.ts';
import type { ChatToolDef, ChatMessage, ChatBlock, ChatResult, ToolHandler } from '../../ai/gateway.ts';
import { classifyCapabilities } from '../../ai/capabilities.ts';
import { runSubagentOneshot, ONESHOT_TOOL_USE_ID_PREFIX } from './subagent-oneshot.ts';
import type { OneshotFallbackReason } from '../types.ts';
import {
  loadPriorMessages,
  loadPriorTools,
  loadPriorToolsV2,
  persistMessage,
  persistToolExecPending,
  persistToolExecComplete,
  persistToolExecFailed,
  finalizeWriteAccounting,
  type PersistedMessage,
  type PersistedToolExec,
} from './subagent-persistence.ts';
import { randomUUIDv7 } from 'bun';

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_RATE_KEY = 'anthropic:messages';

/**
 * Resolve the per-turn output-token cap (#2778). Per-job data wins, then the
 * `agent.max_output_tokens` config row, then a model-aware default: 32000 for
 * thinking-by-default Claude 5 models (#4087 — they burn most of the budget on
 * internal reasoning; the flat 8192 default produced zero-tool-call truncated
 * runs even after the gateway learned to detect them), 8192 for everything
 * else (was a hardcoded 4096 that made pages >~12KB unwritable via put_page).
 * Invalid values (NaN / zero / negative) fall through to the next tier.
 */
export function resolveMaxOutputTokens(
  perJob: number | undefined,
  configRaw: string | null | undefined,
  model?: string,
): number {
  if (typeof perJob === 'number' && Number.isFinite(perJob) && perJob > 0) {
    return Math.floor(perJob);
  }
  if (typeof configRaw === 'string' && configRaw.trim() !== '') {
    const n = Number(configRaw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return isThinkingByDefaultModel(model) ? THINKING_MODEL_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
}

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
  /**
   * #4216 test seam — chat transport for the oneshot runner (extract-atoms
   * `_chat` pattern). Defaults to the gateway chat.
   */
  _chat?: typeof import('../../ai/gateway.ts').chat;
}

// ── Public handler factory ──────────────────────────────────

/**
 * Build a subagent handler bound to a specific engine. `registerBuiltin
 * Handlers` wires this up as `worker.register('subagent', handler)` at
 * worker startup. Always registered — `ANTHROPIC_API_KEY` is the natural
 * cost gate and `PROTECTED_JOB_NAMES` gates submission.
 */

/**
 * F1 (adversarial review): a replayed terminal assistant turn that hit the
 * output cap must NOT launder into 'end_turn'. The zero-attempt honesty gate
 * (finalizeWriteAccounting) keys on stop_reason, and a truncated zero-write
 * run replaying as a clean finish would consume the transcript's idempotency
 * key with zero pages written — the exact silent-loss class #4217 kills. The
 * live stop reason is not persisted; `tokens_out >= cap` recovers it (a
 * length stop reports the capped count). A clean turn producing EXACTLY cap
 * tokens is a theoretical false positive; its consequence is dead-letter +
 * key release + nightly retry — self-healing, never silent loss.
 */
/**
 * Convert a lease-lost abort into the lease-full requeue vocabulary. When
 * the per-turn permit heartbeat discovers its lease row vanished, it aborts
 * the in-flight provider call; the surfacing AbortError is a SCHEDULING
 * condition (slot re-admitted elsewhere), not a job failure — rethrow as
 * RateLeaseUnavailableError so the worker / inline drain requeue WITHOUT
 * burning an attempt.
 */
async function runLoopConvertingLeaseLoss<T>(
  run: () => Promise<T>,
  wasLeaseLost: () => boolean,
  leaseKey: string,
  maxConcurrent: number,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (wasLeaseLost()) {
      throw new RateLeaseUnavailableError(leaseKey, maxConcurrent, maxConcurrent);
    }
    // Same terminal classification the legacy raw-SDK path applies below
    // (see isPromptTooLongError's call site): a 400 "prompt is too long" is
    // unrecoverable — retrying with the same prompt will always fail the
    // same way. `e` here is already normalizeAIError()-wrapped (thrown by
    // gateway.chat()'s catch boundary), which copies only the OUTER message
    // onto the new error and stores the raw provider error on `.cause` —
    // isPromptTooLongError() walks that cause chain so the SDK's inner
    // `.error.message` shape (Anthropic's actual wire shape) still matches
    // post-wrap. Without this, a gateway-native subagent job (required for
    // any non-Anthropic model) retries a prompt-too-long condition like any
    // other transient failure up to max_stalled instead of fast-failing —
    // the exact dream-cycle queue-clog class the legacy-path fix was built
    // to prevent, just on the newer path.
    // Single walk: extractPromptTooLongDetail is non-null exactly when
    // isPromptTooLongError matches (both wrap the same matcher). The detail is
    // the matched provider text ("prompt is too long: N tokens > max"), not
    // `e.message` — post-normalizeAIError that is only the generic outer
    // wrapper; the useful token counts live on `.cause`, same as the match.
    const detail = extractPromptTooLongDetail(e);
    if (detail !== null) throw new UnrecoverableError(`prompt_too_long: ${detail}`);
    throw e;
  }
}

function replayTerminalStopReason(
  tokensOut: number | null | undefined,
  maxOutputTokens: number,
): SubagentStopReason {
  return tokensOut != null && tokensOut >= maxOutputTokens ? 'max_tokens' : 'end_turn';
}

export function makeSubagentHandler(deps: SubagentDeps) {
  const engine = deps.engine;
  // sdk.messages IS the MessagesClient-shaped object. The v0.16.0 bug was
  // casting new Anthropic() (top level) to MessagesClient, but .create()
  // lives at sdk.messages.create. Assigning sdk.messages directly gets the
  // right object; JS method-call semantics preserve `this` at the call
  // site (subagent.ts invokes client.create(...) with client === sdk.messages).
  // Resolve the key env-first, then config (anthropic_api_key) — a bare
  // new Anthropic() only reads env, so launchd/MCP workers whose key lives
  // in the gbrain config file would fail auth (#2048).
  const makeAnthropic = deps.makeAnthropic ?? (() => new Anthropic({ apiKey: resolveAnthropicKey() }));
  const client: MessagesClient = deps.client ?? makeAnthropic().messages;
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as GBrainConfig);
  const rateLeaseKey = deps.rateLeaseKey ?? DEFAULT_RATE_KEY;
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return async function subagentHandler(ctx: MinionJobContext): Promise<SubagentResult> {
    const dataForAccounting = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    // #4217: every subagent job gets structural write accounting merged into
    // its result; jobs submitted with require_writes (dream synthesize /
    // patterns fan-out) FAIL when every attempted put_page write failed —
    // "the turn finished" must never masquerade as "the work succeeded".
    const modeState: {
      fallbackReason?: OneshotFallbackReason;
      oneshotTokens?: { in: number; out: number; cache_read: number; cache_create: number };
    } = {};
    const inner = await subagentHandlerInner(ctx, modeState);
    // #4216: stamp which execution path produced the result. Jobs with no
    // `mode` field keep the legacy result shape (REGRESSION pin).
    // Honesty rule: 'agentic_fallback' is stamped ONLY when the oneshot
    // attempt actually ran and returned a fallback reason this invocation. A
    // replayed already-successful oneshot job (messages persisted, outcome
    // write lost) re-enters via the loop replay path with no marker — leaving
    // synth_mode_used unset there is honest 'unknown/replay', never a fake
    // fallback in phase telemetry.
    const stamped: SubagentResult = dataForAccounting.mode === 'oneshot' && inner.synth_mode_used !== 'oneshot' && modeState.fallbackReason
      ? {
          ...inner,
          synth_mode_used: 'agentic_fallback',
          fallback_reason: modeState.fallbackReason,
          // The PAID oneshot attempt is part of this job's real cost/turn
          // count — fold it into the rollup instead of silently dropping a
          // full model call from details.synthesis math.
          ...(modeState.oneshotTokens
            ? {
                turns_count: inner.turns_count + 1,
                tokens: {
                  in: inner.tokens.in + modeState.oneshotTokens.in,
                  out: inner.tokens.out + modeState.oneshotTokens.out,
                  cache_read: inner.tokens.cache_read + modeState.oneshotTokens.cache_read,
                  cache_create: inner.tokens.cache_create + modeState.oneshotTokens.cache_create,
                },
              }
            : {}),
        }
      : dataForAccounting.mode === 'agentic' && !inner.synth_mode_used
        ? { ...inner, synth_mode_used: 'agentic' }
        : inner;
    return finalizeWriteAccounting(engine, ctx.id, stamped, {
      requireWrites: dataForAccounting.require_writes === true,
      // OV-4: a successful oneshot job's verdict is scoped to its own
      // invocation family; a fallback wrote through the loop (no oneshot
      // rows exist — validation precedes all writes), so job-wide is exact.
      ...(stamped.synth_mode_used === 'oneshot' ? { scopeToolUseIdPrefix: ONESHOT_TOOL_USE_ID_PREFIX } : {}),
    });
  };

  async function subagentHandlerInner(
    ctx: MinionJobContext,
    modeState: {
    fallbackReason?: OneshotFallbackReason;
    oneshotTokens?: { in: number; out: number; cache_read: number; cache_create: number };
  } = {},
  ): Promise<SubagentResult> {
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
    const model = data.model
      ?? await resolveModel(engine, {
        tier: 'subagent',
        configKey: 'models.subagent',
        fallback: TIER_DEFAULTS.subagent,
      });

    // Refuse-at-handler-entry on the FINAL resolved model, not just an
    // explicit data.model: `models.subagent` config resolves through
    // resolveModel's explicit-key branch, which does NOT run
    // enforceSubagentCapable's silent fallback (only the inherited
    // models.default / tier / env branches do). An explicitly chosen
    // loop-incapable model must be refused loudly here rather than silently
    // run a loop that can't dispatch tools or can't reconcile on replay.
    // The queue.ts gate already catches explicit data.model at submit; this
    // check additionally covers config-resolved models, direct `gbrain agent
    // run` invocations, and any path that bypasses the queue's check.
    //
    // Exception (#1151 precedent): a replayed job whose last persisted
    // message is a terminal assistant turn (no tool_use blocks) needs NO
    // further provider call — the path-specific replay logic below returns
    // the already-committed result. Don't let a capability refusal (e.g.
    // config repointed to a loop-incapable model between submit and replay)
    // dead-letter completed work.
    {
      const lastRows = await engine.executeRaw<{ role: string; content_blocks: unknown }>(
        `SELECT role, content_blocks FROM subagent_messages
          WHERE job_id = $1 ORDER BY message_idx DESC LIMIT 1`,
        [ctx.id],
      );
      const lastRow = lastRows[0];
      const lastBlocks = lastRow
        ? (typeof lastRow.content_blocks === 'string'
            ? JSON.parse(lastRow.content_blocks)
            : lastRow.content_blocks) as Array<{ type?: string; text?: unknown }>
        : null;
      // Terminal = assistant turn with NO pending tool dispatch in EITHER
      // block vocabulary (legacy Anthropic `tool_use`, gateway `tool-call`)
      // AND actual text (the gateway terminal rule) — a pending-tool replay
      // must still pass the gate before the loop resumes on the provider.
      const alreadyTerminal = lastRow?.role === 'assistant'
        && Array.isArray(lastBlocks)
        && !lastBlocks.some(b => b?.type === 'tool_use' || b?.type === 'tool-call')
        && lastBlocks.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '');
      const modelSource = data.model ? 'data.model' : 'the resolved subagent model config';
      // A BARE Anthropic id (`claude-sonnet-4-6`, no `provider:` prefix) is a
      // supported value everywhere else: isAnthropicProvider() has an explicit
      // bare-`claude-` branch, the legacy path strips the prefix before calling
      // the Messages API, and this handler's own DEFAULT_MODEL is bare.
      // classifyCapabilities() resolves through the recipe registry, which
      // requires an explicit provider, so classifying the raw value would
      // report `unknown` and refuse a working config. Normalize first — the
      // dream cycle does the same before queueing children
      // (src/core/cycle/synthesize.ts). Narrow on purpose: only bare ids that
      // isAnthropicProvider() recognizes are normalized, so a bare
      // non-Anthropic id still classifies as `unknown` and is still refused.
      const modelForVerdict = splitProviderModelId(model).provider === null && isAnthropicProvider(model)
        ? normalizeModelId(model)
        : model;
      const verdict = alreadyTerminal ? 'ok' : classifyCapabilities(modelForVerdict);
      if (verdict === 'unusable:no_tools') {
        throw new Error(
          `subagent job rejected: ${modelSource} "${model}" lacks native tool calling. ` +
          `The subagent loop dispatches brain ops via tool calls — without tool support the loop has no way to run.`,
        );
      }
      if (verdict === 'unusable:no_subagent_loop') {
        throw new Error(
          `subagent job rejected: ${modelSource} "${model}" comes from a provider whose recipe declares ` +
          `supports_subagent_loop: false — its tool_call_ids are not stable enough across crashes/replays ` +
          `to drive the subagent loop.`,
        );
      }
      if (verdict === 'unknown') {
        throw new Error(
          `subagent job rejected: ${modelSource} "${model}" references an unknown provider. ` +
          `Use format provider:model where provider matches a recipe in src/core/ai/recipes/.`,
        );
      }
    }
    const maxTurns = data.max_turns ?? DEFAULT_MAX_TURNS;
    // #2778: per-turn output cap — data.max_tokens → config → model-aware
    // default (#4087/CDX-6: thinking-by-default Claude 5 models get 32k so the
    // 8192 handler default stops masking the gateway's own headroom; explicit
    // per-job/config values always win).
    const maxOutputTokens = resolveMaxOutputTokens(
      data.max_tokens,
      await engine.getConfig('agent.max_output_tokens').catch(() => null),
      model,
    );
    // v0.41 Approach C: systemPrompt is now built AFTER toolDefs (a few
    // lines below) so the renderer can splice a tool-usage preamble
    // listing each available tool's usage_hint. The renderer is
    // deterministic so the Anthropic prompt-cache marker on the system
    // block stays a hit across turns.

    // v0.38 S1.10 — feature flag for the gateway-native tool loop. When ON,
    // route ALL subagent jobs through gateway.toolLoop() (works for every
    // provider in src/core/ai/recipes/). When OFF, route through the legacy
    // Anthropic-direct path AND refuse non-Anthropic models loudly.
    const useGatewayLoopRaw = await engine.getConfig('agent.use_gateway_loop').catch(() => null);
    // #2753: share the doctor's truthiness set. Before this, the doctor accepted
    // yes/on but the worker did not, so `config set ... yes` reported healthy
    // here and still refused the job below.
    // OpenRouter routes are not `isAnthropicProvider` (the Messages SDK
    // cannot speak OR). Auto-enable the gateway loop for the OR families
    // that have a live abort/retry pin (anthropic/, deepseek/) so the legacy
    // pin does not refuse them when the flag is off.
    const useGatewayLoop = isConfigTruthy(useGatewayLoopRaw) || isOpenRouterSubagentFamily(model);
    if (!useGatewayLoop && !isAnthropicProvider(model)) {
      throw new Error(
        `subagent job: resolved model "${model}" is non-Anthropic but agent.use_gateway_loop is not enabled. ` +
        `Enable the gateway-native loop to run on this provider: ` +
        `\`gbrain config set agent.use_gateway_loop true\`. ` +
        `Or use an Anthropic model (e.g. anthropic:claude-sonnet-4-6).`,
      );
    }

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
      // #1586: cycle-resolved source scope for tool-call OperationContexts.
      sourceId: data.source_id,
    });
    const toolDefs = data.allowed_tools && data.allowed_tools.length > 0
      ? filterAllowedTools(registry, data.allowed_tools)
      : registry;

    // v0.41 Approach C: render the final system prompt now that toolDefs
    // is known. Splices a deterministic tool-usage preamble listing each
    // tool's usage_hint. Caller can opt out via data.system_no_tool_preamble.
    const systemPrompt = buildSystemPrompt(toolDefs, data.system, {
      no_tool_preamble: data.system_no_tool_preamble,
    });

    logSubagentSubmission({
      caller: 'worker',
      remote: true,
      job_id: ctx.id,
      model,
      tools_count: toolDefs.length,
      allowed_tools: toolDefs.map(t => t.name),
    });

    // OV-10: provider-derived lease key. Anthropic-family models keep the
    // legacy 'anthropic:messages' bucket (one shared ceiling per API, not
    // one per code path); everything else gets its own recipe bucket.
    const recipeId = recipeIdFromModel(model);
    const gatewayLeaseKey = deps.rateLeaseKey
      ?? (recipeId === 'anthropic' ? DEFAULT_RATE_KEY : `${recipeId}:chat`);

    // ── #4216 oneshot dispatch ──────────────────────────────
    // Runs ONLY on a fresh job (CDX-2: zero persisted messages — any prior
    // rows mean a crash-replay that the path-specific replay logic below must
    // own; the ledger-first recovery inside the runner covers post-write
    // crashes because a successful attempt persists its transcript LAST).
    if (data.mode === 'oneshot') {
      const freshRows = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM subagent_messages WHERE job_id = $1`,
        [ctx.id],
      );
      let dispatchOneshot = (freshRows[0]?.n ?? 0) === 0;
      if (!dispatchOneshot) {
        // Transcript persistence is two INSERTs; a crash between them leaves
        // messages WITHOUT a terminal assistant row, and the loop replay
        // below would re-call a nondeterministic model with the oneshot
        // pages ALREADY WRITTEN (near-duplicate pages under the same hash
        // suffix). Oneshot ledger rows exist only after full validation on
        // the oneshot path, so their presence routes to the runner's
        // idempotent ledger-first recovery instead of the loop.
        const ledger = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT 1 FROM subagent_tool_executions
              WHERE job_id = $1 AND tool_use_id LIKE $2 LIMIT 1) t`,
          [ctx.id, `${ONESHOT_TOOL_USE_ID_PREFIX}%`],
        );
        dispatchOneshot = (ledger[0]?.n ?? 0) > 0;
      }
      if (dispatchOneshot) {
        // Rebuild put_page with deferEmbeds so the embed network call leaves
        // the model path (the standing embed machinery backfills).
        const oneshotRegistry = deps.toolRegistry ?? buildBrainTools({
          subagentId: ctx.id,
          engine,
          config,
          brainId: data.brain_id,
          allowedSlugPrefixes: data.allowed_slug_prefixes,
          sourceId: data.source_id,
          deferEmbeds: true,
        });
        // Honor allowed_tools EXACTLY like the loop registry — a submitter
        // that scoped its job read-only must not gain write capability by
        // setting mode: oneshot (put_page filtered out → no_put_page_tool
        // fallback → the equally-filtered loop).
        const oneshotTools = data.allowed_tools && data.allowed_tools.length > 0
          ? filterAllowedTools(oneshotRegistry, data.allowed_tools)
          : oneshotRegistry;
        const outcome = await runSubagentOneshot({
          engine,
          ctx,
          data,
          model,
          maxOutputTokens,
          putPageTool: oneshotTools.find(t => t.name === 'brain_put_page'),
          leaseKey: gatewayLeaseKey,
          maxConcurrent,
          leaseTtlMs,
          _chat: deps._chat,
        });
        if (outcome.kind === 'done') return outcome.result;
        modeState.fallbackReason = outcome.reason;
        if (outcome.tokens) modeState.oneshotTokens = outcome.tokens;
        logSubagentHeartbeat({ job_id: ctx.id, event: 'oneshot_fallback', turn_idx: 0, reason: outcome.reason, mode: 'oneshot' });
      }
    }

    // v0.38 S1.5 — gateway path. Route here when the feature flag is on.
    if (useGatewayLoop) {
      return await runSubagentViaGateway({
        engine,
        ctx,
        data,
        model,
        systemPrompt,
        toolDefs,
        maxTurns,
        maxOutputTokens,
        leaseKey: gatewayLeaseKey,
        maxConcurrent,
        leaseTtlMs,
      });
    }

    // ── Load prior state (replay) ───────────────────────────
    const priorMessages = await loadPriorMessages(engine, ctx.id);
    const priorTools = await loadPriorTools(engine, ctx.id);
    // Keyed by (message_idx, tool_use_id) — raw provider tool_use_ids may
    // repeat across turns (#4155), so tool_use_id alone could resolve a
    // sibling turn's execution row. WITHIN a turn this legacy path relies on
    // the Anthropic-direct invariant that ids are unique per message (the
    // whole loop is Anthropic-pinned for exactly that stability — see
    // src/core/ai/capabilities.ts); the gateway path carries D11 ordinals
    // for providers without that guarantee.
    const priorToolByUseId = new Map(priorTools.map(t => [`${t.message_idx}:${t.tool_use_id}`, t]));

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
        return {
          result: finalText,
          turns_count: assistantTurns,
          stop_reason: replayTerminalStopReason(last.tokens_out, maxOutputTokens),
          tokens: tokenTotals,
        };
      }
      if (pendingToolUses.length > 0) {
        const synthesizedResults: ContentBlock[] = [];
        for (const [useOrdinal, use] of pendingToolUses.entries()) {
          const prior = priorToolByUseId.get(`${last.message_idx}:${use.id}`);
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
              engine, ctx.id, last.message_idx, useOrdinal, use.id, use.name, use.input,
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
          await persistToolExecPending(engine, ctx.id, last.message_idx, useOrdinal, use.id, use.name, use.input);
          try {
            const output = await toolDef.execute(use.input, {
              engine, jobId: ctx.id, remote: true, signal: ctx.signal,
            });
            await persistToolExecComplete(engine, ctx.id, last.message_idx, useOrdinal, use.id, output);
            synthesizedResults.push({
              type: 'tool_result', tool_use_id: use.id,
              content: asStringIfNotObject(output),
            } as ContentBlock);
          } catch (e) {
            const errText = e instanceof Error ? (e.stack ?? e.message) : String(e);
            await persistToolExecFailed(engine, ctx.id, last.message_idx, useOrdinal, use.id, use.name, use.input, errText);
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

      // Heartbeat the lease at ttl/3: pre-wave the initial TTL covered every
      // request, but CDX-6 raised thinking-model turns to 32k output tokens
      // and a single call can now outlive 120s — a pruned live lease gets
      // back-filled past maxConcurrent.
      const leaseLost = new AbortController();
      let leaseLostMidCall = false;
      let renewInFlight = false;
      const leaseRenewTimer = setInterval(() => {
        // Single-flight (R3-2): a stalled renewal during a pooler outage must
        // not stack — N children x overlapping renewals would exhaust the
        // pool that lock renewal and job recording also need.
        if (renewInFlight) return;
        renewInFlight = true;
        void renewLeaseWithBackoff(engine, lease.leaseId!, leaseTtlMs)
          .then((ok) => {
            if (!ok) {
              // Row pruned/stolen — the slot is already re-admitted. Abort
              // the in-flight call (renewLeaseWithBackoff contract) instead
              // of running above maxConcurrent; converted below to a
              // lease-full requeue (no attempt burn).
              leaseLostMidCall = true;
              leaseLost.abort();
            }
          })
          .catch(() => { /* next tick retries */ })
          .finally(() => { renewInFlight = false; });
      }, Math.max(5_000, Math.floor(leaseTtlMs / 3)));
      (leaseRenewTimer as unknown as { unref?: () => void }).unref?.();
      try {
        // --- Patch B (borrow-ahead, hand-authored): rolling conversation prompt-cache ---
        // Direct path marks cache_control only on static system(485)+last-tool(498) ~5.2K;
        // the growing anthroMessages conversation is re-billed every turn (6/18 v0.42.51
        // regression). Anthropic caches up to the last cache_control block, so mark the last
        // content block of the last message and keep the 4-breakpoint API limit
        // (system + last-tool + 2 rolling = 4).
        //
        // Two rolling markers, not one: Anthropic's automatic cache lookup only walks
        // back up to 20 content blocks from a breakpoint to find a prior cached prefix
        // (see prompt-caching docs, "20-block lookback window"). A turn that adds more
        // than 20 blocks since the last marker (e.g. a large parallel tool_use/tool_result
        // round) would make a freshly-placed single marker miss the previous cache
        // entirely. Keeping the immediately-preceding rolling marker in place — and only
        // evicting anything older than that — guarantees at least that marker's prefix is
        // still a valid, already-written cache read even when this turn's new marker's
        // lookback comes up empty.
        if (anthroMessages.length > 0) {
          const markerIndices: number[] = [];
          for (let i = 0; i < anthroMessages.length; i++) {
            const m = anthroMessages[i] as any;
            if (Array.isArray(m.content)) {
              for (const b of m.content) {
                if (b && typeof b === 'object' && 'cache_control' in b) {
                  markerIndices.push(i);
                  break;
                }
              }
            }
          }
          const keepIdx = markerIndices.length > 0 ? markerIndices[markerIndices.length - 1] : -1;
          for (const i of markerIndices) {
            if (i === keepIdx) continue;
            const m = anthroMessages[i] as any;
            for (const b of m.content) {
              if (b && typeof b === 'object' && 'cache_control' in b) delete b.cache_control;
            }
          }
          const lastMsg = anthroMessages[anthroMessages.length - 1] as any;
          // A fresh job's seed message has string content (see the
          // `[{ role: 'user', content: data.prompt }]` init above), which
          // the array-only check below would silently skip — leaving the
          // very first call, and thus the common single-tool round-trip,
          // with no rolling breakpoint at all. Normalize to a one-block
          // array first so it gets the marker like every later turn.
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = [{ type: 'text', text: lastMsg.content }];
          }
          if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
            const lastBlock = lastMsg.content[lastMsg.content.length - 1];
            if (lastBlock && typeof lastBlock === 'object') {
              lastBlock.cache_control = { type: 'ephemeral' };
            }
          }
        }
        // --- end Patch B ---
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          // v0.41 Bug 3: strip `provider:` prefix at the SDK call site only.
          // `model` stays qualified everywhere else (persistence, recipe
          // lookup at recipeIdFromModel(), capability gate).
          model: stripProviderPrefix(model),
          max_tokens: maxOutputTokens,
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ] as any,
          messages: anthroMessages,
          ...(toolDefs.length > 0
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

        const combinedSignal = mergeSignals(mergeSignals(ctx.signal, ctx.shutdownSignal), leaseLost.signal);
        assistantMsg = await client.create(params, { signal: combinedSignal });
      } catch (err) {
        // Release lease eagerly on error so we don't starve capacity.
        clearInterval(leaseRenewTimer);
        await releaseLease(engine, lease.leaseId!).catch(() => {});
        if (leaseLostMidCall) {
          throw new RateLeaseUnavailableError(rateLeaseKey, maxConcurrent, maxConcurrent);
        }
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
      clearInterval(leaseRenewTimer);
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
        // #2778: an output-cap hit is NOT end_turn — the text (and possibly a
        // dropped trailing tool_use block) is truncated. Surface it as its own
        // stop_reason instead of silently reporting a clean end_turn.
        stopReason = assistantMsg.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn';
        // Concatenate text blocks as the final answer.
        finalText = blocks
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n');
        break;
      }

      // 5. Dispatch each tool_use. Two-phase persist (pending → complete/failed).
      const toolResults: ContentBlock[] = [];
      for (const [useOrdinal, use] of toolUses.entries()) {
        if (ctx.signal.aborted || ctx.shutdownSignal.aborted) {
          throw new Error('subagent aborted during tool dispatch');
        }

        const toolName = use.name;
        const toolDef = toolDefs.find(t => t.name === toolName);
        if (!toolDef) {
          // Model called a tool we didn't expose. Mark execution failed
          // with a clear error and feed the error back in the next turn.
          await persistToolExecFailed(
            engine, ctx.id, assistantIdx, useOrdinal, use.id, toolName, use.input,
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

        // Replay: if we already have a row for this turn's tool_use_id,
        // trust it unless status='pending' and the tool is idempotent
        // (re-run). Keyed by (message_idx, tool_use_id) — see #4155.
        const prior = priorToolByUseId.get(`${assistantIdx}:${use.id}`);
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
        await persistToolExecPending(engine, ctx.id, assistantIdx, useOrdinal, use.id, toolName, use.input);
        logSubagentHeartbeat({ job_id: ctx.id, event: 'tool_called', turn_idx: turnIdx, tool_name: toolName });

        const toolStart = Date.now();
        try {
          const output = await toolDef.execute(use.input, {
            engine,
            jobId: ctx.id,
            remote: true,
            signal: ctx.signal,
          });
          await persistToolExecComplete(engine, ctx.id, assistantIdx, useOrdinal, use.id, output);
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
          await persistToolExecFailed(engine, ctx.id, assistantIdx, useOrdinal, use.id, toolName, use.input, errText);
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

      // #2778: a max_tokens stop with tool_use blocks means the API dropped an
      // incomplete trailing block (e.g. a large put_page body that overflowed
      // the cap). Tell the model so it re-issues the cut-off call (split, or
      // smaller pages) instead of assuming the write happened.
      if (assistantMsg.stop_reason === 'max_tokens') {
        toolResults.push({
          type: 'text',
          text: `[system] Your previous response hit the ${maxOutputTokens}-token output cap and was truncated; ` +
            `any tool call cut off by the cap was DROPPED and did not execute. Re-issue it, splitting large content if needed.`,
        } as ContentBlock);
        logSubagentHeartbeat({
          job_id: ctx.id,
          event: 'llm_call_completed',
          turn_idx: turnIdx,
          error: `stop_reason=max_tokens at cap ${maxOutputTokens}; truncation note injected`,
        });
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

    return {
      result: finalText,
      turns_count: assistantTurns,
      stop_reason: stopReason,
      tokens: tokenTotals,
    };
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
  /** #2778: per-turn output-token cap (resolved by resolveMaxOutputTokens). */
  maxOutputTokens: number;
  /**
   * #4194/CDX-7 — per-turn rate-lease parameters. Pre-fix the gateway path
   * made provider calls with no lease at all (the legacy loop's acquisition
   * lives inside its own turn loop), so inline_concurrency > 1 could exceed
   * the provider ceiling. Key is provider-derived (OV-10): Anthropic models
   * share the legacy 'anthropic:messages' bucket; other providers get their
   * own '<recipeId>:chat' bucket instead of contending for Anthropic slots.
   */
  leaseKey: string;
  maxConcurrent: number;
  leaseTtlMs: number;
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
  const { engine, ctx, data, model, systemPrompt, toolDefs, maxTurns, maxOutputTokens, leaseKey, maxConcurrent, leaseTtlMs } = args;

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
  const priorTools = await loadPriorToolsV2(engine, ctx.id);
  const priorToolsByStableKey = new Map<string, { status: 'pending' | 'complete' | 'failed'; output?: unknown; error?: string }>();
  for (const row of priorTools) {
    priorToolsByStableKey.set(row.stableKey, {
      status: row.status,
      output: row.output,
      error: row.error ?? undefined,
    });
  }

  // Token rollup across the prior transcript (returned as-is on the terminal
  // early-return path; the loop adds only NEW-turn usage otherwise).
  const priorTokens = { in: 0, out: 0, cache_read: 0, cache_create: 0 };
  for (const m of priorMessages) {
    if (m.tokens_in) priorTokens.in += m.tokens_in;
    if (m.tokens_out) priorTokens.out += m.tokens_out;
    if (m.tokens_cache_read) priorTokens.cache_read += m.tokens_cache_read;
    if (m.tokens_cache_create) priorTokens.cache_create += m.tokens_cache_create;
  }

  // Reconcile an unbalanced transcript from a prior crashed/resumed run. The
  // gateway loop persists each assistant turn but (pre-fix) never persisted the
  // following tool-result user turn, so a resumed job reloads assistant
  // tool-calls with no matching results — which non-Anthropic (openai-compat)
  // providers reject with AI_MissingToolResultsError, dead-lettering the job.
  // reconcileGatewayReplay heals every such dangling turn from settled tool
  // executions (mirroring the legacy Anthropic path) and reports the terminal
  // case where the prior run already reached end_turn.
  const priorToolsV1 = await loadPriorTools(engine, ctx.id);
  const { chatMessages: priorChatMessages, nextMessageIdx: reconciledNextIdx, terminalText } =
    await reconcileGatewayReplay({
      engine,
      jobId: ctx.id,
      priorMessages,
      priorTools: priorToolsV1,
      toolDefs,
      signal: ctx.signal,
    });

  // Terminal early-return (#1151 parity): the prior run already reached
  // end_turn. Non-Anthropic providers reject a trailing assistant "prefill",
  // so surface the persisted text and skip the loop entirely.
  if (terminalText !== null) {
    const lastAssistant = [...priorMessages].reverse().find(m => m.role === 'assistant');
    return {
      result: terminalText,
      turns_count: priorChatMessages.filter(m => m.role === 'assistant').length,
      stop_reason: replayTerminalStopReason(lastAssistant?.tokens_out, maxOutputTokens),
      tokens: priorTokens,
    };
  }

  // Initial seed message if no prior state.
  const initialMessages: ChatMessage[] = priorChatMessages.length === 0
    ? [{ role: 'user', content: data.prompt }]
    : [];

  // Persist seed user message at idx 0 if fresh start. reconciledNextIdx is
  // max(known message_idx) + 1 (0 when no prior rows), which keeps the loop's
  // subsequent writes clear of any healed tool-result turn we just inserted.
  let nextMessageIdx = reconciledNextIdx;
  if (priorChatMessages.length === 0) {
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

  // Set by the per-turn permit heartbeat when its lease row vanished
  // mid-call (renewal returned false → in-flight request aborted). The
  // wrapper below converts the resulting abort into a lease-full requeue so
  // the job retries WITHOUT burning an attempt instead of dying on a
  // generic AbortError.
  let leaseLostDuringTurn = false;

  // Run the loop.
  const result = await runLoopConvertingLeaseLoss(
    () => gatewayToolLoop({
    model,
    system: systemPrompt,
    initialMessages,
    tools: chatTools,
    toolHandlers,
    maxTurns,
    maxTokens: maxOutputTokens,
    abortSignal: ctx.signal,
    cacheSystem,
    // #4194/CDX-7: every provider round-trip holds a rate-lease slot (worker
    // parity with the legacy loop's per-turn acquisition). Lease-full throws
    // RateLeaseUnavailableError out of the loop → worker/inline-drain requeue
    // WITHOUT burning an attempt.
    acquireTurnPermit: async () => {
      const lease = await acquireLease(engine, leaseKey, ctx.id, maxConcurrent, { ttlMs: leaseTtlMs });
      if (!lease.acquired) {
        throw new RateLeaseUnavailableError(leaseKey, lease.activeCount, lease.maxConcurrent);
      }
      // Thinking-model turns (32k output cap, CDX-6) can outlive the base
      // TTL; heartbeat at ttl/3 so a still-live call's lease is never pruned
      // and back-filled past maxConcurrent. unref: a heartbeat must never
      // hold the process open. A FALSE renewal means the row is gone (pruned
      // /stolen — the slot is already re-admitted): per the
      // renewLeaseWithBackoff contract the call must ABORT, not keep running
      // above the ceiling; the loop converts the abort to a lease-full
      // requeue via leaseLostDuringTurn.
      const leaseLost = new AbortController();
      let renewInFlight = false;
      const renewTimer = setInterval(() => {
        // Single-flight (R3-2): never stack renewals behind a stalled pool.
        if (renewInFlight) return;
        renewInFlight = true;
        void renewLeaseWithBackoff(engine, lease.leaseId!, leaseTtlMs)
          .then((ok) => {
            if (!ok) {
              leaseLostDuringTurn = true;
              leaseLost.abort();
            }
          })
          .catch(() => { /* next tick retries */ })
          .finally(() => { renewInFlight = false; });
      }, Math.max(5_000, Math.floor(leaseTtlMs / 3)));
      (renewTimer as unknown as { unref?: () => void }).unref?.();
      return {
        release: () => {
          clearInterval(renewTimer);
          return releaseLease(engine, lease.leaseId!).catch(() => { /* best-effort */ });
        },
        signal: leaseLost.signal,
      };
    },
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
      nextTurnIdx: priorChatMessages.filter(m => m.role === 'assistant').length,
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
      // #4155 — tool_use_id stores the RAW provider id, which is NOT unique
      // per job: some providers (claude-cli) hand back short, repeating ids
      // (e.g. "toolu_01" on every turn, since each `claude -p` (print mode)
      // call is a fresh subprocess replayed from an id-stripped transcript).
      // NOTE: spell it `-p`, not the long form — scripts/generate-flag-registry.ts
      // harvests flag-shaped literals out of comments too, and the long form
      // lands in the generated registry as a flag `jobs` does not accept.
      // The former job-wide `uniq_subagent_tools_use_id UNIQUE (job_id,
      // tool_use_id)` constraint encoded the false assumption that provider
      // ids are job-unique; a reuse collided (it was never this INSERT's
      // conflict target) and dead-lettered the job. Migration v131 dropped
      // it — row identity is (job_id, message_idx, ordinal), and every
      // reader resolves an execution by (message_idx, tool_use_id) or by
      // gbrain_tool_use_id, never by tool_use_id alone.
      const rows = await engine.executeRaw<{ gbrain_tool_use_id: string }>(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, gbrain_tool_use_id, provider_id)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, 'pending', 2, $6, $7, $8)
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
           SET status = 'complete', output = $1::text::jsonb, ended_at = now()
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
    // Persist the tool-result user turn so a resume reloads a balanced
    // transcript. JSON.stringify inside persistMessage ISO-izes any Date in
    // tool output, and the value binds through $N::text::jsonb (never
    // JSON.stringify into a bare ::jsonb).
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
    }),
    () => leaseLostDuringTurn,
    leaseKey,
    maxConcurrent,
  );

  // Map gateway stop reason to SubagentStopReason. 'length' (output-cap hit)
  // maps to 'max_tokens' — the #2778 honesty vocabulary the direct Anthropic
  // path already uses — NOT 'end_turn' (#4088: truncation is not a clean
  // finish). aborted maps to error.
  const stopReason: SubagentStopReason = result.stopReason === 'end'
    ? 'end_turn'
    : result.stopReason === 'length'
      ? 'max_tokens'
      : result.stopReason === 'max_turns'
        ? 'max_turns'
        : result.stopReason === 'refusal'
          ? 'refusal'
          : result.stopReason === 'content_filter'
            ? 'refusal'
            : result.stopReason === 'aborted'
              ? 'error'
              : 'end_turn';

  return {
    result: result.finalText,
    turns_count: result.totalTurns,
    stop_reason: stopReason,
    tokens: {
      in: result.totalUsage.input_tokens,
      out: result.totalUsage.output_tokens,
      cache_read: result.totalUsage.cache_read_tokens,
      cache_create: result.totalUsage.cache_creation_tokens,
    },
  };
}

interface ReconcileArgs {
  engine: BrainEngine;
  jobId: number;
  priorMessages: PersistedMessage[];
  priorTools: PersistedToolExec[];
  toolDefs: ToolDef[];
  signal: AbortSignal;
}

interface ReconcileResult {
  chatMessages: ChatMessage[];
  /** max(known/healed message_idx) + 1 — 0 when there is no prior transcript. */
  nextMessageIdx: number;
  /** Non-null when the transcript already ended on an assistant text turn. */
  terminalText: string | null;
}

/**
 * Heal an unbalanced gateway replay transcript before it reaches the provider.
 *
 * The gateway loop persists each assistant turn but historically never
 * persisted the following tool-result user turn, so a resumed job reloaded
 * assistant tool-calls with no matching results. Non-Anthropic (openai-compat)
 * providers reject that with AI_MissingToolResultsError and the job
 * dead-letters. This walks EVERY prior assistant turn that carries tool-call
 * blocks (not just the tail — a pre-fix multi-turn job persisted several
 * consecutive dangling assistant turns) and, if the turn isn't already answered
 * by the following tool-result user turn, synthesizes that turn from the
 * settled `subagent_tool_executions` rows with the same semantics as the legacy
 * Anthropic replay path:
 *   - complete            → stored output
 *   - failed              → stored error (isError)
 *   - idempotent-pending / missing row → re-dispatch, persist, use output
 *   - non-idempotent-pending           → throw (cannot safely re-run)
 *   - tool no longer registered        → persist failed + error stub
 * Each synthesized turn is persisted at `assistant.message_idx + 1` (the free
 * slot the pre-fix loop skipped) via `ON CONFLICT DO NOTHING`, so the next
 * resume stays balanced.
 */
async function reconcileGatewayReplay(args: ReconcileArgs): Promise<ReconcileResult> {
  const { engine, jobId, priorMessages, priorTools, toolDefs, signal } = args;

  const work = priorMessages.map(m => {
    const adapted = adaptContentBlocksToChatBlocks(m.content_blocks);
    return {
      message_idx: m.message_idx,
      role: m.role,
      blocks: typeof adapted === 'string' ? [{ type: 'text', text: adapted } as ChatBlock] : adapted,
    };
  });

  // Settled executions, three lookup structures:
  //   - execByOrdinal: rows keyed by their PERSISTED (message_idx, ordinal) —
  //     the true D11 row identity. The block position callIdx equals the
  //     ordinal stamped at first observation, so this survives both same-id
  //     repeats within a turn and slot shift when an earlier call never got
  //     a ledger row.
  //   - execByKey: (message_idx, tool_use_id) — exact whenever the turn's raw
  //     ids are unique (single-value: last-write-wins only for the same-id-
  //     twice shape, which execByOrdinal already resolves first).
  //   - legacyByMsg: ordinal=NULL rows (pre-stamping writes) in block order,
  //     for the positional fallback.
  const execByOrdinal = new Map<string, PersistedToolExec>();
  const execByKey = new Map<string, PersistedToolExec>();
  const legacyByMsg = new Map<number, PersistedToolExec[]>();
  for (const t of priorTools) {
    execByKey.set(`${t.message_idx}:${t.tool_use_id}`, t);
    if (t.ordinal != null) {
      execByOrdinal.set(`${t.message_idx}:${t.ordinal}`, t);
    } else {
      const arr = legacyByMsg.get(t.message_idx) ?? [];
      arr.push(t);
      legacyByMsg.set(t.message_idx, arr);
    }
  }

  let maxIdx = work.reduce((mx, w) => Math.max(mx, w.message_idx), -1);

  for (let i = 0; i < work.length; i++) {
    const msg = work[i];
    if (msg.role !== 'assistant') continue;
    const toolCalls = msg.blocks.filter(
      (b): b is Extract<ChatBlock, { type: 'tool-call' }> => b.type === 'tool-call',
    );
    if (toolCalls.length === 0) continue;

    // Skip if a following tool-result user turn exists AT ALL. A fully-answered
    // turn is already balanced; a PARTIALLY-answered turn (only reachable from
    // externally-corrupted data — gbrain persists all of a turn's results in one
    // message) is left for repairToolPairing() at the chat() boundary, which
    // back-fills only the missing ids. Synthesizing a full turn here would
    // duplicate the answered results and collide with the persisted row.
    const next = work[i + 1];
    if (next && next.role === 'user' && next.blocks.some(b => b.type === 'tool-result')) continue;

    // Ids that repeat WITHIN this turn are ambiguous as a lookup key — the
    // single-value execByKey map is last-write-wins for them, so the exact-id
    // fallback below is disabled for those ids (ordinal identity only).
    const idCounts = new Map<string, number>();
    for (const c of toolCalls) idCounts.set(c.toolCallId, (idCounts.get(c.toolCallId) ?? 0) + 1);

    const results: ChatBlock[] = [];
    for (let callIdx = 0; callIdx < toolCalls.length; callIdx++) {
      const call = toolCalls[callIdx];
      // Row resolution order:
      //   1. The persisted-ordinal row at this block position when its raw id
      //      matches the call — exact D11 identity (#4155: raw ids may repeat
      //      within a turn, and an earlier call without a ledger row must not
      //      shift a later row into its slot).
      //   2. The exact (message_idx, tool_use_id) key — only when this turn
      //      uses the id ONCE (a repeated id makes the key ambiguous and the
      //      call must resolve by ordinal or not at all, else one row's
      //      outcome would be served to every call sharing the id).
      //   3. The legacy (ordinal=NULL) positional row, only when it is for
      //      the SAME tool, so a missing row can't mis-attribute a sibling's
      //      output.
      const stamped = execByOrdinal.get(`${msg.message_idx}:${callIdx}`);
      const idIsUniqueInTurn = (idCounts.get(call.toolCallId) ?? 0) <= 1;
      const legacyPositional = legacyByMsg.get(msg.message_idx)?.[callIdx];
      const exec = (stamped && stamped.tool_use_id === call.toolCallId)
        ? stamped
        : (idIsUniqueInTurn ? execByKey.get(`${msg.message_idx}:${call.toolCallId}`) : undefined)
          ?? (legacyPositional && legacyPositional.tool_name === call.toolName ? legacyPositional : undefined);
      if (exec?.status === 'complete') {
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: exec.output ?? null });
        continue;
      }
      if (exec?.status === 'failed') {
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: exec.error ?? 'tool failed', isError: true });
        continue;
      }
      const toolDef = toolDefs.find(t => t.name === call.toolName);
      if (!toolDef) {
        await persistToolExecFailed(engine, jobId, msg.message_idx, callIdx, call.toolCallId, call.toolName, call.input, `tool "${call.toolName}" is not in the registry for this subagent`);
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: `tool "${call.toolName}" is not available`, isError: true });
        continue;
      }
      if (exec?.status === 'pending' && !toolDef.idempotent) {
        throw new Error(`non-idempotent tool "${call.toolName}" pending on resume; cannot safely re-run`);
      }
      await persistToolExecPending(engine, jobId, msg.message_idx, callIdx, call.toolCallId, call.toolName, call.input);
      try {
        const output = await toolDef.execute(call.input, { engine, jobId, remote: true, signal });
        await persistToolExecComplete(engine, jobId, msg.message_idx, callIdx, call.toolCallId, output);
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output });
      } catch (e) {
        const errText = e instanceof Error ? (e.stack ?? e.message) : String(e);
        await persistToolExecFailed(engine, jobId, msg.message_idx, callIdx, call.toolCallId, call.toolName, call.input, errText);
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: errText, isError: true });
      }
    }

    const resultIdx = msg.message_idx + 1;
    await persistMessage(engine, jobId, {
      message_idx: resultIdx,
      role: 'user',
      content_blocks: results as unknown as ContentBlock[],
      tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null,
    });
    maxIdx = Math.max(maxIdx, resultIdx);
    work.splice(i + 1, 0, { message_idx: resultIdx, role: 'user' as const, blocks: results });
    i++; // skip the turn we just inserted
  }

  const chatMessages: ChatMessage[] = work.map(w => ({ role: w.role, content: w.blocks }));

  // Terminal case: the transcript already ends on an assistant turn that
  // carried real text and made no tool calls (prior run reached end_turn).
  // Surface its text; skip the loop. An assistant turn whose blocks are all
  // empty (e.g. a reasoning-only/null-text turn that adaptation dropped) is NOT
  // terminal — falling through lets the loop re-issue the call rather than
  // returning an empty result.
  const lastMsg = work[work.length - 1];
  let terminalText: string | null = null;
  if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.blocks.some(b => b.type === 'tool-call')) {
    const text = lastMsg.blocks
      .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (text.trim() !== '') terminalText = text;
  }

  return { chatMessages, nextMessageIdx: maxIdx + 1, terminalText };
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
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return [];
  const out: ChatBlock[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const t = block.type;
    // #4201: per-part provider state (Gemini thoughtSignature) must survive
    // crash-replay — this shim rebuilds blocks field-by-field, so an omitted
    // field here is erased on resume even though the DB row kept it.
    const meta = block.providerMetadata && typeof block.providerMetadata === 'object'
      ? { providerMetadata: block.providerMetadata as Record<string, unknown> }
      : {};
    if (t === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text, ...meta });
    } else if (t === 'reasoning' && typeof block.text === 'string') {
      // OpenAI Responses API reasoning-item id (providerMetadata.openai.itemId)
      // — see the ChatBlock doc comment. Must survive crash-replay the same
      // way tool-call providerMetadata does, or a resumed reasoning-model
      // tool loop dead-letters on its next turn.
      out.push({ type: 'reasoning', text: block.text, ...meta });
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
        ...meta,
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
        ...meta,
      });
    }
  }
  return out;
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
// Moved to rate-leases.ts (its natural layer); re-exported here because
// worker.ts, inline-drain.ts, job-isolation and tests import it from this
// module historically.
export { RateLeaseUnavailableError } from '../rate-leases.ts';

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
 * Walks up to 3 levels of `.cause` (bounded, same depth as
 * classifyGlobalLlmError in errors.ts): gateway.chat()'s catch boundary
 * wraps every error via normalizeAIError(), which copies only the OUTER
 * `.message` onto the new AIConfigError/AITransientError and stores the
 * original raw error on `.cause` — the SDK's `.error.message` inner shape
 * (the one Anthropic actually uses, per the existing "matches when message
 * is on the inner .error.message field" unit test below) is otherwise lost
 * post-normalization, silently defeating detection on the gateway-native
 * path where callers only ever see the already-normalized error.
 *
 * Exported for unit testing.
 */
export function isPromptTooLongError(err: unknown): boolean {
  return findPromptTooLongMatch(err) !== null;
}

/**
 * Same bounded `.cause` walk as isPromptTooLongError, but returns the
 * matched phrase-bearing text (e.g. "prompt is too long: 1707509 tokens >
 * 1000000 maximum") instead of a boolean — used at the terminal-classification
 * call site so a normalizeAIError()-wrapped error's dead-letter message
 * carries the actually useful provider detail instead of the generic outer
 * wrapper text (e.g. "BadRequestError"). Returns null when no match (mirrors
 * isPromptTooLongError returning false for the same input).
 */
export function extractPromptTooLongDetail(err: unknown): string | null {
  return findPromptTooLongMatch(err);
}

function findPromptTooLongMatch(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth++) {
    const matched = matchesPromptTooLong(cur);
    if (matched !== null) return matched;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function matchesPromptTooLong(err: unknown): string | null {
  if (!err) return null;
  // Walk both `.message` and `.error?.message` shapes.
  const msg = (err as { message?: unknown })?.message;
  const inner = (err as { error?: { message?: unknown } })?.error?.message;
  const candidates = [msg, inner].filter((s): s is string => typeof s === 'string');
  for (const c of candidates) {
    if (/prompt is too long/i.test(c)) return c;
  }
  // Anthropic SDK wraps with .status; 400 + 'invalid_request_error' /
  // 'request_too_large' types both indicate the same class. Only treat
  // as terminal when the message actually says prompt-too-long; broader
  // 400s could be transient (e.g., malformed JSON from a test stub).
  const status = (err as { status?: unknown })?.status;
  const errType = (err as { error?: { type?: unknown } })?.error?.type;
  if (status === 400 && (errType === 'invalid_request_error' || errType === 'request_too_large')) {
    for (const c of candidates) {
      if (/too long|exceed|maximum/i.test(c)) return c;
    }
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
