/**
 * A credential read from stdin never tells the user to put the secret in argv.
 *
 * The generic stdin recovery says "pass it as an argument", which is right for
 * a page body and wrong for a cookie or API key (argv shows up in ps and shell
 * history). Credential callers get a recovery that names only the stdin pipe.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdinFailureMessage } from '../src/core/stdin-read.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ARGV_HINT = /as an argument|on the command line instead|--cookie [^-\s]|--token [^-\s]/;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-cred-stdin-'));
  const init = await runCli(['init', '--pglite', '--no-embedding'], 'devnull');
  expect(init.exitCode).toBe(0);
}, 60_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function runCli(args: string[], stdin: 'silent' | 'partial' | 'devnull') {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GBRAIN_'))) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: home,
    env: { ...base, GBRAIN_HOME: home, HOME: home, GBRAIN_STDIN_TIMEOUT_MS: '1500', GBRAIN_NON_INTERACTIVE: '1' },
    stdin: stdin === 'devnull' ? Bun.file('/dev/null') : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin === 'partial') { (proc.stdin as { write: (s: string) => void; flush?: () => void }).write('sk-partial'); (proc.stdin as { flush?: () => void }).flush?.(); }
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 25_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
    if (stdin !== 'devnull') try { (proc.stdin as { end?: () => void }).end?.(); } catch { /* closed */ }
  }
}

describe('credential stdin recovery', () => {
  test('the credential message for a silent pipe names only the stdin pipe', () => {
    const msg = stdinFailureMessage({ kind: 'timeout', phase: 'first_byte', bytes: 0 }, "printf '%s' \"$KEY\" | gbrain connectors auth fireflies --token -", { credential: true });
    expect(msg).toContain('stdin was open but silent');
    expect(msg).not.toMatch(ARGV_HINT);
    expect(msg).toContain('Never put the credential on the command line');
  });

  test('the credential message for a partial read discards it and names only the pipe', () => {
    const msg = stdinFailureMessage({ kind: 'timeout', phase: 'inactivity', bytes: 10 }, 'x', { credential: true });
    expect(msg).toContain('discarded');
    expect(msg).not.toMatch(ARGV_HINT);
  });

  test('the credential message for an oversize or failed read never suggests argv', () => {
    const msg = stdinFailureMessage({ kind: 'error', error: new Error('stdin exceeds 65536 bytes'), bytes: 70000 }, 'x', { credential: true });
    expect(msg).not.toMatch(ARGV_HINT);
    expect(msg).toContain('nothing was saved');
  });

  test('connectors auth --cookie - on a silent pipe: exit 1, no argv advice, nothing saved', async () => {
    const r = await runCli(['connectors', 'auth', 'chatgpt', '--cookie', '-'], 'silent');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('stdin was open but silent');
    expect(r.stderr).not.toMatch(ARGV_HINT);
    expect(existsSync(join(home, '.gbrain', 'connectors', 'chatgpt.json'))).toBe(false);
  }, 30_000);

  test('connectors auth --cookie - with a partial read that never closes: exit 1, discarded, nothing saved', async () => {
    const r = await runCli(['connectors', 'auth', 'chatgpt', '--cookie', '-'], 'partial');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toMatch(ARGV_HINT);
    expect(r.stderr).not.toContain('sk-partial');
    expect(existsSync(join(home, '.gbrain', 'connectors', 'chatgpt.json'))).toBe(false);
  }, 30_000);
});
