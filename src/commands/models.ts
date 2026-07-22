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
  { key: 'models.eval.contradictions_judge', tier: 'utility',  description: 'Contradiction probe judge (v0.34 temporal-aware)' },
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
  lines.push('Tip: probe reachability with `gbrain models doctor` (opt-in; spends a minimal request per configured chat/embed/rerank surface).');
  return lines.join('\n');
}

// ── Doctor (probe) mode ────────────────────────────────────────────

type ProbeStatus = 'ok' | 'model_not_found' | 'auth' | 'rate_limit' | 'network' | 'config' | 'unknown';

interface ProbeResult {
  model: string;
  touchpoint: 'chat' | 'expansion' | 'embedding_config' | 'embedding_reachability' | 'reranker_config';
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
 * v0.40.6.1: resolve the reranker model the same way live search does, so
 * doctor doesn't drift from the live path. Pre-v0.40.6.1 the probe read
 * `getRerankerModel()` from the gateway, which is fed from
 * `GBrainConfig.reranker_model` — a file-plane field nothing currently
 * writes. Meanwhile live search resolves `search.reranker.model` via
 * `resolveSearchMode()` (per-call > config-key > recipe > bundle default).
 * The two paths could disagree silently: doctor says "not configured"
 * while every `gbrain search` call is using a mode default. This helper
 * walks the same chain live search does so doctor's verdict matches.
 *
 * Falls back to `getRerankerModel()` (gateway value) when the engine path
 * fails, so doctor stays useful in degraded states.
 */
export async function resolveLiveRerankerModel(engine: BrainEngine): Promise<string | undefined> {
  try {
    const { loadSearchModeConfig, resolveSearchMode } = await import('../core/search/mode.ts');
    const input = await loadSearchModeConfig(engine);
    const resolved = resolveSearchMode(input);
    return resolved.reranker_enabled ? resolved.reranker_model : undefined;
  } catch {
    const { getRerankerModel } = await import('../core/ai/gateway.ts');
    return getRerankerModel();
  }
}

/**
 * Resolve the reranker timeout the same way live search does, via
 * `loadSearchModeConfig` + `resolveSearchMode`. Precedence chain:
 *   per-call > `search.reranker.timeout_ms` config > recipe `default_timeout_ms` > mode bundle.
 *
 * Codex outside-voice (Pass 9 of the wave) caught the probe lying either way
 * when the operator sets `search.reranker.timeout_ms`: the probe used the
 * recipe default (30s for llama) while production search used the (lower)
 * config value, so doctor reported reachable while production always
 * timed out. Same fix shape as `resolveLiveRerankerModel`.
 */
export async function resolveLiveRerankerTimeoutMs(engine: BrainEngine): Promise<number> {
  try {
    const { loadSearchModeConfig, resolveSearchMode } = await import('../core/search/mode.ts');
    const input = await loadSearchModeConfig(engine);
    const resolved = resolveSearchMode(input);
    return resolved.reranker_timeout_ms ?? 5000;
  } catch {
    return 5000;
  }
}

/**
 * v0.35.0.0+: zero-network reranker config probe. Validates that the
 * configured reranker model resolves through the recipe registry, that the
 * recipe declares a `reranker` touchpoint, and that the model is in the
 * touchpoint's `models[]` allowlist.
 *
 * CDX2-F11: `assertTouchpoint()` does NOT enforce allowlists for
 * openai-compatible recipes — the probe does it directly here. Without
 * this, `search.reranker.model=zeroentropyai:made-up-name` would silently
 * pass config probes and fail at first rerank call.
 *
 * v0.40.6.1: resolves via `resolveLiveRerankerModel(engine)` so probe and
 * live search read the same value (closes the file-plane / DB-plane
 * divergence flagged in plan review).
 *
 * Returns 'ok' when reranker is unconfigured (default state — opt-in
 * feature). Surfaces `status: 'config'` with paste-ready fix hint when
 * model is invalid.
 */
async function probeRerankerConfig(engine: BrainEngine): Promise<ProbeResult> {
  const start = Date.now();
  const { resolveRecipe } = await import('../core/ai/model-resolver.ts');

  const modelStr = await resolveLiveRerankerModel(engine);
  if (!modelStr) {
    // Reranker not configured. Default state for fresh installs and any
    // brain that hasn't opted in. Not an error; doctor reports 'ok' so the
    // probe row is informational.
    return {
      model: '(none)',
      touchpoint: 'reranker_config',
      status: 'ok',
      message: 'reranker not configured (set `gbrain config set search.reranker.model <provider:model>` and `search.reranker.enabled true`)',
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
 * v0.35.0.0+: 1-doc reachability probe. Sends a real `POST <recipe path>`
 * with `{query, documents: [doc]}` so the probe actually verifies the
 * server is in reranking mode (not just alive). For llama.cpp specifically,
 * `--reranking` is mutually exclusive with `--embeddings`, and a server in
 * embedding mode would 404/501 the rerank path — which this probe catches
 * via classifyError().
 *
 * Returns 'ok' silently when reranker is unconfigured (no probe needed) —
 * probeRerankerConfig already surfaced the missing-config state.
 *
 * v0.40.6.1: uses the resolved live model (same path live search uses),
 * and reads the per-call timeout from the recipe's `default_timeout_ms`
 * when set — so a CPU-only local reranker's cold-start warmup doesn't
 * cause the probe to false-fail with `network`/timeout.
 */
async function probeRerankerReachability(engine: BrainEngine): Promise<ProbeResult | null> {
  const modelStr = await resolveLiveRerankerModel(engine);
  if (!modelStr) return null;

  // Use the same timeout resolution live search uses: per-call > config >
  // recipe > bundle. Pre-fix the probe read only the recipe default, so an
  // operator who set `search.reranker.timeout_ms=1000` would see doctor wait
  // 30s and report reachable while production search timed out at 1s
  // (codex Pass-9 finding). resolveLiveRerankerTimeoutMs reuses the full
  // precedence chain via mode.ts.
  const probeTimeoutMs = await resolveLiveRerankerTimeoutMs(engine);

  const start = Date.now();
  try {
    const { rerank } = await import('../core/ai/gateway.ts');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs);
    try {
      await rerank({
        model: modelStr,
        query: 'probe',
        documents: ['probe document'],
        signal: controller.signal,
        timeoutMs: probeTimeoutMs,
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

/**
 * v0.40.x: embedding reachability probe. Mirrors probeRerankerReachability —
 * sends a real 1-input `embed(['probe'])` to verify the configured embedding
 * provider actually answers (auth + URL + model loaded). probeEmbeddingConfig
 * is zero-network and only validates dims/recipe shape; for LOCAL providers
 * (ollama, llama-server) it can't tell whether the server is up, so a dead or
 * embedding-mode-off endpoint was previously only discovered at first real
 * embed. Caller gates this on probeEmbeddingConfig returning 'ok' so a config
 * failure isn't reported twice.
 *
 * Cold-start note: a local CPU embedder loading a model on first call can take
 * several seconds; the 5s timeout may trip on the very first probe. Re-run if so.
 */
async function probeEmbeddingReachability(): Promise<ProbeResult | null> {
  const { getEmbeddingModel, embed } = await import('../core/ai/gateway.ts');
  const modelStr = getEmbeddingModel();
  if (!modelStr) return null;

  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('probe timed out after 5s')), 5000);
  try {
    await embed(['probe'], { inputType: 'query', abortSignal: controller.signal });
    return {
      model: modelStr,
      touchpoint: 'embedding_reachability',
      status: 'ok',
      message: 'reachable',
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    const { status, message } = classifyError(err);
    return {
      model: modelStr,
      touchpoint: 'embedding_reachability',
      status,
      message,
      elapsed_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timeoutId);
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
  const embeddingConfig = await probeEmbeddingConfig();
  results.push(embeddingConfig);
  // v0.35.0.0+ reranker config probe — same zero-network model as embedding.
  // v0.40.6.1: takes the engine so it can read the same `search.reranker.*`
  // config keys live search reads (closes file-plane / DB-plane divergence).
  results.push(await probeRerankerConfig(engine));

  for (const [modelStr, touchpoint] of [[chatModel, 'chat'], [expansionModel, 'expansion']] as const) {
    if (shouldSkipProvider(modelStr, skip)) {
      if (!json) process.stderr.write(`[skip] ${touchpoint}: ${modelStr} (provider in --skip)\n`);
      continue;
    }
    results.push(await probeModel(modelStr, touchpoint));
  }

  // v0.40.x: embedding reachability — only when the config probe passed
  // (codex #8: a config failure shouldn't be reported twice) AND the provider
  // isn't in --skip. Catches a dead/misconfigured LOCAL embed server early.
  if (embeddingConfig.status === 'ok' && !shouldSkipProvider(embeddingConfig.model, skip)) {
    const er = await probeEmbeddingReachability();
    if (er) results.push(er);
  }

  // v0.40.6.1: reranker reachability uses the live-search resolution path
  // (file-plane / DB-plane divergence fix); only fires when reranker is
  // actually enabled per the resolved mode bundle.
  const liveRerankerModel = await resolveLiveRerankerModel(engine);
  if (liveRerankerModel && !shouldSkipProvider(liveRerankerModel, skip)) {
    const r = await probeRerankerReachability(engine);
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
