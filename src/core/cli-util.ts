import type { Operation } from './ops/contract.ts';

/**
 * Prompt on stdout, read one line from stdin, return trimmed string.
 * Shared helper used by interactive CLI flows (init, apply-migrations, etc.).
 */
export function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      const data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}

/**
 * Same as promptLine, but writes the prompt to stderr instead of stdout AND
 * resolves to `null` on stdin EOF or after `timeoutMs` (default 5 minutes)
 * instead of hanging forever. Used when the surrounding command must keep
 * stdout clean for machine-readable output (JSON, piped data); the thin-client
 * upgrade prompt fires before any routed command runs and would otherwise
 * pollute `gbrain query > out.json`.
 *
 * Return contract:
 *   - resolves to a `string` (trimmed) on the first stdin data event
 *   - resolves to `null` on stdin 'end' (parent shell closed, /dev/null piped
 *     past the TTY check, etc.) or after `timeoutMs` elapses
 *   - never rejects
 *
 * Callers MUST handle null explicitly — it is NOT the same as an empty string
 * (which means "user pressed Enter").
 */
export function promptLineStderr(prompt: string, opts: { timeoutMs?: number } = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    process.stdin.setEncoding('utf-8');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      if (timer !== null) clearTimeout(timer);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunk.toString().trim());
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
    }
    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * Coerce one raw CLI flag value to the operation param's declared type.
 * Structured (`object` / `array`) params parse as JSON so a CLI caller can
 * pass the same shapes MCP callers do; a malformed value or the wrong
 * top-level shape is an error rather than a string stored as a character map.
 */
export function parseTypedOpArg(
  key: string,
  type: Operation['params'][string]['type'],
  raw: string,
): unknown {
  if (type === 'boolean') return raw !== 'false';
  if (type === 'number') return Number(raw);
  if (type !== 'object' && type !== 'array') return raw;
  // Array-valued ops predate JSON CLI input and document comma-delimited
  // flag values. Preserve that wire shape unless the operator explicitly
  // supplies a JSON array. Individual
  // operation boundaries remain responsible for accepting or rejecting the
  // legacy string form.
  if (type === 'array' && !raw.trimStart().startsWith('[')) {
    if (raw.trimStart().startsWith('{')) {
      throw new Error(`--${key.replace(/_/g, '-')} requires a JSON array.`);
    }
    return raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${key.replace(/_/g, '-')} requires valid JSON ${type}.`);
  }
  if (type === 'array' ? !Array.isArray(parsed) : parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`--${key.replace(/_/g, '-')} requires a JSON ${type}.`);
  }
  return parsed;
}
