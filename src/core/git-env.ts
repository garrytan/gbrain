/**
 * The sanitized environment for a Git child process (wave 13): Git's
 * repository-locating variables are dropped so `git -C <root>` always works on
 * `<root>`. Every Git spawn under
 * `src/core` builds its env here (guarded by `test/git-env-guard.test.ts`).
 * Transport and credential variables (`GIT_SSH_COMMAND`, `GIT_ASKPASS`,
 * `SSH_AUTH_SOCK`, proxies) pass through; `extra` wins over both.
 */

/** `git rev-parse --local-env-vars` (Git 2.55): the variables that locate or reconfigure one repository. */
export const GIT_LOCAL_ENV_VARS = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'] as const;

const LOCAL = new Set<string>(GIT_LOCAL_ENV_VARS);

export function gitChildEnv(extra: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!LOCAL.has(key) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}
