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
 * Comparison is primarily lexical (`path.resolve` + separator
 * normalization) because the candidate path often does not exist on the
 * machine evaluating it (that is the whole problem); when a path DOES exist
 * locally its realpath spelling is compared too, so symlink aliases of the
 * same live directory (macOS `/var` → `/private/var`) cannot slip the
 * containment check. The threat model is accidents, not adversaries — an
 * operator who wants to bind a runner path on purpose has the escape
 * hatches below. Windows paths are compared with forward slashes and an
 * uppercased drive letter so a `D:\a\...` Actions checkout classifies the
 * same as its POSIX siblings.
 *
 * Consumers: `sync-anchor.ts:writeSyncAnchor` (skips the repo_path persist;
 * the sync stays session-scoped), `sources-ops.ts:addSource` (throws
 * `ephemeral_ci_path`), `sources-set-path.ts` (exit 7), and
 * `import.ts:runImport` (skips the `sync.repo_path` bookmark persist).
 *
 * Escape hatches (every site honors them):
 *   - `--force` on `gbrain sources add` / `gbrain sources set-path`
 *   - `GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1` (env-only — for CI jobs that
 *     genuinely host a durable brain at a runner-ish path; also the only
 *     hatch for `gbrain sync` / `gbrain import`, which have no force flag)
 */

import { resolve } from 'path';
import { realpathSync } from 'fs';
import { homedir } from 'os';

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
 * anything nested inside it. Windows prefixes are spelled in the normalized
 * comparison form (forward slashes, lowercased — NTFS is case-insensitive).
 */
const EPHEMERAL_RUNNER_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['/home/runner/work/', 'GitHub Actions hosted Linux runner workspace'],
  ['/Users/runner/work/', 'GitHub Actions hosted macOS runner workspace'],
  ['/__w/', 'GitHub Actions container-job workspace mount'],
  ['d:/a/', 'GitHub Actions hosted Windows runner workspace'],
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

/** CI-presence env vars read by `isCiEnv`. */
const CI_PRESENCE_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
] as const;

/**
 * Every env var this guard reads — workspace vars, CI-presence vars, and the
 * escape hatch. Exported so tests can neutralize ambient CI env from ONE
 * canonical list (the suites run for real under GitHub Actions); a provider
 * added here automatically reaches every test-side control case.
 */
export const GUARD_ENV_VARS: readonly string[] = [
  ...WORKSPACE_ENV_VARS.map(([envVar]) => envVar),
  ...CI_PRESENCE_ENV_VARS,
  'GBRAIN_ALLOW_EPHEMERAL_REPO_PATH',
];

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/** Is this process running inside a recognizable CI environment? */
export function isCiEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_PRESENCE_ENV_VARS.some((name) => envTruthy(env[name]));
}

/**
 * Operator escape hatch: persist/bind an ephemeral-looking path anyway.
 * Env-only by design (same incident-time posture as the GBRAIN_SYNC_* knobs).
 *
 * Affirmative allowlist, NOT `envTruthy`: this switch DISABLES a protection,
 * so a negation spelled the common-but-unlisted way (`no`, `off`, `disabled`)
 * must not silently open the bypass. Set-means-CI is the safe direction for
 * `isCiEnv`; set-means-anything is the wrong direction here.
 */
