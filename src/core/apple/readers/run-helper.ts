/**
 * Run an Apple helper (Swift or JXA) and parse its one-JSON-document protocol.
 *
 *   success: stdout = {"items":[...]}, exit 0
 *   failure: stdout = {"error":{"code":"...","message":"..."}}, exit non-zero
 *
 * Spawned by argv array (no shell) through src/core/spawn.ts. Environment is
 * scrubbed to PATH/HOME/TMPDIR/LANG. Helper paths come from this package, never
 * from user input.
 */
import { spawn } from '../../spawn.ts';
import {
  AppleReaderError,
  fixFor,
  isAppleReaderErrorCode,
  readerError,
  type AppleReaderErrorCode,
  type AppleReaderService,
} from './errors.ts';

export const DEFAULT_HELPER_TIMEOUT_MS = 120_000;
export const MAX_HELPER_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_STDERR_BYTES = 2048;
/** Larger window kept only to recognize known compile failures (the message stays at MAX_STDERR_BYTES). */
const STDERR_SCAN_BYTES = 32 * 1024;

const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

export interface RunHelperOptions {
  service: AppleReaderService;
  /** Executable (absolute path preferred). */
  command: string;
  /** Argument vector, passed verbatim. */
  args: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  signal?: AbortSignal;
  /** Override for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Source env to scrub; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function scrubEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = source[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function assertDarwin(service: AppleReaderService, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') {
    throw readerError('unsupported_platform', service, `Apple ${service} reader requires macOS (running on ${platform}).`);
  }
}

function truncate(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  return buf.subarray(0, max).toString('utf8') + '…[truncated]';
}

/** Redact-light single-line excerpt for error messages. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through to direct kill */ }
    }
    child.kill('SIGKILL');
  } catch { /* already gone */ }
}

interface RawResult {
  stdout: Buffer;
  stderr: string;
  /** Up to STDERR_SCAN_BYTES of stderr, for pattern matching only (never shown). */
  stderrScan: string;
  exitCode: number | null;
  signalName: NodeJS.Signals | null;
  spawnError?: Error;
  timedOut: boolean;
  aborted: boolean;
  capped: boolean;
}

function execute(opts: RunHelperOptions): Promise<RawResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const cap = opts.maxStdoutBytes ?? MAX_HELPER_STDOUT_BYTES;
  return new Promise<RawResult>((resolve) => {
    const res: RawResult = {
      stdout: Buffer.alloc(0), stderr: '', stderrScan: '', exitCode: null, signalName: null,
      timedOut: false, aborted: false, capped: false,
    };
    if (opts.signal?.aborted) {
      res.aborted = true;
      resolve(res);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.command, opts.args, {
        env: scrubEnv(opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so a timeout kills `swift` and its compiler children.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      res.spawnError = e as Error;
      resolve(res);
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let stderrBuf = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      res.stdout = Buffer.concat(chunks, total);
      res.stderrScan = stderrBuf.toString('utf8');
      res.stderr = truncate(res.stderrScan, MAX_STDERR_BYTES);
      resolve(res);
    };
    const onAbort = () => {
      res.aborted = true;
      killTree(child);
    };

    timer = setTimeout(() => {
      res.timedOut = true;
      killTree(child);
    }, timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => {
      if (res.capped) return;
      total += d.length;
      if (total > cap) {
        res.capped = true;
        killTree(child);
        return;
      }
      chunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderrBuf.length < STDERR_SCAN_BYTES) {
        stderrBuf = Buffer.concat([stderrBuf, d]).subarray(0, STDERR_SCAN_BYTES);
      }
    });
    child.on('error', (e) => {
      res.spawnError = e;
      finish();
    });
    child.on('close', (code, sig) => {
      res.exitCode = code;
      res.signalName = sig;
      finish();
    });
  });
}

function parseDocument(stdout: Buffer): { ok: true; doc: unknown } | { ok: false } {
  const text = stdout.toString('utf8').trim();
  if (!text) return { ok: false };
  try {
    return { ok: true, doc: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The helper's parsed success document: `items` plus any sibling fields (e.g. mail's `truncated`). */
export interface HelperDocument {
  items: unknown[];
  doc: Record<string, unknown>;
}

/** `swiftc` on an SDK older than the helpers' deployment target prints "is only available in macOS 14". */
const MACOS_TOO_OLD_RE = /is only available in macOS \d+/i;

/**
 * Run a helper and return the parsed document's `items` array.
 * Throws AppleReaderError for every failure mode.
 */
export async function runHelper(opts: RunHelperOptions): Promise<unknown[]> {
  return (await runHelperDocument(opts)).items;
}

/** Like runHelper, but also returns the whole success document. */
export async function runHelperDocument(opts: RunHelperOptions): Promise<HelperDocument> {
  const { service } = opts;
  assertDarwin(service, opts.platform);

  const r = await execute(opts);

  if (r.aborted) {
    throw readerError('helper_failed', service, `Apple ${service} helper was aborted.`);
  }
  if (r.spawnError) {
    const code = (r.spawnError as NodeJS.ErrnoException).code;
    throw readerError('helper_failed', service, `could not start Apple ${service} helper${code ? ` (${code})` : ''}: ${oneLine(r.spawnError.message)}`);
  }
  if (r.timedOut) {
    throw readerError('helper_timeout', service, `Apple ${service} helper timed out after ${opts.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS}ms.`);
  }
  if (r.capped) {
    throw readerError('malformed_output', service, `Apple ${service} helper output exceeded the ${opts.maxStdoutBytes ?? MAX_HELPER_STDOUT_BYTES}-byte cap.`);
  }

  const parsed = parseDocument(r.stdout);
  const stderrNote = r.stderr ? ` stderr: ${oneLine(r.stderr)}` : '';

  if (parsed.ok && parsed.doc && typeof parsed.doc === 'object' && !Array.isArray(parsed.doc)) {
    const doc = parsed.doc as { items?: unknown; error?: unknown };
    if (doc.error && typeof doc.error === 'object') {
      const e = doc.error as { code?: unknown; message?: unknown };
      const code: AppleReaderErrorCode = isAppleReaderErrorCode(e.code) && e.code !== 'unsupported_platform' && e.code !== 'helper_timeout'
        ? e.code
        : 'helper_failed';
      const msg = typeof e.message === 'string' && e.message ? oneLine(e.message) : `Apple ${service} helper reported an error`;
      throw new AppleReaderError(code, service, truncate(msg, 500), fixFor(code, service));
    }
    if (r.exitCode === 0 && Array.isArray(doc.items)) return { items: doc.items, doc: doc as Record<string, unknown> };
    if (r.exitCode === 0) {
      throw readerError('malformed_output', service, `Apple ${service} helper output has no "items" array.`);
    }
  }

  if (MACOS_TOO_OLD_RE.test(r.stderrScan)) {
    throw readerError('macos_too_old', service, `Apple ${service} helper could not be compiled: the installed macOS SDK / Command Line Tools are too old.${stderrNote}`);
  }
  if (r.exitCode !== 0) {
    const how = r.signalName ? `killed by ${r.signalName}` : `exited with code ${r.exitCode}`;
    throw readerError('helper_failed', service, `Apple ${service} helper ${how} without a valid error document.${stderrNote}`);
  }
  throw readerError('malformed_output', service, `Apple ${service} helper printed output that is not one JSON document.${stderrNote}`);
}
