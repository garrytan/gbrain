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
 * Resolution: stdio GBRAIN_SURFACE > --surface flag > config `mcp_surface` >
 * 'full' (resolveStdioSurface); `serve --http` ignores GBRAIN_SURFACE. Why
 * default full: a bare `serve` keeps existing advanced tooling; the
 * registrations gbrain writes pin `starter` (src/core/mcp-registration.ts).
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
import type { Notice } from '../core/agent-output.ts';
import type { GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { VERB_NAMES } from '../core/verbs.ts';
import { opError } from '../core/ops/contract.ts';
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
  'cancel_job',
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
  // #5616: the small-change companion of put_page (a direct literal, like
  // capture, so subagents do not gain a new write tool).
  'edit_page',
  'get_write_request', 'list_write_requests', 'cancel_write_request',
  'list_skills', 'get_skill', 'list_brain_skillpack', 'get_skill_asset',
  'join_brain', 'sync_brain_skills', 'leave_brain', 'put_skill', 'delete_skill',
  // The dismissal for the coaching notices starter sessions receive (onboarding, features).
  'mute_notice',
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
  'get_write_request', 'list_write_requests', 'cancel_write_request',
  'list_skills', 'get_skill', 'list_brain_skillpack', 'get_skill_asset',
  'join_brain', 'sync_brain_skills', 'leave_brain', 'put_skill', 'delete_skill',
]);

/** Strict flag parser — unknown values reject loudly (parseStdioIdleTimeout pattern). */
export function parseSurfaceFlag(args: string[]): McpSurface | null {
  const idx = args.indexOf('--surface');
  if (idx < 0) return null;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw opError('invalid_params', `--surface requires a value: verbs | starter | full`, 'Pass --surface verbs, --surface starter or --surface full (default full).');
  }
  if (!isMcpSurface(raw)) {
    throw opError('invalid_params', `Unknown --surface "${raw}". Use: verbs (the 7 memory verbs) | starter (the ~20 daily-driver ops) | full (all operations, default)`,
      'Pass --surface verbs (the 7 memory verbs), --surface starter (the ~20 daily-driver ops) or --surface full (all operations, default).');
  }
  return raw;
}

/**
 * #4768: stdio access ceiling. `--access read-only` intersects the selected
 * surface with operations that are read-scoped, non-mutating and need no
 * capability scope, so tools/list, the capabilities resource, skill
 * resources and dispatch all see one read-only set (`request_tools` is
 * mutating, so discovery cannot widen it). It denies agent-requested
 * mutations; owner maintenance (startup migrations, hook IPC banking) is a
 * separate control. HTTP enforces per-token operation grants instead.
 */
export type McpAccess = 'full' | 'read-only';

export function parseAccessFlag(args: string[]): McpAccess {
  const idx = args.indexOf('--access');
  if (idx < 0) return 'full';
  const raw = args[idx + 1];
  if (raw !== 'full' && raw !== 'read-only') {
    throw opError('invalid_params', '--access takes read-only or full (default full); see docs/mcp/ADMIN.md#read-only-stdio-serve',
      'Pass --access read-only or --access full (default full).', { docs: 'docs/mcp/ADMIN.md#read-only-stdio-serve' });
  }
  return raw;
}

export function isReadOnlyOperation(op: Pick<Operation, 'scope' | 'mutating' | 'requiredScopes'>): boolean {
  return op.scope === 'read' && op.mutating !== true && !op.requiredScopes?.length;
}

export type SurfaceSource = 'env' | 'flag' | 'config' | 'default';

/** How `serve` prints and `whoami` reports a surface source. */
export const SURFACE_SOURCE_LABEL: Record<SurfaceSource, string> = {
  env: 'env GBRAIN_SURFACE', flag: '--surface', config: 'config', default: 'default',
};

/** --surface flag > config `mcp_surface` > 'full', with where the answer came from. */
export function resolveSurfaceWithSource(
  flag: McpSurface | null,
  config: Pick<GBrainConfig, 'mcp_surface'> | null | undefined,
): { surface: McpSurface; source: SurfaceSource; invalidEnv?: string } {
  if (flag) return { surface: flag, source: 'flag' };
  if (config && isMcpSurface(config.mcp_surface)) return { surface: config.mcp_surface, source: 'config' };
  return { surface: 'full', source: 'default' };
}

