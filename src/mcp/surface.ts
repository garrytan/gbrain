/**
 * MEMORY_VERBS v1 + WP4 — MCP tool-surface modes.
 *
 *   'full'    (default) — every operation, verbs included. Existing installs
 *                         see no change; e2e tool-count assertions hold.
 *   'starter'           — the ~20-op daily-driver set (STARTER_OPS below):
 *                         the seven frozen verbs + the fallback daily ops +
 *                         whoami + the request_tools discovery meta-op. The
 *                         answer to the "85-tool wall" consumer complaint.
 *   'verbs'             — EXACTLY the seven frozen protocol verbs (ops marked
 *                         `verb: true`). The quickstart surface. Its semantics
 *                         are frozen — 'starter' extends the ladder ABOVE it,
 *                         never changes it.
 *
 * Enforcement is two-layer and fail-closed: ListTools advertises the filtered
 * set, AND dispatchToolCall receives the same set as `allowedOps` so a hidden
 * op stays uncallable even if a client guesses its name (tool-list filtering
 * alone leaves dispatch resolving the global catalog — codex c2).
 *
 * Resolution: --surface flag > config `mcp_surface` > 'full'. Why default
 * full: verbs/starter are for agents and quickstarts; full preserves existing
 * advanced tooling.
 *
 * WP4 (D2 CEILING): on the OAuth HTTP transport the server-resolved surface is
 * a CEILING, not the final answer — each request resolves
 * `min(ceiling, client row surface ?? DCR/config default)` via
 * `effectiveSurfaceForClient`, recomputed per request (amendment 20).
 * `GBRAIN_MCP_FORCE_SURFACE` is the incident kill switch: it min()s in on top
 * and can NEVER widen past the configured ceiling (FOV-6a) — widening requires
 * an explicit `--surface` restart.
 */

