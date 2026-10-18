/**
 * The one source of gbrain's search-mode recommendation and the copy that
 * states it: the install picker's reasons, menu and `[AGENT]` banner, init's
 * first-run `search_mode` decision, the post-upgrade banner, and the cost
 * matrix they all print. Prices come from the canonical chat-pricing table
 * (`src/core/model-pricing.ts`), so a price change there moves every surface.
 *
 * The matrix estimates the downstream model's input cost of reading the
 * retrieved payload: an assumed payload per query for each mode (at or under
 * that mode's token budget) times 10K queries a month times the model's input
 * rate. Embedding, reranking and query expansion are separate provider
 * charges and are not in it.
 */
import { agentBlock } from '../agent-markers.ts';
import { canonicalLookup } from '../model-pricing.ts';
import type { SearchMode } from './mode.ts';

/** Who chose `search.mode`: `auto` (the install picker's recommendation) or `operator` (an explicit choice). */
export const SEARCH_MODE_SOURCE_KEY = 'search.mode_source';
export type SearchModeSource = 'auto' | 'operator';

/** The mode gbrain recommends for a brain with a chat key when nothing argues for another. */
export const RECOMMENDED_SEARCH_MODE: SearchMode = 'tokenmax';

const MODES: readonly SearchMode[] = ['conservative', 'balanced', 'tokenmax'];

/** The newest model of each Anthropic family the matrix prices, cheapest first. */
export const COST_MATRIX_MODELS: ReadonlyArray<{ label: string; id: string }> = [
  { label: 'Haiku 5.5', id: 'anthropic:claude-haiku-5-5' },
  { label: 'Sonnet 5.5', id: 'anthropic:claude-sonnet-5-5' },
  { label: 'Opus 5.5', id: 'anthropic:claude-opus-5-5' },
];

/** Assumed retrieved payload per query, in tokens, for each mode. */
export const COST_MATRIX_PAYLOAD_TOKENS: Readonly<Record<SearchMode, number>> = { conservative: 4_000, balanced: 10_000, tokenmax: 20_000 };
export const COST_MATRIX_QUERIES_PER_MONTH = 10_000;

function inputRate(modelId: string): number {
  const price = canonicalLookup(modelId);
  if (!price) throw new Error(`mode-advice: no canonical price for ${modelId}`);
  return price.input;
}

/** Estimated monthly downstream input cost (USD) of `mode`'s payload read by `modelId`. */
export function monthlyPayloadCost(mode: SearchMode, modelId: string): number {
  return (COST_MATRIX_PAYLOAD_TOKENS[mode] * COST_MATRIX_QUERIES_PER_MONTH / 1_000_000) * inputRate(modelId);
}

