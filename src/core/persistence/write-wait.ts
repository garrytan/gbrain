/**
 * #5232: how long a caller waits for an admitted write to commit, and the CLI
 * exit verdict when the wait ends first. Engine-free: the CLI resolves these
 * before it knows whether a resident owner, a remote server or its own engine
 * will run the write.
 */
import { loadConfig, type GBrainConfig } from '../config.ts';
import { getCliOptions } from '../cli-options.ts';
import { PENDING_WRITE_EXIT_CODE } from '../exit-codes.ts';
import { OperationError } from '../ops/contract.ts';
import { pinRouting, type FixRouting } from '../fix-routing.ts';
import { admittedPendingReceipt, type WriteReceipt } from './types.ts';
import { WIRE_WRITE_WAIT_MAX_MS } from './params.ts';

/** Agent and server callers keep the historical bounded wait. */
export const AGENT_WRITE_WAIT_MS = 5_000;
/** CLI default: long enough for a normal commit over a remote pooler (#5232 measured ~8 s). */
export const CLI_WRITE_WAIT_MS = 30_000;
export const MAX_WRITE_WAIT_MS = 600_000;
/** Transport budget beyond the wait for identity checks and admission (O-DX-1). */
export const WRITE_ADMISSION_HEADROOM_MS = 15_000;
export const WRITE_WAIT_ENV = 'GBRAIN_WRITE_WAIT_MS';
export const WRITE_WAIT_CONFIG_KEY = 'persistence.write_wait_ms';
export const ACCEPT_PENDING_ENV = 'GBRAIN_ACCEPT_PENDING';

export const WRITE_EXIT_DOCS = 'docs/protocol/MEMORY_VERBS_v1.md#cli-exit-status-for-writes';

function invalidWriteWait(where: string, value: unknown): OperationError {
  return new OperationError('invalid_write_wait',
    `${where} must be a whole number of milliseconds from 0 to ${MAX_WRITE_WAIT_MS} (got ${JSON.stringify(value)}).`,
    where === WRITE_WAIT_ENV ? `unset ${WRITE_WAIT_ENV}, or set it to e.g. 30000` : `gbrain config set ${WRITE_WAIT_CONFIG_KEY} 30000`,
    'docs/guides/write-refusals.md#invalid_write_wait');
}

function parseMs(value: unknown, where: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_WRITE_WAIT_MS) throw invalidWriteWait(where, value);
  return n;
}

/**
 * #6007: a caller's `wait_ms` on a write (total reply deadline from arrival).
 * Absent → undefined (the context default applies). Outside 0-30000 → the
 * same invalid_write_wait refusal the CLI uses, before anything is admitted.
 */
export function parseWireWriteWaitMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > WIRE_WRITE_WAIT_MAX_MS) {
    throw new OperationError('invalid_write_wait',
      `wait_ms must be a whole number of milliseconds from 0 to ${WIRE_WRITE_WAIT_MAX_MS} (got ${JSON.stringify(value)}); nothing was written.`,
      `Resubmit the same write with the same request_id and wait_ms between 0 and ${WIRE_WRITE_WAIT_MAX_MS} (for example 25000), or omit wait_ms for the 5000 ms default.`,
      'docs/guides/write-refusals.md#invalid_write_wait');
  }
  return value;
}

/** CLI write wait: `--wait <s>` > GBRAIN_WRITE_WAIT_MS > persistence.write_wait_ms (file plane) > 30 s. */
export function resolveCliWriteWaitMs(opts: {
  flagMs?: number | null; env?: NodeJS.ProcessEnv; config?: GBrainConfig | null;
} = {}): number {
  if (opts.flagMs !== undefined && opts.flagMs !== null) return opts.flagMs;
  const env = opts.env ?? process.env;
  return parseMs(env[WRITE_WAIT_ENV], WRITE_WAIT_ENV)
    ?? parseMs(opts.config?.persistence?.write_wait_ms, WRITE_WAIT_CONFIG_KEY)
    ?? CLI_WRITE_WAIT_MS;
}

