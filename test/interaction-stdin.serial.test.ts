/**
 * A5 interaction primitive (src/core/interaction.ts) against a REAL process
 * stdin: each case runs a child `bun -e` driver whose fd 0 is a pipe, a file,
 * /dev/null or a pseudo-terminal. The driver never calls process.exit, so
 * every case also proves the reader leaves no stdin listener or ref behind:
 * the child must exit on its own while its stdin pipe is still held open.
 *
 * Serial lane: concurrent subprocess spawns (one of them sleeps 8 s to pin the
 * slow-first-byte contract) and PTY sessions, same rationale as
 * test/cli-stdin-hang.test.ts and test/init-picker-pty.serial.test.ts.
 * The in-process half (decision table, injected streams) is
 * test/interaction.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTty, ptySupported } from './helpers/tty-harness.ts';

const REPO = join(import.meta.dir, '..');
const MOD = join(REPO, 'src', 'core', 'interaction.ts');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'OPENCODE_PID'];
const TMP = mkdtempSync(join(tmpdir(), 'gbrain-interaction-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DRIVER = `
const m = await import(${JSON.stringify(MOD)});
const mode = process.env.MODE;
const opts = JSON.parse(process.env.OPTS || '{}');
let r;
if (mode === 'payload') r = await m.readStdinBounded(opts);
if (mode === 'cancel') {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  r = await m.readStdinBounded({ ...opts, signal: ac.signal });
}
if (mode === 'readline') r = await m.readLine({ prompt: 'PROMPT> ', ...opts });
if (mode === 'readline2') r = [await m.readLine({ prompt: 'ONE> ' }), await m.readLine({ prompt: 'TWO> ' })];
if (mode === 'probe') {
  const probe = { env: opts.env, stdinIsTTY: true, stdoutIsTTY: true };
  r = [m.isInteractive(probe), m.isInteractive(probe)];
}
if (r && r.kind === 'error') r = { ...r, error: r.error.message };
console.log('__RESULT__' + JSON.stringify(r));
`;

type Stdin = 'hold-open' | 'closed-empty' | { file: string } | { chunks: Array<{ afterMs: number; data: string }>; thenEnd: boolean };

interface Run { exitedOnItsOwn: boolean; result: unknown; stderr: string; elapsedMs: number }

/** Parent env minus anything that changes the decision under test. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['GBRAIN_STDIN_TIMEOUT_MS', 'GBRAIN_INTERACTIVE', 'GBRAIN_NON_INTERACTIVE', 'CI', ...MARKERS]) delete env[k];
  return { ...env, ...extra };
}

async function runDriver(mode: string, stdin: Stdin, opts: { env?: Record<string, string>; driverOpts?: unknown; windowMs?: number } = {}): Promise<Run> {
  const started = Date.now();
  const proc = Bun.spawn(['bun', '-e', DRIVER], {
    cwd: REPO,
    env: cleanEnv({ MODE: mode, OPTS: JSON.stringify(opts.driverOpts ?? {}), ...opts.env }),
    stdin: typeof stdin === 'object' && 'file' in stdin ? Bun.file(stdin.file) : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sink = typeof proc.stdin === 'object' && proc.stdin !== null ? proc.stdin : null;
  let exitedOnItsOwn = true;
  const killer = setTimeout(() => {
    exitedOnItsOwn = false;
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
  }, opts.windowMs ?? 20_000);
  const feed = (async () => {
    if (!sink) return;
    if (stdin === 'closed-empty') return void (await sink.end());
    if (typeof stdin === 'object' && 'chunks' in stdin) {
      for (const c of stdin.chunks) {
        await Bun.sleep(c.afterMs);
        try { sink.write(c.data); await sink.flush(); } catch { /* child gone */ }
      }
      if (stdin.thenEnd) try { await sink.end(); } catch { /* child gone */ }
    }
  })();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  await feed.catch(() => {});
  try { sink?.end(); } catch { /* hold-open cleanup */ }
  const m = stdout.match(/__RESULT__(.*)/);
  return { exitedOnItsOwn, result: m ? JSON.parse(m[1]) : undefined, stderr, elapsedMs: Date.now() - started };
}

