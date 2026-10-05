/**
 * Where the effective `chat_fallback_chain` comes from, and what each entry
 * needs, read without any network call, subprocess or inference.
 *
 * `readChatFallbackPlanes` reads the three planes `loadConfig` /
 * `loadConfigWithEngine` merge (env `GBRAIN_CHAT_FALLBACK_CHAIN` > the
 * config.json key > the DB `config` row) and names the winner, every
 * shadowed value and any plane whose value cannot be read as a chain. The
 * same precedence decides `chat_fallback_on_refusal`.
 *
 * `diagnoseChatFallbackEntry` checks one entry by presence only: it parses
 * as `provider:model`, the provider is known and serves chat, the provider's
 * own credential is present (its env keys, a recipe's `authPresent`, or the
 * claude CLI binary for `claude-cli`; never a login probe), and the model is
 * priced when a user-set cost cap would otherwise refuse it.
 *
 * Consumers: the `chat_fallback_chain` doctor check and the one-time
 * `behavior_changes` safety notice.
 */
import { existsSync } from 'node:fs';
import { configPath, isEnvDisabled, loadConfigFileOnly } from '../config.ts';
import { parseDbChatFallbackChain } from '../config-db-merge.ts';
import { normalizeChatFallbackChain } from './chat-fallback.ts';
import { resolveRecipe } from './model-resolver.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/reservation-cost.ts';
import type { Recipe } from './types.ts';
import type { Action } from '../agent-output.ts';

export type ChatFallbackPlane = 'env' | 'file' | 'db';

export const CHAT_FALLBACK_ENV = 'GBRAIN_CHAT_FALLBACK_CHAIN';
export const CHAT_FALLBACK_ON_REFUSAL_ENV = 'GBRAIN_CHAT_FALLBACK_ON_REFUSAL';

/**
 * Config keys that set a USD cap on chat work. A BudgetTracker built from one
 * runs with `capSource: 'user'`, so an unpriced model under it is refused
 * (`no_pricing`) instead of running unmetered.
 */
export const USER_CHAT_CAP_KEYS: readonly string[] = [
  'cycle.extract_atoms.budget_usd',
  'facts.drain_budget_usd',
  'facts.drain_daily_budget_usd',
  'chronicle.job_budget_usd',
  'takes.bootstrap_budget_usd',
];

export interface ChatFallbackPlanes {
  /** The chain chat() walks, and the plane it comes from; undefined when no plane sets one. */
  effective?: { plane: ChatFallbackPlane; chain: string[] };
  /** Lower-precedence planes that also set a chain (ignored while the winner is set). */
  shadowed: Array<{ plane: ChatFallbackPlane; chain: string[] }>;
  /** Planes whose value cannot be read as a chain. A malformed file value still shadows the DB plane. */
  malformed: Array<{ plane: ChatFallbackPlane; error: string }>;
  onRefusal: { value: boolean; plane: ChatFallbackPlane | 'default' };
  /** config.json path, for file-plane removal guidance. */
  filePath: string;
}

export interface ConfigReader {
  getConfig(key: string): Promise<string | null | undefined>;
}

/** Read all three planes. `db` null (no engine, `--fast`) reads env and file only. Never throws. */
export async function readChatFallbackPlanes(db: ConfigReader | null): Promise<ChatFallbackPlanes> {
  const out: ChatFallbackPlanes = { shadowed: [], malformed: [], onRefusal: { value: true, plane: 'default' }, filePath: configPath() };
  const set: Array<{ plane: ChatFallbackPlane; chain: string[] }> = [];
  // The first plane that speaks wins, even when its value yields no chain:
  // loadConfig keeps it, so the DB merge never fills in under it.
  let winner: ChatFallbackPlane | null = null;

  const envRaw = process.env[CHAT_FALLBACK_ENV];
  if (envRaw) {
    winner = 'env';
    const chain = normalizeChatFallbackChain(envRaw);
    if (chain) set.push({ plane: 'env', chain });
    else out.malformed.push({ plane: 'env', error: `${CHAT_FALLBACK_ENV} is set but names no model` });
  }

  let file: Record<string, unknown> | null = null;
  try { file = loadConfigFileOnly() as unknown as Record<string, unknown> | null; } catch { file = null; }
  const fileRaw = file?.chat_fallback_chain;
  if (fileRaw !== undefined) {
    winner ??= 'file';
    const chain = normalizeChatFallbackChain(fileRaw);
    if (chain) set.push({ plane: 'file', chain });
    else out.malformed.push({ plane: 'file', error: `chat_fallback_chain in ${out.filePath} is not a list of provider:model strings` });
  }

  let dbRaw: string | null | undefined;
  let dbOnRefusal: string | null | undefined;
  if (db) {
    try { dbRaw = await db.getConfig('chat_fallback_chain'); } catch { dbRaw = undefined; }
    try { dbOnRefusal = await db.getConfig('chat_fallback_on_refusal'); } catch { dbOnRefusal = undefined; }
  }
  if (dbRaw) {
    const parsed = parseDbChatFallbackChain(dbRaw);
    if (parsed.chain) { winner ??= 'db'; set.push({ plane: 'db', chain: parsed.chain }); }
    else if (parsed.error) out.malformed.push({ plane: 'db', error: `the DB chat_fallback_chain value ${parsed.error}` });
  }

  out.effective = set.find(s => s.plane === winner);
  out.shadowed = set.filter(s => s.plane !== winner);

  const envRefusal = process.env[CHAT_FALLBACK_ON_REFUSAL_ENV]?.trim();
  const fileRefusal = file?.chat_fallback_on_refusal;
  if (envRefusal) out.onRefusal = { value: !isEnvDisabled(envRefusal), plane: 'env' };
  else if (typeof fileRefusal === 'boolean') out.onRefusal = { value: fileRefusal, plane: 'file' };
  else if (dbOnRefusal === 'true' || dbOnRefusal === 'false') out.onRefusal = { value: dbOnRefusal === 'true', plane: 'db' };
  return out;
}

