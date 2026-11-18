import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';

const CLI_PATH = join(import.meta.dir, '..', 'src', 'cli.ts');
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

test('--json prints one document when a cwd .env triggers the sanitized re-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-json-rerun-'));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-json-rerun-home-'));
  scratch.push(dir, home);
  writeFileSync(join(dir, '.env'), 'GIT_SSL_NO_VERIFY=1\n');
  const proc = Bun.spawn([process.execPath, CLI_PATH, 'doctor', '--only', 'no-such-check', '--json', '--no-migrate'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, PWD: dir, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let docs = 0;
  let outcome = '';
  try { JSON.parse(stdout); docs = 1; } catch (e) { outcome = String(e); docs = (stdout.match(/^\{/gm) ?? []).length; }
  expect(code).not.toBe(0);
  expect(docs).toBe(1);
  expect(outcome).toBe('');
}, 60_000);
