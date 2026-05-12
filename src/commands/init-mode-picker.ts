/**
 * v0.32.3 search-lite install-time mode picker.
 *
 * Runs as a phase inside `gbrain init` AFTER `engine.initSchema()` so DB
 * config writes work [CDX-7]. Idempotent: if `search.mode` is already set
 * (re-init / second run), the picker is skipped entirely.
 *
 * TTY flow shows the menu. Non-TTY (CI, scripted init, --mcp-only) writes
 * `balanced` and prints the one-line hint pointing at `gbrain config set
 * search.mode`. The mode picker NEVER blocks an init run — readLineSafe
 * caps at 60s and falls back to `balanced` on timeout / EOF.
 *
 * Smart auto-suggestion: reads models.tier.subagent / models.default /
 * OPENAI_API_KEY presence + brain size hint to RECOMMEND a mode. The
 * recommendation is informational only — the user picks. This is the
 * "agents perfectly tune for user needs" piece at install time.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readLineSafe } from './init.ts';
import {
  SEARCH_MODES,
  SEARCH_MODE_KEY,
  DEFAULT_SEARCH_MODE,
  isSearchMode,
  type SearchMode,
} from '../core/search/mode.ts';

/**
 * The full set of inputs that can shape the auto-suggestion. Caller passes
 * what it knows (model defaults, API key presence, etc.); function falls
 * back to environment / config for anything not provided.
 */
export interface ModePickerInputs {
  /** Configured subagent tier model id (e.g. 'anthropic:claude-haiku-4-5'). */
  subagentModel?: string | null;
  /** Configured default model id. */
  defaultModel?: string | null;
  /** True iff an OpenAI API key is configured. */
  hasOpenAIKey?: boolean;
  /** Approximate page count of the brain (after initSchema, before bulk import). */
  pageCount?: number;
}

/**
 * Derive a smart recommendation from the inputs. Pure function so it's
 * trivially testable.
 *
 * Heuristic:
 *   - Opus / Frontier / large-context default model → tokenmax
 *   - Haiku / no API key / cost-sensitive subagent → conservative
 *   - Sonnet / mixed / unknown → balanced (the safe default)
 */
export function recommendModeFor(inputs: ModePickerInputs): { mode: SearchMode; reason: string } {
  const opus = /opus/i.test(inputs.defaultModel ?? '') || /opus/i.test(inputs.subagentModel ?? '');
  if (opus) {
    return {
      mode: 'tokenmax',
      reason: 'Opus-class model detected — quality ceiling worth the token cost.',
    };
  }
  const haiku = /haiku/i.test(inputs.subagentModel ?? '');
  if (haiku) {
    return {
      mode: 'conservative',
      reason: 'Haiku subagent tier detected — tight 4K budget keeps per-call cost down.',
    };
  }
  if (inputs.hasOpenAIKey === false) {
    return {
      mode: 'conservative',
      reason: 'No OpenAI key configured — semantic cache still works, but no LLM expansion possible.',
    };
  }
  return {
    mode: DEFAULT_SEARCH_MODE,
    reason: 'Sweet-spot defaults for Sonnet-tier work and mixed workloads.',
  };
}

/**
 * Resolve inputs from the engine + environment. Best-effort; any read
 * failure falls through to defaults. Pure: never throws.
 */
async function resolveInputs(engine: BrainEngine): Promise<ModePickerInputs> {
  const safeGet = async (k: string): Promise<string | null> => {
    try { return await engine.getConfig(k); } catch { return null; }
  };

  const [subagentModel, defaultModel] = await Promise.all([
    safeGet('models.tier.subagent'),
    safeGet('models.default'),
  ]);

  let pageCount = 0;
  try {
    const stats = await engine.getStats();
    pageCount = stats.page_count ?? 0;
  } catch { /* swallow */ }

  return {
    subagentModel,
    defaultModel,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    pageCount,
  };
}

const MENU_TEXT = `
Search mode preference
─────────────────────
GBrain ships a hybrid search engine with three named modes. Pick the one
that matches your workload. You can change it later with:

    gbrain config set search.mode <mode>

  1) conservative   tight 4K token budget per query, no LLM expansion,
                    10 results max. Best for: Haiku-tier subagents,
                    cost-sensitive setups, agents that search constantly.

  2) balanced       12K budget, no LLM expansion, 25 results.
                    Best for: Sonnet-tier work, mixed workloads.

  3) tokenmax       no budget, LLM query expansion ON, 50 results.
                    Best for: Opus/frontier models, high-quality retrieval
                    where token cost is not the bottleneck.
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

/**
 * Run the picker. Returns the resolved mode.
 *
 * Idempotent: if `search.mode` is already set, the picker is skipped
 * (returns the existing value without prompting). This makes re-init
 * safe and lets the upgrade flow set the mode programmatically before
 * the picker fires.
 */
export async function runModePicker(
  engine: BrainEngine,
  opts: { jsonOutput?: boolean; force?: boolean } = {},
): Promise<SearchMode> {
  // Idempotent: don't re-prompt if already chosen, unless --force.
  if (!opts.force) {
    try {
      const existing = await engine.getConfig(SEARCH_MODE_KEY);
      if (existing && isSearchMode(existing)) {
        return existing as SearchMode;
      }
    } catch { /* fall through to picker */ }
  }

  const inputs = await resolveInputs(engine);
  const rec = recommendModeFor(inputs);

  // JSON mode (used by --json init) — apply the recommendation silently
  // and emit a structured event. No interactive prompt.
  if (opts.jsonOutput) {
    try { await engine.setConfig(SEARCH_MODE_KEY, rec.mode); } catch { /* swallow */ }
    console.log(JSON.stringify({
      phase: 'search_mode_picker',
      mode: rec.mode,
      reason: rec.reason,
      auto: true,
    }));
    return rec.mode;
  }

  // Non-TTY (pipe, redirect, container init): write the recommendation
  // and emit a one-line operator hint. No prompt.
  if (!process.stdin.isTTY) {
    try { await engine.setConfig(SEARCH_MODE_KEY, rec.mode); } catch { /* swallow */ }
    console.log('');
    console.log(`[gbrain] search mode: ${rec.mode} (auto-selected — ${rec.reason})`);
    console.log(`[gbrain] To change: gbrain config set search.mode <conservative|balanced|tokenmax>`);
    return rec.mode;
  }

  // Interactive TTY: menu + readLineSafe.
  console.log(MENU_TEXT);
  console.log(`  Recommended: ${rec.mode}  (${rec.reason})`);
  console.log('');

  const raw = await readLineSafe(`Mode [${rec.mode}]: `, rec.mode, 60_000);
  const picked = parseModeInput(raw) ?? rec.mode;

  try {
    await engine.setConfig(SEARCH_MODE_KEY, picked);
  } catch (err) {
    // Worst case: config write fails. Mode resolution falls back to balanced
    // at search-time anyway, so we don't block init. Emit the failure to
    // stderr so the operator sees it.
    console.error(`[gbrain] WARN: failed to persist search.mode (${(err as Error).message ?? 'unknown'}). Defaulting to ${picked} at search-time.`);
  }

  console.log(`Search mode set to: ${picked}`);
  console.log('');
  return picked;
}

/** Re-export the menu text for documentation generation and tests. */
export const MODE_PICKER_MENU = MENU_TEXT;
export const SUPPORTED_MODES = SEARCH_MODES;
