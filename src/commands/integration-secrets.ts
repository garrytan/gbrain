import { buildGatewayConfig } from '../core/ai/build-gateway-config.ts';
import { loadConfig } from '../core/config.ts';

export interface RecipeSecret {
  name: string;
  description: string;
  where: string;
  /** Named alternatives. Every ungrouped secret and one complete group are required. */
  group?: string;
}

export function secretGroupName(secret: RecipeSecret): string | undefined {
  if (typeof secret.group !== 'string') return undefined;
  return secret.group.trim() || undefined;
}

/**
 * Apply the same config.json-to-env folding used by the runtime. Environment
 * values still win, and commands keep working before initialization.
 */
export function secretEnv(): Record<string, string | undefined> {
  try {
    const cfg = loadConfig();
    if (cfg) return buildGatewayConfig(cfg).env;
  } catch { /* integrations must keep working pre-init */ }
  return process.env;
}

export function checkSecrets(secrets: RecipeSecret[]): { set: string[]; missing: RecipeSecret[] } {
  const set: string[] = [];
  const missing: RecipeSecret[] = [];
  const env = secretEnv();
  for (const secret of secrets) {
    if (env[secret.name]) set.push(secret.name);
    else missing.push(secret);
  }
  return { set, missing };
}

/**
 * Require every ungrouped secret and, when alternatives exist, one complete
 * named group.
 */
export function hasConfiguredSecrets(secrets: RecipeSecret[]): boolean {
  const env = secretEnv();
  const groups = new Map<string, RecipeSecret[]>();

  for (const secret of secrets) {
    const group = secretGroupName(secret);
    if (!group) {
      if (!env[secret.name]) return false;
      continue;
    }
    const members = groups.get(group) ?? [];
    members.push(secret);
    groups.set(group, members);
  }

  return groups.size === 0 || [...groups.values()].some(members =>
    members.every(secret => Boolean(env[secret.name]))
  );
}
