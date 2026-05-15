/**
 * v0.31.12 — `gbrain models` CLI.
 *
 * Two modes:
 *
 *   `gbrain models`           — read-only routing table. Prints the four
 *                               tier defaults, the resolved value for each
 *                               (after consulting models.default + models.tier.*),
 *                               per-task overrides, alias map, and source-of-truth
 *                               column (default / config / env).
 *
 *   `gbrain models doctor`    — opt-in probe. Fires a 1-token `gateway.chat()`
 *                               call against each configured chat / expansion
 *                               model and reports reachability with the
 *                               provider's error string. Catches the bug class
 *                               that motivated v0.31.12 (the v0.31.6 chat
 *                               default 404'd silently against the Anthropic
 *                               API).
 *
 * Flags:
 *   --json                    — JSON output (both modes)
 *   --skip=<provider>         — narrow `doctor` probe to skip a provider
 *                               (e.g. cost-sensitive operators with rate limits)
 *
 * Per Codex F11 in plan review: no specific dollar cost claim. Probe uses
 * `max_tokens: 1` against each configured model; actual cost depends on
 * provider billing minimums.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  DEFAULT_ALIASES,
  TIER_DEFAULTS,
  resolveModel,
  type ModelTier,
} from '../core/model-config.ts';

const TIERS: ModelTier[] = ['utility', 'reasoning', 'deep', 'subagent'];

const PER_TASK_KEYS: Array<{ key: string; tier: ModelTier; description: string }> = [
  { key: 'models.dream.synthesize',         tier: 'reasoning', description: 'Dream synthesis (conversation → brain pages)' },
  { key: 'models.dream.synthesize_verdict', tier: 'utility',   description: 'Dream synthesis verdict (Haiku judge)' },
  { key: 'models.dream.patterns',           tier: 'reasoning', description: 'Pattern discovery (cross-take themes)' },
  { key: 'models.drift',                    tier: 'reasoning', description: 'Drift LLM judge (v0.29 scaffold)' },
  { key: 'models.auto_think',               tier: 'deep',      description: 'Auto-think question answering' },
  { key: 'models.think',                    tier: 'deep',      description: '`gbrain think` synthesis op' },
  { key: 'models.subagent',                 tier: 'subagent',  description: '`gbrain agent run` subagent loop' },
  { key: 'facts.extraction_model',          tier: 'reasoning', description: 'Real-time facts extraction during sync' },
  { key: 'models.eval.longmemeval',         tier: 'reasoning', description: 'LongMemEval benchmark answer-gen' },
  { key: 'models.expansion',                tier: 'utility',   description: 'Query expansion for hybrid search' },
  { key: 'models.chat',                     tier: 'reasoning', description: 'Default `gateway.chat()` model' },
];

interface ModelEntry {
  tier: ModelTier;
  resolved: string;
  source: string;  // "default" | "config: <key>" | "env: <VAR>"
}

interface ModelsReport {
  schema_version: 1;
  global_default: { value: string | null };
  tiers: Record<ModelTier, ModelEntry>;
  per_task: Array<{ key: string; tier: ModelTier; resolved: string; source: string; description: string }>;
  aliases: { defaults: Record<string, string>; user: Record<string, string> };
}

async function probeSource(engine: BrainEngine, configKey: string, envVar: string): Promise<string | null> {
  // For per-task probes, return the source the resolver USED (config / env /
  // tier default / hardcoded). The resolver itself is the source of truth;
  // we re-walk a subset of its precedence here to attribute the value.
  const configVal = await engine.getConfig(configKey);
  if (configVal && configVal.trim()) return `config: ${configKey}`;
  if (process.env[envVar] && process.env[envVar]!.trim()) return `env: ${envVar}`;
  return null;
}

async function buildReport(engine: BrainEngine): Promise<ModelsReport> {
  const globalDefault = await engine.getConfig('models.default');

  const tiers = {} as Record<ModelTier, ModelEntry>;
  for (const t of TIERS) {
    const tierOverride = await engine.getConfig(`models.tier.${t}`);
    // What models.default beats tier — re-walk the chain to attribute properly.
    let source: string;
    if (globalDefault && globalDefault.trim()) {
      source = 'config: models.default';
    } else if (tierOverride && tierOverride.trim()) {
      source = `config: models.tier.${t}`;
    } else {
      source = 'default';
    }
    const resolved = await resolveModel(engine, { tier: t, fallback: TIER_DEFAULTS[t] });
    tiers[t] = { tier: t, resolved, source };
  }

  const per_task: ModelsReport['per_task'] = [];
  for (const { key, tier, description } of PER_TASK_KEYS) {
    const resolved = await resolveModel(engine, { configKey: key, tier, fallback: TIER_DEFAULTS[tier] });
    const explicit = await probeSource(engine, key, 'GBRAIN_MODEL');
    const source = explicit ?? `tier.${tier}`;
    per_task.push({ key, tier, resolved, source, description });
  }

  // User-defined aliases (engine.getConfig is the source; we don't enumerate
  // every possible alias key, just the common ones the docs mention).
  const userAliases: Record<string, string> = {};
  for (const name of ['opus', 'sonnet', 'haiku', 'gemini', 'gpt']) {
    const v = await engine.getConfig(`models.aliases.${name}`);
    if (v && v.trim()) userAliases[name] = v.trim();
  }

  return {
    schema_version: 1,
    global_default: { value: globalDefault?.trim() || null },
    tiers,
    per_task,
    aliases: { defaults: { ...DEFAULT_ALIASES }, user: userAliases },
  };
}

function formatText(report: ModelsReport): string {
  const lines: string[] = [];
  lines.push('Tier routing:');
  for (const t of TIERS) {
    const e = report.tiers[t];
    lines.push(`  tier.${t.padEnd(10)} ${e.resolved.padEnd(45)} [${e.source}]`);
  }
  lines.push('');
  lines.push('Global default:');
  lines.push(`  models.default  ${report.global_default.value ?? '(unset)'}`);
  lines.push('');
  lines.push('Per-task overrides:');
  for (const t of report.per_task) {
    lines.push(`  ${t.key.padEnd(34)} → ${t.resolved.padEnd(45)} [${t.source}]`);
  }
  lines.push('');
  lines.push('Aliases:');
  for (const [k, v] of Object.entries(report.aliases.defaults)) {
    const userOverride = report.aliases.user[k];
    if (userOverride) {
      lines.push(`  ${k.padEnd(8)} → ${userOverride}  (user override; default: ${v})`);
    } else {
      lines.push(`  ${k.padEnd(8)} → ${v}`);
    }
  }
  for (const [k, v] of Object.entries(report.aliases.user)) {
    if (!(k in report.aliases.defaults)) {
      lines.push(`  ${k.padEnd(8)} → ${v}  (user)`);
    }
  }
  lines.push('');
  lines.push('Tip: probe reachability with `gbrain models doctor` (opt-in; spends ~1 token per model).');
  return lines.join('\n');
}

// ── Doctor (probe) mode ────────────────────────────────────────────

type ProbeStatus = 'ok' | 'model_not_found' | 'auth' | 'rate_limit' | 'network' | 'config' | 'unknown';

interface ProbeResult {
  model: string;
  touchpoint: 'chat' | 'expansion' | 'embedding_config' | 'reranker_config';
  status: ProbeStatus;
  message: string;
  elapsed_ms: number;
  fix?: string;
}

function classifyError(err: unknown): { status: ProbeStatus; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (/not_?found|does not exist|invalid_model|model.*invalid|404/.test(lower)) {
    return { status: 'model_not_found', message: msg };
  }
  if (/auth|unauthor|401|403|api[_-]?key/.test(lower)) {
    return { status: 'auth', message: msg };
  }
  if (/rate.?limit|429|too many/.test(lower)) {
    return { status: 'rate_limit', message: msg };
  }
  if (/timeout|network|econn|fetch failed|enotfound/.test(lower)) {
    return { status: 'network', message: msg };
  }
  return { status: 'unknown', message: msg };
}

/**
 * Validate the configured embedding model + dims combo without spending tokens.
 * Catches the bug class where a brain configured for Voyage with a missing or
 * out-of-allowlist `embedding_dimensions` value would fail at first-embed with
 * an opaque HTTP 400. Runs purely against local config + recipe metadata —
 * zero network I/O.
 */
