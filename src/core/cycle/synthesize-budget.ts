/**
 * Synthesize-phase token budgets: the pure helpers behind how much of a
 * transcript a dream child sees and how much work it is allowed to do.
 *
 *   - per-chunk character budget (`computeChunkCharBudget`): resolved model
 *     context × headroom, or the operator's `dream.synthesize.max_prompt_tokens`
 *     floored at `MIN_PROMPT_TOKENS`;
 *   - transcript compaction (`prepareTranscriptForSynthesis`): meeting files
 *     that carry a curated summary before a verbatim `## Transcript` appendix
 *     are submitted without the appendix;
 *   - depth tiers (`inferSynthesisDepth`, `triageDepthHint`,
 *     `classifySynthesisDepths`): 'standard' vs 'deep' per passing transcript,
 *     driving the per-child turn / output-token / page caps loaded by
 *     `loadSynthesisDepthBudgets` and picked by `resolveDepthBudget`;
 *   - the prompt fragments (`synthesisDepthPromptBlock`, `pageCapPolicyRules`)
 *     and the phase-report telemetry (`buildPromptVolumeTelemetry`,
 *     `buildSynthesisDepthTelemetry`) that surface those decisions.
 *
 * Everything here is pure (config reads aside) and queue-free so it can be
 * unit-tested without a drain; `synthesize.ts` re-exports the test-facing
 * symbols so callers keep importing from the phase module.
 */

import { AIConfigError } from '../ai/errors.ts';
import { resolveChatContextTokens } from '../ai/model-resolver.ts';
import { normalizeModelId, splitProviderModelId } from '../model-id.ts';
import type { BrainEngine, DreamVerdict } from '../engine.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';

// ── Per-chunk character budget ────────────────────────────────────────

/** Token-to-char ratio. 3.5 matches PR #748; conservative for English text. */
export const CHARS_PER_TOKEN = 3.5;
/** Reserve 10% of context window for system prompt + tool defs + output. */
const HEADROOM_RATIO = 0.9;
/**
 * Floor on user-overridable max_prompt_tokens. The former 100K floor made a
 * configured 30K ceiling a silent no-op and routinely shipped whole meeting
 * transcripts to the model. Eight thousand still leaves room for a useful
 * evidence packet while allowing operators to bound background work.
 */
export const MIN_PROMPT_TOKENS = 8_000;
/** Conservative default budget when model is unknown (200K × HEADROOM_RATIO). */
const UNKNOWN_MODEL_BUDGET_TOKENS = 180_000;

/**
 * Compute per-chunk character budget for the resolved model + config override.
 *
 * Resolution:
 *   - configMaxPromptTokens (already floored at MIN_PROMPT_TOKENS) wins when set.
 *   - Else the official recipe/model resolver's context declaration × HEADROOM_RATIO.
 *   - Else (unqualified custom id / unknown provider / undeclared recipe) UNKNOWN_MODEL_BUDGET_TOKENS, with
 *     a once-per-process stderr warning.
 *
 * D7 scope: this bounds the INITIAL prompt size only. Tool-loop turn-N
 * accumulation is out of scope for v0.30.2 (terminal-error classification
 * catches turn-N blowups; per-turn budget guard is a v0.31+ follow-up).
 */
export function computeChunkCharBudget(
  model: string,
  configMaxPromptTokens: number | null,
): number {
  if (configMaxPromptTokens !== null) {
    return Math.floor(configMaxPromptTokens * CHARS_PER_TOKEN);
  }
  // Bare Claude ids are the one legacy shape resolveModel may still return;
  // all other bare/custom ids remain unknown rather than guessing a provider.
  const split = splitProviderModelId(model);
  const qualified = split.provider
    ? model
    : model.startsWith('claude-')
      ? normalizeModelId(model)
      : null;
  let ctx: number | undefined;
  if (qualified) {
    try {
      ctx = resolveChatContextTokens(qualified);
    } catch (err) {
      if (!(err instanceof AIConfigError)) throw err;
    }
  }
  if (ctx === undefined) {
    warnUnknownModelOnce(model);
    return Math.floor(UNKNOWN_MODEL_BUDGET_TOKENS * CHARS_PER_TOKEN);
  }
  return Math.floor(ctx * HEADROOM_RATIO * CHARS_PER_TOKEN);
}

