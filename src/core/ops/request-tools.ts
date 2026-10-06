/**
 * request_tools operation cluster — pure move from operations.ts (v0.46.x
 * tranche 3): the WP4 (T9) discovery + pull-based per-client surface-unlock
 * op, its persist rate limiter (+ test seam), and the visibleOpsForCaller
 * catalog filter. Op const stays module-private; `requestToolsOperations`
 * below is spliced into the canonical `operations` array in ../operations.ts
 * at the cluster's original position. Never import from '../operations.ts'
 * here STATICALLY (cycle) — visibleOpsForCaller needs the assembled op list,
 * so it loads it via dynamic import inside the call path (the verbs.ts house
 * pattern: by the time a handler runs, operations.ts has finished loading).
 */

// WP4 (request_tools): the four static imports below are runtime leaves
// relative to operations.ts (no import cycles back into it). The cyclic
// dependencies — src/mcp/surface.ts (→ brain-allowlist → operations),
// src/mcp/publish-gates.ts (→ operations), and the assembled `operations`
// array itself — are loaded via dynamic import inside the handler instead
// (the verbs.ts house pattern).
import { isUndefinedColumnError } from '../utils.ts';
import { hasScope, operationScopesAllowed } from '../scope.ts';
import { RateLimiter } from '../../mcp/rate-limit.ts';
import { writeSurfaceChangeAudit } from '../surface-audit.ts';
import type { Operation, OperationContext } from './contract.ts';
import { OperationError, opError } from './contract.ts';
import { hostFix, invalidParam } from './op-fix.ts';

/** stdio and legacy bearer tokens have no per-client surface row: the server's own start flag decides. */
const NO_CLIENT_SURFACE = 'no per-client surface on this transport; the server surface is set on the host with `gbrain serve --surface <verbs|starter|full>`';
import { opAllowedForBoundClient } from './context.ts';

// --- WP4 (T9): request_tools — discovery + pull-based per-client unlock ---

/**
 * D14.5: per-client rate limit on the persist branch (~5 surface persists /
 * hour / client). Module-level token bucket (bounded LRU — attacker-chosen
 * client ids can't grow memory); `let` + reset seam so tests don't leak
 * bucket state across files.
 */
let requestToolsPersistLimiter = new RateLimiter({ limit: 5, windowMs: 3_600_000, lruCap: 5_000 });

/** Test seam: fresh persist-rate-limit buckets. */
export function __resetRequestToolsPersistLimiterForTests(): void {
  requestToolsPersistLimiter = new RateLimiter({ limit: 5, windowMs: 3_600_000, lruCap: 5_000 });
}

/**
 * One-line catalog summary: the first sentence of an op description,
 * capped. Non-contractual rendering — full schemas come from the
 * `{tools: [...]}` branch.
 */
