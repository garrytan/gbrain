/**
 * Hermetic async CLI spawn wrappers for subprocess tests against the real
 * `src/cli.ts` entrypoint. Consolidates the hand-rolled `run()` helpers in
 * ambient-recall-cli.test.ts / cli-dispatch-thin-client.test.ts.
 *
 * Constraints:
 *   - Async Bun.spawn (NOT spawnSync/execFileSync) — the test event loop
 *     stays responsive; see init-mcp-only.test.ts for the rationale.
 *   - Hermetic env: DATABASE_URL / GBRAIN_DATABASE_URL /
 *     GBRAIN_REMOTE_CLIENT_SECRET are ALWAYS stripped (a dev shell's ambient
 *     Postgres URL or remote secret must never reach a test child), the real
 *     CLI is spawned with `--no-env-file` so a repo-root .env cannot
 *     re-inject what the strip removed, and GBRAIN_SKIP_STARTUP_HOOKS=1 so no
 *     detached check-update child leaks past the test (override via opts.env
 *     if a test needs the hooks). Provider keys (OPENAI_/ANTHROPIC_API_KEY)
 *     are NOT stripped here — the bunfig provider-keys preload already scrubs
 *     them from the test process, so children inherit the scrubbed set;
 *     strip per-call via opts.env when a test re-injects them.
 *   - `opts.home` sets BOTH HOME and GBRAIN_HOME so the child cannot read or
 *     clobber the operator's real ~/.gbrain.
 *   - The DIRECT child is reaped: timeout sends SIGTERM, escalates to SIGKILL
 *     +2s later, and the result always awaits `exited`. Grandchildren the CLI
 *     forks are NOT swept — a caller whose CLI spawns heavy subprocesses
 *     should assert on their completion, not rely on the timeout kill.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliSpawnOpts {
  /** Merged over the hermetic base env; `undefined` value deletes the key. */
  env?: Record<string, string | undefined>;
  /** Child working directory. Default: repo root. */
  cwd?: string;
  /** Sets HOME and GBRAIN_HOME in the child. */
  home?: string;
  /** SIGTERM the child after this long (SIGKILL +2s later). Default 60000. */
  timeoutMs?: number;
}

/**
 * Locate the repo root by walking up until `src/cli.ts` exists — never
 * hardcode a `../..` depth (survives this helper moving directories).
 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'src', 'cli.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cli-spawn: no src/cli.ts found in any ancestor of ${from}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(import.meta.dir);
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.ts');

/**
 * Test seam: replaces the `[process.execPath, CLI_PATH]` command prefix so
 * cli-spawn's own unit tests can exercise pool/timeout/env behavior against a
 * tiny `bun -e` fixture instead of booting the real CLI (~1.5GB PGLite).
 * Pass null to restore the real CLI. Reset in afterEach — module-global.
 */
let spawnTargetOverride: readonly string[] | null = null;

export function _setSpawnTarget(cmd: readonly string[] | null): void {
  spawnTargetOverride = cmd;
}

