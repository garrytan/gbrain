#!/usr/bin/env bun
/**
 * The admin UI of a compiled gbrain binary (v0.60.554.0: /admin was blank on installed builds because index.html
 * loaded a bundle the embedded manifest did not carry).
 *
 * Runs `serve --http` from the binary in an empty directory, so only the embedded manifest can answer, then fetches
 * /admin/ and every same-origin script and stylesheet the page loads. Each must return 200 with a body of the right
 * type. A source-tree run cannot catch a bundle that bun build --compile left out; this one runs the release file.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const arg = process.argv.indexOf('--binary');
if (arg < 0 || !process.argv[arg + 1]) { console.error('usage: compiled-admin-smoke.ts --binary <compiled gbrain>'); process.exit(2); }
const binary = resolve(process.argv[arg + 1]!);

const port = await new Promise<number>((done, fail) => {
  const server = createServer().once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); });
});
const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-smoke-'));
mkdirSync(join(home, '.gbrain', 'brain.pglite'), { recursive: true });
writeFileSync(join(home, '.gbrain', 'config.json'), `${JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), embedding_dimensions: 1536 })}\n`);
const server = Bun.spawn([binary, 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1'], {
  cwd: home,
  env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'admin-smoke-bootstrap-token-aaaaaaaaaaaa', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
  stdout: 'pipe', stderr: 'pipe',
});
const base = `http://127.0.0.1:${port}`;
try {
  const deadline = performance.now() + 60_000;
  let ready = false;
  while (!ready && server.exitCode === null && performance.now() < deadline) {
    ready = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
    if (!ready) await Bun.sleep(250);
  }
  if (!ready) throw new Error(`serve --http never answered /health (exit ${server.exitCode}): ${(await new Response(server.stderr).text().catch(() => '')).slice(0, 2000)}`);

  const page = await fetch(`${base}/admin/`, { signal: AbortSignal.timeout(10_000) });
  const html = await page.text();
  if (page.status !== 200 || !/text\/html/.test(page.headers.get('content-type') ?? '') || !html.includes('<div id="root">')) {
    throw new Error(`/admin/ did not return the admin shell (status ${page.status}, ${page.headers.get('content-type')})`);
  }
  const assets = [...html.matchAll(/<(script|link)\b[^>]*?\b(?:src|href)="(\/admin\/[^"]+)"/g)].map(([, tag, path]) => ({ tag: tag!, path: path! }));
  if (!assets.some(a => a.tag === 'script')) throw new Error('/admin/ loads no same-origin script');
  for (const { tag, path } of assets) {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.arrayBuffer();
    const type = res.headers.get('content-type') ?? '';
    const want = tag === 'script' ? /javascript/ : /css/;
    if (res.status !== 200 || body.byteLength === 0 || !want.test(type)) throw new Error(`${path}: status ${res.status}, ${body.byteLength} bytes, ${type}`);
  }
  console.log(`Compiled admin smoke passed: /admin/ and ${assets.length} asset(s)`);
} finally {
  if (server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([server.exited, Bun.sleep(3000)]); }
  if (server.exitCode === null) { server.kill(9); await server.exited; }
  rmSync(home, { recursive: true, force: true });
}
