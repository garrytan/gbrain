/**
 * Warm CLI socket startup: what a CLI process loads before it sends its
 * request to a serve's socket, and before it exits after printing the reply.
 *
 * 1. Protects: a socket hit never opens a database, so it must not pay for
 *    the operation's handler graph (src/core/ops/search.ts, ops/pages.ts and
 *    the AI SDK behind them), the Postgres driver (src/core/db.ts) or the MCP
 *    client. Loading those took most of a warm hit's CLI time: the request
 *    went out only after the handler module of an op the serve runs anyway.
 * 2. Fails when: the socket path loads the op through loadOperation again,
 *    cli-force-exit.ts or pg-access-classify.ts reach db.ts statically, the
 *    dispatcher imports the segmented-page reader or volunteer formatter
 *    statically, or recall.ts imports mcp-client.ts statically.
 * 3. Existing coverage: test/cli-socket.test.ts covers the exchange and the
 *    renderer in process; test/e2e/cli-socket-postgres.test.ts compares warm
 *    and cold bytes against a real serve. Neither looked at the module graph.
 * 4. Seam: a --preload module records require.cache when the CLI calls
 *    net.createConnection and again at exit; a fake serve in this process
 *    answers the request. No database is opened.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { peerCredSupport } from '../src/core/cli-socket/peer-cred.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const REPO = resolve(import.meta.dir, '..');

const PROBE = `
import net from 'node:net';
import { writeFileSync } from 'node:fs';
const loaded = () => Object.keys(require.cache);
const seen = { send: null, exit: null };
const createConnection = net.createConnection;
net.createConnection = (...args) => { seen.send ??= loaded(); return createConnection(...args); };
process.on('exit', () => { seen.exit = loaded(); writeFileSync(process.env.GRAPH_PROBE_OUT, JSON.stringify(seen)); });
`;

/** Modules a warm hit has no use for, before the send or after it. */
const NEVER_LOADED: Array<[string, (m: string) => boolean]> = [
  ['operation registry', m => m.endsWith('/src/core/operations.ts')],
  ['search op handlers', m => m.endsWith('/src/core/ops/search.ts')],
  ['page op handlers', m => m.endsWith('/src/core/ops/pages.ts')],
  ['facts op handlers', m => m.endsWith('/src/core/ops/facts.ts')],
  ['Postgres driver', m => m.endsWith('/src/core/db.ts') || m.includes('/vendor/postgres/')],
  ['MCP client', m => m.endsWith('/src/core/mcp-client.ts') || m.includes('/node_modules/@modelcontextprotocol/')],
  ['AI SDK', m => /\/node_modules\/(ai|@ai-sdk|zod)\//.test(m)],
  ['segmented page reader', m => m.endsWith('/src/core/page-window/segmented.ts') || m.endsWith('/src/core/page-body/read-range.ts')],
  ['volunteer formatter', m => m.endsWith('/src/core/context/volunteer.ts')],
];

function heavy(modules: string[]): string[] {
  return NEVER_LOADED.filter(([, hit]) => modules.some(hit)).map(([name]) => name);
}

const SEARCH_ROW = {
  slug: 'notes/alpha-example', page_id: 1, title: 'Alpha example', type: 'note', chunk_text: 'zephyrquartz synthetic page.',
  chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 0.5, stale: false, source_id: 'default',
};

/** The result a serve answers each request kind with. */
function answer(request: { kind: string; op?: string }): unknown {
  if (request.kind === 'recall') {
    return { facts: [{ fact_id: 1, kind: 'fact', fact: 'zephyrquartz synthetic fact', provenance: 'test', entity_slug: null }], results: [] };
  }
  if (request.op === 'get_page') {
    return { slug: 'notes/alpha-example', title: 'Alpha example', type: 'note', frontmatter: {}, compiled_truth: 'zephyrquartz synthetic body.', timeline: '', tags: [] };
  }
  return [SEARCH_ROW];
}

describe.skipIf(!peerCredSupport().ok)('warm CLI socket module graph', () => {
  let root: string;
  let server: net.Server;
  const requests: Array<{ kind: string; op?: string }> = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-cli-sock-graph-'));
    mkdirSync(join(root, '.gbrain', 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://postgres@127.0.0.1:9/never-opened' }), { mode: 0o600 });
    writeFileSync(join(root, 'probe.ts'), PROBE);
    const path = join(root, '.gbrain', 'run', 'cli.sock');
    server = net.createServer(socket => {
      let buffered = '';
      socket.on('data', data => {
        buffered += String(data);
        if (!buffered.includes('\n')) return;
        const request = JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
        requests.push(request);
        const frame = { v: 1, kind: 'result', result: answer(request), meta: null, notices: [], output: [], source: 'default' };
        socket.end(`${JSON.stringify({ v: 1, accepted: true })}\n${JSON.stringify(frame)}\n`);
      });
    });
    await new Promise<void>(done => server.listen(path, done));
    chmodSync(path, 0o600);
  });

  afterAll(async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });

  async function warm(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; send: string[]; exit: string[] }> {
    const out = join(root, `graph-${requests.length}.json`);
    const env = keylessBrainEnv(process.env, root, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined,
      GBRAIN_CLI_SOCKET: '1', GBRAIN_DEBUG: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_RETRY_CONNECT: '1', GRAPH_PROBE_OUT: out,
    });
    const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(root, 'probe.ts'), join(REPO, 'src/cli.ts'), ...args], {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const graph = JSON.parse(readFileSync(out, 'utf8')) as { send: string[] | null; exit: string[] };
    return { stdout, stderr, exitCode, send: graph.send ?? [], exit: graph.exit };
  }

  test('search answered by the socket loads no handler, driver or AI graph before the send or after the reply', async () => {
    const run = await warm(['search', 'zephyrquartz', '--json']);
    expect(run.stderr).toContain('[cli-socket] warm: search answered by the serve socket');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout).map((row: { slug: string }) => row.slug)).toEqual(['notes/alpha-example']);
    expect(requests.at(-1)).toMatchObject({ kind: 'op', op: 'search', params: { query: 'zephyrquartz', json: true } });
    expect(run.send.length).toBeGreaterThan(0);
    expect(heavy(run.send)).toEqual([]);
    expect(heavy(run.exit)).toEqual([]);
  }, 60_000);

  test('get renders the page without the page handlers or the segmented reader', async () => {
    const run = await warm(['get', 'notes/alpha-example']);
    expect(run.stderr).toContain('[cli-socket] warm: get answered by the serve socket');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('zephyrquartz synthetic body.');
    expect(requests.at(-1)).toMatchObject({ kind: 'op', op: 'get_page', params: { slug: 'notes/alpha-example' } });
    expect(heavy(run.send)).toEqual([]);
    expect(heavy(run.exit)).toEqual([]);
  }, 60_000);

  test('recall --query sends before the MCP client or the Postgres driver loads', async () => {
    const run = await warm(['recall', '--query', 'zephyrquartz', '--json']);
    expect(run.stderr).toContain('[cli-socket] warm: recall answered by the serve socket');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout).facts[0].fact).toBe('zephyrquartz synthetic fact');
    expect(requests.at(-1)).toMatchObject({ kind: 'recall', args: ['--query', 'zephyrquartz', '--json'] });
    expect(heavy(run.send)).toEqual([]);
    expect(heavy(run.exit)).toEqual([]);
  }, 60_000);
});

describe('CLI entry point', () => {
  test('loads no Postgres driver: every command pays for what src/cli.ts imports', () => {
    const r = Bun.spawnSync([process.execPath, '--no-env-file', '-e', `await import(${JSON.stringify(join(REPO, 'src/cli.ts'))}); console.log(JSON.stringify(Object.keys(require.cache)));`], { cwd: REPO });
    expect(r.exitCode).toBe(0);
    const modules = JSON.parse(r.stdout.toString().trim().split('\n').pop()!) as string[];
    expect(modules.filter(m => m.endsWith('/src/core/db.ts') || m.includes('/vendor/postgres/'))).toEqual([]);
  }, 60_000);
});