function buildEnv(opts?: CliSpawnOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  if (opts?.home !== undefined) {
    env.HOME = opts.home;
    env.GBRAIN_HOME = opts.home;
  }
  if (opts?.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

// Wrapper exists so `Child` is the exact inferred Subprocess specialization
// (stdout/stderr typed as ReadableStream) without naming Bun generics.
function spawnChild(cmd: string[], env: Record<string, string>, cwd: string) {
  return Bun.spawn({ cmd, env, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
}
type Child = ReturnType<typeof spawnChild>;

async function spawnOnce(
  args: string[],
  opts: CliSpawnOpts | undefined,
  onSpawn?: (proc: Child) => void,
  onSettle?: (proc: Child) => void,
): Promise<CliResult> {
  // --no-env-file: bun auto-loads a repo-root .env into the child, which
  // would re-inject the exact vars buildEnv() strips (a dev .env defining
  // GBRAIN_DATABASE_URL un-hermeticizes every consumer). The wrapper this
  // helper replaced passed the flag for the same reason.
  const prefix = spawnTargetOverride ?? [process.execPath, '--no-env-file', CLI_PATH];
  const proc = spawnChild([...prefix, ...args], buildEnv(opts), opts?.cwd ?? REPO_ROOT);
  onSpawn?.(proc);
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const term = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  // A child that ignores SIGTERM would hang the suite; escalate.
  const hardKill = setTimeout(() => {
    try { proc.kill(9); } catch { /* already exited */ }
  }, timeoutMs + 2_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Bun types `exited` as Promise<number>, but a signal-killed child's
    // code is runtime-defined; coerce a hypothetical null to -1 so
    // CliResult.exitCode is always a number (and never 0 on timeout).
    return { stdout, stderr, exitCode: exitCode ?? -1 };
  } catch (err) {
    // A rejected pipe read exits Promise.all BEFORE proc.exited — without
    // this, the finally below would clear both kill timers on a still-running
    // child and break the reap guarantee.
    try { proc.kill(9); } catch { /* already exited */ }
    await proc.exited.catch(() => {});
    throw err;
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
    onSettle?.(proc);
  }
}

/**
 * Spawn `bun src/cli.ts <args>` once. Never throws on nonzero exit — the
 * exit code is data (assert on it). Throws only when the spawn itself fails
 * (missing executable) — see runCliBatch for the reap guarantee there.
 */
export async function runCli(args: string[], opts?: CliSpawnOpts): Promise<CliResult> {
  return spawnOnce(args, opts);
}

/**
 * Run many CLI invocations through a bounded-concurrency pool, results in
 * INPUT order regardless of completion order.
 *
 * DEFAULT WIDTH 2 — do not raise casually. The cap is per-invocation: the
 * parallel runner puts 4 shards on one machine, so 4 shards x width
 * multiplies CLI children machine-wide, and each child can boot a ~1.5GB
 * PGLite. Keep 2 unless the file is alone in a lane.
 *
 * If any spawn throws, all still-running children are killed and awaited
 * (reaped — no orphans) before the error propagates.
 */
export async function runCliBatch(
  argvs: string[][],
  opts?: CliSpawnOpts & { width?: number },
): Promise<CliResult[]> {
  const width = Math.max(1, Math.floor(opts?.width ?? 2));
  const results: CliResult[] = new Array(argvs.length);
  const live = new Set<Child>();
  let aborted = false;
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) return;
      const i = next;
      next += 1;
      if (i >= argvs.length) return;
      results[i] = await spawnOnce(
        argvs[i],
        opts,
        p => live.add(p),
        p => live.delete(p),
      );
    }
  }

  const workers = Array.from({ length: Math.min(width, argvs.length) }, () => worker());
  try {
    await Promise.all(workers);
  } catch (err) {
    aborted = true;
    for (const p of live) {
      try { p.kill(); } catch { /* already exited */ }
    }
    // Wait for every worker to settle (a sibling may have spawned between
    // the sweep above and its abort check), then sweep + reap once more.
    await Promise.allSettled(workers);
    for (const p of live) {
      try { p.kill(); } catch { /* already exited */ }
    }
    await Promise.allSettled([...live].map(p => p.exited));
    throw err;
  }
  return results;
}

// Keyed on (argv, home) ONLY — env/cwd/timeout differences do NOT miss.
const memo = new Map<string, Promise<CliResult>>();

/**
 * Memoized runCli for PURE READ-ONLY invocations (`--help`, `--tools-json`,
 * `--version`) that many tests repeat verbatim. A hit returns the identical
 * CliResult object without respawning. Never use for anything that touches
 * the brain or depends on opts.env — the key is argv + home only. Failed
 * spawns are evicted so an error isn't cached.
 */
export function runCliMemo(args: string[], opts?: CliSpawnOpts): Promise<CliResult> {
  if (opts?.env !== undefined || opts?.cwd !== undefined) {
    // The memo key is argv+home+timeout ONLY — an env/cwd-varying call served
    // from cache would silently return a result produced under different inputs.
    throw new Error('runCliMemo: opts.env/opts.cwd are not part of the memo key — use runCli');
  }
  const key = JSON.stringify([args, opts?.home ?? null, opts?.timeoutMs ?? null]);
  const hit = memo.get(key);
  if (hit) return hit;
  // Freeze the settled result: hits share ONE object across test files in the
  // same shard process — a caller mutating it would poison later consumers.
  // Nonzero exits (including timeout kills, exitCode -1/143) are EVICTED after
  // being returned to the caller that triggered them — one overloaded-machine
  // timeout must not poison every later identical assertion in the shard.
  const p = runCli(args, opts).then(r => {
    if (r.exitCode !== 0) memo.delete(key);
    return Object.freeze(r) as CliResult;
  });
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

export function clearCliMemo(): void {
  memo.clear();
}
