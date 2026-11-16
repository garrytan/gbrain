/**
 * Mode-switch UX (v0.40.3.0 — D3)
 *
 * When the user runs `gbrain config set search.mode <X>`, this module
 * surfaces a banner explaining the consequences and offers follow-up
 * actions.
 *
 *   1. summarizeTransition(old, new) — PURE function that classifies the
 *      transition (no_change / narrowing / broadening / tokenmax_opt_in)
 *      and returns banner lines, the backfill requirement and cost estimate.
 *
 *   2. runModeSwitchUx(opts) — the orchestrator. Prints the banner, and for
 *      tokenmax_opt_in on a TTY previews the per-chunk synopsis sweep
 *      (`gbrain reindex --synopsis`, #8744: import, sync and
 *      `reindex --markdown` embed at the title tier, so only that sweep
 *      writes synopses) and runs it in this process when the user answers
 *      yes. The yes is the consent; the sweep's spend cap applies.
 *
 * Suppression: GBRAIN_NO_MODE_SWITCH_UX=1 skips the entire UX for
 * scripted operators (CI fixtures, automation). Non-TTY also skips
 * interactive prompts; prints paste-ready hints to stderr.
 */

import type { BrainEngine } from '../engine.ts';
import { readLineSafe } from '../../commands/init.ts';
import { isSearchMode, type SearchMode } from './mode.ts';

export type TransitionKind =
  | 'no_change'
  | 'narrowing'
  | 'broadening'
  | 'tokenmax_opt_in'
  | 'invalid_new_mode';

export interface TransitionSummary {
  kind: TransitionKind;
  reindex_required: boolean;
  reindex_command?: string;
  cost_estimate_per_query_cents?: number;
  callout_lines: string[];
}

export interface ModeSwitchOpts {
  oldMode: SearchMode | null;
  newMode: string;
  engine: BrainEngine;
  isTty: boolean;
  yesFlag?: boolean;
  /** Test seam: the TTY answer to the sweep prompt. */
  answerFn?: (prompt: string) => Promise<string>;
}

/**
 * Classify the transition + build banner content. Pure: no engine, no
 * file I/O. Test surface for the 5-cell decision matrix below.
 *
 * Decision matrix:
 *   | old → new                | kind                | reindex |
 *   |--------------------------|---------------------|---------|
 *   | any → tokenmax           | tokenmax_opt_in     | yes     |
 *   | balanced → conservative  | narrowing           | no      |
 *   | conservative → balanced  | broadening          | no      |
 *   | any → balanced (else)    | broadening          | no      |
 *   | same → same              | no_change           | no      |
 *   | any → INVALID            | invalid_new_mode    | no      |
 */
export function summarizeTransition(
  oldMode: SearchMode | null,
  newMode: string,
): TransitionSummary {
  if (!isSearchMode(newMode)) {
    return {
      kind: 'invalid_new_mode',
      reindex_required: false,
      callout_lines: [
        `Invalid search.mode value: "${newMode}".`,
        `Valid options: conservative | balanced | tokenmax`,
      ],
    };
  }

  if (oldMode === newMode) {
    return {
      kind: 'no_change',
      reindex_required: false,
      callout_lines: [],
    };
  }

  // tokenmax opt-in wins regardless of old mode. Offers the synopsis sweep:
  // existing pages stay on the title tier until it runs (#8744).
  if (newMode === 'tokenmax') {
    return {
      kind: 'tokenmax_opt_in',
      reindex_required: true,
      reindex_command: 'gbrain reindex --synopsis',
      cost_estimate_per_query_cents: 0.06, // ~$0.0006: rerank-3-lite at 50 candidates (gbrain-evals #148)
      callout_lines: [
        `Switched to tokenmax. Per-chunk Haiku synopsis enabled.`,
        `Backfill cost (one-time): ~$1-5 per 10K pages via Anthropic Haiku.`,
        `Per-query overhead: ~$0.0006 (reranker + slightly larger payload).`,
        `Existing pages stay on the title tier until the synopsis sweep runs: preview it with \`gbrain reindex --synopsis\`, run it with --yes.`,
      ],
    };
  }

  // Narrowing: dropping a feature (e.g. balanced → conservative drops the
  // reranker; tokenmax → balanced drops synopsis context). Semantic result caching is off, so nothing refills; no backfill.
  if (oldMode && narrowness(newMode) < narrowness(oldMode)) {
    return {
      kind: 'narrowing',
      reindex_required: false,
      callout_lines: [
        `Switched to ${newMode}. Some features dropped from prior mode.`,
        ...(oldMode === 'tokenmax'
          ? ['New chunks embed with title context instead of per-chunk synopses; existing vectors keep serving until they are replaced.']
          : []),
        `The next search uses ${newMode} (semantic result caching is disabled). No backfill required.`,
      ],
    };
  }

  // Default: broadening or first-time set to balanced.
  return {
    kind: 'broadening',
    reindex_required: false,
    callout_lines: [
      `Switched to ${newMode}.`,
      oldMode
        ? `Existing wrapped embeddings (if any) continue serving queries.`
        : `First-time mode set; the next search uses it.`,
    ],
  };
}

