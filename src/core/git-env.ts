/**
 * The environment for a Git child process (CSO G4, wave 13). A gbrain started
 * from a Git hook, or under a shell that exported `GIT_DIR`, inherits Git's
 * repository-locating variables; passed on, they make `git -C <root>` read and
 * write the repository they name instead of `<root>`, so a commit meant for a
 * brain checkout can land in another repository. Every Git spawn under
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
