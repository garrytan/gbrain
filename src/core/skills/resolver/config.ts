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
 *   skills.resolver.top_gate    empty the block when the best skill it would
 *     show scores below this over its catalog's maxIdf (0..100; default off)
 *   skills.resolver.per_harness.<harness>.{top_k,min_match,top_gate}  overrides
 *     for one harness; a key it leaves out falls back to the global one, and
 *     an entry that is not an object (a hand-edited null) counts as unset
 *   skills.resolver.per_harness.<claude-code|codex>.dirs  extra absolute
 *     skill directories setup adds to that harness's user catalog (at most
 *     SKILL_DIRS_MAX); setup and the catalog's recorded rebuild keep them
 *   skills.resolver.pinned      skill ids the harness always loads itself,
 *     never suggested (at most 1,024)
 *   skills.resolver.per_harness.hermes.owner_sender_ids  the senders whose
 *     turns get suggestions (Hermes's extra.sender_id); a turn from anyone
 *     else, or with no sender, gets none. Unset or empty: every turn. The
 *     same rule as the OpenClaw plugin's owner_sender_ids.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HARNESSES } from './block.ts';
import { ResolverError } from './errors.ts';
import { EXCLUDE_MAX, MATCH_STRENGTHS, type MatchStrength, TOP_GATE_MAX, TOP_K_MAX } from './limits.ts';

export const DEFAULT_SESSION_TOKEN_BUDGET = 2000;
export const MIN_SESSION_TOKEN_BUDGET = 100;
export const MAX_SESSION_TOKEN_BUDGET = 50_000;
const CONFIG_CAP = 1024 * 1024;
export const SKILL_DIRS_MAX = 32;
/** The harnesses whose user catalog setup builds, so the only ones a dirs key applies to. */
const DIRS_HARNESSES = ['claude-code', 'codex'];

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
  throw configInvalid(key, `must be a number from 0 to ${TOP_GATE_MAX} (0 or unset: off)`);
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
    if (Object.keys(o).some(k => k !== 'top_k' && k !== 'min_match' && k !== 'top_gate' && k !== 'dirs' && (k !== 'owner_sender_ids' || h !== 'hermes'))) throw configInvalid(key, `may hold only top_k, min_match, top_gate and dirs`);
    const r = o as Record<string, unknown>;
    if (r.dirs !== undefined) {
      if (!DIRS_HARNESSES.includes(h)) throw configInvalid(`${key}.dirs`, `applies only to ${DIRS_HARNESSES.join(' and ')}, whose user catalog setup builds`);
      validateSkillDirs(r.dirs, `${key}.dirs`);
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
