/**
 * `gbrain pricing` — register a model's per-token price in `pricing.overrides`.
 *
 *   gbrain pricing set <model> --input <usd/1M> --output <usd/1M> [--source <url>]
 *   gbrain pricing set <model> --rate <usd/1M> [--source <url>]     (embeddings, rerankers)
 *   gbrain pricing list [--json]
 *   gbrain pricing unset <model>
 *
 * Each write reads the stored JSON, changes one entry and writes it back, so
 * other models' overrides survive (`config set pricing.overrides` replaces
 * the whole value). A cost cap the user set refuses an unpriced model with
 * `no_pricing`; the refusal tells the agent to look the rate up and run
 * `pricing set` (src/core/budget/no-pricing.ts).
 *
 * Trust boundary: this is a CLI-only command, never an operation, so no MCP
 * caller can reach it — a remote agent could otherwise declare $0 and void a
 * cap. The command table refuses it on thin clients for the same reason.
 *
 * Entries keep the existing schema: `{input, output}` for chat, `pricePerMTok`
 * for a single rate (input and output). `source` and `set_at` sit beside the
 * rates for provenance; parsePricingOverrides ignores them.
 */

import type { BrainEngine } from '../core/engine.ts';
import { parsePricingOverrides } from '../core/budget/budget-tracker.ts';
import { isAllowedPricingOverrideKey } from '../core/budget/reservation-cost.ts';
import { getRecipe } from '../core/ai/recipes/index.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const KEY = 'pricing.overrides';

const HELP = `gbrain pricing — register model prices for cost caps

USAGE
  gbrain pricing set <model> --input <usd-per-1M> --output <usd-per-1M> [--source <url>]
  gbrain pricing set <model> --rate <usd-per-1M> [--source <url>]
  gbrain pricing list [--json]
  gbrain pricing unset <model>

Chat models take --input and --output (USD per 1M input / output tokens).
Embedding and reranker models take one --rate (USD per 1M tokens).
--source records where the rate came from, usually the provider's pricing page.

Prices merge into the pricing.overrides config: other entries are kept.
They win over gbrain's shipped price tables. A $0 rate is accepted with a
warning: every call to that model then counts as free against all cost caps.

A provider wildcard (<provider>:*) prices every model of a provider that
bills by subscription, today only claude-cli:
  gbrain pricing set 'claude-cli:*' --rate 0 --source <plan-url>
An exact model entry still wins over the wildcard. Per-token API providers
and a bare * are refused: one rate cannot be right for all their models.

This command runs only on the brain host's local CLI. Agents connected over
MCP cannot register prices; they ask the operator to run the command.
See docs/operations/spend-controls.md#registering-a-model-price.
`;

export interface PricingEntry {
  input?: number;
  output?: number;
  pricePerMTok?: number;
  source?: string;
  set_at?: string;
}

type RawOverrides = Record<string, unknown>;

