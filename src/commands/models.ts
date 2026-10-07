/**
 * v0.31.12 — `gbrain models` CLI.
 *
 * Two modes:
 *
 *   `gbrain models`           — read-only routing table. Prints the four
 *                               tier defaults, the resolved value for each
 *                               (after consulting models.default + models.tier.*),
 *                               per-task overrides, alias map, and source-of-truth
 *                               column (default / config / env). An older
 *                               Anthropic haiku/sonnet/opus id gets an
 *                               advisory `[newer <family> available: <id>]`
 *                               hint plus the config command.
 *
 *   `gbrain models doctor`   — opt-in probe. Fires a 1-token `gateway.chat()`
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
import { gbrainPath } from '../core/config.ts';
import {
  DEFAULT_ALIASES,
  TIER_DEFAULTS,
  describeResolveOrigin,
  resolveModelDetailed,
  resolveAlias,
  type ModelTier,
  type ResolveModelOpts,
  type ResolveSource,
} from '../core/model-config.ts';
import { resolveExtractAtomsModelWithSource } from '../core/cycle/extract-atoms.ts';
import { resolveFenceRepairModelWithSource } from '../core/fence-repair/model.ts';
import {
  NIGHTLY_PROBE_EXTRACTOR_ROUTE,
  NIGHTLY_PROBE_READER_ROUTE,
  NIGHTLY_PROBE_SLOT_KEYS,
  resolveNightlyProbeModelRoutes,
  type NightlyProbeSlotId,
} from '../core/cycle/nightly-probe-routes.ts';
import { maybeAttachVersionSuffixHint } from '../core/ai/base-url-probe.ts';
import { newerAnthropicModel } from '../core/ai/anthropic-model-ids.ts';
import type { AIGatewayConfig } from '../core/ai/types.ts';

const TIERS: ModelTier[] = ['utility', 'reasoning', 'deep', 'subagent'];

interface PerTaskModelRoute {
  key: string;
  tier: ModelTier;
  description: string;
  deprecatedConfigKey?: string;
  envVar?: string;
  /**
   * #4152 (2A): an explicit pre-read key that wins over the whole
   * resolveModel chain when set — mirrors loadSynthConfig's triage-model
   * resolution so the dashboard reports the ACTUAL spending route.
   */
  overrideKey?: string;
  /**
   * A caller whose runtime resolution DOESN'T go through resolveModel()'s
   * fuller chain (models.tier.<tier> / models.default / env var) — only
   * `key`'s own DB config, then a tier-default fallback. Reporting via the
   * generic chain here would show a resolved value that can diverge from
   * what the caller actually uses in partially-configured installs, so this
   * calls the caller's own resolver instead. The resolver returns model AND
   * attribution from the same call so the reported `source` — rendered as
   * `config: <key>` or `tier.<tier> (caller-specific)` to make the narrower
   * chain visible rather than implying full resolveModel() coverage — can
   * never disagree with the resolved value.
   */
  narrowResolver?: (engine: BrainEngine) => Promise<{ model: string; source: 'config' | 'tier_default' | 'measured' }>;
}

const PER_TASK_KEYS: PerTaskModelRoute[] = [
  { key: 'models.dream.synthesize',         tier: 'reasoning', description: 'Dream synthesis (conversation → brain pages)' },
  {
    key: 'models.dream.synthesize_verdict',
    tier: 'utility',
    description: 'Dream triage judge (scored gate; models.dream.triage preferred)',
    deprecatedConfigKey: 'dream.synthesize.verdict_model',
    overrideKey: 'models.dream.triage',
  },
  { key: 'models.dream.patterns',           tier: 'reasoning', description: 'Pattern discovery (cross-take themes)' },
  {
    key: 'models.dream.extract_atoms',
    tier: 'utility',
    description: 'Atom extraction from transcripts/pages (extract_atoms phase)',
    narrowResolver: resolveExtractAtomsModelWithSource,
  },
  { key: 'models.drift',                    tier: 'reasoning', description: 'Drift LLM judge (v0.29 scaffold)' },
  { key: 'models.auto_think',               tier: 'deep',      description: 'Auto-think question answering' },
  { key: 'models.think',                    tier: 'deep',      description: '`gbrain think` synthesis op' },
  {
    key: 'models.fence_repair',
    tier: 'deep',
    description: 'Model repair (Tier 3) of malformed facts/takes fence rows; unset: the first measured model with a key, else none (off)',
    narrowResolver: async engine => { const r = await resolveFenceRepairModelWithSource(engine); return { model: r.model ?? 'none', source: r.source }; },
  },
  { key: 'models.subagent',                 tier: 'subagent',  description: '`gbrain agent run` subagent loop' },
  { key: 'facts.extraction_model',          tier: 'reasoning', description: 'Real-time facts extraction during sync' },
  { key: 'models.eval.longmemeval',         tier: 'reasoning', description: 'LongMemEval benchmark answer-gen' },
  { key: 'models.eval.contradictions_judge', tier: 'utility',  description: 'Contradiction probe judge (v0.34 temporal-aware)' },
  { key: 'models.expansion',                tier: 'utility',   description: 'Query expansion for hybrid search' },
  {
    key: 'models.contextual_synopsis',
    tier: 'utility',
    description: 'Per-chunk contextual synopsis generation',
    deprecatedConfigKey: 'contextual_retrieval.haiku_model',
    envVar: 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL',
  },
  { key: 'models.chat',                     tier: 'reasoning', description: 'Default `gateway.chat()` model' },
];

