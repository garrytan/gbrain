/**
 * Serve-side capture of what an operation prints (and the per-process state a
 * one-shot CLI would start fresh: once-only warnings, the pinned fix source,
 * the first chat-fallback hop notice) while it answers a warm CLI request.
 * A cold CLI prints a handler's console and stderr lines itself; the
 * serve records them per request (AsyncLocalStorage, so concurrent MCP work
 * and other requests are untouched) and the CLI replays them in order before
 * rendering the result.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { setFallbackHopScope, type FallbackHopQueue } from '../ai/fallback-hop-queue.ts';
import { setSourceNoteScope } from '../fix-routing.ts';
import { setWarnOnceScope } from '../utils.ts';
import { MAX_CAPTURED_OUTPUT_BYTES, type OutputChunk } from './protocol.ts';

export class OutputCapture {
  readonly chunks: OutputChunk[] = [];
  /** This request's warnOncePerProcess keys: a cold CLI process starts with none. */
  readonly warned = new Set<string>();
  /** This request's chat_fallback_hop queue: a cold CLI process starts with an empty, unarmed one. */
  readonly fallbackHops: FallbackHopQueue = { queued: false, pending: [] };
  /** The first source this request resolved, which the CLI pins in its fix commands. */
  resolvedSource?: string;
  private bytes = 0;
  overflow = false;

  push(stream: OutputChunk[0], text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > MAX_CAPTURED_OUTPUT_BYTES) { this.overflow = true; return; }
    const last = this.chunks[this.chunks.length - 1];
    if (last && last[0] === stream) last[1] += text;
    else this.chunks.push([stream, text]);
  }
}

const store = new AsyncLocalStorage<OutputCapture>();
let uninstall: (() => void) | undefined;

/** Route console and stderr writes made inside a capture scope into it; outside a scope nothing changes. Idempotent. */
export function installOutputCapture(): void {
  if (uninstall) return;
  setWarnOnceScope(() => store.getStore()?.warned);
  setSourceNoteScope(() => store.getStore());
  setFallbackHopScope(() => store.getStore()?.fallbackHops);
  const methods = [['log', 'stdout'], ['info', 'stdout'], ['debug', 'stdout'], ['warn', 'stderr'], ['error', 'stderr']] as const;
  const originals = methods.map(([method]) => [method, console[method]] as const);
  for (const [method, stream] of methods) {
    const original = console[method];
    console[method] = (...args: unknown[]): void => {
      const capture = store.getStore();
      if (!capture) { original.apply(console, args); return; }
      capture.push(stream, format(...args) + '\n');
    };
  }
  const originalWrite = process.stderr.write;
  process.stderr.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    const capture = store.getStore();
    if (!capture) return (originalWrite as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    const encoding = typeof rest[0] === 'string' ? rest[0] as BufferEncoding : 'utf8';
    capture.push('stderr', typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString(encoding));
    const callback = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    if (callback) queueMicrotask(callback);
    return true;
  } as typeof process.stderr.write;
  uninstall = () => {
    for (const [method, original] of originals) console[method] = original;
    process.stderr.write = originalWrite;
    setWarnOnceScope(() => undefined);
    setSourceNoteScope(() => undefined);
    setFallbackHopScope(() => undefined);
  };
}

/**
 * Test-only: put console, stderr and the three per-request scopes back as they were before installOutputCapture.
 * The capture is process-global, so a test file that starts a serve or installs it must call this from an after
 * hook: otherwise every later file in the same bun process runs with the serve's routing (#7494).
 */
export function _uninstallOutputCaptureForTests(): void {
  uninstall?.();
  uninstall = undefined;
}

export function withOutputCapture<T>(capture: OutputCapture, fn: () => Promise<T>): Promise<T> {
  return store.run(capture, fn);
}
