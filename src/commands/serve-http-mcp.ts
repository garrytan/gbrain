/**
 * MCP Streamable HTTP endpoint for `gbrain serve --http` (split out of
 * serve-http.ts by refactor wave 1): bearer auth with the resource-audience
 * verifier, the per-request effective surface, tools/list and tools/call
 * through the shared dispatcher, request logging and the admin SSE feed.
 */
import type { Express, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { opAllowedForBoundClient } from '../core/operations.ts';
import type { AuthInfo, Operation } from '../core/operations.ts';
import { disabledOpsForPublishGates } from '../mcp/publish-gates.ts';
import { resolveMcpInstructions } from '../mcp/instructions.ts';
import { installCapabilitiesResource, mcpAdministrationGuidance } from '../mcp/capabilities.ts';
import { createSkillResources } from '../mcp/skill-resources.ts';
import { resolveAuthCapabilities } from '../core/harness/capabilities.ts';
import { resolveWritebackConfig, ambientOptsFrom } from '../core/facts/writeback-config.ts';
import { hasScope, operationScopesAllowed } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall, requestLogStatusForResult, type ToolResult } from '../mcp/dispatch.ts';
import { resolveStrictParamsMode } from '../mcp/validate-params.ts';
import { buildToolDefs } from '../mcp/tool-defs.ts';
import {
  filterOpsForSurface,
  clampSurface,
  minSurface,
  resolveClientRowSurface,
  resolveDefaultClientSurface,
  type McpSurface,
} from '../mcp/surface.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { serializeError } from '../core/errors.ts';
import { VERSION } from '../version.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import { withBearerScopeHint } from './serve-http-oauth.ts';
import type { ServeHttpContext } from './serve-http.ts';

/** Per-request state shared by the tools/list and tools/call handlers of one POST /mcp. */
interface McpRequestState {
  authInfo: AuthInfo;
  agentName: string;
  startTime: number;
  mcpOperations: Operation[];
  surface: McpSurface;
  surfaceCeiling: McpSurface;
  surfaceAllowedOps: ReadonlySet<string> | undefined;
}

