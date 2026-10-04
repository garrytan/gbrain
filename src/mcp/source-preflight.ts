import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId, ALL_SOURCES } from '../core/source-id.ts';
import { isEngineDegraded } from '../core/degraded-marker.ts';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';

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
 * source grant. `__all__` warns without changing its fail-closed scope;
 * malformed values still fall back to the seed tier in the resolver.
 * A transient engine error does NOT block startup — this guards config, not
 * connectivity — and a degraded engine is never touched, so a boot under
 * the degraded proxy does not spend its reconnect attempt here.
 */
export async function assertStdioSourceBindable(
  engine: BrainEngine,
  env: string | undefined = process.env.GBRAIN_SOURCE,
): Promise<void> {
  if (!env) return;
  if (env === ALL_SOURCES) {
    process.stderr.write(
      '[gbrain] GBRAIN_SOURCE=__all__ does not grant all-source access to stdio MCP; ' +
      'this binding remains fail-closed and reads return no results. In the MCP server environment, ' +
      'set GBRAIN_SOURCE to a registered source id, or remove it to use normal source resolution ' +
      '(not unrestricted access), then restart the server. ' +
      'See docs/mcp/DEPLOY.md#stdio-source-binding.\n',
    );
    return;
  }
  if (!isValidSourceId(env)) return;
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
    throw opError('unknown_source',
      `GBRAIN_SOURCE="${env}" is not a registered active source (missing or archived); ` +
      `refusing to serve a phantom scope (reads would return nothing, writes would fail ` +
      `on the sources foreign key). Run \`gbrain sources list\`, then set GBRAIN_SOURCE ` +
      `to a listed id or unset it.`,
      'Set GBRAIN_SOURCE to an id that `gbrain sources list` shows (or unset it) in the environment that launches this MCP server, then restart it.',
      { fix: { ...readFix('Lists the registered sources so GBRAIN_SOURCE can name one.', { argv: ['gbrain', 'sources', 'list'] }), actor: 'user',
        user_message: 'The MCP server is bound to a source that does not exist. Please set GBRAIN_SOURCE to one of the ids `gbrain sources list` prints, or unset it, and restart the server.' } });
  }
}
