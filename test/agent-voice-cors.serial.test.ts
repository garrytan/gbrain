/**
 * #2477 — agent-voice reference server ships default-deny CORS, an Origin
 * gate on the side-effectful POSTs, and a loopback-default bind.
 *
 * Spawns the real server (recipes/agent-voice/code/server.mjs) and asserts:
 *
 *   1. Default posture (no env): no Access-Control-Allow-Origin header is
 *      ever emitted; cross-origin POSTs to /session and /tool are rejected
 *      403 BEFORE any work (proven by ordering: a no-Origin POST /session
 *      reaches the handler and 500s on the missing OPENAI_API_KEY instead).
 *      Same-origin requests (Origin host == Host header) pass the gate.
 *   2. Allowlist posture (AGENT_VOICE_CORS_ORIGIN): exact-match origins get
 *      ACAO echo + Vary: Origin (+ preflight headers on OPTIONS) and pass
 *      the gate; everything else stays default-deny. Spaces around commas
 *      are trimmed.
 *
 * `.serial` suffix: binds TCP ports, runs in the serial pass.
 * Pattern per test/admin-embed-spawn.serial.test.ts (spawn + /health poll +
 * SIGTERM→SIGKILL cleanup). The default HOST bind (127.0.0.1) is covered
 * implicitly — every request here reaches the server via 127.0.0.1.
 */

import { describe, test, expect } from 'bun:test';
import type { Subprocess } from 'bun';
import { join } from 'path';

const SERVER_SCRIPT = join(import.meta.dir, '..', 'recipes', 'agent-voice', 'code', 'server.mjs');
const EVIL = 'https://evil.example';

function pickPort(): number {
  return 31000 + Math.floor(Math.random() * 4000);
}

interface VoiceServer {
  port: number;
  base: string;
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Accumulated stdout — carries the startup bind + CORS posture log lines. */
  stdout: () => string;
}

async function spawnVoice(extraEnv: Record<string, string> = {}): Promise<VoiceServer> {
  const port = pickPort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    // The server starts without a key; /session 500s lazily — which the
    // ordering assertions below rely on.
    OPENAI_API_KEY: '',
  };
  // A developer's shell must not leak an allowlist or bind override into the
  // default-deny spawn.
  delete env.AGENT_VOICE_CORS_ORIGIN;
  delete env.HOST;
  Object.assign(env, extraEnv);

  const proc = Bun.spawn([process.execPath, SERVER_SCRIPT], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain stdout in the background so the startup log lines are assertable.
  let out = '';
  (async () => {
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        out += new TextDecoder().decode(chunk);
      }
    } catch { /* stream closed on shutdown */ }
  })();

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { port, base, proc, stdout: () => out };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`agent-voice server did not become healthy in 30s\nstderr: ${stderr.slice(-800)}`);
}

async function stopVoice(server: VoiceServer): Promise<void> {
  server.proc.kill('SIGTERM');
  const graceful = await Promise.race([
    server.proc.exited.then(() => true),
    new Promise<false>(r => setTimeout(() => r(false), 2000)),
  ]);
  if (!graceful) {
    server.proc.kill('SIGKILL');
    await server.proc.exited.catch(() => {});
  }
}

