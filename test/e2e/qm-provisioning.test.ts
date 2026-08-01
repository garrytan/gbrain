/**
 * E2E for the qm-harness integration recipe (docs/integrations/qm-harness.md):
 * roster-driven provisioning + over-the-wire write fencing.
 *
 * PGLite-based and ungated (no DATABASE_URL needed) — PGLite is
 * single-process, so every provisioning step runs BEFORE `serve --http`
 * starts; after that all access goes over HTTP MCP.
 *
 * Pins, end to end:
 *   - provision-scopes.sh creates a path-less shared source + one bound
 *     client per employee, is idempotent on re-run, and RESCOPES in place
 *     (no secret rotation) when the roster changes;
 *   - thin clients (`init --mcp-only`) can write inside their
 *     bound_slug_prefixes and are rejected with the fence error outside
 *     them (v0.42.70.0 enforceClientSlugFence, over the real transport);
 *   - reads stay source-granular (a bob-example client CAN read
 *     chan-eng/ — the documented shared-source tradeoff).
 */

import { describe, test as testRaw, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120000);
}

const CLI = join(__dirname, '..', '..', 'src', 'cli.ts');
const SCRIPT = join(__dirname, '..', '..', 'docs', 'integrations', 'qm-harness-snippets', 'provision-scopes.sh');

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function spawn(cmd: string[], env: Record<string, string | undefined>, cwd?: string): Promise<RunResult> {
  const fullEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) fullEnv[k] = v;
  }
  delete fullEnv.GBRAIN_REMOTE_CLIENT_SECRET;
  delete fullEnv.DATABASE_URL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete fullEnv[k];
    else fullEnv[k] = v;
  }
  const proc = Bun.spawn({ cmd, env: fullEnv, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const gbrain = (args: string[], home: string, extraEnv: Record<string, string | undefined> = {}) =>
  spawn(['bun', 'run', CLI, ...args], { GBRAIN_HOME: home, ...extraEnv });

describe('qm-harness provisioning + write fence (e2e, PGLite)', () => {
  let hostHome: string;
  let workDir: string;
  let aliceHome: string;
  let bobHome: string;
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let serverPort: number;
  const creds: Record<string, { clientId: string; secret: string }> = {};
  let rerunCredsGrew = true; // set false when idempotency holds

  const rosterPath = () => join(workDir, 'roster.tsv');
  const statePath = () => join(workDir, 'roster.tsv.state.tsv');
  const secretsPath = () => join(workDir, 'roster.tsv.new-credentials.tsv');

  async function provision(): Promise<RunResult> {
    return spawn(
      ['bash', SCRIPT, rosterPath(), '--gbrain', `bun run ${CLI}`, '--budget-usd-per-day', '5'],
      { GBRAIN_HOME: hostHome },
      workDir,
    );
  }

  beforeAll(async () => {
    hostHome = mkdtempSync(join(tmpdir(), 'gbrain-qm-host-'));
    workDir = mkdtempSync(join(tmpdir(), 'gbrain-qm-work-'));
    aliceHome = mkdtempSync(join(tmpdir(), 'gbrain-qm-alice-'));
    bobHome = mkdtempSync(join(tmpdir(), 'gbrain-qm-bob-'));

    // 1. Host brain on PGLite, embedding deferred (FTS is enough here).
    const init = await gbrain(['init', '--pglite', '--no-embedding'], hostHome);
    if (init.exitCode !== 0) throw new Error(`host init failed: ${init.stderr || init.stdout}`);

    // 2. Roster v1: alice in eng, bob in product.
    writeFileSync(rosterPath(), [
      'channel eng',
      'channel product',
      'employee alice-example eng',
      'employee bob-example product',
      '',
    ].join('\n'));
    const p1 = await provision();
    if (p1.exitCode !== 0) throw new Error(`provision v1 failed: ${p1.stderr || p1.stdout}`);

    for (const line of readFileSync(secretsPath(), 'utf8').trim().split('\n')) {
      const [slug, clientId, secret] = line.split('\t');
      creds[slug] = { clientId, secret };
    }

    // 3. Idempotency: re-run with the same roster mints no new secrets.
    const before = readFileSync(secretsPath(), 'utf8');
    const p2 = await provision();
    if (p2.exitCode !== 0) throw new Error(`provision re-run failed: ${p2.stderr || p2.stdout}`);
    rerunCredsGrew = readFileSync(secretsPath(), 'utf8') !== before;

    // 4. Roster churn: alice joins product → rescope in place.
    writeFileSync(rosterPath(), [
      'channel eng',
      'channel product',
      'employee alice-example eng,product',
      'employee bob-example product',
      '',
    ].join('\n'));
    const p3 = await provision();
    if (p3.exitCode !== 0) throw new Error(`provision rescope failed: ${p3.stderr || p3.stdout}`);

    // 4b. An UNBOUND client, standing in for a webhook integration. Registered
    //     here because PGLite is single-process: once serve --http holds the
    //     lock, no host-side CLI command can run.
    const wh = await gbrain([
      'auth', 'register-client', 'webhook-integration',
      '--grant-types', 'client_credentials', '--scopes', 'read write',
    ], hostHome);
    if (wh.exitCode !== 0) throw new Error(`webhook client registration failed: ${wh.stderr || wh.stdout}`);
    creds['webhook-integration'] = {
      clientId: wh.stdout.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1] ?? '',
      secret: wh.stdout.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1] ?? '',
    };

    // 5. Serve over HTTP MCP (holds the PGLite lock from here on).
    serverPort = 30000 + Math.floor(Math.random() * 30000);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GBRAIN_HOME = hostHome;
    delete env.DATABASE_URL;
    serverProc = Bun.spawn({
      cmd: ['bun', 'run', CLI, 'serve', '--http', '--port', String(serverPort)],
      env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/.well-known/oauth-authorization-server`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!up) throw new Error('serve --http did not come up');

    // 6. Thin-client bootstrap for both scopes (the once-per-sandbox step).
    //    --oauth-client-secret (NOT the env var) on purpose: an env-sourced
    //    secret is deliberately not persisted to config.json, and qm has no
    //    per-scope env to keep it in. Every later call below runs WITHOUT the
    //    env var, so the suite proves the documented setup actually survives
    //    the init session instead of masking it.
    for (const [slug, home] of [['alice-example', aliceHome], ['bob-example', bobHome]] as const) {
      const tc = await gbrain([
        'init', '--mcp-only',
        '--issuer-url', `http://127.0.0.1:${serverPort}`,
        '--mcp-url', `http://127.0.0.1:${serverPort}/mcp`,
        '--oauth-client-id', creds[slug].clientId,
        '--oauth-client-secret', creds[slug].secret,
      ], home);
      if (tc.exitCode !== 0) throw new Error(`thin-client init (${slug}) failed: ${tc.stderr || tc.stdout}`);
    }
  }, 300_000);

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill();
      await serverProc.exited.catch(() => {});
    }
    for (const dir of [hostHome, workDir, aliceHome, bobHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // No GBRAIN_REMOTE_CLIENT_SECRET: auth must come from the persisted config.
  const asAlice = (args: string[]) => gbrain(args, aliceHome);
  const asBob = (args: string[]) => gbrain(args, bobHome);

  async function mintToken(slug: string): Promise<string> {
    const { clientId, secret } = creds[slug];
    const res = await fetch(`http://127.0.0.1:${serverPort}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}`
        + `&client_secret=${encodeURIComponent(secret)}&scope=${encodeURIComponent('read write')}`,
    });
    if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async function mcpCall(token: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });
    return res.text();
  }

  test('provisioning minted one bound client per employee, exactly once', () => {
    // Only the roster-provisioned clients; 'webhook-integration' is registered
    // separately by the suite to prove the /ingest deny is scoped to bound clients.
    expect(Object.keys(creds).filter(k => k !== 'webhook-integration').sort())
      .toEqual(['alice-example', 'bob-example']);
    expect(creds['alice-example'].clientId).toStartWith('gbrain_cl_');
    expect(creds['alice-example'].secret).toStartWith('gbrain_cs_');
    expect(rerunCredsGrew).toBe(false);
    expect(existsSync(statePath())).toBe(true);
  });

  test('alice writes inside her prefixes (personal + channel)', async () => {
    const own = await asAlice(['put', 'emp-alice-example/notes/hello', '--content', '# hello\nmine']);
    expect(own.exitCode).toBe(0);
    const chan = await asAlice(['put', 'chan-eng/notes/standup', '--content', '# standup\nshared']);
    expect(chan.exitCode).toBe(0);
  });

  test('roster churn took effect: alice can write chan-product/ after rescope', async () => {
    const joined = await asAlice(['put', 'chan-product/notes/joined', '--content', '# joined']);
    expect(joined.exitCode).toBe(0);
  });

  test("alice cannot write bob's namespace or an unbound prefix", async () => {
    const bobNs = await asAlice(['put', 'emp-bob-example/notes/nope', '--content', 'x']);
    expect(bobNs.exitCode).not.toBe(0);
    expect(bobNs.stdout + bobNs.stderr).toMatch(/bound_slug_prefixes/);

    const stray = await asAlice(['put', 'org-notes/anything', '--content', 'x']);
    expect(stray.exitCode).not.toBe(0);
    expect(stray.stdout + stray.stderr).toMatch(/bound_slug_prefixes/);
  });

  test('bob is fenced to HIS prefixes (not in eng)', async () => {
    const own = await asBob(['put', 'emp-bob-example/notes/hello', '--content', '# hi']);
    expect(own.exitCode).toBe(0);
    const eng = await asBob(['put', 'chan-eng/notes/nope', '--content', 'x']);
    expect(eng.exitCode).not.toBe(0);
    expect(eng.stdout + eng.stderr).toMatch(/bound_slug_prefixes/);
  });

  test('reads stay source-granular: bob CAN read chan-eng pages (documented tradeoff)', async () => {
    const read = await asBob(['get', 'chan-eng/notes/standup']);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('standup');
  });

  test('the documented health check works on a read+write client (no admin scope)', async () => {
    const who = await asAlice(['whoami']);
    expect(who.exitCode).toBe(0);
    expect(who.stdout).toContain(creds['alice-example'].clientId);
  });

  test('POST /ingest is closed to bound clients — it bypasses the op layer entirely', async () => {
    const post = async (token: string, slug: string | null) => {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/markdown',
      };
      if (slug) headers['X-Gbrain-Slug'] = slug;
      const res = await fetch(`http://127.0.0.1:${serverPort}/ingest`, {
        method: 'POST', headers,
        body: '---\ntype: note\ntitle: x\n---\n# injected',
      });
      return { status: res.status, body: await res.text() };
    };
    const bound = await mintToken('alice-example');

    // The bypass this closes: /ingest queues a job for a handler that skips
    // the put_page op layer AND refuses to honor a source id for untrusted
    // payloads, so the write lands in the `default` source. Fencing only the
    // slug would still have written the right slug into the wrong source.
    const outside = await post(bound, 'wiki/ceo-comp');
    expect(outside.status).toBe(403);
    expect(outside.body).toContain('not available to clients restricted to slug prefixes');

    // Even an IN-prefix slug is refused — the source, not just the slug, is
    // outside the client's grant.
    expect((await post(bound, 'emp-alice-example/inbox/note')).status).toBe(403);
    expect((await post(bound, null)).status).toBe(403);
  });

  test('/ingest still works for an unbound webhook client (deny is scoped to bound clients)', async () => {
    expect(creds['webhook-integration'].clientId).toStartWith('gbrain_cl_');
    const token = await mintToken('webhook-integration');

    const res = await fetch(`http://127.0.0.1:${serverPort}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/markdown',
        'X-Gbrain-Slug': 'inbox/webhook-note',
      },
      body: '---\ntype: note\ntitle: x\n---\n# from a webhook',
    });
    expect([200, 202]).toContain(res.status);
  });

  test('write ops that cannot be slug-fenced are denied to a bound client', async () => {
    // extract_entities mutates people/* and companies/* timelines; extract_facts
    // appends to any entity's fact fence; forget_fact targets a fact by numeric
    // id across sources; ontology_propose writes claims keyed to any entity.
    // None takes a fenceable slug, so all are denied at dispatch rather than
    // left silently unfenced.
    const token = await mintToken('alice-example');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['extract_entities', { text: 'Bob Victim did a bad thing.', source_slug: 'emp-alice-example/notes/hello' }],
      ['extract_facts', { turn_text: 'Bob Victim admitted it.', entity_hints: ['people/bob-victim'] }],
      ['forget_fact', { id: 1, reason: 'retracted' }],
      ['ontology_propose', { entity: 'emp-bob-example/profile', dimension: 'role', value: 'terminated' }],
    ];
    for (const [tool, args] of cases) {
      const body = await mcpCall(token, tool, args);
      expect(body).toMatch(/not available to slug-bound clients/);
    }
  });

  test('a fenced write op still works over the same transport (allow-list is not a blanket deny)', async () => {
    const token = await mintToken('alice-example');
    const ok = await mcpCall(token, 'put_page', {
      slug: 'emp-alice-example/notes/via-mcp', content: '# via mcp',
    });
    expect(ok).not.toMatch(/not available to slug-bound clients/);
    expect(ok).not.toMatch(/permission_denied/);

    const denied = await mcpCall(token, 'put_page', {
      slug: 'emp-bob-example/notes/nope', content: '# nope',
    });
    expect(denied).toMatch(/bound_slug_prefixes/);
  });
});
