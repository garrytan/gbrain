/**
 * C10 (agent operator wave): `gbrain serve --fail-fast` / GBRAIN_SERVE_FAIL_FAST=1
 * is for process supervisors: when serve cannot start, it exits non-zero
 * with the classified error envelope (one JSON document) on stderr instead
 * of staying up in a degraded or status-only mode.
 *
 * Seam: the real CLI against a Postgres brain that is unreachable (degraded
 * serve would otherwise start and wait on stdin). Serial: spawns a process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFailFastRequested } from '../src/core/serve-fail-fast.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-serve-fail-fast-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://gbrain@127.0.0.1:1/unreachable' }));
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function serve(args: string[], extraEnv: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GBRAIN_') && k !== 'DATABASE_URL')) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, 'serve', ...args], {
    cwd: home,
    env: { ...base, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_RETRY_CONNECT: '1', ...extraEnv },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 45_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode, killed };
  } finally {
    clearTimeout(killer);
  }
}

describe('serve --fail-fast', () => {
  test('flag and env both request it; "0"/"false" do not', () => {
    expect(serveFailFastRequested(['--fail-fast'], {})).toBe(true);
    expect(serveFailFastRequested([], { GBRAIN_SERVE_FAIL_FAST: '1' })).toBe(true);
    expect(serveFailFastRequested([], { GBRAIN_SERVE_FAIL_FAST: 'false' })).toBe(false);
    expect(serveFailFastRequested(['--', '--fail-fast'], {})).toBe(false);
  });

  test('an unreachable brain exits non-zero before the handshake with the classified envelope on stderr', async () => {
    const r = await serve(['--fail-fast']);
    expect(r.killed).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
    const start = r.stderr.indexOf('{\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const envelope = JSON.parse(r.stderr.slice(start, r.stderr.indexOf('\n}\n', start) + 2));
    expect(envelope).toMatchObject({ contract_version: 1 });
    expect(typeof envelope.code).toBe('string');
    expect(typeof envelope.suggestion).toBe('string');
  }, 60_000);
});
