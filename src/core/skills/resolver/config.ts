/**
 * The resolver's settings, read engine-free from the file-plane config
 * (`<home>/config.json`, the `skills.resolver` object) and the
 * environment. Nothing here opens a brain.
 *
 *   skills.resolver.session_token_budget  block tokens one session may receive
 *     (default 8000). 0 turns the resolver silent: every block is empty and
 *     budget_exhausted is true. Otherwise 100..50000; anything else refuses
 *     with skill_resolver_config_invalid. Only a compaction (or
 *     reset_session) resets a session's spend.
 *   skills.resolver.auto_rebuild  false (or GBRAIN_SKILLS_NO_AUTOREBUILD=1)
 *     stops a stale resolve from scheduling a rebuild (no stale.stamp).
 *
 * The model picker (router.ts; off by default, and only the command line and
 * the Claude Code and Codex hook lanes may start it):
 *
 *   skills.resolver.router  true turns the picker on
 *   skills.resolver.router_model  "provider:model" (default: Claude Haiku 5.5
 *     with an Anthropic key, else the cheapest configured ROUTER_DEFAULT_MODELS)
 *   skills.resolver.router_timeout_ms  the longest a turn waits for it
 *     (ROUTER_TIMEOUT_MS_MIN..MAX; default 1500 in Claude Code, 2000 elsewhere)
 *   skills.resolver.router_max_usd_per_day  the daily spend cap in USD
 *     (0..ROUTER_MAX_USD_PER_DAY_MAX, default 0.50; 0 stops every call)
 *   A model on any OpenAI-compatible endpoint (a self-hosted or fine-tuned
 *   one) is router_model compat:<model id> with:
 *   skills.resolver.router_base_url  the endpoint's base URL, up to /v1
 *     (https, or http to localhost only); required for compat:
 *   skills.resolver.router_api_key_env  the environment variable holding its
 *     key, read by name (unset: no key is sent)
 *   skills.resolver.router_usd_per_mtok  [input, output] or [input, output,
 *     cached input] USD per million tokens, so the daily cap holds; required
 *     for compat: ([0, 0] when free); without the third, cached input is
 *     charged at the input rate
 *   A bad router value does not refuse the turn: the picker stays off for it
 *     and the turn reports router.fallback.code config_invalid.
 *
 * The hook lane's turn settings (read by hook-lane.ts; a library caller
 * passes its own per turn):
 *
 *   skills.resolver.top_k       suggestions per turn (1..8, default 5)
 *   skills.resolver.min_match   the weakest match_strength to suggest
 *     (default: every match)
 *   skills.resolver.top_gate    empty the block when the best skill it would
 *     show scores below this over its catalog's maxIdf (0..100, 0 is off;
 *     default TOP_GATE_DEFAULT)
 *   skills.resolver.per_harness.<harness>.{top_k,min_match,top_gate}  overrides
 *     for one harness; a key it leaves out falls back to the global one, and
 *     an entry that is not an object (a hand-edited null) counts as unset
 *   skills.resolver.per_harness.<claude-code|codex>.dirs  extra absolute
 *     skill directories setup adds to that harness's user catalog (at most
 *     SKILL_DIRS_MAX); setup and the catalog's recorded rebuild keep them
 *   skills.resolver.pinned      skill ids the harness always loads itself,
 *     never suggested (at most 1,024)
 *   skills.resolver.per_harness.<claude-code|codex>.session_start  plain text
 *     the hook lane prints at every SessionStart that starts or restores
 *     context (startup, resume, clear, compact), after that harness's pinned
 *     block (skills.resolver.pins.<harness>-user); at most
 *     SESSION_START_TOKEN_CAP tokens, no control characters but newlines and
 *     tabs (laneSessionStart)
 *   skills.resolver.per_harness.hermes.owner_sender_ids  the senders whose
 *     turns get suggestions (Hermes's extra.sender_id); a turn from anyone
 *     else, or with no sender, gets none. Unset or empty: every turn. The
 *     same rule as the OpenClaw plugin's owner_sender_ids.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens, HARNESSES } from './block.ts';
import { ResolverError } from './errors.ts';
import { EXCLUDE_MAX, MATCH_STRENGTHS, type MatchStrength, TOP_GATE_DEFAULT, TOP_GATE_MAX, TOP_K_MAX } from './limits.ts';

export const DEFAULT_SESSION_TOKEN_BUDGET = 8000;
export const MIN_SESSION_TOKEN_BUDGET = 100;
export const MAX_SESSION_TOKEN_BUDGET = 50_000;
const CONFIG_CAP = 1024 * 1024;
export const SKILL_DIRS_MAX = 32;
/** The session_start text's cap, the same as the pinned block's (PIN_BLOCK_TOKEN_CAP). */
export const SESSION_START_TOKEN_CAP = 600;
/** The harnesses whose user catalog setup builds and whose hook lane has a SessionStart entry, so the only ones a dirs or session_start key applies to. */
const DIRS_HARNESSES = ['claude-code', 'codex'];

