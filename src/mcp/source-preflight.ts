import type { BrainEngine } from '../core/engine.ts';

/**
 * Stdio-lane preflight: a well-formed `GBRAIN_SOURCE` that names NO registered
 * source must not serve.
 *
 * Why: `resolveMcpStdioSourceScope` deliberately
 * passes a well-formed-but-unknown env value through as tier 'env' so the
 * opt-in `--source-guard` can produce its actionable envelope. Without the
 * flag, nothing catches it: every read scopes to a source that holds zero
 * pages (search/query return `[]` even with `__all__`) and every write dies
 * on `facts_source_id_fkey`. A stale `GBRAIN_SOURCE=workspace` in a harness
 * MCP config blinded the Claude Code lane for a week while every health check
 * stayed green. Fail loudly at startup instead.
 *
 * Scope: only the stdio server calls this. HTTP tokens carry their own
 * source grant. `__all__` and malformed values keep their existing handling
 * (malformed already falls back to the seed tier in the resolver).
 * A transient engine error does NOT block startup — this guards config, not
 * connectivity.
 */
export async function assertStdioSourceBindable(
  engine: BrainEngine,
  env: string | undefined = process.env.GBRAIN_SOURCE,
): Promise<void> {
  if (!env) return;
  const { isValidSourceId, ALL_SOURCES } = await import('../core/source-id.ts');
  if (env === ALL_SOURCES || !isValidSourceId(env)) return;
  let rows: Array<{ id: string }>;
  try {
    rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [env]);
  } catch {
    return;
  }
  if (rows.length === 0) {
    throw new Error(
      `GBRAIN_SOURCE="${env}" is not a registered source; refusing to serve a phantom scope ` +
      `(reads would return nothing, writes would fail on the sources foreign key). ` +
      `Run \`gbrain sources list\`, then set GBRAIN_SOURCE to a listed id or unset it.`,
    );
  }
}