/** Parse the stored value. Refuses (throws) instead of clobbering an unreadable value. */
export function readRawOverrides(raw: string | null): RawOverrides {
  if (raw == null || raw.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${KEY} is not valid JSON, so it was left unchanged. Inspect it with: gbrain config get ${KEY}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${KEY} is not a JSON object, so it was left unchanged. Inspect it with: gbrain config get ${KEY}`);
  }
  return value as RawOverrides;
}

const normalize = (model: string) => model.trim().toLowerCase();

function withoutModel(overrides: RawOverrides, model: string): { rest: RawOverrides; removed: string[] } {
  const rest: RawOverrides = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (normalize(k) === normalize(model)) removed.push(k);
    else rest[k] = v;
  }
  return { rest, removed };
}

/** Returns the rate or an error message. Non-negative finite numbers only. */
function parseRate(flag: string, value: string | undefined): number | string {
  if (value === undefined || value.trim() === '' || value.startsWith('--')) return `${flag} needs a value in USD per 1M tokens.`;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return `${flag} must be a non-negative number of USD per 1M tokens (got "${value}").`;
  return n;
}

export interface PricingSetRequest {
  model: string;
  input?: number;
  output?: number;
  rate?: number;
  source?: string;
}

/** Merge one model's price into the stored overrides. Pure. */
export function mergePricing(overrides: RawOverrides, req: PricingSetRequest, now: Date): { next: RawOverrides; entry: PricingEntry; replaced: boolean } {
  const { rest, removed } = withoutModel(overrides, req.model);
  const entry: PricingEntry = req.rate !== undefined
    ? { pricePerMTok: req.rate }
    : { input: req.input, output: req.output };
  if (req.source) entry.source = req.source;
  entry.set_at = now.toISOString();
  return { next: { ...rest, [normalize(req.model)]: entry }, entry, replaced: removed.length > 0 };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1] ?? '';
}

function fail(message: string): void {
  console.error(`gbrain pricing: ${message}`);
  setCliExitVerdict(1);
}

function describeEntry(model: string, value: unknown): { input: number; output: number } | null {
  if (!isAllowedPricingOverrideKey(model)) return null;
  const parsed = parsePricingOverrides({ probe: value });
  return parsed?.probe ?? null;
}

/** The recipe models a `<provider>:*` key prices (empty for an exact model key). */
export function wildcardMatches(key: string): string[] {
  const k = normalize(key);
  if (!k.endsWith(':*')) return [];
  const recipe = getRecipe(k.slice(0, -2));
  if (!recipe) return [];
  const models = new Set<string>();
  for (const tp of Object.values(recipe.touchpoints)) {
    for (const m of (tp as { models?: string[] } | undefined)?.models ?? []) models.add(`${recipe.id}:${m}`);
  }
  return [...models];
}

async function runSet(engine: BrainEngine, args: string[]): Promise<void> {
  const model = args[0];
  if (!model || model.startsWith('--')) return fail('missing <model>. Usage: gbrain pricing set <model> --input <usd-per-1M> --output <usd-per-1M>');
  const has = (flag: string) => args.includes(flag);
  if (!isAllowedPricingOverrideKey(model)) {
    return fail(`"${model}" is not a model id gbrain can price. A provider wildcard (<provider>:*) is accepted only for providers that bill by subscription (claude-cli); register each model of a per-token provider separately.`);
  }
  const req: PricingSetRequest = { model: model.trim() };
  if (has('--rate')) {
    if (has('--input') || has('--output')) return fail('use either --rate, or --input with --output, not both.');
    const rate = parseRate('--rate', flagValue(args, '--rate'));
    if (typeof rate === 'string') return fail(rate);
    req.rate = rate;
  } else if (has('--input') || has('--output')) {
    if (!has('--input') || !has('--output')) return fail('chat prices need both --input and --output (use --rate for a single per-token rate).');
    const input = parseRate('--input', flagValue(args, '--input'));
    if (typeof input === 'string') return fail(input);
    const output = parseRate('--output', flagValue(args, '--output'));
    if (typeof output === 'string') return fail(output);
    req.input = input;
    req.output = output;
  } else {
    return fail('give the price: --input <usd-per-1M> --output <usd-per-1M> for chat models, or --rate <usd-per-1M> for embeddings.');
  }
  if (has('--source')) {
    const source = flagValue(args, '--source')?.trim();
    if (!source || source.startsWith('--')) return fail('--source needs a value (the pricing page URL).');
    req.source = source;
  }

  let current: RawOverrides;
  try {
    current = readRawOverrides(await engine.getConfig(KEY));
  } catch (err) {
    return fail((err as Error).message);
  }
  const { next, entry, replaced } = mergePricing(current, req, new Date());
  await engine.setConfig(KEY, JSON.stringify(next));

  const rates = req.rate !== undefined
    ? `$${req.rate} per 1M tokens`
    : `$${req.input} per 1M input tokens, $${req.output} per 1M output tokens`;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ model: normalize(req.model), ...entry, replaced }, null, 2));
  } else {
    console.log(`${replaced ? 'Updated' : 'Registered'} ${normalize(req.model)}: ${rates}${req.source ? ` (source: ${req.source})` : ''}.`);
    console.log('Cost caps now price this model at that rate. Retry the command that was refused.');
  }
  if (req.rate === 0 || (req.input === 0 && req.output === 0)) {
    console.error(`gbrain pricing: warning: ${normalize(req.model)} is registered at $0, so its calls count as free against every cost cap. Use $0 only for local or flat-rate routes.`);
  }
  if (normalize(req.model).endsWith(':*')) {
    console.error(`gbrain pricing: ${normalize(req.model)} is an operator assumption that prices every ${normalize(req.model).slice(0, -2)} model, including ones gbrain ships a rate for, so cost caps no longer use those shipped rates. An exact model entry still wins.`);
  }
}

async function runList(engine: BrainEngine, args: string[]): Promise<void> {
  let current: RawOverrides;
  try {
    current = readRawOverrides(await engine.getConfig(KEY));
  } catch (err) {
    return fail((err as Error).message);
  }
  const rows = Object.entries(current).map(([model, value]) => {
    const priced = describeEntry(model, value);
    const meta = value && typeof value === 'object' ? value as PricingEntry : {};
    return {
      model,
      input: priced?.input ?? null,
      output: priced?.output ?? null,
      valid: priced !== null,
      source: meta.source ?? null,
      set_at: meta.set_at ?? null,
      ...(model.trim().endsWith(':*') ? { matches: wildcardMatches(model) } : {}),
    };
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ overrides: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No registered prices. Add one with: gbrain pricing set <model> --input <usd-per-1M> --output <usd-per-1M>');
    return;
  }
  console.log('Registered prices (USD per 1M tokens; these win over the shipped tables):');
  for (const r of rows) {
    const rate = r.valid ? `input $${r.input}, output $${r.output}` : 'invalid entry, ignored by cost caps';
    const extra = [r.source && `source ${r.source}`, r.set_at && `set ${r.set_at}`].filter(Boolean).join('; ');
    console.log(`  ${r.model}: ${rate}${extra ? ` (${extra})` : ''}`);
    if (r.valid && r.matches) console.log(`    provider wildcard, operator assumption; prices every ${r.model.trim().slice(0, -2)} model without an exact entry, e.g. ${r.matches.join(', ')}`);
  }
}

async function runUnset(engine: BrainEngine, args: string[]): Promise<void> {
  const model = args[0];
  if (!model || model.startsWith('--')) return fail('missing <model>. Usage: gbrain pricing unset <model>');
  let current: RawOverrides;
  try {
    current = readRawOverrides(await engine.getConfig(KEY));
  } catch (err) {
    return fail((err as Error).message);
  }
  const { rest, removed } = withoutModel(current, model);
  if (removed.length === 0) {
    console.log(`No registered price for ${normalize(model)}; nothing changed.`);
    return;
  }
  await engine.setConfig(KEY, JSON.stringify(rest));
  console.log(`Removed the registered price for ${normalize(model)}. Under a cost cap it is unpriced again unless gbrain ships a rate for it.`);
}

export async function runPricing(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (sub === 'set') return runSet(engine, rest);
  if (sub === 'list') return runList(engine, rest);
  if (sub === 'unset') return runUnset(engine, rest);
  fail(`unknown subcommand "${sub}". Run gbrain pricing --help.`);
}
