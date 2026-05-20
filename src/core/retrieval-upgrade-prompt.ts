/**
 * v0.36.0.0 — Interactive prompt UI for the retrieval upgrade (D10 + D6 + C2).
 *
 * Wires the RetrievalUpgradePlanner to a TTY prompt that:
 *   - Shows the comparison numbers from the v0.36.0.0 wave
 *   - Presents a two-line cost split (D10): schema change + re-embed
 *   - Includes the privacy callout (C2) when balanced-mode reranker flips on
 *   - Honors TTY detection (non-TTY = skip, informational stderr line)
 *   - Default-on-Enter = STAY (safest); explicit 's' = switch, 'l' = later,
 *     'n' = never ask again
 *
 * Used by:
 *   - src/commands/upgrade.ts:runPostUpgrade (post-migration call site)
 *   - src/commands/ze-switch.ts (manual CLI lever)
 */

import type { BrainEngine } from './engine.ts';
import {
  planRetrievalUpgrade,
  applyRetrievalUpgrade,
  recordDeclinedThisRun,
  recordDeclinedForever,
  resumeRetrievalUpgrade,
  undoRetrievalUpgrade,
  type RetrievalUpgradeState,
  type ApplyResult,
  type ZeSwitchSnapshot,
  KEY_PROMPT_SHOWN,
  KEY_APPLIED,
  KEY_REQUESTED,
  ZE_TARGET_EMBEDDING_MODEL,
  ZE_TARGET_EMBEDDING_DIM,
} from './retrieval-upgrade-planner.ts';

// ============================================================================
// Public API
// ============================================================================

export interface PromptOpts {
  /** Override stdin TTY detection for tests. */
  isTTY?: boolean;
  /** Override the read function for tests (single keypress). */
  readKey?: () => Promise<string>;
  /** Where to write the prompt. Defaults to process.stderr. */
  write?: (line: string) => void;
  /** Bypass the `prompt_shown` gate (for `gbrain ze-switch --force`). */
  force?: boolean;
}

export type PromptResult =
  | { status: 'applied'; plan: RetrievalUpgradeState }
  | { status: 'declined_this_run'; plan: RetrievalUpgradeState }
  | { status: 'declined_forever'; plan: RetrievalUpgradeState }
  | { status: 'not_offered'; plan: RetrievalUpgradeState; reason: string }
  | { status: 'non_tty_skip'; plan: RetrievalUpgradeState }
  | { status: 'failed'; plan: RetrievalUpgradeState; reason: string };

/**
 * Run the v0.36.0.0 retrieval-upgrade prompt. Returns a tagged-union outcome
 * so callers can dispatch without parsing strings (mirrors D15).
 */
