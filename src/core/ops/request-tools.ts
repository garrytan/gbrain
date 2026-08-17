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
import { hasScope } from '../scope.ts';
import { RateLimiter } from '../../mcp/rate-limit.ts';
import { writeSurfaceChangeAudit } from '../surface-audit.ts';
import type { Operation, OperationContext } from './contract.ts';
import { OperationError } from './contract.ts';
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
      gateDisabled = await disabledOpsForPublishGates(ctx.engine, ctx.config);
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
    && (scopes === null
      || hasScope(scopes, op.scope ?? 'read')
      || (op.agentCallable === true && hasScope(scopes, 'agent')))
    && opAllowedForBoundClient(ctx.auth, op)
    && !gateDisabled.has(op.name),
  );
}

const request_tools: Operation = {
  name: 'request_tools',
  description:
    'Discover this brain\'s tool catalog and optionally unlock a wider tool surface for your client. ' +
    'No arguments → the catalog visible to YOUR credentials, grouped by area (tool names + one-line summaries). ' +
    '{tools: ["name", ...]} → full read-only schemas for the visible subset of those names (unknown/hidden names are silently omitted). ' +
    '{surface: "verbs"|"starter"|"full"} → persist that tool surface for this client (bounded by the server ceiling; denied when an operator pinned the surface; ~5 changes/hour), then re-issue tools/list to see the new catalog.',
  area: 'discovery',
  // FOV-4: callable by read OR agent scope — discovery for every token class.
  agentCallable: true,
  params: {
    tools: {
      type: 'array',
      items: { type: 'string', description: 'A tool name from the catalog.' },
      description: 'Fetch full read-only tool schemas for these names. Names outside your visible surface are silently omitted (D5).',
    },
    surface: {
      type: 'string',
      enum: ['verbs', 'starter', 'full'],
      description: 'Persist this tool surface for your client. Must not exceed the server ceiling; ignored surfaces stay available via no-arg discovery. Takes effect on your next tools/list.',
    },
  },
  scope: 'read',
  // D9: mutating because the persist branch writes oauth_clients.surface.
  // The bound-client fence exempts it via BOUND_CLIENT_META_OPS (see the
  // carve-out comment at opAllowedForBoundClient); the persist branch
  // self-enforces ceiling + operator lock + scopes + rate limit.
  mutating: true,
  handler: async (ctx, p) => {
    const { surfaceWiderThan, isMcpSurface } = await import('../../mcp/surface.ts');
    // Unset ceiling (local CLI / direct dispatch) = 'full' — trusted-local
    // callers were never surface-bounded.
    const ceiling = ctx.surfaceCeiling ?? 'full';

    // D5: the three branches are mutually exclusive. {surface, tools}
    // together is ambiguous (persist vs descriptor fetch) — reject loudly
    // rather than silently persisting and ignoring the tools list.
    if (p.surface !== undefined && p.tools !== undefined) {
      throw new OperationError(
        'invalid_params',
        'pass either {surface} (persist) or {tools} (descriptor fetch), not both.',
      );
    }

    // ── persist branch (D5: accepts ONLY {surface}) ─────────────────────
    if (p.surface !== undefined) {
      const requested = p.surface as string;
      if (!isMcpSurface(requested)) {
        // Backstop for direct handler calls — MCP dispatch already rejects
        // via the enum in validateParams (invalid_params naming the valid set).
        throw new OperationError('invalid_params', `surface must be one of: verbs, starter, full (got an unrecognized value)`);
      }
      const clientId = ctx.auth?.clientId;
      if (!clientId) {
        // stdio has no per-token identity; a surface persist has nowhere to land.
        return { persisted: false, reason: 'no per-client surface on this transport; use --surface' };
      }
      if (surfaceWiderThan(requested, ceiling)) {
        const e = new OperationError(
          'permission_denied',
          `surface '${requested}' is above this server's ceiling '${ceiling}' (D2: per-client surfaces narrow, never widen).`,
          `The operator caps this transport at --surface ${ceiling}; widening requires a server restart with a wider --surface.`,
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
        return { persisted: false, reason: 'no per-client surface on this transport; use --surface' };
      }
      const current = rows[0] as { surface?: string | null; surface_set_by?: string | null };
      const operatorLocked = () => {
        const e = new OperationError(
          'permission_denied',
          "this client's surface is operator-pinned and cannot be self-changed (amendment 19).",
          `Ask the brain operator to change it: gbrain auth rescope-client ${clientId} --surface ${requested}`,
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
        throw new OperationError(
          'rate_limited',
          'surface persistence is rate-limited to ~5 changes per hour per client (D14.5).',
          `Retry after ~${rl.retryAfter ?? 60}s.`,
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

    const visible = await visibleOpsForCaller(ctx, ceiling);

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
      note: 'Call request_tools {tools: ["name", ...]} for full schemas, or {surface: "starter"|"full"} to persist a wider tool surface (within the server ceiling), then re-issue tools/list.',
    };
  },
};

export const requestToolsOperations: Operation[] = [request_tools];
