import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId, ALL_SOURCES } from '../core/source-id.ts';
import { isEngineDegraded } from '../core/degraded-marker.ts';

/**
 * Stdio-lane preflight: a well-formed `GBRAIN_SOURCE` that names NO active
 * registered source must not serve.
 *
 * Why: `resolveMcpStdioSourceScope` deliberately passes a well-formed-but-
 * unknown env value through as tier 'env' so the opt-in `--source-guard` can
 * produce its actionable envelope. Without the flag, nothing catches it:
 * every read scopes to a source that holds zero pages (search/query return
 * `[]` even with `__all__`) and every write dies on `facts_source_id_fkey`.
 * A stale `GBRAIN_SOURCE` in a harness MCP config blinds the whole lane
 * while every health check stays green. Fail loudly at startup instead —
 * the same posture the CLI env tier already takes (`assertSourceExists` in
 * source-resolver.ts, whose `archived = false` predicate this mirrors).
 *
 * Scope: only the stdio server calls this. HTTP tokens carry their own
 * source grant. `__all__` and malformed values keep their existing handling
 * (malformed already falls back to the seed tier in the resolver).
 * A transient engine error does NOT block startup — this guards config, not
 * connectivity — and a degraded engine is never touched, so a boot under
 * the degraded proxy does not spend its reconnect attempt here.
 */
export async function assertStdioSourceBindable(
  engine: BrainEngine,
  env: string | undefined = process.env.GBRAIN_SOURCE,
): Promise<void> {
  if (!env) return;
  if (env === ALL_SOURCES || !isValidSourceId(env)) return;
  if (isEngineDegraded(engine)) return;
  let rows: Array<{ id: string }>;
  try {
    rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1 AND archived = false`,
      [env],
    );
  } catch (e) {
    // Fail-open by design (this guards config, not connectivity) — but never
    // silently: an operator debugging a blind stdio lane needs to know the
    // preflight did not run.
    process.stderr.write(
      `[gbrain] GBRAIN_SOURCE preflight skipped (could not read sources): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return;
  }
  if (rows.length === 0) {
    throw new Error(
      `GBRAIN_SOURCE="${env}" is not a registered active source (missing or archived); ` +
      `refusing to serve a phantom scope (reads would return nothing, writes would fail ` +
      `on the sources foreign key). Run \`gbrain sources list\`, then set GBRAIN_SOURCE ` +
      `to a listed id or unset it.`,
    );
  }
}
