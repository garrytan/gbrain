/**
 * CLI half of the warm CLI socket. Before a read (search, query, get, recall)
 * opens its own database connection, the CLI looks for a serve's socket in
 * `$GBRAIN_HOME/.gbrain/run/`; when a serve bound to the same brain identity
 * answers, the CLI prints that answer with the cold path's own renderer and
 * exit codes. A missing, unsafe, stale, busy, refusing or dying socket returns
 * false and the cold path runs as if the socket did not exist (a note goes to
 * stderr only with GBRAIN_DEBUG=1). GBRAIN_CLI_SOCKET=0 skips the socket.
 */
import net from 'node:net';
import { format } from 'node:util';
import { loadConfig, configDir, configPath, isThinClient } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { VERSION } from '../version.ts';
import type { OperationMeta } from '../core/ops/contract.ts';
import { cliSocketDir, cliSocketPath, connectProblem } from '../core/cli-socket/fs-guard.ts';
import { cliSocketIdentity } from '../core/cli-socket/identity.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from '../core/cli-socket/peer-cred.ts';
import {
  CONNECT_TIMEOUT_MS, DEFAULT_READ_WALLCLOCK_MS, FrameReader, HANDSHAKE_TIMEOUT_MS, isHandshakeFrame, isResultFrame, MAX_RESPONSE_BYTES,
  MAX_ROUND_TRIP_MS, reviveOperationError, type CliSocketOp, type CliSocketRequest, type OutputChunk, type ResultFrame,
} from '../core/cli-socket/protocol.ts';

export const CLI_SOCKET_COMMANDS: readonly string[] = ['search', 'query', 'get', 'recall'];
const SOCKET_OPS: Record<string, CliSocketOp> = { search: 'search', query: 'query', get_page: 'get_page' };

function debug(reason: string): void {
  if (process.env.GBRAIN_DEBUG === '1') process.stderr.write(`[cli-socket] cold path: ${reason}\n`);
}

function debugWarm(command: string, path: string): void {
  if (process.env.GBRAIN_DEBUG === '1') process.stderr.write(`[cli-socket] warm: ${command} answered by the serve socket at ${path}\n`);
}

type Exchange = { frame: ResultFrame } | { reason: string };

/**
 * One request on one connection: connect, verify the serve's uid, send, read
 * the handshake, then the result. `totalTimeoutMs` bounds the whole exchange;
 * the connect and handshake keep their own shorter bounds inside it. Without a
 * peer-credential reader on this platform the CLI never connects.
 */
export function exchangeCliSocket(path: string, request: CliSocketRequest, totalTimeoutMs: number, peerCred: PeerCredSupport = peerCredSupport()): Promise<Exchange> {
  if (!peerCred.ok) return Promise.resolve({ reason: `peer_credentials_unsupported (${peerCred.reason})` });
  const support = peerCred;
  return new Promise(resolve => {
    const deadline = performance.now() + totalTimeoutMs;
    const socket = net.createConnection(path);
    const reader = new FrameReader(MAX_RESPONSE_BYTES);
    let accepted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const arm = (ms: number, reason: string) => {
      clearTimeout(timer);
      const remaining = deadline - performance.now();
      timer = setTimeout(() => finish({ reason: remaining <= ms ? 'round_trip_timeout' : reason }), Math.max(0, Math.min(ms, remaining)));
    };
    arm(CONNECT_TIMEOUT_MS, 'connect_timeout');
    socket.once('error', error => finish({ reason: `${accepted ? 'lost' : 'connect_failed'} (${(error as NodeJS.ErrnoException).code ?? error.message})` }));
    socket.once('close', () => finish({ reason: accepted ? 'serve_closed_mid_request' : 'serve_closed' }));
    socket.once('connect', () => {
      if (peerUid(socket, support.read) !== process.getuid?.()) { finish({ reason: 'serve_uid_mismatch' }); return; }
      arm(HANDSHAKE_TIMEOUT_MS, 'handshake_timeout');
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', data => {
      const frames = reader.push(typeof data === 'string' ? Buffer.from(data) : data);
      if (frames === 'overflow') { finish({ reason: 'response_too_large' }); return; }
      for (const text of frames) {
        let value: unknown;
        try { value = JSON.parse(text); } catch { finish({ reason: 'malformed_response' }); return; }
        if (!accepted) {
          if (!isHandshakeFrame(value)) { finish({ reason: 'malformed_response' }); return; }
          if (!value.accepted) { finish({ reason: `refused (${value.reason})${value.mismatch ? `: ${value.mismatch}` : ''}` }); return; }
          accepted = true;
          arm(Number.POSITIVE_INFINITY, 'round_trip_timeout');
          continue;
        }
        finish(isResultFrame(value) ? { frame: value } : { reason: 'malformed_response' });
        return;
      }
    });
  });
}

