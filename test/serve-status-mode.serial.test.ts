/**
 * F4 status-only serve (agent operator contract v1): a second `gbrain serve`
 * on a PGLite brain another serve holds, and a serve with no brain at all,
 * complete the MCP handshake with exactly one `gbrain_status` tool that names
 * the lock owner / missing brain path, the fix and the relay text. Then the
 * documented recoveries end in a successful recall:
 *   (a) the owner closes → the next gbrain_status call opens the brain in
 *       place, tools/list_changed fires and the full catalog answers recall;
 *   (b) both harnesses move to one shared `gbrain serve --http` with no prior
 *       HTTP credentials (tokens minted before the shared owner starts): the
 *       stale stdio server then names the HTTP owner and the rewiring fix, and
 *       both HTTP sessions recall;
 *   no brain → `gbrain init` (the fix) → recovery in place → recall.
 * `--fail-fast` keeps the pre-F4 exit for supervisors. H2 mid-transition row:
 * `serve --http` on a taken port fails fast (serve_port_in_use) instead of
 * holding the brain while serving nothing, and both stdio harnesses recover.
 *
 * Serial: real subprocesses over one temp GBRAIN_HOME (PGLite lock).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const MARKER = 'zelkova-status-marker-4q7';

function cli(args: string[], env: Record<string, string>) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

async function connect(env: Record<string, string>, extra: string[] = []) {
  const transport = new StdioClientTransport({
    command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', ...extra], cwd: process.cwd(), env, stderr: 'pipe',
  });
  const client = new Client({ name: 'status-mode-test', version: '1.0.0' }, { capabilities: {} });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  client.onclose = () => { if (process.env.STATUS_TEST_DEBUG) console.error(`[serve ${extra.join(' ')} closed] ${stderr}`); };
  await client.connect(transport);
  return { client, transport };
}

function body(res: unknown): Record<string, any> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

async function waitFor(pred: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function envFor(home: string): Record<string, string> {
  const env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined });
  delete env.GBRAIN_SOURCE;
  delete env.GBRAIN_SERVE_FAIL_FAST;
  return env;
}

describe('status-only serve: lock contention → recovery in place (a)', () => {
  let home: string;
  let env: Record<string, string>;
  const opened: Array<{ client: Client; transport: StdioClientTransport }> = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-lock-'));
    env = envFor(home);
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'm.md'), `---\ntitle: ${MARKER}\n---\n\n# ${MARKER}\n\nStatus-mode recall proof ${MARKER}.\n`);
    expect(cli(['import', notes, '--no-embed'], env).status).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const c of opened) { try { await c.client.close(); } catch { /* best-effort */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test('second serve handshakes with gbrain_status naming the owner, then recovers when the owner closes', async () => {
    const owner = await connect(env);
    opened.push(owner);
    expect((await owner.client.listTools()).tools.some(t => t.name === 'search')).toBe(true);

    const second = await connect(env);
    opened.push(second);
    expect(second.client.getInstructions()).toContain('STATUS-ONLY MODE');
    const tools = (await second.client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(['gbrain_status']);

    const status = body(await second.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(status.status).toBe('unavailable');
    expect(status.reason).toBe('lock_held');
    expect(status.why).toContain(String(status.lock_owner.pid));
    expect(status.why).toContain(status.brain_path);
    expect(status.lock_owner.transport).toBe('stdio');
    expect(status.fix.next).toBe('tell_user_to_run');
    expect(status.user_message).toBeTruthy();
    expect(status.decisions[0].options.map((o: { id: string }) => o.id)).toEqual(['close_owner', 'share_http']);
    // The executable shared-HTTP plan: stop the owner → serve --http → rewire harnesses.
    expect(status.share_http_plan.argv).toEqual(['kill', String(status.lock_owner.pid)]);
    expect(status.share_http_plan.then.argv).toEqual(['gbrain', 'serve', '--http']);
    expect(status.share_http_plan.then.then.argv).toEqual(['gbrain', 'bootstrap', 'harness', '--harness', 'all', '--yes']);

    // Any other tool: one error block that names gbrain_status.
    const refused = await second.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(refused.isError).toBe(true);
    expect((refused.content as unknown[]).length).toBe(1);
    expect(body(refused).code).toBe('serve_status_only');

    let listChanged = false;
    second.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged = true; });
    await owner.client.close();
    opened.shift();

    expect(await waitFor(async () => body(await second.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered')).toBe(true);
    expect(await waitFor(async () => listChanged, 10_000)).toBe(true);
    expect((await second.client.listTools()).tools.some(t => t.name === 'search')).toBe(true);
    const found = await second.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(found.isError).toBeFalsy();
    expect(JSON.stringify(body(found))).toContain(MARKER);
  }, 180_000);

  test('--fail-fast keeps the supervisor exit', () => {
    const holder = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--fail-fast'], { cwd: process.cwd(), env: { ...env, GBRAIN_HOME: join(home, 'nope') }, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(holder.status).not.toBe(0);
  }, 90_000);
});

describe('status-only serve: no brain → init → recovery in place', () => {
  let home: string;
  let env: Record<string, string>;
  let session: { client: Client; transport: StdioClientTransport } | null = null;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-nobrain-'));
    env = envFor(home);
  });
  afterAll(async () => {
    if (session) { try { await session.client.close(); } catch { /* best-effort */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test('handshake names the missing config path; running the fix recovers and recall works', async () => {
    session = await connect(env);
    const status = body(await session.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(status.reason).toBe('no_brain');
    expect(status.why).toContain(join(home, '.gbrain', 'config.json'));
    expect(status.fix.argv).toEqual(['gbrain', 'init', '--pglite', '--no-embedding']);
    // A1 surface rule: a CLI-only fix on stdio is relayed (tell_user_to_run).
    expect(status.fix.next).toBe('tell_user_to_run');
    expect(status.fix.consent).toEqual(['persistent_install']);

    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    expect(await waitFor(async () => body(await session!.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered', 60_000)).toBe(true);
    const remembered = await session.client.callTool({ name: 'remember', arguments: { fact: `${MARKER} is the install-check fact`, provenance: 'install-check' } });
    expect(remembered.isError).toBeFalsy();
    const recalled = await session.client.callTool({ name: 'recall', arguments: { query: MARKER } });
    expect(recalled.isError).toBeFalsy();
    expect(JSON.stringify(body(recalled))).toContain(MARKER);
  }, 180_000);
});

describe('status-only serve: lock contention → one shared serve --http (b)', () => {
  let home: string;
  let env: Record<string, string>;
  let http: ChildProcess | null = null;
  const opened: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const PORT = 41000 + Math.floor(Math.random() * 2000);
  const URL_ = `http://127.0.0.1:${PORT}/mcp`;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-http-'));
    env = envFor(home);
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'm.md'), `---\ntitle: ${MARKER}\n---\n\n# ${MARKER}\n\nShared-HTTP recall proof ${MARKER}.\n`);
    expect(cli(['import', notes, '--no-embed'], env).status).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const c of opened) { try { await c.client.close(); } catch { /* best-effort */ } }
    if (http) { try { http.kill('SIGTERM'); } catch { /* best-effort */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test('tokens minted before the shared owner starts; both harnesses recall over HTTP; the stale stdio server names the HTTP owner', async () => {
    const owner = await connect(env);
    opened.push(owner);
    const stale = await connect(env);
    opened.push(stale);
    expect(body(await stale.client.callTool({ name: 'gbrain_status', arguments: {} })).reason).toBe('lock_held');

    // Step 1 of the plan: the owner closes (its session ends).
    await owner.client.close();
    opened.shift();
    // No prior HTTP credentials: mint one token per harness while the lock is free.
    const tokens = ['harness-a', 'harness-b'].map(name => {
      const out = cli(['auth', 'create', name, '--scopes', 'read,write'], env);
      expect(out.status).toBe(0);
      return (out.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    });
    expect(tokens.every(Boolean)).toBe(true);
    // Step 2: one shared HTTP server owns the brain.
    http = spawn('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--bind', '127.0.0.1', '--port', String(PORT)],
      { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'ignore'] });
    expect(await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null))?.ok === true, 60_000)).toBe(true);

    // The stale stdio server cannot take the brain back; it names the HTTP owner and the rewiring fix.
    const after = body(await stale.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(after.status).toBe('unavailable');
    expect(after.lock_owner.transport).toBe('http');
    expect(after.why).toContain('gbrain serve --http');
    expect(after.fix.argv).toEqual(['gbrain', 'bootstrap', 'harness', '--harness', 'all', '--yes']);

    // Step 3: each harness, rewired to the shared server, recalls.
    for (const token of tokens) {
      const client = new Client({ name: 'shared-http', version: '1' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      try {
        const found = await client.callTool({ name: 'search', arguments: { query: MARKER } });
        expect(found.isError).toBeFalsy();
        expect(JSON.stringify(body(found))).toContain(MARKER);
      } finally {
        await client.close();
      }
    }
  }, 240_000);
});

describe('status-only serve: the shared-HTTP transition fails midway (H2)', () => {
  let home: string;
  let env: Record<string, string>;
  let blocker: ReturnType<typeof import('node:http').createServer> | null = null;
  const opened: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const PORT = 44000 + Math.floor(Math.random() * 2000);

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-midway-'));
    env = envFor(home);
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'm.md'), `---\ntitle: ${MARKER}\n---\n\n# ${MARKER}\n\nMid-transition recall proof ${MARKER}.\n`);
    expect(cli(['import', notes, '--no-embed'], env).status).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const c of opened) { try { await c.client.close(); } catch { /* best-effort */ } }
    blocker?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('serve --http cannot listen: it fails fast without keeping the brain, and both stdio registrations keep working', async () => {
    const owner = await connect(env);
    opened.push(owner);
    const stale = await connect(env);
    opened.push(stale);
    expect(body(await stale.client.callTool({ name: 'gbrain_status', arguments: {} })).reason).toBe('lock_held');

    // Step 1 of the plan: the owner closes.
    await owner.client.close();
    opened.shift();
    // Step 2 fails: the port is taken, so the shared server cannot start.
    const http = await import('node:http');
    blocker = http.createServer((_q, r) => { r.end('not gbrain'); });
    await new Promise<void>(r => blocker!.listen(PORT, '127.0.0.1', () => r()));
    const started = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--bind', '127.0.0.1', '--port', String(PORT)],
      { cwd: process.cwd(), env, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(started.signal, 'serve --http on a taken port must exit, not hang holding the brain').toBeNull();
    expect(started.status).not.toBe(0);
    expect(started.stderr).toContain('serve_port_in_use');
    expect(started.stderr).toContain(`--port ${PORT + 1}`);

    // The stale stdio server recovers in place and recalls; the re-launched first harness handshakes
    // (status-only, naming the new owner) — no harness config was rewritten by the failed step.
    expect(await waitFor(async () => body(await stale.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered', 60_000)).toBe(true);
    const found = await stale.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(found.isError).toBeFalsy();
    expect(JSON.stringify(body(found))).toContain(MARKER);
    const relaunched = await connect(env);
    opened.push(relaunched);
    const status = body(await relaunched.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(status.reason).toBe('lock_held');
    expect(status.lock_owner.transport).toBe('stdio');
    // Recovery (a) still ends in a recall for the re-launched harness once the other session closes.
    await stale.client.close();
    opened.splice(opened.indexOf(stale), 1);
    expect(await waitFor(async () => body(await relaunched.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered', 60_000)).toBe(true);
    const again = await relaunched.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(JSON.stringify(body(again))).toContain(MARKER);
  }, 300_000);
});
