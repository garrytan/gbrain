/**
 * Pre-test setup: force `commit.gpgsign=false` / `tag.gpgsign=false` for every
 * git invocation in the test run — the test files' own `git init`/`git commit`
 * setup AND any git subprocess spawned by code under test (sync, put_page
 * write-through, bootstrap).
 *
 * Why this exists: ~40 test files create throwaway git repos and commit into
 * them. On a dev box whose GLOBAL gitconfig sets `commit.gpgsign=true`, every
 * one of those commits routes through gpg-agent. Under full-suite parallel
 * load the agent intermittently fails with "gpg: signing failed: Cannot
 * allocate memory" → "fatal: failed to write commit object", flipping
 * whichever sync/write-through tests got unlucky that run (observed: 4
 * failures across 3 serial files, all green standalone). CI has no signing
 * config, so the flake is dev-box-only and looks like lane contention.
 *
 * Fix: git's environment-config mechanism (GIT_CONFIG_COUNT/KEY_n/VALUE_n,
 * git >= 2.31) injects the two keys at the HIGHEST config priority without
 * touching anything else — user identity, init.defaultBranch, and every other
 * global setting still resolve normally, and child processes inherit the env
 * through the usual `{ ...process.env }` spawn spreads. A per-repo
 * `git config commit.gpgsign false` in each test would fix only that repo and
 * misses repos created by the code under test.
 *
 * Composes with (rather than clobbers) any pre-existing GIT_CONFIG_COUNT
 * entries, and skips entirely if signing keys are already injected — an
 * operator or a future signing-behavior test can override deliberately.
 *
 * #7451: it first drops every variable production's `gitChildEnv` drops (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_CONFIG_* and the rest of `git rev-parse --local-env-vars`). A run started from a git hook inherits the hook's
 * repository through them, and a helper's `git -C <temp repo> config ...` then wrote into the caller's repository
 * (`core.bare=true`, `user.name t`). Transport and credential variables pass through, as in production.
 *
 * Bun.spawn and Bun.spawnSync called without an `env` option give the child the environment the process started with,
 * not process.env as edited here, so both are wrapped to default `env` to process.env (child_process already does).
 * Without that, a helper's `Bun.spawnSync(['git', ...])` still saw the hook's GIT_DIR and none of the keys below.
 *
 * Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/git-hermetic-preload.ts"]`.
 */
import { gitChildEnv } from '../../src/core/git-env.ts';

for (const name of ['spawn', 'spawnSync'] as const) {
  const original = Bun[name] as (...args: unknown[]) => unknown;
  (Bun as unknown as Record<string, unknown>)[name] = (first: unknown, second?: object) => Array.isArray(first)
    ? original(first, { env: process.env, ...second })
    : original({ env: process.env, ...(first as object) });
}

const kept = gitChildEnv({}, process.env);
for (const key of Object.keys(process.env)) if (!(key in kept)) delete process.env[key];
Object.assign(process.env, kept);

const base = Number(process.env.GIT_CONFIG_COUNT ?? '0') || 0;
const existingKeys: string[] = [];
for (let i = 0; i < base; i++) {
  existingKeys.push(process.env[`GIT_CONFIG_KEY_${i}`] ?? '');
}

if (!existingKeys.includes('commit.gpgsign') && !existingKeys.includes('tag.gpgsign')) {
  process.env[`GIT_CONFIG_KEY_${base}`] = 'commit.gpgsign';
  process.env[`GIT_CONFIG_VALUE_${base}`] = 'false';
  process.env[`GIT_CONFIG_KEY_${base + 1}`] = 'tag.gpgsign';
  process.env[`GIT_CONFIG_VALUE_${base + 1}`] = 'false';
  process.env.GIT_CONFIG_COUNT = String(base + 2);
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
    console.error('[git-hermetic-preload] gpg signing disabled for test git processes');
  }
}