const _unknownModelWarned = new Set<string>();
function warnUnknownModelOnce(model: string): void {
  if (_unknownModelWarned.has(model)) return;
  _unknownModelWarned.add(model);
  process.stderr.write(
    `[dream] model "${model}" has no declared chat context window; ` +
    `using ${UNKNOWN_MODEL_BUDGET_TOKENS}-token fallback budget. ` +
    `Set dream.synthesize.max_prompt_tokens to override.\n`,
  );
}

/** Numeric config read that honors an explicit 0 (no `|| fallback`). */
export async function getNumberConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

// ── Depth-tiered synthesis (token-churn controls) ─────────────────────

/** Per-transcript synthesis depth: compact background update vs full analysis. */
export type SynthesisDepth = 'standard' | 'deep';

/**
 * Child tool surface. The prompt only ever asks for search/query (existing
 * pages), get_page (load-bearing evidence) and put_page (the write); the rest
 * of the subagent registry is dead weight in every turn's tool block. Short
 * names resolve against the `brain_*` registry (filterAllowedTools). Oneshot
 * children need only put_page and ignore the rest.
 */
export const DREAM_ALLOWED_TOOLS = ['search', 'query', 'get_page', 'put_page'] as const;

/** Agentic-loop system preamble (oneshot children use their own static contract). */
export const DREAM_SYSTEM_PROMPT =
  'You are gBrain\'s Dream synthesis editor. Preserve durable insight, not transcript volume. ' +
  'Use the smallest sufficient evidence set, write useful pages through put_page, and never ' +
  'substitute a long prose answer for the requested database write.';

/**
 * Granola files already contain a curated summary and commitments before the
 * verbatim `## Transcript` appendix. Dream should reason over that high-signal
 * packet instead of paying to reread the raw transcript. The raw-content hash
 * remains the idempotency identity, so an edited source still gets reconsidered.
 */
export function prepareTranscriptForSynthesis(t: DiscoveredTranscript): string {
  const isMeeting = /(?:^|[/\\])raw[/\\]meetings(?:[/\\]|$)/i.test(t.filePath) ||
    /(?:^|-)granola(?:-|$)/i.test(t.basename);
  if (!isMeeting) return t.content;
  const marker = /\n## Transcript\s*\r?\n/i.exec(t.content);
  // A small but real curated packet is still enough. Ten of the current
  // Granola files have useful summaries under the former 800-char guard,
  // including several multi-thousand-character raw appendices.
  if (!marker || marker.index < 200) return t.content;
  return t.content.slice(0, marker.index).trimEnd() +
    '\n\n[Verbatim transcript omitted: Dream used the source commitments and curated meeting summary.]\n';
}

/** Cached pre-depth verdicts still escalate when their reasons or filename are clearly strategic. */
export function inferSynthesisDepth(
  t: DiscoveredTranscript,
  reasons: string[],
  judgedDepth?: SynthesisDepth,
): SynthesisDepth {
  if (judgedDepth === 'deep') return 'deep';
  const signal = `${t.basename} ${reasons.join(' ')}`.toLowerCase();
  return /(strateg|decision|thesis|mental model|original idea|reflection|personal pattern|emotion|brain session|quarterly|business review|acquisition)/i.test(signal)
    ? 'deep'
    : 'standard';
}

/** Triage content types whose HIGH-band verdicts are deep-tier material. */
const DEEP_CONTENT_TYPES = new Set(['reflection', 'idea', 'strategy']);

