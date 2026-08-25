import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchToolCall, buildOperationContext } from './dispatch.ts';
import { validateParams, parseStrictParamsMode } from './validate-params.ts';
import { filterOpsForSurface, allowedOpNames, clampSurface, type McpSurface } from './surface.ts';
import { disabledOpsForPublishGates } from './publish-gates.ts';
import type { Operation } from '../core/operations.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig } from '../core/config.ts';
import { gcSessionContextState } from '../core/context/session-state.ts';
import { bindResolveIpcForServe } from './resolve-ipc-binding.ts';

export async function resolveMcpStdioSourceScope(
  engine: BrainEngine,
  cwd: string = process.cwd(),
): Promise<{ sourceId: string; localFederatedSourceIds?: string[]; tier: import('../core/source-resolver.ts').SourceTier }> {
  try {
    const { resolveSourceWithTier, localFederatedSourceIds } = await import('../core/source-resolver.ts');
    const resolved = await resolveSourceWithTier(engine, null, cwd);
    const federated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    return {
      sourceId: resolved.source_id,
      ...(federated ? { localFederatedSourceIds: federated } : {}),
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
    const env = process.env.GBRAIN_SOURCE;
    return env && isValidSourceId(env)
      ? { sourceId: env, tier: 'env' }
      : { sourceId: 'default', tier: 'seed_default' };
  }
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
  if (!surfacedOps.some(op => op.publishGateKey)) return surfacedOps;
  let gateDisabled: ReadonlySet<string>;
  try {
    gateDisabled = await disabledOpsForPublishGates(engine, loadConfig());
  } catch {
    gateDisabled = new Set(surfacedOps.filter(o => o.publishGateKey).map(o => o.name));
  }
  if (gateDisabled.size === 0) return surfacedOps;
  return surfacedOps.filter(op => !gateDisabled.has(op.name));
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
  }
}

export async function startMcpServer(engine: BrainEngine, opts: { surface?: McpSurface; sourceGuard?: boolean } = {}) {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // MEMORY_VERBS v1 surface mode: 'full' (default — every op, byte-identical
  // to pre-surface behavior), 'starter' (WP4 daily-driver set), or 'verbs'
  // (exactly the 7 protocol verbs). Enforced BOTH on the advertised list and
  // in dispatch (fail-closed [c2]). WP4: the GBRAIN_MCP_FORCE_SURFACE kill
  // switch min()s in (narrow-only, FOV-6a). Note stdio keeps localOnly ops
  // on every surface tier that includes them — it IS the local surface (D7,
  // the transport-LOCALITY axis). Publish gates are the separate owner-
  // CONSENT axis keyed on ctx.remote === false only, and stdio dispatches
  // remote:true — so gate-off ops are subtracted per tools/list below.
  const surface: McpSurface = clampSurface(opts.surface ?? 'full');
  const surfacedOps = filterOpsForSurface(operations, surface);
  const allowedOps = surface === 'full' ? undefined : allowedOpNames(operations, surface);

  // WP3: strict-params schema emission, resolved ONCE at startup from the
  // FILE config plane only — stdio has no per-request list cycle, so a
  // `mcp.strict_params` flip needs a serve restart here (deliberate; the
  // OAuth HTTP path re-reads dual-plane per request).
  const strictParams = parseStrictParamsMode(loadConfig()?.mcp?.strict_params) === 'reject';

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape. Publish-gate
  // subtraction happens per request (stdioVisibleTools) — no caching, so a
  // `gbrain config set mcp.publish_skills true` takes effect on the next
  // tools/list without a serve restart (matches the HTTP transports).
  server.setRequestHandler(ListToolsRequestSchema, async () => trackStdioRpc(async () => ({
    tools: buildToolDefs(await stdioVisibleTools(engine, surfacedOps), { strictParams }),
  })));

  // Dispatch tool calls via shared dispatch.ts (parity with HTTP transport).
  // MCP stdio callers are remote/untrusted; dispatch defaults remote=true.
  // The MCP SDK's response type widened in 1.29 to allow a managed-task wrapper;
  // gbrain ops are synchronous, so we return the legacy `{ content, isError? }`
  // shape and cast through `any` (the SDK accepts it via the ServerResult union).
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => trackStdioRpc(async () => {
    const { name, arguments: params } = request.params;
    // #3242 / #3906: stdio resolves its source through the same ambient chain
    // as local CLI dispatch: GBRAIN_SOURCE, then .gbrain-source, then the
    // non-explicit fallback tiers. Non-explicit tiers may widen to federated
    // local reads; explicit/env/dotfile scopes stay scalar.
    const sourceScope = await resolveMcpStdioSourceScope(engine);
    // v0.28: stdio MCP has no per-token auth (local pipe). Default the
    // takes-holder allow-list to ['world'] so agent-facing callers don't
    // see private hunches via takes_list / takes_search / query. Operators
    // who want stdio to see everything should call ops directly via
    // `gbrain call <op>` (sets remote=false in src/cli.ts).
    // CX2-11: MCP carries `_meta.session_id` as a sibling of `arguments` in
    // request.params. Thread it (clamped in dispatch) into the typed
    // OperationContext.sessionId so the hot-memory metaHook's cache keys per
    // session instead of collapsing every caller onto the null-session key.
    const rawMetaSession = (request.params as { _meta?: { session_id?: unknown } })?._meta?.session_id;
    const sessionId = typeof rawMetaSession === 'string' && rawMetaSession.length > 0
      ? rawMetaSession
      : undefined;
    return dispatchToolCall(engine, name, params, {
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
      // --source-guard (plugin lanes): thread the winning resolution tier so
      // dispatch can fail-close ambient-tier writes. Off (undefined) unless
      // the serve was started with the flag.
      ...(opts.sourceGuard ? { sourceGuardTier: sourceScope.tier } : {}),
      // v0.31 (eD3): _meta.brain_hot_memory injection so Claude Desktop /
      // Code see the brain's relevant hot memory automatically alongside
      // every tool-call response. Best-effort; absorbs errors.
      metaHook: getBrainHotMemoryMeta,
      // MEMORY_VERBS v1: fail-closed surface enforcement + usage attribution.
      ...(allowedOps ? { allowedOps } : {}),
      surface,
      // WP4 (D2): stdio has no per-client rows; its surface is the ceiling
      // request_tools bounds its catalog by (persist no-ops without auth).
      surfaceCeiling: surface,
    });
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Retrieval Reflex (#1981, D9=C): the resolve/turn_context/context_pack
  // (+ delegated sync/sweep) IPC listener. Wiring shared with `serve --http`
  // via bindResolveIpcForServe (#4474) — best-effort; failure to bind never
  // blocks the MCP server.
  const ipcBinding = await bindResolveIpcForServe(
    engine,
    (await resolveMcpStdioSourceScope(engine)).sourceId,
  );

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
  let startupSweep: { cancel: () => void } | null = null;
  try {
    const { armStartupSweep } = await import('../core/sweep.ts');
    const { sourceId } = await resolveMcpStdioSourceScope(engine);
    startupSweep = armStartupSweep(engine, {
      sourceId,
    });
  } catch {
    /* startup sweep is best-effort; never block serve */
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
    ipcBinding.close();
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
  opts?: { sourceId?: string; localFederatedSourceIds?: string[] },
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx = buildOperationContext(engine, params, {
    remote: false,
    logger: { info: console.log, warn: console.warn, error: console.error },
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts?.localFederatedSourceIds
      ? { localFederatedSourceIds: opts.localFederatedSourceIds }
      : {}),
  });

  return op.handler(ctx, params);
}