interface NewerAvailable {
  family: string;
  model: string;
  command: string;
}

interface ModelEntry {
  tier: ModelTier;
  resolved: string;
  source: string;  // "default" | "config: <key>" | "env: <VAR>"
  newer_available?: NewerAvailable;
}

interface PerTaskEntry {
  key: string;
  tier: ModelTier;
  resolved: string;
  source: string;
  description: string;
  newer_available?: NewerAvailable;
}

interface NightlyProbeRouteEntry {
  model: string;
  source: string;
}

interface NightlyProbeReport {
  reader: NightlyProbeRouteEntry;
  extractor: NightlyProbeRouteEntry;
  /** Judge panel in slot order; `source` is `config: <slot key>`, `panel default` or `substitute for <default> (no usable provider)`. */
  slots: Array<NightlyProbeRouteEntry & { id: string }>;
  /**
   * Slot availability, substitutes and key-aware defaults are judged from this
   * process's environment, not the daemon's: says which keys the daemon may
   * hold that this report cannot see.
   */
  environment_note?: string;
}

interface ModelsReport {
  schema_version: 1;
  global_default: { value: string | null };
  tiers: Record<ModelTier, ModelEntry>;
  per_task: PerTaskEntry[];
  aliases: { defaults: Record<string, string>; user: Record<string, string> };
  nightly_probe: NightlyProbeReport;
}

/**
 * Report label for the chain step `resolveModelDetailed` says won, so the
 * attribution can never disagree with the resolved value. Built-in defaults
 * render as `inheritedLabel` (`default` for tier rows, `tier.<tier>` for
 * per-task rows).
 */
function sourceLabel(
  source: ResolveSource,
  opts: Pick<ResolveModelOpts, 'configKey' | 'deprecatedConfigKey' | 'envVar' | 'tier'>,
  inheritedLabel: string,
): string {
  if (source === 'tier_default' || source === 'fallback') return inheritedLabel;
  const origin = describeResolveOrigin(source, opts);
  return source === 'env' ? `env: ${origin}` : `config: ${origin}`;
}

/**
 * Advisory `[newer <family> available]` hint: set when `resolved` is an
 * Anthropic haiku/sonnet/opus id older than the anthropic recipe's newest
 * priced id in the same family. `configKey` is the key the paste-ready fix
 * sets. Defaults are never changed by this.
 */
function newerAvailable(resolved: string, configKey: string): NewerAvailable | undefined {
  const newer = newerAnthropicModel(resolved);
  if (!newer) return undefined;
  const model = `anthropic:${newer.id}`;
  return { family: newer.family, model: newer.id, command: `gbrain config set ${configKey} ${model}` };
}

