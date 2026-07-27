/**
 * v0.43 (#2084 / eng-review TD1) — PgBouncer transaction-mode teardown E2E.
 *
 * Three consecutive waves (#1972 → #2015 → #2084) fixed pooler-teardown bugs
 * that were verified only against one production deployment, because CI had
 * no transaction-mode pooler. This file pins the bug CLASS, not exact
 * timings: a CLI op against a txn-mode pooled URL must
 *
 *   1. exit zero with intact stdout, and
 *   2. NOT ride the 10s hard-deadline backstop (the
 *      "[cli] engine.disconnect() did not return within 10000ms" banner is
 *      the smoking gun — pre-#2084 it printed on 100% of query-shaped ops).
 *
 * Topology: docker-compose.ci.yml runs `pgbouncer` (transaction mode) in
 * front of postgres-1. The test uses a DEDICATED database
 * (`gbrain_pgbouncer`) created via the direct URL, so it never races the
 * TRUNCATE-based fixtures any shard runs against `gbrain_test`.
 *
 * Gated by GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL — skips
 * gracefully outside the docker CI gate. Run manually:
 *
 *   GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@localhost:6543/gbrain_pgbouncer \
 *   GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *   bun test test/e2e/pgbouncer-teardown.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const POOLED_URL = process.env.GBRAIN_PGBOUNCER_URL;
const DIRECT_ADMIN_URL = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const SKIP = !POOLED_URL || !DIRECT_ADMIN_URL;
const describePooled = SKIP ? describe.skip : describe;

const REPO = resolve(import.meta.dir, '..', '..');
const TEST_DB = 'gbrain_pgbouncer';
const SLUG = 'test/pgbouncer-teardown-fixture';
const MARKER = 'pgbouncer-teardown-marker-content-7c4f';

/** Direct URL pointing at the dedicated test database (same server). */
function directTestDbUrl(): string {
  const u = new URL(DIRECT_ADMIN_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; wallMs: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, ...env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, wallMs: Date.now() - t0 };
  } finally {
    clearTimeout(killer);
  }
}

describePooled('pgbouncer txn-mode teardown (#2084 / TD1)', () => {
  let home: string;

  beforeAll(async () => {
    // Dedicated database on the same server, created via the DIRECT url
    // (CREATE DATABASE cannot run through a transaction-mode pooler).
    const admin = postgres(DIRECT_ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }

    // Schema + fixture via the direct connection (DDL stays off the pooler,
    // matching the production split-pool discipline).
    const eng = new PostgresEngine();
    await eng.connect({ engine: 'postgres', database_url: directTestDbUrl() });
    await eng.initSchema();
    await eng.putPage(SLUG, {
      type: 'note',
      title: 'PgBouncer teardown fixture',
      compiled_truth: MARKER,
      timeline: '',
    });
    await eng.disconnect();

    // Brain config pointing the CLI at the POOLED url.
    home = mkdtempSync(join(tmpdir(), 'gbrain-pgbouncer-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const pooled = new URL(POOLED_URL!);
    pooled.pathname = `/${TEST_DB}`;
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: pooled.toString() }) + '\n',
    );
  }, 240_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('op against the pooled URL exits clean — output intact, no force-exit banner', async () => {
    const env = { HOME: home, GBRAIN_HOME: home };
    const res = await runCli(['get', SLUG], env, 90_000);

    if (res.exitCode !== 0 || /force-exiting/.test(res.stderr)) {
      console.error('--- stdout ---\n' + res.stdout);
      console.error('--- stderr ---\n' + res.stderr);
    }
    expect(res.exitCode).toBe(0);
    // Output is complete — the #1959 truncation class.
    expect(res.stdout).toContain(MARKER);
    // The smoking gun: pre-#2084 the hard-deadline banner printed every time
    // a query-shaped op ran against a txn-mode pooler.
    expect(res.stderr).not.toMatch(/force-exiting/);
    expect(res.stderr).not.toMatch(/did not return within/);
    // Generous CLASS bound (cold bun parse on CI is 10-20s): the op itself is
    // milliseconds; anything that ALSO waited out a 10s teardown backstop
    // lands well past this.
    expect(res.wallMs).toBeLessThan(60_000);
  }, 120_000);

  test('second run (warm schema probe) also exits clean through the pooler', async () => {
    const env = { HOME: home, GBRAIN_HOME: home };
    const res = await runCli(['get', SLUG], env, 90_000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(MARKER);
    expect(res.stderr).not.toMatch(/force-exiting/);
  }, 120_000);
});
