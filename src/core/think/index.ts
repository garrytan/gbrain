/**
 * v0.28: `gbrain think` — INTENT → GATHER → SYNTHESIZE → (optional) COMMIT.
 *
 * v0.28.0 ships the full pipeline. The Anthropic call is dependency-injected
 * (MessagesClient interface) so tests can stub it without an API key. Live
 * runs require ANTHROPIC_API_KEY in the environment.
 *
 * --rounds scaffolding: round 1 is the only round actually exercised in
 * v0.28. Round N+1 fed by gaps from round N is the v0.29 follow-up; the
 * loop structure is in place so rounds > 1 don't fail — they just re-run
 * gather + synthesize without specialized gap-filling logic. Use rounds=1
 * (the default) for production until the gap-fill heuristic ships.
 *
 * --save persists a synthesis page + synthesis_evidence rows. --take
 * appends a take row to the anchor page (requires --anchor). Both are
 * local-CLI-only; remote (MCP) callers get a `not_implemented` envelope
 * for those flags per Codex P1 #7.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BrainEngine, SynthesisEvidenceInput } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { runGather, renderPagesBlock, takesHitToTakeForPrompt, selectRelevantExcerpt } from './gather.ts';
import { renderTakesBlock } from './sanitize.ts';
import { buildThinkSystemPrompt, buildThinkUserMessage } from './prompt.ts';
import { resolveCitations, type ParsedCitation } from './cite-render.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { resolveModel } from '../model-config.ts';
import { chat as gatewayChat, probeChatModel, isThinkingByDefaultModel, type ChatResult } from '../ai/gateway.ts';
import { getProviderCapabilities } from '../ai/capabilities.ts';
import { AIConfigError } from '../ai/errors.ts';
import { normalizeModelId } from '../model-id.ts';
import { hasAnthropicKey } from '../ai/anthropic-key.ts';

/** Anthropic Messages client interface — same shape used by subagent.ts so test stubs can be shared. */
export interface ThinkLLMClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

/** Closed set of LLM-call failure classes carried on the wire (D6 discipline). */
export type LlmCallFailureClass = 'timeout' | 'rate_limited' | 'network' | 'provider_error';

/**
 * Coarse, closed-vocabulary failure class for a thrown LLM call. The wire
 * (verb `warnings`) carries ONLY this class — raw provider/transport messages
 * (which can name hosts, keys, request ids) stay off remote responses and go
 * to stderr instead. Exported so tests pin the vocabulary.
 */
export function classifyLlmCallFailure(e: unknown): LlmCallFailureClass {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (/\b429\b|rate.?limit|overloaded/.test(msg)) return 'rate_limited';
  if (/timeout|timed.?out|etimedout/.test(msg)) return 'timeout';
  if (/econnrefused|econnreset|enotfound|eai_again|network|socket|fetch failed|dns/.test(msg)) return 'network';
  return 'provider_error';
}

export interface RunThinkOpts {
  question: string;
  /** Anchor entity slug. Activates the graph stream + entity-focused prompt. */
  anchor?: string;
  /** v0.28: rounds=1 is the only path exercised. Round-loop scaffolding is in place. */
  rounds?: number;
  /** When true, persist a synthesis page (caller resolves brainDir externally if writing to disk). */
  save?: boolean;
  /** When true, append a take row to the anchor page (requires anchor). */
  take?: boolean;
  /** Model override (CLI flag). Falls through resolveModel's 6-tier chain. */
  model?: string;
  /**
   * v0.41.x (#1698) — true when the CALLER explicitly supplied a model
   * (CLI `--model`, or the MCP `think` op's `model` param). When true, an
   * unresolvable model is a HARD ERROR (throws before gather) instead of
   * silently degrading to the no-LLM stub. Default false: the configured /
   * default model path keeps its graceful-degrade behavior.
   */
  modelExplicit?: boolean;
  /** Optional time window for temporal questions. */
  since?: string;
  until?: string;
  /** When set, MCP-bound calls forward this to the gather phase (server-side filter). */
  takesHoldersAllowList?: string[];
  /** Inject an LLM client (for tests). Defaults to a fresh Anthropic SDK client. */
  client?: ThinkLLMClient;
  /** Inject a question-embedding function. When omitted, vector takes search is skipped. */
  embedQuestion?: (q: string) => Promise<Float32Array | null>;
  /** Pure-test escape: return synthesized payload without calling any LLM. */
  stubResponse?: ThinkResponse;
  /**
   * v0.36.1.0 (E1, D22) — when true, retrieve the active calibration profile
   * for the configured holder and inject it into the prompt per D22 placement
   * (after retrieval, before question). The system prompt also gains
   * anti-bias rewrite rules.
   *
   * Off by default (regression posture). When on but no profile exists,
   * think falls back to baseline behavior + a NO_CALIBRATION_PROFILE warning.
   */
  withCalibration?: boolean;
  /**
   * Holder to retrieve the calibration profile for. Resolves via resolveOwnerHolder
   * (config emotional_weight.user_holder, else 'self'). Only consulted when withCalibration=true.
   */
  calibrationHolder?: string;
  /**
   * v0.40.2.0 — when true (default), inject a `<trajectory>` block for
   * temporal / knowledge_update intents. Bypass via
   * `think.trajectory_enabled=false` config OR explicit `withTrajectory:false`
   * caller opt. Kill switch for the rare regression. When set, runThink
   * runs `classifyIntent` + `extractCandidateEntities` + per-candidate
   * `findTrajectory` (5s timeout, concurrency cap 3) before prompt assembly.
   * `other` intent short-circuits the path entirely — no per-candidate
   * SQL fires.
   */
  withTrajectory?: boolean;
  /**
   * v0.40.2.0 — scalar projection of `OperationContext.sourceId`. MCP
   * `think` op handler populates this via `sourceScopeOpts(ctx)` so
   * trajectory queries inherit the same source scope as page/take
   * retrieval. CLI callers omit it and get the engine's default source.
   */
  sourceId?: string;
  /**
   * v0.40.2.0 — scalar projection of `OperationContext.auth.allowedSources`.
   * Federated-read OAuth clients scoped to multiple sources see their
   * full federation. Mutually exclusive with `sourceId` (the array wins
   * when both set, per `sourceScopeOpts` contract).
   */
  allowedSources?: string[];
  /**
   * v0.40.2.0 — scalar projection of `OperationContext.remote`. When
   * true, trajectory queries apply `visibility='world'` filter (mirrors
   * the recall posture for untrusted callers). CLI defaults to false.
   */
  remote?: boolean;
}

