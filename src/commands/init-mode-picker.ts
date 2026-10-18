/**
 * Install-time search-mode picker.
 *
 * Runs as a phase inside `gbrain init` AFTER `engine.initSchema()` so DB
 * config writes work [CDX-7]. Idempotent: if `search.mode` is already set
 * (re-init / second run), the picker is skipped entirely.
 *
 * TTY flow shows the menu. Non-TTY (CI, scripted init, --mcp-only) applies
 * the recommendation, prints the cost matrix + an [AGENT] directive to
 * confirm with the operator, and points at `gbrain config set search.mode`.
 * The mode picker NEVER blocks an init run — readLineSafe caps at 60s and
 * falls back to the recommendation on timeout / EOF.
 *
 * `gbrain init --search-mode <mode>` records an operator's choice instead:
 * no recommendation, no first-run `search_mode` ask, `search.mode_source:
 * operator`. On a brain whose mode is already set to something else it
 * refuses unless `--force`. Picker choices record `search.mode_source: auto`.
 *
 * The recommendation reads the configured model tiers, whether a chat key
 * exists (Anthropic / OpenAI / Google) and whether the reranker the
 * recommended mode would use is ready (rerankerReadiness, not a key name),
 * both through mergedProviderEnv so a key saved in ~/.gbrain/config.json
 * counts. Its copy (reasons, banner, matrix) lives in
 * src/core/search/mode-advice.ts.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readLineSafe } from './init.ts';
import {
  SEARCH_MODES,
  SEARCH_MODE_KEY,
  isSearchMode,
  loadSearchModeConfig,
  resolveSearchMode,
  type SearchMode,
} from '../core/search/mode.ts';
import {
  MODE_REASONS,
  QUERY_EXPANSION_LINE,
  RECOMMENDED_SEARCH_MODE,
  SEARCH_MODE_SOURCE_KEY,
  agentBannerLines,
  costMatrixLines,
  type SearchModeSource,
} from '../core/search/mode-advice.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../core/config.ts';
import { mergedProviderEnv } from '../core/ai/provider-env.ts';
import { rerankerReadiness } from '../core/ai/reranker-readiness.ts';

/**
 * The inputs that shape the recommendation. Undefined means unknown; the
 * no-keys branch fires only when both key inputs are known to be false.
 */
export interface ModePickerInputs {
  /** Configured subagent tier model id (e.g. 'anthropic:claude-haiku-5-5'). */
  subagentModel?: string | null;
  /** Configured default model id. */
  defaultModel?: string | null;
  /** A chat key (Anthropic / OpenAI / Google) is configured, in the environment or the config file. */
  hasChatKey?: boolean;
  /** The reranker the recommended mode would use is ready (readiness, not a key name). */
  hasRerankKey?: boolean;
  /** Approximate page count of the brain (after initSchema, before bulk import). */
  pageCount?: number;
}

/**
 * The recommendation. Pure.
 *   - Haiku subagent → conservative (a small-context model).
 *   - No chat key and no ready reranker → conservative.
 *   - A ready reranker without a chat key → balanced.
 *   - Opus, or anything else → tokenmax (RECOMMENDED_SEARCH_MODE).
 */
export function recommendModeFor(inputs: ModePickerInputs): { mode: SearchMode; reason: string } {
  if (/haiku/i.test(inputs.subagentModel ?? '')) return { mode: 'conservative', reason: MODE_REASONS.haiku };
  if (inputs.hasChatKey === false && inputs.hasRerankKey === false) return { mode: 'conservative', reason: MODE_REASONS.noKeys };
  if (inputs.hasChatKey === false && inputs.hasRerankKey === true) return { mode: 'balanced', reason: MODE_REASONS.rerankOnly };
  const opus = /opus/i.test(inputs.defaultModel ?? '') || /opus/i.test(inputs.subagentModel ?? '');
  if (opus) return { mode: RECOMMENDED_SEARCH_MODE, reason: MODE_REASONS.opus };
  return { mode: RECOMMENDED_SEARCH_MODE, reason: MODE_REASONS.default };
}

/** Chat keys the recommendation counts, after mergedProviderEnv folds config-file keys and the GEMINI alias. */
const CHAT_KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const;

/**
 * Resolve inputs from the engine, the config file and the environment.
 * Best-effort; any read failure falls through to "unknown". Never throws.
 */