import type { Operation } from '../core/operations.ts';
import type { GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { VERB_NAMES } from '../core/verbs.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../core/minions/tools/brain-allowlist.ts';

export type McpSurface = 'verbs' | 'starter' | 'full';

/** Widening order for the D2 ceiling math: verbs < starter < full. */
const SURFACE_RANK: Record<McpSurface, number> = { verbs: 0, starter: 1, full: 2 };

export function isMcpSurface(v: unknown): v is McpSurface {
  return v === 'verbs' || v === 'starter' || v === 'full';
}

/** The narrower of two surfaces (verbs < starter < full). */
export function minSurface(a: McpSurface, b: McpSurface): McpSurface {
  return SURFACE_RANK[a] <= SURFACE_RANK[b] ? a : b;
}

/** True when `a` is strictly wider than `b` (used for the ceiling deny). */
export function surfaceWiderThan(a: McpSurface, b: McpSurface): boolean {
  return SURFACE_RANK[a] > SURFACE_RANK[b];
}

/**
 * WP4 FOV-6b fallback for the daily-driver slice of STARTER_OPS.
 *
 * Provenance: the plan's STARTER_OPS derivation from the production
 * `mcp_request_log` histogram (30d window, keyed by token_name) had NOT
 * landed at implementation time (2026-08-13), so per FOV-6b this v1 set is
 * the fallback: the reviewed subagent brain-tool allow-list
 * (BRAIN_TOOL_ALLOWLIST — imported, never name-copied) plus the agent lane
 * (`submit_agent` / `get_agent_job`, FOV-4 — agent-scope clients must not be
 * stranded). Corrected later by `scripts/derive-starter-ops.ts` + the E3
 * advisor drift check once the histogram pull lands.
 */
const FALLBACK_DAILY_OPS: readonly string[] = [
  ...BRAIN_TOOL_ALLOWLIST,
  'submit_agent',
  'get_agent_job',
];

/**
 * The 'starter' surface membership set (WP4). Composed PROGRAMMATICALLY —
 * the verb slice is a spread of VERB_NAMES (ENG-1: post-#4028 that is SEVEN
 * verbs including context_pack/delta; never a hand-count), the daily slice
 * is the FOV-6b fallback above, plus `whoami` (identity) and `request_tools`
 * (the D4 discovery meta-op: listed on starter + full, never verbs).
 *
 * Membership is pinned by test/mcp-surface.test.ts: every name here must
 * exist in `operations`, and allowedOpNames(verbs) ⊆ starter ⊆ full holds
 * (monotonicity, ENG-1).
 */
export const STARTER_OPS: ReadonlySet<string> = new Set([
  ...VERB_NAMES,
  ...FALLBACK_DAILY_OPS,
  'whoami',
  'request_tools',
  // [EV8] capture joins as a DIRECT literal — deliberately NOT via
  // BRAIN_TOOL_ALLOWLIST (that would grant every minion subagent a new write
  // tool and require the skillopt mutating-exclusion update). The plugin +
  // starter connect lanes retire the "unknown tool: capture" FAQ, which only
  // works if the starter surface actually lists it.
  'capture',
]);

/**
 * The never-remove STARTER_OPS core: the seven frozen verbs, identity
 * (`whoami`), discovery (`request_tools`), and the agent lane
 * (`submit_agent`/`get_agent_job` — FOV-4: agent-scope clients must not be
 * stranded). Usage-driven re-derivation (`scripts/derive-starter-ops.ts`)
 * and the advisor drift check (collect-mcp-client-fit) both consume THIS
 * set so "always included" has exactly one definition.
 */
export const ALWAYS_INCLUDED_STARTER_OPS: ReadonlySet<string> = new Set([
  ...VERB_NAMES,
  'whoami',
  'request_tools',
  'submit_agent',
  'get_agent_job',
  // [EV8] capture is contract-bearing on the starter lanes (the retired FAQ
  // points agents at it) — usage-driven re-derivation must never propose
  // evicting it as a zero-usage newcomer.
  'capture',
]);

/** Strict flag parser — unknown values reject loudly (parseStdioIdleTimeout pattern). */
export function parseSurfaceFlag(args: string[]): McpSurface | null {
  const idx = args.indexOf('--surface');
  if (idx < 0) return null;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`--surface requires a value: verbs | starter | full`);
  }
  if (!isMcpSurface(raw)) {
    throw new Error(`Unknown --surface "${raw}". Use: verbs (the 7 memory verbs) | starter (the ~20 daily-driver ops) | full (all operations, default)`);
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
  // FROZEN: 'verbs' is EXACTLY `op.verb === true` (MEMORY_VERBS v1) — starter
  // extends the ladder above it and must never alter these semantics.
  if (surface === 'verbs') return ops.filter(op => op.verb === true);
  return ops.filter(op => STARTER_OPS.has(op.name));
}

/** The fail-closed allow-set handed to dispatchToolCall. */
export function allowedOpNames(ops: Operation[], surface: McpSurface): ReadonlySet<string> {
  return new Set(filterOpsForSurface(ops, surface).map(o => o.name));
}

// ---------------------------------------------------------------------------
// WP4 — kill switch + per-client (D2 ceiling) resolution
// ---------------------------------------------------------------------------

let warnedBadForceValue = false;

/**
 * `GBRAIN_MCP_FORCE_SURFACE` — incident kill switch (amendment 21,
 * env-above-config per the pace-mode precedent). NARROW-ONLY (FOV-6a):
 * consumers min() it into the resolved surface, so it can clamp a
 * misbehaving deployment down but can never widen past the configured
 * ceiling. Unknown values are ignored with a one-time warn (ignoring can
 * only leave the surface as configured — it never widens anything).
 */
export function readForceSurfaceEnv(
  warn: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): McpSurface | null {
  const raw = process.env.GBRAIN_MCP_FORCE_SURFACE;
  if (raw === undefined || raw === '') return null;
  if (isMcpSurface(raw)) return raw;
  if (!warnedBadForceValue) {
    warnedBadForceValue = true;
    warn(`[mcp] ignoring unknown GBRAIN_MCP_FORCE_SURFACE="${raw}" (use verbs | starter | full); surface stays as configured`);
  }
  return null;
}

