/**
 * Inheritable secrets for `shell` job `inherit:` allowlist (v0.35.8.0).
 *
 * One record, three derivations:
 *   - `InheritableSecret`     — the closed-enum type used in ShellJobParams
 *   - `INHERITABLE_NAMES`     — the runtime list used by the validator
 *   - `INHERITABLE[name].read` — the resolver consulted at child-spawn time
 *
 * Single source of truth: adding a new inheritable secret in a follow-up PR
 * means adding ONE object entry here. The type, the validation walk, the
 * shadow-key set (env keys that must be rejected so they don't bypass the
 * inherit mechanism), and the resolver all derive from this record. The
 * old v0.35.8.0 plan had two parallel arrays which is exactly the drift bug
 * class single-source-of-truth defeats.
 *
 * Scope in v0.35.8.0: `database_url` only. Anthropic / OpenAI / Groq / Voyage
 * / remote_mcp_client_secret are deferred to a follow-up PR that does the
 * `GBrainConfig` + `buildGatewayConfig()` refactor properly — groq_api_key
 * and voyage_api_key aren't first-class config fields today.
 */
import type { GBrainConfig } from '../../config.ts';

/** Spec for one inheritable secret. */
export interface InheritableSpec {
  /** Env-var name set on the spawned child process. */
  envKey: string;
  /**
   * Env-key aliases that are also secrets-by-name. The pre-enqueue validator
   * rejects any caller `env:` containing ANY shadow key, regardless of whether
   * `inherit` was passed. Closes the leak path PR #1137's plain-env-secret
   * workaround opened: callers can no longer place a plaintext DB URL into
   * `minion_jobs.data` by setting `env: { GBRAIN_DATABASE_URL: '...' }`.
   */
  shadowKeys: readonly string[];
  /** Resolve the secret value from the loaded gbrain config. */
  read: (cfg: GBrainConfig | null) => string | undefined;
}

export const INHERITABLE = {
  database_url: {
    envKey: 'GBRAIN_DATABASE_URL',
    // GBRAIN_DIRECT_DATABASE_URL added v0.36.5.0 (codex H3): `src/core/connection-manager.ts`
    // reads it as a non-pooler direct-connection override. Same secret class as
    // GBRAIN_DATABASE_URL — must be shadow-blocked from caller-supplied `env:`.
    shadowKeys: ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL'] as const,
    read: (cfg: GBrainConfig | null) => cfg?.database_url,
  },
} as const satisfies Record<string, InheritableSpec>;

export type InheritableSecret = keyof typeof INHERITABLE;

/** Runtime list of inheritable secret names. Derived from `INHERITABLE`. */
export const INHERITABLE_NAMES: readonly InheritableSecret[] =
  Object.keys(INHERITABLE) as InheritableSecret[];

/** All shadow keys across every inheritable secret. Used by the env-shadow
 *  rejection in the validator. */
export const ALL_SHADOW_KEYS: ReadonlySet<string> = new Set(
  INHERITABLE_NAMES.flatMap((name) => INHERITABLE[name].shadowKeys as readonly string[]),
);

/** Reverse-lookup: which inheritable secret (if any) does this env key shadow?
 *  Returns the InheritableSecret name when the env key matches one of its
 *  shadowKeys; undefined otherwise. Used to write precise error messages. */
export function inheritedByShadowKey(envKey: string): InheritableSecret | undefined {
  for (const name of INHERITABLE_NAMES) {
    if ((INHERITABLE[name].shadowKeys as readonly string[]).includes(envKey)) {
      return name;
    }
  }
  return undefined;
}

/** Type-narrowing guard for runtime payloads. */
export function isInheritableSecret(s: unknown): s is InheritableSecret {
  return typeof s === 'string' && (INHERITABLE_NAMES as readonly string[]).includes(s);
}