async function buildReport(engine: BrainEngine): Promise<ModelsReport> {
  const globalDefault = await engine.getConfig('models.default');

  const tiers = {} as Record<ModelTier, ModelEntry>;
  for (const t of TIERS) {
    const detail = await resolveModelDetailed(engine, { tier: t, fallback: TIER_DEFAULTS[t] });
    const newer = newerAvailable(detail.model, `models.tier.${t}`);
    tiers[t] = {
      tier: t,
      resolved: detail.model,
      source: sourceLabel(detail.source, { tier: t }, 'default'),
      ...(newer ? { newer_available: newer } : {}),
    };
  }

  const per_task: ModelsReport['per_task'] = [];
  for (const route of PER_TASK_KEYS) {
    const { key, tier, description, deprecatedConfigKey, envVar, overrideKey, narrowResolver } = route;
    // Per-task rows carry the hint only when the row's OWN key supplied the
    // model; inherited rows follow their tier row, which already reports it.
    // A caller with its own narrower resolution (doesn't honor models.tier.*
    // / models.default / env var) reports via that exact resolver, not the
    // generic resolveModel() chain — see PerTaskModelRoute.narrowResolver.
    if (narrowResolver) {
      // ONE resolver call feeds both the resolved model and the attribution,
      // so the label can never disagree with what `resolved` actually
      // reflects (previously a separate getConfig truthiness re-check).
      const { model: resolved, source: narrowSource } = await narrowResolver(engine);
      const source = narrowSource === 'config' ? `config: ${key}` : narrowSource === 'measured' ? 'measured default' : `tier.${tier} (caller-specific)`;
      const newer = narrowSource === 'config' ? newerAvailable(resolved, key) : undefined;
      per_task.push({ key, tier, resolved, source, description, ...(newer ? { newer_available: newer } : {}) });
      continue;
    }
    // Explicit pre-read override (loadSynthConfig 2A parity): when set, it IS
    // the effective spending route and must be reported as such.
    const overrideValue = overrideKey ? await engine.getConfig(overrideKey) : null;
    if (overrideKey && overrideValue?.trim()) {
      const resolved = await resolveAlias(engine, overrideValue.trim());
      const newer = newerAvailable(resolved, overrideKey);
      per_task.push({ key, tier, resolved, source: `config: ${overrideKey}`, description, ...(newer ? { newer_available: newer } : {}) });
      continue;
    }
    const opts = { configKey: key, deprecatedConfigKey, envVar, tier };
    const detail = await resolveModelDetailed(engine, { ...opts, fallback: TIER_DEFAULTS[tier] });
    const ownKey = detail.source === 'config_key' || detail.source === 'deprecated_key';
    const newer = ownKey ? newerAvailable(detail.model, key) : undefined;
    per_task.push({
      key,
      tier,
      resolved: detail.model,
      source: sourceLabel(detail.source, opts, `tier.${tier}`),
      description,
      ...(newer ? { newer_available: newer } : {}),
    });
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
    nightly_probe: await buildNightlyProbeReport(engine),
  };
}

/**
 * The nightly quality probe's routes as the probe resolves them (#5872): the
 * probe's own route resolver, then the #4636 substitution over the panel
 * defaults against this process's brain-configured gateway (silent log —
 * the report labels each substituted slot instead). The daemon's launcher
 * also sources the gbrain env file, which this command never loads, so the
 * report names that gap instead of reading a secrets file.
 */
async function buildNightlyProbeReport(engine: BrainEngine): Promise<NightlyProbeReport> {
  const routes = await resolveNightlyProbeModelRoutes(engine);
  const { substituteUnavailableDefaultSlots } = await import('./eval-cross-modal.ts');
  const { DEFAULT_SLOTS } = await import('../core/cross-modal-eval/runner.ts');
  const explicit: Record<string, string | undefined> = routes.slots;
  const panel = substituteUnavailableDefaultSlots(
    DEFAULT_SLOTS.map(s => ({ id: s.id, model: explicit[s.id] ?? s.model })),
    explicit,
    () => {},
  );
  return {
    reader: {
      model: routes.reader.model,
      source: sourceLabel(routes.reader.source, NIGHTLY_PROBE_READER_ROUTE, 'tier.reasoning'),
    },
    extractor: {
      model: routes.extractor.model,
      source: sourceLabel(routes.extractor.source, NIGHTLY_PROBE_EXTRACTOR_ROUTE, 'tier.utility'),
    },
    slots: panel.map((slot, i) => {
      const panelDefault = DEFAULT_SLOTS[i]!.model;
      const source = explicit[slot.id]
        ? `config: ${NIGHTLY_PROBE_SLOT_KEYS[slot.id as NightlyProbeSlotId]}`
        : slot.model === panelDefault ? 'panel default' : `substitute for ${panelDefault} (no usable provider)`;
      return { id: slot.id, model: slot.model, source };
    }),
    environment_note:
      "Slot availability, substitutes and key-aware defaults are judged from this process's environment; " +
      `a provider key set only in ${gbrainPath('env')} (sourced by the autopilot daemon's launcher) reads here as unavailable.`,
  };
}

