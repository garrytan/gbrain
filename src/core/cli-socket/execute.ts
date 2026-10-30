/**
 * Serve-side execution of one warm CLI request. Shared ops run through the
 * operation's own handler with the trusted local CLI context (remote: false),
 * built the way src/cli/main.ts makeContext builds it but with the CLI's cwd
 * and GBRAIN_SOURCE instead of the serve's. The result goes back as data and
 * the CLI renders it with the cold path's renderer, so the printed bytes come
 * from the same code. `recall` runs its op-backed forms the same way.
 */
import type { Notice } from '../agent-output.ts';
import { takeChatFallbackHopNotices } from '../ai/fallback-hop-queue.ts';
import { recallInteropNotices } from '../interop-notices.ts';
import { DEFAULT_CLI_OPTIONS } from '../cli-options.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { withRequestConfigSnapshot } from '../config-snapshot.ts';
import type { BrainEngine } from '../engine.ts';
import { operationsByName } from '../operations.ts';
import { OperationError, opOwnsSource, type Operation, type OperationContext } from '../ops/contract.ts';
import { currentCliWriteWait } from '../persistence/write-wait.ts';
import { localFederatedSourceIds, resolveSourceWithTier, SourceTargetError } from '../source-resolver.ts';
import { OperationTimeoutError, withTimeout } from '../timeout.ts';
import { bigintToStringReplacer } from '../utils.ts';
import { OutputCapture, withOutputCapture } from './output-capture.ts';
import { withRequestSignal } from '../request-signal.ts';
import { withResponseDeferral } from '../background-work.ts';
import { DEFAULT_READ_WALLCLOCK_MS, MAX_ROUND_TRIP_MS, serializeOperationError, warmRoundTripTimeout, type CliSocketRequest, type ResultFrame } from './protocol.ts';

/** File config merged with the DB plane, read fresh for every request (inside its config snapshot), as a cold CLI reads it at connect. */
export async function mergedRequestConfig(engine: BrainEngine): Promise<GBrainConfig> {
  const fileConfig = loadConfig() || { engine: 'postgres' as const };
  try {
    return (await loadConfigWithEngine(engine, fileConfig)) ?? fileConfig;
  } catch (err) {
    console.warn(
      `[config] DB-plane merge failed; using file/env config only. ` +
      `Values set via \`gbrain config set\` will not apply to this command: ` +
      `${(err as Error).message}`,
    );
    return fileConfig;
  }
}

/** The CLI's OperationContext for one request: makeContext's fields, with the caller's routing. */
export async function cliRequestContext(engine: BrainEngine, params: Record<string, unknown>, op: Pick<Operation, 'params'>,
  request: Pick<CliSocketRequest, 'routing' | 'cli'>, config: GBrainConfig | Promise<GBrainConfig>,
  sinks: { emitResponseMeta: (key: string, value: unknown) => void; emitNotice: (notice: Notice) => void }): Promise<OperationContext> {
  const merged = Promise.resolve(config);
  merged.catch(() => {});
  let sourceId: string | undefined;
  let localFederated: string[] | undefined;
  let sourceImplicit = true;
  const explicit = opOwnsSource(op) ? null : (params.source as string | undefined) ?? null;
  const env = request.routing.source_env ?? undefined;
  try {
    const resolved = await resolveSourceWithTier(engine, explicit, request.routing.cwd, { env });
    sourceId = resolved.source_id;
    sourceImplicit = resolved.tier !== 'flag' && resolved.tier !== 'env' && resolved.tier !== 'dotfile';
    localFederated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
  } catch (err) {
    if (explicit || err instanceof SourceTargetError) throw err;
    sourceId = undefined;
  }
  return {
    engine,
    config: await merged,
    logger: { info: (...args: unknown[]) => console.log(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) },
    dryRun: (params.dry_run as boolean) || false,
    remote: false, admissionOrigin: 'interactive',
    cliOpts: { ...DEFAULT_CLI_OPTIONS, quiet: request.cli.quiet, timeoutMs: request.cli.timeout_ms },
    writeWaitMs: currentCliWriteWait().waitMs,
    sourceId: sourceId ?? 'default',
    brainId: 'host',
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
    ...(sourceImplicit ? { localSourceImplicit: true } : {}),
    emitResponseMeta: sinks.emitResponseMeta,
    emitNotice: sinks.emitNotice,
  } as OperationContext;
}

/** Only a plain OperationError round-trips exactly; subclasses and driver errors send the CLI to its cold path. */
function errorFrame(error: unknown, capture: OutputCapture): ResultFrame {
  if (error instanceof OperationError && error.constructor === OperationError && !('consent' in error)) {
    return { v: 1, kind: 'error', error: serializeOperationError(error), output: capture.chunks };
  }
  return { v: 1, kind: 'fallback', reason: 'unportable_error' };
}

/** The promises a request started; the serve counts the request as active until every one settles, even after a timeout answered it. */
type Work = Promise<unknown>[];

function track<T>(work: Work, promise: Promise<T>): Promise<T> {
  work.push(promise);
  return promise;
}

/** The round trip reached its cap: cancel the request's remaining work (request-signal.ts) and answer a retryable timeout. */
function roundTripTimeout(request: CliSocketRequest, ms: number, cancel: AbortController, capture: OutputCapture): ResultFrame {
  cancel.abort(new Error('round_trip_cap'));
  return { v: 1, kind: 'error', error: serializeOperationError(warmRoundTripTimeout(request.command, ms, 'serve')), output: capture.chunks };
}