export interface ResolverSettings {
  sessionTokenBudget: number;
  autoRebuild: boolean;
  router: RouterSettings;
}

export const ROUTER_TIMEOUT_MS_MIN = 200;
export const ROUTER_TIMEOUT_MS_MAX = 2500;
/** The most a Claude Code turn waits for the picker, whatever router_timeout_ms says: worker start, deadline, margin and process boot must fit Claude Code's 3 s hook limit. */
export const ROUTER_TIMEOUT_MS_CLAUDE_CODE_MAX = 2000;
export const ROUTER_MAX_USD_PER_DAY_DEFAULT = 0.5;
export const ROUTER_MAX_USD_PER_DAY_MAX = 100;
const ROUTER_MODEL_RE = /^(?:(?:anthropic|openai|google):[A-Za-z0-9][\w.\-]{0,127}|compat:[A-Za-z0-9][\w.\-/:]{0,127})$/;
const ROUTER_KEY_ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const ROUTER_USD_PER_MTOK_MAX = 1000;
export const ROUTER_EXTRA_BODY_MAX_BYTES = 4096;
/** The only fields router_extra_body may set: sampling and reasoning controls, none of which adds billable input or lifts the output cap the daily-cap reservation counts on. */
const ROUTER_EXTRA_BODY_FIELDS = ['temperature', 'top_p', 'top_k', 'min_p', 'seed', 'presence_penalty', 'frequency_penalty', 'repetition_penalty', 'reasoning_effort', 'thinking', 'chat_template_kwargs'];

/** The picker's settings; `invalid` names the first bad key (the picker then stays off and reports config_invalid). */
export interface RouterSettings { on: boolean; model: string | null; timeoutMs: number | null; maxUsdPerDay: number; baseUrl: string | null; keyEnv: string | null; usdPerMtok: RouterUsdPerMtok | null; extraBody: Record<string, unknown> | null; promptVersion: number | null; invalid: string | null }
/** [input, output] or [input, output, cached input] in USD per million tokens. */
export type RouterUsdPerMtok = [number, number] | [number, number, number];

export function validateRouterModel(v: unknown, key: string): string {
  if (typeof v === 'string' && ROUTER_MODEL_RE.test(v)) return v;
  throw configInvalid(key, 'must be an anthropic:, openai:, google: or compat: model id, like anthropic:claude-haiku-5-5');
}

export function validateRouterBaseUrl(v: unknown, key: string): string {
  let u: URL | null = null;
  try { if (typeof v === 'string' && v.length <= 512) u = new URL(v); } catch { u = null; }
  const local = u && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u && !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && local))) return (v as string).replace(/\/+$/, '');
  throw configInvalid(key, 'must be the https base URL of the endpoint up to /v1, like https://models.example.com/v1 (http only for localhost; no credentials in the URL)');
}

export function validateRouterKeyEnv(v: unknown, key: string): string {
  if (typeof v === 'string' && ROUTER_KEY_ENV_RE.test(v)) return v;
  throw configInvalid(key, 'must be the name of an environment variable, like MY_MODEL_API_KEY');
}

export function validateRouterUsdPerMtok(v: unknown, key: string): RouterUsdPerMtok {
  const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= ROUTER_USD_PER_MTOK_MAX;
  if (Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(ok)) return v.length === 3 ? [v[0], v[1], v[2]] : [v[0], v[1]];
  throw configInvalid(key, `must be [input, output] or [input, output, cached input] in US dollars per million tokens, each 0 to ${ROUTER_USD_PER_MTOK_MAX}, like [0.1, 0.5]`);
}

export function validateRouterExtraBody(v: unknown, key: string): Record<string, unknown> {
  const other = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter(k => !ROUTER_EXTRA_BODY_FIELDS.includes(k)) : [];
  if (v && typeof v === 'object' && !Array.isArray(v) && !other.length && Buffer.byteLength(JSON.stringify(v)) <= ROUTER_EXTRA_BODY_MAX_BYTES) return v as Record<string, unknown>;
  throw configInvalid(key, `must be a JSON object of at most ${ROUTER_EXTRA_BODY_MAX_BYTES} bytes, like {"reasoning_effort": "none"}, with only ${ROUTER_EXTRA_BODY_FIELDS.join(', ')}${other.length ? `; remove ${other.join(', ')}` : ''}`);
}