describe('readStdinBounded on a real process stdin', () => {
  test('slow first byte (8 s) succeeds, with the 5 s notice naming GBRAIN_STDIN_TIMEOUT_MS', async () => {
    const run = await runDriver('payload', { chunks: [{ afterMs: 8000, data: 'late payload' }], thenEnd: true }, { windowMs: 25_000 });
    expect(run.exitedOnItsOwn).toBe(true);
    expect(run.result).toEqual({ kind: 'data', text: 'late payload' });
    expect(run.stderr).toContain('waiting for stdin');
    expect(run.stderr).toContain('GBRAIN_STDIN_TIMEOUT_MS');
    expect(run.stderr.match(/waiting for stdin/g)?.length).toBe(1);
  }, 30_000);

  test('an open silent pipe times out at GBRAIN_STDIN_TIMEOUT_MS and the process exits with the pipe still open', async () => {
    const run = await runDriver('payload', 'hold-open', { env: { GBRAIN_STDIN_TIMEOUT_MS: '300' } });
    expect(run.exitedOnItsOwn).toBe(true);
    expect(run.result).toEqual({ kind: 'timeout', phase: 'first_byte', bytes: 0 });
    expect(run.stderr).not.toContain('waiting for stdin');
  }, 30_000);

  test('one byte then a stall times out in the inactivity phase; the partial byte is not returned', async () => {
    const run = await runDriver('payload', { chunks: [{ afterMs: 0, data: 'x' }], thenEnd: false }, { driverOpts: { inactivityMs: 300 } });
    expect(run.exitedOnItsOwn).toBe(true);
    expect(run.result).toEqual({ kind: 'timeout', phase: 'inactivity', bytes: 1 });
  }, 30_000);

  test('cancellation on a silent pipe is cancelled and the process exits', async () => {
    const run = await runDriver('cancel', 'hold-open');
    expect(run.exitedOnItsOwn).toBe(true);
    expect(run.result).toEqual({ kind: 'cancelled', bytes: 0 });
  }, 30_000);

  test('an empty pipe that closes at once is empty', async () => {
    const run = await runDriver('payload', 'closed-empty');
    expect(run.result).toEqual({ kind: 'empty' });
  }, 30_000);

  test('/dev/null is empty without waiting', async () => {
    const run = await runDriver('payload', { file: '/dev/null' });
    expect(run.result).toEqual({ kind: 'empty' });
  }, 30_000);

  test('a regular file is read whole; past maxBytes it is an error', async () => {
    const f = join(TMP, 'payload.md');
    writeFileSync(f, '# title\nbody\n');
    expect((await runDriver('payload', { file: f })).result).toEqual({ kind: 'data', text: '# title\nbody\n' });
    const big = await runDriver('payload', { file: f }, { driverOpts: { maxBytes: 4 } });
    expect((big.result as { kind: string }).kind).toBe('error');
  }, 30_000);

  test('multiple chunks then EOF are returned whole', async () => {
    const run = await runDriver('payload', { chunks: [{ afterMs: 0, data: 'a' }, { afterMs: 100, data: 'b' }, { afterMs: 100, data: 'c' }], thenEnd: true });
    expect(run.result).toEqual({ kind: 'data', text: 'abc' });
  }, 30_000);
});