// Cheap ordering for narrowing detection. Higher = more features enabled.
function narrowness(mode: SearchMode): number {
  switch (mode) {
    case 'conservative':
      return 1;
    case 'balanced':
      return 2;
    case 'tokenmax':
      return 3;
  }
}

/**
 * Orchestrator. Called by `gbrain config set search.mode <X>` after the
 * config write lands. Honors GBRAIN_NO_MODE_SWITCH_UX=1 (full skip) and
 * non-TTY / --yes (no prompt; prints the paste-ready preview command).
 */
export async function runModeSwitchUx(opts: ModeSwitchOpts): Promise<void> {
  if (process.env.GBRAIN_NO_MODE_SWITCH_UX === '1') return;
  if (!isSearchMode(opts.newMode)) {
    // The runConfig caller should have validated. Defense-in-depth:
    // print the invalid banner anyway.
    const summary = summarizeTransition(opts.oldMode, opts.newMode);
    for (const line of summary.callout_lines) console.error(`[mode-switch] ${line}`);
    return;
  }

  const summary = summarizeTransition(opts.oldMode, opts.newMode);
  if (summary.kind === 'no_change') return; // Quiet no-op.

  // Print banner regardless of TTY/non-TTY.
  console.error(`[mode-switch] ${summary.callout_lines[0]}`);
  for (let i = 1; i < summary.callout_lines.length; i++) {
    console.error(`[mode-switch]   ${summary.callout_lines[i]}`);
  }

  if (!summary.reindex_required) return;

  if (!opts.isTty || opts.yesFlag) {
    console.error(`[mode-switch] Preview the backfill (spends nothing): ${summary.reindex_command}`);
    return;
  }

  // TTY: show the sweep's preview (pages, chunks, tokens, dollars), then ask before any spend.
  const { runReindexSynopsis } = await import('../../commands/reindex-synopsis.ts');
  const preview = await runReindexSynopsis(opts.engine, ['--synopsis']);
  if (preview.mode !== 'preview' || !preview.plan || preview.plan.pages.length === 0) return;
  const cost = preview.plan.est_usd === null ? 'cost unknown in advance' : `up to $${preview.plan.est_usd.toFixed(2)}`;
  const prompt = `Run '${summary.reindex_command} --yes' now? It writes per-chunk synopses for ${preview.plan.pages.length} page(s) (${cost}) in this terminal; Ctrl-C stops it and the same command resumes. [y/N]: `;
  const answer = opts.answerFn ? await opts.answerFn(prompt) : await readLineSafe(prompt, 'n', 60_000);
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.error(`[mode-switch] Skipped. Run \`${summary.reindex_command}\` to preview it again when ready.`);
    return;
  }
  await runReindexSynopsis(opts.engine, ['--synopsis', '--yes']);
}
