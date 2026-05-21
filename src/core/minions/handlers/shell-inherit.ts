/**
 * Free-form secret inheritance for `shell` job `inherit:` field (v0.36.5.0).
 *
 * Design choice: the agent spawning a minion is in the same trust domain as the
 * worker (same uid on the same machine). When the agent asks for `inherit:[X]`,
 * it KNOWS what X means and what it's for. The validator's job is to make the
 * mechanism work, not to second-guess which config fields are "OK to inherit."
 *
 * What's guaranteed:
 *   - The agent passes config-key NAMES, not values, in `inherit:`.
 *   - Names persist to `minion_jobs.data` and the shell-audit JSONL.
 *   - Values resolve at child-spawn time from the worker's `loadConfig()`.
 *   - If a requested name has no value on the worker, the validator fail-fasts.
 *
 * What's NOT guaranteed:
 *   - No closed enum of "approved" secrets — any config key works.
 *   - No env-shadow rejection — caller can also use `env:` for the same name
 *     if they want; that's their call. Names land in the row plaintext via env:
 *     if you do that, so prefer `inherit:` for hygiene.
 *   - No output-side scrub — if your script prints the value, it persists in
 *     `result.stdout_tail`. Script author's responsibility.
 */
import type { GBrainConfig } from '../../config.ts';

/**
 * Snake-case config-key shape. Pinned by regex to:
 *   - prevent prototype-pollution shapes (`__proto__`, `constructor`)
 *   - prevent path-traversal-looking names in audit logs
 *   - match the `GBrainConfig` field-name convention
 */
export const INHERIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Optional env-key overrides. For most config keys we derive `ENV_KEY` by
 * uppercasing the name (`anthropic_api_key` → `ANTHROPIC_API_KEY`). For a few
 * gbrain-flavored names we use a gbrain-prefixed form so they don't collide
 * with provider conventions: `database_url` becomes `GBRAIN_DATABASE_URL`
 * because plain `DATABASE_URL` is ambiguous (every Postgres app uses it).
 */
const ENV_KEY_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  database_url: 'GBRAIN_DATABASE_URL',
});

/**
 * Derive the child-env key name for a given config key. Falls back to
 * `name.toUpperCase()` when no override is set. Example:
 *   deriveEnvKey('database_url')     === 'GBRAIN_DATABASE_URL'
 *   deriveEnvKey('anthropic_api_key') === 'ANTHROPIC_API_KEY'
 *   deriveEnvKey('voyage_api_key')   === 'VOYAGE_API_KEY'
 */
export function deriveEnvKey(name: string): string {
  return ENV_KEY_OVERRIDES[name] ?? name.toUpperCase();
}

/**
 * Resolve a config-key name to its string value on `cfg`. Returns undefined
 * when the field is unset, non-string, or empty. Uses `Object.hasOwn` to
 * defeat prototype-pollution lookups (`__proto__`, `constructor`, etc.).
 */
export function resolveInheritValue(
  cfg: GBrainConfig | null,
  name: string,
): string | undefined {
  if (cfg === null || typeof cfg !== 'object') return undefined;
  if (!Object.hasOwn(cfg, name)) return undefined;
  const value = (cfg as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}
