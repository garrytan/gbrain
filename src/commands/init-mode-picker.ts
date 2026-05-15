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
 * Heuristic (default-tokenmax bias — preserve the v0.31.x power-user
 * shape per the v0.32.3 install-picker directive):
 *   - Opus / Frontier model OR Sonnet / unknown → tokenmax (max-quality default)
 *   - Haiku subagent → conservative (cost-sensitive setups)
 *   - No OpenAI key configured → conservative (LLM expansion not possible
 *     anyway, so tight budget makes more sense)
 *
 * Rationale: the previous "default to balanced unless Opus detected" logic
 * silently downgraded users who were running Sonnet-tier work and expected
 * the v0.31.x default (expand=true, limit=20) to carry forward. Tokenmax
 * is the closest mode bundle to that prior default. Operators who want
 * something tighter pick conservative or balanced explicitly.
 */
export function recommendModeFor(inputs: ModePickerInputs): { mode: SearchMode; reason: string } {
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
  const opus = /opus/i.test(inputs.defaultModel ?? '') || /opus/i.test(inputs.subagentModel ?? '');
  if (opus) {
    return {
      mode: 'tokenmax',
      reason: 'Opus-class model detected — quality ceiling worth the token cost.',
    };
  }
  return {
    mode: 'tokenmax',
    reason: 'Preserves the v0.31.x default retrieval shape (expand=on, generous result set). Pick conservative or balanced if cost-sensitive.',
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
──────────────────────
Three named modes. Cost depends on BOTH the mode AND your downstream model
— the corner-to-corner spread is 25x. Pick the pairing intentionally.

The "cost" isn't gbrain itself — it's the downstream agent's input cost
reading the retrieved chunks back into its context window. gbrain's own
overhead is rounding-error (semantic cache is free; tokenmax adds ~$1.50
per 1K queries for the Haiku expansion call).

Per-query cost @ 10K queries/mo (full search payload, no cache savings):

                  Haiku 4.5     Sonnet 4.6    Opus 4.7
                  ($1/M input)  ($3/M input)  ($5/M input)
  conservative    $40/mo        $120/mo       $200/mo
  balanced        $100/mo       $300/mo       $500/mo
  tokenmax        $200/mo       $600/mo       $1,000/mo

(scales linearly — multiply by 10 for 100K/mo, divide by 10 for 1K/mo)

Natural pairings span ~4x (cheap/cheap → frontier/frontier). Mismatches
(tokenmax+Haiku, conservative+Opus) waste capacity in different
directions. Real agent loops with disciplined prompt caching see 50-80%
discount on top of these numbers (cache hits skip downstream entirely).

  1) conservative   4K-token cap, no LLM expansion, 10 chunks max.
                    Best for: Haiku subagents, cost-sensitive agents,
                    high-volume search loops, MCP servers w/ many users.

  2) balanced       12K cap, no LLM expansion, 25 chunks max.
                    Best for: Sonnet-tier work, mixed workloads.
                    (The middle path most users land on.)

  3) tokenmax       no cap, LLM query expansion ON, 50 chunks.
                    Best for: Opus/frontier models, max retrieval quality,
                    low-volume high-stakes work.

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

  // Non-TTY (agent-driven install, CI, scripted init): print the FULL matrix
  // and emit an explicit [AGENT] directive. The previous version printed
  // 2 stderr lines that agents typically miss / don't relay to the human.
  // Now: the agent sees the same matrix the human-TTY picker shows, plus
  // a directive saying "show this to your operator and confirm before
  // moving on." Default-applied mode is tokenmax (preserves v0.31.x shape).
  if (!process.stdin.isTTY) {
    try { await engine.setConfig(SEARCH_MODE_KEY, rec.mode); } catch { /* swallow */ }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`[gbrain] search mode tentatively set to: ${rec.mode}`);
    console.log(`[gbrain] Reason: ${rec.reason}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('[AGENT] Before continuing, SHOW this matrix to your operator and');
    console.log('[AGENT] ask which mode they want. The default above preserves the');
    console.log('[AGENT] v0.31.x retrieval shape. Run `gbrain config set search.mode');
    console.log('[AGENT] <conservative|balanced|tokenmax>` if the operator picks');
    console.log('[AGENT] differently. See INSTALL_FOR_AGENTS.md Step 3.5 for the');
    console.log('[AGENT] full protocol.');
    console.log('');
    console.log('Per-query cost @ 10K queries/mo (search payload only, no cache savings):');
    console.log('');
    console.log('                    Haiku 4.5     Sonnet 4.6    Opus 4.7');
    console.log('                    ($1/M input)  ($3/M input)  ($5/M input)');
    console.log('   conservative     $40/mo        $120/mo       $200/mo');
    console.log('   balanced         $100/mo       $300/mo       $500/mo');
    console.log('   tokenmax         $200/mo       $600/mo       $1,000/mo');
    console.log('');
    console.log('   (scales linearly: ×10 for 100K queries/mo, ÷10 for 1K)');
    console.log('   25x corner-to-corner spread. Natural diagonal pairings span ~4x.');
    console.log('');
    console.log('To change later: gbrain config set search.mode <mode>');
    console.log('To see what is running: gbrain search modes');
    console.log('');
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