function formatNewer(newer: NewerAvailable | undefined): string {
  return newer ? ` [newer ${newer.family} available: ${newer.model}] (${newer.command})` : '';
}

function formatText(report: ModelsReport): string {
  const lines: string[] = [];
  lines.push('Tier routing:');
  for (const t of TIERS) {
    const e = report.tiers[t];
    lines.push(`  tier.${t.padEnd(10)} ${e.resolved.padEnd(45)} [${e.source}]${formatNewer(e.newer_available)}`);
  }
  lines.push('');
  lines.push('Global default:');
  lines.push(`  models.default  ${report.global_default.value ?? '(unset)'}`);
  lines.push('');
  lines.push('Per-task overrides:');
  for (const t of report.per_task) {
    lines.push(`  ${t.key.padEnd(34)} → ${t.resolved.padEnd(45)} [${t.source}]${formatNewer(t.newer_available)}`);
  }
  lines.push('');
  lines.push('Nightly quality probe (autopilot.nightly_quality_probe):');
  const probe = report.nightly_probe;
  const probeRows: Array<[string, NightlyProbeRouteEntry]> = [
    ['reader (LongMemEval answers)', probe.reader],
    ['extractor (trajectory claims)', probe.extractor],
    ...probe.slots.map(s => [`judge slot ${s.id}`, s] as [string, NightlyProbeRouteEntry]),
  ];
  for (const [label, route] of probeRows) {
    lines.push(`  ${label.padEnd(34)} → ${route.model.padEnd(45)} [${route.source}]`);
  }
  if (probe.environment_note) lines.push(`  Note: ${probe.environment_note}`);
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

/** Injectable transport + per-run hint cache for the doctor probes. */
interface ProbeDeps {
  chat?: typeof import('../core/ai/gateway.ts').chat;
  embed?: typeof import('../core/ai/gateway.ts').embed;
  rerank?: typeof import('../core/ai/gateway.ts').rerank;
  cfg?: AIGatewayConfig;
  fetchImpl?: typeof fetch;
  cache?: Map<string, string | undefined>;
}

/**
 * Build a failed-probe ProbeResult and attach the base-URL version hint. Shared
 * by the three reachability-probe catch blocks. `resultTouchpoint` names the
 * result row; `hintTouchpoint` is the auth-resolution touchpoint the hint uses.
 */
async function failedProbe(
  err: unknown,
  modelStr: string,
  resultTouchpoint: ProbeResult['touchpoint'],
  hintTouchpoint: 'embedding' | 'expansion' | 'chat' | 'reranker',
  start: number,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const { status, message } = classifyError(err);
  const result: ProbeResult = { model: modelStr, touchpoint: resultTouchpoint, status, message, elapsed_ms: Date.now() - start };
  await maybeAttachVersionSuffixHint(result, modelStr, hintTouchpoint, deps);
  return result;
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
        fix: 'Switch to a provider that does (e.g. voyage:rerank-2.5).',
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
export async function probeRerankerReachability(engine: BrainEngine, deps: ProbeDeps = {}): Promise<ProbeResult | null> {
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
    const rerank = deps.rerank ?? (await import('../core/ai/gateway.ts')).rerank;
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
    return failedProbe(err, modelStr, 'reranker_config', 'reranker', start, deps);
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
export async function probeEmbeddingReachability(deps: ProbeDeps = {}): Promise<ProbeResult | null> {
  const gw = await import('../core/ai/gateway.ts');
  const modelStr = gw.getEmbeddingModel();
  if (!modelStr) return null;
  const embed = deps.embed ?? gw.embed;

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
    return failedProbe(err, modelStr, 'embedding_reachability', 'embedding', start, deps);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve the chat/expansion probe timeout: the recipe's declared
 * `touchpoints.<kind>.default_timeout_ms` when set, else the probe's
 * historical flat 5000ms.
 *
 * Pre-fix `probeModel` hardcoded 5000ms for every provider. That's fine for
 * a plain network round-trip, but `claude-cli:` dispatches through a
 * `claude -p (print mode)` subprocess (CLI cold start + user-level CLAUDE.md load),
 * which routinely takes 5-6s even when healthy — so the probe aborted on
 * every run and reported 'unknown — claude-cli adapter aborted', not
 * because the model was actually unreachable. Mirrors the reranker probe's
 * recipe-default fallback (`resolveLiveRerankerTimeoutMs` / mode.ts), but
 * simpler: unlike `search.reranker.timeout_ms`, there's no config-key
 * override for chat/expansion timeouts, so the chain is just per-call
 * default (5000) unless the recipe overrides it.
 */
/** Historical flat probe timeout — right for fast HTTP providers; recipes override via default_timeout_ms. */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export async function resolveChatProbeTimeoutMs(modelStr: string, touchpoint: 'chat' | 'expansion'): Promise<number> {
  try {
    const { resolveRecipe } = await import('../core/ai/model-resolver.ts');
    const { recipe } = resolveRecipe(modelStr);
    return recipe.touchpoints[touchpoint]?.default_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS;
  } catch {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
}

export async function probeModel(modelStr: string, touchpoint: 'chat' | 'expansion', deps: ProbeDeps = {}): Promise<ProbeResult> {
  const start = Date.now();
  const probeTimeoutMs = await resolveChatProbeTimeoutMs(modelStr, touchpoint);
  try {
    const chat = deps.chat ?? (await import('../core/ai/gateway.ts')).chat;
    // Use AbortController so the resolved timeout doesn't hang on a stuck network.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs);
    try {
      await chat({
        model: modelStr,
        // A probe reports on this model; a chain hop would answer for another.
        allowFallback: false,
        messages: [{ role: 'user', content: '.' }],
        // OpenAI rejects max_output_tokens below 16 ("Invalid
        // 'max_output_tokens': integer below minimum value. Expected a value
        // >= 16, but got 1 instead."), so a probe of 1 fails for EVERY
        // OpenAI-family chat model regardless of whether it is reachable —
        // which is precisely what this check exists to tell apart. 16 is the
        // documented floor; the probe still costs at most 16 output tokens.
        maxTokens: 16,
        abortSignal: controller.signal,
      });
      return { model: modelStr, touchpoint, status: 'ok', message: 'reachable', elapsed_ms: Date.now() - start };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    return failedProbe(err, modelStr, touchpoint, touchpoint, start, deps);
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
  // args is `subArgs` from cli.ts `handleCliOnly` — the leading 'models'
  // token has already been stripped. The subcommand is at args[0], NOT
  // args[1]. Pre-fix this check was `args[1]`, so `gbrain models doctor`
  // silently fell through to the read view. The doctor probe path was
  // unreachable from the CLI.
  //
  // --help honored FIRST so `gbrain models doctor --help` shows usage
  // instead of running network probes (which would spend tokens or
  // exit nonzero when the user only asked for help). Pre-fix the
  // args[1] ternary happened to dodge this by always falling through
  // to the args.includes('--help') branch; the args[0] rewrite needs
  // explicit ordering to preserve that behavior.
  const hasHelp = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  const sub = hasHelp ? 'help' : args[0] === 'doctor' ? 'doctor' : 'read';

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

  // Per-run cache so several probe sites sharing a base URL run the base-URL
  // /models sweep once, not once per site.
  const hintCache = new Map<string, string | undefined>();

  for (const [modelStr, touchpoint] of [[chatModel, 'chat'], [expansionModel, 'expansion']] as const) {
    if (shouldSkipProvider(modelStr, skip)) {
      if (!json) process.stderr.write(`[skip] ${touchpoint}: ${modelStr} (provider in --skip)\n`);
      continue;
    }
    results.push(await probeModel(modelStr, touchpoint, { cache: hintCache }));
  }

  // v0.40.x: embedding reachability — only when the config probe passed
  // (codex #8: a config failure shouldn't be reported twice) AND the provider
  // isn't in --skip. Catches a dead/misconfigured LOCAL embed server early.
  if (embeddingConfig.status === 'ok' && !shouldSkipProvider(embeddingConfig.model, skip)) {
    const er = await probeEmbeddingReachability({ cache: hintCache });
    if (er) results.push(er);
  }

  // v0.40.6.1: reranker reachability uses the live-search resolution path
  // (file-plane / DB-plane divergence fix); only fires when reranker is
  // actually enabled per the resolved mode bundle.
  const liveRerankerModel = await resolveLiveRerankerModel(engine);
  if (liveRerankerModel && !shouldSkipProvider(liveRerankerModel, skip)) {
    const r = await probeRerankerReachability(engine, { cache: hintCache });
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
