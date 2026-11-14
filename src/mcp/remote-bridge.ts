/**
 * Thin-client `gbrain serve`: a stdio MCP server that relays every request to
 * the remote brain with this install's stored OAuth credential (#8543).
 *
 * Nothing here opens an engine or runs an operation handler, and no page text
 * is stored on this machine. The host decides every call: `tools/list` is the
 * host's own list for this client's token (narrowed, never widened, by
 * `--surface` / `--advertise`), and `tools/call` returns the host's
 * `CallToolResult` byte-identical, `isError` envelopes and pending write
 * receipts included. Each relayed call reaches the host as an ordinary remote
 * OAuth caller (`remote: true`); this process never builds an
 * OperationContext, so nothing in it can act as the trusted local CLI.
 *
 * Bridge-built answers (a transport failure, a refusal that never left this
 * machine, a bridge fault) are v1 envelopes from remote-bridge-errors.ts.
 * stdout carries JSON-RPC only; the bridge's own lines go to stderr as
 * `[gbrain-bridge]`. The lifecycle (signals, bounded EOF drain, MCP_STDIO=1,
 * parent watchdog) is local serve's, from stdio-lifecycle.ts.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RenderContext } from '../core/agent-output.ts';
import { configDir, type GBrainConfig } from '../core/config.ts';
import { forwardRemoteToolCall, listRemoteToolDefs, RemoteMcpError, type RemoteToolDefs } from '../core/mcp-client.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import type { Operation, OperationMeta } from '../core/ops/contract.ts';
import { isPersistenceIpcMutation } from '../core/persistence/ipc.ts';
import { VERSION } from '../version.ts';
import { hiddenToolHint } from './hidden-tool-hint.ts';
import { installInstructionsResolver, MCP_SERVER_DESCRIPTION, resolveMcpInstructions } from './instructions.ts';
import { BRIDGE_LOG_PREFIX, bridgeCallFailure, bridgeInternalFailure, bridgeListFailure, bridgeRefusal, endpointLabel, writeBridgeTrace, type BridgeErrorContext } from './remote-bridge-errors.ts';
import { installStdioShutdownTriggers, mcpStdioTransport, probeWatchdogAvailable, readLiveParentPid, resolveEofDrainMs, type StdioLifecycleDeps } from './stdio-lifecycle.ts';
import { clampSurface, createStdioSurfaceState, isMcpSurface, resolveStdioSurface, sessionWidenAllowed, stdioToolListing, surfaceWiderThan, SURFACE_SOURCE_LABEL, type McpSurface } from './surface.ts';
import { stripUrlSecrets } from '../core/url-redact.ts';

/** The client name the host sees. Not the thin client's, so the host serves the lean rows and windowed pages any remote agent gets. */
export const BRIDGE_CLIENT_NAME = 'gbrain-stdio-bridge';
/** Per-call timeout (the CLI's think default); the SDK's own 60 s would cut think off. `gbrain --timeout=Ns serve` overrides it. */
export const BRIDGE_DEFAULT_TIMEOUT_MS = 180_000;
/** The first gbrain whose hosts enforce a request-level `_meta.on_behalf_of` and report it as `_meta.access.audience`. */
export const AUDIENCE_MIN_HOST_VERSION = '0.60.543.0';

export interface RemoteBridgeOptions {
  surface?: McpSurface | null;
  advertise?: McpSurface | null;
  sourceGuard?: boolean;
  timeoutMs?: number;
  /** Test seams; production uses the process's stdio and the real remote calls. */
  transport?: () => Transport;
  lifecycle?: Partial<StdioLifecycleDeps>;
  mcpStdio?: boolean;
  eofDrainMs?: number;
  installFatalHandlers?: boolean;
  list?: typeof listRemoteToolDefs;
  forward?: typeof forwardRemoteToolCall;
}