const wallclock = (request: CliSocketRequest) => Math.min(MAX_ROUND_TRIP_MS, request.cli.timeout_ms ?? DEFAULT_READ_WALLCLOCK_MS);

async function runOp(engine: BrainEngine, request: Extract<CliSocketRequest, { kind: 'op' }>, capture: OutputCapture, work: Work, cancel: AbortController): Promise<ResultFrame> {
  const op = operationsByName[request.op];
  if (!op || op.scope !== 'read' || op.mutating) return { v: 1, kind: 'fallback', reason: 'not_a_read_op' };
  const params = request.params;
  const wallclockMs = wallclock(request);
  let meta: Record<string, unknown> | null = null;
  const notices: Notice[] = [];
  const sinks = {
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval' && value !== null && typeof value === 'object') meta = value as Record<string, unknown>; },
    emitNotice: (notice: Notice) => { notices.push(notice); },
  };
  let stage = `gbrain ${request.command}: context`;
  try {
    // GBRA-156: the merged config and the source resolution read the request's snapshot together (one round trip).
    const ctx = await withTimeout(track(work, cliRequestContext(engine, params, op, request, mergedRequestConfig(engine), sinks)), wallclockMs, stage);
    stage = `gbrain ${request.command}`;
    const raw = await withTimeout(track(work, op.handler(ctx, params)), wallclockMs, stage);
    // src/cli/main.ts runSharedOperation: captureRetrievalNotices after the handler, before the JSON round trip.
    const retrieval = op.name === 'search' || op.name === 'query'
      ? recallInteropNotices(op.name, raw, { retrieval: meta ?? {} }, params, { config: ctx.config, transport: 'cli' })
      : [];
    const result = JSON.parse(JSON.stringify(raw, bigintToStringReplacer) ?? 'null');
    return { v: 1, kind: 'result', result, meta, notices: [...notices, ...retrieval, ...takeChatFallbackHopNotices()], output: capture.chunks };
  } catch (error) {
    if (error instanceof OperationTimeoutError) return roundTripTimeout(request, wallclockMs, cancel, capture);
    if (op.name === 'get_page' && (error as { code?: unknown })?.code === 'page_body_segmented') return { v: 1, kind: 'fallback', reason: 'segmented_page' };
    return errorFrame(error, capture);
  }
}

async function runRecall(engine: BrainEngine, request: Extract<CliSocketRequest, { kind: 'recall' }>, capture: OutputCapture, work: Work, cancel: AbortController): Promise<ResultFrame> {
  const { recallVerbForCaller } = await import('../../commands/recall.ts');
  const wallclockMs = wallclock(request);
  try {
    const raw = await withTimeout(track(work, recallVerbForCaller(engine, request.args, { cwd: request.routing.cwd, env: request.routing.source_env ?? undefined })), wallclockMs, `gbrain ${request.command}`);
    if (raw === null) return { v: 1, kind: 'fallback', reason: 'not_a_recall_verb' };
    const result = JSON.parse(JSON.stringify(raw, bigintToStringReplacer) ?? 'null');
    // A cold recall prints the first chat-fallback hop at teardown (src/core/cli-force-exit.ts); the CLI does the same with these.
    return { v: 1, kind: 'result', result, meta: null, notices: takeChatFallbackHopNotices(), output: capture.chunks };
  } catch (error) {
    if (error instanceof OperationTimeoutError) return roundTripTimeout(request, wallclockMs, cancel, capture);
    return errorFrame(error, capture);
  }
}

/**
 * Runs one accepted request inside its own output capture and its own config
 * snapshot (config-snapshot.ts, the one MCP read ops use): the first config
 * read takes the table in one statement, every later read in the request
 * answers from it, and the snapshot closes when the request settles, so
 * nothing is cached across requests. Every op served here is non-mutating.
 */
export interface ExecutedRequest {
  frame: ResultFrame;
  /** Settles when every promise the request started has settled (never rejects); a timed-out handler keeps it pending. */
  settled: Promise<unknown>;
}

/** `signal`: the serve aborts it when the client disconnects before the answer; the request's work is then cancelled (request-signal.ts). */
export async function executeCliSocketRequest(engine: BrainEngine, request: CliSocketRequest, signal?: AbortSignal): Promise<ExecutedRequest> {
  const capture = new OutputCapture();
  const work: Work = [];
  const cancel = new AbortController();
  if (signal) signal.aborted ? cancel.abort(signal.reason) : signal.addEventListener('abort', () => cancel.abort(signal.reason), { once: true });
  const { value: answered, release } = await withResponseDeferral(() => withRequestSignal(cancel.signal, () => withOutputCapture(capture, () => withRequestConfigSnapshot(engine, () => request.kind === 'op'
    ? runOp(engine, request, capture, work, cancel)
    : runRecall(engine, request, capture, work, cancel)))));
  // GBRA-156: the request's writes (background-work.ts deferUntilResponse) start once the serve has written this answer.
  setImmediate(release);
  const settled = Promise.allSettled(work);
  if (answered.kind === 'fallback') return { frame: answered, settled };
  if (capture.overflow) return { frame: { v: 1, kind: 'fallback', reason: 'output_too_large' }, settled };
  return { frame: { ...answered, source: capture.resolvedSource ?? null }, settled };
}
