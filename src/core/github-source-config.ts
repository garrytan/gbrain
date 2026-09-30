/** Parse a GitHub connector source's `sources.config`. Dependency-light so migrations and the connector identity can import it. */
import type { GitHubSourceConfig, GitHubAppConfig } from './github-source.ts';

/** True for "owner/name" with no dot segments, slashes, or empty parts. */
export function isValidRepoName(repo: string): boolean {
  if (repo.length === 0 || repo.length > 200) return false;
  if (repo.startsWith('/') || repo.endsWith('/')) return false;
  const parts = repo.split('/');
  if (parts.length !== 2) return false;
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..' && /^[\w.-]+$/.test(p));
}

export function parseGitHubSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GitHubSourceConfig {
  const tokenEnv =
    typeof config.gh_token_env === 'string' && config.gh_token_env.length > 0
      ? config.gh_token_env
      : 'GH_TOKEN';
  const app: GitHubAppConfig | null =
    typeof config.gh_app_id === 'number' &&
    Number.isInteger(config.gh_app_id) &&
    typeof config.gh_app_pem_path === 'string' &&
    config.gh_app_pem_path.length > 0
      ? {
          appId: config.gh_app_id,
          pemPath: config.gh_app_pem_path,
          installId:
            typeof config.gh_app_install_id === 'number' &&
            Number.isInteger(config.gh_app_install_id) &&
            config.gh_app_install_id > 0
              ? config.gh_app_install_id
              : undefined,
        }
      : null;
  // gh_handle / gh_involvement are reserved config keys: tolerated when
  // present but ignored (the involvement expansion is not implemented).
  const scope = config.gh_scope === 'repos' ? 'repos' : 'auto';
  // Repo names are case-insensitive on GitHub; everything downstream (page
  // paths, state file, webhook matching, slugs) keys on the lowercase form.
  const repos =
    typeof config.gh_repos === 'string'
      ? config.gh_repos
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(isValidRepoName)
      : [];
  const dir =
    typeof config.gh_dir === 'string' && config.gh_dir.length > 0
      ? config.gh_dir
      : fallbackDir;
  return { tokenEnv, app, scope, repos, dir };
}
