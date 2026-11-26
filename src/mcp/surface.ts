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
 * default full: a bare `serve` keeps existing advanced tooling, and the
 * registrations gbrain writes pin their harness's `registrationProfile`
 * (src/core/mcp-registration.ts) unless the user passes `--surface`.
 *
 * WP4 (D2 CEILING): on the OAuth HTTP transport the server-resolved surface is
 * a CEILING, not the final answer — each request resolves
 * `min(ceiling, client row surface ?? DCR/config default)` via
 * `effectiveSurfaceForClient`, recomputed per request (amendment 20).
 * `GBRAIN_MCP_FORCE_SURFACE` is the incident kill switch: it min()s in on top
 * and can NEVER widen past the configured ceiling (FOV-6a) — widening requires
 * an explicit `--surface` restart.
 */

import type { OperationMeta, ParamDef } from '../core/ops/contract.ts';
import type { Notice } from '../core/agent-output.ts';
import type { GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { VERB_NAMES } from '../core/verbs.ts';
import { opError } from '../core/ops/contract.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../core/minions/tools/brain-tool-allowlist.ts';
import { flagValues } from '../core/direct-pool-profile.ts';
import { SUBMIT_AGENT_DEFAULT_MAX_TURNS } from '../core/ops/jobs.ts';
import { sessionWidenOff } from '../core/mcp-registration.ts';

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
  // GBRA-219: the per-conversation memory switch rides next to remember.
  'memory_conversation_mode',
  // Agent platform H1: "what's at risk at home" is a daily-driver read (a direct literal, so subagents gain nothing).
  'household_due',
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

/**
 * Strict flag parser — unknown values reject loudly (parseStdioIdleTimeout pattern). `--surface=verbs` is the same flag
 * (`flagValues`), and a repeated flag takes the narrowest value, so it never widens the ceiling.
 */
export function parseSurfaceFlag(args: string[]): McpSurface | null {
  const values = flagValues(args, '--surface');
  if (!values.length) return null;
  for (const raw of values) {
    if (!raw || raw.startsWith('--')) {
      throw opError('invalid_params', `--surface requires a value: verbs | starter | full`, 'Pass --surface verbs, --surface starter or --surface full (default full).');
    }
    if (!isMcpSurface(raw)) {
      throw opError('invalid_params', `Unknown --surface "${raw}". Use: verbs (the 7 memory verbs) | starter (the ~20 daily-driver ops) | full (all operations, default)`,
        'Pass --surface verbs (the 7 memory verbs), --surface starter (the ~20 daily-driver ops) or --surface full (all operations, default).');
    }
  }
  return (values as McpSurface[]).reduce(minSurface);
}

/**
 * `--advertise`: the surface tools/list shows, narrower than what is callable.
 * Registrations gbrain writes on the starter profile pass `--advertise verbs` (STARTER_PROFILE);
 * absent, `mcp.advertised_surface` decides.
 */
export function parseAdvertiseFlag(args: string[]): McpSurface | null {
  const inline = args.find(a => a.startsWith('--advertise='));
  const idx = args.indexOf('--advertise');
  if (inline === undefined && idx < 0) return null;
  const raw = inline !== undefined ? inline.slice('--advertise='.length) : args[idx + 1];
  if (raw === undefined || raw.startsWith('--') || !isMcpSurface(raw)) {
    throw opError('invalid_params', `gbrain serve --advertise takes verbs, starter or full${raw === undefined || raw.startsWith('--') ? '' : ` (got "${raw}")`}`,
      'Run gbrain serve --advertise verbs (list the 7 memory verbs and request_tools), gbrain serve --advertise starter or gbrain serve --advertise full. Every tool the surface allows stays callable.');
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
 * `--access=read-only` is the same flag (`flagValues`); any read-only
 * value wins, so a repeated flag never widens the ceiling.
 */
export type McpAccess = 'full' | 'read-only';

export function parseAccessFlag(args: string[]): McpAccess {
  const values = flagValues(args, '--access');
  if (values.some(raw => raw !== 'full' && raw !== 'read-only')) {
    throw opError('invalid_params', '--access takes read-only or full (default full); see docs/mcp/ADMIN.md#read-only-stdio-serve',
      'Pass --access read-only or --access full (default full).', { docs: 'docs/mcp/ADMIN.md#read-only-stdio-serve' });
  }
  return values.includes('read-only') ? 'read-only' : 'full';
}

export function isReadOnlyOperation(op: Pick<OperationMeta, 'scope' | 'mutating' | 'requiredScopes'>): boolean {
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

export function filterOpsForSurface<T extends OperationMeta>(ops: T[], surface: McpSurface): T[] {
  if (surface === 'full') return ops;
  // FROZEN: 'verbs' is EXACTLY `op.verb === true` (MEMORY_VERBS v1) — starter
  // extends the ladder above it and must never alter these semantics.
  if (surface === 'verbs') return ops.filter(op => op.verb === true);
  return ops.filter(op => STARTER_OPS.has(op.name)).map(starterParams);
}

/** Shared params a starter op leaves off its schema; the op keeps the shared definition, so every surface validates the same object. */
const STARTER_HIDDEN_PARAMS: Readonly<Record<string, ReadonlySet<string>>> = { remember: new Set(['expected_revision', 'force']) };

/** Starter ops advertise every param except the full-surface-only ones and their STARTER_HIDDEN_PARAMS. */
function starterParams<T extends OperationMeta>(op: T): T {
  const hidden = STARTER_HIDDEN_PARAMS[op.name];
  const keep = ([name, p]: [string, ParamDef]) => !p.fullSurfaceOnly && !hidden?.has(name);
  const params = Object.entries(op.params);
  if (params.every(keep)) return op;
  return { ...op, params: Object.fromEntries(params.filter(keep)) };
}

const WINDOW = 'A window or part of the same page body that get_page already returns whole; gbrain\'s own large-page reads, next calls and refusals name it.';
const SKILL = 'Sent by gbrain\'s shared-skill follower and named in its fixes; catalog reads stay confined to the grant.';
const NARROW = 'Only narrows the read to sources the grant already reads, as search\'s listed source_ids does.';
const LIST_FILTER = 'The starter list_pages description names it; it only filters pages the caller can already list.';
const FULL_ROWS = 'The starter tool description and the lean-row contract name fields: "full" to restore every row field.';
const THIN_SOURCE = 'gbrain\'s thin client maps GBRAIN_SOURCE, .gbrain-source or --source onto it; a source outside the grant is refused.';

/**
 * #9669: parameters a starter caller may still pass although its tool schema leaves them out (to stay inside the starter
 * list's size budget). Every other hidden parameter is refused at dispatch (param_not_on_surface). Each entry is sent
 * by gbrain's own clients or named in its own fixes and reads nothing the starter schema cannot already reach.
 */
export const STARTER_CALLABLE_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  get_page: {
    body: WINDOW, lines: WINDOW, bytes: WINDOW, around_chunk_id: WINDOW, context_lines: WINDOW, cursor: WINDOW, max_bytes: WINDOW,
    view: WINDOW, outline_from: WINDOW, section: WINDOW, grep: WINDOW, context: WINDOW,
    grammar_diagnostics: 'The line-grammar findings for the page being read; put_page and capture receipts on starter point at it.',
  },
  edit_page: { within: 'Narrows an edit to the byte range a get_page window hands back as edit_target.' },
  put_page: { drop_timeline: 'Confirms a timeline removal the starter schema already allows by omitting the section; put_page\'s own refusal names it.' },
  remember: {
    visibility: 'Already accepted per item in items, which starter lists; the segmented-entity refusal and the connection check pass it.',
    infer_entity: 'false only turns entity inference off; the segmented-entity refusal\'s retry names it.',
    valid_from: 'Already accepted per item in items; it only dates the fact being written, to the same source under the same grant, and reads nothing.',
    facet: 'The brain-ops skill and docs/guides/profile.md name it; it only labels a fact for the caller\'s own profile, and the profile checks refuse any other page.',
    content_origin: 'gbrain profile import labels each imported fact inferred; a starter caller may pass only inferred or tool_output (STARTER_PARAM_VALUES), which only lower a write\'s trust tier, and an inferred write never supersedes a user_said fact.',
  },
  recall: {
    grep: 'A substring filter that only narrows the facts returned; gbrain\'s connection check passes it.',
    limit: 'Caps rows per arm at 100; gbrain\'s connection check passes it.',
    source_ids: NARROW,
  },
  list_pages: {
    source_ids: NARROW, slug_prefix: LIST_FILTER, where: LIST_FILTER,
    offset: 'The server\'s own default-sort continuation (pagination.next) and the listing_truncated fix name it; it only skips rows the caller can already list.',
  },
  search: { fields: FULL_ROWS },
  query: { fields: FULL_ROWS },
  submit_agent: {
    max_turns: 'May only lower the job\'s turns below the default a call without it gets (STARTER_PARAM_CEILINGS); gbrain\'s connection check passes max_turns: 1.',
    queue: 'Only routes the job to the worker that claims that queue (a delegating client runs its own); the grant\'s concurrency and budget still apply.',
    model: 'Must name a supported agent tool-loop model or the call is invalid_params; spend stays in the client\'s daily budget, and a finite budget refuses a model with no known price before any call.',
    allowed_slug_prefixes: 'Only narrows the grant\'s delegated write fence: a prefix outside delegated_slug_prefixes, or any override of a job namespace, is refused.',
  },
  entity: { source_id: THIN_SOURCE, prefer_source_id: THIN_SOURCE },
  context_pack: {
    source_id: THIN_SOURCE, prefer_source_id: THIN_SOURCE,
    profile: 'The brain-ops skill names it and gbrain profile on a thin client sends it; it adds only the caller\'s own profile, read at the caller\'s scope.',
  },
  list_skills: { schema_version: SKILL, cursor: SKILL, source_id: SKILL },
  get_skill: { schema_version: SKILL, qualified_id: SKILL, expected_brain_id: SKILL, source_incarnation: SKILL, pack_id: SKILL, revision: SKILL },
  get_skill_asset: { source_incarnation: SKILL, pack_id: SKILL, qualified_id: SKILL, expected_brain_id: SKILL },
};

/**
 * #9669: whether a caller on `surface` may pass `param` to `op`: the surface lists it, or STARTER_CALLABLE_PARAMS does.
 * An undeclared name or an op the surface does not list is left to unknown-parameter and unknown-tool handling.
 */
export function paramCallable(op: OperationMeta, param: string, surface: McpSurface): boolean {
  if (surface === 'full' || !(param in op.params)) return true;
  const listed = filterOpsForSurface([op], surface)[0];
  return !listed || param in listed.params || STARTER_CALLABLE_PARAMS[op.name]?.[param] !== undefined;
}

/** GST-3170: ops whose array parameter's items take the op's own parameter names (remember's items[]). */
const ITEM_PARAMS: Readonly<Record<string, string>> = { remember: 'items' };

/** GST-3170: the op's own parameter names an item of its ITEM_PARAMS array carries, each held to paramCallable as at the top. */
export function itemParamKeys(op: OperationMeta, params: Record<string, unknown>): string[] {
  const field = ITEM_PARAMS[op.name];
  const items = field ? params[field] : undefined;
  if (!Array.isArray(items)) return [];
  return [...new Set(items.flatMap(item => item && typeof item === 'object' ? Object.keys(item) : []))].filter(key => key in op.params);
}

/** #9669: the highest value a narrower surface may pass for a reviewed hidden parameter that only lowers a default. */
export const STARTER_PARAM_CEILINGS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  submit_agent: { max_turns: SUBMIT_AGENT_DEFAULT_MAX_TURNS },
};

/** The only values a narrower surface accepts for a reviewed hidden parameter: starter callers may label a remember lower, never user_said. */
export const STARTER_PARAM_VALUES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  remember: { content_origin: ['inferred', 'tool_output'] },
};

/**
 * The first parameter value in `params` (top level, then remember's items) outside the values `surface` accepts for a
 * parameter it hides (STARTER_PARAM_VALUES), or undefined. Only a value the parameter's own enum accepts counts: anything
 * else is left to parameter validation, which never echoes it, and a refusal here can quote the value it names.
 */
export function paramValueOffSurface(op: OperationMeta, params: Record<string, unknown>, surface: McpSurface): { param: string; value: unknown; allowed: readonly string[]; inItem: boolean } | undefined {
  const values = STARTER_PARAM_VALUES[op.name];
  if (surface === 'full' || !values) return undefined;
  const listed = filterOpsForSurface([op], surface)[0];
  const field = ITEM_PARAMS[op.name];
  const items = field && Array.isArray(params[field]) ? (params[field] as unknown[]).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object') : [];
  for (const [param, allowed] of Object.entries(values)) {
    if (listed?.params[param] !== undefined) continue;
    const declared = (op.params[param] as { enum?: unknown[] } | undefined)?.enum ?? [];
    for (const [where, inItem] of [[params, false], ...items.map(i => [i, true] as const)] as const) {
      const value = where[param];
      if (typeof value === 'string' && declared.includes(value) && !allowed.includes(value)) return { param, value, allowed, inItem };
    }
  }
  return undefined;
}

/** The ceiling a surface puts on a parameter it hides, or undefined when it puts none. */
export function paramCeiling(op: OperationMeta, param: string, surface: McpSurface): number | undefined {
  if (surface === 'full' || filterOpsForSurface([op], surface)[0]?.params[param] !== undefined) return undefined;
  return STARTER_PARAM_CEILINGS[op.name]?.[param];
}

/** The fail-closed allow-set handed to dispatchToolCall. */
export function allowedOpNames(ops: OperationMeta[], surface: McpSurface): ReadonlySet<string> {
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
 * marker, so the default applies to ALL null-surface OAuth clients; operators
 * pre-seed important clients with `gbrain auth rescope-client <id> --surface
 * full`). Legacy bearer tokens have no client row and keep the server ceiling
 * (#9266). DB plane wins, file plane falls back, absent/unparseable on both =
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
export async function resolveAdvertisedSurface(engine: BrainEngine | null, config: GBrainConfig | null | undefined, flag: McpSurface | null = null): Promise<McpSurface | null> {
  if (flag) return flag;
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

/**
 * `oauth_clients.surface_set_by` for a surface an install default wrote (the
 * `gbrain agent register` presets and the harness grant profiles), not an
 * operator: the client calls that surface but lists only the memory verbs and
 * `request_tools`, like a stdio registration with `--advertise verbs`.
 */
export const INSTALL_SURFACE_SET_BY = 'install';

/**
 * The advertised surface for one HTTP client. A client without its own
 * surface gets the server's (`--advertise`, `mcp.advertised_surface`); one
 * whose surface an install default wrote lists the verbs; one that chose its
 * surface (an operator rescope, `request_tools {surface}`) lists it in full.
 */
export async function clientAdvertisedSurface(
  auth: { surface?: unknown; surfaceSetBy?: string | null },
  engine: BrainEngine | null, config: GBrainConfig | null | undefined, flag: McpSurface | null = null,
): Promise<McpSurface | null> {
  if (auth.surface) return auth.surfaceSetBy === INSTALL_SURFACE_SET_BY ? 'verbs' : null;
  return resolveAdvertisedSurface(engine, config, flag);
}

/**
 * The tools to list: the callable set narrowed to the advertised surface
 * (never wider). A narrowed list always keeps request_tools when it is
 * callable: it is how an agent reaches the unlisted tools (the verbs surface
 * itself has none).
 */
export function advertisedOps<T extends OperationMeta>(callable: T[], callableSurface: McpSurface, advertised: McpSurface | null): T[] {
  if (!advertised || !surfaceWiderThan(callableSurface, advertised)) return callable;
  const listed = new Set(filterOpsForSurface(callable, advertised).map(op => op.name));
  return callable.filter(op => listed.has(op.name) || op.name === 'request_tools');
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
  const revealed = new Set<string>(), served = new Set<string>();
  const startSurface = session.surface;
  const notify = () => { Promise.resolve(server.sendToolListChanged()).catch(() => { /* best-effort */ }); };
  return {
    async listed<T extends OperationMeta>(visible: T[]): Promise<T[]> {
      // A session the agent widened with request_tools {surface} lists everything it asked for.
      if (session.surface !== startSurface) return visible;
      const listed = advertisedOps(visible, session.surface, await advertised());
      return listed.length === visible.length ? visible : visible.filter(op => revealed.has(op.name) || listed.includes(op));
    },
    /** D2: whether tools/list shows this (callable) tool now. */
    async isListed(op: OperationMeta): Promise<boolean> {
      if (session.surface !== startSurface || revealed.has(op.name)) return true;
      return advertisedOps([op], session.surface, await advertised()).length > 0;
    },
    /** Records the names the latest tools/list answer served (the list the client last read). */
    noteServed(names: string[]): void {
      served.clear();
      for (const name of names) served.add(name);
    },
    /** Whether the latest tools/list answer served this tool. */
    servedToClient(name: string): boolean {
      return served.has(name);
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
  surfacedOps: OperationMeta[];
  allowedOps: ReadonlySet<string> | undefined;
  widen(to: McpSurface): { from: McpSurface; to: McpSurface; added: string[] };
}

export function createStdioSurfaceState(
  ops: OperationMeta[],
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
  try {
    const dbVal = engine ? await engine.getConfig('mcp.allow_session_widen') : null;
    if (dbVal != null) return !sessionWidenOff(dbVal);
  } catch { /* the file plane decides */ }
  return !sessionWidenOff(config?.mcp?.allow_session_widen);
}

/** The once-per-process `surface_env_invalid` info notice for an ignored GBRAIN_SURFACE value. */
export function surfaceEnvInvalidNotice(raw: string, served: McpSurface, source: SurfaceSource): Notice {
  return {
    code: 'surface_env_invalid', kind: 'info',
    why: `GBRAIN_SURFACE="${raw}" is not a tool surface (use verbs, starter or full), so this server ignored it and serves '${served}' (source: ${SURFACE_SOURCE_LABEL[source]}).`,
    user_message: `The gbrain MCP server's GBRAIN_SURFACE setting ("${raw}") is not valid; it takes verbs, starter or full. Can you fix it in the env of your agent app's MCP server entry for gbrain?`,
  };
}