export function validateRouterPromptVersion(v: unknown, key: string): number {
  if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000) return v as number;
  throw configInvalid(key, 'must be the whole-number picker prompt version the model was trained on, like 1');
}

export function validateRouterTimeout(v: unknown, key: string): number {
  if (Number.isInteger(v) && (v as number) >= ROUTER_TIMEOUT_MS_MIN && (v as number) <= ROUTER_TIMEOUT_MS_MAX) return v as number;
  throw configInvalid(key, `must be a whole number of milliseconds from ${ROUTER_TIMEOUT_MS_MIN} to ${ROUTER_TIMEOUT_MS_MAX} (unset: 1500 in Claude Code, 2000 elsewhere)`);
}

export function validateRouterMaxUsd(v: unknown, key: string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= ROUTER_MAX_USD_PER_DAY_MAX) return v;
  throw configInvalid(key, `must be a number of US dollars from 0 to ${ROUTER_MAX_USD_PER_DAY_MAX} (default ${ROUTER_MAX_USD_PER_DAY_DEFAULT})`);
}

/** The picker settings in a skills.resolver section. Never throws. */
export function routerSettings(section: Record<string, unknown>): RouterSettings {
  const p = 'skills.resolver.';
  const out: RouterSettings = { on: section.router === true, model: null, timeoutMs: null, maxUsdPerDay: ROUTER_MAX_USD_PER_DAY_DEFAULT, baseUrl: null, keyEnv: null, usdPerMtok: null, extraBody: null, promptVersion: null, invalid: null };
  try {
    if (section.router !== undefined && typeof section.router !== 'boolean') throw configInvalid(`${p}router`, 'must be true or false');
    if (section.router_model !== undefined) out.model = validateRouterModel(section.router_model, `${p}router_model`);
    if (section.router_timeout_ms !== undefined) out.timeoutMs = validateRouterTimeout(section.router_timeout_ms, `${p}router_timeout_ms`);
    if (section.router_max_usd_per_day !== undefined) out.maxUsdPerDay = validateRouterMaxUsd(section.router_max_usd_per_day, `${p}router_max_usd_per_day`);
    if (section.router_base_url !== undefined) out.baseUrl = validateRouterBaseUrl(section.router_base_url, `${p}router_base_url`);
    if (section.router_api_key_env !== undefined) out.keyEnv = validateRouterKeyEnv(section.router_api_key_env, `${p}router_api_key_env`);
    if (section.router_usd_per_mtok !== undefined) out.usdPerMtok = validateRouterUsdPerMtok(section.router_usd_per_mtok, `${p}router_usd_per_mtok`);
    if (section.router_extra_body !== undefined) out.extraBody = validateRouterExtraBody(section.router_extra_body, `${p}router_extra_body`);
    if (section.router_prompt_version !== undefined) out.promptVersion = validateRouterPromptVersion(section.router_prompt_version, `${p}router_prompt_version`);
    if (out.extraBody && !out.model?.startsWith('compat:')) throw configInvalid(`${p}router_extra_body`, 'applies only to a compat: router_model; unset it for this model');
    if (out.model?.startsWith('compat:') && !out.baseUrl) throw configInvalid(`${p}router_base_url`, 'must be set when router_model is a compat: model');
  } catch (e) { out.invalid = (e as Error).message; }
  return out;
}

export function validateSessionTokenBudget(v: unknown, where: string): number {
  if (v === 0) return 0;
  if (typeof v === 'number' && Number.isInteger(v) && v >= MIN_SESSION_TOKEN_BUDGET && v <= MAX_SESSION_TOKEN_BUDGET) return v;
  throw new ResolverError('skill_resolver_config_invalid',
    `${where} must be 0 (resolver silent) or an integer from ${MIN_SESSION_TOKEN_BUDGET} to ${MAX_SESSION_TOKEN_BUDGET}.`,
    { suggestion: `Set ${where} to 0 or a value from ${MIN_SESSION_TOKEN_BUDGET} to ${MAX_SESSION_TOKEN_BUDGET} (default ${DEFAULT_SESSION_TOKEN_BUDGET}).` });
}

/** The skills.resolver object of <home>/config.json ({} when the file or the object is missing or unreadable). */
export function readResolverSection(home: string): Record<string, unknown> {
  const path = join(home, 'config.json');
  try {
    if (statSync(path).size <= CONFIG_CAP) {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as { skills?: { resolver?: Record<string, unknown> } };
      const r = cfg?.skills?.resolver;
      if (r && typeof r === 'object') return r;
    }
  } catch { /* no config or not JSON: defaults */ }
  return {};
}

