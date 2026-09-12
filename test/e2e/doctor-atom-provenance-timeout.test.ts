/**
 * Real-Postgres coverage for atom_provenance_drift.
 *
 * This file must run only through the isolated E2E lane. It executes the real
 * aggregate at production-like row counts, proves timeout rollback on one
 * known backend, and proves a killed client cannot strand tagged SQL or an
 * open transaction beyond the database-side statement timeout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { computeAtomProvenanceDriftCheck } from '../../src/commands/doctor.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const describeE2E = hasDatabase() ? describe : describe.skip;
const TIMEOUT_QUERY_TAG = 'gbrain-doctor-atom-provenance-timeout-e2e';
const CHILD_QUERY_TAG = 'gbrain-doctor-atom-provenance-child-death-e2e';

interface BackendState {
  pid: number;
  state: string;
  xact_start: Date | string | null;
  query: string;
}

async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let value = await read();
  while (!done(value) && performance.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

async function readFirstJsonLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = performance.now() + timeoutMs;
  let text = '';
  try {
    while (!text.includes('\n')) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('timed out waiting for child readiness line');
      const part = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => { throw new Error('timed out waiting for child readiness line'); }),
      ]);
      if (part.done) throw new Error(`child stdout closed before readiness: ${text}`);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text.slice(0, text.indexOf('\n'))) as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

describeE2E('atom provenance Postgres performance and containment', () => {
  let observer: ReturnType<typeof postgres> | null = null;
  let engine: PostgresEngine | null = null;

  beforeAll(async () => {
    await setupDB();
    observer = postgres(DATABASE_URL, { max: 1, connect_timeout: 10 });
    engine = new PostgresEngine();
    // A one-connection pool makes every before/during/after PID assertion exact.
    await engine.connect({ database_url: DATABASE_URL, poolSize: 1 });
  }, 30_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (observer) await observer.end({ timeout: 2 });
    await teardownDB();
  });

  test('executes the optimized aggregate on 101k deterministic rows in under five seconds', async () => {
    // Exactly seven populated sources, 60k source pages, and 41k atom rows.
    await observer!.unsafe(
      `INSERT INTO sources (id, name)
       SELECT 'source-' || n, 'Synthetic source ' || n
         FROM generate_series(0, 6) AS n`,
    );
    await observer!.unsafe(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, frontmatter, content_hash, deleted_at)
       SELECT 'source-' || (n % 7),
              'pages/' || lpad(n::text, 6, '0'),
              'article',
              'Synthetic page ' || n,
              'deterministic fixture',
              '{}'::jsonb,
              CASE WHEN n >= 59300
                   THEN 'd' || (n % 7) || lpad(n::text, 30, '0')
                   ELSE 'l' || (n % 7) || lpad(floor(n / 14.0)::int::text, 30, '0')
               END,
              CASE WHEN n >= 59300 THEN TIMESTAMPTZ '2026-01-01T00:00:00Z' END
         FROM generate_series(0, 59999) AS n`,
    );
    // 30k resolved atoms. Every live hash is deliberately duplicated by a
    // second same-source page; DISTINCT must prevent aggregate fan-out.
    await observer!.unsafe(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, frontmatter, content_hash)
       SELECT p.source_id,
              'atoms/healthy/' || lpad(i::text, 6, '0'),
              'atom',
              'Healthy atom ' || i,
              'deterministic fixture',
              jsonb_build_object(
                'source_hash', substring(p.content_hash from 1 for 16),
                'source_slug', p.slug,
                'extracted_at', '2026-01-03T00:00:00.000Z'
              ),
              NULL
         FROM generate_series(0, 29999) AS i
         JOIN pages p
           ON p.source_id = 'source-' || (i % 7)
          AND p.slug = 'pages/' || lpad(((i % 7) + 7 * (floor(i / 7.0)::int % 8000))::text, 6, '0')`,
    );
    // 7k drifted atoms whose same-source slug remains live: source_changed.
    await observer!.unsafe(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, frontmatter, content_hash)
       SELECT p.source_id,
              'atoms/changed/' || lpad(i::text, 6, '0'),
              'atom',
              'Changed atom ' || i,
              'deterministic fixture',
              jsonb_build_object(
                'source_hash', 'y' || lpad(i::text, 15, '0'),
                'source_slug', p.slug,
                'extracted_at', '2020-01-02T00:00:00.000Z'
              ),
              NULL
         FROM generate_series(0, 6999) AS i
         JOIN pages p
           ON p.source_id = 'source-' || (i % 7)
          AND p.slug = 'pages/' || lpad(((i % 7) + 7 * (floor(i / 7.0)::int % 1000))::text, 6, '0')`,
    );
    // 2k hashes carried only by another source plus 2k hashes/slugs carried
    // only by deleted same-source pages: all must classify source_gone.
    await observer!.unsafe(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, frontmatter, content_hash)
       SELECT own_source,
              'atoms/gone-cross-source/' || lpad(i::text, 6, '0'),
              'atom',
              'Cross-source atom ' || i,
              'deterministic fixture',
              jsonb_build_object(
                'source_hash', substring(p.content_hash from 1 for 16),
                'source_slug', 'missing/cross-source/' || i,
                'extracted_at', '2020-01-01T00:00:00.000Z'
              ),
              NULL
         FROM generate_series(0, 1999) AS i
         CROSS JOIN LATERAL (SELECT 'source-' || (i % 7) AS own_source) own
         JOIN pages p
           ON p.source_id = 'source-' || ((i + 1) % 7)
          AND p.slug = 'pages/' || lpad((((i + 1) % 7) + 7 * (floor(i / 7.0)::int % 1000))::text, 6, '0')`,
    );
    await observer!.unsafe(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, frontmatter, content_hash)
       SELECT p.source_id,
              'atoms/gone-deleted/' || lpad(i::text, 6, '0'),
              'atom',
              'Deleted-source atom ' || i,
              'deterministic fixture',
              jsonb_build_object(
                'source_hash', substring(p.content_hash from 1 for 16),
                'source_slug', p.slug,
                'extracted_at', '2020-01-01T00:00:00.000Z'
              ),
              NULL
         FROM generate_series(0, 1999) AS i
         JOIN pages p
           ON p.source_id = 'source-' || (i % 7)
          AND p.slug = 'pages/' || lpad((59300 + ((i - 3) % 7 + 7) % 7 + 7 * (floor(i / 7.0)::int % 100))::text, 6, '0')`,
    );

    const fixture = await observer!.unsafe<Array<{ pages: number; atoms: number; sources: number }>>(
      `SELECT count(*)::int AS pages,
              count(*) FILTER (WHERE type = 'atom')::int AS atoms,
              count(DISTINCT source_id)::int AS sources
         FROM pages`,
    );
    expect(fixture[0]).toEqual({ pages: 101000, atoms: 41000, sources: 7 });

    let aggregateMs = Number.NaN;
    let aggregatePid: number | null = null;
    let aggregateTimeout: string | null = null;
    const instrumented = Object.create(engine!) as BrainEngine;
    instrumented.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
      engine!.transaction(async (tx) => {
        const measured = Object.create(tx) as BrainEngine;
        measured.executeRaw = async <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          opts?: { signal?: AbortSignal },
        ): Promise<R[]> => {
          if (!sql.includes('WITH atom AS')) return tx.executeRaw<R>(sql, params, opts);
          const state = await tx.executeRaw<{ pid: number; timeout: string }>(
            `SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout`,
          );
          aggregatePid = Number(state[0].pid);
          aggregateTimeout = state[0].timeout;
          const started = performance.now();
          try {
            return await tx.executeRaw<R>(sql, params, opts);
          } finally {
            aggregateMs = performance.now() - started;
          }
        };
        return fn(measured);
      });

    const result = await computeAtomProvenanceDriftCheck(instrumented);
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({
      total_atoms: 41000,
      drifted: 11000,
      source_changed: 7000,
      source_gone: 4000,
      drift_pct: 26.8,
    });
    expect(aggregatePid).not.toBeNull();
    expect(String(aggregateTimeout)).toBe('5s');
    expect(aggregateMs).toBeLessThan(5_000);
    console.log(JSON.stringify({
      aggregate: 'verified',
      fixture: fixture[0],
      expected: result.details,
      backend_pid: aggregatePid,
      timeout_during_aggregate: aggregateTimeout,
      aggregate_ms: Math.round(aggregateMs),
    }));
  }, 60_000);

  test('times out on one known backend, restores its session value, and leaves no open transaction', async () => {
    await engine!.executeRaw(`SET statement_timeout = '9s'`);
    const baseline = await engine!.executeRaw<{ pid: number; timeout: string }>(
      `SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout`,
    );
    const baselinePid = Number(baseline[0].pid);
    expect(baseline[0].timeout).toBe('9s');
    let backendPid: number | null = null;
    let timeoutDuringQuery: string | null = null;

    const slow = Object.create(engine!) as BrainEngine;
    slow.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
      engine!.transaction(async (tx) => {
        const instrumented = Object.create(tx) as BrainEngine;
        instrumented.executeRaw = async <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          opts?: { signal?: AbortSignal },
        ): Promise<R[]> => {
          if (sql.includes("set_config('statement_timeout'")) {
            return tx.executeRaw<R>(sql, params, opts);
          }
          const state = await tx.executeRaw<{ pid: number; timeout: string }>(
            `SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout`,
          );
          backendPid = Number(state[0].pid);
          timeoutDuringQuery = state[0].timeout;
          return tx.executeRaw<R>(`SELECT pg_sleep(15) /* ${TIMEOUT_QUERY_TAG} */`, [], opts);
        };
        return fn(instrumented);
      });

    const started = performance.now();
    const result = await computeAtomProvenanceDriftCheck(slow);
    const elapsedMs = performance.now() - started;

    expect(result.status).toBe('warn');
    expect(result.message).toContain('statement timeout');
    expect(elapsedMs).toBeLessThan(7_000);
    expect(Number(backendPid)).toBe(baselinePid);
    expect(String(timeoutDuringQuery)).toBe('5s');

    const backend = await observer!.unsafe<BackendState[]>(
      `SELECT pid, state, xact_start, query
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid!],
    );
    expect(backend).toHaveLength(1);
    expect(backend[0].state).toBe('idle');
    expect(backend[0].xact_start).toBeNull();
    expect(backend[0].state).not.toMatch(/^idle in transaction/);

    const reused = await engine!.executeRaw<{ pid: number; timeout: string; value: number }>(
      `SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout, 42::int AS value`,
    );
    expect(Number(reused[0].pid)).toBe(Number(backendPid));
    expect(reused[0].timeout).toBe('9s');
    expect(reused[0].value).toBe(42);
    console.log(JSON.stringify({
      containment: 'verified',
      baseline_backend_pid: baselinePid,
      timeout_backend_pid: backendPid,
      reuse_backend_pid: Number(reused[0].pid),
      elapsed_ms: Math.round(elapsedMs),
      timeout_during_query: timeoutDuringQuery,
      backend_state_after_timeout: backend[0].state,
      backend_xact_start_after_timeout: backend[0].xact_start,
      session_timeout_before: baseline[0].timeout,
      session_timeout_after: reused[0].timeout,
      connection_reuse_probe: reused[0].value,
    }));
  }, 15_000);

  test('a killed test child leaves no tagged active query or open transaction within a bounded deadline', async () => {
    const childScript = `
      import postgres from 'postgres';
      const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
      try {
        await sql.begin(async tx => {
          await tx.unsafe("SELECT set_config('statement_timeout', '5000ms', true)");
          const state = await tx.unsafe("SELECT pg_backend_pid()::int AS pid, current_setting('statement_timeout') AS timeout");
          console.log(JSON.stringify(state[0]));
          await tx.unsafe("SELECT pg_sleep(30) /* ${CHILD_QUERY_TAG} */");
        });
      } finally {
        await sql.end({ timeout: 1 });
      }
    `;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', childScript], {
      cwd: import.meta.dir + '/../..',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GBRAIN_HOME: process.env.GBRAIN_HOME ?? '',
        DATABASE_URL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let childPid: number | null = null;
    let childTimeout: string | null = null;
    let activeSeen = false;
    let finalBackend: BackendState[] = [];
    const killStarted = performance.now();
    try {
      const ready = await readFirstJsonLine(child.stdout, 5_000);
      childPid = Number(ready.pid);
      childTimeout = String(ready.timeout);
      expect(childPid).toBeGreaterThan(0);
      expect(childTimeout).toBe('5s');

      const active = await pollUntil(
        () => observer!.unsafe<BackendState[]>(
          `SELECT pid, state, xact_start, query
             FROM pg_stat_activity
            WHERE pid = $1 AND state = 'active' AND query LIKE $2`,
          [childPid!, `%${CHILD_QUERY_TAG}%`],
        ),
        rows => rows.length === 1,
        3_000,
      );
      expect(active).toHaveLength(1);
      activeSeen = true;

      // Kill only the child process created above; never signal a database PID.
      child.kill('SIGKILL');
      await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => { throw new Error('test child did not exit after SIGKILL'); }),
      ]);

      finalBackend = await pollUntil(
        () => observer!.unsafe<BackendState[]>(
          `SELECT pid, state, xact_start, query FROM pg_stat_activity WHERE pid = $1`,
          [childPid!],
        ),
        rows => rows.length === 0 || (
          rows[0].state !== 'active'
          && !rows[0].state.startsWith('idle in transaction')
          && rows[0].xact_start === null
        ),
        7_000,
      );
      expect(finalBackend.length === 0 || (
        finalBackend[0].state !== 'active'
        && !finalBackend[0].state.startsWith('idle in transaction')
        && finalBackend[0].xact_start === null
      )).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    console.log(JSON.stringify({
      child_death_containment: 'verified',
      test_child_process_pid: child.pid,
      database_backend_pid: childPid,
      timeout_before_dispatch: childTimeout,
      tagged_query_observed_active: activeSeen,
      cleanup_deadline_ms: 7000,
      cleanup_elapsed_ms: Math.round(performance.now() - killStarted),
      backend_present_after_cleanup: finalBackend.length > 0,
      backend_state_after_cleanup: finalBackend[0]?.state ?? null,
      backend_xact_start_after_cleanup: finalBackend[0]?.xact_start ?? null,
    }));
  }, 20_000);
});
