/**
 * Row shape for `search`/`query` results served to remote MCP callers.
 *
 * Remote callers get lean rows by default (the projection lives in
 * src/core/search/lean-rows.ts). Two host-side escape hatches restore full
 * rows without any change on the client: the `mcp.result_rows: full` host
 * config (every remote caller), and the `X-Gbrain-Client` header foresights's own
 * thin client sends (src/core/mcp-client.ts), so the CLI's renderers and
 * `--explain` keep every field. A caller can also pass `fields: "full"`.
 *
 * The header is unverified: any HTTP client can send it. It selects a row
 * shape and nothing else; it must never gate authority, scope, visibility or
 * any other security-relevant decision.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';

export type ResultRowsMode = 'lean' | 'full';

/** HTTP header foresights's thin client sends on every request: `gbrain-remote-cli/<version>`. */
export const GBRAIN_CLIENT_HEADER = 'X-Gbrain-Client';
export const GBRAIN_THIN_CLIENT_NAME = 'gbrain-remote-cli';

export function parseResultRowsMode(v: unknown): ResultRowsMode | null {
  return v === 'lean' || v === 'full' ? v : null;
}

/** True when an `X-Gbrain-Client` header value names foresights's thin client. */
export function isGbrainThinClient(header: string | null | undefined): boolean {
  return typeof header === 'string'
    && (header === GBRAIN_THIN_CLIENT_NAME || header.startsWith(`${GBRAIN_THIN_CLIENT_NAME}/`));
}

/**
 * Dual-plane `mcp.result_rows`: the DB plane wins, the file plane is the
 * fallback, absent or unparseable on both = 'lean'. A failed DB read falls to
 * the file plane; resolving a row shape never takes a request down.
 */
export async function resolveResultRowsMode(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
): Promise<ResultRowsMode> {
  try {
    const dbMode = parseResultRowsMode(await engine.getConfig('mcp.result_rows'));
    if (dbMode) return dbMode;
  } catch {
    // Engine without a config table / transient error: the file plane decides.
  }
  return parseResultRowsMode(config?.mcp?.result_rows) ?? 'lean';
}

/** The row shape for one HTTP request: the thin-client header wins, then the host mode. */
export function resultRowsForRequest(clientHeader: string | null | undefined, hostMode: ResultRowsMode): ResultRowsMode {
  return isGbrainThinClient(clientHeader) ? 'full' : hostMode;
}