export function readResolverSettings(home: string, env: NodeJS.ProcessEnv = process.env): ResolverSettings {
  const section = readResolverSection(home);
  const budget = section.session_token_budget === undefined ? DEFAULT_SESSION_TOKEN_BUDGET
    : validateSessionTokenBudget(section.session_token_budget, 'skills.resolver.session_token_budget');
  const autoRebuild = env.GBRAIN_SKILLS_NO_AUTOREBUILD === '1' ? false : section.auto_rebuild !== false;
  return { sessionTokenBudget: budget, autoRebuild, router: routerSettings(section) };
}

/** What the hook lane adds to each turn's input. */
export interface LaneTurnSettings { top_k?: number; min_match_strength?: MatchStrength; top_gate?: number; exclude?: string[] }

function configInvalid(key: string, rule: string): ResolverError {
  return new ResolverError('skill_resolver_config_invalid', `${key} ${rule}.`, { suggestion: `Fix or unset ${key}: gbrain config unset ${key}` });
}

export function validateTopK(v: unknown, key: string): number {
  if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= TOP_K_MAX) return v as number;
  throw configInvalid(key, `must be a whole number from 1 to ${TOP_K_MAX} (default 5)`);
}

export function validateMinMatch(v: unknown, key: string): MatchStrength {
  if ((MATCH_STRENGTHS as readonly unknown[]).includes(v)) return v as MatchStrength;
  throw configInvalid(key, `must be one of ${MATCH_STRENGTHS.join(', ')}`);
}

export function validateTopGate(v: unknown, key: string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= TOP_GATE_MAX) return v;
  throw configInvalid(key, `must be a number from 0 to ${TOP_GATE_MAX} (0: off; unset: ${TOP_GATE_DEFAULT})`);
}

export function validateSkillDirs(v: unknown, key: string): string[] {
  if (Array.isArray(v) && v.length <= SKILL_DIRS_MAX && v.every(x => typeof x === 'string' && x.startsWith('/') && x.length <= 4096 && !x.includes('\0') && !x.split('/').includes('..'))) return [...new Set((v as string[]).map(d => resolve(d)))];
  throw configInvalid(key, `must be a list of at most ${SKILL_DIRS_MAX} absolute directory paths`);
}

/** The extra skill directories configured for one harness's user catalog (empty when none). Throws skill_resolver_config_invalid on a bad value. */
export function configuredSkillDirs(section: Record<string, unknown>, harness: string): string[] {
  const per = section.per_harness;
  const mine = per && typeof per === 'object' && !Array.isArray(per) ? (per as Record<string, unknown>)[harness] : undefined;
  const dirs = mine && typeof mine === 'object' && !Array.isArray(mine) ? (mine as Record<string, unknown>).dirs : undefined;
  return dirs === undefined ? [] : validateSkillDirs(dirs, `skills.resolver.per_harness.${harness}.dirs`);
}

export function validatePinned(v: unknown, key: string): string[] {
  if (Array.isArray(v) && v.length <= EXCLUDE_MAX && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)) return v as string[];
  throw configInvalid(key, `must be a list of at most ${EXCLUDE_MAX} skill ids`);
}

/** The top_gate configured for `harness` (its per_harness key, else the global one), or undefined when neither is set. Reads and validates only those two keys, so a bad value elsewhere in the section never affects it. Throws skill_resolver_config_invalid on a bad top_gate. */
export function configuredTopGate(section: Record<string, unknown>, harness: string): number | undefined {
  const per = section.per_harness;
  const mine = harness && per && typeof per === 'object' && !Array.isArray(per) ? (per as Record<string, unknown>)[harness] : undefined;
  const own = mine && typeof mine === 'object' && !Array.isArray(mine) ? (mine as Record<string, unknown>).top_gate : undefined;
  if (own !== undefined) return validateTopGate(own, `skills.resolver.per_harness.${harness}.top_gate`);
  return section.top_gate === undefined ? undefined : validateTopGate(section.top_gate, 'skills.resolver.top_gate');
}

