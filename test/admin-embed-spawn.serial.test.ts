/**
 * v0.36.1.x #1090: admin embed E2E — spawns `gbrain serve --http` from a
 * fresh tmpdir (so `process.cwd()/admin/dist` doesn't exist), then issues
 * a real HTTP GET to /admin and asserts the React SPA shell HTML comes
 * back from the embedded manifest path — NOT a 404, NOT an Express
 * default error page.
 *
 * Pre-fix, the server resolved `adminDistPath = path.join(process.cwd(),
 * 'admin', 'dist')` and skipped /admin route mounting when that path did
 * not exist. Every globally-installed binary (`bun install -g
 * github:garrytan/gbrain`) hit 404 on /admin because the user never
 * cd's into the source repo. The fix:
 *   1. `scripts/build-admin-embedded.ts` walks admin/dist and emits
 *      `src/admin-embedded.ts` with `with { type: 'file' }` imports.
 *   2. `serve-http.ts` two-tier resolution: cwd-relative admin/dist for
 *      dev (Vite hot-rebuild), embedded manifest otherwise.
 *
 * This test deliberately runs the server from a tmpdir so the cwd-relative
 * branch CANNOT fire — the embedded path is the one under test. If the
 * embed wiring regresses, this case fails with a 404 (or never reaches
 * the SPA shell HTML).
 *
 * No DATABASE_URL needed; PGLite is the engine. Serial because it binds
 * a TCP port and reads/writes a tmpdir.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

interface ServeProc {
  proc: Subprocess;
  port: number;
  home: string;
  bootstrapToken: string;
  cleanup: () => Promise<void>;
}

function pickPort(): number {
  // High-random port. Collision is unlikely; test reruns get fresh ports.
  return 31000 + Math.floor(Math.random() * 4000);
}

async function spawnServer(): Promise<ServeProc> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-embed-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );

  // Pin the bootstrap token via env so the test doesn't have to scrape it
  // out of the startup banner (and the banner stays predictable across
  // future formatting tweaks).
  const bootstrapToken = 'test-bootstrap-token-aaaaaaaaaaaaaaaaaa'; // 41 chars
  const port = pickPort();

  // CRITICAL: cwd is the tmpdir, NOT the repo. This forces serve-http to
  // fall into the embedded-manifest branch because cwd/admin/dist does
  // not exist. The pre-fix code would 404 here; the fix serves from the
  // bundled assets via Bun's `with { type: 'file' }` import resolution.
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      `${REPO}/src/cli.ts`,
      'serve',
      '--http',
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,
        // Don't let test-process inherit any auth keys it doesn't need.
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // Wait for readiness by polling /health. Bun's readable streams don't
  // give us a synchronous "stderr line" API and the startup banner format
  // is allowed to drift; a /health probe is the contract that matters.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }

  const cleanup = async () => {
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    // Give it 2s to exit cleanly, then SIGKILL.
    await Promise.race([
      proc.exited,
      new Promise(r => setTimeout(r, 2000)),
    ]);
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  if (!ready) {
    // Capture some diagnostics for the failure message before tearing down.
    const stderrText = await new Response(proc.stderr).text().catch(() => '');
    await cleanup();
    throw new Error(
      `serve --http never became ready on port ${port} after 30s. stderr: ${stderrText.slice(0, 2000)}`,
    );
  }

  return { proc, port, home, bootstrapToken, cleanup };
}

describe('admin embed E2E — /admin served from embedded manifest (v0.36.1.x #1090)', () => {
  test('GET /admin/ returns 200 with the React SPA shell HTML', async () => {
    const s = await spawnServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/admin/`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // The actual admin/dist/index.html declares <title>GBrain Admin</title>
      // and mounts the SPA on <div id="root">. Both must be present, otherwise
      // we're not serving the embedded asset.
      expect(html).toContain('GBrain Admin');
      expect(html).toContain('<div id="root">');
      // Content-Type is text/html, not application/octet-stream (which would
      // mean the mime lookup in ADMIN_ASSETS regressed).
      expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    } finally {
      await s.cleanup();
    }
  }, 90_000);

  test('GET /admin/index.html (explicit path) also returns the SPA HTML', async () => {
    const s = await spawnServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/admin/index.html`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('GBrain Admin');
    } finally {
      await s.cleanup();
    }
  }, 90_000);

  test('GET /admin/agents (SPA-routed deep link) falls back to index.html', async () => {
    const s = await spawnServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/admin/agents`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // SPA fallback: any unmatched /admin/* path serves index.html so
      // client-side routing takes over.
      expect(html).toContain('GBrain Admin');
      expect(html).toContain('<div id="root">');
    } finally {
      await s.cleanup();
    }
  }, 90_000);

  test('GET /admin/api/stats (API route) is NOT swallowed by the SPA fallback — returns auth challenge', async () => {
    const s = await spawnServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/stats`, {
        signal: AbortSignal.timeout(5000),
      });
      // No session cookie → 401/403 from requireAdmin, NOT 200 + HTML.
      // The regression we guard against: SPA fallback grabbing /admin/api/*
      // would silently return HTML to a JSON client and break the dashboard.
      expect(res.status).not.toBe(200);
      const body = await res.text().catch(() => '');
      expect(body).not.toContain('<div id="root">');
    } finally {
      await s.cleanup();
    }
  }, 90_000);
});
