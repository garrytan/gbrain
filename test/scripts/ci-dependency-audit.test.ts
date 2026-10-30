/**
 * scripts/ci-dependency-audit.sh: a registry that never answered is not an advisory. Master v0.60.361.0 went red when the
 * advisories endpoint returned 503 and the script reported "bun audit found advisories". Forced probe: a local stub
 * registry (BUN_CONFIG_REGISTRY) answers 503, then advisories, then nothing found; the real `bun audit` runs against it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
let plan: number[] = [];
let calls = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/-/npm/v1/security/advisories/bulk')) return new Response('not found', { status: 404 });
    const status = plan[calls++] ?? plan.at(-1)!;
    if (status !== 200 && status !== 299) return new Response('Service Unavailable', { status });
    if (status === 200) return Response.json({});
    const raw = new Uint8Array(await req.arrayBuffer());
    let text: string; try { text = new TextDecoder().decode(Bun.gunzipSync(raw)); } catch { text = new TextDecoder().decode(raw); }
    const [name] = Object.keys(JSON.parse(text) as Record<string, string[]>);
    return Response.json({ [name!]: [{ id: 1, url: 'https://github.com/advisories/GHSA-0000-0000-0000', title: 'Synthetic advisory', severity: 'high', vulnerable_versions: '*', cwe: [], cvss: { score: 7.5, vectorString: null } }] });
  } });
});
afterAll(() => server.stop(true));

/** 299 stands for "answers with an advisory for the first package". */
async function audit(statuses: number[], env: Record<string, string> = {}) {
  plan = statuses; calls = 0;
  // Asynchronous: the stub registry answers on this test's event loop.
  const child = Bun.spawn(['bash', 'scripts/ci-dependency-audit.sh'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}/`, AUDIT_RETRY_DELAYS: '0 0', REASON: 'test', ...env } });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { status, out: out + err, calls };
}

/** Requests one `bun audit` makes against a registry that keeps answering 503: 1 on Bun 1.4.3, 6 on 1.4.4, which retries itself. */
async function requestsPerAudit() {
  plan = [503]; calls = 0;
  const child = Bun.spawn(['bun', 'audit'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}/` } });
  await child.exited;
  return calls;
}

test('a registry that keeps answering 503 is audit_registry_unavailable after bounded retries, never advisories', async () => {
  const perAudit = await requestsPerAudit();
  expect(perAudit).toBeGreaterThan(0);
  const run = await audit([503]);
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::audit_registry_unavailable');
  expect(run.out).toContain('- 503 (attempt 3)');
  expect(run.out).not.toContain('found advisories');
  // Root and admin/, three attempts each.
  expect(run.calls).toBe(2 * 3 * perAudit);
}, 60_000);

test('a 503 that recovers on retry is a clean audit', async () => {
  // Every request of the first attempt fails, so the script's own retry is what recovers.
  const run = await audit([...Array<number>(await requestsPerAudit()).fill(503), 200]);
  expect(run.status).toBe(0);
  expect(run.out).toContain('retrying in 0s');
  expect(run.out).toContain('bun audit: no advisories.');
  expect(run.out).not.toContain('audit_registry_unavailable');
});

test('a real advisory still blocks a blocking run as advisories', async () => {
  const run = await audit([299]);
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::bun audit found advisories');
  expect(run.out).not.toContain('audit_registry_unavailable');
});

test('an unavailable registry on an advisory-only run warns without failing', async () => {
  const run = await audit([503], { BLOCKING: 'false' });
  expect(run.status).toBe(0);
  expect(run.out).toContain('::warning::audit_registry_unavailable');
  expect(run.out).not.toContain('found advisories');
});