function usd(n: number): string {
  if (n < 10) return `$${n.toFixed(2).replace(/\.00$/, '')}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Cheapest cell to dearest cell, rounded. */
export function costMatrixSpread(): number {
  const cells = MODES.flatMap(m => COST_MATRIX_MODELS.map(x => monthlyPayloadCost(m, x.id)));
  return Math.round(Math.max(...cells) / Math.min(...cells));
}

const tokensK = (m: SearchMode) => `${COST_MATRIX_PAYLOAD_TOKENS[m] / 1000}K`;

/** The matrix as aligned text lines (no trailing blank line). */
export function costMatrixLines(indent = '  '): string[] {
  const col = (s: string) => s.padEnd(14);
  const lines = [
    `Estimated downstream input cost of the retrieved payload @ ${COST_MATRIX_QUERIES_PER_MONTH / 1000}K queries/mo:`,
    '',
    `${indent}${''.padEnd(16)}${COST_MATRIX_MODELS.map(x => col(x.label)).join('')}`.trimEnd(),
    `${indent}${''.padEnd(16)}${COST_MATRIX_MODELS.map(x => col(`(${usd(inputRate(x.id))}/M in)`)).join('')}`.trimEnd(),
    ...MODES.map(m => `${indent}${m.padEnd(16)}${COST_MATRIX_MODELS.map(x => col(`${usd(monthlyPayloadCost(m, x.id))}/mo`)).join('')}`.trimEnd()),
    '',
    `${indent}Assumed payload per query: ${MODES.map(m => `${m} ${tokensK(m)}`).join(', ')} tokens.`,
    `${indent}Scales linearly: x10 for 100K queries/mo, /10 for 1K. ${costMatrixSpread()}x corner-to-corner spread.`,
    `${indent}Embedding, reranking and query expansion are separate provider charges.`,
  ];
  return lines;
}

/** The matrix in one sentence (init's first-run decision). */
export function costMatrixSentence(): string {
  const labels = COST_MATRIX_MODELS.map(x => x.label).join(' / ');
  const cells = MODES.map(m => `${m} ${COST_MATRIX_MODELS.map(x => usd(monthlyPayloadCost(m, x.id))).join(' / ')}`).join(', ');
  return `Estimated downstream input cost of the retrieved payload at ${COST_MATRIX_QUERIES_PER_MONTH / 1000}K queries/month (${labels}): ${cells} per month.`;
}

/** How `query` and `search` expand, stated once. */
export const QUERY_EXPANSION_LINE =
  '`gbrain query` does not expand by default in any mode; --expand forces it and --no-expand skips it. ' +
  '`gbrain config set search.expansion true` turns the default on for the brain in any mode (false turns it off; ' +
  'an explicit --expand or --no-expand still wins). `gbrain search` never expands. An expansion is one call to the ' +
  'configured chat model, a separate provider charge; keyless brains never expand.';

/** The picker's reason for each recommendation branch. */
export const MODE_REASONS = {
  haiku: 'Haiku subagent tier detected — conservative keeps the payload at 4K tokens for a small-context model.',
  noKeys: 'No chat key (Anthropic/OpenAI/Google) and no ready reranker — conservative keeps a tight 4K budget; balanced\'s reranker could not run.',
  rerankOnly: 'A reranker is ready but there is no chat key — balanced reranks with it; nothing in balanced needs a chat model.',
  opus: 'Opus-class model detected — quality ceiling worth the token cost.',
  default: 'A chat key is configured — tokenmax gives the widest retrieval; pick conservative or balanced if cost-sensitive.',
} as const;

/** The non-TTY banner the picker prints after applying `applied`: an agent block asking the operator, then the matrix. */
export function agentBannerLines(applied: SearchMode, reason: string): string[] {
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    `[gbrain] search mode tentatively set to: ${applied}`,
    `[gbrain] Reason: ${reason}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    ...agentBlock({
      ask: 'Which search mode should this brain use: conservative, balanced or tokenmax?',
      why: `The default above (${applied}) was auto-selected from the Reason line. Before continuing, show this matrix to your operator and ask which mode they want; INSTALL_FOR_AGENTS.md Step 3.5 has the full protocol.`,
      next: 'ask_user: if the operator picks differently, run `gbrain config set search.mode <conservative|balanced|tokenmax>` (or `gbrain init --search-mode <mode>` at install time).',
      verify: 'gbrain search modes',
    }).trimEnd().split('\n'),
    '',
    ...costMatrixLines('   '),
    `   ${QUERY_EXPANSION_LINE}`,
    '',
    'To change later: gbrain config set search.mode <mode>',
    'To see what is running: gbrain search modes',
    '',
  ];
}

/** The post-upgrade banner for a brain that has no `search.mode` (it runs the default, balanced). */
export function upgradeBannerLines(): string[] {
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    '[gbrain] This brain has no search.mode set, so it runs balanced',
    '[gbrain] (named modes: conservative / balanced / tokenmax).',
    '═══════════════════════════════════════════════════════════════',
    '',
    ...agentBlock({
      ask: 'Which search mode should this brain use: conservative, balanced or tokenmax?',
      why: `Relay this matrix to your operator and ask which mode they want. Recommended for a brain with a chat key: ${RECOMMENDED_SEARCH_MODE}.`,
      next: 'ask_user: run `gbrain config set search.mode <mode>` after they decide.',
      verify: 'gbrain search modes',
    }).trimEnd().split('\n'),
    '',
    ...costMatrixLines('  '),
    `  ${QUERY_EXPANSION_LINE}`,
    '',
    'To pick:',
    '  gbrain search modes              # see what is running',
    '  gbrain config set search.mode <conservative|balanced|tokenmax>',
    '  gbrain search tune               # data-driven recommendations',
    '',
  ];
}
