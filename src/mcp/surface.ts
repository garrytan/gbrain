/**
 * MEMORY_VERBS v1 — MCP tool-surface modes (Cathedral 1).
 *
 *   'full'  (default) — every operation, verbs included. Existing installs
 *                       see no change; e2e tool-count assertions hold.
 *   'verbs'           — EXACTLY the five frozen protocol verbs (ops marked
 *                       `verb: true`). The quickstart surface: agents see
 *                       recall/remember/entity/synthesize/forget and nothing
 *                       else.
 *
 * Enforcement is two-layer and fail-closed: ListTools advertises the filtered
 * set, AND dispatchToolCall receives the same set as `allowedOps` so a hidden
 * op stays uncallable even if a client guesses its name (tool-list filtering
 * alone leaves dispatch resolving the global catalog — codex c2).
 *
 * Resolution: --surface flag > config `mcp_surface` > 'full'. Why default
 * full: verbs is for agents and quickstarts; full preserves existing advanced
 * tooling.
 */

import type { Operation } from '../core/operations.ts';
import type { GBrainConfig } from '../core/config.ts';

export type McpSurface = 'verbs' | 'full';

export function isMcpSurface(v: unknown): v is McpSurface {
  return v === 'verbs' || v === 'full';
}

/** Strict flag parser — unknown values reject loudly (parseStdioIdleTimeout pattern). */
export function parseSurfaceFlag(args: string[]): McpSurface | null {
  const idx = args.indexOf('--surface');
  if (idx < 0) return null;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`--surface requires a value: verbs | full`);
  }
  if (!isMcpSurface(raw)) {
    throw new Error(`Unknown --surface "${raw}". Use: verbs (the 5 memory verbs) | full (all operations, default)`);
  }
  return raw;
}

/** Flag > config `mcp_surface` > 'full'. */
export function resolveSurface(
  flag: McpSurface | null,
  config: Pick<GBrainConfig, 'mcp_surface'> | null | undefined,
): McpSurface {
  if (flag) return flag;
  if (config && isMcpSurface(config.mcp_surface)) return config.mcp_surface;
  return 'full';
}

export function filterOpsForSurface(ops: Operation[], surface: McpSurface): Operation[] {
  if (surface === 'full') return ops;
  return ops.filter(op => op.verb === true);
}

/** The fail-closed allow-set handed to dispatchToolCall. */
export function allowedOpNames(ops: Operation[], surface: McpSurface): ReadonlySet<string> {
  return new Set(filterOpsForSurface(ops, surface).map(o => o.name));
}
