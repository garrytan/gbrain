/**
 * The graduation E2E's beforeAll (test/e2e/graduation-clients.test.ts) lists and fetches older
 * release tags from origin before it builds their binaries. A git call over a connection that
 * opens and then never answers used to block it until the 900 s hook limit. This probe points
 * origin at a local TCP listener that accepts and never replies, then requires each network git
 * call in test/helpers/graduation-e2e.ts to give up on its own bound, retry, and fail with an
 * error that names the timeout. The helper runs in a child process: Bun.spawnSync blocks the
 * event loop, so a hang in-process would also stop this test's own bound.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const OUTER_BOUND_MS = 25_000;
let server: net.Server;
const sockets: net.Socket[] = [];
let hungUrl = '';
const cache = mkdtempSync(join(tmpdir(), 'gbrain-older-release-probe-'));

beforeAll(async () => {
  server = net.createServer(socket => { sockets.push(socket); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  hungUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/hung/gbrain.git`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(cache, { recursive: true, force: true });
});

function hungOriginEnv(): Record<string, string> {
  const origin = Bun.spawnSync(['git', '-C', REPO, 'config', '--get', 'remote.origin.url'], { stdout: 'pipe', stderr: 'pipe' });
  const rewrite = origin.exitCode === 0
    ? { GIT_CONFIG_KEY_0: `url.${hungUrl}.insteadOf`, GIT_CONFIG_VALUE_0: origin.stdout.toString().trim() }
    : { GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: hungUrl };
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? cache, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', ...rewrite, GBRAIN_OLDER_RELEASE_DIR: cache };
}

async function probe(call: string): Promise<{ settled: boolean; code: number | null; stderr: string; ms: number }> {
  const script = `import { olderReleaseBinary, previousReleaseTags } from './test/helpers/graduation-e2e.ts';\n${call};`;
  const started = Date.now();
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: REPO, env: hungOriginEnv(), stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => child.kill('SIGKILL'), OUTER_BOUND_MS);
  const code = await child.exited;
  clearTimeout(killer);
  const ms = Date.now() - started;
  return { settled: child.signalCode !== 'SIGKILL', code, stderr: await new Response(child.stderr).text(), ms };
}

describe('graduation older-release helper against an origin that accepts and never answers', () => {
  test('listing release tags gives up on its bound, retries, and names the timeout', async () => {
    const r = await probe('previousReleaseTags(2, { timeoutMs: 1_500, attempts: 2 })');
    expect(r.settled).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/git ls-remote .*failed 2 time\(s\).*timed out after 1\.5s/);
    expect(r.ms).toBeLessThan(OUTER_BOUND_MS);
  }, OUTER_BOUND_MS + 10_000);

  test('fetching an uncached release tag gives up on its bound, retries, and names the timeout', async () => {
    const r = await probe("olderReleaseBinary('v0.0.0.1', { timeoutMs: 1_500, attempts: 2 })");
    expect(r.settled).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/git fetch .*v0\.0\.0\.1.*failed 2 time\(s\).*timed out after 1\.5s/);
    expect(r.ms).toBeLessThan(OUTER_BOUND_MS);
  }, OUTER_BOUND_MS + 10_000);
});
