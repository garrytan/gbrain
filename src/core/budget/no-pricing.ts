/**
 * The one `no_pricing` refusal: what an agent needs when a cost cap the user
 * set cannot be enforced because gbrain has no price for the model.
 *
 * Every surface that reports `no_pricing` (BudgetTracker.reserve, enrich,
 * conversation facts, skillopt, the embedding migration authorization, and
 * the cycle warnings that point at the same registration) builds its text and
 * structured fields here, so the guidance cannot drift between them.
 *
 * Registration (`gbrain pricing set`) is trusted-local CLI only: a remote MCP
 * caller could otherwise declare a $0 rate and void the cap. The guidance
 * therefore always names the exact command and tells a remote caller to ask
 * the brain's operator to run it.
 */

import type { Action, Transport } from '../agent-output.ts';
import { ERROR_CATALOGUE } from '../error-catalogue.ts';
import { splitProviderModelId } from '../model-id.ts';
import type { BudgetKind } from './reservation-cost.ts';

export interface NoPricingGuidance {
  /** Stable wire code. */
  code: 'no_pricing';
  model: string;
  provider: string | null;
  kind: BudgetKind;
  /** Rates `gbrain pricing set` needs, each in USD per 1M tokens. */
  units: Array<'usd_per_1m_input_tokens' | 'usd_per_1m_output_tokens' | 'usd_per_1m_tokens'>;
  /** What to look up before registering. */
  lookup: string;
  /** The literal registration command, with placeholders for the rates and source URL. */
  register_command: string;
  /** Registration runs only through the trusted local CLI on the brain host; never over MCP. */
  register_scope: 'local_cli';
  docs: string;
}

const KIND_NOUN: Record<BudgetKind, string> = { chat: 'chat', embed: 'embedding', rerank: 'reranker', decide: 'decision' };

function shellArg(value: string): string {
  return /^[\w.:/@+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The registration argv for one model; `<name>` slots are the fix's `inputs`. */
export function pricingSetArgv(modelId: string, kind: BudgetKind): string[] {
  const rates = kind === 'chat'
    ? ['--input', '<usd-per-1M-input-tokens>', '--output', '<usd-per-1M-output-tokens>']
    : ['--rate', '<usd-per-1M-tokens>'];
  return ['gbrain', 'pricing', 'set', modelId, ...rates, '--source', '<pricing-page-url>'];
}

/** The registration command for one model, in the units its kind bills. */
export function pricingSetCommand(modelId: string, kind: BudgetKind): string {
  return pricingSetArgv(modelId, kind).map((a, i) => (i === 3 ? shellArg(a) : a)).join(' ');
}

export function noPricingGuidance(modelId: string, kind: BudgetKind): NoPricingGuidance {
  const provider = splitProviderModelId(modelId).provider;
  const units: NoPricingGuidance['units'] = kind === 'chat'
    ? ['usd_per_1m_input_tokens', 'usd_per_1m_output_tokens']
    : ['usd_per_1m_tokens'];
  const rate = kind === 'chat' ? 'USD per 1M input tokens and USD per 1M output tokens' : 'USD per 1M tokens';
  return {
    code: 'no_pricing',
    model: modelId,
    provider,
    kind,
    units,
    lookup: `Look up ${provider ?? 'the provider'}'s current price for ${modelId} (for example, web-search its pricing page): ${rate}.`,
    register_command: pricingSetCommand(modelId, kind),
    register_scope: 'local_cli',
    docs: ERROR_CATALOGUE.no_pricing.docs,
  };
}

/** The steps after the cause: look up, register, retry, and the remote-caller route. */
export function noPricingSteps(g: NoPricingGuidance): string {
  return `${g.lookup} Register it on the brain host (saved in pricing.overrides) with: ${g.register_command} — then retry. ` +
    `Over MCP or another remote connection you cannot register prices; ask the brain's operator to run that command. ` +
    `See ${g.docs}`;
}

/**
 * The full refusal text: a one-line cause, then the steps. `label` prefixes
 * the cause (the tracker's phase/command label); `capUsd` names the cap.
 */
export function noPricingMessage(g: NoPricingGuidance, opts: { label?: string; capUsd?: number } = {}): string {
  const cap = opts.capUsd !== undefined && Number.isFinite(opts.capUsd) ? `the $${opts.capUsd.toFixed(2)} cost cap` : 'the cost cap';
  const who = g.provider ? ` (provider ${g.provider})` : '';
  const prefix = opts.label ? `${opts.label}: ` : '';
  return `${prefix}gbrain has no pricing for ${KIND_NOUN[g.kind]} model "${g.model}"${who}, so ${cap} can't be enforced. ${noPricingSteps(g)}`;
}

/**
 * The agent-contract `fix` for a `no_pricing` refusal under a user cap: the
 * registration command with an `inputs` entry per rate to look up. Only the
 * trusted local CLI can register a price, so the actor is `agent` on the CLI
 * and `host_admin` on a remote transport.
 */
export function noPricingFix(g: NoPricingGuidance, transport: Transport = 'cli'): Action {
  const rateInputs = g.kind === 'chat'
    ? [{ name: 'usd-per-1M-input-tokens', how: g.lookup }, { name: 'usd-per-1M-output-tokens', how: g.lookup }]
    : [{ name: 'usd-per-1M-tokens', how: g.lookup }];
  return {
    argv: pricingSetArgv(g.model, g.kind),
    consent: [],
    actor: transport === 'cli' ? 'agent' : 'host_admin',
    why: `gbrain has no price for ${g.model}, so the cost cap the user set cannot be enforced; registering the rate lets the run retry under that cap.`,
    inputs: [...rateInputs, { name: 'pricing-page-url', how: 'The provider pricing page the rates came from.' }],
    verify: { argv: ['gbrain', 'pricing', 'list'] },
    docs: g.docs,
    requires_exclusive: false,
  };
}
