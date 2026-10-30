/**
 * serve.vector_prewarm is opt-in (core/vector-prewarm.ts). A serve that leaves it off loads nothing under
 * src/core/vector-prewarm.ts and makes no engine call or log line for it; one whose published config merge turns it on
 * loads it once the boot is done. Each boot runs in its own bun process, like test/serve-cli-socket-off.test.ts, so a
 * module another test already loaded cannot hide an import.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Boot { calls: string[]; modules: string[]; logs: string[] }

const CHILD = `
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { runServe } from './src/commands/serve.ts';
const { published, out } = JSON.parse(process.env.BOOT_SPEC);
const calls = [];
const engine = {
  kind: 'pglite',
  getConfig: async (key) => { calls.push('getConfig(' + key + ')'); return null; },
  getAllConfig: async () => { calls.push('getAllConfig()'); return {}; },
  executeRaw: async (sql) => { calls.push('executeRaw(' + sql.slice(0, 40) + ')'); return []; },
  disconnect: async () => { calls.push('disconnect()'); },
};
(await import('./src/core/config.ts')).MERGED_CONFIG_BY_ENGINE.set(engine, { engine: 'pglite', ...(published ? { serve_vector_prewarm: published === 'on' } : {}) });
const logs = [];
await runServe(engine, [], {
  stdin: new EventEmitter(), signals: { on() { return this; } }, exit: () => {}, log: line => { logs.push(line); },
  startMcpServer: async () => {}, getParentPid: () => 1, setInterval: () => 0, clearInterval: () => {},
  probeWatchdog: () => false, sweepEnabled: false,
});
await new Promise(resolve => setTimeout(resolve, 300));
const modules = Object.keys(require.cache).filter(path => path.endsWith('/src/core/vector-prewarm.ts'));
writeFileSync(out, JSON.stringify({ calls, modules, logs }));
process.exit(0);
`;

async function boot(published: '' | 'on' | 'off'): Promise<Boot> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-serve-prewarm-off-'));
  try {
    const out = join(home, 'boot.json');
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, GBRAIN_SWEEP: '0', BOOT_SPEC: JSON.stringify({ published, out }) };
    const proc = Bun.spawn(['bun', '--no-env-file', '-e', CHILD], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
    return JSON.parse(readFileSync(out, 'utf8')) as Boot;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('serve with the vector prewarm off', () => {
  test('unset or false: loads no prewarm module, makes no extra engine call and logs nothing for it', async () => {
    const [unset, off, on] = await Promise.all([boot(''), boot('off'), boot('on')]);
    for (const b of [unset, off]) {
      expect(b.modules).toEqual([]);
      expect(b.logs.filter(line => line.includes('vector prewarm'))).toEqual([]);
      expect(b.calls.toSorted()).toEqual(on.calls.toSorted());
    }
    expect(unset.calls).not.toContain('getConfig(serve.vector_prewarm)');
  }, 60_000);

  test('serve_vector_prewarm in the published merge runs it after the boot (the control: the probe sees it)', async () => {
    const on = await boot('on');
    expect(on.modules).toHaveLength(1);
    expect(on.logs).toContain('[gbrain serve] vector prewarm: skipped (Postgres only; this brain is PGLite)');
    expect(on.calls).not.toContain('getConfig(serve.vector_prewarm)');
  }, 60_000);
});
