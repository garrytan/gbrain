/**
 * Interaction primitive (agent operator contract v1, A5): whether a human can
 * answer a prompt, prompt reads that treat EOF/timeout as a decline, and
 * bounded payload reads from stdin. Neither GBRAIN_INTERACTIVE nor
 * GBRAIN_NON_INTERACTIVE implies consent.
 *
 * Also the one home of the legacy prompt helpers (`promptLine`,
 * `promptLineStderr`, `promptYesNo`); `src/core/cli-util.ts` and
 * `src/core/confirm-prompt.ts` re-export them for one release.
 */

import { fstatSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface InteractiveProbe {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean; stdoutIsTTY?: boolean;
}

/** Process-scoped markers only: a variable set inside an agent's child process, never a user-level home dir. */
const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'OPENCODE_PID'] as const;

/** The first agent-process marker present in env, or null. Never CODEX_HOME (a human's shell sets it). */
export function agentProcessMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of AGENT_MARKERS) if (env[k]) return k;
  return null;
}

const truthy = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

let forcedNoticePrinted = false;

/** One stderr line per process when an agent marker or CI turns off prompts on two TTYs. */
function noteForcedNonInteractive(cause: string): void {
  if (forcedNoticePrinted) return;
  forcedNoticePrinted = true;
  process.stderr.write(
    `[gbrain] prompts are off: ${cause} is set, so confirmations decline by default. ` +
    `A human at this terminal can set GBRAIN_INTERACTIVE=1 to answer prompts.\n`,
  );
}

export function isInteractive(probe: InteractiveProbe = {}): boolean {
  const env = probe.env ?? process.env;
  const stdinTTY = probe.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutTTY = probe.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinTTY || !stdoutTTY) return false;
  if (truthy(env.GBRAIN_INTERACTIVE)) return true;
  if (truthy(env.GBRAIN_NON_INTERACTIVE)) return false;
  const cause = truthy(env.CI) ? 'CI' : agentProcessMarker(env);
  if (cause === null) return true;
  noteForcedNonInteractive(cause);
  return false;
}

export type LineRead = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'timeout' };

interface LineSource {
  prompt: string;
  timeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** An earlier reader already saw EOF (or the stream was destroyed): 'end' will never fire again. */
function streamFinished(stream: NodeJS.ReadableStream): boolean {
  const r = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  return r.readableEnded === true || r.destroyed === true;
}

/**
 * Read one line (trimmed) from `input`. EOF without a newline yields the
 * buffered text as the line, or `eof` when nothing arrived. Bytes after the
 * newline are pushed back so the next prompt sees them. Always removes its
 * listeners and pauses the stream, so the process can exit afterwards.
 */
function readLineFrom(src: LineSource): Promise<LineRead> {
  const input = (src.input ?? process.stdin) as NodeJS.ReadableStream & { unshift?(chunk: Buffer): void };
  const timeoutMs = src.timeoutMs ?? 300_000;
  (src.output ?? process.stderr).write(src.prompt);
  if (streamFinished(input)) return Promise.resolve({ kind: 'eof' });
  return new Promise(resolve => {
    let buf = Buffer.alloc(0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const done = (r: LineRead, rest?: Buffer) => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      if (timer) clearTimeout(timer);
      input.pause();
      if (rest?.length) { try { input.unshift?.(rest); } catch { /* best effort */ } }
      resolve(r);
    };
    const onData = (chunk: string | Buffer) => {
      buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) done({ kind: 'line', text: buf.subarray(0, nl).toString('utf8').trim() }, buf.subarray(nl + 1));
    };
    const onEnd = () => done(buf.length ? { kind: 'line', text: buf.toString('utf8').trim() } : { kind: 'eof' });
    if (timeoutMs > 0) timer = setTimeout(() => done({ kind: 'timeout' }), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    input.resume();
  });
}

/**
 * Prompt read: stderr prompt; EOF/timeout = decline. Returns {kind:'eof'} at once when !isInteractive().
 * `input`/`output`/`probe` are injection seams for tests and embedders; the default is process stdin/stderr.
 */
export async function readLine(
  opts: { prompt: string; timeoutMs?: number; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; probe?: InteractiveProbe },
): Promise<LineRead> {
  if (!isInteractive(opts.probe)) return { kind: 'eof' };
  return readLineFrom(opts);
}

/**
 * Legacy prompt (stdout prompt, no interactivity gate). Resolves the trimmed
 * line; '' on EOF or timeout (it used to hang forever on a closed stdin).
 * @deprecated use readLine.
 */
export async function promptLine(prompt: string): Promise<string> {
  const r = await readLineFrom({ prompt, output: process.stdout });
  return r.kind === 'line' ? r.text : '';
}

/**
 * Legacy prompt that keeps stdout clean (stderr prompt, no interactivity
 * gate). Resolves the trimmed line, or `null` on EOF or after `timeoutMs`
 * (default 5 minutes). `null` is NOT the empty string ('' = user pressed Enter).
 * @deprecated use readLine.
 */
export async function promptLineStderr(prompt: string, opts: { timeoutMs?: number } = {}): Promise<string | null> {
  const r = await readLineFrom({ prompt, timeoutMs: opts.timeoutMs, output: process.stderr });
  return r.kind === 'line' ? r.text : null;
}

export interface ConfirmStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Interactive [y/N] prompt. Resolves true on y/yes; false on anything else or EOF.
 * #4318: resolve the ANSWER first, then close the interface; the 'close'
 * listener declines only when no answer arrived (true EOF / Ctrl-D).
 */
export async function promptYesNo(question: string, streams: ConfirmStreams = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: streams.input ?? process.stdin,
      output: streams.output ?? process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
      rl.close();
    });
    rl.on('close', () => {
      if (!answered) resolve(false);
    });
  });
}