export type EntryProblem = 'malformed' | 'unknown_provider' | 'no_chat' | 'no_credential' | 'unpriced_under_cap';

export interface EntryDiagnosis {
  entry: string;
  provider?: string;
  /** What the provider authenticates with (env key names or the claude CLI binary); never a value. */
  credential?: string;
  problem?: EntryProblem;
  detail?: string;
}

function claudeCliBinaryPresent(env: Record<string, string | undefined>): boolean {
  const bin = env.GBRAIN_CLAUDE_CLI_BIN ?? process.env.GBRAIN_CLAUDE_CLI_BIN ?? 'claude';
  if (bin.includes('/')) return existsSync(bin);
  try { return !!Bun.which(bin, { PATH: process.env.PATH ?? '' }); } catch { return false; }
}

function credentialOf(recipe: Recipe, env: Record<string, string | undefined>): { present: boolean; how: string } {
  if (recipe.implementation === 'claude-cli') {
    return { present: claudeCliBinaryPresent(env), how: 'the claude CLI binary on PATH or GBRAIN_CLAUDE_CLI_BIN (it keeps its own login)' };
  }
  const required = recipe.auth_env?.required ?? [];
  const how = required.length ? required.join(', ') : 'no credential (local endpoint)';
  if (recipe.authPresent) return { present: recipe.authPresent(env), how };
  return { present: required.every(k => !!env[k]), how };
}

/** One entry, by presence only. `env` is the merged provider env (`mergedProviderEnv`). */
export function diagnoseChatFallbackEntry(
  entry: string,
  ctx: { env: Record<string, string | undefined>; pricingOverrides?: PricingOverrides; userCapKeys: readonly string[] },
): EntryDiagnosis {
  let resolved: ReturnType<typeof resolveRecipe>;
  try {
    resolved = resolveRecipe(entry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /Unknown provider/.test(msg)
      ? { entry, problem: 'unknown_provider', detail: msg }
      : { entry, problem: 'malformed', detail: `${msg} Entries are provider:model, for example anthropic:claude-sonnet-4-6.` };
  }
  const { recipe } = resolved;
  if (!recipe.touchpoints.chat) return { entry, provider: recipe.id, problem: 'no_chat', detail: `${recipe.name} has no chat models.` };
  const cred = credentialOf(recipe, ctx.env);
  if (!cred.present) return { entry, provider: recipe.id, credential: cred.how, problem: 'no_credential', detail: `${recipe.name} needs ${cred.how}, which is not present.` };
  if (ctx.userCapKeys.length > 0 && !isModelPriceable(entry, 'chat', ctx.pricingOverrides)) {
    return { entry, provider: recipe.id, credential: cred.how, problem: 'unpriced_under_cap',
      detail: `gbrain has no price for ${entry}, and a cost cap the user set (${ctx.userCapKeys.join(', ')}) refuses unpriced models.` };
  }
  return { entry, provider: recipe.id, credential: cred.how };
}

export const CHAT_FALLBACK_PLANE_LABEL: Record<ChatFallbackPlane, string> = {
  env: `the ${CHAT_FALLBACK_ENV} environment variable`,
  file: 'config.json',
  db: 'the brain database (gbrain config set)',
};

/**
 * Per-plane removal guidance. Optional: the user decides. DB: the agent may
 * run `gbrain config unset` after the user agrees (`ask_user`). Env and file:
 * only the user can change them (`tell_user_to_run` / `report`), and a
 * long-lived process keeps the old value until it restarts.
 */
export function chatFallbackRemovalFix(plane: ChatFallbackPlane, filePath: string, reason = 'Removing it makes chat calls use only their own model.'): Action {
  const restart = 'A long-lived process (gbrain serve, autopilot, a worker) keeps the old value until it restarts.';
  const base = { consent: ['destructive' as const], requires_exclusive: false, verify: { argv: ['gbrain', 'doctor', '--only', 'chat_fallback_chain', '--json'] }, docs: 'docs/guides/chat-fallback.md' };
  if (plane === 'db') {
    return { ...base, argv: ['gbrain', 'config', 'unset', 'chat_fallback_chain'], actor: 'agent',
      why: `The chain is stored in the brain database. ${reason} Optional: ask the user first. ${restart}`,
      user_message: 'A chat fallback chain is stored in your brain. Do you want it removed (gbrain config unset chat_fallback_chain)? Chat calls would then use only their own model.' };
  }
  if (plane === 'env') {
    return { ...base, argv: ['unset', CHAT_FALLBACK_ENV], actor: 'user',
      why: `The chain comes from ${CHAT_FALLBACK_ENV}. ${reason} Only the user can remove it from the environment that launches gbrain (shell profile, service unit, MCP client config). ${restart}`,
      user_message: `To remove the chat fallback chain, delete ${CHAT_FALLBACK_ENV} from the environment that starts gbrain, then restart any running gbrain serve or autopilot.` };
  }
  return { ...base, actor: 'user',
    why: `The chain is the chat_fallback_chain key in ${filePath}. ${reason} Only the user edits that file. ${restart}`,
    user_message: `To remove the chat fallback chain, delete the "chat_fallback_chain" key from ${filePath}, then restart any running gbrain serve or autopilot.` };
}