export async function resolveModePickerInputs(engine: BrainEngine): Promise<ModePickerInputs> {
  const safeGet = async (k: string): Promise<string | null> => {
    try { return await engine.getConfig(k); } catch { return null; }
  };
  const [subagentModel, defaultModel] = await Promise.all([safeGet('models.tier.subagent'), safeGet('models.default')]);

  let pageCount = 0;
  try { pageCount = (await engine.getStats()).page_count ?? 0; } catch { /* swallow */ }

  // One provider plane for both inputs: process env over the config file over
  // DB-plane keys (mergedProviderEnv over loadConfigWithEngine), the plane
  // rerankerReadinessForEngine uses when no gateway is configured. Not the
  // gateway's: init configures it from process env alone, which would miss a
  // key saved in ~/.gbrain/config.json.
  let env: Record<string, string> | null = null;
  let cfg: GBrainConfig | null = null;
  try {
    try { cfg = loadConfig(); } catch { cfg = null; }
    try { cfg = await loadConfigWithEngine(engine, cfg); } catch { /* file plane alone */ }
    env = mergedProviderEnv(cfg, process.env);
  } catch { env = null; }
  const hasChatKey = env ? CHAT_KEY_ENV.some(name => !!env![name]) : undefined;

  let hasRerankKey: boolean | undefined;
  try {
    const overrides = (await loadSearchModeConfig(engine)).overrides;
    const model = resolveSearchMode({ mode: RECOMMENDED_SEARCH_MODE, overrides }).reranker_model;
    hasRerankKey = env ? rerankerReadiness(model, env, { baseUrlOverrides: cfg?.provider_base_urls ?? null }).ready : undefined;
  } catch { hasRerankKey = undefined; }

  return { subagentModel, defaultModel, hasChatKey, hasRerankKey, pageCount };
}

const MENU_TEXT = `
Search mode preference
──────────────────────
Three named modes. Cost depends on BOTH the mode AND your downstream model.
Pick the pairing intentionally.

${costMatrixLines('  ').join('\n')}

GBrain's semantic result caching is temporarily disabled; budget for fresh retrieval.
Downstream provider prompt caching may discount input charges; it does not skip
retrieval or downstream generation.

  1) conservative   4K-token cap, 10 results by default, no reranker.
                    Best for: Haiku subagents, cost-sensitive agents,
                    high-volume search loops, MCP servers w/ many users.

  2) balanced       12K-token cap, 25 results by default, reranked.
                    Best for: mixed workloads, a reranker without a chat key.

  3) tokenmax       no token cap, 50 results by default, reranked.
                    Best for: the widest retrieval, low-volume high-stakes work.

${QUERY_EXPANSION_LINE}
Actual expansion needs configured embedding and expansion providers; cloud
expansion sends the query to the configured provider.

You can change this any time with: gbrain config set search.mode <mode>
Per-knob tuning + recommendation engine ships at: gbrain search tune
`;

/**
 * Map user input to a SearchMode. Accepts:
 *   - The numeric menu choice ('1', '2', '3')
 *   - The mode name (case-insensitive)
 *   - Empty / unrecognized → null (caller decides whether to retry or default)
 */
export function parseModeInput(raw: string): SearchMode | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '1') return 'conservative';
  if (trimmed === '2') return 'balanced';
  if (trimmed === '3') return 'tokenmax';
  if (isSearchMode(trimmed)) return trimmed;
  return null;
}

export interface SearchModeChoice {
  /** `gbrain init --search-mode <mode>`: the operator's choice. */
  explicit?: SearchMode;
  /** `gbrain init --force`: lets --search-mode replace an existing brain's mode. */
  force?: boolean;
  /** How init refuses (prints, exits); the picker throws when absent. */
  refuse?: (message: string) => never;
}

/** Parse `--search-mode` from init's argv; an invalid value goes to `fail`. */
export function searchModeChoiceFromArgs(args: string[], fail: (message: string, jsonOutput: boolean) => never): SearchModeChoice {
  const json = args.includes('--json');
  const i = args.indexOf('--search-mode');
  if (i === -1) return {};
  const value = (args[i + 1] ?? '').trim().toLowerCase();
  if (!isSearchMode(value)) fail(`gbrain init: --search-mode must be one of ${SEARCH_MODES.join(', ')} (got: ${args[i + 1] ?? ''})`, json);
  return { explicit: value as SearchMode, force: args.includes('--force'), refuse: message => fail(message, json) };
}