export function mountMcp(app: Express, ctx: ServeHttpContext): void {
  const { engine, config, resourceVerifier, resourceMetadataUrl, mcpOperationsBase } = ctx;
  // ---------------------------------------------------------------------------
  // MCP tool calls (bearer auth + scope enforcement)
  // ---------------------------------------------------------------------------
  // MEMORY_VERBS v1 + WP4 (D2): the server-resolved surface is the CEILING.
  // The per-REQUEST effective surface — min(ceiling, client row surface ??
  // config default), clamped by the GBRAIN_MCP_FORCE_SURFACE kill switch
  // (narrow-only, FOV-6a) — is resolved inside the /mcp handler so a rescope
  // or config flip takes effect on the client's next request without a
  // restart, and the dispatch allow-set is recomputed per request
  // (amendment 20). The surface filter applies AFTER the localOnly filter;
  // the same set feeds dispatch as allowedOps so hidden ops are uncallable,
  // not just unlisted [c2].
  const serverSurfaceCeiling: McpSurface = ctx.surface ?? 'full';

  /**
   * WP4 (D2): resolve this request's effective surface from the caller's
   * verified auth. The config default (`mcp.default_surface_dcr`) is read
   * dual-plane ONLY when the client row carries no usable surface — the
   * common full-surface path pays no extra config read. Unknown row values
   * are ignored with a warn-once per client (amendment 18). Never throws:
   * surface resolution must not take a request down. On a default-surface
   * read failure the LAST successfully read default (per process) still
   * applies, so a transient config outage cannot silently widen a client
   * that normally resolves narrower than the ceiling; with no prior read,
   * the ceiling is the only floor available (pre-WP4 behavior).
   */
  let lastKnownDefaultSurface: McpSurface | null = null;
  async function resolveEffectiveSurface(authInfo: AuthInfo): Promise<{ ceiling: McpSurface; effective: McpSurface }> {
    const ceiling = clampSurface(serverSurfaceCeiling);
    // min() can never go below the narrowest surface: a 'verbs' ceiling makes
    // the row/default resolution a no-op, so skip the awaited config read.
    if (ceiling === 'verbs') return { ceiling, effective: ceiling };
    const rowSurface = resolveClientRowSurface(authInfo.surface, authInfo.clientId);
    if (rowSurface !== null) return { ceiling, effective: minSurface(ceiling, rowSurface) };
    try {
      const dflt = await resolveDefaultClientSurface(engine, config);
      lastKnownDefaultSurface = dflt ?? null;
      return { ceiling, effective: minSurface(ceiling, dflt ?? ceiling) };
    } catch {
      return { ceiling, effective: minSurface(ceiling, lastKnownDefaultSurface ?? ceiling) };
    }
  }

  // v0.36.x #1076: MCP Streamable HTTP spec — GET /mcp opens an optional SSE
  // backchannel for server-initiated messages. gbrain's transport is stateless
  // and doesn't push server-initiated messages, so per spec we MUST return 405
  // (not 404) so probing clients (claude.ai, etc.) recognize this as an MCP
  // endpoint, not a missing route. Without this, clients display "endpoint not
  // found" instead of "endpoint exists but no SSE channel."
  app.get('/mcp', (_req: Request, res: Response) => {
    res.set('Allow', 'POST, DELETE');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  // #5277: hint every scope a connector may need. Clients that request exactly
  // the hinted scope and never step up (claude.ai connectors) otherwise stay
  // read-only; grantScopes still caps each grant to the client row's scope.
  app.post('/mcp', withBearerScopeHint(
    requireBearerAuth({ verifier: resourceVerifier, resourceMetadataUrl }), ['read', 'write'],
  ), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authInfo = (req as any).auth as AuthInfo;

    // Human-readable agent name is now threaded through AuthInfo by
    // verifyAccessToken (which JOINs oauth_clients in its existing token
    // SELECT). No per-request DB roundtrip needed. Falls back to clientId
    // for legacy tokens or when the JOIN row's client_name is NULL.
    const agentName = authInfo.clientName ?? authInfo.clientId;

    // WP4 (D2): per-request effective surface + fail-closed allow-set,
    // recomputed per request (amendment 20) so rescopes/request_tools
    // persists take effect on the next request with zero restart.
    // Ambient writeback (opt-in, default off) resolves CONCURRENTLY with the
    // surface read (performance review, this wave — the two independent DB
    // waits must not serialize; an initialize-only resolve is NOT possible
    // here because /mcp has no JSON middleware, so req.body is undefined
    // until the SDK transport reads the stream — verified by the OAuth
    // lifecycle test, which caught exactly that regression). Restart-free
    // like the publish gates, fail-closed with a per-engine last-known-good
    // bundle so a transient config blip serves the previous bundle instead
    // of silently dropping the section mid-session. OV-A5: a token without
    // write scope never receives the section (`remember` would be
    // uncallable — instructions must not order impossible calls); OV2-14:
    // extract_facts is advertised only when this token's ACTUAL visible set
    // can call it (surface + scope + bound-client fence — the same
    // predicates tools/list applies).
    const canWrite = hasScope(authInfo.scopes, 'write');
    const [{ ceiling: surfaceCeiling, effective: surface }, writeback] = await Promise.all([
      resolveEffectiveSurface(authInfo),
      canWrite ? resolveWritebackConfig(engine, config) : Promise.resolve(null),
    ]);
    const mcpOperations = filterOpsForSurface(mcpOperationsBase, surface)
      .filter(op => authInfo.allowedOperations == null || authInfo.allowedOperations.includes(op.name));
    authInfo.effectiveSurface = surface;
    const surfaceAllowedOps: ReadonlySet<string> | undefined =
      surface === 'full' && authInfo.allowedOperations == null ? undefined : new Set(mcpOperations.map(o => o.name));
    const state: McpRequestState = { authInfo, agentName, startTime, mcpOperations, surface, surfaceCeiling, surfaceAllowedOps };
    const server = createMcpRequestServer(ctx, state, writeback);
    await serveMcpRequest(server, req, res);
  });
}

function createMcpRequestServer(
  ctx: ServeHttpContext,
  state: McpRequestState,
  writeback: Awaited<ReturnType<typeof resolveWritebackConfig>> | null,
): Server {
  const { engine, config, mcpResourceUrl } = ctx;
  const { authInfo, mcpOperations, surface, surfaceCeiling, surfaceAllowedOps } = state;
  // Create a fresh MCP server per request (stateless).
  let writebackOpts: ReturnType<typeof ambientOptsFrom> = null;
  if (writeback) {
    // Both availability probes apply the SAME predicates tools/list does
    // (surface filter + bound-client fence): a slug-bound client whose
    // fence denies `remember` receives NO ambient section at all —
    // instructions must never order calls dispatch will deny.
    const rememberOp = mcpOperations.find(o => o.name === 'remember');
    const extractFactsOp = mcpOperations.find(o => o.name === 'extract_facts');
    writebackOpts = ambientOptsFrom(writeback, {
      remember: rememberOp !== undefined && opAllowedForBoundClient(authInfo, rememberOp),
      extractFacts: extractFactsOp !== undefined && opAllowedForBoundClient(authInfo, extractFactsOp),
    });
  }
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      // #4748: contract (+ opt-in writeback section) + deployment identity.
      instructions: resolveMcpInstructions(config, process.env, { writeback: writebackOpts }),
    },
  );
  installCapabilitiesResource(server, async () => {
    return { transport: authInfo.clientId.startsWith('gbrain_cl_') ? 'oauth' : 'legacy', client_id: authInfo.clientId,
      ...await resolveAuthCapabilities(authInfo, engine, config), administration: mcpAdministrationGuidance(mcpResourceUrl.toString()) };
  }, createSkillResources(engine, async () => {
    const sourceId = authInfo.sourceId ?? 'default';
    const { noGrantFederatedScope } = await import('../core/source-resolver.ts');
    return { remote: true, transport: 'http', sourceId, auth: authInfo, config,
      localFederatedSourceIds: await noGrantFederatedScope(engine, authInfo.hasSourceGrant, sourceId),
      allowedOps: surfaceAllowedOps, surface, surfaceCeiling };
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => listMcpTools(ctx, state));
  server.setRequestHandler(CallToolRequestSchema, async (request) => callMcpTool(ctx, state, request));
  return server;
}

async function listMcpTools(ctx: ServeHttpContext, state: McpRequestState) {
  const { engine, config, broadcastEvent } = ctx;
  const { authInfo, agentName, startTime, mcpOperations } = state;
  // WP1 honest catalog: the advertised list is exactly what THIS token
  // can call. Three per-request filters, cheapest first:
  //   1. token scope — a read-only token never sees admin/write tools;
  //   2. bound-client fence — a slug-bound client never sees ops the
  //      dispatch fence would deny (same predicate, cannot drift);
  //   3. publish gates — gated ops (skills/advisor) are hidden while
  //      their gate is off; the resolver never throws (read failure =
  //      hidden, matching the default-off consent posture) so a config
  //      hiccup costs at most the 4 gated tools, never the whole list.
  // Call-time enforcement (hasScope / fence / assertPublishEnabled)
  // stays as the fail-closed backstop for all three layers.
  // Both per-request config reads are independent — issue them
  // concurrently (one RTT of latency on network Postgres, not two).
  const [gateDisabled, strictParamsMode] = await Promise.all([
    disabledOpsForPublishGates(engine, config),
    resolveStrictParamsMode(engine, config),
  ]);
  // FOV-4: `agent` deliberately implies only itself, which would strand
  // agent-only tokens with ZERO discovery — ops flagged `agentCallable`
  // (request_tools) are visible to (and callable by, below) agent scope
  // in addition to their declared scope.
  const visibleOps = mcpOperations.filter(op =>
    operationScopesAllowed(authInfo.scopes, op)
    && opAllowedForBoundClient(authInfo, op)
    && !gateDisabled.has(op.name),
  );
  // WP3 (amendment 14): ONE schema mapper — the inline map this handler
  // carried is unified onto buildToolDefs so the byte-pin test covers the
  // transport consumers actually use. strict_params is read dual-plane
  // PER REQUEST (same restart-free property as the publish gates above):
  // 'reject' closes each schema with additionalProperties:false and
  // declares the _meta/dry_run passthrough keys (D14.1).
  const strictParams = strictParamsMode === 'reject';
  const tools = buildToolDefs(visibleOps, { strictParams });
  // v0.28.10: log every JSON-RPC method, not just successful tools/call.
  // Pre-fix, /admin/api/requests showed nothing for clients that only
  // ever called tools/list, and the v0.26.3 persistence regression test
  // asserting >= 2 rows after tools/list + tools/call was unreachable.
  // Amendment 23 stopgap (full list-size telemetry deferred): the row's
  // params carry the listed-tool count so per-token-class list sizes are
  // queryable (`params->>'tool_count'`) without new telemetry plumbing.
  const latency = Date.now() - startTime;
  try {
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [authInfo.clientId, agentName, 'tools/list', latency, 'success'],
      [{ tool_count: tools.length }],
    );
  } catch { /* best effort */ }
  broadcastEvent({
    agent: agentName,
    operation: 'tools/list',
    scopes: authInfo.scopes.join(','),
    latency_ms: latency,
    status: 'success',
    timestamp: new Date().toISOString(),
  });
  return { tools };
}