/** The turn settings the lane uses for `harness`: its per_harness keys, else the global ones. Throws skill_resolver_config_invalid on a bad value anywhere in the section. */
export function laneTurnSettings(section: Record<string, unknown>, harness: string): LaneTurnSettings {
  const p = 'skills.resolver.';
  const global: LaneTurnSettings = {
    ...(section.top_k !== undefined ? { top_k: validateTopK(section.top_k, `${p}top_k`) } : {}),
    ...(section.min_match !== undefined ? { min_match_strength: validateMinMatch(section.min_match, `${p}min_match`) } : {}),
    ...(section.top_gate !== undefined ? { top_gate: validateTopGate(section.top_gate, `${p}top_gate`) } : {}),
    ...(section.pinned !== undefined ? { exclude: validatePinned(section.pinned, `${p}pinned`) } : {}),
  };
  const per = section.per_harness;
  if (per === undefined) return global;
  if (!per || typeof per !== 'object' || Array.isArray(per)) throw configInvalid(`${p}per_harness`, 'must be an object keyed by harness');
  let mine: LaneTurnSettings = {};
  for (const [h, o] of Object.entries(per as Record<string, unknown>)) {
    const key = `${p}per_harness.${h}`;
    if (!(HARNESSES as readonly string[]).includes(h)) throw configInvalid(key, `names no harness (one of ${HARNESSES.join(', ')})`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (Object.keys(o).some(k => k !== 'top_k' && k !== 'min_match' && k !== 'top_gate' && k !== 'dirs' && k !== 'session_start' && (k !== 'owner_sender_ids' || h !== 'hermes'))) throw configInvalid(key, `may hold only top_k, min_match, top_gate, dirs and session_start`);
    const r = o as Record<string, unknown>;
    if (r.dirs !== undefined) {
      if (!DIRS_HARNESSES.includes(h)) throw configInvalid(`${key}.dirs`, `applies only to ${DIRS_HARNESSES.join(' and ')}, whose user catalog setup builds`);
      validateSkillDirs(r.dirs, `${key}.dirs`);
    }
    if (r.session_start !== undefined) {
      if (!DIRS_HARNESSES.includes(h)) throw configInvalid(`${key}.session_start`, `applies only to ${DIRS_HARNESSES.join(' and ')}, whose hook lane has a SessionStart entry`);
      validateSessionStart(r.session_start, `${key}.session_start`);
    }
    const parsed: LaneTurnSettings = {
      ...(r.top_k !== undefined ? { top_k: validateTopK(r.top_k, `${key}.top_k`) } : {}),
      ...(r.min_match !== undefined ? { min_match_strength: validateMinMatch(r.min_match, `${key}.min_match`) } : {}),
      ...(r.top_gate !== undefined ? { top_gate: validateTopGate(r.top_gate, `${key}.top_gate`) } : {}),
    };
    if (h === 'hermes' && r.owner_sender_ids !== undefined) validateOwnerSenders(r.owner_sender_ids, `${key}.owner_sender_ids`);
    if (h === harness) mine = parsed;
  }
  return { ...global, ...mine };
}

export function validateSessionStart(v: unknown, key: string): string {
  if (typeof v === 'string' && v.trim() && estimateTokens(v) <= SESSION_START_TOKEN_CAP && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) return v;
  throw configInvalid(key, `must be plain text of at most ${SESSION_START_TOKEN_CAP} tokens (about ${SESSION_START_TOKEN_CAP * 4} characters) with no control characters but newlines and tabs`);
}

/** The session_start text for `harness` (Claude Code or Codex), or undefined when unset. Call after laneTurnSettings, which validates it. */
export function laneSessionStart(section: Record<string, unknown>, harness: string): string | undefined {
  const mine = (section.per_harness as Record<string, unknown> | undefined)?.[harness] as { session_start?: string } | null | undefined;
  return DIRS_HARNESSES.includes(harness) && mine && typeof mine === 'object' ? mine.session_start : undefined;
}

export const OWNER_SENDERS_MAX = 64;

export function validateOwnerSenders(v: unknown, key: string): string[] {
  if (Array.isArray(v) && v.length <= OWNER_SENDERS_MAX && v.every(x => typeof x === 'string' && /^[\x21-\x7e]{1,128}$/.test(x))) return v as string[];
  throw configInvalid(key, `must be a list of at most ${OWNER_SENDERS_MAX} sender ids (1-128 visible characters each)`);
}

/** The senders whose turns get suggestions on `harness` (Hermes only), or null for every turn. Call after laneTurnSettings, which validates it. */
export function laneOwnerSenders(section: Record<string, unknown>, harness: string): string[] | null {
  const mine = (section.per_harness as Record<string, unknown> | undefined)?.[harness] as { owner_sender_ids?: string[] } | null | undefined;
  const ids = harness === 'hermes' && mine && typeof mine === 'object' ? mine.owner_sender_ids : undefined;
  return ids?.length ? ids : null;
}
