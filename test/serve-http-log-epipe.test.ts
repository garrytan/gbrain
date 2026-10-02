/**
 * #5079: `serve --http` exited when its stdout/stderr pipe closed (a
 * hand-written systemd unit or a log pipeline that restarts), because the
 * CLI-wide broken-pipe handling (SIGPIPE under Bun, EPIPE stream errors)
 * stops the process. For `serve --http` those streams only carry logs, so it
 * now drops the write and keeps serving; stdio `serve` and every other
 * command still exit, since there a broken stdout means the reader left.
 *
 * The broken pipe is real: a child installs the handlers through the same
 * entrypoint cli.ts uses, keeps logging on a timer, and the parent destroys
 * the child's stdout/stderr pipes.
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { isHttpServeInvocation } from '../src/core/serve-invocation.ts';

const ENTRY = resolve(import.meta.dir, '..', 'src', 'core', 'serve-invocation.ts');

async function logThroughClosedPipe(argv: string[]): Promise<{ exit: number | string | null; ticksAfterClose: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-5079-'));
  try {
    const marker = join(dir, 'ticks.log');
    const script = join(dir, 'child.ts');
    writeFileSync(script, `
const { installCleanupSignalHandlers } = await import(${JSON.stringify(ENTRY)});
const { appendFileSync } = await import('fs');
installCleanupSignalHandlers(${JSON.stringify(argv)});
let n = 0;
setInterval(() => {
  n++;
  console.log('request log ' + n);
  console.error('request err ' + n);
  appendFileSync(${JSON.stringify(marker)}, n + '\\n');
}, 50);
`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let exit: number | string | null = 'alive';
    child.on('exit', (code, signal) => { exit = code ?? signal; });
    const ticks = () => (existsSync(marker) ? readFileSync(marker, 'utf-8').trim().split('\n').length : 0);
    for (let i = 0; i < 100 && ticks() < 5; i++) await new Promise(r => setTimeout(r, 50));
    child.stdout!.destroy();
    child.stderr!.destroy();
    const atClose = ticks();
    await new Promise(r => setTimeout(r, 1500));
    const after = ticks() - atClose;
    child.kill('SIGKILL');
    return { exit, ticksAfterClose: after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#5079 serve --http survives a closed log pipe', () => {
  test('serve --http keeps running and logging', async () => {
    const r = await logThroughClosedPipe(['serve', '--http', '--port', '3131']);
    expect(r.exit).toBe('alive');
    expect(r.ticksAfterClose).toBeGreaterThan(5);
  }, 30_000);

  test('stdio serve and other commands still exit on a broken pipe', async () => {
    for (const argv of [['serve'], ['sync']]) expect((await logThroughClosedPipe(argv)).exit).not.toBe('alive');
  }, 30_000);

  test('only `serve --http` gets the setting', () => {
    expect(isHttpServeInvocation(['serve', '--http', '--port', '3131'])).toBe(true);
    expect(isHttpServeInvocation(['--timeout', '30s', 'serve', '--http'])).toBe(true);
    expect(isHttpServeInvocation(['serve'])).toBe(false);
    expect(isHttpServeInvocation(['sync', '--http'])).toBe(false);
    expect(isHttpServeInvocation([])).toBe(false);
  });
});