/** The longest the CLI waits on one whole exchange: MAX_ROUND_TRIP_MS, or the call's --timeout when shorter. */
export function cliSocketRoundTripMs(timeoutMs: number | null): number {
  return Math.min(MAX_ROUND_TRIP_MS, timeoutMs ?? DEFAULT_READ_WALLCLOCK_MS);
}

/** The source the serve resolved for this call, pinned in fix commands exactly as the cold process would have noted it (before anything renders). */
async function noteSource(frame: { source?: string | null }): Promise<void> {
  if (frame.source) (await import('../core/fix-routing.ts')).noteResolvedSource(frame.source);
}

/** Prints the operation's own output, as the cold process would have by now. */
async function replay(frame: { output: OutputChunk[] }): Promise<void> {
  for (const [stream, text] of frame.output) {
    if (stream === 'stdout') process.stdout.write(text);
    else process.stderr.write(text);
  }
}

async function opRequest(command: string, args: string[]): Promise<{ op: OperationMeta; params: Record<string, unknown> } | string> {
  const { cliOps } = await import('./op-manifest.ts');
  const { cliAliases, parseOpArgs } = await import('./main.ts');
  const op = cliOps.get(command) ?? cliAliases.get(command);
  if (!op || !SOCKET_OPS[op.name]) return 'not_a_socket_op';
  const params = parseOpArgs(op, args);
  if (op.cliHints?.stdin && !params[op.cliHints.stdin]) return 'stdin_input';
  if (typeof params.image === 'string' && params.image.length > 0) return 'image_query';
  if (Object.entries(op.params).some(([key, def]) => def.required && params[key] === undefined)) return 'missing_param';
  if (typeof params.source === 'string' && params.source.length > 0 && (params.source_id !== undefined || params.all_sources === true)) return 'conflicting_scope';
  return { op, params };
}

type Buffered<T> = { value: T; flush: () => void } | { error: unknown };

/**
 * Runs a renderer with stdout, stderr and console held in memory, so a frame
 * the renderer cannot handle throws before anything reaches the terminal and
 * the caller can still take the cold path. `flush` writes what it printed.
 */
async function buffered<T>(render: () => T | Promise<T>): Promise<Buffered<T>> {
  const chunks: Array<['stdout' | 'stderr', string]> = [];
  const hold = (stream: 'stdout' | 'stderr') => (chunk: unknown, ...rest: unknown[]): boolean => {
    chunks.push([stream, typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()]);
    const callback = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    if (callback) queueMicrotask(callback);
    return true;
  };
  const saved = { out: process.stdout.write, err: process.stderr.write, log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  process.stdout.write = hold('stdout') as typeof process.stdout.write;
  process.stderr.write = hold('stderr') as typeof process.stderr.write;
  for (const [method, stream] of [['log', 'stdout'], ['info', 'stdout'], ['debug', 'stdout'], ['warn', 'stderr'], ['error', 'stderr']] as const) {
    console[method] = (...args: unknown[]) => { chunks.push([stream, format(...args) + '\n']); };
  }
  try {
    const value = await render();
    return { value, flush: () => { for (const [stream, text] of chunks) (stream === 'stdout' ? process.stdout : process.stderr).write(text); } };
  } catch (error) {
    return { error };
  } finally {
    Object.assign(process.stdout, { write: saved.out });
    Object.assign(process.stderr, { write: saved.err });
    Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug });
  }
}

function renderFailed(error: unknown): false {
  debug(`render_failed (${error instanceof Error ? error.message : String(error)})`);
  return false;
}

/** Prints an answered op frame the way the cold path would; false (nothing printed) when the frame cannot be rendered. */
export async function renderOp(command: string, op: OperationMeta, params: Record<string, unknown>, frame: Exclude<ResultFrame, { kind: 'fallback' }>): Promise<boolean> {
  const { formatResult, captureRetrievalMeta, maybePrintConceptNudge } = await import('./main.ts');
  const { applyCliOpNotices, captureOpNotice } = await import('./op-notices.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../core/cli-force-exit.ts');
  await noteSource(frame);
  if (frame.kind === 'error') {
    const { writeCliError } = await import('./cli-error.ts');
    const rendered = await buffered(() => writeCliError(reviveOperationError(frame.error), command));
    if ('error' in rendered) return renderFailed(rendered.error);
    await replay(frame);
    rendered.flush();
    setCliExitVerdict(rendered.value);
    return true;
  }
  const rendered = await buffered(() => {
    if (frame.meta) captureRetrievalMeta('retrieval', frame.meta);
    for (const notice of frame.notices) captureOpNotice(notice);
    const { result, stderr } = applyCliOpNotices(frame.result, params.json === true);
    return { result, noticeText: stderr, output: formatResult(op.name, result, params) };
  });
  if ('error' in rendered) {
    try { applyCliOpNotices(null, true); } catch { /* drains what the failed render captured */ }
    return renderFailed(rendered.error);
  }
  const { result, noticeText, output } = rendered.value;
  await replay(frame);
  rendered.flush();
  if (output) await writeStdoutFinal(output);
  if (noticeText) process.stderr.write(noticeText);
  if (typeof result === 'object' && result !== null && !Array.isArray(result) && (result as { status?: unknown }).status === 'error') {
    const detail = (result as { error?: unknown }).error;
    console.error(`gbrain ${command}: operation reported status 'error'` + (typeof detail === 'string' && detail ? ` — ${detail}` : '') + '.');
    setCliExitVerdict(1);
  }
  maybePrintConceptNudge(op.name, params);
  return true;
}

