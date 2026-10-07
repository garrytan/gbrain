import { noteForwardProgress } from '../core/forward-progress.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, opError, OperationError } from '../core/operations.ts';
import { isCallable, publishGatesFromDisabled } from '../core/ops/callable.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchToolCall, buildOperationContext, dispatchRenderContext, requestMetaSessionId, type ToolResult } from './dispatch.ts';
import { findInvalidParam, schemaInvalidParams, parseStrictParamsMode } from './validate-params.ts';
import { clampSurface, createStdioSurfaceState, resolveAdvertisedSurface, stdioToolListing, sessionWidenAllowed, surfaceEnvInvalidNotice, type McpAccess, type McpSurface, type SurfaceSource } from './surface.ts';
import { startOnboardingRefresher } from '../core/onboard/mcp-onboarding.ts';
import { noticeBlock, renderNotice, type Notice } from '../core/agent-output.ts';
import { disabledOpsForPublishGates } from './publish-gates.ts';
import { parseResultRowsMode, resolveResultRowsMode } from './result-rows.ts';
import type { Operation } from '../core/operations.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig } from '../core/config.ts';
import { gcSessionContextState } from '../core/context/session-state.ts';
import { bindResolveIpcForServe } from './resolve-ipc-binding.ts';
import { createPersistenceIpcProvider, residentPersistenceConfig } from '../core/persistence/provider.ts';
import { installInstructionsResolver, resolveMcpInstructions } from './instructions.ts';
import { instructionReadiness, stdioCapabilityReadiness } from './initialize-context.ts';
import { STATUS_TOOL_DEF, STATUS_TOOL_NAME, attemptStatusRecovery, statusHeadline, statusInstructionLine, statusModeErrorResult, statusModeOf, statusPayload, statusToolResult } from './status-mode.ts';
import { installCapabilitiesResource, mcpAdministrationGuidance } from './capabilities.ts';
import { createSkillResources } from './skill-resources.ts';
import { operationScopesAllowed } from '../core/scope.ts';
import { readLocalWriter, verifyLocalWriter } from '../core/persistence/identity.ts';
import { resolveWritebackConfig, ambientOptsFrom } from '../core/facts/writeback-config.ts';
import { isEngineDegraded, onEngineRecovered } from '../core/degraded-marker.ts';
import { assertStdioSourceBindable } from './source-preflight.ts';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export async function resolveMcpStdioSourceScope(
  engine: BrainEngine,
  cwd: string = process.cwd(),
  signals?: { envSource?: string },
): Promise<{
  sourceId: string;
  localFederatedSourceIds?: string[];
  explicitReadBinding?: import('../core/ops/contract.ts').ExplicitReadBinding;
  tier: import('../core/source-resolver.ts').SourceTier;
}> {
  // Degraded mode (db-availability 4c): short-circuit WITHOUT touching the
  // engine. This site runs before EVERY dispatch and its catch below
  // swallows errors into sourceId 'default' — letting it hit a degraded
  // engine would both consume the one reconnect attempt (before the handler
  // whose classified envelope the agent needs) and eat the error silently.
  // A well-formed GBRAIN_SOURCE binding is still honored (engine-free, same
  // rule as the catch below); otherwise seed_default keeps --source-guard
  // fail-closed on writes. No call ever EXECUTES under this fallback scope
  // against a live engine: the degraded proxy throws while dead, and the
  // one call whose access triggers a successful reconnect gets
  // DegradedRecoveredRetryError instead of a result (see degraded-engine.ts).
  if (isEngineDegraded(engine)) {
    const { isValidSourceId } = await import('../core/source-id.ts');
    const env = signals ? signals.envSource : process.env.GBRAIN_SOURCE;
    return env && isValidSourceId(env)
      ? { sourceId: env, tier: 'env' }
      : { sourceId: 'default', tier: 'seed_default' };
  }
  try {
    const { resolveSourceWithTier, localFederatedSourceIds, explicitReadBinding } = await import('../core/source-resolver.ts');
    const resolved = await resolveSourceWithTier(engine, null, cwd, signals);
    const federated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    // #5081: the admission set is optional; a failed lookup must not discard
    // the resolved binding (the catch below would fall back to 'default').
    const binding = await explicitReadBinding(engine, resolved.source_id, resolved.tier).catch(() => undefined);
    return {
      sourceId: resolved.source_id,
      ...(federated ? { localFederatedSourceIds: federated } : {}),
      ...(binding ? { explicitReadBinding: binding } : {}),
      tier: resolved.tier,
    };
  } catch {
    // Resolution failure. Report the tier truthfully so --source-guard makes
    // the safe call. A MALFORMED GBRAIN_SOURCE can never be a real binding —
    // launder it through as tier 'env' and the guard would pass the write,
    // which then dies downstream on the sources FK with a raw error instead
    // of the guard's actionable envelope. So a format-invalid env value falls
    // back to the ambiguous seed tier (guard blocks with "set GBRAIN_SOURCE /
    // --source"). A well-formed value keeps tier 'env': a nonexistent-source
    // or a transient engine blit is a separate downstream concern, and
    // blocking a valid binding on a blip is worse.
    const { isValidSourceId } = await import('../core/source-id.ts');
    const env = signals ? signals.envSource : process.env.GBRAIN_SOURCE;
    return env && isValidSourceId(env)
      ? { sourceId: env, tier: 'env' }
      : { sourceId: 'default', tier: 'seed_default' };
  }
}

