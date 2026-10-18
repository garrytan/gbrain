/**
 * F6 + D2: the one hidden-tool decision. `hiddenToolRoute` says how a
 * connection reaches a tool it does not list: it is already callable (name
 * it; stdio reveals it), one `request_tools {surface}` call makes it
 * callable (stdio: this session only, nothing written; HTTP: the client's own
 * surface, within the server ceiling and never past an operator pin), or
 * only the brain host can change that (read-only access, the server surface,
 * the grant). A widen is offered only when the widened connection could
 * actually call the tool: never past `--access read-only`, the force-surface
 * clamp, the grant's snapshot or its scopes.
 *
 * `hiddenToolHint` is F6's unknown_tool hint on the owner's stdio pipe: a
 * stdio caller that names a real tool outside this server's surface learns
 * that the tool exists and how to reach it. The stdio pipe is the brain
 * owner's own process, so this is not an existence oracle; HTTP keeps the
 * opaque unknown_tool envelope. D2's in-band `next` for content a hidden tool
 * serves (`hiddenToolNext`) uses the same route on every transport.
 */
import type { Action, McpCall } from '../core/agent-output.ts';
import type { Operation, OperationMeta } from '../core/ops/contract.ts';
import { cliEquivalent } from '../core/ops/cli-equivalent.ts';
import { clampSurface, filterOpsForSurface, isReadOnlyOperation, surfaceWiderThan, type McpSurface } from './surface.ts';

const PERSISTENT_ROUTE = 'To keep the full surface for new sessions, set GBRAIN_SURFACE=full in the env of this harness\'s MCP server entry for gbrain '
  + '(`claude mcp add gbrain -e GBRAIN_SURFACE=full -- …`, the env table of the Codex server entry, or the plugin\'s GBRAIN_SURFACE setting on launcher installs), '
  + 'or re-register the server with `--surface full`. An inherited GBRAIN_SURFACE overrides a pinned --surface.';

/** What the route decision reads about one connection. */
export interface ToolConnection {
  transport?: string;
  /** The surface this connection serves now. */
  surface?: McpSurface;
  /** stdio `--access read-only`: a widen never adds a write tool. */
  readOnly?: boolean;
  /** The widest surface a widen may reach before the force-surface clamp (stdio: full; HTTP: the server ceiling). */
  ceiling?: McpSurface;
  /** `request_tools {surface}` is callable here and this connection may use it (stdio: session widening on; HTTP: an OAuth client not pinned by the operator). */
  canWiden: boolean;
  /** The callability predicate behind tools/list and dispatch for this connection, as it stands now. */
  isCallable: (name: string) => boolean;
  /** Whether the grant itself (scopes, operation snapshot, write fence) allows the tool on any surface. Default: yes. */
  grantAllows?: (op: OperationMeta) => boolean;
}

export type HiddenToolRoute =
  | { kind: 'callable' }
  | { kind: 'widen'; surface: McpSurface }
  | { kind: 'host'; blocker: 'read_only' | 'surface' | 'grant' };

export function hiddenToolRoute(op: OperationMeta | undefined, conn: ToolConnection): HiddenToolRoute | null {
  if (!op || op.cliOnly || (op.localOnly && conn.transport !== 'stdio')) return null;
  if (conn.isCallable(op.name)) return { kind: 'callable' };
  if (conn.grantAllows && !conn.grantAllows(op)) return { kind: 'host', blocker: 'grant' };
  if (conn.readOnly && !isReadOnlyOperation(op)) return { kind: 'host', blocker: 'read_only' };
  const target = clampSurface(conn.ceiling ?? 'full', () => {});
  if (conn.canWiden && surfaceWiderThan(target, conn.surface ?? 'full') && filterOpsForSurface([op], target).length > 0) return { kind: 'widen', surface: target };
  return { kind: 'host', blocker: 'surface' };
}

function argInputs(argv: string[], name: string) {
  return argv.includes('<params_json>') ? { inputs: [{ name: 'params_json', how: `The arguments you passed to ${name}, as one JSON object.` }] } : {};
}

