/**
 * #6453: `harness_wiring` on a brain without a PGLite lock (Postgres,
 * `database_url`, a `remote_mcp` thin client) used to report
 * `http_serve_missing` for every HTTP registration without contacting the
 * endpoint, and `describeRegistration` echoed the registered URL verbatim,
 * userinfo and `?token=` included.
 *
 * Hermetic HOME + GBRAIN_HOME; the "server" is a local `Bun.serve` stub that
 * records every request it sees. No `gbrain serve` is spawned and nothing
 * leaves the machine (every URL is loopback or a closed loopback port).
 *
 * - the registered URL's credentials never appear in the message, details or
 *   fix of any verdict (healthy, refused, unhealthy, registration-only);
 * - Postgres + healthy `/health?deep=1` → `ok` / `wired_running` with
 *   `probe: 'health'` and `mcp_access: 'unverified'`, exactly one credential-free hit;
 * - a registration whose MCP token is wrong is still reported `unverified`,
 *   never as a passed recall;
 * - loopback `http:` refused → `http_serve_missing` with the `serve --http` fix;
 * - `https:` refused, a hang, a 503, a redirect, an unrelated listener → warn
 *   with no fix (never "start a second server");
 * - PGLite without a lock is never probed; a `remote_mcp` thin client probes
 *   shallow `/health` with `details.remote: true`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';

const mod = () => import('../src/commands/doctor/checks/harness-wiring.ts');
import { withEnv } from './helpers/with-env.ts';
import { renderBrainFirstSnippet } from '../src/core/setup/brain-first.ts';

const USER = 'alice-example';
const USERINFO_PART = 'userinfo-6453-fixture';
const QUERY_PART = 'query-6453-fixture';

interface Box { root: string; env: Record<string, string | undefined> }

function box(config: Record<string, unknown>): Box {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-6453-'));
  const home = join(root, 'home');
  const gbrainHome = join(root, 'gbrain-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
  writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify(config));
  return {
    root,
    env: {
      HOME: home,
      GBRAIN_HOME: gbrainHome,
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
    },
  };
}

const POSTGRES = { engine: 'postgres', database_url: 'postgres://gbrain:pw@127.0.0.1:1/gbrain' };
const PGLITE = { engine: 'pglite', database_path: '/nonexistent/brain.pglite' };

function register(b: Box, url: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(b.env.HOME!, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'http', url, ...extra } } }));
  // A complete wiring also carries the brain-first block, or harness_wiring warns on it.
  mkdirSync(b.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(b.env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'), renderBrainFirstSnippet('claude-code', { kind: 'mcp', server: 'gbrain' }));
}

interface Hit { path: string; query: string; authorization: string | null }
interface Stub { port: number; hits: Hit[]; stop(): void }

function stub(handler: (req: Request) => Response | Promise<Response>): Stub {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ path: u.pathname, query: u.search, authorization: req.headers.get('authorization') });
      return handler(req);
    },
  });
  return { port: server.port!, hits, stop: () => server.stop(true) };
}

const healthy = (version = '0.0.0-test') => (req: Request): Response => {
  const u = new URL(req.url);
  if (u.pathname.endsWith('/health')) return Response.json({ status: 'ok', deep: u.searchParams.get('deep') === '1', version, engine: 'postgres' });
  return new Response('unauthorized', { status: 401 });
};

function closedPort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
  const port = s.port!;
  s.stop(true);
  return port;
}

function credentialedUrl(port: number, scheme = 'http'): string {
  return `${scheme}://${USER}:${USERINFO_PART}@127.0.0.1:${port}/mcp?token=${QUERY_PART}#frag`;
}

function assertNoCredentials(check: unknown): void {
  const text = JSON.stringify(check);
  expect(text).not.toContain(USERINFO_PART);
  expect(text).not.toContain(QUERY_PART);
  expect(text).not.toContain(`${USER}:`);
  expect(text).not.toContain('token=');
}

const boxes: Box[] = [];
const stubs: Stub[] = [];
afterEach(() => {
  for (const s of stubs.splice(0)) s.stop();
  for (const b of boxes.splice(0)) rmSync(b.root, { recursive: true, force: true });
});

async function check(b: Box, smoke = true): Promise<Record<string, unknown>> {
  boxes.push(b);
  return (await withEnv(b.env, () => harnessWiringCheck({ smoke }))) as unknown as Record<string, unknown>;
}

describe('redactRegistrationUrl', () => {
  test('strips userinfo, query and fragment; an unparseable URL is never echoed', async () => {
    const { redactRegistrationUrl } = await mod();
    expect(redactRegistrationUrl(`https://${USER}:${USERINFO_PART}@brain.example:8443/mcp?token=${QUERY_PART}#x`)).toBe('https://brain.example:8443/mcp');
    expect(redactRegistrationUrl('http://127.0.0.1:3737/mcp')).toBe('http://127.0.0.1:3737/mcp');
    expect(redactRegistrationUrl(`not a url ${QUERY_PART}`)).toBe('<unparseable url>');
  });
});

describe('harness_wiring never echoes registration credentials (#6453)', () => {
  test('registration-only read (no smoke)', async () => {
    const b = box(POSTGRES);
    register(b, credentialedUrl(closedPort()));
    const c = await check(b, false);
    expect(c.details).toMatchObject({ reason: 'registration_unverified' });
    expect(String(c.message)).toContain('127.0.0.1');
    assertNoCredentials(c);
  });

  test('refused, healthy and unhealthy verdicts', async () => {
    const refused = box(POSTGRES);
    register(refused, credentialedUrl(closedPort()));
    assertNoCredentials(await check(refused));

    const ok = stub(healthy());
    stubs.push(ok);
    const wired = box(POSTGRES);
    register(wired, credentialedUrl(ok.port));
    const c = await check(wired);
    expect(c.details).toMatchObject({ reason: 'wired_running' });
    assertNoCredentials(c);
    expect(ok.hits.map(h => h.authorization)).toEqual([null]);
    expect(ok.hits[0].query).not.toContain(QUERY_PART);

    const bad = stub(() => new Response('<html>not gbrain</html>', { headers: { 'content-type': 'text/html' } }));
    stubs.push(bad);
    const unhealthy = box(POSTGRES);
    register(unhealthy, credentialedUrl(bad.port));
    const u = await check(unhealthy);
    expect(u.details).toMatchObject({ reason: 'http_serve_unhealthy' });
    assertNoCredentials(u);
  });
});

describe('harness_wiring probes the registered HTTP endpoint when there is no PGLite lock (#6453)', () => {
  test('Postgres + healthy /health?deep=1 → wired_running, probe: health, mcp_access: unverified', async () => {
    const s = stub(healthy('9.9.9-stub'));
    stubs.push(s);
    const b = box(POSTGRES);
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ name: 'harness_wiring', status: 'ok', details: { reason: 'wired_running', probe: 'health', mcp_access: 'unverified', kind: 'http', version: '9.9.9-stub', version_mismatch: true } });
    expect(c).not.toHaveProperty('fix');
    expect(String(c.message)).toContain('MCP access unverified');
    expect(String(c.message)).not.toMatch(/recall answered|smoke_passed/);
    expect(s.hits).toEqual([{ path: '/health', query: '?deep=1', authorization: null }]);
  });

  test('a healthy server behind a registration with an invalid MCP token is still only "unverified", never a passed recall', async () => {
    const s = stub(healthy());
    stubs.push(s);
    const b = box(POSTGRES);
    register(b, `http://127.0.0.1:${s.port}/mcp`, { headers: { Authorization: 'Bearer wrong-token-6453' } });
    const c = await check(b);
    expect(c).toMatchObject({ status: 'ok', details: { reason: 'wired_running', mcp_access: 'unverified' } });
    expect(c.details).not.toHaveProperty('smoke');
    expect(s.hits.map(h => h.path)).toEqual(['/health']);
    expect(s.hits[0].authorization).toBeNull();
    expect(JSON.stringify(c)).not.toContain('wrong-token-6453');
  });

  test('loopback http: refused → http_serve_missing with the serve --http fix', async () => {
    const b = box(POSTGRES);
    register(b, `http://localhost:${closedPort()}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_missing', probe: 'health' } });
    expect((c.fix as { argv: string[] }).argv).toEqual(['gbrain', 'serve', '--http']);
  });

  test('https: refused → http_serve_unreachable without a serve --http fix', async () => {
    const b = box(POSTGRES);
    register(b, `https://127.0.0.1:${closedPort()}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_unreachable' }, fix_unavailable_reason: 'no_safe_automatic_fix' });
    expect(c).not.toHaveProperty('fix');
  });

  test('an unrelated healthy listener → http_serve_unhealthy, no fix', async () => {
    const s = stub(() => Response.json({ hello: 'world' }));
    stubs.push(s);
    const b = box(POSTGRES);
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_unhealthy', http_status: 200 }, fix_unavailable_reason: 'no_safe_automatic_fix' });
    expect(c).not.toHaveProperty('fix');
  });

  test('a gbrain server whose deep probe answers 503 → http_serve_unhealthy with the health reason', async () => {
    const s = stub(() => Response.json({ error: 'service_unavailable', error_description: 'Deep health probe timed out', deep: true }, { status: 503 }));
    stubs.push(s);
    const b = box(POSTGRES);
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_unhealthy', http_status: 503 } });
    expect(String(c.message)).toContain('Deep health probe timed out');
    expect(c).not.toHaveProperty('fix');
  });

  test('a redirect is reported, not followed, and gets no fix', async () => {
    const s = stub(() => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:1/health?token=${QUERY_PART}` } }));
    stubs.push(s);
    const b = box(POSTGRES);
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_unhealthy', http_status: 302 }, fix_unavailable_reason: 'no_safe_automatic_fix' });
    expect(s.hits).toHaveLength(1);
    assertNoCredentials(c);
  });

  test('a hanging endpoint → http_serve_unreachable (timeout), no fix', async () => {
    const s = stub(() => new Promise<Response>(() => {}));
    stubs.push(s);
    const { probeHttpRegistration } = await mod();
    const outcome = await probeHttpRegistration({ harness: 'claude-code', source: 'x', kind: 'http', url: `http://127.0.0.1:${s.port}/mcp` }, { remote: false, timeoutMs: 300 });
    expect(outcome).toMatchObject({ ok: false, reason: 'http_serve_unreachable', details: { error: 'timeout' } });
    expect(outcome.fix).toBeUndefined();
  });

  test('PGLite without a lock is never probed and keeps http_serve_missing', async () => {
    const s = stub(healthy());
    stubs.push(s);
    const b = box(PGLITE);
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'warn', details: { reason: 'http_serve_missing' } });
    expect(c.details).not.toHaveProperty('probe');
    expect(s.hits).toEqual([]);
  });

  test('a remote_mcp thin client probes shallow /health and says so', async () => {
    const s = stub(healthy());
    stubs.push(s);
    const b = box({ engine: 'pglite', remote_mcp: { issuer_url: `http://127.0.0.1:${s.port}`, mcp_url: `http://127.0.0.1:${s.port}/mcp`, oauth_client_id: 'c' } });
    register(b, `http://127.0.0.1:${s.port}/mcp`);
    const c = await check(b);
    expect(c).toMatchObject({ status: 'ok', details: { reason: 'wired_running', probe: 'health', remote: true, mcp_access: 'unverified' } });
    expect(s.hits).toEqual([{ path: '/health', query: '', authorization: null }]);
  });
});
