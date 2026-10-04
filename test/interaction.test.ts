/**
 * A5 interaction primitive (src/core/interaction.ts), in-process half: the
 * isInteractive decision table, agentProcessMarker, and readLine /
 * readStdinBounded against injected streams with short timeouts. The real
 * process-stdin cases (natural exit, 8 s slow first byte, /dev/null, the
 * one-per-process stderr line) live in test/interaction-stdin.serial.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PassThrough, Readable } from 'node:stream';
import {
  agentProcessMarker,
  isInteractive,
  readLine,
  readStdinBounded,
  type StdinRead,
} from '../src/core/interaction.ts';

const TTY = { stdinIsTTY: true, stdoutIsTTY: true } as const;
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'OPENCODE_PID'];

describe('isInteractive decision table', () => {
  const rows: Array<[string, NodeJS.ProcessEnv, { stdinIsTTY: boolean; stdoutIsTTY: boolean }, boolean]> = [
    ['a human on two TTYs', {}, TTY, true],
    ['a human with only CODEX_HOME keeps prompts', { CODEX_HOME: '/home/u/.codex' }, TTY, true],
    ['stdin not a TTY', {}, { stdinIsTTY: false, stdoutIsTTY: true }, false],
    ['stdout not a TTY', {}, { stdinIsTTY: true, stdoutIsTTY: false }, false],
    ['CI=true', { CI: 'true' }, TTY, false],
    ['CI=1', { CI: '1' }, TTY, false],
    ['CI=false is not CI', { CI: 'false' }, TTY, true],
    ['CI=0 is not CI', { CI: '0' }, TTY, true],
    ['GBRAIN_NON_INTERACTIVE=1', { GBRAIN_NON_INTERACTIVE: '1' }, TTY, false],
    ['GBRAIN_INTERACTIVE=1 overrides an agent marker', { CLAUDECODE: '1', GBRAIN_INTERACTIVE: '1' }, TTY, true],
    ['GBRAIN_INTERACTIVE=1 overrides CI', { CI: 'true', GBRAIN_INTERACTIVE: '1' }, TTY, true],
    ['GBRAIN_INTERACTIVE=1 overrides GBRAIN_NON_INTERACTIVE', { GBRAIN_NON_INTERACTIVE: '1', GBRAIN_INTERACTIVE: '1' }, TTY, true],
    ['GBRAIN_INTERACTIVE=1 cannot conjure a TTY', { GBRAIN_INTERACTIVE: '1' }, { stdinIsTTY: false, stdoutIsTTY: true }, false],
    ['GBRAIN_INTERACTIVE=0 is not an override', { CLAUDECODE: '1', GBRAIN_INTERACTIVE: '0' }, TTY, false],
    ...MARKERS.map((m): [string, NodeJS.ProcessEnv, typeof TTY, boolean] => [`agent marker ${m}`, { [m]: '1' }, TTY, false]),
  ];
  for (const [name, env, ttys, want] of rows) {
    test(name, () => {
      expect(isInteractive({ env, ...ttys })).toBe(want);
    });
  }
});

describe('agentProcessMarker', () => {
  test('names each process-scoped marker', () => {
    for (const m of MARKERS) expect(agentProcessMarker({ [m]: '1' })).toBe(m);
  });
  test('never CODEX_HOME; empty values do not count', () => {
    expect(agentProcessMarker({ CODEX_HOME: '/x' })).toBeNull();
    expect(agentProcessMarker({ CLAUDECODE: '' })).toBeNull();
    expect(agentProcessMarker({})).toBeNull();
  });
});

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const parts: string[] = [];
  stream.on('data', c => parts.push(c.toString()));
  return { stream, text: () => parts.join('') };
}

const listenerTotal = (s: NodeJS.ReadableStream) =>
  ['data', 'end', 'error', 'close'].reduce((n, e) => n + s.listenerCount(e), 0);

describe('readLine', () => {
  test('non-interactive returns eof at once without prompting or reading', async () => {
    const input = new PassThrough();
    const out = sink();
    const started = Date.now();
    const r = await readLine({ prompt: 'Proceed? ', input, output: out.stream, probe: { env: {}, stdinIsTTY: false, stdoutIsTTY: true } });
    expect(r).toEqual({ kind: 'eof' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(out.text()).toBe('');
    expect(listenerTotal(input)).toBe(0);
  });

  test('an agent marker on two TTYs is non-interactive: eof without reading', async () => {
    const input = new PassThrough();
    const r = await readLine({ prompt: 'Q ', input, output: sink().stream, probe: { env: { CODEX_SANDBOX: 'seatbelt' }, ...TTY } });
    expect(r).toEqual({ kind: 'eof' });
  });

  const human = { env: {}, ...TTY };

  test('reads one trimmed line; prompt goes to the output stream; listeners removed', async () => {
    const input = new PassThrough();
    const out = sink();
    const p = readLine({ prompt: 'Name? ', input, output: out.stream, probe: human });
    input.write('  Ada  \r\n');
    expect(await p).toEqual({ kind: 'line', text: 'Ada' });
    expect(out.text()).toBe('Name? ');
    expect(listenerTotal(input)).toBe(0);
  });

  test('bytes after the newline stay for the next read', async () => {
    const input = new PassThrough();
    const p1 = readLine({ prompt: '', input, output: sink().stream, probe: human });
    input.write('one\ntwo\n');
    expect(await p1).toEqual({ kind: 'line', text: 'one' });
    const p2 = readLine({ prompt: '', input, output: sink().stream, probe: human });
    expect(await p2).toEqual({ kind: 'line', text: 'two' });
  });

  test('EOF with nothing typed is eof (a decline); an ended stream stays eof', async () => {
    const input = new PassThrough();
    const p = readLine({ prompt: '', input, output: sink().stream, probe: human });
    input.end();
    expect(await p).toEqual({ kind: 'eof' });
    expect(await readLine({ prompt: '', input, output: sink().stream, probe: human })).toEqual({ kind: 'eof' });
  });

  test('EOF after a partial line returns the text', async () => {
    const input = new PassThrough();
    const p = readLine({ prompt: '', input, output: sink().stream, probe: human });
    input.end('y');
    expect(await p).toEqual({ kind: 'line', text: 'y' });
  });

  test('timeout is its own result (a decline) and cleans up', async () => {
    const input = new PassThrough();
    const r = await readLine({ prompt: '', timeoutMs: 50, input, output: sink().stream, probe: human });
    expect(r).toEqual({ kind: 'timeout' });
    expect(listenerTotal(input)).toBe(0);
  });
});

describe('readStdinBounded (injected stream)', () => {
  const read = (stream: NodeJS.ReadableStream, extra: Parameters<typeof readStdinBounded>[0] = {}) =>
    readStdinBounded({ firstByteMs: 2000, inactivityMs: 2000, ...extra, stream });

  test('data then EOF is data', async () => {
    const s = new PassThrough();
    const p = read(s);
    s.write('hello ');
    s.end('world');
    expect(await p).toEqual({ kind: 'data', text: 'hello world' });
    expect(listenerTotal(s)).toBe(0);
  });

  test('zero bytes then EOF is empty', async () => {
    const s = new PassThrough();
    const p = read(s);
    s.end();
    expect(await p).toEqual({ kind: 'empty' });
  });

  test('an open silent stream times out in the first_byte phase', async () => {
    const s = new PassThrough();
    expect(await read(s, { firstByteMs: 50 })).toEqual({ kind: 'timeout', phase: 'first_byte', bytes: 0 });
    expect(listenerTotal(s)).toBe(0);
  });

  test('one byte then a stall times out in the inactivity phase; the partial byte is not returned', async () => {
    const s = new PassThrough();
    const p = read(s, { inactivityMs: 80 });
    s.write('x');
    const r = await p;
    expect(r).toEqual({ kind: 'timeout', phase: 'inactivity', bytes: 1 });
    expect('text' in r).toBe(false);
  });

  test('inactivity resets on every chunk: no total time cap', async () => {
    const s = new PassThrough();
    const p = read(s, { firstByteMs: 200, inactivityMs: 120 });
    for (let i = 0; i < 8; i++) {
      s.write(String(i));
      await Bun.sleep(50);
    }
    s.end();
    expect(await p).toEqual({ kind: 'data', text: '01234567' });
  });

  test('partial then a stream error is an error carrying the byte count, never data', async () => {
    const s = new PassThrough();
    const p = read(s);
    s.write('abc');
    await Bun.sleep(5);
    s.destroy(new Error('EPIPE-ish'));
    const r = await p;
    expect(r.kind).toBe('error');
    expect((r as Extract<StdinRead, { kind: 'error' }>).bytes).toBe(3);
    expect((r as Extract<StdinRead, { kind: 'error' }>).error.message).toBe('EPIPE-ish');
  });

  test('close without end is an error, not a short success', async () => {
    const s = new PassThrough();
    const p = read(s);
    s.write('ab');
    await Bun.sleep(5);
    s.destroy();
    const r = await p;
    expect(r.kind).toBe('error');
    expect((r as Extract<StdinRead, { kind: 'error' }>).bytes).toBe(2);
  });

  test('cancellation mid-read is cancelled with the byte count', async () => {
    const s = new PassThrough();
    const ac = new AbortController();
    const p = read(s, { signal: ac.signal });
    s.write('abcd');
    await Bun.sleep(5);
    ac.abort();
    expect(await p).toEqual({ kind: 'cancelled', bytes: 4 });
    expect(listenerTotal(s)).toBe(0);
  });

  test('an already-aborted signal returns cancelled without reading', async () => {
    const s = new PassThrough();
    const ac = new AbortController();
    ac.abort();
    expect(await read(s, { signal: ac.signal })).toEqual({ kind: 'cancelled', bytes: 0 });
    expect(listenerTotal(s)).toBe(0);
  });

  test('input past maxBytes is an error, never truncated data', async () => {
    const s = new PassThrough();
    const p = read(s, { maxBytes: 4 });
    s.write('abc');
    s.write('de');
    const r = await p;
    expect(r.kind).toBe('error');
    expect((r as Extract<StdinRead, { kind: 'error' }>).error.message).toContain('exceeds 4 bytes');
  });

  test('string chunks and multi-byte UTF-8 split across chunks decode intact', async () => {
    const bytes = Buffer.from('héllo ✓');
    const s = Readable.from([bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)]);
    expect(await read(s)).toEqual({ kind: 'data', text: 'héllo ✓' });
  });

  test('an already-consumed stream is an error', async () => {
    const s = new PassThrough();
    const p = read(s);
    s.end();
    await p;
    const r = await read(s);
    expect(r.kind).toBe('error');
  });
});