export function hiddenToolHint(
  op: Operation | undefined,
  opts: { transport?: string; remote?: boolean; surface?: McpSurface; allowedOps?: ReadonlySet<string>; readOnly?: boolean },
  canWiden = false,
): { suggestion: string; fix: Action } | null {
  if (!op || opts.transport !== 'stdio' || opts.remote === false || !opts.allowedOps || opts.allowedOps.has(op.name)) return null;
  const surface = opts.surface ?? 'full';
  const route = hiddenToolRoute(op, {
    transport: 'stdio', surface, canWiden, ceiling: 'full',
    // A full-surface stdio session that still hides a tool is a read-only session.
    readOnly: opts.readOnly ?? surface === 'full',
    isCallable: name => opts.allowedOps!.has(name),
  });
  if (!route || route.kind === 'callable') return null;
  const name = op.name;
  const argv = cliEquivalent(op);
  const inputs = argInputs(argv, name);
  if (route.kind === 'host' && route.blocker === 'read_only') {
    const why = `${name} exists, but this server is read-only (access read-only), so it is not listed. Its CLI equivalent does the same on the brain host; this connection stays read-only.`;
    return { suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`, fix: { argv, consent: [], actor: 'agent', requires_exclusive: false, why, ...inputs } };
  }
  if (route.kind === 'widen') {
    const why = `${name} exists, but this session serves the ${surface} tool surface, which does not include it. `
      + `Call request_tools {"surface":"${route.surface}"} to add it to this session (no restart; nothing is written), then call ${name} by name. ${PERSISTENT_ROUTE}`;
    return {
      suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`,
      fix: { mcp: { tool: 'request_tools', arguments: { surface: route.surface } }, argv, consent: [], actor: 'agent', requires_exclusive: false, why, ...inputs },
    };
  }
  const why = `${name} exists, but this server runs the ${surface} tool surface, which does not include it, and this session cannot widen it. `
    + `Its CLI equivalent does the same on the brain host. ${PERSISTENT_ROUTE}`;
  return {
    suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`,
    fix: {
      argv, consent: [], actor: 'user', requires_exclusive: false, why,
      user_message: `The ${name} tool is not in this session's gbrain tool set. You can run \`${argv.join(' ')}\` on the brain host, or add GBRAIN_SURFACE=full to the gbrain MCP server's env in your agent app and start a new session.`,
      ...inputs,
    },
  };
}

/**
 * D2: the `fix` for content this result left out that `call.tool` serves.
 * Callable → the call itself (`next: run`). Widenable → the `request_tools
 * {surface}` call, then the tool. Otherwise the host-owned repair (`hostFix`,
 * relayed to the user), or on stdio the tool's CLI equivalent. Never names a
 * call the connection's ceiling refuses: the rendered fix drops any MCP call
 * the connection cannot make.
 */
export function hiddenToolNext(op: Operation, call: McpCall, route: HiddenToolRoute, conn: ToolConnection, what: string, hostFix: Action | null): Action | null {
  const name = op.name;
  if (route.kind === 'callable') {
    return { mcp: call, consent: [], actor: 'agent', requires_exclusive: false,
      why: `${name} lists ${what} on this connection; call it with the arguments shown (it may not be in your tool list yet).` };
  }
  if (route.kind === 'widen') {
    const scope = conn.transport === 'stdio' ? 'this session (no restart; nothing is written)' : 'this connection (your client\'s own tool surface, within the server ceiling)';
    return { mcp: { tool: 'request_tools', arguments: { surface: route.surface } }, consent: [], actor: 'agent', requires_exclusive: false,
      why: `${name} lists ${what}, but this connection serves the ${conn.surface ?? 'full'} tool surface, which does not include it. Call request_tools {"surface":"${route.surface}"} to add it to ${scope}, then call ${name} with ${JSON.stringify(call.arguments)}.` };
  }
  if (conn.transport === 'stdio') {
    const base = cliEquivalent(op);
    const argv = base.includes('<params_json>') ? base.map(a => a === '<params_json>' ? JSON.stringify(call.arguments) : a)
      : op.cliHints?.name && base[1] === op.cliHints.name ? [...base, ...Object.entries(call.arguments).flatMap(([k, v]) => [`--${k.replace(/_/g, '-')}`, String(v)])] : base;
    const why = route.blocker === 'read_only'
      ? `${name} lists ${what}, but this connection is read-only and cannot call it; its CLI equivalent does the same on the brain host.`
      : `${name} lists ${what}, but this session cannot add it to its tool surface; its CLI equivalent does the same on the brain host. ${PERSISTENT_ROUTE}`;
    return { argv, consent: [], actor: 'user', requires_exclusive: false, why,
      user_message: `This gbrain connection cannot list ${what}. You can run \`${argv.join(' ')}\` on the brain host.` };
  }
  return hostFix;
}
