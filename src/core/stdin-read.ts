/**
 * Payload reads from stdin for CLI commands (agent operator wave C5).
 *
 * Wraps interaction.readStdinBounded (first-byte timeout, inactivity reset,
 * byte cap) and turns every non-data outcome into one actionable message, so
 * a command never hangs on an open-but-silent pipe and never processes
 * partial input as success.
 */
import { readStdinBounded, type StdinRead, type StdinReadOptions } from './interaction.ts';

export type StdinPayload = { ok: true; text: string; raw: Buffer } | { ok: false; reason: 'timeout' | 'cancelled' | 'error'; message: string };

/** The message for a read that produced no usable payload; `example` is a working pipe for this command. */
export function stdinFailureMessage(read: Exclude<StdinRead, { kind: 'data' } | { kind: 'empty' }>, example: string): string {
  if (read.kind === 'timeout' && read.phase === 'first_byte') {
    return 'stdin was open but silent: no input arrived, so nothing was read or written. '
      + `Pipe the content (${example}), redirect stdin from a file or </dev/null, or pass it as an argument. `
      + 'Set GBRAIN_STDIN_TIMEOUT_MS=<ms> to wait longer for the first byte.';
  }
  if (read.kind === 'timeout') {
    return `stdin went silent after ${read.bytes} byte(s) without closing, so the partial input was discarded and nothing was written. `
      + 'Close stdin when the payload is complete (end the pipe or redirect from a file).';
  }
  if (read.kind === 'cancelled') return `Reading stdin was cancelled after ${read.bytes} byte(s); nothing was written.`;
  return `Could not read stdin (${read.error.message}); nothing was written.`;
}

/** Read the whole payload, or explain why there is none. `empty` (clean EOF, zero bytes) is ok with ''. */
export async function readStdinPayload(example: string, opts: StdinReadOptions = {}): Promise<StdinPayload> {
  const read = await readStdinBounded({ ...opts, raw: true });
  if (read.kind === 'data') return { ok: true, text: read.text, raw: read.raw ?? Buffer.from(read.text, 'utf8') };
  if (read.kind === 'empty') return { ok: true, text: '', raw: Buffer.alloc(0) };
  return { ok: false, reason: read.kind, message: stdinFailureMessage(read, example) };
}