export async function runRetrievalUpgradePrompt(
  engine: BrainEngine,
  opts: PromptOpts = {},
): Promise<PromptResult> {
  const writeFn = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const isTTY = typeof opts.isTTY === 'boolean'
    ? opts.isTTY
    : Boolean(process.stdin.isTTY);

  // Don't re-ask within the same brain unless --force.
  if (!opts.force) {
    const shown = (await engine.getConfig(KEY_PROMPT_SHOWN)) === 'true';
    const applied = (await engine.getConfig(KEY_APPLIED)) === 'true';
    if (shown || applied) {
      const plan = await planRetrievalUpgrade(engine);
      return { status: 'not_offered', plan, reason: applied ? 'already_applied' : 'prompt_shown' };
    }
  }

  const plan = await planRetrievalUpgrade(engine);

  // Nothing to do.
  if (!plan.ze_switch_offered) {
    return {
      status: 'not_offered',
      plan,
      reason: plan.ze_switch_already_declined ? 'declined' : 'not_eligible',
    };
  }

  // Show banner regardless of TTY so non-TTY upgrades see what they skipped.
  writeFn(formatBanner(plan));

  if (!isTTY) {
    writeFn('[ze-switch] non-TTY environment; skipping prompt. Run `gbrain ze-switch` manually when ready.');
    return { status: 'non_tty_skip', plan };
  }

  // Single-keypress prompt. Enter = stay (safest default).
  const key = await (opts.readKey ?? defaultReadKey)();
  const normalized = key.toLowerCase().trim();

  if (normalized === 's') {
    const result = await applyRetrievalUpgrade(engine, plan);
    if (result.status === 'applied') {
      writeFn('[ze-switch] Schema rebuilt at 1024d. Run `gbrain embed --stale` to refill embeddings (or wait for autopilot).');
      return { status: 'applied', plan };
    }
    if (result.status === 'failed') {
      return { status: 'failed', plan, reason: result.reason };
    }
    // skipped_* shouldn't happen here (we just planned and saw offered=true).
    return { status: 'failed', plan, reason: `unexpected apply status: ${result.status}` };
  }
  if (normalized === 'n') {
    await recordDeclinedForever(engine);
    writeFn('[ze-switch] Will not ask again. Re-enable with `gbrain ze-switch --force`.');
    return { status: 'declined_forever', plan };
  }
  // Enter, 'l', or anything else = defer to next upgrade.
  // Per C3 the planner re-asks on the next run; mark prompt_shown=false to
  // re-enable. We DON'T touch the config here; absence of prompt_shown means
  // re-ask. The 'l' case is identical.
  return { status: 'declined_this_run', plan };
}

/** Mirror of runRetrievalUpgradePrompt for --undo (D16 cost-warning prompt). */
export async function runUndoPrompt(
  engine: BrainEngine,
  opts: PromptOpts = {},
): Promise<
  | { status: 'undone'; snapshot: ZeSwitchSnapshot }
  | { status: 'aborted' }
  | { status: 'non_tty_skip' }
  | { status: 'no_snapshot' }
  | { status: 'failed'; reason: string }
> {
  const writeFn = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const isTTY = typeof opts.isTTY === 'boolean'
    ? opts.isTTY
    : Boolean(process.stdin.isTTY);

  // Read snapshot just to show the cost warning.
  const snapshotStr = await engine.getConfig('ze_switch_previous_snapshot');
  if (!snapshotStr) {
    writeFn('[ze-switch --undo] No prior config snapshot found (brain was never switched). Nothing to undo.');
    return { status: 'no_snapshot' };
  }
  let snapshot: ZeSwitchSnapshot;
  try {
    snapshot = JSON.parse(snapshotStr) as ZeSwitchSnapshot;
  } catch (err) {
    return { status: 'failed', reason: `corrupt snapshot: ${err instanceof Error ? err.message : String(err)}` };
  }

  const plan = await planRetrievalUpgrade(engine);
  writeFn(formatUndoBanner(snapshot, plan.pages_pending_dim || 0));

  if (!isTTY) {
    writeFn('[ze-switch --undo] non-TTY environment; refusing without --confirm-reembed.');
    return { status: 'non_tty_skip' };
  }

  const key = await (opts.readKey ?? defaultReadKey)();
  if (key.toLowerCase().trim() !== 's') {
    writeFn('[ze-switch --undo] aborted (you must press `s` to confirm).');
    return { status: 'aborted' };
  }

  const result = await undoRetrievalUpgrade(engine);
  if (result.status === 'undone') {
    writeFn(`[ze-switch --undo] Restored ${snapshot.embedding_model} at ${snapshot.embedding_dimensions}d. Run \`gbrain embed --stale\` to refill embeddings.`);
    return result;
  }
  return result;
}

/** Programmatic resume helper used by the CLI's --resume flag. */
export async function runResume(engine: BrainEngine): Promise<ApplyResult> {
  return resumeRetrievalUpgrade(engine);
}

// ============================================================================
// Banner formatting (pure; testable)
// ============================================================================

/**
 * Format the upgrade banner per D10 (two-line cost split) + C2 (privacy
 * callout). Pure — returns a string; the caller emits to stderr.
 */
