/**
 * The product's names, in one place.
 *
 * The product is called Foresights; the command is `foresights`, and the old
 * `gbrain` command stays as a second bin of the package for good, so scripts,
 * hooks and services an older version installed keep running.
 *
 * Names stored outside the code keep their original spelling, because
 * renaming them would orphan what is already there:
 *   - the environment variables (`GBRAIN_*`): they live in shell profiles,
 *     `.env` files, service units and hook commands that setup re-reads byte
 *     for byte. `FORESIGHTS_*` is accepted as an alias (adoptAliasEnv);
 *   - the home folder (`~/.gbrain`): its path is recorded in the database,
 *     lock files and backup archives;
 *   - database function names, note markers, schema pack names, job labels,
 *     lock ids, MCP registration names and `.gbrain-*` dotfiles.
 * Code that recognises what an older version wrote (a crontab line, a running
 * process, a hook command) matches either command name (isBrandCommand).
 */

export const LEGACY = Object.freeze({
  /** The command and package name this fork shipped under before; still a bin. */
  name: 'gbrain',
  displayName: 'GBrain',
});

export const BRAND = Object.freeze({
  /** The command and the MCP server name. */
  name: 'foresights',
  /** The name in prose. */
  displayName: 'Foresights',
  /** Prefix of the product's environment variables (stored settings: kept). */
  envPrefix: 'GBRAIN_',
  /** A second prefix every variable answers to (`FORESIGHTS_HOME` = `GBRAIN_HOME`). */
  envAliasPrefix: 'FORESIGHTS_',
  /** The home folder appended to the home parent (`~/.gbrain`, a stored location: kept). */
  homeDirName: '.gbrain',
  /** The GitHub repository releases and upgrades come from. */
  repo: 'aimonk2025/gbrain',
});

/** Kept for callers that named the prefix this way. */
export const LEGACY_ENV_PREFIX = BRAND.envPrefix;

/** The full environment-variable name for an unprefixed key (`HOME` -> `GBRAIN_HOME`). */
export function brandEnvName(key: string, prefix: string = BRAND.envPrefix): string {
  return prefix + key;
}

/**
 * Read an environment variable by its unprefixed key: `GBRAIN_<key>` first,
 * then its alias `FORESIGHTS_<key>`. The environment is passed in (the
 * embeddable core reads no process state itself).
 */
export function readBrandEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const own = env[BRAND.envPrefix + key];
  return own !== undefined ? own : env[BRAND.envAliasPrefix + key];
}

/**
 * Copy every `FORESIGHTS_X` into `GBRAIN_X` where `GBRAIN_X` is unset, so a
 * setting written with the new name reaches code that reads the stored one. A
 * set `GBRAIN_X` always wins. Returns the keys it set. Run once, first, at each
 * process entry; children inherit the result.
 */
export function adoptAliasEnv(env: Record<string, string | undefined>): string[] {
  const adopted: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(BRAND.envAliasPrefix)) continue;
    const stored = BRAND.envPrefix + key.slice(BRAND.envAliasPrefix.length);
    if (env[stored] === undefined && env[key] !== undefined) {
      env[stored] = env[key];
      adopted.push(stored);
    }
  }
  return adopted;
}

/**
 * Whether a command word is this product's CLI under either name: `foresights`
 * or `gbrain`, bare or as a path to the binary (`/usr/local/bin/gbrain`,
 * `foresights.exe`). For code that recognises what an older version installed.
 */
export function isBrandCommand(word: string | undefined | null): boolean {
  if (!word) return false;
  const base = word.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
  return base === BRAND.name || base === LEGACY.name;
}