export type StdinRead =
  /** `raw` (only with `StdinReadOptions.raw`): the undecoded bytes, for callers that inspect binary input before decoding. */
  | { kind: 'data'; text: string; raw?: Buffer }
  | { kind: 'empty' }
  | { kind: 'timeout'; phase: 'first_byte' | 'inactivity'; bytes: number }
  | { kind: 'cancelled'; bytes: number }
  | { kind: 'error'; error: Error; bytes: number };

export interface StdinReadOptions {
  /** First-byte deadline. Default: GBRAIN_STDIN_TIMEOUT_MS, else 30 s. */
  firstByteMs?: number;
  /** Silence allowed between chunks once data flows; reset on every chunk. Default 60 s. */
  inactivityMs?: number;
  /** Byte cap; more input is an error, never a truncated success. Default 5 MB. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Also return the undecoded bytes as `raw` on a `data` result. */
  raw?: boolean;
  /** Injection seam (tests, embedders). Default: process.stdin, with a direct read for files and /dev/null. */
  stream?: NodeJS.ReadableStream;
}

const DEFAULT_FIRST_BYTE_MS = 30_000;
const FIRST_BYTE_NOTICE_MS = 5_000;
const DEFAULT_INACTIVITY_MS = 60_000;
export const DEFAULT_STDIN_MAX_BYTES = 5_000_000;

function firstByteDeadlineMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const n = Number(process.env.GBRAIN_STDIN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FIRST_BYTE_MS;
}

const tooLarge = (maxBytes: number, bytes: number): StdinRead =>
  ({ kind: 'error', error: new Error(`stdin exceeds ${maxBytes} bytes; split the input into smaller pieces`), bytes });

/**
 * fd 0 as a regular file or a non-TTY character device (`< file`, `< /dev/null`)
 * never blocks, so read it directly. Returns null when fd 0 needs the stream path.
 */
function readStdinFd(maxBytes: number, withRaw: boolean): StdinRead | null {
  try {
    const st = fstatSync(0);
    if (st.isFIFO() || st.isSocket() || process.stdin.isTTY) return null;
    if (st.isFile() && st.size > maxBytes) return tooLarge(maxBytes, 0);
    const raw = readFileSync(0, { encoding: null });
    if (raw.length > maxBytes) return tooLarge(maxBytes, raw.length);
    return raw.length ? { kind: 'data', text: raw.toString('utf-8'), ...(withRaw ? { raw } : {}) } : { kind: 'empty' };
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)), bytes: 0 };
  }
}

/**
 * Payload read: first-byte timeout 30 s (stderr notice at 5 s), 60 s inactivity reset on progress, no total time cap.
 * EOF, timeout, cancellation and stream error are distinct results; partial input is never returned as data.
 */
export async function readStdinBounded(opts: StdinReadOptions = {}): Promise<StdinRead> {
  const maxBytes = opts.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
  if (opts.signal?.aborted) return { kind: 'cancelled', bytes: 0 };
  if (!opts.stream) {
    const direct = readStdinFd(maxBytes, opts.raw === true);
    if (direct) return direct;
  }
  const ownsStdin = !opts.stream;
  const stream: NodeJS.ReadableStream = opts.stream ?? process.stdin;
  if (streamFinished(stream)) return { kind: 'error', error: new Error('stdin was already consumed or closed'), bytes: 0 };
  const firstByteMs = firstByteDeadlineMs(opts.firstByteMs);
  const inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const armed = (ms: number) => Number.isFinite(ms) && ms > 0;

  return new Promise<StdinRead>(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let notice: ReturnType<typeof setTimeout> | null = null;

    const finish = (r: StdinRead) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (notice) clearTimeout(notice);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      opts.signal?.removeEventListener('abort', onAbort);
      stream.pause();
      // A still-open process stdin would keep the event loop alive after a failed read.
      if (ownsStdin && r.kind !== 'data' && r.kind !== 'empty') process.stdin.destroy();
      resolve(r);
    };
    const arm = (phase: 'first_byte' | 'inactivity', ms: number) => {
      if (deadline) clearTimeout(deadline);
      deadline = armed(ms) ? setTimeout(() => finish({ kind: 'timeout', phase, bytes }), ms) : null;
    };
    const onData = (chunk: string | Buffer) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (b.length === 0) return;
      if (bytes === 0 && notice) { clearTimeout(notice); notice = null; }
      bytes += b.length;
      if (bytes > maxBytes) return finish(tooLarge(maxBytes, bytes));
      chunks.push(b);
      arm('inactivity', inactivityMs);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks);
      finish(bytes ? { kind: 'data', text: raw.toString('utf8'), ...(opts.raw ? { raw } : {}) } : { kind: 'empty' });
    };
    const onError = (e: unknown) => finish({ kind: 'error', error: e instanceof Error ? e : new Error(String(e)), bytes });
    const onClose = () => finish({ kind: 'error', error: new Error('stdin closed before end of input'), bytes });
    const onAbort = () => finish({ kind: 'cancelled', bytes });

    arm('first_byte', firstByteMs);
    if (armed(firstByteMs) && firstByteMs > FIRST_BYTE_NOTICE_MS) {
      notice = setTimeout(() => {
        notice = null;
        process.stderr.write(
          `[gbrain] waiting for stdin: no input after ${FIRST_BYTE_NOTICE_MS / 1000}s; giving up after ${Math.round(firstByteMs / 1000)}s. ` +
          `Pipe the payload or close stdin; set GBRAIN_STDIN_TIMEOUT_MS=<ms> to wait longer for the first byte.\n`,
        );
      }, FIRST_BYTE_NOTICE_MS);
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.resume();
  });
}