function firstSentenceOf(description: string): string {
  const t = description.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * The set of ops VISIBLE to this caller (never leak hidden names — C8/
 * amendment 11 class): bounded by the server ceiling (ops above it can
 * never be served, so naming them would recreate listed-but-denied at the
 * persist level), minus localOnly on network transports (stdio and the
 * trusted local CLI keep them — D7), minus ops outside the caller's scopes
 * (agent-callable carve-out per FOV-4), minus bound-client-fenced ops (same
 * predicate as tools/list, ENG-3), minus publish-gated ops whose gate is off.
 * Two DISTINCT caller axes here: localOnly visibility is the transport-
 * LOCALITY axis (stdio pipe or trusted local CLI can call localOnly ops, D7),
 * while publish gates are the owner-CONSENT axis and exempt ONLY
 * ctx.remote === false (assertPublishEnabled + the advisor inline gate) —
 * stdio dispatches remote:true, so its catalog subtracts gate-off ops or it
 * advertises tools that deny at call time. A failed gate read hides the gated
 * ops, fail-closed.
 */
async function visibleOpsForCaller(
  ctx: OperationContext,
  ceiling: 'verbs' | 'starter' | 'full',
): Promise<Operation[]> {
  // The assembled op list lives in ../operations.ts, which spreads THIS
  // module's array — so it must never be imported statically here. Loaded
  // lazily instead (the verbs.ts house pattern); by the time any handler
  // runs, operations.ts has finished evaluating.
  const { operations } = await import('../operations.ts');
  const { filterOpsForSurface } = await import('../../mcp/surface.ts');
  // Locality axis: the stdio pipe or the local CLI (remote strictly false)
  // CAN call localOnly ops, so hiding those would make the catalog dishonest.
  const canSeeLocalOnly = ctx.transport === 'stdio' || ctx.remote === false;
  // Consent axis: publish-gate enforcement exempts ONLY remote === false —
  // stdio is remote:true, so it is gate-subject like every other agent caller.
  const gateExempt = ctx.remote === false;

  let gateDisabled: ReadonlySet<string> = new Set();
  if (!gateExempt) {
    try {
      const { disabledOpsForPublishGates } = await import('../../mcp/publish-gates.ts');
      gateDisabled = await disabledOpsForPublishGates(ctx.engine, ctx.config, { transport: ctx.transport });
    } catch {
      // Fail-closed: if the resolver can't even load, hide every gated op.
      gateDisabled = new Set(operations.filter(o => o.publishGateKey).map(o => o.name));
    }
  }

  // Auth-less transports (stdio) and grandfathered legacy bearer tokens
  // (empty scopes array — that transport does no call-time scope checks
  // either) skip scope filtering: for them the whole surface IS callable,
  // so hiding by scope would make the catalog LESS honest, not more.
  const scopes = ctx.auth?.scopes && ctx.auth.scopes.length > 0 ? ctx.auth.scopes : null;

  return filterOpsForSurface(operations, ceiling).filter(op =>
    (canSeeLocalOnly || !op.localOnly)
    && (ctx.remote === false || (scopes === null && !op.requiredScopes?.length)
      || operationScopesAllowed(scopes ?? [], op))
    && opAllowedForBoundClient(ctx.auth, op)
    && !gateDisabled.has(op.name),
  );
}

/**
 * Stdio branch of the {surface} call: widen this session's allow-set (the
 * one tools/list and dispatch share), never past `--access read-only` or
 * GBRAIN_MCP_FORCE_SURFACE, then answer with the newly allowed tools'
 * schemas so a client that ignores `tools/list_changed` can call them by
 * name. Nothing is written; a new session starts at the registered surface.
 */
async function widenStdioSession(ctx: OperationContext, requested: 'verbs' | 'starter' | 'full'): Promise<Record<string, unknown>> {
  const session = ctx.stdioSurface!;
  const { clampSurface, sessionWidenAllowed, surfaceWiderThan } = await import('../../mcp/surface.ts');
  session.widenAllowed = await sessionWidenAllowed(ctx.engine, ctx.config);
  const persistent = `For a lasting change, set GBRAIN_SURFACE=${requested} in the env of this harness's MCP server entry for gbrain (or re-register the server with --surface ${requested}) and start a new session.`;
  if (!session.widenAllowed) {
    throw opError('permission_denied',
      'Session widening is off on this brain (mcp.allow_session_widen is false), so request_tools cannot add tools to this stdio session.',
      `${persistent} The user can turn session widening back on with \`gbrain config set mcp.allow_session_widen true\`.`,
      { fix: hostFix(ctx, ['gbrain', 'config', 'set', 'mcp.allow_session_widen', 'true'],
        `Turns stdio session widening back on (the brain owner turned it off). ${persistent}`) });
  }
  const target = clampSurface(requested);
  if (!surfaceWiderThan(target, session.surface)) {
    return { persisted: false, scope: 'session', surface: session.surface, widened: false,
      note: target !== requested
        ? `GBRAIN_MCP_FORCE_SURFACE caps this server at '${target}', so this session stays at '${session.surface}'.`
        : `This session already serves '${session.surface}', which includes everything in '${requested}'.` };
  }
  if (ctx.dryRun) return { persisted: false, scope: 'session', dry_run: true, surface: target, previous: session.surface };
  const change = session.widen(target);
  const added = new Set(change.added);
  const { buildToolDefs } = await import('../../mcp/tool-defs.ts');
  const { resolveStrictParamsMode } = await import('../../mcp/validate-params.ts');
  const strictParams = (await resolveStrictParamsMode(ctx.engine, ctx.config)) === 'reject';
  const visible = (await visibleOpsForCaller(ctx, target)).filter(op => added.has(op.name));
  return {
    persisted: false, scope: 'session', surface: target, previous: change.from,
    tools: buildToolDefs(visible, { strictParams }),
    note: `This session now serves '${target}' (tools/list_changed was sent). Call the new tools by name now; their schemas are above. A new session starts at the registered surface. ${persistent}`,
  };
}

const request_tools: Operation = {
  name: 'request_tools',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'More tools: no arguments lists your catalog; {tools: [names]} returns schemas; {surface} widens it (per OAuth client; stdio: this session).',
  area: 'discovery',
  // FOV-4: callable by read OR agent scope — discovery for every token class.
  agentCallable: true,
  params: {
    tools: {
      type: 'array',
      items: { type: 'string', description: 'A tool name from the catalog.' },
      description: 'Tool names to fetch schemas for.',
    },
    surface: {
      type: 'string',
      enum: ['verbs', 'starter', 'full'],
      description: 'Surface to widen to (stdio: this session only).',
    },
  },
  scope: 'read',
  // D9: mutating because the persist branch writes oauth_clients.surface.
  // The bound-client fence exempts it via BOUND_CLIENT_META_OPS (see the
  // carve-out comment at opAllowedForBoundClient); the persist branch
  // self-enforces ceiling + operator lock + scopes + rate limit.
  mutating: true,
  handler: async (ctx, p) => {
    const { surfaceWiderThan, isMcpSurface, clampSurface } = await import('../../mcp/surface.ts');
    // Unset ceiling (local CLI / direct dispatch) = 'full' — trusted-local
    // callers were never surface-bounded.
    const ceiling = ctx.surfaceCeiling ?? 'full';

    // D5: the three branches are mutually exclusive. {surface, tools}
    // together is ambiguous (persist vs descriptor fetch) — reject loudly
    // rather than silently persisting and ignoring the tools list.
    if (p.surface !== undefined && p.tools !== undefined) {
      throw opError(
        'invalid_params',
        'pass either {surface} (persist) or {tools} (descriptor fetch), not both.',
        'Call request_tools once with `tools` to fetch descriptors, and separately with `surface` to change this client\'s tool surface.',
      );
    }

    // ── persist branch (D5: accepts ONLY {surface}) ─────────────────────
    if (p.surface !== undefined) {
      const requested = p.surface as string;
      if (!isMcpSurface(requested)) {
        // Backstop for direct handler calls — MCP dispatch already rejects
        // via the enum in validateParams (invalid_params naming the valid set).
        throw invalidParam(ctx, 'request_tools', 'surface', 'surface must be one of: verbs, starter, full (got an unrecognized value)', { choices: ['verbs', 'starter', 'full'] });
      }
      const clientId = ctx.auth?.clientId;
      if (!clientId && ctx.transport === 'stdio' && ctx.stdioSurface) return widenStdioSession(ctx, requested);
      if (!clientId) {
        // No per-token identity and no stdio session: a surface persist has nowhere to land.
        return { persisted: false, reason: NO_CLIENT_SURFACE };
      }
      if (surfaceWiderThan(requested, ceiling)) {
        const e = opError(
          'permission_denied',
          `surface '${requested}' is above this server's ceiling '${ceiling}' (D2: per-client surfaces narrow, never widen).`,
          `The brain host's operator caps this server at surface '${ceiling}'; a wider surface needs that server restarted with \`gbrain serve --surface ${requested}\`. Tools outside '${ceiling}' stay unavailable on this connection until then.`,
          { fix: hostFix(ctx, ['gbrain', 'serve', '--surface', requested], 'The surface ceiling is a server start flag; only the host that runs the server can widen it.') },
        );
        e.detail = `ceiling=${ceiling}`; // amendment 4 key=value denial grammar; ENG-11 assign-after
        throw e;
      }
      let rows: Record<string, unknown>[];
      try {
        rows = await ctx.engine.executeRaw(
          `SELECT surface, surface_set_by FROM oauth_clients WHERE client_id = $1`,
          [clientId],
        );
      } catch (err) {
        if (isUndefinedColumnError(err, 'surface') || isUndefinedColumnError(err, 'surface_set_by')) {
          // D5: a capability-negotiation op never returns internal_error for
          // a pre-migration brain — report the gap and keep serving.
          return { persisted: false, reason: 'migration pending' };
        }
        throw err;
      }
      if (rows.length === 0) {
        // Legacy bearer tokens carry a clientId that is not an oauth_clients row.
        return { persisted: false, reason: NO_CLIENT_SURFACE };
      }
      const current = rows[0] as { surface?: string | null; surface_set_by?: string | null };
      const operatorLocked = () => {
        const e = opError(
          'permission_denied',
          "this client's surface is operator-pinned and cannot be self-changed (amendment 19).",
          `Ask the brain operator to change it: gbrain auth rescope-client ${clientId} --surface ${requested}`,
          { fix: hostFix(ctx, ['gbrain', 'auth', 'rescope-client', clientId, '--surface', requested],
            'The operator pinned this client\'s surface; only the brain host\'s operator can change a pin.') },
        );
        e.detail = 'locked_by=operator';
        return e;
      };
      if (current.surface_set_by === 'operator') throw operatorLocked();
      // A dry-run preview exercises every denial above but must not consume
      // the persist budget — the limiter meters actual writes only.
      if (ctx.dryRun) {
        return { persisted: false, dry_run: true, surface: requested, reason: 'dry_run' };
      }
      const rl = requestToolsPersistLimiter.check(clientId);
      if (!rl.allowed) {
        throw opError(
          'rate_limited',
          'surface persistence is rate-limited to ~5 changes per hour per client (D14.5).',
          `Nothing changed. Call request_tools with this surface again after ~${rl.retryAfter ?? 60}s.`,
        );
      }
      // Atomic re-check: a concurrent operator pin between the SELECT and
      // this UPDATE must still win.
      const updated = await ctx.engine.executeRaw(
        `UPDATE oauth_clients SET surface = $1, surface_set_by = 'self'
         WHERE client_id = $2 AND (surface_set_by IS DISTINCT FROM 'operator')
         RETURNING client_id`,
        [requested, clientId],
      );
      if (updated.length === 0) {
        // Concurrent operator pin won the race: the denial must not consume
        // the client's persist budget (the limiter meters actual writes).
        requestToolsPersistLimiter.refund(clientId);
        throw operatorLocked();
      }
      await writeSurfaceChangeAudit(ctx.engine, {
        actor: clientId,
        client_id: clientId,
        old: (current.surface as string | null) ?? null,
        new: requested,
        via: 'request_tools',
      });
      return { persisted: true, surface: requested, note: 're-issue tools/list to see the new catalog' };
    }

    // A widenable stdio session lists what request_tools {surface} can add, not only what it serves now.
    const session = ctx.transport === 'stdio' ? ctx.stdioSurface : undefined;
    const catalogCeiling = session && session.widenAllowed && !session.readOnly ? clampSurface('full') : ceiling;
    const visible = await visibleOpsForCaller(ctx, catalogCeiling);

    // ── descriptor branch (D5: read-only) ───────────────────────────────
    if (p.tools !== undefined) {
      const requested = (p.tools as unknown[]).filter((t): t is string => typeof t === 'string');
      const byName = new Map(visible.map(o => [o.name, o]));
      const picked: Operation[] = [];
      const seen = new Set<string>();
      for (const name of requested) {
        if (seen.has(name)) continue;
        seen.add(name);
        const op = byName.get(name);
        if (op) picked.push(op); // invisible names silently omitted (D5)
      }
      const { buildToolDefs } = await import('../../mcp/tool-defs.ts');
      const { resolveStrictParamsMode } = await import('../../mcp/validate-params.ts');
      const strictParams = (await resolveStrictParamsMode(ctx.engine, ctx.config)) === 'reject';
      if (ctx.revealTools && picked.length) {
        ctx.revealTools(picked.map(o => o.name));
        return { tools: buildToolDefs(picked, { strictParams }), listed: true, note: 'These tools are now in your tool list (tools/list_changed was sent); call them directly.' };
      }
      return { tools: buildToolDefs(picked, { strictParams }) };
    }

    // ── catalog branch (no args) ────────────────────────────────────────
    const groups = new Map<string, Array<{ name: string; one_line: string }>>();
    for (const op of visible) {
      // Area names are non-contractual grouping labels (amendment 22).
      const area = op.area ?? 'other';
      const bucket = groups.get(area) ?? [];
      bucket.push({ name: op.name, one_line: firstSentenceOf(op.description) });
      groups.set(area, bucket);
    }
    const catalog = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([area, tools]) => ({ area, tools }));
    return {
      catalog,
      total_tools: visible.length,
      note: session
        ? 'Call request_tools {tools: ["name", ...]} for full schemas, or {surface: "starter"|"full"} to add those tools to this session (nothing is written).'
        : 'Call request_tools {tools: ["name", ...]} for full schemas, or {surface: "starter"|"full"} to persist a wider tool surface for your OAuth client (within the server ceiling), then re-issue tools/list.',
    };
  },
};

export const requestToolsOperations: Operation[] = [request_tools];
