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
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ResolverError } from './errors.ts';

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
