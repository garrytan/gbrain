/**
 * Truncated usage windows after a request-log prune (#6770 rewrite), through
 * the real CLI and script entry points.
 *
 * Authoring gate: (1) protects what an operator reads when a usage window
 * reaches back past pruned history: `gbrain auth clients --usage` prints the
 * truncation with the exact `--days` that is complete and the recovery note,
 * its `--json` carries the same facts in keys only (stdout stays one JSON
 * document), and `scripts/derive-starter-ops.ts` refuses on stderr with a
 * non-zero exit instead of deriving the starter surface from partial data;
 * (2) fails when a truncated window reads as complete; (3) no test spawned
 * either entry point before; (4) no production seam.
 *
 * Repo-less: a disk PGLite brain with no git checkout, reached through
 * GBRAIN_HOME's config.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const ROOT = resolve(import.meta.dir, '..');
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function run(argv: string[]) {
  const proc = Bun.spawn(['bun', 'run', ...argv], { cwd: root, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}
const cli = (args: string[]) => run([join(ROOT, 'src', 'cli.ts'), ...args]);
const derive = (args: string[]) => run([join(ROOT, 'scripts', 'derive-starter-ops.ts'), ...args]);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-mcp-log-retention-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try {
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read) VALUES ('alice-client', 'alice-client', 'read', 'default', ARRAY['default'])");
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, created_at)
       SELECT 'alice-client', 'alice-client', 'query', 5, 'success', now() - (g * interval '1 hour') FROM generate_series(1, 12) g`);
    // A prune already ran: the newest pruned row is 40 days old.
    await engine.executeRaw(
      `INSERT INTO mcp_request_log_rollup (token_name, requests, last_used_at, pruned_through)
       VALUES ('alice-client', 30, now() - interval '40 days', now() - interval '40 days')`);
  } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('usage windows that reach past pruned history (repo-less PGLite)', () => {
  test('auth clients --usage --days 365 --json carries the truncation in JSON keys only', async () => {
    const r = await cli(['auth', 'clients', '--usage', '--days', '365', '--json']);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ window_days: 365, window_truncated: true, covered_days: 40 });
    expect(Date.parse(doc.pruned_before)).toBeLessThan(Date.now() - 39 * 86_400_000);
    expect(doc.window_note).toContain('--days 40');
    expect(doc.window_note).toContain('cannot restore');
    expect(r.stderr).not.toContain('window truncated');
  }, 60_000);

  test('auth clients --usage --days 365 prints the truncation with the fix and the recovery note', async () => {
    const r = await cli(['auth', 'clients', '--usage', '--days', '365']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('window truncated: details before');
    expect(r.stdout).toContain('--days 40');
    expect(r.stdout).toContain('cannot restore');
  }, 60_000);

  test('a window inside the kept history is complete', async () => {
    const r = await cli(['auth', 'clients', '--usage', '--days', '30', '--json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ window_truncated: false, covered_days: 30, pruned_before: expect.any(String) });
  }, 60_000);

  test('derive-starter-ops refuses a truncated window on stderr with a non-zero exit', async () => {
    const refused = await derive(['--days', '365']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('window truncated');
    expect(refused.stderr).toContain('--days 40');
    expect(refused.stderr).toContain('cannot restore');
    expect(refused.stdout).not.toContain('Proposed block');
    const ok = await derive(['--days', '30']);
    expect(ok.exitCode).toBe(0);
  }, 120_000);
});