/**
 * #4583 rework + review fixes: once-per-process unscoped-default-write
 * advisory for the stdio lane. The latch arms on the first SUCCESSFUL
 * assessment whatever its verdict (warned, or no-guard) — pre-fix it armed
 * only when a warning printed, so on a no-guard brain the assessment's
 * unindexed full-`pages` aggregate ran on EVERY mutating stdio call. The
 * inputs are process-stable (env escape hatch, the brain's page
 * distribution), so one assessment decides for the process. A FAILED
 * assessment does NOT latch: the write proceeds (fail-open) but the next
 * mutating seed_default call retries, so a transient DB error cannot disable
 * the advisory for the life of the serve process. Concurrent calls share one
 * in-flight assessment. Cheap early-returns (non-mutating call, non-seed
 * tier) do NOT latch either — a later mutating seed_default call still gets
 * its assessment. Exported for tests; `write` is injectable (production
 * writes stderr).
 */
export function createDefaultWriteAdvisory(
  engine: BrainEngine,
  opts: { enabled: boolean; write?: (line: string) => void },
): (tier: import('../core/source-resolver.ts').SourceTier, mutating: boolean) => Promise<void> {
  let latched = false;
  let inflight: Promise<void> | null = null;
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  return async (tier, mutating) => {
    if (latched || !opts.enabled) return;
    if (!mutating || tier !== 'seed_default') return;
    inflight ??= (async () => {
      try {
        const { assessUnscopedDefaultWrite } = await import('../core/source-resolver.ts');
        const { warning, assessed } = await assessUnscopedDefaultWrite(engine, tier, mutating);
        // Latch before writing so a throwing stderr writer still counts as
        // assessed; never latch on a failed (fail-open) assessment.
        if (assessed) latched = true;
        if (warning) write(warning);
      } catch { /* advisory; never block a write */ } finally {
        inflight = null;
      }
    })();
    await inflight;
  };
}

/**
 * Per-request stdio tools/list set: the surfaced ops minus publish-gated ops
 * whose gate resolves off. stdio dispatches remote:true (agent-facing), and
 * the gate enforcement (assertPublishEnabled, the advisor inline gate) exempts
 * only ctx.remote === false — so listing gate-off ops here was the exact
 * listed-but-denied class the honest-catalog wave exists to kill, surviving on
 * the default transport. localOnly ops STAY listed: locality is the transport
 * axis (stdio IS the local pipe, D7); publish gates are the owner-consent
 * axis. Deliberately uncached (publish-gates.ts doctrine: the per-request read
 * is what makes a config flip take effect without a restart; tools/list is
 * rare). Fail-closed: a resolver failure hides every gated op rather than
 * re-creating the listed-but-denied complaint.
 */
