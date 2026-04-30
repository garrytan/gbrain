import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type { AIGatewayConfig, AuthResolution, ProviderAuthConfig, Recipe } from './types.ts';

const OPENCLAW_CODEX_PROFILE = 'openclaw-codex';
const OPENCLAW_OPENAI_PROFILE = 'openclaw-openai';

const PROFILE_ENV_HINTS: Record<string, string[]> = {
  [OPENCLAW_CODEX_PROFILE]: ['OPENCLAW_CODEX_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  [OPENCLAW_OPENAI_PROFILE]: ['OPENAI_API_KEY'],
};

export function getProviderAuthConfig(config: AIGatewayConfig | undefined, recipe: Recipe): ProviderAuthConfig {
  return config?.provider_auth?.[recipe.id] ?? {};
}

export function resolveProviderAuth(recipe: Recipe, config: AIGatewayConfig): AuthResolution {
  const providerConfig = getProviderAuthConfig(config, recipe);
  const envResolution = resolveEnvAuth(recipe, config.env);
  if (envResolution) return envResolution;

  if (providerConfig.prefer === 'openclaw-codex' || providerConfig.prefer === 'openclaw-openai') {
    return resolveOpenClawProfileAuth(recipe, config, providerConfig);
  }

  return missingResolution(recipe, providerConfig);
}

export function redactAuthResolution(resolution: AuthResolution): Record<string, unknown> {
  const meta = resolution.meta ?? {};
  return {
    source: resolution.source,
    credentialKey: resolution.credentialKey,
    isConfigured: resolution.isConfigured,
    missingReason: resolution.missingReason,
    meta,
  };
}

export function getCredentialValue(resolution: AuthResolution): string | undefined {
  return resolution.value;
}

function resolveEnvAuth(recipe: Recipe, env: Record<string, string | undefined>): AuthResolution | null {
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) {
    return {
      source: 'unauthenticated',
      isConfigured: true,
      meta: { mode: 'unauthenticated' },
    };
  }

  for (const key of required) {
    const value = env[key];
    if (value) {
      return {
        source: 'env',
        credentialKey: key,
        value,
        isConfigured: true,
        meta: { mode: 'env' },
      };
    }
  }

  return null;
}

function resolveOpenClawProfileAuth(recipe: Recipe, config: AIGatewayConfig, providerConfig: ProviderAuthConfig): AuthResolution {
  const profile = providerConfig.profile ?? defaultProfileForRecipe(recipe);
  const path = providerConfig.openclawAuthPath ?? defaultOpenClawAuthPath();
  const raw = readOpenClawAuthRecord(path, profile);
  if (!raw) {
    return missingResolution(recipe, providerConfig, `OpenClaw profile \"${profile}\" not found at ${path}`);
  }

  const envHints = PROFILE_ENV_HINTS[profile] ?? recipe.auth_env?.required ?? [];
  const found = envHints.find(key => typeof raw[key] === 'string' && raw[key]);
  if (!found) {
    return missingResolution(recipe, providerConfig, `OpenClaw profile \"${profile}\" missing expected token field`);
  }

  return {
    source: providerConfig.prefer ?? 'openclaw-codex',
    credentialKey: found,
    value: String(raw[found]),
    isConfigured: true,
    meta: {
      mode: 'openclaw-profile',
      profile,
      path,
    },
  };
}

function missingResolution(recipe: Recipe, providerConfig: ProviderAuthConfig, reason?: string): AuthResolution {
  const expected = providerConfig.prefer === 'openclaw-codex' || providerConfig.prefer === 'openclaw-openai'
    ? providerConfig.profile ?? defaultProfileForRecipe(recipe)
    : recipe.auth_env?.required?.[0];

  return {
    source: 'missing',
    credentialKey: expected,
    isConfigured: false,
    missingReason: reason ?? defaultMissingReason(recipe, providerConfig),
    meta: {
      mode: providerConfig.prefer ?? 'env',
    },
  };
}

function defaultMissingReason(recipe: Recipe, providerConfig: ProviderAuthConfig): string {
  if (providerConfig.prefer === 'openclaw-codex' || providerConfig.prefer === 'openclaw-openai') {
    return `OpenClaw profile \"${providerConfig.profile ?? defaultProfileForRecipe(recipe)}\" is not configured.`;
  }
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) return 'No credentials required.';
  return `Missing ${required.join(', ')}.`;
}

function defaultProfileForRecipe(recipe: Recipe): string {
  return recipe.id === 'openai' ? OPENCLAW_CODEX_PROFILE : OPENCLAW_OPENAI_PROFILE;
}

function defaultOpenClawAuthPath(): string {
  return join(homedir(), '.openclaw', 'auth.json');
}

function readOpenClawAuthRecord(path: string, profile: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return findProfileRecord(raw, profile);
  } catch {
    return null;
  }
}

function findProfileRecord(raw: unknown, profile: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const direct = obj[profile];
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;

  const profiles = obj.profiles;
  if (profiles && typeof profiles === 'object') {
    const nested = (profiles as Record<string, unknown>)[profile];
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }

  return null;
}