describe('readLine and the interactivity notice', () => {
  test('non-interactive readLine returns eof at once without prompting, even on an open pipe', async () => {
    const run = await runDriver('readline', 'hold-open');
    expect(run.exitedOnItsOwn).toBe(true);
    expect(run.result).toEqual({ kind: 'eof' });
    expect(run.stderr).not.toContain('PROMPT>');
    expect(run.elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  for (const cause of ['CLAUDECODE', 'CODEX_CI', 'CI']) {
    test(`${cause} on two TTYs prints ONE stderr line per process naming it and GBRAIN_INTERACTIVE=1`, async () => {
      const run = await runDriver('probe', 'closed-empty', { driverOpts: { env: { [cause]: '1' } } });
      expect(run.result).toEqual([false, false]);
      const lines = run.stderr.split('\n').filter(l => l.includes('prompts are off'));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(cause);
      expect(lines[0]).toContain('GBRAIN_INTERACTIVE=1');
    }, 30_000);
  }

  test('no notice for a human (CODEX_HOME only), GBRAIN_NON_INTERACTIVE, or the override', async () => {
    for (const [env, want] of [
      [{ CODEX_HOME: '/home/u/.codex' }, [true, true]],
      [{ GBRAIN_NON_INTERACTIVE: '1', CLAUDECODE: '1' }, [false, false]],
      [{ GBRAIN_INTERACTIVE: '1', CLAUDECODE: '1' }, [true, true]],
    ] as const) {
      const run = await runDriver('probe', 'closed-empty', { driverOpts: { env } });
      expect(run.result).toEqual(want);
      expect(run.stderr).not.toContain('prompts are off');
    }
  }, 30_000);
});

describe('readLine under a real pseudo-terminal', () => {
  if (process.env.CI) {
    test('PTY support is mandatory on CI', () => expect(ptySupported()).toBe(true));
  }
  const ptyTest = ptySupported() ? test : test.skip;
  const ptyEnv = (extra: Record<string, string>) => ({ MODE: 'readline2', HOME: TMP, GBRAIN_HOME: join(TMP, '.gbrain'), ...extra });

  async function drive(extra: Record<string, string>, steps: (s: ReturnType<typeof launchTty>) => Promise<void>): Promise<string> {
    const s = launchTty(['bun', '-e', DRIVER], { cwd: REPO, env: ptyEnv(extra), dropEnv: ['CI', 'GBRAIN_INTERACTIVE', 'GBRAIN_NON_INTERACTIVE', ...MARKERS].filter(k => !(k in extra)), timeoutMs: 30_000 });
    try {
      await steps(s);
      expect(await s.waitForExit(10_000)).toBe(0);
      return s.visible();
    } finally {
      await s.close();
    }
  }

  ptyTest('a human types two answers: both lines read, and the process exits on its own', async () => {
    const out = await drive({}, async s => {
      await s.waitFor('ONE> ', { timeoutMs: 10_000 });
      s.send('first answer\r');
      await s.waitFor('TWO> ', { timeoutMs: 10_000 });
      s.send('  second  \r');
    });
    expect(out).toContain('__RESULT__[{"kind":"line","text":"first answer"},{"kind":"line","text":"second"}]');
  }, 40_000);

  ptyTest('Ctrl-D at the prompt is eof (a decline)', async () => {
    const out = await drive({}, async s => {
      await s.waitFor('ONE> ', { timeoutMs: 10_000 });
      s.send('\x04');
      await s.waitFor('TWO> ', { timeoutMs: 10_000 });
    });
    expect(out).toContain('__RESULT__[{"kind":"eof"},{"kind":"eof"}]');
  }, 40_000);

  ptyTest('an agent marker on a real terminal: no prompt, eof, one notice line naming the override', async () => {
    const out = await drive({ CLAUDECODE: '1' }, async s => { await s.waitFor('__RESULT__', { timeoutMs: 10_000 }); });
    expect(out).toContain('__RESULT__[{"kind":"eof"},{"kind":"eof"}]');
    expect(out).not.toContain('ONE> ');
    expect(out.match(/prompts are off: CLAUDECODE/g)?.length).toBe(1);
    expect(out).toContain('GBRAIN_INTERACTIVE=1');
  }, 40_000);

  ptyTest('GBRAIN_INTERACTIVE=1 lets a human behind an agent marker answer', async () => {
    const out = await drive({ CLAUDECODE: '1', GBRAIN_INTERACTIVE: '1' }, async s => {
      await s.waitFor('ONE> ', { timeoutMs: 10_000 });
      s.send('y\r');
      await s.waitFor('TWO> ', { timeoutMs: 10_000 });
      s.send('n\r');
    });
    expect(out).toContain('__RESULT__[{"kind":"line","text":"y"},{"kind":"line","text":"n"}]');
    expect(out).not.toContain('prompts are off');
  }, 40_000);
});
