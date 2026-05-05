import { execSync } from 'node:child_process';
import { loadConfig } from './config.ts';

export type SecretName = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GROQ_API_KEY';

const COMMAND_KEYS: Record<SecretName, 'openai_api_key_command' | 'anthropic_api_key_command' | 'groq_api_key_command'> = {
  OPENAI_API_KEY: 'openai_api_key_command',
  ANTHROPIC_API_KEY: 'anthropic_api_key_command',
  GROQ_API_KEY: 'groq_api_key_command',
};

const cache = new Map<SecretName, string>();

const RESOLVER_TIMEOUT_MS = 10_000;

function resolverCommandFor(name: SecretName): string | undefined {
  const cfg = loadConfig();
  const cmd = cfg?.secrets?.[COMMAND_KEYS[name]];
  return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd : undefined;
}

function runResolver(name: SecretName, cmd: string): string {
  let out: string;
  try {
    out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RESOLVER_TIMEOUT_MS,
    });
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 'unknown';
    const stderr = e?.stderr ? String(e.stderr).trim() : '';
    const stderrLine = stderr ? `\n  stderr: ${stderr}` : '';
    throw new Error(
      `gbrain: ${name} resolver command failed (exit ${status}): ${cmd}${stderrLine}`,
    );
  }
  const trimmed = out.trim();
  if (!trimmed) {
    throw new Error(
      `gbrain: ${name} resolver command returned empty output: ${cmd}`,
    );
  }
  return trimmed;
}

/**
 * Resolve an API key by name, preferring a configured shell command in
 * `~/.gbrain/config.json` `secrets.<lowercase_name>_command` over the env var.
 *
 * Returns undefined when neither a command nor an env var is configured —
 * call sites already handle the "no key" case (skip embedding, skip vector
 * search, skip pattern detection). When a command IS configured but fails,
 * this throws loudly: a configured-but-broken resolver is a real misconfig
 * the user wants surfaced, not silently downgraded to "no key".
 *
 * Resolved values are held in a module-private cache for the process
 * lifetime so we never re-prompt Keychain. They are NEVER written back to
 * `process.env`, so they don't inherit into spawned subprocesses or show up
 * in `ps -E`. Subprocess gbrain invocations re-resolve via their own config.
 */
export function getSecret(name: SecretName): string | undefined {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const cmd = resolverCommandFor(name);
  if (cmd) {
    const value = runResolver(name, cmd);
    cache.set(name, value);
    return value;
  }

  const env = process.env[name];
  if (env) {
    cache.set(name, env);
    return env;
  }
  return undefined;
}

/** Test-only: drop cached values so a follow-up call re-resolves. */
export function clearSecretsCache(): void {
  cache.clear();
}

export interface SecretResolutionStatus {
  name: SecretName;
  configured: boolean;
  resolved: boolean;
  error?: string;
}

/**
 * Used by `gbrain doctor`. For every secret with a configured resolver
 * command, attempt resolution and report success/failure. Does NOT include
 * the resolved value in the result — only whether resolution worked. Env-only
 * secrets (no configured command) are reported as `configured: false`.
 */
export function resolveAllConfiguredSecrets(): SecretResolutionStatus[] {
  const out: SecretResolutionStatus[] = [];
  for (const name of Object.keys(COMMAND_KEYS) as SecretName[]) {
    const cmd = resolverCommandFor(name);
    if (!cmd) {
      out.push({ name, configured: false, resolved: false });
      continue;
    }
    try {
      getSecret(name);
      out.push({ name, configured: true, resolved: true });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      out.push({ name, configured: true, resolved: false, error: message });
    }
  }
  return out;
}