/** Whether a host's initialize `serverInfo` names a gbrain at least `min` (four-part versions). */
export function hostAtLeast(server: { name?: string; version?: string } | undefined, min: string): boolean {
  if (server?.name !== 'gbrain' || typeof server.version !== 'string') return false;
  const have = server.version.split('.').map(Number);
  const need = min.split('.').map(Number);
  if (have.some(n => !Number.isInteger(n))) return false;
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  }
  return true;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Start the bridge on this process's stdio. Resolves once the transport is connected; the lifecycle exits the process. */
export async function startRemoteStdioBridge(cfg: GBrainConfig, opts: RemoteBridgeOptions = {}): Promise<void> {
  const deps: StdioLifecycleDeps = {
    stdin: process.stdin, signals: process, exit: (code?: number) => { process.exit(code); }, log: (msg: string) => console.error(msg),
    getParentPid: readLiveParentPid, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    probeWatchdog: probeWatchdogAvailable, ...opts.lifecycle,
  };
  const log = (line: string) => deps.log(stripUrlSecrets(line));
  const home = configDir();
  const fatal = (stage: string, error: unknown) => {
    const trace = writeBridgeTrace(home, error, { stage });
    log(`${BRIDGE_LOG_PREFIX} code=internal_error version=${VERSION} stage=${stage} diagnostic=${trace.id}${trace.path ? ` trace=${trace.path}` : ''}`);
    deps.exit(1);
  };
  if (opts.installFatalHandlers !== false) {
    process.on('uncaughtException', (e) => fatal('uncaught_exception', e));
    process.on('unhandledRejection', (e) => fatal('unhandled_rejection', e));
  }
  try {
    await runBridge(cfg, opts, deps, log, home);
  } catch (error) {
    fatal('startup', error);
  }
}