describe('agent-voice CORS default-deny + origin gate (#2477)', () => {
  test('default posture: no CORS headers, cross-origin side-effect POSTs 403 before any work', async () => {
    const server = await spawnVoice();
    try {
      // No ACAO on a cross-origin read — the browser blocks the response.
      const health = await fetch(`${server.base}/health`, { headers: { Origin: EVIL } });
      expect(health.status).toBe(200);
      expect(health.headers.get('access-control-allow-origin')).toBeNull();
      expect(health.headers.get('vary') ?? '').not.toContain('Origin');

      // Preflight still answers 204, but with no CORS headers it fails in
      // the browser — the actual cross-origin request never fires.
      const preflight = await fetch(`${server.base}/session`, {
        method: 'OPTIONS',
        headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      expect(preflight.headers.get('access-control-allow-methods')).toBeNull();

      // Origin gate: a "simple" cross-origin POST (no preflight in real
      // browsers) is rejected before the handler runs.
      const gated = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(gated.status).toBe(403);
      expect(await gated.text()).toContain('origin not allowed');

      // Ordering proof: without an Origin header (curl / Twilio / native)
      // the same request PASSES the gate and reaches the handler, which
      // 500s on the missing OPENAI_API_KEY. 403 above therefore came from
      // the gate, before any upstream spend could happen.
      const noOrigin = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(noOrigin.status).toBe(500);
      expect(await noOrigin.text()).toContain('OPENAI_API_KEY not set');

      // Same-origin browser requests (Origin host == Host header) pass the
      // gate — the served /call page keeps working with zero config.
      const sameOrigin = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { Origin: server.base, 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(sameOrigin.status).toBe(500); // handler reached, not 403

      // Malformed Origin (unparseable by new URL()) must fail closed → 403,
      // never fall through to the handler. A bypass here would be a real hole.
      const malformed = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { Origin: 'http://[::bogus', 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(malformed.status).toBe(403);

      // /tool: gated identically (before the body is even read)…
      const toolGated = await fetch(`${server.base}/tool`, {
        method: 'POST',
        headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
        body: 'not json',
      });
      expect(toolGated.status).toBe(403);

      // …while a no-Origin caller reaches the handler (400 invalid_json).
      const toolNoOrigin = await fetch(`${server.base}/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      });
      expect(toolNoOrigin.status).toBe(400);
    } finally {
      await stopVoice(server);
    }
  }, 90_000);

  test('allowlist posture: exact-match origins get CORS headers and pass the gate; others stay denied', async () => {
    // Space after the comma pins trimming.
    const server = await spawnVoice({ AGENT_VOICE_CORS_ORIGIN: 'https://ok.example, https://two.example' });
    try {
      // Allowlisted origin: ACAO echoes the exact origin + Vary: Origin.
      const ok = await fetch(`${server.base}/health`, { headers: { Origin: 'https://ok.example' } });
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok.example');
      expect(ok.headers.get('vary') ?? '').toContain('Origin');

      // Second (space-padded) entry works too — trimming pinned.
      const two = await fetch(`${server.base}/health`, { headers: { Origin: 'https://two.example' } });
      expect(two.headers.get('access-control-allow-origin')).toBe('https://two.example');

      // Preflight from an allowlisted origin carries the method/header grants.
      const preflight = await fetch(`${server.base}/session`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://ok.example', 'Access-Control-Request-Method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://ok.example');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
      // Never credentialed, even when allowlisted.
      expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

      // Allowlisted origin passes the side-effect gate (handler reached).
      const gatePass = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { Origin: 'https://ok.example', 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(gatePass.status).toBe(500);
      expect(await gatePass.text()).toContain('OPENAI_API_KEY not set');

      // Exact match, not wildcard: unlisted origins stay fully denied.
      const evil = await fetch(`${server.base}/health`, { headers: { Origin: EVIL } });
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      const evilPost = await fetch(`${server.base}/session`, {
        method: 'POST',
        headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
        body: 'v=0',
      });
      expect(evilPost.status).toBe(403);
    } finally {
      await stopVoice(server);
    }
  }, 90_000);

  // The loopback-default bind is the security-relevant half of #2477. A raw
  // socket probe of a non-loopback interface is flaky in CI (no LAN IP,
  // firewalls), so pin the HOST knob via the startup log the listen callback
  // emits: default → 127.0.0.1, HOST override → honored.
  async function readStartupLog(server: VoiceServer): Promise<string> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (server.stdout().includes('listening on')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    return server.stdout();
  }

  test('HOST default binds loopback (127.0.0.1)', async () => {
    const server = await spawnVoice(); // HOST scrubbed from env → default
    try {
      const log = await readStartupLog(server);
      expect(log).toContain(`listening on http://127.0.0.1:${server.port}`);
      expect(log).toContain('bind: 127.0.0.1');
      // The default log carries a "set HOST=0.0.0.0 to expose" hint, so the
      // bind proof is the loopback URL above, not mere absence of "0.0.0.0".
      expect(log).not.toContain('http://0.0.0.0');
    } finally {
      await stopVoice(server);
    }
  }, 90_000);

  test('HOST override is honored (0.0.0.0 for containers/LAN)', async () => {
    const server = await spawnVoice({ HOST: '0.0.0.0' });
    try {
      const log = await readStartupLog(server);
      expect(log).toContain(`listening on http://0.0.0.0:${server.port}`);
      // Still reachable via loopback when bound to all interfaces.
      const health = await fetch(`${server.base}/health`);
      expect(health.status).toBe(200);
    } finally {
      await stopVoice(server);
    }
  }, 90_000);
});
