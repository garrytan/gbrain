/**
 * scripts/ci-dependency-audit.sh: a registry that never answered is not an advisory. Master v0.60.361.0 went red when the
 * advisories endpoint returned 503 and the script reported "bun audit found advisories". Forced probe: a local stub
 * registry (BUN_CONFIG_REGISTRY) answers 503, then advisories, then nothing found; the real `bun audit` runs against it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
let plan: number[] = [];
let calls = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/-/npm/v1/security/advisories/bulk')) return new Response('not found', { status: 404 });
    const status = plan[calls++] ?? plan.at(-1)!;
    if (status < 200 || status > 299) return new Response('Service Unavailable', { status });
    if (status === 200) return Response.json({});
    const raw = new Uint8Array(await req.arrayBuffer());
    let text: string; try { text = new TextDecoder().decode(Bun.gunzipSync(raw)); } catch { text = new TextDecoder().decode(raw); }
    const names = Object.keys(JSON.parse(text) as Record<string, string[]>);
    // 298 answers only admin/ (vite is admin-only), 297 only the root (@ai-sdk/anthropic is root-only).
    if ((status === 298 && !names.includes('vite')) || (status === 297 && !names.includes('@ai-sdk/anthropic'))) return Response.json({});
    const [name] = names;
    return Response.json({ [name!]: [{ id: 1, url: 'https://github.com/advisories/GHSA-0000-0000-0000', title: 'Synthetic advisory', severity: 'high', vulnerable_versions: '*', cwe: [], cvss: { score: 7.5, vectorString: null } }] });
  } });
});
afterAll(() => server.stop(true));

/** 299 stands for "answers with an advisory for the first package"; 298 and 297 do so for admin/ or the root only. */
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
}, 60_000);

function ignoreFile(id: string, until: string) {
  const path = join(tmpdir(), `audit-ignore-${process.pid}-${until}.toml`);
  writeFileSync(path, `[[IgnoredVulns]]\nid = "${id}"\nignoreUntil = ${until}\nreason = "test"\n`);
  return path;
}

test('an ignore entry before its date clears that advisory in admin/', async () => {
  const run = await audit([298], { AUDIT_IGNORE_FILE: ignoreFile('GHSA-0000-0000-0000', '2026-12-17'), AUDIT_TODAY: '2026-11-17' });
  expect(run.out).toContain('bun audit in admin ignores GHSA-0000-0000-0000 until 2026-12-17');
  expect(run.out).toContain('bun audit: no advisories.');
  expect(run.status).toBe(0);
});

test('an ignore entry never applies to the root lockfile', async () => {
  const run = await audit([297], { AUDIT_IGNORE_FILE: ignoreFile('GHSA-0000-0000-0000', '2026-12-17'), AUDIT_TODAY: '2026-11-17' });
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::bun audit found advisories');
});

test('an ignore entry on or after its date blocks as audit_ignore_expired and is checked again', async () => {
  const run = await audit([298], { AUDIT_IGNORE_FILE: ignoreFile('GHSA-0000-0000-0000', '2026-12-17'), AUDIT_TODAY: '2026-12-17' });
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::audit_ignore_expired');
  expect(run.out).toContain('GHSA-0000-0000-0000 expired on 2026-12-17');
  expect(run.out).toContain('::error::bun audit found advisories');
  expect(run.out).not.toContain('ignores GHSA-0000-0000-0000');
});

test('the shipped admin ignore file parses and every entry has a date', () => {
  const t = Bun.TOML.parse(readFileSync(join(ROOT, 'admin', 'osv-scanner.toml'), 'utf8')) as { IgnoredVulns: { id: string; ignoreUntil: unknown; reason: string }[] };
  expect(t.IgnoredVulns.length).toBeGreaterThan(0);
  for (const v of t.IgnoredVulns) {
    expect(String(v.ignoreUntil)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.reason.length).toBeGreaterThan(20);
  }
});

test('an ignore entry without ignoreUntil blocks as audit_ignore_expired and is not ignored', async () => {
  const path = join(tmpdir(), `audit-ignore-${process.pid}-nodate.toml`);
  writeFileSync(path, '[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\nreason = "test"\n');
  const run = await audit([298], { AUDIT_IGNORE_FILE: path, AUDIT_TODAY: '2026-11-17' });
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::audit_ignore_expired');
  expect(run.out).toContain('GHSA-0000-0000-0000 has no ignoreUntil date');
  expect(run.out).toContain('::error::bun audit found advisories');
});

test('an unreadable ignore file fails as audit_ignore_unreadable', async () => {
  const path = join(tmpdir(), `audit-ignore-${process.pid}-bad.toml`);
  writeFileSync(path, '[[IgnoredVulns]\nid = ');
  const run = await audit([200], { AUDIT_IGNORE_FILE: path });
  expect(run.status).toBe(1);
  expect(run.out).toContain('::error::audit_ignore_unreadable');
});
