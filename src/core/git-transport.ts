/**
 * Git transport hardening shared by every remote git call (#6530 split this
 * out of git-remote.ts so src/core/git/ can use it without an import cycle;
 * git-remote.ts re-exports every name here).
 */

/**
 * Git CLI accepts two flag positions:
 *   git [global -c flags] <subcommand> [subcommand flags] [args]
 *
 * Global flags (the `-c key=value` config overrides) MUST come before the
 * subcommand. Subcommand-specific flags (like `--no-recurse-submodules`)
 * MUST come after the subcommand. Mixing the two positions makes git fail
 * with `unknown option` (exit 129). Pre-v0.34 the single GIT_SSRF_FLAGS
 * constant spliced both positions before the verb; real git rejected the
 * subcommand flag but the test harness used a fake-git script that didn't
 * validate, so every remote-source clone/pull broke silently in production.
 *
 * Split into two constants so the call-site spread is unambiguous and the
 * type/name signal the position rule.
 */

/**
 * Global git config flags. Spread BEFORE the subcommand verb.
 * - http.followRedirects=false: closes DNS rebinding via redirect chains
 * - protocol.file.allow=never: no local-file URLs (defense in depth)
 * - protocol.ext.allow=never: no external helpers (`git-remote-foo`)
 */
export const GIT_SSRF_FLAGS = [
  '-c', 'http.followRedirects=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
] as const;

/**
 * Subcommand-level flags. Spread AFTER the subcommand verb (clone/pull).
 * - --no-recurse-submodules: .gitmodules cannot become a second fetch surface
 */
export const GIT_SSRF_SUBCOMMAND_FLAGS = [
  '--no-recurse-submodules',
] as const;

/**
 * Build the strict no-prompt git env for the current (or given) platform.
 *
 * POSIX: confine to the gbrain SSRF model — no credential helpers, no SSH
 * askpass, no GUI prompts (`/bin/false` fails any askpass invocation fast).
 *
 * win32 (#1315): `/bin/false` does not exist, so pointing GIT_ASKPASS at it
 * makes every authed operation die with a confusing "could not run askpass"
 * spawn error instead of failing auth cleanly. Drop both askpass overrides
 * there and set `SSH_ASKPASS_REQUIRE=never` (OpenSSH 8.4+) so ssh never
 * pops a GUI prompt; `GIT_TERMINAL_PROMPT=0` remains the no-terminal-prompt
 * guard on every platform.
 *
 * Pure + platform-parameterized so the win32 shape is unit-testable on
 * POSIX CI (no Windows runner exists).
 */
export function buildGitEnv(
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
  if (platform === 'win32') {
    env.SSH_ASKPASS_REQUIRE = 'never';
  } else {
    env.GIT_ASKPASS = '/bin/false';
    env.SSH_ASKPASS = '/bin/false';
  }
  return env;
}

export const GIT_ENV = buildGitEnv();

/**
 * Auth-capable git env for the durability push/probe paths (v0.42.44).
 *
 * Read-only clone/pull keep the strict GIT_ENV (askpass=/bin/false) so they can
 * never prompt. But push, push-probe, and the durability cron's authed fetch
 * MUST be able to consult the repo's configured credential helper (repo-scoped
 * `store`/`osxkeychain`) — a `/bin/false` askpass would defeat that. We drop the
 * askpass overrides but KEEP `GIT_TERMINAL_PROMPT=0` so a *missing* credential
 * fails fast instead of hanging a non-interactive cron forever.
 */
export const GIT_ENV_AUTH = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
} as const;

/**
 * Global SSRF flags for the durability fetch/pull/push paths. Identical to
 * GIT_SSRF_FLAGS except `protocol.file.allow` honors the env escape hatch
 * `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1` (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES) so
 * self-hosted local-filesystem remotes — and the test suite — can use the file
 * transport. Default stays `never`. These ops act on an ALREADY-validated origin
 * (set + checked at clone time); `http.followRedirects=false` is the live guard.
 */
export function durableSsrfFlags(): string[] {
  const fileAllow = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never';
  return [
    '-c', 'http.followRedirects=false',
    '-c', `protocol.file.allow=${fileAllow}`,
    '-c', 'protocol.ext.allow=never',
  ];
}
