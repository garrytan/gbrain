/**
 * serve's own log hygiene (#7246): size-based rotation and dedupe of repeated
 * lines for a `gbrain serve` whose stdout or stderr is a regular file.
 *
 * The service installs `gbrain mcp expose` writes (launchd StandardOutPath,
 * systemd `append:`, the nohup `>>` fallback) and any operator `>>` redirect
 * hand serve an append-mode file descriptor it cannot reopen. So rotation is
 * copy-then-truncate on that descriptor: shift <path>.N-1 → <path>.N, copy
 * <path> → <path>.1, truncate <path> to zero, keep writing. Every write goes
 * at the file's current end, so a truncated file never grows a hole.
 *
 * Dedupe: a line seen again inside the window (a leading timestamp ignored)
 * is counted instead of written; when the window ends, or the process exits,
 * one "[gbrain serve-log] repeated N more time(s) in the last Ws: <line>" line
 * follows. The first occurrence is always written immediately.
 *
 * TTYs, pipes and journald are left alone. Knobs (env, read at serve start):
 * GBRAIN_SERVE_LOG_MAX_BYTES (default 10 MiB; 0 turns rotation off),
 * GBRAIN_SERVE_LOG_MAX_FILES (rotated copies kept, default 5),
 * GBRAIN_SERVE_LOG_DEDUPE_SECONDS (default 600; 0 turns dedupe off).
 */
import { copyFileSync, existsSync, fstatSync, ftruncateSync, readlinkSync, renameSync, statSync, writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
import { serveErrPath, serveLogPath } from './serve-service.ts';

export interface ServeLogPolicy {
  maxBytes: number;
  maxFiles: number;
  dedupeWindowMs: number;
}

const DEFAULTS: ServeLogPolicy = { maxBytes: 10 * 1024 * 1024, maxFiles: 5, dedupeWindowMs: 600_000 };
const MAX_TRACKED_LINES = 10_000;
const LEADING_TIMESTAMP = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/;

export function resolveServeLogPolicy(env: Record<string, string | undefined>, warn: (line: string) => void): ServeLogPolicy {
  const read = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min) return n;
    warn(`[gbrain serve] ignoring invalid ${name}=${JSON.stringify(raw)} — using default ${fallback}`);
    return fallback;
  };
  return {
    maxBytes: read('GBRAIN_SERVE_LOG_MAX_BYTES', DEFAULTS.maxBytes, 0),
    maxFiles: read('GBRAIN_SERVE_LOG_MAX_FILES', DEFAULTS.maxFiles, 1),
    dedupeWindowMs: read('GBRAIN_SERVE_LOG_DEDUPE_SECONDS', DEFAULTS.dedupeWindowMs / 1000, 0) * 1000,
  };
}

export class LineDeduper {
  private readonly seen = new Map<string, { first: number; repeats: number; line: string }>();

  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** The lines to write for one complete line: pending summaries first, then the line unless it is a repeat. */
  accept(line: string): string[] {
    if (this.windowMs <= 0 || line.trim() === '') return [line];
    const out = this.flush(false);
    const key = line.replace(LEADING_TIMESTAMP, '');
    const entry = this.seen.get(key);
    if (entry) {
      entry.repeats++;
      return out;
    }
    if (this.seen.size >= MAX_TRACKED_LINES) out.push(...this.evict(this.seen.keys().next().value!));
    this.seen.set(key, { first: this.now(), repeats: 0, line });
    out.push(line);
    return out;
  }

  /** Summary lines for every line whose window has ended (all of them when forced). */
  flush(force: boolean): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.seen) {
      if (!force && this.now() - entry.first < this.windowMs) break;
      out.push(...this.evict(key));
    }
    return out;
  }

  private evict(key: string): string[] {
    const entry = this.seen.get(key)!;
    this.seen.delete(key);
    return entry.repeats > 0
      ? [`[gbrain serve-log] repeated ${entry.repeats} more time(s) in the last ${Math.round(this.windowMs / 1000)}s: ${entry.line}`]
      : [];
  }
}

/** One append-mode log descriptor: dedupes complete lines and rotates at the size bound when its path is known. */
export class ServeLogFile {
  private readonly dedupe: LineDeduper;
  private atLineStart = true;