export async function stdioVisibleTools(
  engine: BrainEngine,
  surfacedOps: Operation[],
): Promise<Operation[]> {
  let scopes: readonly string[] = [];
  if (surfacedOps.some(op => op.requiredScopes?.length) && !isEngineDegraded(engine)) {
    try {
      const verified = await verifyLocalWriter(engine, await readLocalWriter(engine, 'stdio'));
      if (verified.remote) scopes = verified.grant.scopes;
    } catch {}
  }
  // Degraded serve (db-availability 4c): fail-closed WITHOUT touching the
  // engine. The gate read can hit engine.getConfig, which on the degraded
  // wrapper would burn the one lazy reconnect attempt — and stall the
  // client's INITIAL tools/list handshake behind the reconnect's wait cap.
  // Recovery re-sends tools/list_changed, so the full catalog returns.
  let gateDisabled: ReadonlySet<string> = new Set();
  if (surfacedOps.some(op => op.publishGateKey)) {
    if (isEngineDegraded(engine)) {
      gateDisabled = new Set(surfacedOps.filter(o => o.publishGateKey).map(o => o.name));
    } else {
      try {
        gateDisabled = await disabledOpsForPublishGates(engine, loadConfig(), { transport: 'stdio' });
      } catch {
        gateDisabled = new Set(surfacedOps.filter(o => o.publishGateKey).map(o => o.name));
      }
    }
  }
  // Agent contract v1 (A2): the one callability predicate. The surface was
  // applied by the caller (surfacedOps), so 'full' here adds no filter.
  const publishGates = publishGatesFromDisabled(surfacedOps, gateDisabled);
  return surfacedOps.filter(op => isCallable(op, { transport: 'stdio', surface: 'full', scopes, publishGates }));
}

// ─── #4409: in-flight stdio RPC tracking ────────────────────────────────
// A one-shot MCP client can write a batch of frames and close stdin
// immediately; the SDK parses every frame during the 'data' events (handler
// start is queued as a microtask), so at stdin-'end' time requests can be
// in flight with no response written yet. serve.ts's EOF path consults this
// counter and drains before its graceful exit instead of dropping the
// response on the floor. Module-level because one process runs one stdio
// server (matches the serve-sync-runner singleton posture).
let _stdioRpcsInFlight = 0;

/** Live count of stdio JSON-RPC requests whose handlers have not settled. */
export function stdioRpcsInFlightCount(): number {
  return _stdioRpcsInFlight;
}

/** Wrap one request handler invocation in the in-flight counter. @internal */
export async function trackStdioRpc<T>(work: () => Promise<T>): Promise<T> {
  _stdioRpcsInFlight++;
  try {
    return await work();
  } finally {
    _stdioRpcsInFlight--;
    // A completed request is forward progress: serve's boot deadline must not
    // stop a server that is answering its client while a boot phase waits on
    // the engine behind those requests.
    noteForwardProgress();
  }
}

/**
 * The stdio session surface: one mutable allow-set per process that
 * tools/list, dispatch, the capabilities resource, whoami and gbrain_status
 * read. `request_tools {surface}` widens it for this session only (never past
 * --access read-only); each widen writes a `surface_widened` stderr line and
 * sends tools/list_changed. `finishResult` adds the once-per-process
 * `surface_env_invalid` notice to the first successful result.
 */