export function allowEphemeralPersist(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GBRAIN_ALLOW_EPHEMERAL_REPO_PATH?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Normalize a path into the guard's comparison form. POSIX spellings resolve
 * against cwd (case-sensitive — Linux runners are). A win32-absolute
 * spelling (`D:\a\r`, `D:/a/r`) is recognized on ANY host so a
 * Windows-origin path in a shared brain classifies correctly from a Mac too
 * (POSIX `resolve` would treat it as relative and mangle it); it gets a pure,
 * host-independent win32 lexical normalize — forward slashes, doubled
 * separators and dot segments collapsed (so `D://a/x` and `D:/foo/../a/x`
 * cannot dodge the prefix) — and is lowercased whole, because NTFS is
 * case-insensitive. Lexical only — see the module header for why not
 * realpath (and `comparisonForms` for the realpath assist).
 */
function normalizePathForCompare(path: string): string {
  const winAbs = /^[A-Za-z]:[\\/]/.test(path);
  if (!winAbs) return resolve(path).replace(/\\/g, '/');
  const slashed = path.replace(/\\/g, '/');
  const segments = slashed.slice(3).split('/').filter((seg) => seg !== '' && seg !== '.');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${slashed[0]!.toLowerCase()}:/${out.join('/')}`.toLowerCase();
}

/** Leading-tilde expansion for env-supplied workspace values: CircleCI
 * conventionally sets CIRCLE_WORKING_DIRECTORY to the literal `~/project`,
 * which `resolve` would turn into `<cwd>/~/project` and never match. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}/${p.slice(2)}`;
  return p;
}

/**
 * The comparison spellings of a path: always the lexical form, plus the
 * realpath form when the path exists locally and differs. Lexical stays
 * primary (a runner path replayed on a machine where it doesn't exist must
 * still classify), but symlinked spellings of the SAME live directory —
 * macOS `/var` → `/private/var` is the everyday case — must not slip the
 * containment check when a caller realpaths before persisting while the
 * provider's env carries the symlinked spelling (or vice versa).
 */
function comparisonForms(p: string): string[] {
  const lexical = normalizePathForCompare(p);
  const forms = [lexical];
  try {
    const real = normalizePathForCompare(realpathSync(p));
    if (real !== lexical) forms.push(real);
  } catch {
    // Path doesn't exist here — lexical form is all we have, by design.
  }
  return forms;
}

/**
 * Is `normalizedPath` the directory `root` itself, or nested inside it?
 * Lexical and segment-exact — `/srv/app2` is NOT under `/srv/app`. A trailing
 * slash on `root` is tolerated so the tables above can be spelled either way.
 */
function isAtOrUnder(normalizedPath: string, root: string): boolean {
  const dir = root.endsWith('/') ? root.slice(0, -1) : root;
  return normalizedPath === dir || normalizedPath.startsWith(dir + '/');
}

/** A workspace root that would contain every path on the filesystem/drive
 * (`/`, `D:/`) must never be used for containment. */
function isDegenerateRoot(normalized: string): boolean {
  return normalized === '/' || /^[a-z]:\/?$/.test(normalized);
}

/**
 * Classify a candidate durable-binding path. Pure: all environment input
 * comes through `env`, so tests inject fixtures instead of mutating globals.
 */
export function classifyEphemeralCiPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): EphemeralPathVerdict {
  const candidates = comparisonForms(path);

  for (const [prefix, label] of EPHEMERAL_RUNNER_PREFIXES) {
    if (candidates.some((p) => isAtOrUnder(p, prefix))) {
      return { ephemeral: true, rule: 'ci_runner_path', detail: label };
    }
  }

  if (isCiEnv(env)) {
    for (const [prefix, label] of CI_CORROBORATED_PREFIXES) {
      if (candidates.some((p) => isAtOrUnder(p, prefix))) {
        return { ephemeral: true, rule: 'ci_runner_path', detail: label };
      }
    }
  }

  for (const [envVar, label] of WORKSPACE_ENV_VARS) {
    const raw = env[envVar]?.trim();
    if (!raw) continue;
    const wsForms = comparisonForms(expandTilde(raw)).filter(
      (ws) => !isDegenerateRoot(ws),
    );
    if (wsForms.some((ws) => candidates.some((p) => isAtOrUnder(p, ws)))) {
      return { ephemeral: true, rule: 'ci_workspace_env', detail: `inside ${label}` };
    }
  }

  return { ephemeral: false, rule: null, detail: null };
}

/**
 * Shared remediation copy for refusal sites (`addSource`, `sources set-path`)
 * so the two error surfaces cannot drift. `subject` is the sentence lead-in
 * naming what was refused (e.g. `Refusing to register source "x" with
 * local_path /p:` or `"/p" looks like ...`); this returns the consequence +
 * remediation tail. sync/import sites keep their bespoke shorter wording —
 * they SKIP a persist rather than refuse an operation.
 */
export function ephemeralCiPathAdvice(detail: string): string {
  return (
    `it looks like an ephemeral CI checkout (${detail}). On a shared brain ` +
    `this path would break capture and sync on every other machine once the ` +
    `runner is gone. To sync CI content without binding the path: register ` +
    `the source path-less if it doesn't exist yet ('gbrain sources add <id>' ` +
    `with no --path), then run 'gbrain sync --repo <path> --source <id>' ` +
    `(the path stays session-scoped). If this path really is durable, pass ` +
    `--force or set GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1.`
  );
}