async function persistMode(engine: BrainEngine, mode: SearchMode, source: SearchModeSource): Promise<void> {
  await engine.setConfig(SEARCH_MODE_KEY, mode);
  await engine.setConfig(SEARCH_MODE_SOURCE_KEY, source);
}

/**
 * Run the picker. Returns the resolved mode.
 *
 * Idempotent: if `search.mode` is already set, the picker is skipped
 * (returns the existing value without prompting), unless `force`. An
 * explicit choice is recorded as the operator's and never calls onDecision,
 * so init's first-run bundle carries no `search_mode` ask.
 */
export async function runModePicker(
  engine: BrainEngine,
  opts: SearchModeChoice & { jsonOutput?: boolean; onDecision?: (d: { mode: SearchMode; reason: string }) => void } = {},
): Promise<SearchMode> {
  let existing: SearchMode | null = null;
  try {
    const raw = await engine.getConfig(SEARCH_MODE_KEY);
    if (raw && isSearchMode(raw)) existing = raw;
  } catch { /* fall through to picker */ }

  if (opts.explicit) {
    if (existing && existing !== opts.explicit && !opts.force) {
      const message = `This brain already has search.mode ${existing}; gbrain init --search-mode does not change an existing brain's mode. ` +
        `Run \`gbrain config set search.mode ${opts.explicit}\`, or re-run gbrain init with --force.`;
      if (opts.refuse) opts.refuse(message);
      throw new Error(message);
    }
    await persistMode(engine, opts.explicit, 'operator');
    if (opts.jsonOutput) {
      console.log(JSON.stringify({ phase: 'search_mode_picker', mode: opts.explicit, reason: 'Chosen with gbrain init --search-mode.', auto: false, source: 'operator' }));
    } else {
      console.log(`Search mode set to: ${opts.explicit} (chosen with --search-mode)`);
    }
    return opts.explicit;
  }

  if (existing && !opts.force) return existing;

  const rec = recommendModeFor(await resolveModePickerInputs(engine));
  opts.onDecision?.({ mode: rec.mode, reason: rec.reason });

  // JSON mode (used by --json init) — apply the recommendation silently
  // and emit a structured event. No interactive prompt.
  if (opts.jsonOutput) {
    try { await persistMode(engine, rec.mode, 'auto'); } catch { /* swallow */ }
    console.log(JSON.stringify({ phase: 'search_mode_picker', mode: rec.mode, reason: rec.reason, auto: true, source: 'auto' }));
    return rec.mode;
  }

  // Non-TTY (agent-driven install, CI, scripted init): the full matrix plus
  // an explicit [AGENT] directive to relay it and confirm with the operator.
  if (!process.stdin.isTTY) {
    try { await persistMode(engine, rec.mode, 'auto'); } catch { /* swallow */ }
    for (const line of agentBannerLines(rec.mode, rec.reason)) console.log(line);
    return rec.mode;
  }

  // Interactive TTY: menu + readLineSafe. A typed choice other than the
  // recommendation is the operator's; Enter or a timeout keeps the recommendation.
  console.log(MENU_TEXT);
  console.log(`  Recommended: ${rec.mode}  (${rec.reason})`);
  console.log('');

  const typed = parseModeInput(await readLineSafe(`Mode [${rec.mode}]: `, rec.mode, 60_000));
  const picked = typed ?? rec.mode;

  try {
    await persistMode(engine, picked, typed && typed !== rec.mode ? 'operator' : 'auto');
  } catch (err) {
    // Worst case: config write fails. Mode resolution falls back to balanced
    // at search-time anyway, so we don't block init.
    console.error(`[gbrain] WARN: failed to persist search.mode (${(err as Error).message ?? 'unknown'}). Defaulting to ${picked} at search-time.`);
  }

  console.log(`Search mode set to: ${picked}`);
  console.log('');
  return picked;
}

/** Re-export the menu text for documentation generation and tests. */
export const MODE_PICKER_MENU = MENU_TEXT;
export const SUPPORTED_MODES = SEARCH_MODES;
