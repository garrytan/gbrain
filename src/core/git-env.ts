/**
 * The sanitized environment for a Git child process (wave 13): Git's
 * repository-locating variables are dropped so `git -C <root>` always works on
 * `<root>`. Every Git spawn under
 * `src/core` builds its env here (guarded by `test/git-env-guard.test.ts`).
 * #7759: Git's global pathspec switches are dropped too, so a pathspec gbrain
 * builds means what it says and a hook or helper Git starts for gbrain sees none.
 * Transport and credential variables (`GIT_SSH_COMMAND`, `GIT_ASKPASS`,
 * `SSH_AUTH_SOCK`, proxies) pass through, and so do the operator's environment
 * `safe.directory` entries (#7584); `extra` wins over all of them.
 */

/** `git rev-parse --local-env-vars` (Git 2.55): the variables that locate or reconfigure one repository. */
export const GIT_LOCAL_ENV_VARS = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'] as const;

/** Git's global pathspec switches; GIT_LITERAL_PATHSPECS is what `git --literal-pathspecs` exports to every hook and child. */
export const GIT_PATHSPEC_ENV_VARS = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'] as const;

const DROPPED = new Set<string>([...GIT_LOCAL_ENV_VARS, ...GIT_PATHSPEC_ENV_VARS]);

/**
 * #7759: each path as a literal pathspec. Use this instead of the global `--literal-pathspecs` flag, which Git exports
 * as GIT_LITERAL_PATHSPECS=1 to hooks and children, where a hook's glob pathspec then silently matches nothing.
 */
export const literalPathspecs = (paths: readonly string[]): string[] => paths.map(path => `:(literal)${path}`);

/**
 * Extra env for a Git call that only reads (diff, ls-files, cat-file, rev-parse, status): `GIT_OPTIONAL_LOCKS=0` stops Git
 * taking `index.lock` to refresh the index opportunistically, so a sync never holds the lock a concurrent commit needs.
 * Never for a call that writes (commit, merge, push, update-ref).
 */
export const GIT_READ_ENV: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' };

/**
 * #7584: the `safe.directory` entries the operator set through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`,
 * in order. Only this key survives a scrub: it relaxes Git's ownership check for directories the operator names and cannot run
 * code or reach the network, so carrying it lets a repository owned by another user be read the way plain `git` reads it.
 */
export function envSafeDirectories(source: NodeJS.ProcessEnv = process.env): string[] {
  const count = Number(source.GIT_CONFIG_COUNT);
  const values: string[] = [];
  for (let i = 0; Number.isInteger(count) && i < count; i++) {
    if (source[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === 'safe.directory') values.push(source[`GIT_CONFIG_VALUE_${i}`] ?? '');
  }
  return values;
}

/** `safe.directory` values as command-scope config in the environment, in order (an empty value resets the list, as in Git). */
export function safeDirectoryEnv(values: readonly string[]): NodeJS.ProcessEnv {
  if (!values.length) return {};
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(values.length) };
  values.forEach((value, i) => { env[`GIT_CONFIG_KEY_${i}`] = 'safe.directory'; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}

export function gitChildEnv(extra: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED.has(key) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = value;
  }
  return { ...env, ...safeDirectoryEnv(envSafeDirectories(source)), ...extra };
}
