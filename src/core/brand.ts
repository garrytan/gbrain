/**
 * The product's names, in one place.
 *
 * This fork is being renamed. Every name a user sees or types (the command,
 * the MCP server name, the home folder, the environment-variable prefix)
 * should come from BRAND, so the rename is one edit here plus a mechanical
 * sweep, not a hunt through thousands of literals. New code reads BRAND;
 * old literals move here as the sweep reaches them.
 *
 * LEGACY_ENV_PREFIX stays `GBRAIN_` for good: once BRAND.envPrefix changes,
 * readBrandEnv still honours an existing install's `GBRAIN_*` variables, so
 * nobody's setup breaks on upgrade.
 */

export const LEGACY_ENV_PREFIX = 'GBRAIN_';

export const BRAND = Object.freeze({
  /** The command, the package and the MCP server name. */
  name: 'gbrain',
  /** The name in prose. */
  displayName: 'GBrain',
  /** Prefix of the product's environment variables. */
  envPrefix: 'GBRAIN_',
  /** The home folder appended to the home parent (`~/.gbrain`). */
  homeDirName: '.gbrain',
});

/** The full environment-variable name for an unprefixed key (`HOME` -> `GBRAIN_HOME`). */
export function brandEnvName(key: string, prefix: string = BRAND.envPrefix): string {
  return prefix + key;
}

/**
 * Read an environment variable by its unprefixed key: the brand's own name
 * first, then the legacy `GBRAIN_` name. The environment is passed in (the
 * embeddable core reads no process state itself).
 */
export function readBrandEnv(
  env: Record<string, string | undefined>,
  key: string,
  prefix: string = BRAND.envPrefix,
): string | undefined {
  const own = env[prefix + key];
  if (own !== undefined || prefix === LEGACY_ENV_PREFIX) return own;
  return env[LEGACY_ENV_PREFIX + key];
}
