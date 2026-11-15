/**
 * `gbrain wakeshift emit cron.finished` is the last line of a user's cron script, so a brain it cannot open (a live
 * serve holding the PGLite lock, a Postgres outage) must not fail that script: one stderr line, exit 0. A bad
 * argument list still exits 2. Spawns the real CLI against an unreachable Postgres, so the connect itself fails.
 *
 * Spawns a subprocess and writes its own tmpdir; it never mutates this process's environment.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let home: string;

async function emit(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, 'wakeshift', 'emit', ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 50_000);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
  } finally {
    clearTimeout(killer);
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-emit-connect-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://gbrain:gbrain@127.0.0.1:1/gbrain' }), { mode: 0o600 });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('wakeshift emit when the brain cannot be opened', () => {
  test('exits 0 with one stderr line naming the run, so the cron script keeps its own status', async () => {
    const r = await emit(['cron.finished', '--name', 'nightly-example', '--status', 'ok']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('[wakeshift] could not record the nightly-example run');
  }, 60_000);

  test('a malformed emit still exits 2 with the usage line', async () => {
    const r = await emit(['cron.finished', '--name', 'nightly-example']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Usage: gbrain wakeshift emit cron.finished');
  }, 60_000);
});