async function callMcpTool(ctx: ServeHttpContext, state: McpRequestState, request: CallToolRequest): Promise<ToolResult> {
  const { engine, broadcastEvent, logFullParams } = ctx;
  const { authInfo, agentName, startTime, mcpOperations, surface, surfaceCeiling, surfaceAllowedOps } = state;
  const { name, arguments: params } = request.params;
  const op = mcpOperations.find(o => o.name === name);
  if (!op) {
    return rejectUnknownMcpOperation(ctx, state, name);
  }

  // Scope enforcement (v0.28: hasScope replaces exact-string-match so
  // admin tokens satisfy any scope, write satisfies read, and the new
  // sources_admin / users_admin scopes resolve through the same
  // hierarchy. Plain string includes() at this site would have made
  // sources_admin tokens look like they couldn't even read.)
  const requiredScope = op.scope || 'read';
  // FOV-4: agentCallable carve-out mirrors the tools/list filter above —
  // an op listed for an agent-only token must not scope-deny at call time.
  const scopeSatisfied = operationScopesAllowed(authInfo.scopes, op);
  if (!scopeSatisfied) {
    return rejectInsufficientMcpScope(ctx, state, name, requiredScope);
  }

  // F8: redact request payload by default (declared keys only via the
  // op's `params` allow-list; values + attacker-controlled key names
  // never written to mcp_request_log or the SSE feed). --log-full-params
  // bypasses this for operators debugging on their own laptop, with the
  // startup warning printed earlier.
  //
  // D1 (v0.31 wave): mcp_request_log.params is JSONB. Pre-v0.31 wrote
  // a JSON-string into that JSONB column via the postgres.js template
  // tag's loose typing — readable but semantically wrong (params->>'op'
  // would return the encoded string, not the value). Post-v0.31 we
  // pass the OBJECT through executeRawJsonb with an explicit ::jsonb
  // cast, so reads return real objects and `params->>'op'` returns
  // 'tools/list'. Pre-existing string-shaped rows are normalized by
  // migration v41 in src/core/migrate.ts.
  const safeParamsSummary = summarizeMcpParams(name, params);
  const logParamsObj: unknown = logFullParams
    ? (params || null)
    : (safeParamsSummary || null);
  const broadcastParams = logFullParams ? (params || {}) : safeParamsSummary;

  // v0.31 (D12 / eE1): refactor the inlined op.handler call to go through
  // src/mcp/dispatch.ts so HTTP MCP shares the same dispatch path as
  // stdio MCP. The dispatcher does param validation, OperationContext
  // build, error envelope unification, and (new) `_meta.brain_hot_memory`
  // injection via the metaHook. HTTP-specific concerns (mcp_request_log
  // persistence + SSE broadcast) stay here; the dispatcher returns the
  // ToolResult and we read isError + _meta to pick the right branch.
  // #2529: takesHoldersAllowList is a typed AuthInfo field populated by
  // verifyAccessToken from access_tokens.permissions.takes_holders for
  // legacy bearer tokens ([] preserved as deny-all). The fail-closed
  // ['world'] default covers OAuth-client tokens (no per-client storage
  // yet — see TODOS.md) and pre-v29 brains (no permissions column →
  // isUndefinedColumnError fallback in verifyAccessToken).
  const tokenAllowList = authInfo.takesHoldersAllowList ?? ['world'];
  // v0.34.1 (#861, D13): AuthInfo.sourceId is now a real typed field
  // populated from oauth_clients.source_id (migration v60 backfilled
  // NULL → 'default'). Pre-fix this site cast through AuthInfo and
  // fell back to GBRAIN_SOURCE env / 'default' — the silent-fallback
  // path codex flagged in plan review. Post-v60, every OAuth client
  // has source_id set; legacy bearer tokens default to 'default' in
  // verifyAccessToken. The env-fallback is gone.
  const tokenSourceId = authInfo.sourceId ?? 'default';

  // #3242 parity: the legacy-transport and stdio dispatch sites widen a
  // no-grant caller's unqualified reads across the federated source set
  // (localFederatedSourceIds); this SDK-transport site never did, so the
  // same token saw federated pages over /mcp on one serve mode and scalar
  // 'default' on the other. hasSourceGrant === false is set ONLY for
  // legacy bearer tokens with no operator source grant (oauth-provider);
  // granted tokens and OAuth clients never widen. Best-effort: a resolver
  // failure keeps the scalar scope.
  const { noGrantFederatedScope } = await import('../core/source-resolver.ts');
  const localFederated = await noGrantFederatedScope(
    engine,
    authInfo.hasSourceGrant,
    tokenSourceId,
  );

  let toolResult: Awaited<ReturnType<typeof dispatchToolCall>>;
  try {
    toolResult = await dispatchToolCall(engine, name, params as Record<string, unknown> | undefined, {
      remote: true,
      // WP1/D7: network transport — the dispatch-layer localOnly
      // backstop keys off this marker.
      transport: 'http',
      takesHoldersAllowList: tokenAllowList,
      sourceId: tokenSourceId,
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      metaHook: getBrainHotMemoryMeta,
      // MEMORY_VERBS v1: fail-closed surface enforcement + usage attribution.
      ...(surfaceAllowedOps ? { allowedOps: surfaceAllowedOps } : {}),
      surface,
      // WP4 (D2): request_tools bounds its catalog + persist by this.
      surfaceCeiling,
      // v0.31 follow-up fix: thread auth so the whoami op (and any
      // future scope-aware handlers) can introspect the caller. The
      // original D12/eE1 refactor moved dispatch into dispatchToolCall
      // but forgot to pass authInfo; whoami fell through to the
      // unknown_transport throw because ctx.auth was undefined.
      auth: authInfo,
      logger: {
        info: (msg: string) => console.error(`[INFO] ${msg}`),
        warn: (msg: string) => console.error(`[WARN] ${msg}`),
        error: (msg: string) => console.error(`[ERROR] ${msg}`),
      },
    });
  } catch (e) {
    // dispatchToolCall absorbs OperationError + Error and returns
    // isError:true; only an unexpected throw lands here. Treat as the
    // F15 unified envelope. v0.31 wave (D1): mcp_request_log.params is
    // JSONB — write the object via executeRawJsonb so reads return a
    // real object, not a JSON-encoded string.
    const latency = Date.now() - startTime;
    const errorPayload = serializeError(e);
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [authInfo.clientId, agentName, name, latency, 'error', errorPayload.message],
        [logParamsObj],
      );
    } catch { /* best effort */ }
    broadcastEvent({
      agent: agentName,
      operation: name,
      params: broadcastParams,
      scopes: authInfo.scopes.join(','),
      latency_ms: latency,
      status: 'error',
      error: errorPayload,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ error: errorPayload }) }], isError: true };
  }

  return recordMcpToolResult(ctx, state, name, toolResult, logParamsObj, broadcastParams);
}

