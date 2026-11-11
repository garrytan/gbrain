/**
 * The resolver's settings, read engine-free from the file-plane config
 * (`<home>/config.json`, the `skills.resolver` object) and the
 * environment. Nothing here opens a brain.
 *
 *   skills.resolver.session_token_budget  block tokens one session may receive
 *     (default 2000). 0 turns the resolver silent: every block is empty and
 *     budget_exhausted is true. Otherwise 100..50000; anything else refuses
 *     with skill_resolver_config_invalid. Only a compaction (or
 *     reset_session) resets a session's spend.
 *   skills.resolver.auto_rebuild  false (or GBRAIN_SKILLS_NO_AUTOREBUILD=1)
 *     stops a stale resolve from scheduling a rebuild (no stale.stamp).
 *
 * The hook lane's turn settings (read by hook-lane.ts; a library caller
 * passes its own per turn):
 *
 *   skills.resolver.top_k       suggestions per turn (1..8, default 5)
 *   skills.resolver.min_match   the weakest match_strength to suggest
 *     (default: every match)
 *   skills.resolver.per_harness.<harness>.{top_k,min_match}  overrides
 *     for one harness; a key it leaves out falls back to the global one, and
 *     an entry that is not an object (a hand-edited null) counts as unset
 *   skills.resolver.pinned      skill ids the harness always loads itself,
 *     never suggested (at most 1,024)
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESSES } from './block.ts';
import { ResolverError } from './errors.ts';
import { EXCLUDE_MAX, MATCH_STRENGTHS, type MatchStrength, TOP_K_MAX } from './limits.ts';

export const DEFAULT_SESSION_TOKEN_BUDGET = 2000;
export const MIN_SESSION_TOKEN_BUDGET = 100;
export const MAX_SESSION_TOKEN_BUDGET = 50_000;
const CONFIG_CAP = 1024 * 1024;

export interface ResolverSettings {
  sessionTokenBudget: number;
  autoRebuild: boolean;
}

export function validateSessionTokenBudget(v: unknown, where: string): number {
  if (v === 0) return 0;
  if (typeof v === 'number' && Number.isInteger(v) && v >= MIN_SESSION_TOKEN_BUDGET && v <= MAX_SESSION_TOKEN_BUDGET) return v;
  throw new ResolverError('skill_resolver_config_invalid',
    `${where} must be 0 (resolver silent) or an integer from ${MIN_SESSION_TOKEN_BUDGET} to ${MAX_SESSION_TOKEN_BUDGET}.`,
    { suggestion: `Set ${where} to 0 or a value from ${MIN_SESSION_TOKEN_BUDGET} to ${MAX_SESSION_TOKEN_BUDGET} (default ${DEFAULT_SESSION_TOKEN_BUDGET}).` });
}

export function readResolverSettings(home: string, env: NodeJS.ProcessEnv = process.env): ResolverSettings {
  let section: Record<string, unknown> = {};
  const path = join(home, 'config.json');
  try {
    if (statSync(path).size <= CONFIG_CAP) {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as { skills?: { resolver?: Record<string, unknown> } };
      const r = cfg?.skills?.resolver;
      if (r && typeof r === 'object') section = r;
    }
  } catch { /* no config or not JSON: defaults */ }
  const budget = section.session_token_budget === undefined ? DEFAULT_SESSION_TOKEN_BUDGET
    : validateSessionTokenBudget(section.session_token_budget, 'skills.resolver.session_token_budget');
  const autoRebuild = env.GBRAIN_SKILLS_NO_AUTOREBUILD === '1' ? false : section.auto_rebuild !== false;
  return { sessionTokenBudget: budget, autoRebuild };
}

/** What the hook lane adds to each turn's input. */
export interface LaneTurnSettings { top_k?: number; min_match_strength?: MatchStrength; exclude?: string[] }

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

export function validatePinned(v: unknown, key: string): string[] {
  if (Array.isArray(v) && v.length <= EXCLUDE_MAX && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)) return v as string[];
  throw configInvalid(key, `must be a list of at most ${EXCLUDE_MAX} skill ids`);
}

/** The turn settings the lane uses for `harness`: its per_harness keys, else the global ones. Throws skill_resolver_config_invalid on a bad value anywhere in the section. */
export function laneTurnSettings(section: Record<string, unknown>, harness: string): LaneTurnSettings {
  const p = 'skills.resolver.';
  const global: LaneTurnSettings = {
    ...(section.top_k !== undefined ? { top_k: validateTopK(section.top_k, `${p}top_k`) } : {}),
    ...(section.min_match !== undefined ? { min_match_strength: validateMinMatch(section.min_match, `${p}min_match`) } : {}),
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
    if (Object.keys(o).some(k => k !== 'top_k' && k !== 'min_match')) throw configInvalid(key, 'may hold only top_k and min_match');
    const r = o as Record<string, unknown>;
    const parsed: LaneTurnSettings = {
      ...(r.top_k !== undefined ? { top_k: validateTopK(r.top_k, `${key}.top_k`) } : {}),
      ...(r.min_match !== undefined ? { min_match_strength: validateMinMatch(r.min_match, `${key}.min_match`) } : {}),
    };
    if (h === harness) mine = parsed;
  }
  return { ...global, ...mine };
}