/**
 * Depth hint from a scored triage verdict (#4152 shape): a HIGH-band score
 * (>= 0.7) on reflection/idea/strategy content is the "consequential
 * decision, original thesis, rich self-reflection" case the deep tier exists
 * for. Anything else returns undefined so inferSynthesisDepth's
 * basename/reason heuristics decide. Legacy boolean-era rows (score null)
 * carry no hint.
 */
export function triageDepthHint(
  v: Pick<DreamVerdict, 'score' | 'content_type'> | undefined,
): SynthesisDepth | undefined {
  if (!v || v.score === null || v.score < 0.7) return undefined;
  return v.content_type !== null && DEEP_CONTENT_TYPES.has(v.content_type) ? 'deep' : undefined;
}

/**
 * Depth tier per passing transcript: a HIGH-band reflection/idea/strategy
 * verdict hints 'deep'; otherwise basename + judge reasons decide
 * (inferSynthesisDepth). Drives the per-child turn/token/page budgets.
 */
export function classifySynthesisDepths(
  worthProcessing: readonly DiscoveredTranscript[],
  reasonsByPath: ReadonlyMap<string, { reasons: string[] }>,
  verdictByPath: ReadonlyMap<string, Pick<DreamVerdict, 'score' | 'content_type'>>,
): Map<string, SynthesisDepth> {
  const depthByPath = new Map<string, SynthesisDepth>();
  for (const t of worthProcessing) {
    depthByPath.set(t.filePath, inferSynthesisDepth(
      t,
      reasonsByPath.get(t.filePath)?.reasons ?? [],
      triageDepthHint(verdictByPath.get(t.filePath)),
    ));
  }
  return depthByPath;
}

/**
 * Depth-tiered child budgets (mixed into `SynthConfig`). `inferSynthesisDepth`
 * classifies each passing transcript as 'standard' (compact background
 * synthesis) or 'deep' (strategic/reflective material; also hinted by a
 * HIGH-band triage score on reflection/idea/strategy content). Turn budgets
 * default to `maxTurns` so the split is OPT-IN via
 * dream.synthesize.standard_max_turns / deep_max_turns; output caps are null
 * unless dream.synthesize.{standard,deep}_max_tokens is set (the handler's
 * model-aware default applies otherwise); page caps default 2 / 6 and ride
 * into the prompt as an OUTPUT POLICY rule.
 */
export interface SynthesisDepthBudgets {
  standardMaxTurns: number;
  standardMaxTokens: number | null;
  standardMaxPages: number;
  deepMaxTurns: number;
  deepMaxTokens: number | null;
  deepMaxPages: number;
}

/** The (turns, output tokens, pages) triple a child of the given depth runs under. */
export interface ResolvedDepthBudget {
  maxTurns: number;
  maxTokens: number | null;
  maxPages: number;
}

/**
 * Read the depth-tiered budgets. Turn defaults inherit `maxTurns` so an unset
 * install behaves exactly like dream.synthesize.max_turns (pinned by
 * test/e2e/dream-synthesize-chunking); deep >= standard, floor 1.
 */