/** An explicitly configured wait (`--wait`, GBRAIN_WRITE_WAIT_MS, persistence.write_wait_ms), else `fallbackMs`. */
export function configuredWriteWaitMs(fallbackMs: number): number {
  const flagMs = getCliOptions().writeWaitMs;
  if (flagMs !== undefined && flagMs !== null) return flagMs;
  return parseMs(process.env[WRITE_WAIT_ENV], WRITE_WAIT_ENV)
    ?? parseMs(loadConfig()?.persistence?.write_wait_ms, WRITE_WAIT_CONFIG_KEY)
    ?? fallbackMs;
}

/** The wait and pending opt-in this CLI invocation resolved. */
export function currentCliWriteWait(): { waitMs: number; acceptPending: boolean } {
  const cli = getCliOptions();
  return { waitMs: resolveCliWriteWaitMs({ flagMs: cli.writeWaitMs, config: loadConfig() }), acceptPending: acceptPendingRequested(cli.acceptPending) };
}

/** A wire-requested wait is honored only within the documented bound. */
export function boundedWriteWaitMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_WRITE_WAIT_MS) : undefined;
}

/**
 * One transport exchange for a write: an explicit `--timeout` bounds the
 * exchange, so the owner is asked to stop waiting early enough to return a
 * pending receipt before that deadline. Otherwise the deadline is the wait
 * plus admission headroom, so a slow commit is never an unknown submission.
 */
export function writeExchangeBudget(waitMs: number, explicitTimeoutMs?: number | null): { waitMs: number; timeoutMs: number } {
  if (explicitTimeoutMs === undefined || explicitTimeoutMs === null) return { waitMs, timeoutMs: waitMs + WRITE_ADMISSION_HEADROOM_MS };
  return { waitMs: Math.max(0, Math.min(waitMs, explicitTimeoutMs - WRITE_ADMISSION_HEADROOM_MS)), timeoutMs: explicitTimeoutMs };
}

/** `--accept-pending` / `--no-accept-pending` beat GBRAIN_ACCEPT_PENDING=1. */
export function acceptPendingRequested(flag: boolean | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag !== undefined && flag !== null) return flag;
  return /^(1|true|yes|on)$/i.test(env[ACCEPT_PENDING_ENV]?.trim() ?? '');
}

/** The admitted, still-pending receipt carried by a thrown write error, if any. */
export function pendingReceiptOf(error: unknown): WriteReceipt | null {
  const json = (error as { toJSON?: () => unknown } | null)?.toJSON;
  if (typeof json !== 'function') return null;
  try { return admittedPendingReceipt(json.call(error)); } catch { return null; }
}

/**
 * The one CLI exit verdict for a failed write (O-DX-1/O-ENG-1): an admitted
 * pending receipt exits PENDING_WRITE_EXIT_CODE (0 with the opt-in); every
 * other error, including a pre-admission `unavailable`, exits 1.
 */
export function writeErrorExitCode(error: unknown, acceptPending: boolean): number {
  if (!pendingReceiptOf(error)) return 1;
  return acceptPending ? 0 : PENDING_WRITE_EXIT_CODE;
}

/**
 * The copy-paste poll command for a pending receipt (#6255): the same
 * `gbrain write-request [--brain <id>] -- <request_id>` argv the error
 * envelope's `fix` carries. A `fix.argv` that reads this receipt wins, so the
 * two never disagree; otherwise the receipt command is pinned to `routing`.
 */
export function pollCommand(requestId: string, fix?: { argv?: readonly string[] }, routing?: FixRouting): string {
  const argv = fix?.argv?.[0] === 'gbrain' && fix.argv[1] === 'write-request' && fix.argv.includes(requestId)
    ? fix.argv : pinRouting(['gbrain', 'write-request', '--', requestId], routing);
  return argv.join(' ');
}

/**
 * Keep the caller's wait across transports that wait less than it (an older
 * owner, or a remote server's own bounded wait): replay the identical request
 * (same request_id, so nothing new is admitted) until it settles or the wait
 * is spent. Only an admitted pending receipt is replayed.
 */
export async function replayWhilePending<T>(send: () => Promise<T>, waitMs: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await send(); }
    catch (error) {
      const receipt = pendingReceiptOf(error);
      const remaining = deadline - Date.now();
      if (!receipt || remaining <= 0) throw error;
      await sleep(Math.min(Math.max(receipt.retry_after_ms ?? 1000, 50), remaining));
    }
  }
}
