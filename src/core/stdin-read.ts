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

/**
 * The message for a read that produced no usable payload; `example` is a working pipe for this command.
 * `credential`: the payload is a secret (cookie, API key), so the recovery names only the stdin pipe and never
 * suggests passing it as an argument, where it would land in `ps` and shell history.
 */
export function stdinFailureMessage(read: Exclude<StdinRead, { kind: 'data' } | { kind: 'empty' }>, example: string, opts: { credential?: boolean } = {}): string {
  if (opts.credential) return credentialStdinFailureMessage(read, example);
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

function credentialStdinFailureMessage(read: Exclude<StdinRead, { kind: 'data' } | { kind: 'empty' }>, example: string): string {
  const never = 'Never put the credential on the command line; it would be visible in the process list and shell history.';
  if (read.kind === 'timeout' && read.phase === 'first_byte') {
    return 'stdin was open but silent: no credential arrived, so nothing was read or saved. '
      + `Pipe it on stdin (${example}). ${never} Set GBRAIN_STDIN_TIMEOUT_MS=<ms> to wait longer for the first byte.`;
  }
  if (read.kind === 'timeout') {
    return `stdin went silent after ${read.bytes} byte(s) without closing, so the partial credential was discarded and nothing was saved. `
      + `Close stdin when the credential is complete (${example}). ${never}`;
  }
  if (read.kind === 'cancelled') return `Reading the credential from stdin was cancelled after ${read.bytes} byte(s); nothing was saved.`;
  return `Could not read the credential from stdin (${read.error.message}); nothing was saved. Pipe it on stdin (${example}). ${never}`;
}

/** Read the whole payload, or explain why there is none. `empty` (clean EOF, zero bytes) is ok with ''. */
export async function readStdinPayload(example: string, opts: StdinReadOptions & { credential?: boolean } = {}): Promise<StdinPayload> {
  const { credential, ...readOpts } = opts;
  const read = await readStdinBounded({ ...readOpts, raw: true });
  if (read.kind === 'data') return { ok: true, text: read.text, raw: read.raw ?? Buffer.from(read.text, 'utf8') };
  if (read.kind === 'empty') return { ok: true, text: '', raw: Buffer.alloc(0) };
  return { ok: false, reason: read.kind, message: stdinFailureMessage(read, example, { credential }) };
}
