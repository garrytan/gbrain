/**
 * Transcript capture for live-mode agent runs (D8 + D14, D17 backpressure).
 *
 * The existing minions/audit infrastructure is for INTERNAL gbrain subagents
 * only. External openclaw/hermes subprocesses don't write to those tables —
 * v1 builds its own capture channel here.
 *
 * Output: JSONL at `<run-tempdir>/transcript.jsonl`, one event per line.
 *   { schema_version: "1", ts, channel, byte_offset, bytes_b64 }
 *
 *  child stdout/stderr  ─piped─▶  TranscriptSink.write()
 *                                       │
 *                                       ▼
 *                       fs.createWriteStream (flags: 'a')
 *                          ▲
 *                          │ honors 'drain' events to avoid blocking
 *                          │ the child when bursts exceed the pipe buffer
 *                          ▼
 *                     transcript.jsonl  (line-tolerant readers
 *                                        skip malformed; render() resolves
 *                                        byte_offset → readable lines)
 *
 * Friction CLI's `transcript_offset` field references the byte offset INTO
 * `transcript.jsonl` (not into the captured payload). Render --transcripts
 * reads the file and finds the line that contains that offset.
 */

import { createWriteStream, type WriteStream } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { TranscriptEvent, TranscriptSink } from './agent-runner.ts';

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export function createTranscriptSink(path: string): TranscriptSink {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });

  let bytesWritten = 0;
  let drainPromise: Promise<void> | null = null;

  function awaitDrain(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = new Promise<void>(resolve => {
      stream.once('drain', () => {
        drainPromise = null;
        resolve();
      });
    });
    return drainPromise;
  }

  return {
    write(event: TranscriptEvent) {
      const line = JSON.stringify({
        schema_version: '1',
        ts: event.ts,
        channel: event.channel,
        byte_offset: bytesWritten,
        bytes_b64: event.bytes.toString('base64'),
      }) + '\n';
      bytesWritten += Buffer.byteLength(line, 'utf-8');
      const ok = stream.write(line, 'utf-8');
      // If the kernel buffer is full, write() returns false. We don't await
      // here (callers don't expect that), but next callers wait on drain
      // before writing further. Bun's WritableStream is small; the drain
      // window is typically a few µs.
      if (!ok) void awaitDrain();
    },

    nextOffset(): number {
      return bytesWritten;
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => err ? reject(err) : resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// spawnWithCapture
// ---------------------------------------------------------------------------

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  transcriptSink: TranscriptSink;
  /** Optional fixed input to write on stdin then close. */
  stdinPayload?: string;
}

export interface SpawnResult {
  exitCode: number;
  durationMs: number;
  /** True if SIGTERM/SIGKILL was issued due to timeout. */
  timedOut: boolean;
}

const SIGTERM_GRACE_MS = 5_000;
/** After 'exit', how long to wait for 'close' (pipe drain) before resolving anyway. */
const STREAM_DRAIN_GRACE_MS = 2_000;

export async function spawnWithCapture(bin: string, args: string[], opts: SpawnOpts): Promise<SpawnResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // Own process group so timeout kills reach grandchildren too — agents
        // spawn MCP servers and gbrain children; signalling only the direct
        // PID leaves those orphaned holding the stdout/stderr pipes open.
        detached: true,
      });
    } catch (e) {
      reject(e);
      return;
    }

    // Signal the whole process group (negative pid); fall back to the direct
    // child if the group is already gone or grouping failed.
    const killTree = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, sig); return; } catch { /* group gone or not a leader */ }
      }
      try { child.kill(sig); } catch { /* already gone */ }
    };

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const wallClockTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => {
        killTree('SIGKILL');
      }, SIGTERM_GRACE_MS);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      opts.transcriptSink.write({ ts: Date.now(), channel: 'stdout', bytes: chunk });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.transcriptSink.write({ ts: Date.now(), channel: 'stderr', bytes: chunk });
    });

    if (opts.stdinPayload !== undefined && child.stdin) {
      try {
        opts.transcriptSink.write({
          ts: Date.now(),
          channel: 'stdin',
          bytes: Buffer.from(opts.stdinPayload, 'utf-8'),
        });
        child.stdin.end(opts.stdinPayload, 'utf-8');
      } catch (e) {
        reject(e);
        return;
      }
    } else {
      // No payload: close stdin anyway. An agent build that waits for stdin
      // EOF would otherwise block silently until the wall-clock kill — a paid
      // live turn burned as a timeout.
      try { child.stdin?.end(); } catch { /* stream already gone */ }
    }

    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    child.on('error', (err) => {
      clearTimeout(wallClockTimer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // 'close' (all pipes drained) is the clean path. But a grandchild that
    // survives the group kill can hold the pipes open forever, so 'exit' arms
    // a short drain grace and then settles regardless — the harness must not
    // hang AFTER its own timeout already fired.
    child.on('close', (code) => settle(code));
    child.on('exit', (code) => {
      const t = setTimeout(() => settle(code), STREAM_DRAIN_GRACE_MS);
      t.unref?.();
    });
  });
}