async function probeEmbeddingConfig(): Promise<ProbeResult> {
  const start = Date.now();
  const { getEmbeddingModel, getEmbeddingDimensions } = await import('../core/ai/gateway.ts');
  const { parseModelId } = await import('../core/ai/model-resolver.ts');
  const {
    supportsVoyageOutputDimension, isValidVoyageOutputDim, VOYAGE_VALID_OUTPUT_DIMS,
    supportsZeroEntropyDimension, isValidZeroEntropyDim, ZEROENTROPY_VALID_DIMS,
  } = await import('../core/ai/dims.ts');

  const modelStr = getEmbeddingModel();
  const dims = getEmbeddingDimensions();

  try {
    const { providerId, modelId } = parseModelId(modelStr);

    // Voyage flexible-dim check — the bug class that motivated this probe.
    if (providerId === 'voyage' && supportsVoyageOutputDimension(modelId)) {
      if (!isValidVoyageOutputDim(dims)) {
        return {
          model: modelStr,
          touchpoint: 'embedding_config',
          status: 'config',
          message:
            `embedding_dimensions=${dims} is not a valid Voyage output_dimension ` +
            `for "${modelId}" (allowed: ${VOYAGE_VALID_OUTPUT_DIMS.join('/')}).`,
          fix:
            `gbrain config set embedding_dimensions <${VOYAGE_VALID_OUTPUT_DIMS.join('|')}>, ` +
            `or switch to a fixed-dim Voyage model (e.g. voyage-3, voyage-3-lite).`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    // ZeroEntropy zembed-1 flexible-dim check. Same bug class as Voyage:
    // `embedding_model: zeroentropyai:zembed-1` configured without
    // `embedding_dimensions` falls back to DEFAULT_EMBEDDING_DIMENSIONS=1536
    // (an OpenAI default) which ZE doesn't accept.
    if (providerId === 'zeroentropyai' && supportsZeroEntropyDimension(modelId)) {
      if (!isValidZeroEntropyDim(dims)) {
        return {
          model: modelStr,
          touchpoint: 'embedding_config',
          status: 'config',
          message:
            `embedding_dimensions=${dims} is not a valid ZeroEntropy dimensions ` +
            `for "${modelId}" (allowed: ${ZEROENTROPY_VALID_DIMS.join('/')}).`,
          fix:
            `gbrain config set embedding_dimensions <${ZEROENTROPY_VALID_DIMS.join('|')}>.`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    return {
      model: modelStr,
      touchpoint: 'embedding_config',
      status: 'ok',
      message: `embedding_dimensions=${dims} ok for ${modelStr}`,
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fix = err && typeof err === 'object' && 'fix' in err
      ? (err as { fix?: string }).fix
      : undefined;
    return {
      model: modelStr,
      touchpoint: 'embedding_config',
      status: 'config',
      message: msg,
      fix,
      elapsed_ms: Date.now() - start,
    };
  }
}

/**
 * v0.33.2+: zero-network reranker config probe. Validates that the
 * configured reranker model resolves through the recipe registry, that the
 * recipe declares a `reranker` touchpoint, and that the model is in the
 * touchpoint's `models[]` allowlist.
 *
 * CDX2-F11: `assertTouchpoint()` does NOT enforce allowlists for
 * openai-compatible recipes — the probe does it directly here. Without
 * this, `search.reranker.model=zeroentropyai:made-up-name` would silently
 * pass config probes and fail at first rerank call.
 *
 * Returns 'ok' when reranker is unconfigured (default state — opt-in
 * feature). Surfaces `status: 'config'` with paste-ready fix hint when
 * model is invalid.
 */
async function probeRerankerConfig(): Promise<ProbeResult> {
  const start = Date.now();
  const { getRerankerModel } = await import('../core/ai/gateway.ts');
  const { resolveRecipe } = await import('../core/ai/model-resolver.ts');

  const modelStr = getRerankerModel();
  if (!modelStr) {
    // Reranker not configured. Default state for fresh installs and any
    // brain that hasn't opted in. Not an error; doctor reports 'ok' so the
    // probe row is informational.
    return {
      model: '(none)',
      touchpoint: 'reranker_config',
      status: 'ok',
      message: 'reranker not configured (set GBRAIN_RERANKER_MODEL or `gbrain config set search.reranker.enabled true`)',
      elapsed_ms: Date.now() - start,
    };
  }

  try {
    const { parsed, recipe } = resolveRecipe(modelStr);
    const tp = recipe.touchpoints.reranker;
    if (!tp) {
      return {
        model: modelStr,
        touchpoint: 'reranker_config',
        status: 'config',
        message: `Provider "${recipe.id}" does not declare a reranker touchpoint.`,
        fix: 'Switch to a provider that does (e.g. zeroentropyai:zerank-2).',
        elapsed_ms: Date.now() - start,
      };
    }
    if (tp.models.length > 0 && !tp.models.includes(parsed.modelId)) {
      return {
        model: modelStr,
        touchpoint: 'reranker_config',
        status: 'config',
        message: `Model "${parsed.modelId}" is not in ${recipe.name}'s reranker allowlist.`,
        fix: `gbrain config set search.reranker.model ${recipe.id}:<one of ${tp.models.join('|')}>`,
        elapsed_ms: Date.now() - start,
      };
    }
    return {
      model: modelStr,
      touchpoint: 'reranker_config',
      status: 'ok',
      message: `reranker configured: ${modelStr}`,
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model: modelStr,
      touchpoint: 'reranker_config',
      status: 'config',
      message: msg,
      elapsed_ms: Date.now() - start,
    };
  }
}

/**
 * v0.33.2+: 1-token-equivalent reranker reachability probe. Sends a minimal
 * `{query, documents: [doc]}` request to verify auth + URL. Uses the same
 * AbortController + 5s timeout pattern as probeModel.
 *
 * Returns 'ok' silently when reranker is unconfigured (no probe needed) —
 * probeRerankerConfig already surfaced the missing-config state.
 */
async function probeRerankerReachability(): Promise<ProbeResult | null> {
  const { getRerankerModel } = await import('../core/ai/gateway.ts');
  const modelStr = getRerankerModel();
  if (!modelStr) return null;

  const start = Date.now();
  try {
    const { rerank } = await import('../core/ai/gateway.ts');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('probe timed out after 5s')), 5000);
    try {
      await rerank({
        query: 'probe',
        documents: ['probe document'],
        signal: controller.signal,
        timeoutMs: 5000,
      });
      return {
        model: modelStr,
        touchpoint: 'reranker_config',
        status: 'ok',
        message: 'reachable',
        elapsed_ms: Date.now() - start,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const { status, message } = classifyError(err);
    return {
      model: modelStr,
      touchpoint: 'reranker_config',
      status,
      message,
      elapsed_ms: Date.now() - start,
    };
  }
}

async function probeModel(modelStr: string, touchpoint: 'chat' | 'expansion'): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { chat } = await import('../core/ai/gateway.ts');
    // Use AbortController so the 5s timeout doesn't hang on a stuck network.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('probe timed out after 5s')), 5000);
    try {
      await chat({
        model: modelStr,
        messages: [{ role: 'user', content: '.' }],
        maxTokens: 1,
        abortSignal: controller.signal,
      });
      return { model: modelStr, touchpoint, status: 'ok', message: 'reachable', elapsed_ms: Date.now() - start };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const { status, message } = classifyError(err);
    return { model: modelStr, touchpoint, status, message, elapsed_ms: Date.now() - start };
  }
}

function shouldSkipProvider(modelStr: string, skip: string[]): boolean {
  if (skip.length === 0) return false;
  const colon = modelStr.indexOf(':');
  const provider = colon === -1 ? '' : modelStr.slice(0, colon).toLowerCase();
  return skip.includes(provider);
}

export async function runModels(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const sub = args[1] === 'doctor' ? 'doctor' : args[1] === 'help' || args.includes('--help') || args.includes('-h') ? 'help' : 'read';

  if (sub === 'help') {
    process.stdout.write(
`Usage:
  gbrain models                   Show routing table (read-only)
  gbrain models doctor [flags]    Probe each configured model (~1 token each)
  gbrain models --json            Machine-readable output

Flags (doctor only):
  --skip=<provider>               Skip a provider (e.g. --skip=openai)
                                  Repeatable: --skip=openai --skip=google
  --json                          JSON output

Configure routing:
  gbrain config set models.default <model>           # global hammer
  gbrain config set models.tier.<tier> <model>       # per-tier (utility/reasoning/deep/subagent)
  gbrain config set models.aliases.<name> <model>    # custom alias

Tiers: utility (haiku-class) | reasoning (sonnet) | deep (opus) | subagent (Anthropic-only)
`);
    return;
  }

  if (sub === 'read') {
    const report = await buildReport(engine);
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatText(report) + '\n');
    }
    return;
  }

  // doctor mode
  const skipArgs = args.filter(a => a.startsWith('--skip='));
  const skip = skipArgs.map(a => a.slice('--skip='.length).toLowerCase()).filter(Boolean);

  const { getChatModel, getExpansionModel } = await import('../core/ai/gateway.ts');
  const chatModel = getChatModel();
  const expansionModel = getExpansionModel();

  const results: ProbeResult[] = [];

  // Config-only probe runs first: zero tokens, catches the bug class where a
  // brain misconfigured for Voyage with the wrong embedding_dimensions would
  // 400 on first embed. Fast feedback before we spend a single token.
  results.push(await probeEmbeddingConfig());
  // v0.33.2+ reranker config probe — same zero-network model as embedding.
  results.push(await probeRerankerConfig());

  for (const [modelStr, touchpoint] of [[chatModel, 'chat'], [expansionModel, 'expansion']] as const) {
    if (shouldSkipProvider(modelStr, skip)) {
      if (!json) process.stderr.write(`[skip] ${touchpoint}: ${modelStr} (provider in --skip)\n`);
      continue;
    }
    results.push(await probeModel(modelStr, touchpoint));
  }

  // v0.33.2+: reranker reachability (only when configured + provider not in --skip).
  const { getRerankerModel } = await import('../core/ai/gateway.ts');
  const rerankerModel = getRerankerModel();
  if (rerankerModel && !shouldSkipProvider(rerankerModel, skip)) {
    const r = await probeRerankerReachability();
    if (r) results.push(r);
  }

  const report = {
    schema_version: 1 as const,
    probes: results,
    summary: {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      failed: results.filter(r => r.status !== 'ok').length,
    },
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('Model reachability probe:\n');
    for (const r of results) {
      const icon = r.status === 'ok' ? '✔' : '✘';
      process.stdout.write(`  ${icon} ${r.touchpoint.padEnd(17)} ${r.model.padEnd(50)} ${r.status} (${r.elapsed_ms}ms)\n`);
      if (r.status !== 'ok') {
        process.stdout.write(`      ${r.message}\n`);
        if (r.fix) process.stdout.write(`      fix: ${r.fix}\n`);
      }
    }
    process.stdout.write(`\nSummary: ${report.summary.ok}/${report.summary.total} reachable.\n`);
  }

  if (report.summary.failed > 0) {
    process.exit(1);
  }
}