/** Structured response from the LLM (matches the schema declared in prompt.ts). */
export interface ThinkResponse {
  answer: string;
  citations: Array<{ page_slug: string; row_num: number | null; citation_index?: number }>;
  gaps: string[];
}

/**
 * WP2/T5 — how the synthesis step concluded. Additive: the synthesize verb
 * maps this onto the protocol's `synthesis_status` field (stamping
 * `extractive_fallback` at the verb layer when a compose failure met a
 * non-empty gather). `ok` is the only value that marks a real answer.
 */
export type ThinkSynthesisStatus =
  | 'ok'              // parsed JSON with a non-empty answer
  | 'empty_answer'    // parsed JSON, answer empty
  | 'not_json'        // unparseable output: malformed JSON, refusals, the graceful sentinel
  | 'no_llm'          // no key configured — gather-only stub
  | 'model_unusable'  // configured model failed the probe (unknown provider/model)
  | 'llm_error';      // client.create() threw (429 / timeout / 5xx / network)

export interface ThinkResult {
  question: string;
  answer: string;
  citations: ParsedCitation[];
  gaps: string[];
  pagesGathered: number;
  takesGathered: number;
  graphHits: number;
  modelUsed: string;
  rounds: number;
  warnings: string[];
  /**
   * v0.41.x (#1698) — true only when an actual synthesis produced a NON-EMPTY
   * answer. False for the no-LLM graceful stub, malformed (not-JSON) output, and
   * valid-but-empty JSON (`{"answer":""}`). `persistSynthesis` refuses to write
   * when this is `=== false`, so an empty page can never be saved. Undefined on
   * pre-existing/test `ThinkResult` literals → treated as persistable (back-compat).
   */
  synthesisOk?: boolean;
  /**
   * WP2/T5 — why synthesis produced (or didn't produce) a real answer.
   * Additive-forever; `synthesisOk` remains the persistence gate. The MCP
   * `think` op spreads this through verbatim.
   */
  synthesis_status?: ThinkSynthesisStatus;
  /**
   * WP2/E2 — extractive-fallback material, present ONLY when synthesis failed
   * (`synthesis_status !== 'ok'`) AND gather returned pages. Composed
   * exclusively from gathered pages — an empty gather never yields one
   * (ENG-19: no pages, no answer). `answer`/`citations` are left untouched
   * so existing consumers keep the raw failure shape; callers opt in.
   */
  extractive?: ExtractiveFallback;
  /**
   * MEMORY_VERBS v1 [E2] — gateway token usage for the synthesis call(s),
   * summed across rounds. Best-effort: null when no LLM ran (graceful stub),
   * when a test client returns no usage, or when a provider omits accounting.
   * The synthesize verb maps this to its frozen `cost` block.
   */
  usage?: { input_tokens: number; output_tokens: number } | null;
  /** Only set when --save was true and the caller persisted a synthesis page. */
  savedSlug?: string;
  /** Diagnostics for `--explain` callers (CLI surface for v0.29). */
  diagnostics: {
    pagesFromHybrid: number;
    takesFromKeyword: number;
    takesFromVector: number;
    graphHits: number;
  };
  /** USD cost computed from `usage` + `canonicalLookup(modelUsed)`, when both are available. */
  cost_usd?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

// Thinking-by-default Claude 5 models spend a large share of the output budget
// on internal reasoning before emitting any answer, so the 4000 default leaves
// `think` with empty or truncated text. Give those models headroom; providers
// bill actual tokens, not the cap. Everything else keeps 4000. Detection is
// shared with the gateway (`isThinkingByDefaultModel`) so provider-prefixed
// spellings (openrouter:anthropic/claude-*-5, claude-cli:*) get the same
// treatment; think keeps its own smaller 16000 cap.
const THINKING_DEFAULT_MAX_OUTPUT_TOKENS = 16000;
// OpenAI reasoning models spend output budget on internal reasoning tokens
// the same way — reasoning tokens are billed as output and count against
// `max_tokens` — so they get the same headroom. Deliberately scoped to the
// gpt-5 family and the numbered o-series only; anything else (gpt-4o, the
// non-reasoning `*-chat` snapshots like gpt-5-chat-latest, other providers'
// reasoning models routed through their own recipes) keeps the conservative
// 4000 default.
const OPENAI_REASONING_MODEL_RE = /^openai[:/](?:gpt-5|o[0-9]+)(?:[.-]|$)/i;
const OPENAI_CHAT_SNAPSHOT_RE = /-chat(?:-|$)/i; // gpt-5-chat-latest, gpt-5.2-chat-latest
export function maxOutputTokensFor(modelStr: string): number {
  const openaiReasoning =
    OPENAI_REASONING_MODEL_RE.test(modelStr) && !OPENAI_CHAT_SNAPSHOT_RE.test(modelStr);
  // Shared name-based predicate (#4087: one source of truth in gateway.ts —
  // provider-prefixed + bare Claude 5 spellings, never 3.5-era models).
  if (isThinkingByDefaultModel(modelStr) || openaiReasoning) {
    return THINKING_DEFAULT_MAX_OUTPUT_TOKENS;
  }
  // Recipe-declared thinking-by-default (gbrain#4172, e.g. DeepSeek v4):
  // keyed on the capability, not a model-name regex, so a provider's model
  // renames don't silently drop the headroom. Reasoning bills as output and
  // counts against max_tokens; without headroom the 4000 cap is spent on
  // reasoning and think returns truncated/empty JSON.
  try {
    if (getProviderCapabilities(modelStr).supportsThinking) {
      return THINKING_DEFAULT_MAX_OUTPUT_TOKENS;
    }
  } catch {
    // Unknown provider / chat-less recipe — keep the conservative default.
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

function inferIntent(question: string, anchor?: string): string {
  if (anchor) return 'entity';
  const q = question.toLowerCase();
  if (/\b(when|history|over time|evolved|since|before|after)\b/.test(q)) return 'temporal';
  if (/\b(meeting|event|happened)\b/.test(q)) return 'event';
  return 'general';
}

function tryParseJSON(text: string): unknown {
  // The model may wrap JSON in code fences. Strip if present.
  const stripped = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    // Fallback: extract the first {...} block. Useful when the model emits prose alongside JSON.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
    return null;
  }
}

// ─── Extractive fallback [WP2/E2] ────────────────────────────────────────────
// When synthesis fails but gather succeeded, a digest of the top gathered
// pages (title + best excerpt, page-level citations) beats an empty failure.

const EXTRACTIVE_TOP_PAGES = 5;
const EXTRACTIVE_EXCERPT_LEN = 400;

export interface ExtractiveFallback {
  answer: string;
  /** Page-level citations (row_num null) for the digested pages, gather order. */
  citations: ParsedCitation[];
}

/**
 * Compose an extractive digest from gathered pages: one line per page,
 * title + the excerpt window with the strongest query-term coverage, cited
 * `[slug]`. NEVER fabricates: every line quotes ONE gathered page and an
 * empty gather returns null (ENG-19 — no pages, no answer, ever).
 */
export function composeExtractiveFallback(
  pages: SearchResult[],
  question: string,
): ExtractiveFallback | null {
  if (pages.length === 0) return null;
  const top = pages.slice(0, EXTRACTIVE_TOP_PAGES);
  const citations: ParsedCitation[] = [];
  const lines = top.map((p, idx) => {
    const page = p as unknown as {
      slug?: string; title?: string; chunk_text?: string; compiled_truth?: string; snippet?: string;
    };
    const slug = String(page.slug ?? '');
    const title = String(page.title ?? '') || slug;
    const slugIdentity = slug.split('/').pop()?.replace(/[-_]/g, ' ') ?? '';
    const content = String(page.chunk_text ?? page.compiled_truth ?? page.snippet ?? '');
    const excerpt = selectRelevantExcerpt(
      content, question, EXTRACTIVE_EXCERPT_LEN, `${title} ${slugIdentity}`,
    ).trim();
    citations.push({ page_slug: slug, row_num: null, citation_index: idx + 1 });
    return excerpt ? `- ${title} [${slug}]: ${excerpt}` : `- ${title} [${slug}]`;
  });
  return {
    answer:
      `No synthesized answer — extractive excerpts from the ${top.length} most relevant retrieved page(s):\n` +
      lines.join('\n'),
    citations,
  };
}

/**
 * Persist citations into synthesis_evidence. Resolves slugs to page_ids
 * via the engine. Pages that don't exist in the brain are skipped + warn'd.
 * Pages without a row_num are page-level citations and are NOT persisted
 * (synthesis_evidence is a take→synthesis FK; page-level citations live in
 * the answer body's [slug] markers only).
 */
async function persistCitations(
  engine: BrainEngine,
  synthesisPageId: number,
  citations: ParsedCitation[],
): Promise<{ inserted: number; warnings: string[] }> {
  const warnings: string[] = [];
  // Resolve unique slugs to page_ids
  const slugToPageId = new Map<string, number>();
  for (const c of citations) {
    if (c.row_num === null) continue;  // page-level, skip
    if (slugToPageId.has(c.page_slug)) continue;
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
      [c.page_slug],
    );
    if (rows[0]) slugToPageId.set(c.page_slug, rows[0].id);
  }
  const evidenceInputs: SynthesisEvidenceInput[] = [];
  for (const c of citations) {
    if (c.row_num === null) continue;
    const pageId = slugToPageId.get(c.page_slug);
    if (!pageId) {
      warnings.push(`CITATION_PAGE_NOT_IN_BRAIN: ${c.page_slug}#${c.row_num}`);
      continue;
    }
    evidenceInputs.push({
      synthesis_page_id: synthesisPageId,
      take_page_id: pageId,
      take_row_num: c.row_num,
      citation_index: c.citation_index,
    });
  }
  if (evidenceInputs.length === 0) return { inserted: 0, warnings };
  const inserted = await engine.addSynthesisEvidence(evidenceInputs);
  return { inserted, warnings };
}

/**
 * Run the think pipeline. Returns a ThinkResult — caller decides whether
 * to print, persist as synthesis page, or surface as MCP response.
 */
export async function runThink(
  engine: BrainEngine,
  opts: RunThinkOpts,
): Promise<ThinkResult> {
  const rounds = Math.max(1, opts.rounds ?? 1);
  const warnings: string[] = [];

  // Resolve the model through the 6-tier chain.
  const modelUsed = await resolveModel(engine, {
    cliFlag: opts.model,
    configKey: 'models.think',
    tier: 'deep',
    fallback: 'opus',  // think is the high-stakes synthesis op; opus is the right default
  });

  // #1698: fail fast on an unresolvable EXPLICIT model (CLI --model, or the MCP op's
  // model param) BEFORE gather, so we don't waste retrieval per failure (the 200-call
  // batch case). The default/configured-model path is unaffected (modelExplicit false →
  // it keeps the graceful no-LLM-stub degrade). Test/injected client + stub bypass.
  if (opts.modelExplicit && !opts.client && !opts.stubResponse) {
    const probe = probeChatModel(normalizeModelId(modelUsed));
    if (!probe.ok) {
      throw new Error(
        `think: --model "${opts.model}" is not usable (${probe.reason}): ${probe.detail}. ` +
        `Refusing to run synthesis with no model — fix the model id or omit --model.` +
        (probe.fix ? ` Fix: ${probe.fix}` : ''),
      );
    }
  }

  // Optional question embedding — caller decides whether to pay the embedder.
  let questionEmbedding: Float32Array | undefined;
  if (opts.embedQuestion) {
    try {
      const e = await opts.embedQuestion(opts.question);
      if (e) questionEmbedding = e;
    } catch (e) {
      // D6: code-only on the wire; raw exception text goes to server logs.
      warnings.push('QUESTION_EMBED_FAILED');
      process.stderr.write(`[think] question embed failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // GATHER
  const gather = await runGather(engine, {
    question: opts.question,
    anchor: opts.anchor,
    questionEmbedding,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
    ...(opts.allowedSources !== undefined ? { sourceIds: opts.allowedSources } : {}),
  });
  // D6: per-stream gather failures surface as typed codes (GATHER_*_FAILED);
  // raw error text stays on stderr. Distinguishes an errored stream from a
  // legitimately-empty one for MCP/remote callers.
  for (const w of gather.warnings) warnings.push(w);

  // Render evidence blocks for the prompt
  const pagesBlock = renderPagesBlock(gather.pages, 600, opts.question);
  const takesForPrompt = gather.takes.map(takesHitToTakeForPrompt);
  const { rendered: takesBlock, sanitizedCount } = renderTakesBlock(takesForPrompt);
  if (sanitizedCount > 0) {
    warnings.push(`SANITIZED_${sanitizedCount}_TAKE_CLAIMS`);
  }
  const graphBlock = gather.graphSlugs.length > 0
    ? `<anchor>${opts.anchor}</anchor>\nReachable: ${gather.graphSlugs.slice(0, 30).join(', ')}`
    : undefined;

  // v0.36.1.0 (E1) — optional calibration profile retrieval. When enabled
  // and a profile exists, inject it per D22 (after retrieval, before question).
  // When enabled and no profile, fall back to baseline + warn.
  let calibrationBlockOpts:
    | { holder: string; patternStatements: string[]; activeBiasTags: string[]; brier?: number | null }
    | undefined;
  if (opts.withCalibration) {
    try {
      const { getLatestProfile } = await import('../../commands/calibration.ts');
      const profile = await getLatestProfile(engine, {
        holder: resolveOwnerHolder({
          override: opts.calibrationHolder,
          configValue: await engine.getConfig('emotional_weight.user_holder'),
        }),
      });
      if (profile) {
        calibrationBlockOpts = {
          holder: profile.holder,
          patternStatements: profile.pattern_statements,
          activeBiasTags: profile.active_bias_tags,
          brier: profile.brier,
        };
      } else {
        warnings.push('NO_CALIBRATION_PROFILE');
      }
    } catch (err) {
      // D6: code-only on the wire; raw exception text goes to server logs.
      warnings.push('CALIBRATION_FETCH_FAILED');
      process.stderr.write(`[think] calibration fetch failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // v0.40.2.0 — trajectory injection for temporal / knowledge_update
  // intents. Default ON (Eng D1). `think.trajectory_enabled` config flag
  // is the kill switch. `withTrajectory: false` caller opt also bypasses.
  // `other` intent short-circuits before any SQL fires.
  let trajectoryBlock = '';
  let trajectoryPointsCount = 0;
  const trajectoryEnabledConfig = await readThinkTrajectoryEnabled(engine);
  const trajectoryEnabledOpt = opts.withTrajectory !== false; // default true
  if (trajectoryEnabledConfig && trajectoryEnabledOpt) {
    try {
      const { classifyIntent } = await import('./intent.ts');
      const trajIntent = classifyIntent(opts.question);
      if (trajIntent === 'temporal' || trajIntent === 'knowledge_update') {
        const { extractCandidateEntities } = await import('./entity-extract.ts');
        const retrievedSlugs = gather.pages.map(p => p.slug);
        const candidates = extractCandidateEntities(opts.question, retrievedSlugs);
        if (candidates.length > 0) {
          const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
          const { formatTrajectoryBlock } = await import('../trajectory-format.ts');
          const sourceIdScalar = opts.sourceId ?? 'default';
          // Per-candidate trajectory fetch. Concurrency cap = 3; each call
          // has its own 5s timeout via Promise.race. allSettled prevents
          // one error from killing the others (Codex Problem 13: timeout
          // bounds latency, not just failure propagation).
          const allBlocks: string[] = [];
          const seenSlugs = new Set<string>();
          let totalPoints = 0;
          const candidateQueue = [...candidates];
          while (candidateQueue.length > 0) {
            const batch = candidateQueue.splice(0, 3);
            const settled = await Promise.allSettled(
              batch.map(async (cand) => {
                const resolved = await resolveEntitySlugWithSource(engine, sourceIdScalar, cand.raw);
                if (!resolved) return null;
                if (resolved.source === 'fallback_slugify') return null;
                if (seenSlugs.has(resolved.slug)) return null;
                seenSlugs.add(resolved.slug);
                // 5s per-candidate timeout. Promise.race resolves with the
                // first to land; the timeout returns [] (empty trajectory).
                const points = await Promise.race([
                  engine.findTrajectory({
                    entitySlug: resolved.slug,
                    ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
                    ...(opts.allowedSources !== undefined ? { sourceIds: opts.allowedSources } : {}),
                    ...(opts.remote !== undefined ? { remote: opts.remote } : {}),
                    kind: 'all',
                    limit: 100,
                  }),
                  new Promise<import('../engine.ts').TrajectoryPoint[]>(resolve => {
                    setTimeout(() => resolve([]), 5000);
                  }),
                ]);
                if (points.length === 0) return null;
                const fmt = formatTrajectoryBlock(points, resolved.slug, {
                  intent: trajIntent,
                });
                if (fmt.rendered.length === 0) return null;
                return { rendered: fmt.rendered, points: fmt.emittedPoints };
              }),
            );
            for (const s of settled) {
              if (s.status !== 'fulfilled' || s.value === null) continue;
              allBlocks.push(s.value.rendered);
              totalPoints += s.value.points;
            }
          }
          if (allBlocks.length > 0) {
            trajectoryBlock = allBlocks.join('\n\n');
            trajectoryPointsCount = totalPoints;
          }
        }
      }
    } catch (err) {
      // Defensive: trajectory injection is best-effort. Any unexpected
      // error degrades to "no trajectory block" + a warning. The think
      // call itself never fails because of trajectory wiring.
      // D6: code-only on the wire; raw exception text goes to server logs.
      warnings.push('TRAJECTORY_INJECTION_FAILED');
      process.stderr.write(`[think] trajectory injection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (trajectoryPointsCount > 0) {
    warnings.push(`TRAJECTORY_INJECTED_${trajectoryPointsCount}_POINTS`);
  }

  // SYNTHESIZE
  const intent = inferIntent(opts.question, opts.anchor);
  const systemPrompt = buildThinkSystemPrompt({
    intent,
    ...(opts.anchor !== undefined ? { anchor: opts.anchor } : {}),
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    willSave: opts.save,
    withCalibration: !!calibrationBlockOpts,
  });
  const userMessage = buildThinkUserMessage({
    question: opts.question,
    pagesBlock,
    takesBlock,
    ...(graphBlock !== undefined ? { graphBlock } : {}),
    ...(calibrationBlockOpts !== undefined ? { calibration: calibrationBlockOpts } : {}),
    ...(trajectoryBlock.length > 0 ? { trajectoryBlock } : {}),
  });

  // #1698: true only when an actual synthesis produced a non-empty answer. Set false
  // on the not-JSON branch (covers malformed output AND the buildGracefulMessage
  // sentinel, which is non-JSON) and on the no-client early return below; the final
  // return ANDs it with a non-empty-answer check (catches valid-but-empty JSON).
  let synthesisOk = true;
  // [WP2/T5] typed compose status. Starts 'ok'; failure branches overwrite it
  // with their specific value; the parsed-but-empty check at the bottom is the
  // only downgrade applied to a still-'ok' status.
  let synthesisStatus: ThinkSynthesisStatus = 'ok';
  // [E2] best-effort usage aggregation across synthesis calls (single-pass in
  // v0.28+, but summed so the round loop inherits it when gap-fill lands).
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  // Initialized to the llm_error shape; every non-throwing branch overwrites it.
  let response: ThinkResponse = { answer: '', citations: [], gaps: [] };
  if (opts.stubResponse) {
    response = opts.stubResponse;
  } else {
    // Build a ThinkLLMClient. Three sources, in priority order:
    //   1. opts.client (test injection — preserved as test seam)
    //   2. Gateway adapter (routes through gateway.chat() — picks up
    //      anthropic_api_key from gbrain config OR env, gateway rate-leases,
    //      retry, prompt caching, the canonical seam per CLAUDE.md)
    //   3. Graceful fallback ("no LLM available" stub) — when gateway is
    //      unconfigured AND no env var is set, return without throwing.
    //
    // Pre-v0.36, this code path constructed `new Anthropic()` directly.
    // That bypassed gateway config (gbrain config set anthropic_api_key)
    // because the Anthropic SDK only reads process.env.ANTHROPIC_API_KEY.
    // Closes #952 (think over MCP returns "no LLM available").
    const client = opts.client ?? await tryBuildGatewayClient(modelUsed, { explicitModel: opts.modelExplicit });
    if (!client) {
      // Label the failure honestly: a missing key and an unusable model id are
      // different incidents with different fixes. Pre-fix EVERY null client was
      // stamped NO_ANTHROPIC_API_KEY, which sent operators chasing env/keychain
      // problems when the real cause was a model id the recipe didn't know
      // (e.g. a tier-configured model newer than the recipe list). The re-probe
      // is pure and cheap (no IO): same predicate tryBuildGatewayClient used.
      const probe = probeChatModel(normalizeModelId(modelUsed));
      const modelProblem = !probe.ok && probe.reason !== 'unavailable';
      warnings.push(
        modelProblem ? `MODEL_NOT_USABLE:${(probe as { reason: string }).reason}` : 'NO_ANTHROPIC_API_KEY',
      );
      const detail = !probe.ok ? probe.detail : '';
      const fix = !probe.ok && probe.fix ? ` Fix: ${probe.fix}` : '';
      // [WP2/E2] non-empty gather still has value — attach the extractive
      // digest so callers (the synthesize verb) can surface it instead of
      // the stub answer. Null on empty gather (never fabricate).
      const stubExtractive = composeExtractiveFallback(gather.pages, opts.question);
      // Degrade gracefully: return the gather without synthesis. Better than throwing.
      return {
        question: opts.question,
        answer: modelProblem
          ? `(model "${modelUsed}" not usable — ${detail}${fix})`
          : '(no LLM available — set ANTHROPIC_API_KEY or pass `client`)',
        citations: [],
        gaps: [
          modelProblem
            ? `model "${modelUsed}" not usable (${(probe as { reason: string }).reason}); gather succeeded but synthesis skipped`
            : 'no LLM available; gather succeeded but synthesis skipped',
        ],
        pagesGathered: gather.pages.length,
        takesGathered: gather.takes.length,
        graphHits: gather.graphSlugs.length,
        modelUsed,
        rounds: 0,
        warnings,
        synthesisOk: false,  // #1698: no LLM ran — never persist this
        synthesis_status: modelProblem ? 'model_unusable' : 'no_llm',
        ...(stubExtractive ? { extractive: stubExtractive } : {}),
        usage: null,         // [E2] no LLM ran — no accounting
        diagnostics: {
          pagesFromHybrid: gather.diagnostics.pagesFromHybrid,
          takesFromKeyword: gather.diagnostics.takesFromKeyword,
          takesFromVector: gather.diagnostics.takesFromVector,
          graphHits: gather.diagnostics.graphHits,
        },
      };
    }
    let created: Anthropic.Message | null = null;
    try {
      created = await client.create({
        model: modelUsed,
        max_tokens: maxOutputTokensFor(normalizeModelId(modelUsed)),
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (e) {
      // [ENG-10] provider/transport failures (429, timeout, 5xx, network)
      // become a typed llm_error status instead of killing the whole call —
      // gather already succeeded and the caller can still act on it. Three
      // throw classes stay hard: the explicit-model config error (#1698 — the
      // gateway adapter only lets AIConfigError escape on the explicit path),
      // budget exhaustion (spend control must stop the enclosing loop), and
      // aborts (cancellation is control flow, not an LLM failure).
      const name = e instanceof Error ? e.name : '';
      if ((opts.modelExplicit && e instanceof AIConfigError) || name === 'BudgetExhausted' || name === 'AbortError') {
        throw e;
      }
      // D6 closed vocabulary: the wire carries the coarse class only; the raw
      // provider/transport message goes to stderr for the operator.
      warnings.push(`LLM_CALL_FAILED: ${classifyLlmCallFailure(e)}`);
      process.stderr.write(`[think] LLM call failed (${classifyLlmCallFailure(e)}): ${e instanceof Error ? e.message : String(e)}\n`);
      synthesisStatus = 'llm_error';
      synthesisOk = false;
      // response keeps its empty llm_error initialization.
    }
    if (created) {
      // [E2] capture usage when the message carries it (test-injected clients
      // and providers without accounting leave it null).
      const u = (created as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
        // Single synthesis call in v0.28+; when gap-driven rounds land, sum here.
        const prev = usage as { input_tokens: number; output_tokens: number } | null;
        usage = {
          input_tokens: (prev?.input_tokens ?? 0) + u.input_tokens,
          output_tokens: (prev?.output_tokens ?? 0) + u.output_tokens,
        };
      }
      const block = created.content.find(b => b.type === 'text');
      const text = block && 'text' in block ? block.text : '';
      const parsed = tryParseJSON(text);
      if (!parsed || typeof parsed !== 'object') {
        warnings.push('LLM_OUTPUT_NOT_JSON');
        synthesisOk = false;  // #1698: malformed output (and the non-JSON graceful sentinel)
        // Refusals + the graceful sentinel land here too — coarse on purpose
        // (no dedicated status; the raw text stays in `answer` for consumers).
        synthesisStatus = 'not_json';
        response = { answer: text, citations: [], gaps: [] };
      } else {
        const r = parsed as Partial<ThinkResponse>;
        response = {
          answer: typeof r.answer === 'string' ? r.answer : '',
          citations: Array.isArray(r.citations) ? (r.citations as ThinkResponse['citations']) : [],
          gaps: Array.isArray(r.gaps) ? (r.gaps as string[]).filter(g => typeof g === 'string') : [],
        };
      }
    }
  }

  // Resolve citations: prefer structured, fall back to inline-marker regex scan.
  const resolved = resolveCitations(response.citations, response.answer);
  if (resolved.warnings.length > 0) {
    for (const w of resolved.warnings) warnings.push(w);
  }

  // Round-loop scaffolding (rounds > 1 currently re-runs without gap-driven retrieval).
  // The loop is in place so the v0.29 gap-fill heuristic doesn't change the call site.
  for (let r = 1; r < rounds; r++) {
    warnings.push(`ROUNDS_GT_1_NOT_GAP_DRIVEN_IN_V028`);
    break;  // v0.28: single-pass only
  }

  // [WP2/T5] parsed-but-empty answer gets its own status; branches that
  // already flagged a more specific failure keep theirs.
  if (synthesisStatus === 'ok' && response.answer.trim().length === 0) {
    synthesisStatus = 'empty_answer';
    warnings.push('SYNTHESIS_EMPTY_ANSWER');
  }
  // [WP2/E2] compose failed + non-empty gather → attach extractive material
  // (callers decide whether to surface it; null on empty gather — ENG-19).
  const extractive = synthesisStatus !== 'ok'
    ? composeExtractiveFallback(gather.pages, opts.question)
    : null;

  return {
    question: opts.question,
    answer: response.answer,
    citations: resolved.citations,
    gaps: response.gaps,
    pagesGathered: gather.pages.length,
    takesGathered: gather.takes.length,
    graphHits: gather.graphSlugs.length,
    modelUsed,
    rounds: 1,
    warnings,
    // #1698: persistable only when a real synthesis produced a non-empty answer.
    // ANDs the not-JSON/sentinel flag with a content check (catches valid-but-empty JSON).
    synthesisOk: synthesisOk && response.answer.trim().length > 0,
    synthesis_status: synthesisStatus,
    ...(extractive ? { extractive } : {}),
    usage,
    diagnostics: {
      pagesFromHybrid: gather.diagnostics.pagesFromHybrid,
      takesFromKeyword: gather.diagnostics.takesFromKeyword,
      takesFromVector: gather.diagnostics.takesFromVector,
      graphHits: gather.diagnostics.graphHits,
    },
  };
}

/**
 * Strip a "## Gaps" section from an answer body.
 *
 * `think` returns gaps in the structured `gaps` array, which the CLI and the
 * persisted synthesis page render exactly once. The system prompt also used to
 * ask for a "Gaps" section inside the answer prose, so a model that still emits
 * one would make the output show "## Gaps" twice — once from the prose, once
 * from the structured array. This removes the prose section so the structured
 * array stays the single source of truth.
 *
 * Matches a heading line `## Gaps` (level 2-6, case-insensitive) and removes it
 * through the next heading of the same-or-higher level, or end of string.
 * Returns the input unchanged when there is no such section.
 */
export function stripGapsSection(answer: string): string {
  if (!answer) return answer;
  const lines = answer.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{2,6})\s+gaps\s*$/i.exec(lines[i]);
    if (m) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return answer;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s+\S/.exec(lines[i]);
    if (h && h[1].length <= level) { end = i; break; }
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  // Drop trailing blank lines left by removing a trailing section.
  return kept.replace(/\s+$/, '');
}

/**
 * Persist a synthesis page + its evidence. Returns the saved slug.
 * Synthesis pages are written under `synthesis/<slugified-question>-<date>.md`.
 */
export async function persistSynthesis(
  engine: BrainEngine,
  result: ThinkResult,
): Promise<{ slug: string; evidenceInserted: number; warnings: string[] }> {
  // #1698: never persist an empty synthesis. Returned signal (NOT a throw, F3) so
  // the MCP `think` op can return the gather result + warning instead of a bare error
  // envelope; the CLI keys off this warning to exit non-zero. Guard on `=== false` so
  // pre-existing/test ThinkResult literals without the field still persist (back-compat).
  if (result.synthesisOk === false) {
    return { slug: '', evidenceInserted: 0, warnings: ['SYNTHESIS_EMPTY_NOT_PERSISTED'] };
  }

  const today = new Date().toISOString().slice(0, 10);
  const slugSafe = result.question
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'untitled';
  const slug = `synthesis/${slugSafe}-${today}`;

  // Build the markdown body
  const body = [
    `# ${result.question}`,
    '',
    stripGapsSection(result.answer),
    '',
    result.gaps.length > 0 ? '## Gaps\n\n' + result.gaps.map(g => `- ${g}`).join('\n') : '',
  ].filter(Boolean).join('\n');

  const page = await engine.putPage(slug, {
    title: result.question.slice(0, 200),
    type: 'synthesis',
    compiled_truth: body,
    frontmatter: {
      type: 'synthesis',
      question: result.question,
      model: result.modelUsed,
      date: today,
      pages_gathered: result.pagesGathered,
      takes_gathered: result.takesGathered,
    },
  });

  const persisted = await persistCitations(engine, page.id, result.citations);
  return { slug, evidenceInserted: persisted.inserted, warnings: persisted.warnings };
}

// ─────────────────────────────────────────────────────────────────
// Gateway adapter for #952 (think over MCP returns "no LLM available").
// ─────────────────────────────────────────────────────────────────
// Pre-v0.36, runThink instantiated `new Anthropic()` directly and read
// ANTHROPIC_API_KEY from process.env. Claude Desktop's stdio MCP launch
// doesn't inherit shell env, so `gbrain config set anthropic_api_key sk-...`
// (which writes to ~/.gbrain/config.json) never reached the SDK and every
// MCP think call degraded to "no LLM available."
//
// The adapter routes through gateway.chat() — the canonical seam per
// CLAUDE.md. Gateway reads the API key from gbrain config OR env, picks
// up prompt caching, rate-leases, retry, and the test seam
// (__setChatTransportForTests) that v0.31.12 already established.
//
// Per plan-eng-review D10 (cross-model tension with codex C7+C8+C9+C10),
// the adapter implements four fixes:
//   1. Drop the new Anthropic() direct path entirely — always route through gateway
//   2. Real availability check via try/catch around resolveRecipe + assertion
//      (NOT the false-positive `getChatModel()` truthy check)
//   3. Model-id resolution: handle both bare (`claude-opus-4-7`) and
//      provider-prefixed (`anthropic:claude-opus-4-7`) shapes
//   4. Response-shape conversion: ChatResult → Anthropic.Message
//
// `opts.client` injection path is preserved (test seam — see ThinkLLMClient).
// `opts.stubResponse` path is preserved (pure-test escape).
// ─────────────────────────────────────────────────────────────────

/**
 * v0.40.2.0 — read the `think.trajectory_enabled` config key. Default
 * true. Returns false ONLY when the value is set AND parses to a false
 * string. Any read error (table missing on pre-v36 brains, etc.) returns
 * true so users on legacy installs still get the feature. The flag is
 * the kill switch for the rare prod regression.
 */
async function readThinkTrajectoryEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig('think.trajectory_enabled');
    if (v === null || v === undefined) return true;
    const lower = v.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Try to build a gateway-backed ThinkLLMClient for the given model.
 * Returns null when the gateway cannot resolve a usable chat provider for
 * this model (missing API key for the resolved provider, unknown provider,
 * touchpoint not supported, etc.). Caller falls through to the graceful
 * "no LLM available" stub on null.
 */
async function tryBuildGatewayClient(
  modelUsed: string,
  opts: { explicitModel?: boolean } = {},
): Promise<ThinkLLMClient | null> {
  // Normalize: ensure provider:model shape (and slash→colon — #1698). resolveModel
  // returns bare anthropic ids (`claude-opus-4-7`); gateway.chat needs `anthropic:...`.
  const modelStr = normalizeModelId(modelUsed);

  // #1698: ONE shared probe (resolveRecipe + assertTouchpoint + isAvailable).
  // assertTouchpoint catches chat-less providers (voyage/ollama); isAvailable
  // catches missing keys. Model-id typos are NOT caught locally (no runtime
  // allowlist) — a nonexistent id fails at the provider with model_not_found.
  // For an EXPLICIT model the user typed, an unusable model is a HARD ERROR (throw)
  // — never silently degrade to the no-LLM stub. For the default/configured-model
  // path, return null so the caller falls through to the graceful "no LLM" stub
  // (preserves the documented no-key gather-only behavior).
  const probe = probeChatModel(modelStr);
  if (!probe.ok) {
    if (opts.explicitModel) {
      throw new Error(
        `think: --model "${modelUsed}" is not usable (${probe.reason}): ${probe.detail}. ` +
        `Refusing to run synthesis with no model — fix the model id or omit --model.` +
        (probe.fix ? ` Fix: ${probe.fix}` : ''),
      );
    }
    return null;
  }

  return {
    create: async (params): Promise<Anthropic.Message> => {
      // Build ChatOpts from Anthropic.MessageCreateParamsNonStreaming.
      const messages = params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content.map(b => 'text' in b ? b.text : '').join('') : ''),
      }));
      const system = typeof params.system === 'string'
        ? params.system
        : (Array.isArray(params.system) ? params.system.map(b => 'text' in b ? b.text : '').join('') : undefined);

      let result: ChatResult;
      try {
        result = await gatewayChat({
          model: modelStr,
          system,
          messages,
          maxTokens: params.max_tokens,
        });
      } catch (e) {
        // AIConfigError at chat time = e.g. key revoked mid-run. For an EXPLICIT
        // model the user typed, this is a hard error (rethrow) — the early gate
        // normally catches it first; this is defense-in-depth. For the default
        // path, surface a sentinel "no LLM available"-shaped Message so the
        // existing JSON-parse path produces the graceful degradation answer.
        if (e instanceof AIConfigError) {
          if (opts.explicitModel) throw e;
          return buildGracefulMessage(modelStr, e) as unknown as Anthropic.Message;
        }
        throw e;
      }
      return chatResultToMessage(result, modelStr) as unknown as Anthropic.Message;
    },
  };
}

/**
 * Convert gateway's `ChatResult` into an Anthropic-Message-shaped object.
 * The caller (`runThink`) parses `result.content[0].text` as JSON; the
 * other fields (usage, stop_reason) are returned with best-effort mapping
 * for downstream telemetry compat.
 */
function chatResultToMessage(result: ChatResult, modelStr: string): {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
} {
  return {
    id: '',
    type: 'message',
    role: 'assistant',
    model: modelStr,
    content: [{ type: 'text', text: result.text }],
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
    stop_reason: mapStopReason(result.stopReason),
  };
}

function mapStopReason(s: ChatResult['stopReason']): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
  switch (s) {
    case 'end': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    // 'refusal', 'content_filter', 'other' → end_turn (no Anthropic equivalent)
    default: return 'end_turn';
  }
}

/**
 * Sentinel Message returned when gateway.chat throws AIConfigError (missing
 * API key, or the provider rejecting the model/config with a 4xx — with no
 * runtime model allowlist, a nonexistent model id surfaces here as the
 * provider's model_not_found). The caller's JSON parser will fail on this
 * text, fall through to `LLM_OUTPUT_NOT_JSON`, and surface the sentinel as
 * the answer — matches the legacy graceful-degradation shape.
 *
 * When the thrown error is in hand, its own message + fix are surfaced (they
 * name the actual cause: which key is missing, or what the provider rejected)
 * instead of the generic key advice — the generic text key-blamed provider
 * 4xxs like model_not_found.
 */
function buildGracefulMessage(modelStr: string, err?: AIConfigError): {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: 'end_turn';
} {
  return {
    id: '',
    type: 'message',
    role: 'assistant',
    model: modelStr,
    content: [{
      type: 'text',
      text: err
        ? `(no LLM available — ${err.message}${err.fix ? ` Fix: ${err.fix}` : ''})`
        : '(no LLM available — set anthropic_api_key via gbrain config or ANTHROPIC_API_KEY env)',
    }],
    usage: { input_tokens: 0, output_tokens: 0 },
    stop_reason: 'end_turn',
  };
}

// Test-only exports for the adapter helpers. The functions live at module
// scope (not inside runThink) so they can be unit-tested directly. Naming
// follows the `__` prefix convention already established by
// `__setChatTransportForTests` in gateway.ts.
export const __thinkAdapter = {
  tryBuildGatewayClient,
  chatResultToMessage,
  mapStopReason,
  buildGracefulMessage,
  hasAnthropicKey,
};
