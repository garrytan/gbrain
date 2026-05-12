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

type ProbeStatus = 'ok' | 'model_not_found' | 'auth' | 'rate_limit' | 'network' | 'unknown';

interface ProbeResult {
  model: string;
  touchpoint: 'chat' | 'expansion';
  status: ProbeStatus;
  message: string;
  elapsed_ms: number;
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
  for (const [modelStr, touchpoint] of [[chatModel, 'chat'], [expansionModel, 'expansion']] as const) {
    if (shouldSkipProvider(modelStr, skip)) {
      if (!json) process.stderr.write(`[skip] ${touchpoint}: ${modelStr} (provider in --skip)\n`);
      continue;
    }
    results.push(await probeModel(modelStr, touchpoint));
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
      process.stdout.write(`  ${icon} ${r.touchpoint.padEnd(10)} ${r.model.padEnd(50)} ${r.status} (${r.elapsed_ms}ms)\n`);
      if (r.status !== 'ok') {
        process.stdout.write(`      ${r.message}\n`);
      }
    }
    process.stdout.write(`\nSummary: ${report.summary.ok}/${report.summary.total} reachable.\n`);
  }

  if (report.summary.failed > 0) {
    process.exit(1);
  }
}