  constructor(private readonly fd: number, private readonly path: string | null, private readonly policy: ServeLogPolicy, now: () => number = Date.now) {
    this.dedupe = new LineDeduper(policy.dedupeWindowMs, now);
  }

  write(text: string): void {
    const parts = text.split('\n');
    const tail = parts.pop()!;
    const out: string[] = [];
    for (const line of parts) {
      out.push(...(this.atLineStart ? this.dedupe.accept(line) : [line]));
      this.atLineStart = true;
    }
    let chunk = out.map(line => `${line}\n`).join('');
    if (tail !== '') {
      chunk += tail;
      this.atLineStart = false;
    }
    this.emit(chunk);
  }

  /** Writes the summaries of windows that ended (all pending ones when forced, at exit). */
  flush(force: boolean): void {
    const lines = this.dedupe.flush(force);
    if (!lines.length) return;
    this.emit(`${this.atLineStart ? '' : '\n'}${lines.map(line => `${line}\n`).join('')}`);
    this.atLineStart = true;
  }

  private emit(chunk: string): void {
    if (chunk === '') return;
    const bytes = Buffer.from(chunk, 'utf8');
    if (this.path === null || this.policy.maxBytes <= 0) {
      writeSync(this.fd, bytes);
      return;
    }
    let size = fstatSync(this.fd).size;
    if (size > 0 && size + bytes.length > this.policy.maxBytes && this.rotate()) size = 0;
    writeSync(this.fd, bytes, 0, bytes.length, size);
  }

  private rotate(): boolean {
    const path = this.path!;
    const current = fstatSync(this.fd);
    if (!existsSync(path) || statSync(path).ino !== current.ino) return false;
    for (let i = this.policy.maxFiles - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    copyFileSync(path, `${path}.1`);
    ftruncateSync(this.fd, 0);
    return true;
  }
}

function regularFilePath(fd: number): { file: boolean; path: string | null } {
  let stat;
  try {
    stat = fstatSync(fd);
  } catch {
    return { file: false, path: null };
  }
  if (!stat.isFile()) return { file: false, path: null };
  const candidates: string[] = [];
  try { candidates.push(readlinkSync(`/proc/self/fd/${fd}`)); } catch { /* not Linux */ }
  candidates.push(serveLogPath(), serveErrPath());
  for (const candidate of candidates) {
    try {
      const s = statSync(candidate);
      if (s.ino === stat.ino && s.dev === stat.dev) return { file: true, path: candidate };
    } catch { /* not this one */ }
  }
  return { file: true, path: null };
}

let installed = false;

/**
 * Routes serve's console and stream writes for each log-file stream through a
 * ServeLogFile. stdout only under --http: stdio serve's stdout is the JSON-RPC
 * channel and is never touched.
 */
export function installServeLogSink(opts: { http: boolean; env?: Record<string, string | undefined> }): void {
  if (installed) return;
  const env = opts.env ?? process.env;
  const streams: Array<{ fd: number; stream: NodeJS.WriteStream; methods: Array<'log' | 'info' | 'debug' | 'error' | 'warn'> }> = [
    { fd: 2, stream: process.stderr, methods: ['error', 'warn'] },
    ...(opts.http ? [{ fd: 1, stream: process.stdout, methods: ['log', 'info', 'debug'] as Array<'log' | 'info' | 'debug'> }] : []),
  ];
  const targets = streams.map(entry => ({ ...entry, ...regularFilePath(entry.fd) })).filter(entry => entry.file);
  if (!targets.length) return;
  installed = true;
  const policy = resolveServeLogPolicy(env, line => process.stderr.write(`${line}\n`));
  const logs: ServeLogFile[] = [];
  for (const target of targets) {
    const log = new ServeLogFile(target.fd, target.path, policy);
    logs.push(log);
    const write = (chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), maybeCb?: (err?: Error | null) => void): boolean => {
      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
      log.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding));
      if (cb) queueMicrotask(() => cb(null));
      return true;
    };
    target.stream.write = write as typeof target.stream.write;
    for (const method of target.methods) console[method] = (...args: unknown[]) => log.write(`${formatWithOptions({ colors: false }, ...args)}\n`);
  }
  if (policy.dedupeWindowMs > 0) {
    setInterval(() => { for (const log of logs) log.flush(false); }, Math.min(policy.dedupeWindowMs, 60_000)).unref();
  }
  process.on('exit', () => { for (const log of logs) log.flush(true); });
}