/** min() the kill switch into a resolved surface. Narrow-only by construction. */
export function clampSurface(
  surface: McpSurface,
  warn?: (msg: string) => void,
): McpSurface {
  const force = readForceSurfaceEnv(warn);
  return force ? minSurface(surface, force) : surface;
}

// Warn-once-per-client bookkeeping for unknown oauth_clients.surface values
// (amendment 18). Bounded so attacker-controlled client ids can't grow it.
const warnedUnknownRowSurface = new Set<string>();
const WARNED_CLIENTS_CAP = 10_000;

/** Test seam: reset the warn-once caches. */
export function __resetSurfaceWarnCachesForTests(): void {
  warnedUnknownRowSurface.clear();
  warnedBadForceValue = false;
}

/**
 * Parse an `oauth_clients.surface` row value (amendment 18). The column's
 * value space is documented OPEN — deferred client tiers will write tier
 * names into this same column — so an unrecognized value is IGNORED (falls
 * back to server/config resolution) with a warn-log once per client, never
 * an auth failure.
 */
export function resolveClientRowSurface(
  raw: unknown,
  clientId: string,
  warn: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): McpSurface | null {
  if (raw === null || raw === undefined) return null;
  if (isMcpSurface(raw)) return raw;
  if (!warnedUnknownRowSurface.has(clientId)) {
    if (warnedUnknownRowSurface.size >= WARNED_CLIENTS_CAP) warnedUnknownRowSurface.clear();
    warnedUnknownRowSurface.add(clientId);
    warn(`[mcp] client ${clientId} carries unrecognized oauth_clients.surface value; ignoring it and falling back to the server/config surface (rescope with: gbrain auth rescope-client ${clientId} --surface verbs|starter|full|clear)`);
  }
  return null;
}

/**
 * Dual-plane resolution for `mcp.default_surface_dcr` — the surface applied
 * to clients whose row surface is NULL (oauth_clients carries no DCR-origin
 * marker, so the default applies to ALL null-surface clients; operators
 * pre-seed important clients with `gbrain auth rescope-client <id> --surface
 * full`). DB plane wins, file plane falls back, absent/unparseable on both =
 * null (caller falls back to the server ceiling — pre-WP4 behavior). A
 * failed DB read falls to the file plane; surface resolution must never take
 * a request down.
 */
export async function resolveDefaultClientSurface(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
): Promise<McpSurface | null> {
  try {
    const dbVal = await engine.getConfig('mcp.default_surface_dcr');
    if (isMcpSurface(dbVal)) return dbVal;
    if (dbVal != null) return null; // set but unrecognized → ignore (open value space)
  } catch {
    // Engine without a config table / transient error → file plane decides.
  }
  const fileVal = (config?.mcp as Record<string, unknown> | undefined)?.default_surface_dcr;
  return isMcpSurface(fileVal) ? fileVal : null;
}

/**
 * D2 CEILING resolution — the per-request effective surface on the OAuth
 * HTTP transport:
 *
 *     effective = clamp(min(server ceiling, client row surface ?? default ?? ceiling))
 *
 * where `clamp` folds in the GBRAIN_MCP_FORCE_SURFACE kill switch
 * (narrow-only, FOV-6a). A verbs-pinned server with a `full` client row
 * still serves verbs (pinned by test); a client can request a narrower
 * surface than the ceiling and get it.
 */
export function effectiveSurfaceForClient(opts: {
  ceiling: McpSurface;
  /** Parsed row value (resolveClientRowSurface); null = no per-client surface. */
  clientSurface: McpSurface | null;
  /** mcp.default_surface_dcr resolution; null = unset (fall back to ceiling). */
  defaultSurface: McpSurface | null;
  warn?: (msg: string) => void;
}): McpSurface {
  const requested = opts.clientSurface ?? opts.defaultSurface ?? opts.ceiling;
  return clampSurface(minSurface(opts.ceiling, requested), opts.warn);
}