function stdioSurfaceSession(
  opts: { surface?: McpSurface; surfaceSource?: SurfaceSource; invalidSurfaceEnv?: string; access?: McpAccess },
  server: () => Server | null,
) {
  const session = createStdioSurfaceState(operations, {
    surface: clampSurface(opts.surface ?? 'full'), source: opts.surfaceSource ?? (opts.surface ? 'flag' : 'default'), readOnly: opts.access === 'read-only',
    onWiden: ({ from, to, added }) => {
      process.stderr.write(`[gbrain-serve] surface_widened from=${from} to=${to} op=request_tools added=${added.length}\n`);
      Promise.resolve(server()?.sendToolListChanged()).catch(() => { /* best-effort */ });
    },
  });
  let pending: Notice | null = opts.invalidSurfaceEnv ? surfaceEnvInvalidNotice(opts.invalidSurfaceEnv, session.surface, session.source) : null;
  const finishResult = (result: ToolResult): ToolResult => {
    if (!pending || result.isError) return result;
    const rendered = renderNotice(pending, dispatchRenderContext({ transport: 'stdio', remote: true, surface: session.surface, allowedOps: session.allowedOps }));
    result.content.push({ type: 'text', text: noticeBlock(rendered) });
    result._meta = { ...(result._meta ?? {}), gbrain_notices: [...((result._meta?.gbrain_notices as unknown[]) ?? []), rendered] };
    pending = null;
    return result;
  };
  const statusResult = (state: NonNullable<ReturnType<typeof statusModeOf>>) => {
    const status = statusToolResult(state);
    status.content[0].text = JSON.stringify({ ...JSON.parse(status.content[0].text), surface: session.surface, surface_source: session.source }, null, 2);
    return status;
  };
  return { session, finishResult, statusResult };
}

export interface McpServerOptions {
  surface?: McpSurface; surfaceSource?: SurfaceSource; invalidSurfaceEnv?: string;
  sourceGuard?: boolean; onBootPhase?: (phase: string) => void; access?: McpAccess;
  /** Shared owners supply a separate transport and source context per session. */
  session?: { transport: Transport; cwd: string; envSource?: string };
}