async function runBridge(cfg: GBrainConfig, opts: RemoteBridgeOptions, deps: StdioLifecycleDeps, log: (line: string) => void, home: string): Promise<void> {
  const remote = cfg.remote_mcp;
  const mcpUrl = remote?.mcp_url ?? '';
  const timeoutMs = opts.timeoutMs ?? BRIDGE_DEFAULT_TIMEOUT_MS;
  const list = opts.list ?? listRemoteToolDefs;
  const forward = opts.forward ?? forwardRemoteToolCall;
  const byName = new Map<string, OperationMeta>(OPERATION_MANIFEST.map(op => [op.name, op]));

  const resolved = resolveStdioSurface(opts.surface ?? null, cfg);
  if (resolved.invalidEnv !== undefined) {
    log(`${BRIDGE_LOG_PREFIX} surface_env_invalid: ignoring GBRAIN_SURFACE="${resolved.invalidEnv}" (use verbs | starter | full); serving '${resolved.surface}' (source: ${SURFACE_SOURCE_LABEL[resolved.source]})`);
  }
  let server: Server | null = null;
  const notify = () => { Promise.resolve(server?.sendToolListChanged()).catch(() => { /* best-effort */ }); };
  const session = createStdioSurfaceState(OPERATION_MANIFEST, {
    surface: clampSurface(resolved.surface), source: resolved.source, readOnly: false,
    onWiden: ({ from, to, added }) => { log(`${BRIDGE_LOG_PREFIX} surface_widened from=${from} to=${to} op=request_tools added=${added.length}`); notify(); },
  });
  session.widenAllowed = await sessionWidenAllowed(null, cfg);
  const advertise = opts.advertise ?? null;
  const listing = stdioToolListing(async () => advertise, session, { sendToolListChanged: async () => notify() });
  const listingNarrowed = () => session.allowedOps !== undefined || (advertise !== null && surfaceWiderThan(session.surface, advertise));
  const hostNames = new Set<string>();
  const warnedUnknown = new Set<string>();
  const render: RenderContext = {
    transport: 'stdio', surface: session.surface,
    isCallable: (n) => hostNames.has(n) && (!session.allowedOps || session.allowedOps.has(n)),
    preapproved: () => false,
  };
  const errCtx: BridgeErrorContext = { render, mcpUrl, clientId: remote?.oauth_client_id, timeoutMs };

  log(`${BRIDGE_LOG_PREFIX} relaying stdio to ${endpointLabel(mcpUrl)} surface=${session.surface} (source: ${SURFACE_SOURCE_LABEL[resolved.source]})${advertise ? ` advertise=${advertise}` : ''}`);
  if (opts.sourceGuard) {
    log(`${BRIDGE_LOG_PREFIX} --source-guard: write routing follows this client's source grant on the brain host; the bridge enforces nothing locally`);
  }

  /** The host's tools for this token that this session may call, before the advertise listing. */
  const callableTools = (defs: RemoteToolDefs): Tool[] => {
    hostNames.clear();
    for (const t of defs.tools) hostNames.add(t.name);
    const hostTools = defs.tools.filter(t => !byName.get(t.name)?.localOnly && !byName.get(t.name)?.cliOnly);
    if (!listingNarrowed()) return hostTools;
    const unknown = hostTools.filter(t => !byName.has(t.name) && !warnedUnknown.has(t.name)).map(t => t.name);
    if (unknown.length) {
      for (const n of unknown) warnedUnknown.add(n);
      log(`${BRIDGE_LOG_PREFIX} not listing ${unknown.length} host tool(s) this gbrain does not know under a narrowed surface: ${unknown.join(', ')}`);
    }
    return hostTools.filter(t => byName.has(t.name) && (!session.allowedOps || session.allowedOps.has(t.name)));
  };
  const listedTools = async (defs: RemoteToolDefs): Promise<Tool[]> => {
    const callable = callableTools(defs);
    if (!listingNarrowed()) return callable;
    const names = new Set((await listing.listed(callable.map(t => byName.get(t.name)!))).map(op => op.name));
    return callable.filter(t => names.has(t.name));
  };

  server = new Server({ name: 'gbrain', version: VERSION, description: MCP_SERVER_DESCRIPTION },
    { capabilities: { tools: { listChanged: true } }, instructions: resolveMcpInstructions(cfg, process.env) });
  installInstructionsResolver(server, async () => {
    const relay = `This MCP server is a gbrain stdio bridge: it relays every call to the remote brain at ${endpointLabel(mcpUrl)}, which decides what each call may read or write.`;
    try {
      const defs = await list(cfg, { clientName: BRIDGE_CLIENT_NAME, timeoutMs: Math.min(timeoutMs, 15_000) });
      return `${defs.instructions ?? resolveMcpInstructions(cfg, process.env)}\n\n${relay}`;
    } catch {
      return `${resolveMcpInstructions(cfg, process.env)}\n\n${relay}`;
    }
  });

  let inFlight = 0;
  const writes = new Map<number, { tool: string; requestId?: string }>();
  let nextCall = 0;
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    inFlight++;
    try { return await work(); } finally { inFlight--; }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => track(async () => {
    try {
      return { tools: await listedTools(await list(cfg, { clientName: BRIDGE_CLIENT_NAME, timeoutMs })) };
    } catch (e) {
      if (!(e instanceof RemoteMcpError)) throw e;
      const { error, line } = bridgeListFailure(e, errCtx);
      log(line);
      throw error;
    }
  }));

  /** `request_tools {surface}` is this session's own widen (never forwarded, so nothing is written on the host). */
  const widenSession = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const requested = args.surface;
    if (!isMcpSurface(requested)) {
      return bridgeRefusal({ code: 'invalid_params', message: 'request_tools surface must be one of: verbs, starter, full.', why: 'The bridge widens its own session surface and knows only these three.',
        suggestion: 'Call request_tools {"surface":"starter"} or {"surface":"full"}.' }, render) as CallToolResult;
    }
    const persistent = `For a lasting change, set GBRAIN_SURFACE=${requested} in the env of this harness's MCP server entry for gbrain (or edit its --surface) and start a new session.`;
    session.widenAllowed = await sessionWidenAllowed(null, cfg);
    if (!session.widenAllowed) {
      return bridgeRefusal({ code: 'permission_denied', message: 'Session widening is off for this bridge (mcp.allow_session_widen is false), so request_tools cannot add tools to it.',
        why: 'The owner of this machine turned stdio session widening off.', suggestion: persistent,
        fix: { argv: ['gbrain', 'serve', '--surface', requested], consent: [], actor: 'user', requires_exclusive: false, why: `The bridge surface is a start flag of this harness entry. ${persistent}` } }, render) as CallToolResult;
    }
    const target = clampSurface(requested);
    let change: Record<string, unknown>;
    if (!surfaceWiderThan(target, session.surface)) {
      change = { persisted: false, scope: 'session', surface: session.surface, widened: false,
        note: target !== requested ? `GBRAIN_MCP_FORCE_SURFACE caps this bridge at '${target}', so this session stays at '${session.surface}'.` : `This session already serves '${session.surface}', which includes everything in '${requested}'.` };
    } else {
      const widened = session.widen(target);
      render.surface = session.surface;
      const added = new Set(widened.added);
      const tools = callableTools(await list(cfg, { clientName: BRIDGE_CLIENT_NAME, timeoutMs })).filter(t => added.has(t.name));
      change = { persisted: false, scope: 'session', surface: target, previous: widened.from, tools,
        note: `This session now serves '${target}' (tools/list_changed was sent). Call the new tools by name now; their schemas are above. Only tools the brain host grants this client are added. ${persistent}` };
    }
    if (args.tools === undefined) return { content: [{ type: 'text', text: JSON.stringify(change, null, 2) }] };
    const described = await relay('request_tools', { tools: args.tools }, undefined, undefined);
    return withBody(described, body => ({ ...body, surface_change: change }));
  };

  /** Rewrite a relayed request_tools answer for this session: its catalog note, and which described tools this session can call now. */
  const sessionRequestTools = (result: CallToolResult): CallToolResult => withBody(result, body => {
    const out = { ...body };
    if (Array.isArray(body.catalog)) {
      out.note = 'Call request_tools {tools: ["name", ...]} for full schemas, or {surface: "starter"|"full"} to add those tools to this session (nothing is written).';
      if (session.allowedOps && !session.widenAllowed) {
        const allowed = session.allowedOps;
        out.catalog = (body.catalog as Array<{ area: string; tools: Array<{ name: string }> }>).map(g => ({ ...g, tools: g.tools.filter(t => allowed.has(t.name)) })).filter(g => g.tools.length);
        out.total_tools = (out.catalog as Array<{ tools: unknown[] }>).reduce((n, g) => n + g.tools.length, 0);
      }
    }
    if (Array.isArray(body.tools) && body.tools.length && listingNarrowed()) {
      const names = (body.tools as Array<{ name?: unknown }>).map(t => t.name).filter((n): n is string => typeof n === 'string');
      const reachable = names.filter(n => !session.allowedOps || session.allowedOps.has(n));
      const outside = names.filter(n => !reachable.includes(n));
      listing.reveal(reachable);
      out.listed = outside.length === 0;
      out.note = outside.length === 0
        ? 'These tools are now in your tool list (tools/list_changed was sent); call them directly.'
        : `${reachable.length ? `${reachable.map(n => `\`${n}\``).join(', ')} are now in your tool list (tools/list_changed was sent). ` : ''}${outside.map(n => `\`${n}\``).join(', ')} are outside this session's '${session.surface}' surface, so they are not listed and cannot be called yet: call request_tools {"surface":"full"} to add them to this session, then call them by name.`;
    }
    return out;
  });

  /** Forward one call and return the host's answer, or the bridge's envelope for a transport failure. */
  const relay = async (name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined, signal: AbortSignal | undefined): Promise<CallToolResult> => {
    const op = byName.get(name);
    const audience = meta?.on_behalf_of !== undefined;
    const sent = isPersistenceIpcMutation(name) && args.request_id === undefined && args.dry_run !== true ? { ...args, request_id: randomUUID() } : args;
    const id = nextCall++;
    if (!op || op.mutating) writes.set(id, { tool: name, ...(typeof sent.request_id === 'string' ? { requestId: sent.request_id } : {}) });
    let result: CallToolResult;
    try {
      result = await forward(cfg, name, sent, {
        clientName: BRIDGE_CLIENT_NAME, timeoutMs, ...(signal ? { signal } : {}), ...(meta ? { meta } : {}),
        ...(audience ? { admit: (host) => hostAtLeast(host, AUDIENCE_MIN_HOST_VERSION) ? null : audienceUnsupported(host?.version) } : {}),
      });
    } catch (e) {
      if (!(e instanceof RemoteMcpError)) throw e;
      return bridgeCallFailure(e, name, op, errCtx) as CallToolResult;
    } finally {
      writes.delete(id);
    }
    // A received answer is authoritative: a fault while reading it relays it unchanged.
    try {
      if (audience && op && !op.mutating && !result.isError && !Array.isArray((result._meta as { access?: { audience?: unknown } } | undefined)?.access?.audience)) {
        return audienceUnsupported(undefined);
      }
      return name === 'request_tools' && !result.isError ? sessionRequestTools(result) : result;
    } catch (error) {
      const trace = writeBridgeTrace(home, error, { stage: 'read_result', tool: name });
      log(`${BRIDGE_LOG_PREFIX} code=internal_error stage=read_result tool=${name} diagnostic=${trace.id}; relayed the host's answer unchanged`);
      return result;
    }
  };

  const audienceUnsupported = (hostVersion: string | undefined): CallToolResult => bridgeRefusal({
    code: 'host_upgrade_required',
    message: `This call names an audience (_meta.on_behalf_of), but the brain host${hostVersion ? ` (gbrain ${hostVersion})` : ''} cannot be shown to enforce one, so the bridge did not relay it.`,
    why: `A host older than gbrain ${AUDIENCE_MIN_HOST_VERSION} ignores a request-level audience and would answer with the credential's whole view; the bridge never relays an audience-narrowed call it cannot verify.`,
    suggestion: 'Upgrade gbrain on the brain host (gbrain upgrade there), or ask its operator to; until then, call without the audience only if every reader of the answer may see this credential\'s whole view.',
    fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'The audience is enforced by the brain host; only an upgrade there adds it.' },
  }, render, { client_version: VERSION, ...(hostVersion ? { host_version: hostVersion } : {}), min_host_version: AUDIENCE_MIN_HOST_VERSION }) as CallToolResult;

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => track(async () => {
    const { name, arguments: rawArgs, _meta: meta } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const op = byName.get(name);
    try {
      if (op?.localOnly || op?.cliOnly) {
        return bridgeRefusal({ code: 'unknown_tool', message: `${name} is not a tool this connection can call.`, why: `${name} runs only on the brain host itself, so no remote connection reaches it.`,
          suggestion: 'Call request_tools for the tools this connection can call.' }, render) as CallToolResult;
      }
      if (session.allowedOps && !session.allowedOps.has(name)) {
        const hint = hiddenToolHint(op as Operation | undefined, { transport: 'stdio', remote: true, surface: session.surface, allowedOps: session.allowedOps, readOnly: false }, session.widenAllowed);
        return bridgeRefusal({ code: 'unknown_tool', message: `${name} is not in this session's '${session.surface}' tool surface.`,
          why: hint ? 'The bridge was started with a narrower --surface (or GBRAIN_SURFACE) than the brain host grants.' : `${name} is not a tool this connection can call.`,
          suggestion: hint?.suggestion ?? 'Call request_tools for the tools this connection can call.', ...(hint ? { fix: hint.fix } : {}) }, render) as CallToolResult;
      }
      if (meta !== undefined && !isPlainObject(meta)) {
        return bridgeRefusal({ code: 'invalid_params', message: 'Request-level _meta must be a JSON object, so the bridge did not relay this call.',
          why: 'An audience or session id rides in _meta beside arguments; a call is never relayed with its narrowing dropped.',
          suggestion: 'Send _meta as an object beside arguments, for example {"name": "query", "arguments": {...}, "_meta": {"on_behalf_of": ["alice-example"], "session_id": "s-1"}}; never put on_behalf_of inside arguments.' }, render) as CallToolResult;
      }
      if (name === 'request_tools' && args.surface !== undefined) return await widenSession(args);
      return await relay(name, args, meta as Record<string, unknown> | undefined, extra.signal);
    } catch (error) {
      if (error instanceof RemoteMcpError) return bridgeCallFailure(error, name, op, errCtx) as CallToolResult;
      const trace = writeBridgeTrace(home, error, { stage: 'call', tool: name });
      log(`${BRIDGE_LOG_PREFIX} code=internal_error stage=call tool=${name} diagnostic=${trace.id}${trace.path ? ` trace=${trace.path}` : ''}`);
      return bridgeInternalFailure(name, 'call', trace, render) as CallToolResult;
    }
  }));

  let shuttingDown = false;
  let exitCode = 0;
  const mcpStdio = opts.mcpStdio ?? (process.env.MCP_STDIO === '1');
  // Under MCP_STDIO=1 stdin EOF is not a disconnect, and with no engine nothing else holds the event loop open.
  const keepAlive = mcpStdio ? setInterval(() => {}, 1 << 30) : undefined;
  const triggers = installStdioShutdownTriggers(deps, {
    beginShutdown: (reason) => {
      if (shuttingDown) return;
      shuttingDown = true;
      triggers.stopWatchdog();
      if (keepAlive) clearInterval(keepAlive);
      log(`${BRIDGE_LOG_PREFIX} exit (${reason})`);
      const deadline = setTimeout(() => deps.exit(exitCode), 2_000);
      deadline.unref?.();
      void Promise.resolve(server?.close()).catch(() => { /* best-effort */ }).finally(() => { clearTimeout(deadline); deps.exit(exitCode); });
    },
    isShuttingDown: () => shuttingDown,
    pendingRpcs: () => inFlight,
    // A forwarded write may take the whole call timeout; the drain waits that long before it gives up on a receipt.
    eofDrainMs: opts.eofDrainMs ?? resolveEofDrainMs(timeoutMs),
    mcpStdio,
    logPrefix: BRIDGE_LOG_PREFIX,
    onDrainExpired: () => {
      for (const w of writes.values()) {
        exitCode = 1;
        log(`${BRIDGE_LOG_PREFIX} code=write_outcome_unknown tool=${w.tool} submission_status=unknown${w.requestId ? ` request_id=${w.requestId} fix="gbrain write-request -- ${w.requestId}"` : ' fix="ask the brain host owner whether it took effect before resending"'}`);
      }
    },
  });
  server.onclose = () => triggers.drainThenShutdown('transport-close');
  await server.connect(opts.transport ? opts.transport() : mcpStdioTransport());
}

/** Apply `edit` to a result's JSON body (content[0]); any other shape passes through unchanged. */
function withBody(result: CallToolResult, edit: (body: Record<string, unknown>) => Record<string, unknown>): CallToolResult {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') return result;
  let body: unknown;
  try { body = JSON.parse(first.text); } catch { return result; }
  if (!isPlainObject(body)) return result;
  return { ...result, content: [{ ...first, text: JSON.stringify(edit(body), null, 2) }, ...result.content.slice(1)] };
}