/** Flag > config `mcp_surface` > 'full' (`serve --http`; stdio adds GBRAIN_SURFACE via resolveStdioSurface). */
export function resolveSurface(
  flag: McpSurface | null,
  config: Pick<GBrainConfig, 'mcp_surface'> | null | undefined,
): McpSurface {
  return resolveSurfaceWithSource(flag, config).surface;
}

/**
 * Stdio `serve`: GBRAIN_SURFACE > --surface > config `mcp_surface` > 'full',
 * the plugin launcher's substitute-or-append semantics. An invalid env value
 * never stops the server (that would end it before the handshake, where no
 * agent sees it): it is ignored and returned as `invalidEnv`.
 */
export function resolveStdioSurface(
  flag: McpSurface | null,
  config: Pick<GBrainConfig, 'mcp_surface'> | null | undefined,
  env: string | undefined = process.env.GBRAIN_SURFACE,
): { surface: McpSurface; source: SurfaceSource; invalidEnv?: string } {
  if (env === undefined || env === '') return resolveSurfaceWithSource(flag, config);
  if (isMcpSurface(env)) return { surface: env, source: 'env' };
  return { ...resolveSurfaceWithSource(flag, config), invalidEnv: env };
}

export function filterOpsForSurface(ops: Operation[], surface: McpSurface): Operation[] {
  if (surface === 'full') return ops;
  // FROZEN: 'verbs' is EXACTLY `op.verb === true` (MEMORY_VERBS v1) — starter
  // extends the ladder above it and must never alter these semantics.
  if (surface === 'verbs') return ops.filter(op => op.verb === true);
  return ops.filter(op => STARTER_OPS.has(op.name)).map(starterParams);
}