export function formatBanner(plan: RetrievalUpgradeState): string {
  const lines: string[] = [];
  lines.push('────────────────────────────────────────────────────────────');
  lines.push('v0.36.0.0 ships a new default: ZeroEntropy');
  lines.push('');
  lines.push('Real-corpus benchmark across 20 queries on a 17K-page brain:');
  lines.push('  • Wins 11/20 queries head-to-head (OpenAI 6, Voyage 4)');
  lines.push('  • Fastest:  442ms  vs OpenAI 973ms  (2.2× faster)');
  lines.push('  • Cheapest: $0.05/M tokens vs OpenAI $0.13/M (2.6× cheaper)');
  lines.push('               (sale rate $0.025/M may be promotional, subject to change)');
  lines.push('  • zerank-2 reshuffles 60% of top-1 results (real value)');
  lines.push('  • Only 10–18% overlap between providers — they see different');
  lines.push('    things, so a pair compounds');
  lines.push('');
  lines.push(`Your current setup:  ${plan.current_embedding_model} (${plan.current_dim}d)`);
  lines.push(`Target:              ${ZE_TARGET_EMBEDDING_MODEL} (${ZE_TARGET_EMBEDDING_DIM}d via Matryoshka)`);
  lines.push('');

  // D10: two-line cost split — schema change vs re-embed.
  const dollars = plan.est_cost_usd > 0 ? `~$${plan.est_cost_usd.toFixed(2)}` : 'estimate unavailable';
  const pages = Math.max(plan.pages_pending_chunker, plan.pages_pending_dim);
  lines.push(`Schema change: ~${plan.est_schema_change_seconds}s (drops + recreates embedding column with new index)`);
  lines.push(`Re-embed:      ~${plan.est_minutes}min and ${dollars} for ${pages.toLocaleString()} pages`);
  lines.push('               (runs via `gbrain embed --stale` or autopilot — you can walk away)');

  // C2: privacy callout for the balanced-mode reranker flip.
  lines.push('');
  lines.push('Heads-up: reranking on this default sends your query and top-30');
  lines.push('search snippets to api.zeroentropy.dev. Disable any time with');
  lines.push('`gbrain config set search.reranker.enabled false`.');

  lines.push('');
  lines.push('Options:');
  lines.push('  [Enter]  Stay on current provider for now (default — safe)');
  lines.push('  s        Switch to ZeroEntropy (RECOMMENDED)');
  lines.push('  l        Decide later (ask me again on next upgrade)');
  lines.push('  n        Never ask again');
  lines.push('────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

/** Cost-warning prompt before --undo runs. D16 symmetric UX. */
export function formatUndoBanner(snapshot: ZeSwitchSnapshot, pageCount: number): string {
  const lines: string[] = [];
  lines.push('────────────────────────────────────────────────────────────');
  lines.push('Undo the v0.36.0.0 ZeroEntropy switch?');
  lines.push('');
  lines.push(`Will restore: ${snapshot.embedding_model} (${snapshot.embedding_dimensions}d)`);
  lines.push(`              reranker_enabled = ${snapshot.search_reranker_enabled}`);
  if (snapshot.search_reranker_model) {
    lines.push(`              reranker_model   = ${snapshot.search_reranker_model}`);
  }
  lines.push('');
  lines.push(`This will re-embed ~${pageCount.toLocaleString()} pages at the prior width.`);
  lines.push('Same re-embed bill as the forward switch (in reverse).');
  lines.push('');
  lines.push('  s        Confirm undo');
  lines.push('  [any]    Abort');
  lines.push('────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ============================================================================
// Keypress reader (mockable for tests)
// ============================================================================

async function defaultReadKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      // Strip trailing newline; treat Enter as empty string.
      resolve(chunk === '\r' || chunk === '\n' || chunk === '\r\n' ? '' : chunk.replace(/[\r\n]/g, ''));
    };
    stdin.on('data', onData);
  });
}
