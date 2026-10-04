/**
 * C5 (agent operator wave): commands that read a payload from stdin never
 * hang on an open-but-silent pipe and never process partial input.
 *
 * Protects: `gbrain report` used readFileSync('/dev/stdin') (blocks forever on
 * an open pipe and ignores SIGTERM), `capture --stdin` and `connectors auth
 * --cookie -` used `for await (process.stdin)` (no EOF/timeout). Each now goes
 * through interaction.readStdinBounded via src/core/stdin-read.ts: a silent
 * pipe ends with the "stdin was open but silent" message and a non-zero exit;
 * a closed stdin (</dev/null) is an empty payload, not a hang.
 *
 * Serial: spawns the real CLI with stdin held open (GBRAIN_STDIN_TIMEOUT_MS
 * keeps it fast). Fails on the base: the report spawn is killed by the
 * harness timeout instead of exiting.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdinFailureMessage } from '../src/core/stdin-read.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let home: string;

beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-stdin-silent-')); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** Run the CLI with stdin an open pipe that never writes (or /dev/null). */
async function runCli(args: string[], stdin: 'silent' | 'devnull', timeoutMs = 20_000) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GBRAIN_'))) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: home,
    env: { ...base, GBRAIN_HOME: home, HOME: home, GBRAIN_STDIN_TIMEOUT_MS: '1500', GBRAIN_NON_INTERACTIVE: '1' },
    stdin: stdin === 'silent' ? 'pipe' : Bun.file('/dev/null'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr, killed };
  } finally {
    clearTimeout(killer);
    if (stdin === 'silent') try { (proc.stdin as { end?: () => void }).end?.(); } catch { /* closed */ }
  }
}

describe('silent stdin never hangs', () => {
  test('report: an open, silent pipe exits non-zero with the message; nothing is written', async () => {
    const r = await runCli(['report', '--type', 'maintenance', '--dir', home], 'silent');
    expect(r.killed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('stdin was open but silent');
    expect(r.stderr).toContain('GBRAIN_STDIN_TIMEOUT_MS');
    expect(readdirSync(home).includes('reports')).toBe(false);
  }, 30_000);

  test('report: a closed stdin (</dev/null) is an empty payload, reported as such, not a hang', async () => {
    const r = await runCli(['report', '--type', 'maintenance', '--dir', home], 'devnull');
    expect(r.killed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No content provided');
  }, 30_000);

  test('the inactivity and error messages say partial input was discarded', () => {
    expect(stdinFailureMessage({ kind: 'timeout', phase: 'inactivity', bytes: 12 }, 'x')).toContain('partial input was discarded');
    expect(stdinFailureMessage({ kind: 'error', error: new Error('boom'), bytes: 0 }, 'x')).toContain('nothing was written');
  });
});
