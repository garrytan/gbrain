/**
 * #6453: `harness_wiring` on a Postgres brain (or any brain with no PGLite
 * lock to read) used to report `http_serve_missing` for an HTTP registration
 * even while the registered endpoint was up, because the only "is a server
 * running" signal was the PGLite lock. The smoke now probes the registered
 * URL's `/health?deep=1` (no credentials) before warning.
 *
 * Hermetic temp HOME + GBRAIN_HOME; the "server" is a Bun.serve stub, so no
 * gbrain process and no database is started.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck, probeHttpRegistration, type HarnessRegistration } from '../src/commands/doctor/checks/harness-wiring.ts';
import { withEnv } from './helpers/with-env.ts';

const SECRET = 'gbrain_SECRETTOKEN0123456789';
const roots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Stub { url: string; hits: Array<{ path: string; auth: string | null }> }

function stub(handler: (req: Request) => Response | Promise<Response>): Stub {
  const hits: Stub['hits'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ path: u.pathname + u.search, auth: req.headers.get('authorization') });
      return handler(req);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

const healthy = (): Response => Response.json({ status: 'ok', deep: true, version: '0.0.0.0', engine: 'postgres', probe_ms: 1, pool: null });

/** A fresh machine whose Claude Code registers `mcpEntry` for gbrain. */
function box(engine: 'postgres' | 'pglite', mcpEntry: Record<string, unknown>): { env: Record<string, string | undefined>; gbrainHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-http-'));
  roots.push(root);
  const home = join(root, 'home');
  const gbrainHome = join(root, 'gbrain-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: mcpEntry } }));
  const cfg = engine === 'postgres'
    ? { engine: 'postgres', database_url: 'postgresql://user:pw@127.0.0.1:1/none' }
    : { engine: 'pglite', database_path: join(gbrainHome, '.gbrain', 'brain.pglite') };
  writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify(cfg));
  return {
    gbrainHome,
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

const httpEntry = (base: string, extra = ''): Record<string, unknown> => ({
  type: 'http', url: `${base}/mcp${extra}`, headers: { Authorization: `Bearer ${SECRET}` },
});

async function check(b: ReturnType<typeof box>, opts: { httpProbeTimeoutMs?: number } = {}) {
  return withEnv(b.env, () => harnessWiringCheck({ smoke: true, ...opts }));
}

/** A closed port: bind, remember the port, stop. */
function deadBase(): string {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
  const base = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return base;
}

describe('harness_wiring HTTP registration on a brain with no PGLite lock (#6453)', () => {
  test('Postgres + healthy endpoint → ok wired_running, probed without credentials', async () => {
    const s = stub(healthy);
    const c = await check(box('postgres', httpEntry(s.url)));
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ reason: 'wired_running', kind: 'http', harness: 'claude-code' });
    expect(c.fix).toBeUndefined();
    expect(s.hits).toEqual([{ path: '/health?deep=1', auth: null }]);
  });

  test('Postgres + dead endpoint → the original http_serve_missing warning, unchanged', async () => {
    const c = await check(box('postgres', httpEntry(deadBase())));
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'http_serve_missing' });
    expect(c.fix?.argv).toEqual(['gbrain', 'serve', '--http']);
  });

  test('Postgres + endpoint that answers 503 → warn, and no fix that starts a second server', async () => {
    const s = stub(() => Response.json({ error: 'service_unavailable', deep: true }, { status: 503 }));
    const c = await check(box('postgres', httpEntry(s.url)));
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'http_serve_unhealthy', http_status: 503 });
    expect(c.fix).toBeUndefined();
    expect(c.fix_unavailable_reason).toBe('no_safe_automatic_fix');
  });

  test('Postgres + something else listening on the port (not gbrain) → warn, no start fix', async () => {
    const s = stub(() => new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const c = await check(box('postgres', httpEntry(s.url)));
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'http_serve_unhealthy' });
    expect(c.fix).toBeUndefined();
  });

  test('Postgres + endpoint that never answers → warn after the probe timeout, no start fix', async () => {
    const s = stub(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const c = await check(box('postgres', httpEntry(s.url)), { httpProbeTimeoutMs: 250 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'http_serve_unhealthy', probe: 'timeout' });
    expect(c.fix).toBeUndefined();
    expect(c.fix_unavailable_reason).toBe('no_safe_automatic_fix');
  });

  test('a redirecting endpoint is not followed', async () => {
    const target = stub(healthy);
    const s = stub(() => new Response(null, { status: 302, headers: { location: `${target.url}/health?deep=1` } }));
    const c = await check(box('postgres', httpEntry(s.url)));
    expect(c.status).toBe('warn');
    expect(target.hits).toHaveLength(0);
  });

  test('registered URL userinfo, query and bearer never reach the output', async () => {
    const s = stub(healthy);
    const dead = deadBase();
    for (const base of [s.url, dead]) {
      const entry = httpEntry(base.replace('http://', `http://bob:${SECRET}@`), `?token=${SECRET}`);
      const c = await check(box('postgres', entry));
      const text = JSON.stringify(c);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('bob:');
      expect(text).not.toContain('token=');
    }
  });

  test('PGLite: the lock stays the only signal; a healthy stub is never probed', async () => {
    const s = stub(healthy);
    const b = box('pglite', httpEntry(s.url));
    const c = await check(b);
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'http_serve_missing' });
    expect(c.fix?.argv).toEqual(['gbrain', 'serve', '--http']);
    expect(s.hits).toHaveLength(0);
  });

  test('PGLite: a live serve --http holding the lock is still ok without probing', async () => {
    const s = stub(healthy);
    const b = box('pglite', httpEntry(s.url));
    const lockDir = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid, acquired_at: Date.now(), refreshed_at: Date.now(), subcommand: 'serve', argv: ['gbrain', 'serve', '--http'], owner_token: 't',
    }));
    const c = await check(b);
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ reason: 'wired_running' });
    expect(String(c.message)).toContain('holds this brain');
    expect(s.hits).toHaveLength(0);
  });
});

describe('probeHttpRegistration', () => {
  const reg = (url: string): HarnessRegistration => ({ harness: 'claude-code', source: '/x/.claude.json', kind: 'http', url });

  test('maps the registered …/mcp URL to the sibling …/health?deep=1, keeping any proxy prefix', async () => {
    const s = stub(healthy);
    const out = await probeHttpRegistration(reg(`${s.url}/some/prefix/mcp`), 2_000);
    expect(out).toMatchObject({ state: 'up' });
    expect(s.hits.map((h) => h.path)).toEqual(['/some/prefix/health?deep=1']);
  });

  test('refused connection → down; hung → timeout; 503 → unhealthy; malformed url → down', async () => {
    expect(await probeHttpRegistration(reg(`${deadBase()}/mcp`), 2_000)).toMatchObject({ state: 'down' });
    const hung = stub(() => new Promise<Response>(() => {}));
    expect(await probeHttpRegistration(reg(`${hung.url}/mcp`), 200)).toMatchObject({ state: 'timeout' });
    const bad = stub(() => new Response('no', { status: 503 }));
    expect(await probeHttpRegistration(reg(`${bad.url}/mcp`), 2_000)).toMatchObject({ state: 'unhealthy', status: 503 });
    expect(await probeHttpRegistration(reg('not a url'), 2_000)).toMatchObject({ state: 'down' });
  });
});
