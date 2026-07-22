/**
 * In-process migration helpers (v0.41.37.0 #1605).
 *
 * Why this exists: migration schema phases used to shell out to a child
 * `gbrain init --migrate-only` via `execSync`. On Windows + bun + Supabase
 * pooler, the spawned CHILD process dies with `getaddrinfo ENOTFOUND` before it
 * can connect — even though the PARENT connects fine and `env: process.env` is
 * passed. It is a bun-on-Windows child-process DNS-resolution failure, not an
 * env-propagation bug. The only robust fix is to not spawn at all: run the
 * schema bring-up IN-PROCESS. The PGLite path at v0_11_0.ts already proved the
 * pattern; this generalizes it to every engine + every schema phase.
 *
 * `runMigrateOnlyCore` is the single source of truth for "bring schema to head"
 * — `init.ts:initMigrateOnly` (the `gbrain init --migrate-only` CLI path) and
 * the migration orchestrators both call it, so the configureGateway-before-
 * initSchema fix can't drift between them.
 *
 * `runGbrainSubprocess` is the diagnostic wrapper for the REMAINING (non-schema)
 * gbrain-subprocess spawns (extract/repair/stats). It captures child stderr and
 * folds it into the thrown error so a Windows failure shows the real
 * `getaddrinfo ENOTFOUND` line instead of the bare `Command failed: ...`.
 */

import { execSync } from 'child_process';

import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';

/** Default wall-clock guard for in-process initSchema. Matches the 600s cap
 *  the old `execSync('gbrain init --migrate-only', { timeout: 600_000 })` used,
 *  so a hung schema bring-up surfaces as a phase failure instead of wedging
 *  the whole cascade. */
export const MIGRATE_ONLY_TIMEOUT_MS = 600_000;

/** Large stderr buffer for captured subprocess output. `execSync`'s default
 *  ~1MB maxBuffer overflows on long backfills (extract/repair) and turns a
 *  successful run into a spurious failure. */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;

export interface MigrateOnlyResult {
  /** The engine kind that was brought to head ('pglite' | 'postgres'). */
  engine: string;
}

export class MigrateOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrateOnlyError';
  }
}

/**
 * Bring the configured brain's schema to head, in-process. Mirrors what
 * `gbrain init --migrate-only` did via subprocess: configureGateway →
 * createEngine → connect → initSchema → disconnect. Idempotent (initSchema is
 * a no-op when already at head). Throws `MigrateOnlyError` on no-config or
 * timeout so callers report a failed phase rather than hanging.
 */
export async function runMigrateOnlyCore(opts?: { timeoutMs?: number }): Promise<MigrateOnlyResult> {
  const config = loadConfig();
  if (!config) {
    throw new MigrateOnlyError(
      'No brain configured. Run `gbrain init` (interactive) or `gbrain init --pglite` / `gbrain init --supabase` first.',
    );
  }

  // configureGateway BEFORE initSchema (init.ts B.3): a schema bump on a brain
  // whose file config is missing embedding fields must not fall through to
  // stale hardcoded fallbacks. loadConfig already merged env; propagate it.
  const { configureGateway } = await import('../../core/ai/gateway.ts');
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    env: { ...process.env },
  });

  const timeoutMs = opts?.timeoutMs ?? MIGRATE_ONLY_TIMEOUT_MS;
  const engine = await createEngine(toEngineConfig(config));
  try {
    await engine.connect(toEngineConfig(config));
    await withTimeout(
      engine.initSchema(),
      timeoutMs,
      `schema init timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }

  return { engine: config.engine };
}

/**
 * Run a `gbrain ...` subcommand as a subprocess, capturing child stderr so a
 * failure surfaces the real reason. Used for the non-schema backfill phases
 * (extract/repair/stats) that aren't yet in-process. On Windows these may still
 * fail with `getaddrinfo ENOTFOUND`, but the operator now sees WHY instead of a
 * bare `Command failed`. Returns captured stdout (utf-8) on success.
 *
 * Note: stderr is piped (captured), so gbrain progress lines (which go to
 * stderr) are not shown live during these phases — acceptable for a one-shot
 * `apply-migrations` run; the failure reason matters more than live progress.
 */
export function runGbrainSubprocess(cmd: string, opts?: { timeoutMs?: number }): string {
  try {
    const out = execSync(cmd, {
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? MIGRATE_ONLY_TIMEOUT_MS,
      env: process.env,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      encoding: 'utf-8',
    });
    return typeof out === 'string' ? out : '';
  } catch (e: unknown) {
    const err = e as { message?: string; stderr?: Buffer | string };
    const stderrRaw = err?.stderr
      ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf-8') : String(err.stderr))
      : '';
    const tail = stderrRaw.split('\n').filter(Boolean).slice(-10).join('\n');
    const base = err?.message ?? String(e);
    throw new Error(tail ? `${base}\n--- child stderr (tail) ---\n${tail}` : base);
  }
}

/** Reject `p` if it doesn't settle within `ms`. The original promise keeps
 *  running (best-effort) but the caller sees a clear timeout error. */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MigrateOnlyError(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
