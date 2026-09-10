/**
 * gbrain ci-path-guard — classify filesystem paths that look like EPHEMERAL
 * CI checkouts so durable path bindings never point at them.
 *
 * The incident class this prevents: a CI job (GitHub Actions runner, checkout
 * at /home/runner/work/<repo>/<repo>) runs `gbrain sync` / `gbrain sources add
 * --path` against a SHARED brain (Supabase creds in CI secrets). The run
 * itself is legitimate — syncing content from a CI checkout is fine — but
 * persisting the runner's checkout path into `sources.local_path` (or the
 * legacy `sync.repo_path` config key) poisons the shared row: every OTHER
 * machine mounting that brain now resolves a path that only ever existed for
 * one CI job, and `gbrain capture` / write-through fails with repo_not_found
 * until an operator repairs the row by hand.
 *
 * Two detection rules, both pure and env-parameterized for testing:
 *
 *   1. `ci_runner_path` — the path sits under a well-known hosted-runner
 *      workspace prefix. These prefixes only exist inside CI runners, so
 *      they fire unconditionally (no env corroboration needed) — which also
 *      catches a runner path REPLAYED outside CI (e.g. restoring a DB dump
 *      that already contains one). Ambiguous prefixes that could plausibly
 *      be a persistent host dir (GitLab's `/builds/`) additionally require
 *      a CI-ish environment before firing.
 *   2. `ci_workspace_env` — the path is inside the workspace directory the
 *      CI provider advertises via env (GITHUB_WORKSPACE, CI_PROJECT_DIR, …).
 *      This catches self-hosted runners with nonstandard roots, where no
 *      static prefix can.
 *
 * Deliberately NOT a rule: bare `CI=true` with an arbitrary path. A brain
 * legitimately hosted on a durable disk of a self-hosted runner (stable path,
 * CI env set) must keep working without ceremony; and this repo's own test
 * suite runs under CI=true against tmpdir fixtures.
 *
 * Comparison is lexical (`path.resolve`), NOT realpath: the candidate path
 * usually does not exist on the machine evaluating it (that is the whole
 * problem), and the threat model is accidents, not adversaries — an operator
 * who wants to bind a runner path on purpose has the escape hatches below.
 *
 * Consumers: `sync-anchor.ts:writeSyncAnchor` (skips the repo_path persist;
 * the sync stays session-scoped), `sources-ops.ts:addSource` (throws
 * `ephemeral_ci_path`), and `sources-set-path.ts` (exit 7).
 *
 * Escape hatches (every site honors them):
 *   - `--force` on `gbrain sources add` / `gbrain sources set-path`
 *   - `GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1` (env-only — for CI jobs that
 *     genuinely host a durable brain at a runner-ish path; also the only
 *     hatch for `gbrain sync`, which has no force flag)
 */

import { resolve } from 'path';

export type EphemeralPathRule = 'ci_runner_path' | 'ci_workspace_env';

export interface EphemeralPathVerdict {
  ephemeral: boolean;
  rule: EphemeralPathRule | null;
  /** Human fragment naming what matched, for error/skip messages. */
  detail: string | null;
}

/**
 * Workspace prefixes that only exist inside hosted CI runners. Fire without
 * env corroboration. Matched segment-exact: the prefix directory itself and
 * anything nested inside it.
 */
const EPHEMERAL_RUNNER_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['/home/runner/work/', 'GitHub Actions hosted Linux runner workspace'],
  ['/Users/runner/work/', 'GitHub Actions hosted macOS runner workspace'],
  ['/__w/', 'GitHub Actions container-job workspace mount'],
  ['/home/circleci/project', 'CircleCI convenience-image checkout'],
  ['/home/vsts/work/', 'Azure Pipelines hosted-agent workspace'],
  ['/buildkite/builds/', 'Buildkite agent build directory'],
];

/**
 * Prefixes that are the default CI checkout root of a provider but could
 * plausibly be a persistent directory on a non-CI host. Only fire when the
 * environment corroborates that we are inside CI.
 */
const CI_CORROBORATED_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['/builds/', 'GitLab CI default builds directory'],
];

/**
 * Env vars through which CI providers advertise the job's (ephemeral)
 * checkout/workspace directory. A path inside any of these is ephemeral
 * regardless of its shape — this is what catches self-hosted runners.
 */
const WORKSPACE_ENV_VARS: ReadonlyArray<readonly [envVar: string, label: string]> = [
  ['GITHUB_WORKSPACE', 'GitHub Actions $GITHUB_WORKSPACE'],
  ['CI_PROJECT_DIR', 'GitLab CI $CI_PROJECT_DIR'],
  ['BUILDKITE_BUILD_CHECKOUT_PATH', 'Buildkite $BUILDKITE_BUILD_CHECKOUT_PATH'],
  ['CIRCLE_WORKING_DIRECTORY', 'CircleCI $CIRCLE_WORKING_DIRECTORY'],
];

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/** Is this process running inside a recognizable CI environment? */
export function isCiEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    envTruthy(env.CI) ||
    envTruthy(env.GITHUB_ACTIONS) ||
    envTruthy(env.GITLAB_CI) ||
    envTruthy(env.BUILDKITE) ||
    envTruthy(env.CIRCLECI) ||
    envTruthy(env.TF_BUILD)
  );
}

/**
 * Operator escape hatch: persist/bind an ephemeral-looking path anyway.
 * Env-only by design (same incident-time posture as the GBRAIN_SYNC_* knobs).
 */
export function allowEphemeralPersist(env: NodeJS.ProcessEnv = process.env): boolean {
  return envTruthy(env.GBRAIN_ALLOW_EPHEMERAL_REPO_PATH);
}

/**
 * Is `resolvedPath` the directory `root` itself, or nested inside it? Lexical
 * and segment-exact — `/srv/app2` is NOT under `/srv/app`. A trailing slash on
 * `root` is tolerated so the tables above can be spelled either way.
 */
function isAtOrUnder(resolvedPath: string, root: string): boolean {
  const dir = root.endsWith('/') ? root.slice(0, -1) : root;
  return resolvedPath === dir || resolvedPath.startsWith(dir + '/');
}

/**
 * Classify a candidate durable-binding path. Pure: all environment input
 * comes through `env`, so tests inject fixtures instead of mutating globals.
 */
export function classifyEphemeralCiPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): EphemeralPathVerdict {
  const p = resolve(path);

  for (const [prefix, label] of EPHEMERAL_RUNNER_PREFIXES) {
    if (isAtOrUnder(p, prefix)) {
      return { ephemeral: true, rule: 'ci_runner_path', detail: label };
    }
  }

  if (isCiEnv(env)) {
    for (const [prefix, label] of CI_CORROBORATED_PREFIXES) {
      if (isAtOrUnder(p, prefix)) {
        return { ephemeral: true, rule: 'ci_runner_path', detail: label };
      }
    }
  }

  for (const [envVar, label] of WORKSPACE_ENV_VARS) {
    const raw = env[envVar]?.trim();
    if (!raw) continue;
    const ws = resolve(raw);
    // Guard the degenerate ws='/' (would contain every path).
    if (ws === '/') continue;
    if (isAtOrUnder(p, ws)) {
      return { ephemeral: true, rule: 'ci_workspace_env', detail: `inside ${label}` };
    }
  }

  return { ephemeral: false, rule: null, detail: null };
}