async function rejectUnknownMcpOperation(ctx: ServeHttpContext, state: McpRequestState, name: string): Promise<ToolResult> {
  const { engine, broadcastEvent } = ctx;
  const { authInfo, agentName, startTime } = state;
  // v0.28.10: persist unknown-op attempts. Operators investigating
  // misbehaving agents need to see the full attempt log, not just
  // valid-op success/error.
  const latency = Date.now() - startTime;
  try {
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [authInfo.clientId, agentName, name, latency, 'error', `unknown_operation: ${name}`],
      [null],
    );
  } catch { /* best effort */ }
  broadcastEvent({
    agent: agentName,
    operation: name,
    scopes: authInfo.scopes.join(','),
    latency_ms: latency,
    status: 'error',
    error: { code: 'unknown_operation', message: `Unknown: ${name}` },
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_operation', message: `Unknown: ${name}` }) }], isError: true };
}

async function rejectInsufficientMcpScope(
  ctx: ServeHttpContext,
  state: McpRequestState,
  name: string,
  requiredScope: string,
): Promise<ToolResult> {
  const { engine, broadcastEvent } = ctx;
  const { authInfo, agentName, startTime } = state;
  // v0.28.10: persist scope-rejected attempts. Same operator-visibility
  // motivation as the unknown-op path — and it makes the v0.26.3
  // persistence regression test reliable across both rejection paths.
  // Amendment 33: a call-time scope deny is a LIST-LEVEL denial (the
  // tools/list filter uses this same hasScope predicate, so the op was
  // never advertised to this token — the client ignored or staled its
  // list, or list/call drifted). status='denied_after_list' makes the
  // honest-catalog metric a one-line count that trends to zero.
  const latency = Date.now() - startTime;
  try {
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [authInfo.clientId, agentName, name, latency, 'denied_after_list', `insufficient_scope: requires '${requiredScope}'`],
      [null],
    );
  } catch { /* best effort */ }
  broadcastEvent({
    agent: agentName,
    operation: name,
    scopes: authInfo.scopes.join(','),
    latency_ms: latency,
    status: 'denied_after_list',
    error: { code: 'insufficient_scope', message: `requires '${requiredScope}'` },
    timestamp: new Date().toISOString(),
  });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'insufficient_scope',
        message: `Operation ${name} requires '${requiredScope}' scope`,
        your_scopes: authInfo.scopes,
      }),
    }],
    isError: true,
  };
}

