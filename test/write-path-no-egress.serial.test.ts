/**
 * Real CLI writes on a keyless brain leave the machine for nothing.
 *
 * Each write runs as its own `gbrain` process (and any child process it
 * starts inherits the environment) with HTTP_PROXY / HTTPS_PROXY pointed at a
 * local recorder that logs every connection and refuses it. Chat keys are
 * present, so key-gated model paths are live. The commit must succeed, and
 * the recorder must see zero connections. This catches transports the
 * in-process tripwire cannot see. The first case proves the recorder is live.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeGitFixture } from './helpers/git-fixture.ts';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
let home: string;
let proxy: Server;
let proxyUrl = '';
const connections: string[] = [];

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    GBRAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test-fake',
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
    DATABASE_URL: '', GBRAIN_DATABASE_URL: '', ...extra,
  };
}

/** Async spawn: the recorder lives in this process, so the event loop must stay free. */
async function run(cmd: string[], input?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { env: env(), stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: `${stdout}\n${stderr}` };
}

const gbrain = (args: string[], input?: string) => run(['bun', CLI, ...args], input);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-no-egress-'));
  proxy = createServer(socket => {
    socket.once('data', chunk => {
      connections.push(chunk.toString('latin1').split('\r\n')[0] ?? '');
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const addr = proxy.address();
  proxyUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const init = await gbrain(['init', '--pglite', '--no-embedding']);
  if (init.code !== 0) throw new Error(`init failed: ${init.out}`);
}, 180_000);

afterAll(() => {
  proxy?.close();
  rmSync(home, { recursive: true, force: true });
});

const NOTE = '---\ntype: meeting\ntitle: Roadmap\n---\nA substantive meeting note about the quarterly roadmap with acme-example. '.padEnd(400, 'More detail. ');

describe('CLI writes make no network connection', () => {
  test('the recorder sees a child process that does reach for the network', async () => {
    connections.length = 0;
    await run(['bun', '-e', "await fetch('https://api.anthropic.com/v1/messages').catch(() => {})"]);
    expect(connections.some(c => c.includes('api.anthropic.com'))).toBe(true);
  }, 60_000);

  test('put, remember, link, timeline-add, import, sync', async () => {
    connections.length = 0;
    const steps: Array<[string[], string | undefined]> = [
      [['put', 'meetings/roadmap'], NOTE],
      [['put', 'companies/acme-example'], '---\ntype: company\ntitle: Acme Example\n---\nA company.'],
      [['remember', 'Alice Example prefers async standups.', '--provenance', 'test', '--entity', 'companies/acme-example'], undefined],
      [['link', 'meetings/roadmap', 'companies/acme-example'], undefined],
      [['timeline-add', 'companies/acme-example', '2026-09-01', 'Signed the pilot.'], undefined],
    ];
    for (const [args, input] of steps) {
      const r = await gbrain(args, input);
      if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.code}: ${r.out}`);
    }
    const dir = join(home, 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'imported.md'), NOTE);
    const imp = await gbrain(['import', dir, '--no-embed']);
    if (imp.code !== 0) throw new Error(`gbrain import exited ${imp.code}: ${imp.out}`);
    const repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    const fixture = await makeGitFixture(repo);
    writeFileSync(join(repo, 'synced.md'), NOTE.replace('title: Roadmap', 'title: Synced'));
    fixture.commitAll('add synced note');
    for (const args of [['sources', 'add', 'synced', '--path', repo], ['sync', '--source', 'synced', '--no-pull', '--no-embed']]) {
      const r = await gbrain(args);
      if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.code}: ${r.out}`);
    }
    expect(connections).toEqual([]);
    const search = await gbrain(['search', 'quarterly roadmap']);
    expect(search.out).toContain('meetings/roadmap');
  }, 600_000);
});