export async function loadSynthesisDepthBudgets(
  engine: BrainEngine,
  maxTurns: number,
): Promise<SynthesisDepthBudgets> {
  const standardMaxTurns = Math.max(1,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.standard_max_turns', maxTurns)) || 1);
  const deepMaxTurns = Math.max(standardMaxTurns,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.deep_max_turns', maxTurns)) || 1);
  // Output caps are opt-in: null keeps the handler's model-aware default.
  const readOptionalCap = async (key: string, floor: number): Promise<number | null> => {
    const raw = await engine.getConfig(key);
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(floor, Math.floor(n)) : null;
  };
  const standardMaxTokens = await readOptionalCap('dream.synthesize.standard_max_tokens', 1024);
  const deepMaxTokensRaw = await readOptionalCap('dream.synthesize.deep_max_tokens', 1024);
  const deepMaxTokens = deepMaxTokensRaw === null ? null : Math.max(standardMaxTokens ?? 0, deepMaxTokensRaw);
  const standardMaxPages = Math.max(1,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.standard_max_pages', 2)) || 1);
  const deepMaxPages = Math.max(standardMaxPages,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.deep_max_pages', 6)) || 1);
  return { standardMaxTurns, standardMaxTokens, standardMaxPages, deepMaxTurns, deepMaxTokens, deepMaxPages };
}

/** Pick the child budget triple for a depth tier. */
export function resolveDepthBudget(
  budgets: SynthesisDepthBudgets,
  depth: SynthesisDepth,
): ResolvedDepthBudget {
  return depth === 'deep'
    ? { maxTurns: budgets.deepMaxTurns, maxTokens: budgets.deepMaxTokens, maxPages: budgets.deepMaxPages }
    : { maxTurns: budgets.standardMaxTurns, maxTokens: budgets.standardMaxTokens, maxPages: budgets.standardMaxPages };
}

// ── Prompt fragments ──────────────────────────────────────────────────

/** The `SYNTHESIS DEPTH` block of the child prompt (between CONTEXT and OUTPUT POLICY). */
export function synthesisDepthPromptBlock(depth: SynthesisDepth): string {
  return `SYNTHESIS DEPTH: ${depth.toUpperCase()}
- ${depth === 'deep'
    ? 'Develop the implications, tensions, counterarguments, and decisions this material supports. Depth is welcome when it produces durable judgment.'
    : 'Capture the durable update or lesson compactly. Do not inflate routine material into a thesis.'}`;
}

/**
 * OUTPUT POLICY rules 8-10: the page cap (every mode) plus the retrieval
 * budget and put_page-only rules that only make sense for the agentic loop.
 */
export function pageCapPolicyRules(maxPages: number, mode: 'agentic' | 'oneshot'): string {
  return `8. Write at most ${maxPages} page${maxPages === 1 ? '' : 's'}. Quality and durability beat coverage; do not inflate routine material into a thesis.${mode === 'agentic' ? `
9. Retrieval budget: prefer ONE \`query\` call (detail=low, limit=3) over broad searching; call \`get_page\` only when a result's full text is load-bearing for what you write.
10. Every page is created through \`put_page\`. Never draft an unwritten page in the final message.` : ''}`;
}

// ── Phase-report telemetry ────────────────────────────────────────────

/** Deep-tier transcripts actually submitted this run (not skipped, not budget-deferred). */
export function countDeepTranscripts(
  worthProcessing: readonly DiscoveredTranscript[],
  depthByPath: ReadonlyMap<string, SynthesisDepth>,
  skippedPaths: ReadonlySet<string>,
  deferredBasenames: ReadonlySet<string>,
  basenameOf: (filePath: string) => string,
): number {
  return worthProcessing.filter(
    t => depthByPath.get(t.filePath) === 'deep'
      && !skippedPaths.has(t.filePath)
      && !deferredBasenames.has(basenameOf(t.filePath)),
  ).length;
}

/** `synthesis_depth` block of the phase report. */
export function buildSynthesisDepthTelemetry(
  submittedTranscripts: number,
  deepTranscripts: number,
): { standard_transcripts: number; deep_transcripts: number } {
  return {
    standard_transcripts: Math.max(0, submittedTranscripts - deepTranscripts),
    deep_transcripts: deepTranscripts,
  };
}

/**
 * `prompt_volume` block of the phase report. Character counts are
 * provider-neutral and stay trustworthy even when a CLI adapter reports
 * placeholder token usage.
 */
export function buildPromptVolumeTelemetry(
  sourceChars: number,
  preparedChars: number,
): { source_chars: number; prepared_chars: number; compaction_saved_chars: number } {
  return {
    source_chars: sourceChars,
    prepared_chars: preparedChars,
    compaction_saved_chars: Math.max(0, sourceChars - preparedChars),
  };
}