async function recordMcpToolResult(
  ctx: ServeHttpContext,
  state: McpRequestState,
  name: string,
  toolResult: ToolResult,
  logParamsObj: unknown,
  broadcastParams: unknown,
): Promise<ToolResult> {
  const { engine, broadcastEvent } = ctx;
  const { authInfo, agentName, startTime } = state;
  const latency = Date.now() - startTime;
  if (toolResult.isError) {
    // dispatchToolCall serializes the error into the content text;
    // for the audit log we re-extract a message string for the
    // mcp_request_log error_message column. Best-effort parse.
    // Amendment 33 / D10: op-level denials the list should have
    // prevented (publish-gate backstop `config_key=...`, bound-client
    // fence op-level deny `fence=op`) log status='denied_after_list'
    // instead of plain 'error' — the honest-catalog trend-to-zero
    // metric. Argument-level fence denials carry no marker and stay
    // 'error' (legitimate for a listed op).
    let errMsg = 'unknown_error';
    try {
      const parsed = JSON.parse(toolResult.content[0]?.text ?? '{}');
      errMsg = parsed.error?.message ?? parsed.message ?? errMsg;
    } catch { /* ignore */ }
    const errStatus = requestLogStatusForResult(toolResult);
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [authInfo.clientId, agentName, name, latency, errStatus, errMsg],
        [logParamsObj],
      );
    } catch { /* best effort */ }
    broadcastEvent({
      agent: agentName,
      operation: name,
      params: broadcastParams,
      scopes: authInfo.scopes.join(','),
      latency_ms: latency,
      status: errStatus,
      error: { code: 'op_error', message: errMsg },
      timestamp: new Date().toISOString(),
    });
    return toolResult;
  }

  // WP3 (amendment 13): warn-mode observability. A success whose _meta
  // carries a non-empty warnings array logs as 'success_with_warnings' so
  // the reject-flip decision is evidence-based (count per client via the
  // status column). Warn CONTENTS (the raw unknown keys) are never logged.
  const successStatus = requestLogStatusForResult(toolResult);
  try {
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [authInfo.clientId, agentName, name, latency, successStatus],
      [logParamsObj],
    );
  } catch { /* best effort */ }
  broadcastEvent({
    agent: agentName,
    operation: name,
    params: broadcastParams,
    scopes: authInfo.scopes.join(','),
    latency_ms: latency,
    status: successStatus,
    timestamp: new Date().toISOString(),
  });
  return toolResult;
}

async function serveMcpRequest(server: Server, req: Request, res: Response): Promise<void> {
  // F14: wrap transport setup + handleRequest in try/catch. Without this,
  // an SDK-level throw (e.g., schema parse failure on a malformed request)
  // propagates to express's default error handler, which renders an HTML
  // error page — clients expecting JSON-RPC envelopes break. On
  // !res.headersSent we emit a minimal JSON 500 so the client at least
  // gets parseable JSON back.
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any });
    // #2844: per-request teardown (SDK stateless pattern) — without it every POST /mcp leaks the transport+Server pair (~3GB/day RSS). Registered BEFORE connect/handleRequest so early disconnects and handleRequest throws still clean up; best-effort catches so cleanup never surfaces an unhandledRejection.
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP request handler error:', e instanceof Error ? e.message : e);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'internal_error',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }
}