export async function startMcpServer(engine: BrainEngine, opts: McpServerOptions = {}) {
  const config = loadConfig();
  const sourceScopeForSession = () => resolveMcpStdioSourceScope(engine, opts.session?.cwd, opts.session);
  const bootPhase = (phase: string) => { try { opts.onBootPhase?.(phase); } catch { /* diagnostic only */ } };
  // Refuse to serve a well-formed GBRAIN_SOURCE that no active source row
  // backs (see source-preflight.ts). Throws before any transport is attached.
  bootPhase('source_preflight');
  await assertStdioSourceBindable(engine, opts.session ? opts.session.envSource ?? '' : process.env.GBRAIN_SOURCE);
  // MEMORY_VERBS v1 surface mode: 'full' (default — every op, byte-identical
  // to pre-surface behavior), 'starter' (WP4 daily-driver set), or 'verbs'
  // (exactly the 7 protocol verbs). Enforced BOTH on the advertised list and
  // in dispatch (fail-closed [c2]). WP4: the GBRAIN_MCP_FORCE_SURFACE kill
  // switch min()s in (narrow-only, FOV-6a). Note stdio keeps localOnly ops
  // on every surface tier that includes them — it IS the local surface (D7,
  // the transport-LOCALITY axis). Publish gates are the separate owner-
  // CONSENT axis keyed on ctx.remote === false only, and stdio dispatches
  // remote:true — so gate-off ops are subtracted per tools/list below.
  // (Resolved before Server construction: the initialize instructions need
  // the allowed-op set to decide whether extract_facts may be advertised.)
  let server: Server | null = null;
  const { session, finishResult, statusResult } = stdioSurfaceSession(opts, () => server);

  // Ambient writeback (opt-in, default off): resolved ONCE at boot — a
  // config flip needs a serve restart on this lane, the same posture as
  // `mcp.strict_params` below. Uses the fail-closed dual-plane resolver
  // rather than a file-only read (deliberate deviation from the file-plane
  // boot rule): the visibility POSTURE lives in the DB plane, and a partial
  // file-only resolve could embed a `world` posture against an explicitly
  // private brain. Read failure here yields the OFF bundle — no section,
  // never a wrong posture — and the engine is already connected by the time
  // serve reaches this call.
  bootPhase('writeback_config');
  // F4 status-only mode: never touch the lazy engine at boot (its gated
  // reconnect belongs to tool calls).
  const statusMode = statusModeOf(engine);
  const writeback = statusMode ? null : await resolveWritebackConfig(engine, config);
  const writebackOpts = writeback ? ambientOptsFrom(writeback, {
    remember: session.allowedOps ? session.allowedOps.has('remember') : true,
    extractFacts: session.allowedOps ? session.allowedOps.has('extract_facts') : true,
  }) : null;
  server = new Server(
    { name: 'gbrain', version: VERSION },
    // listChanged: a client that handshakes during DEGRADED mode receives the
    // gate-hidden catalog (stdioVisibleTools fail-closes every publishGateKey
    // op on engine failure) and caches it — recovery sends the notification
    // so the full catalog comes back without a harness restart.
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      // #4748: canonical contract (+ opt-in ambient-writeback section) plus the
      // optional operator-set deployment identity, appended last.
      instructions: resolveMcpInstructions(config, process.env, { writeback: writebackOpts }),
    },
  );
  const listing = stdioToolListing(() => resolveAdvertisedSurface(isEngineDegraded(engine) ? null : engine, config), session, server);
  // F1: callable-set contract + readiness tail (or status-only line), resolved at client initialize.
  installInstructionsResolver(server, async () => {
    if (statusMode && isEngineDegraded(engine)) {
      return resolveMcpInstructions(config, process.env, { tools: { callable: n => n === STATUS_TOOL_NAME, statusLine: statusInstructionLine(statusMode) } });
    }
    const visibleOps = await stdioVisibleTools(engine, session.surfacedOps), visible = new Set(visibleOps.map(op => op.name));
    return resolveMcpInstructions(config, process.env, {
      writeback: writebackOpts,
      tools: { callable: n => visible.has(n), readiness: await instructionReadiness(engine, config, 'stdio'), hiddenCallable: visibleOps.length - (await listing.listed(visibleOps)).length },
    });
  });

  // WP3: strict-params schema emission, resolved ONCE at startup from the
  installCapabilitiesResource(server, async () => {
    if (statusMode && isEngineDegraded(engine)) return { transport: 'stdio', status_only: statusPayload(statusMode) };
    const scope = await sourceScopeForSession();
    const available = (await stdioVisibleTools(engine, session.surfacedOps)).map(op => op.name);
    let scopes: readonly string[] = [];
    if (!isEngineDegraded(engine)) {
      try {
        const verified = await verifyLocalWriter(engine, await readLocalWriter(engine, 'stdio'));
        if (verified.remote) scopes = verified.grant.scopes;
      } catch {}
    }
    return { transport: 'stdio', scopes, surface: session.surface, surface_source: session.source, access: session.readOnly ? 'read-only' : 'full', source_id: scope.sourceId,
      available_operations: available,
      administration: mcpAdministrationGuidance(),
      shared_skills: { protocol_version: 2, catalog: available.includes('list_skills') && available.includes('get_skill'),
        can_join: available.includes('join_brain'), can_edit: available.includes('put_skill') && available.includes('delete_skill'), native_activation: 'unverified' },
      ...await stdioCapabilityReadiness(engine, config),
      note: 'This local MCP pipe has no OAuth profile; agent-facing operation restrictions still apply.' };
  }, createSkillResources(engine, async () => {
    const scope = await sourceScopeForSession();
    return { remote: true, transport: 'stdio', sourceId: scope.sourceId,
      localFederatedSourceIds: scope.localFederatedSourceIds, allowedOps: session.allowedOps, surface: session.surface, config: config ?? undefined };
  }));

  // FILE config plane only — stdio has no per-request list cycle, so a
  // `mcp.strict_params` flip needs a serve restart here (deliberate; the
  // OAuth HTTP path re-reads dual-plane per request).
  const strictParams = parseStrictParamsMode(config?.mcp?.strict_params) === 'reject';
  // C1: row shape resolved once at boot like strict_params (stdio has no thin client; a degraded engine reads the file plane).
  const resultRows = isEngineDegraded(engine)
    ? parseResultRowsMode(config?.mcp?.result_rows) ?? 'lean'
    : await resolveResultRowsMode(engine, config);
  session.widenAllowed = await sessionWidenAllowed(isEngineDegraded(engine) ? null : engine, config);

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape. Publish-gate
  // subtraction happens per request (stdioVisibleTools) — no caching, so a
  // `gbrain config set mcp.publish_skills true` takes effect on the next
  // tools/list without a serve restart (matches the HTTP transports).
  server.setRequestHandler(ListToolsRequestSchema, async () => trackStdioRpc(async () => ({
    tools: statusMode && isEngineDegraded(engine)
      ? [STATUS_TOOL_DEF]
      : buildToolDefs(await listing.listed(await stdioVisibleTools(engine, session.surfacedOps)), { strictParams }),
  })));

  // #4583 (fixes #4564's misrouted-write symptom): once-per-process advisory
  // for unscoped default writes on a multi-source brain; latch semantics live
  // in createDefaultWriteAdvisory above. Skipped under --source-guard (the
  // opt-in fail-closed guard owns that lane).
  const defaultWriteAdvisory = createDefaultWriteAdvisory(engine, { enabled: !opts.sourceGuard });

  // Dispatch tool calls via shared dispatch.ts (parity with HTTP transport).
  // MCP stdio callers are remote/untrusted; dispatch defaults remote=true.
  // The MCP SDK's response type widened in 1.29 to allow a managed-task wrapper;
  // gbrain ops are synchronous, so we return the legacy `{ content, isError? }`
  // shape and cast through `any` (the SDK accepts it via the ServerResult union).
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => trackStdioRpc(async () => {
    const { name, arguments: params } = request.params;
    // F4: status-only mode answers gbrain_status and refuses the rest until
    // a tool call's re-probe finds the brain openable (then dispatch normally).
    if (statusMode) {
      const open = await attemptStatusRecovery(engine, statusMode);
      if (name === STATUS_TOOL_NAME) return statusResult(statusMode);
      if (!open) return statusModeErrorResult(statusMode, name);
    }
    // #3242 / #3906: stdio resolves its source through the same ambient chain
    // as local CLI dispatch: GBRAIN_SOURCE, then .gbrain-source, then the
    // non-explicit fallback tiers. Non-explicit tiers may widen to federated
    // local reads; explicit/env/dotfile scopes stay scalar.
    const sourceScope = await sourceScopeForSession();
    // v0.28: stdio MCP has no per-token auth (local pipe). Default the
    // takes-holder allow-list to ['world'] so agent-facing callers don't
    // see private hunches via takes_list / takes_search / query. Operators
    // who want stdio to see everything should call ops directly via
    // `gbrain call <op>` (sets remote=false in src/cli.ts).
    // CX2-11: MCP carries `_meta.session_id` as a sibling of `arguments` in
    // request.params. Thread it (clamped in dispatch) into the typed
    // OperationContext.sessionId so the hot-memory metaHook's cache keys per
    // session instead of collapsing every caller onto the null-session key.
    const sessionId = requestMetaSessionId(request.params);
    // #4583 rework: warn (once per process) when a MUTATING call's RESOLVED
    // source scope actually lands in 'default' (tier seed_default) on a
    // bulk-non-default brain. Keyed on the already-computed resolution tier —
    // NOT on raw GBRAIN_SOURCE presence — so dotfile / local_path /
    // brain_default pins never false-positive. No `--source` flag exists on
    // this transport, so warn instead of refusing the agent's write.
    await defaultWriteAdvisory(
      sourceScope.tier,
      operations.find(o => o.name === name)?.mutating === true,
    );
    return finishResult(await dispatchToolCall(engine, name, params, {
      ...(opts.session ? { cwd: opts.session.cwd } : {}),
      remote: true,
      // #1061: mark the transport so whoami can report {transport: 'stdio'}
      // instead of throwing unknown_transport. Trust posture unchanged —
      // stdio stays remote/untrusted.
      transport: 'stdio',
      takesHoldersAllowList: ['world'],
      ...(sessionId ? { sessionId } : {}),
      sourceId: sourceScope.sourceId,
      ...(sourceScope.localFederatedSourceIds
        ? { localFederatedSourceIds: sourceScope.localFederatedSourceIds }
        : {}),
      ...(sourceScope.explicitReadBinding
        ? { explicitReadBinding: sourceScope.explicitReadBinding }
        : {}),
      // --source-guard (plugin lanes): thread the winning resolution tier so
      // dispatch can fail-close ambient-tier writes. Off (undefined) unless
      // the serve was started with the flag.
      ...(opts.sourceGuard ? { sourceGuardTier: sourceScope.tier } : {}),
      // v0.31 (eD3): _meta.brain_hot_memory injection so Claude Desktop /
      // Code see the brain's relevant hot memory automatically alongside
      // every tool-call response. Best-effort; absorbs errors.
      metaHook: getBrainHotMemoryMeta,
      // MEMORY_VERBS v1: fail-closed surface enforcement + usage attribution.
      ...(session.allowedOps ? { allowedOps: session.allowedOps } : {}),
      surface: session.surface,
      // WP4 (D2): stdio has no per-client rows; its surface is the ceiling
      // request_tools bounds its catalog by; its {surface} call widens the session.
      surfaceCeiling: session.surface, stdioSurface: session, revealTools: listing.reveal,
      resultRows,
    }));
  }));

  const transport = opts.session?.transport ?? new StdioServerTransport();
  bootPhase('mcp_connect');
  await server.connect(transport);
  // Session close must never disconnect the common engine or exit its owner.
  if (opts.session) return server;

  // Engine-dependent boot: the resolve-IPC listener, session-cursor GC, and
  // the startup maintenance sweep all touch the engine. In DEGRADED mode
  // (db-availability 4c) they are DEFERRED until the first successful
  // reconnect — running them against a dead engine would burn reconnect
  // attempts on background work instead of tool calls.
  let ipcBinding: { close: () => void } | null = null;
  let startupSweep: { cancel: () => void } | null = null;
  const bootEngineDependents = async (): Promise<void> => {
    // Retrieval Reflex (#1981, D9=C): the resolve/turn_context/context_pack
    // (+ delegated sync/sweep) IPC listener. Wiring shared with `serve --http`
    // via bindResolveIpcForServe (#4474) — best-effort; failure to bind never
    // blocks the MCP server.
    bootPhase('source_scope');
    const { sourceId: ipcSourceId } = await resolveMcpStdioSourceScope(engine);
    bootPhase('persistence_consumer');
    const persistence = await createPersistenceIpcProvider(engine, residentPersistenceConfig(config) ?? { engine: engine.kind });
    bootPhase('resolve_ipc_bind');
    ipcBinding = await bindResolveIpcForServe(engine, ipcSourceId, persistence, { rememberCallable: () => !session.allowedOps || session.allowedOps.has('remember') });

    // v0.45.7 ambient recall: age out stale session cursors once per serve boot
    // (7-day TTL, indexed DELETE). Best-effort — GC failure never blocks serve.
    gcSessionContextState(engine).catch(() => {});

    // Startup maintenance sweep [ENG-5][CX-P0.1+P0.3]: the serve process is
    // the lock owner, so it runs the bounded sweep that ingests the corpus +
    // reconciles fences/links/timeline for recent workspace writes. Same
    // best-effort shape as the resolve-IPC block above: fires once ~3s after
    // connect, unref'd (can never hold the process open), all errors
    // swallowed inside armStartupSweep. Kill switch: GBRAIN_SWEEP=0 (checked
    // inside the helper). Lazy import keeps sweep code off the boot path.
    startOnboardingRefresher(engine, { idle: () => _stdioRpcsInFlight === 0 }).catch(() => { /* coaching is best-effort */ });
    bootPhase('startup_sweep');
    try {
      const { armStartupSweep } = await import('../core/sweep.ts');
      const { sourceId } = await resolveMcpStdioSourceScope(engine);
      startupSweep = armStartupSweep(engine, {
        sourceId,
      });
    } catch {
      /* startup sweep is best-effort; never block serve */
    }
  };

  if (isEngineDegraded(engine)) {
    // Structured enter/exit lines for harness-log forensics.
    process.stderr.write(statusMode
      ? `[gbrain-serve] STATUS-ONLY: ${statusHeadline(statusMode)} Serving gbrain_status; the full tool list returns once a tool call finds the brain openable. Supervisors: --fail-fast exits instead.\n`
      : '[gbrain-serve] DEGRADED: database unreachable at startup — tool calls return classified errors (GBRAIN_DB_ACCESS) and the server reconnects automatically. Fix: gbrain db-repair. Kill switch: GBRAIN_SERVE_DEGRADED=0.\n');
    onEngineRecovered(engine, () => {
      // A reconnect can complete while shutdown is already draining (stdin
      // EOF during the attempt) — booting IPC/sweep on an exiting process
      // would leak a socket binding past the shutdown close.
      if (shuttingDown) return;
      process.stderr.write('[gbrain-serve] RECOVERED: database reachable — full service restored.\n');
      // Refresh clients holding the degraded (gate-hidden) tool catalog.
      Promise.resolve(server.sendToolListChanged()).catch(() => { /* best-effort */ });
      bootEngineDependents().catch(() => { /* deferred boot is best-effort */ });
    });
  } else {
    await bootEngineDependents();
  }

  // Exit cleanly when MCP client disconnects (stdin EOF) or on signals.
  // Without this, orphaned serve processes accumulate and contend for the
  // PGLite write lock, causing ingest jobs (email-sync) to time out.
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[gbrain-serve] shutdown: ${reason}\n`);
    try { startupSweep?.cancel(); } catch { /* noop */ }
    ipcBinding?.close();
    // Cathedral 5: abort the in-flight checkpoint harvest + drop its queue
    // BEFORE engine.disconnect — the background-work registry's drain is
    // CLI-exit-only by contract, and a fire-and-forget DB writer surviving
    // disconnect busy-loops the single-writer lock (the #1762 hazard class).
    import('../core/context/checkpoint-harvest.ts')
      .then((m) => m.shutdownCheckpointHarvest())
      .catch(() => {})
      // Delegated-sync settle BEFORE disconnect (idempotent shared promise —
      // serve.ts's beginShutdown races here on the same signals): the job's
      // final checkpoint flush and row-lock release need the live engine.
      .then(() => import('../core/serve-sync-runner.ts').then((m) => m.shutdownDelegatedSync()))
      .catch(() => {})
      .then(() => Promise.resolve(engine.disconnect?.()))
      .catch(() => {})
      .finally(() => process.exit(code));
  };
  // v0.34.1 (#870): when MCP_STDIO=1, the wrapping gateway (OpenClaw's
  // bundle-mcp layer, others) often pipes the JSON-RPC handshake then
  // closes its stdin half. Treating that as a permanent disconnect kills
  // the server before the first tool call arrives. Signal handlers and
  // transport.onclose still cover the legitimate shutdown paths.
  if (process.env.MCP_STDIO !== '1') {
    process.stdin.on('end', () => shutdown('stdin end'));
    process.stdin.on('close', () => shutdown('stdin close'));
  }
  // @ts-ignore — SDK exposes onclose on transport
  transport.onclose = () => shutdown('transport close');
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Backward compat: used by `gbrain call` command (trusted local path).
// v0.31.8 (D22): accept opts.sourceId so `gbrain call --source X <op> <json>`
// can scope the op handler to that source. resolveSourceWithTier() in call.ts
// is the upstream resolver; this layer just passes the resolved id through.
// #3874: also accept opts.localFederatedSourceIds so an ambient-tier
// resolution widens unqualified reads across federated sources exactly like
// the direct CLI path (cli.ts makeContext) does.
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
  opts?: { sourceId?: string; localFederatedSourceIds?: string[]; writeWaitMs?: number },
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw opError('unknown_tool', `Unknown tool: ${tool}`, 'Run `gbrain --tools-json` to list the tool names.');

  const validationFailure = findInvalidParam(op, params);
  if (validationFailure) throw schemaInvalidParams(op, validationFailure, {});

  const ctx = buildOperationContext(engine, params, {
    remote: false,
    logger: { info: console.log, warn: console.warn, error: console.error },
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts?.writeWaitMs !== undefined ? { writeWaitMs: opts.writeWaitMs } : {}),
    ...(opts?.localFederatedSourceIds
      ? { localFederatedSourceIds: opts.localFederatedSourceIds }
      : {}),
  });

  return op.handler(ctx, params);
}
