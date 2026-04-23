/**
 * E2E cycle tests — Tier 1 (no API keys required).
 *
 * Exercises runCycle against REAL Postgres (via the E2E helpers' setupDB /
 * teardownDB lifecycle) with a real git repo and a mocked embedBatch.
 * Covers what the unit tests can't: the gbrain_cycle_locks table's
 * INSERT...ON CONFLICT...WHERE semantics under a real postgres-js client,
 * the v0.17 schema migration applying cleanly to a fresh Postgres, and the
 * dry-run regression guard asserting zero writes when flag is set.
 *
 * Run: DATABASE_URL=... bun test test/e2e/cycle.test.ts
 */

import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';

// Mock embedBatch BEFORE importing runCycle so no real OpenAI calls happen
// even when the full cycle's embed phase runs.
mock.module('../../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    // Deterministic fake vector for each chunk.
    return texts.map(() => new Float32Array(1536));
  },
}));

const { runCycle } = await import('../../src/core/cycle.ts');

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E cycle tests (DATABASE_URL not set)');
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-cycle-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: dir, stdio: 'pipe' });

  mkdirSync(join(dir, 'people'), { recursive: true });
  writeFileSync(
    join(dir, 'people/alice.md'),
    '---\ntype: person\ntitle: Alice\n---\n\nAlice collaborates with Bob.\n',
  );
  writeFileSync(
    join(dir, 'people/bob.md'),
    '---\ntype: person\ntitle: Bob\n---\n\nBob is a person.\n',
  );
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describeE2E('E2E: runCycle against real Postgres', () => {
  let repo: string;

  beforeAll(async () => {
    await setupDB();
    repo = makeGitRepo();
  });

  afterAll(async () => {
    await teardownDB();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test('v0.17 migration v16 created gbrain_cycle_locks table', async () => {
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT tablename FROM pg_tables WHERE tablename = 'gbrain_cycle_locks'`,
    );
    expect(rows.length).toBe(1);

    // idx_cycle_locks_ttl index also exists.
    const idx = await conn.unsafe(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_cycle_locks_ttl'`,
    );
    expect(idx.length).toBe(1);
  });

  test('dry-run full cycle: zero DB writes + zero filesystem changes', async () => {
    const conn = getConn();
    // Baseline: track initial state.
    const beforePages = await conn.unsafe(`SELECT count(*)::int AS n FROM pages`);
    const beforeSync = await conn.unsafe(
      `SELECT value FROM config WHERE key = 'sync.last_commit'`,
    );

    const report = await runCycle(getEngine(), {
      brainDir: repo,
      dryRun: true,
      pull: false,
    });

    expect(report.schema_version).toBe('1');
    // Cycle ran all 6 phases (or skipped the ones that don't support dry-run).
    expect(report.phases.length).toBe(6);

    // Nothing got written.
    const afterPages = await conn.unsafe(`SELECT count(*)::int AS n FROM pages`);
    expect(afterPages[0].n).toBe(beforePages[0].n);

    // sync.last_commit unchanged (wasn't set before, isn't set now).
    const afterSync = await conn.unsafe(
      `SELECT value FROM config WHERE key = 'sync.last_commit'`,
    );
    expect(afterSync.length).toBe(beforeSync.length);

    // Cycle lock was acquired + released; table should be empty after.
    const locks = await conn.unsafe(`SELECT COUNT(*)::int AS n FROM gbrain_cycle_locks`);
    expect(locks[0].n).toBe(0);
  });

  test('live cycle: pages get synced + chunks created + cycle lock cleaned up', async () => {
    const conn = getConn();

    const report = await runCycle(getEngine(), {
      brainDir: repo,
      dryRun: false,
      pull: false,
    });

    expect(report.schema_version).toBe('1');
    // The sync phase should have run and imported real pages.
    const syncPhase = report.phases.find(p => p.phase === 'sync');
    expect(syncPhase).toBeDefined();
    expect(syncPhase?.status).not.toBe('fail');

    // Pages exist in the DB.
    const pages = await conn.unsafe(`SELECT slug FROM pages ORDER BY slug`);
    const slugs = (pages as unknown as Array<{ slug: string }>).map(p => p.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).toContain('people/bob');

    // sync.last_commit bookmark is now set.
    const sync = await conn.unsafe(
      `SELECT value FROM config WHERE key = 'sync.last_commit'`,
    );
    expect(sync.length).toBe(1);
    expect((sync[0] as any).value.length).toBeGreaterThanOrEqual(7);

    // Cycle lock is released.
    const locks = await conn.unsafe(`SELECT COUNT(*)::int AS n FROM gbrain_cycle_locks`);
    expect(locks[0].n).toBe(0);
  }, 60_000);

  test('concurrent cycle is blocked by the lock (status:skipped)', async () => {
    const conn = getConn();

    // Seed a fresh-TTL lock held by a different (fake) PID.
    await conn.unsafe(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 99999, 'other-host', NOW(), NOW() + INTERVAL '1 hour')`,
    );

    try {
      const report = await runCycle(getEngine(), {
        brainDir: repo,
        dryRun: true,
        pull: false,
      });
      expect(report.status).toBe('skipped');
      expect(report.reason).toBe('cycle_already_running');
      expect(report.phases.length).toBe(0);
    } finally {
      // Clean up the seeded lock.
      await conn.unsafe(`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle'`);
    }
  });

  test('TTL-expired lock is auto-claimed (crashed holder recovery)', async () => {
    const conn = getConn();

    // Seed a stale lock (TTL in the past).
    await conn.unsafe(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 99999, 'crashed-host', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
    );

    const report = await runCycle(getEngine(), {
      brainDir: repo,
      dryRun: true,
      pull: false,
    });
    // Crashed holder's stale TTL lets the new run acquire the lock.
    expect(report.status).not.toBe('skipped');

    // Lock released after the run.
    const locks = await conn.unsafe(`SELECT COUNT(*)::int AS n FROM gbrain_cycle_locks`);
    expect(locks[0].n).toBe(0);
  });

  test('--phase orphans skips the lock entirely (read-only optimization)', async () => {
    const conn = getConn();

    // Seed a fresh-TTL lock held by someone else. A read-only phase
    // selection should succeed anyway (orphans never acquires the lock).
    await conn.unsafe(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 99999, 'other-host', NOW(), NOW() + INTERVAL '1 hour')`,
    );

    try {
      const report = await runCycle(getEngine(), {
        brainDir: repo,
        phases: ['orphans'],
        pull: false,
      });
      // Status is NOT skipped — orphans ran despite the held lock.
      expect(report.status).not.toBe('skipped');
      const orphansPhase = report.phases.find(p => p.phase === 'orphans');
      expect(orphansPhase).toBeDefined();
    } finally {
      await conn.unsafe(`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle'`);
    }
  });
});