/** Starter ops advertise every param except the full-surface-only ones. */
function starterParams(op: Operation): Operation {
  if (!Object.values(op.params).some(p => p.fullSurfaceOnly)) return op;
  return { ...op, params: Object.fromEntries(Object.entries(op.params).filter(([, p]) => !p.fullSurfaceOnly)) };
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
 * `mcp.advertised_surface`: which tools `tools/list` shows. The callable set
 * (the ceiling: --surface > mcp_surface > full, per-client rows on HTTP) is
 * unchanged, so a tool outside the advertised list is still callable and
 * `request_tools` returns its schema. The ceiling stays the security boundary;
 * the advertised list is a context-cost choice. DB plane wins, file plane
 * falls back; unset or unrecognized = advertise the whole callable set.
 */
export async function resolveAdvertisedSurface(engine: BrainEngine | null, config: GBrainConfig | null | undefined): Promise<McpSurface | null> {
  if (engine) {
    try {
      const dbVal = await engine.getConfig('mcp.advertised_surface');
      if (isMcpSurface(dbVal)) return dbVal;
      if (dbVal != null) return null;
    } catch { /* file plane decides */ }
  }
  const fileVal = (config?.mcp as Record<string, unknown> | undefined)?.advertised_surface;
  return isMcpSurface(fileVal) ? fileVal : null;
}

/** The tools to list: the callable set narrowed to the advertised surface (never wider). */
export function advertisedOps<T extends Operation>(callable: T[], callableSurface: McpSurface, advertised: McpSurface | null): T[] {
  if (!advertised || !surfaceWiderThan(callableSurface, advertised)) return callable;
  const listed = new Set(filterOpsForSurface(callable as Operation[], advertised).map(op => op.name));
  return callable.filter(op => listed.has(op.name));
}

/**
 * A stdio session's tool listing: the advertised surface, plus every tool
 * `request_tools` described in this session (`reveal`), which notifies the
 * client with tools/list_changed. Once the session widens (request_tools
 * {surface}), the whole widened surface is listed. `mcp.advertised_surface` narrows only this
 * listing; dispatch keeps the callable set.
 */
export function stdioToolListing(advertised: () => Promise<McpSurface | null>, session: { readonly surface: McpSurface },
  server: { sendToolListChanged(): Promise<void> }) {
  const revealed = new Set<string>();
  const startSurface = session.surface;
  const notify = () => { Promise.resolve(server.sendToolListChanged()).catch(() => { /* best-effort */ }); };
  return {
    async listed<T extends Operation>(visible: T[]): Promise<T[]> {
      // A session the agent widened with request_tools {surface} lists everything it asked for.
      if (session.surface !== startSurface) return visible;
      const listed = advertisedOps(visible, session.surface, await advertised());
      return listed.length === visible.length ? visible : visible.filter(op => revealed.has(op.name) || listed.includes(op));
    },
    reveal(names: string[]): void {
      const before = revealed.size;
      for (const name of names) revealed.add(name);
      if (revealed.size > before) notify();
    },
  };
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

// ---------------------------------------------------------------------------
// Stdio session surface — one mutable allow-set per stdio server process
// ---------------------------------------------------------------------------

/**
 * The stdio session's surface: tools/list, dispatch, the capabilities
 * resource and `whoami` read the same object, so a `request_tools` widen is
 * visible to all of them at once. Widening is session-scoped (nothing is
 * written) and never passes `--access read-only`.
 */
export interface StdioSurfaceState {
  surface: McpSurface;
  readonly source: SurfaceSource;
  readonly readOnly: boolean;
  /** `mcp.allow_session_widen` as last resolved (boot, then each request_tools call). */
  widenAllowed: boolean;
  surfacedOps: Operation[];
  allowedOps: ReadonlySet<string> | undefined;
  widen(to: McpSurface): { from: McpSurface; to: McpSurface; added: string[] };
}

export function createStdioSurfaceState(
  ops: Operation[],
  init: { surface: McpSurface; source: SurfaceSource; readOnly: boolean; onWiden?: (change: { from: McpSurface; to: McpSurface; added: string[] }) => void },
): StdioSurfaceState {
  const compute = (surface: McpSurface) => {
    const surfacedOps = filterOpsForSurface(ops, surface).filter(op => !init.readOnly || isReadOnlyOperation(op));
    const allowedOps = init.readOnly ? new Set(surfacedOps.map(op => op.name)) : surface === 'full' ? undefined : allowedOpNames(ops, surface);
    return { surface, surfacedOps, allowedOps };
  };
  const state: StdioSurfaceState = {
    source: init.source,
    readOnly: init.readOnly,
    widenAllowed: true,
    ...compute(init.surface),
    widen(to) {
      const from = state.surface;
      const before = new Set(state.surfacedOps.map(op => op.name));
      Object.assign(state, compute(to));
      const change = { from, to, added: state.surfacedOps.filter(op => !before.has(op.name)).map(op => op.name) };
      init.onWiden?.(change);
      return change;
    },
  };
  return state;
}

/** `mcp.allow_session_widen` (default true): DB plane, then the file plane (file only when `engine` is null). */
export async function sessionWidenAllowed(engine: BrainEngine | null, config: GBrainConfig | null | undefined): Promise<boolean> {
  const off = (v: unknown) => v === false || (typeof v === 'string' && /^(false|0|off|no)$/i.test(v.trim()));
  try {
    const dbVal = engine ? await engine.getConfig('mcp.allow_session_widen') : null;
    if (dbVal != null) return !off(dbVal);
  } catch { /* the file plane decides */ }
  return !off(config?.mcp?.allow_session_widen);
}

/** The once-per-process `surface_env_invalid` info notice for an ignored GBRAIN_SURFACE value. */
export function surfaceEnvInvalidNotice(raw: string, served: McpSurface, source: SurfaceSource): Notice {
  return {
    code: 'surface_env_invalid', kind: 'info',
    why: `GBRAIN_SURFACE="${raw}" is not a tool surface (use verbs, starter or full), so this server ignored it and serves '${served}' (source: ${SURFACE_SOURCE_LABEL[source]}).`,
    user_message: `The gbrain MCP server's GBRAIN_SURFACE setting ("${raw}") is not valid; it takes verbs, starter or full. Can you fix it in the env of your agent app's MCP server entry for gbrain?`,
  };
}