/**
 * Serves `command` from a warm serve when one is bound to this CLI's brain.
 * True means the output was printed and the exit verdict set; false means the
 * caller runs the normal cold path.
 */
export async function maybeServeFromCliSocket(command: string, args: string[]): Promise<boolean> {
  if (!CLI_SOCKET_COMMANDS.includes(command) || process.env.GBRAIN_CLI_SOCKET === '0') return false;
  const config = loadConfig();
  if (!config || config.engine !== 'postgres' || !config.database_url || isThinClient(config)) { debug('not a local postgres brain'); return false; }
  const cliOpts = getCliOptions();
  if (cliOpts.explain) { debug('--explain runs locally'); return false; }
  const home = configDir();
  const path = cliSocketPath(home);
  const problem = connectProblem(path, cliSocketDir(home));
  if (problem === 'missing') { debug(`no socket at ${path}; start the serve with gbrain serve --cli-socket or set serve.cli_socket true`); return false; }
  if (problem) { debug(`socket refused before connect (${problem})`); return false; }
  let brainId: string;
  try { brainId = resolveBrainId(cliOpts.brain); } catch { debug('brain did not resolve'); return false; }
  if (brainId !== 'host') { debug(`mount brain ${brainId}`); return false; }

  const base = {
    v: 1 as const,
    identity: cliSocketIdentity({ config, brainId, configDir: home, configFile: configPath(), version: VERSION, env: process.env }),
    command,
    routing: { cwd: process.cwd(), source_env: process.env.GBRAIN_SOURCE ?? null },
    cli: { quiet: cliOpts.quiet, timeout_ms: cliOpts.timeoutMs },
  };
  const resultTimeoutMs = cliSocketRoundTripMs(cliOpts.timeoutMs);

  if (command === 'recall') {
    const recall = await import('../commands/recall.ts');
    if (args.includes('--help') || args.includes('-h')) return false;
    let flags: ReturnType<typeof recall.parseFlags>;
    try { flags = recall.parseFlags(args); } catch { return false; }
    if (!recall.isRecallVerbForm(flags)) return false;
    if (!recall.isOneShotRecall(flags)) recall.validateAndNormalizeFlags(flags);
    const outcome = await exchangeCliSocket(path, { ...base, kind: 'recall', args }, resultTimeoutMs);
    if ('reason' in outcome) { debug(outcome.reason); return false; }
    if (outcome.frame.kind === 'fallback') { debug(outcome.frame.reason); return false; }
    const frame = outcome.frame;
    debugWarm(command, path);
    await noteSource(frame);
    if (frame.kind === 'error' && !recall.isOneShotRecall(flags)) { await replay(frame); throw reviveOperationError(frame.error); }
    const { writeCliNotices } = await import('../core/interop-notices.ts');
    const rendered = await buffered(async () => {
      if (frame.kind === 'error') { await recall.reportOneShotRecallError(reviveOperationError(frame.error), flags); return; }
      await recall.renderRecallVerbResult(flags, frame.result as Parameters<typeof recall.renderRecallVerbResult>[1]);
      if (frame.notices.length > 0) writeCliNotices(frame.notices);
    });
    if ('error' in rendered) return renderFailed(rendered.error);
    await replay(frame);
    rendered.flush();
    return true;
  }

  const prepared = await opRequest(command, args);
  if (typeof prepared === 'string') { debug(prepared); return false; }
  const outcome = await exchangeCliSocket(path, { ...base, kind: 'op', op: SOCKET_OPS[prepared.op.name]!, params: prepared.params }, resultTimeoutMs);
  if ('reason' in outcome) { debug(outcome.reason); return false; }
  if (outcome.frame.kind === 'fallback') { debug(outcome.frame.reason); return false; }
  debugWarm(command, path);
  return renderOp(command, prepared.op, prepared.params, outcome.frame);
}
