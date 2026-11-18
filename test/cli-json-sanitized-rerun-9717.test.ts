/**
 * #9717: with a .env in the working directory that assigns a protected key, the CLI re-runs itself sanitized with fd 1
 * inherited. The re-run writes the command's JSON document; the wrapper used to add its own `command_failed` fallback
 * on a non-zero exit, so stdout held two documents. Spawned directly (not through test/helpers/cli-spawn.ts, which
 * passes --no-env-file and would keep Bun from loading the .env), with a hermetic HOME.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const CLI_PATH = join(import.meta.dir, '..', 'src', 'cli.ts');
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function runFrom(dotenv: string | null, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-9717-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-9717-home-'));
  scratch.push(dir, home);
  if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv);
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, PWD: dir, GBRAIN_SKIP_STARTUP_HOOKS: '1' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('#9717: --json after the sanitized re-run', () => {
  const failing = ['doctor', '--only', 'no-such-check', '--json', '--no-migrate'];

  test('a non-zero exit writes exactly one JSON document, as it does without the .env', () => {
    const control = runFrom(null, failing);
    const rerun = runFrom('OPENCLAW_GATEWAY_TOKEN=x\n', failing);
    expect(rerun.stderr).toContain('[env] Ignoring OPENCLAW_GATEWAY_TOKEN');
    expect(rerun.status).toBe(control.status);
    expect(control.status).not.toBe(0);
    expect(() => JSON.parse(control.stdout)).not.toThrow();
    expect(() => JSON.parse(rerun.stdout)).not.toThrow();
    expect(JSON.parse(rerun.stdout)).toEqual(JSON.parse(control.stdout));
  });

  test('a re-run killed by a signal still gets the wrapper\'s command_failed document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-9717-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-9717-home-'));
    scratch.push(dir, home);
    writeFileSync(join(dir, '.env'), 'OPENCLAW_GATEWAY_TOKEN=x\n');
    const wrapper = spawn(process.execPath, [CLI_PATH, ...failing], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, PWD: dir, GBRAIN_SKIP_STARTUP_HOOKS: '1' } });
    let stdout = '';
    wrapper.stdout!.on('data', chunk => { stdout += chunk; });
    const exited = new Promise<number | null>(resolve => wrapper.on('exit', code => resolve(code)));
    let child = '';
    for (let i = 0; i < 500 && !child; i++) {
      child = spawnSync('pgrep', ['-P', String(wrapper.pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0] ?? '';
      if (!child) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(child).not.toBe('');
    process.kill(Number(child), 'SIGKILL');
    expect(await exited).toBe(137);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'command_failed' });
  }, 60_000);

  test('control: an exit 0 writes the command document alone', () => {
    const rerun = runFrom('OPENCLAW_GATEWAY_TOKEN=x\n', ['errors', 'no_brain', '--json']);
    expect(rerun.stderr).toContain('[env] Ignoring OPENCLAW_GATEWAY_TOKEN');
    expect(rerun.status).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ code: 'no_brain' });
  });
});
