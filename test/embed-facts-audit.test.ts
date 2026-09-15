/**
 * Coverage audit for #4812 / #4867 (`gbrain embed --stale --facts`): the
 * branches test/embed-facts.test.ts leaves open.
 *
 *   - isKeylessStaleRefusal must NOT swallow a --facts run (the modified
 *     predicate; a keyless brain gets the loud EmbeddingDisabledError, not a
 *     silent exit 0 that does nothing).
 *   - runEmbed's --facts branch refuses `--facts` without `--stale` and
 *     `--facts --background` with a usage line + exit 1, before any DB work.
 *   - runEmbed --stale --facts --dry-run --json is keyless-safe (no creds
 *     preflight), prints the EmbedFactsResult and maps it onto EmbedResult.
 *   - `--source` / `--batch-size` fail closed (missing, flag-like, inline `=`
 *     form, malformed or unknown source, non-positive batch, batch above the
 *     500 cap) with exit 1 BEFORE the creds preflight; chunk-only flags
 *     (--pace, --slugs, --all, ...) are refused with the usage line; the
 *     summary names the scope; a facts.embedding width that differs from the
 *     configured width exits 1 before the lock and before any provider call.
 *   - Single-flight on EMBED_FACTS_BACKFILL_LOCK_ID: a held lock is
 *     lock_skipped + exit 0 (cron-friendly); the heartbeat aborts the drain
 *     as lock_lost when the lock is stolen; a lock-subsystem error and a
 *     width-probe error both fail OPEN (the drain runs).
 *   - Progress: `embed.facts` starts before the first provider call.
 *   - A keyless (embedding_disabled) brain rejects a live run with
 *     EmbeddingDisabledError rather than exiting 0.
 *   - embedStaleFacts loop edges: pre-aborted signal, batchSize clamp,
 *     failure_samples cap, onProgress arguments, NaN vector rejected.
 *
 * Hermetic: injected embedFn, PGLite, no provider keys required.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { runEmbed, isKeylessStaleRefusal } from '../src/commands/embed.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { EMBED_FACTS_BACKFILL_LOCK_ID } from '../src/core/embed-backfill-lock.ts';
import { __setEmbedTransportForTests, configureGateway } from '../src/core/ai/gateway.ts';
import { setCliOptions, _resetCliOptionsForTest, DEFAULT_CLI_OPTIONS } from '../src/core/cli-options.ts';
import { EmbeddingDisabledError } from '../src/core/embedding-dim-check.ts';
import { configPath } from '../src/core/config.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

let engine: PGLiteEngine;
let dims = 1536;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dims = Number(await engine.getConfig('embedding_dimensions')) || 1536;
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedStaleFacts(count: number, sourceId = 'default'): Promise<number[]> {
  const res = await engine.insertFacts(
    Array.from({ length: count }, (_, i) => ({
      fact: `seeded fact ${i}`,
      kind: 'fact' as const,
      source: 'test',
      row_num: i + 1,
      source_markdown_slug: 'people/alice-example',
    })),
    { source_id: sourceId },
  );
  return res.ids;
}

function exitCode(run: { thrown?: unknown }): string {
  return String((run.thrown as Error)?.message);
}

/** The preload's OpenAI/1536 pin, with an optional env overlay (a fake key lets the stub transport be reached) and dims override. */
function pinGateway(env: Record<string, string> = {}, embeddingDims: number = LEGACY_EMBEDDING_CONFIG.embedding_dimensions): void {
  configureGateway({
    embedding_model: LEGACY_EMBEDDING_CONFIG.embedding_model,
    embedding_dimensions: embeddingDims,
    env: { ...process.env, ...env },
  });
}

/** Stub the gateway's embed transport; returns the recorded input batches. */
function stubEmbedTransport(): string[][] {
  const calls: string[][] = [];
  __setEmbedTransportForTests((async (params: { values: string[] }) => {
    calls.push([...params.values]);
    return {
      embeddings: params.values.map((v) => Array.from(new Float32Array(dims).fill(0).map((_, i) => (i === 0 ? v.length : i === 1 ? 1 : 0)))),
      values: params.values,
      warnings: [],
      usage: { tokens: params.values.length },
    };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  return calls;
}

function fakeEmbedFn(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(texts.map((t) => {
    const v = new Float32Array(dims);
    v[0] = t.length;
    v[1] = 1;
    return v;
  }));
}

async function pendingCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE embedding IS NULL AND expired_at IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Embed transport stub whose behaviour per call is injected; returns the recorded input batches. */
function stubEmbedTransportWith(onCall: (call: number) => Promise<void>): string[][] {
  const calls: string[][] = [];
  __setEmbedTransportForTests((async (params: { values: string[] }) => {
    calls.push([...params.values]);
    await onCall(calls.length);
    return {
      embeddings: params.values.map((v) => Array.from(new Float32Array(dims).fill(0).map((_, i) => (i === 0 ? v.length : i === 1 ? 1 : 0)))),
      values: params.values,
      warnings: [],
      usage: { tokens: params.values.length },
    };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  return calls;
}

/** The real engine with `executeRaw` rejecting for SQL matching `failing` (the facts width probe). */
function withFailingExecuteRaw(real: PGLiteEngine, failing: RegExp): BrainEngine {
  return new Proxy(real, {
    get(t, p) {
      if (p === 'executeRaw') {
        return (sql: string, ...rest: unknown[]) => failing.test(sql)
          ? Promise.reject(new Error('probe unavailable'))
          : (t.executeRaw as (...a: unknown[]) => Promise<unknown>).call(t, sql, ...rest);
      }
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as BrainEngine;
}

/** The real engine whose lock table is unreachable (tryAcquireDbLock goes through `engine.db.query` on PGLite). */
function withLockTableDown(real: PGLiteEngine): BrainEngine {
  const realDb = (real as unknown as { db: { query: (sql: string, params?: unknown[]) => Promise<unknown> } }).db;
  const fakeDb = new Proxy(realDb, {
    get(t, p) {
      if (p === 'query') {
        return (sql: string, params?: unknown[]) => /gbrain_cycle_locks/.test(sql)
          ? Promise.reject(new Error('lock table unavailable'))
          : t.query(sql, params);
      }
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return new Proxy(real, {
    get(t, p) {
      if (p === 'db') return fakeDb;
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as BrainEngine;
}

async function lockRowCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM gbrain_cycle_locks WHERE id = $1`, [EMBED_FACTS_BACKFILL_LOCK_ID],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Run fn with process.exit throwing `__exit__<code>` and console.error/log captured. */
async function withCliCapture<T>(fn: () => Promise<T>): Promise<{ result?: T; thrown?: unknown; stderr: string[]; stdout: string[] }> {
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  const stderr: string[] = [];
  const stdout: string[] = [];
  process.exit = ((code?: number) => { throw new Error(`__exit__${code}`); }) as typeof process.exit;
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), stderr, stdout };
  } catch (thrown) {
    return { thrown, stderr, stdout };
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
}

describe('isKeylessStaleRefusal with --facts', () => {
  test('a --stale --facts run is never the silent keyless exit-0 refusal', () => {
    expect(isKeylessStaleRefusal(['--stale', '--facts'], true)).toBe(false);
    expect(isKeylessStaleRefusal(['--facts', '--stale', '--source', 'wiki'], true)).toBe(false);
    // The guard still fires for the documented chain spelling without --facts.
    expect(isKeylessStaleRefusal(['--stale', '--source', 'wiki'], true)).toBe(true);
  });
});

describe('runEmbed --facts CLI branch', () => {
  test('--facts without --stale, and --facts --background, exit 1 with usage before any DB work', async () => {
    await seedStaleFacts(1);
    for (const args of [['--facts'], ['--stale', '--facts', '--background']]) {
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(String((run.thrown as Error)?.message), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n')).toContain('Usage: gbrain embed --stale --facts');
      expect(run.stdout).toEqual([]);
    }
    expect(await pendingCount()).toBe(1);
  });

  test('--stale --facts --dry-run --json is keyless-safe, prints the facts result and maps it onto EmbedResult', async () => {
    await seedStaleFacts(3);
    // Inline `--batch-size=5` is accepted alongside the two-token form.
    const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--dry-run', '--json', '--batch-size=5']));
    expect(run.thrown).toBeUndefined();
    expect(run.stderr).toEqual([]);
    expect(run.stdout.length).toBe(1);
    expect(JSON.parse(run.stdout[0])).toEqual({
      total_stale: 3, embedded: 0, would_embed: 3, failures: 0, failure_samples: [], dryRun: true,
    });
    expect(run.result).toEqual({
      embedded: 0, skipped: 0, would_embed: 3, total_chunks: 3, pages_processed: 0,
      failures: 0, failure_samples: [], dryRun: true, chunkless_pages_healed: 0,
    });
    expect(await pendingCount()).toBe(3);
  });

  test('--source fails closed on a missing, flag-like, or empty inline value — exit 1 before the creds preflight', async () => {
    await seedStaleFacts(1);
    for (const args of [
      ['--stale', '--facts', '--source'],
      ['--stale', '--facts', '--source', '--json'],
      ['--stale', '--facts', '--source='],
    ]) {
      // Deliberately NOT a dry run: on this keyless brain the creds preflight
      // would throw (not exit 1) if the flag check came after it.
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(exitCode(run), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n'), args.join(' ')).toContain('--source requires a value');
      expect(run.stdout).toEqual([]);
    }
    expect(await pendingCount()).toBe(1);
  });

  test('--source rejects a malformed id and an unknown (unregistered) source with exit 1', async () => {
    await seedStaleFacts(1);
    const malformed = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--source', 'Not_Valid']));
    expect(exitCode(malformed)).toBe('__exit__1');
    expect(malformed.stderr.join('\n')).toContain('Invalid source_id');
    const unknown = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--source', 'bogus-id']));
    expect(exitCode(unknown)).toBe('__exit__1');
    expect(unknown.stderr.join('\n')).toContain('source "bogus-id" does not exist');
    expect(await pendingCount()).toBe(1);
  });

  test('--source=<id> inline form scopes the drain and the summary names the scope', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other')`);
    await seedStaleFacts(2);
    await seedStaleFacts(3, 'other');
    const scoped = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--dry-run', '--json', '--source=other']));
    expect(scoped.thrown).toBeUndefined();
    expect(JSON.parse(scoped.stdout[0])).toMatchObject({ total_stale: 3, would_embed: 3 });
    const human = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--dry-run', '--source', 'other']));
    expect(human.stdout.join('\n')).toContain('Would embed 3 active fact(s) (source "other")');
    const all = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--dry-run']));
    expect(all.stdout.join('\n')).toContain('Would embed 5 active fact(s) (all sources)');
    expect(await pendingCount()).toBe(5);
  });

  test('--batch-size rejects 0, non-numeric, negative inline, and a missing value with exit 1 before any provider call', async () => {
    await seedStaleFacts(1);
    const cases: Array<[string[], string]> = [
      [['--stale', '--facts', '--batch-size', '0'], '0'],
      [['--stale', '--facts', '--batch-size', 'abc'], 'abc'],
      [['--stale', '--facts', '--batch-size=-3'], '-3'],
      [['--stale', '--facts', '--batch-size'], ''],
      // parseInt would have read these as 5 and 1.
      [['--stale', '--facts', '--batch-size', '5abc'], '5abc'],
      [['--stale', '--facts', '--batch-size', '1e3'], '1e3'],
    ];
    for (const [args, raw] of cases) {
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(exitCode(run), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n'), args.join(' ')).toContain(`Invalid --batch-size "${raw}". Expected a positive integer.`);
    }
    expect(await pendingCount()).toBe(1);
  });

  test('single-flight: a held facts lock skips the run (lock_skipped, exit 0) with no provider call; once released the drain runs and releases it again', async () => {
    await seedStaleFacts(2);
    const calls = stubEmbedTransport();
    // Keyless run: the fake key only satisfies the gateway's provider-key check
    // so the call reaches the stub; GBRAIN_HOME is already scoped by the preload.
    pinGateway({ OPENAI_API_KEY: 'sk-fake' });
    const held = await tryAcquireDbLock(engine, EMBED_FACTS_BACKFILL_LOCK_ID, 60);
    expect(held).not.toBeNull();
    try {
      const refused = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts']));
      expect(refused.thrown).toBeUndefined();
      expect(refused.result).toMatchObject({ lock_skipped: true, embedded: 0, failures: 0, total_chunks: 0, dryRun: false });
      expect(refused.stderr.join('\n')).toContain('another facts backfill is already running (all sources)');
      expect(refused.stdout).toEqual([]);
      // --json under contention still prints one parseable object.
      const refusedJson = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--json']));
      expect(refusedJson.thrown).toBeUndefined();
      expect(refusedJson.stdout.length).toBe(1);
      expect(JSON.parse(refusedJson.stdout[0])).toEqual({
        total_stale: 0, embedded: 0, would_embed: 0, failures: 0, failure_samples: [], dryRun: false, lock_skipped: true,
      });
      expect(calls).toEqual([]);
      expect(await pendingCount()).toBe(2);

      await held!.release();
      const ok = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--batch-size', '1']));
      expect(ok.thrown).toBeUndefined();
      expect(ok.result).toMatchObject({ embedded: 2, failures: 0, total_chunks: 2, dryRun: false });
      expect(ok.stdout.join('\n')).toContain('Embedded 2 fact(s) (all sources); 0 remain stale.');
      expect(calls.length).toBe(2);
      expect(await pendingCount()).toBe(0);
      // Released in finally: the key is free again immediately.
      const again = await tryAcquireDbLock(engine, EMBED_FACTS_BACKFILL_LOCK_ID, 60);
      expect(again).not.toBeNull();
      await again!.release();
    } finally {
      __setEmbedTransportForTests(null);
      pinGateway();
    }
  });

  test('--batch-size above the 500 cap exits 1 naming the cap, before any provider call', async () => {
    await seedStaleFacts(1);
    const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--batch-size', '2000']));
    expect(exitCode(run)).toBe('__exit__1');
    expect(run.stderr.join('\n')).toContain('Invalid --batch-size "2000". The facts drain sends at most 500 facts');
    expect(await pendingCount()).toBe(1);
  });

  test('chunk-only flags are refused with the usage line, not silently ignored', async () => {
    await seedStaleFacts(1);
    for (const extra of [['--pace'], ['--pace=gentle'], ['--pace-max-concurrency', '4'], ['--slugs', 'a'], ['--all'], ['--priority', 'recent'], ['--catch-up'], ['--include-null-signature'], ['--no-embed']]) {
      const args = ['--stale', '--facts', '--dry-run', ...extra];
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(exitCode(run), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n'), args.join(' ')).toContain('Usage: gbrain embed --stale --facts');
      expect(run.stdout).toEqual([]);
    }
    expect(await pendingCount()).toBe(1);
  });

  test('heartbeat: a lock stolen mid-drain aborts the drain as lock_lost with the rows left NULL', async () => {
    await seedStaleFacts(3);
    // Call 1 yanks the lock row out from under the drain, then idles long
    // enough for the 5ms heartbeat to see the fenced refresh match 0 rows.
    const calls = stubEmbedTransportWith(async (call) => {
      if (call !== 1) return;
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [EMBED_FACTS_BACKFILL_LOCK_ID]);
      await new Promise((r) => setTimeout(r, 150));
    });
    pinGateway({ OPENAI_API_KEY: 'sk-fake' });
    try {
      const run = await withEnv({ GBRAIN_EMBED_LOCK_HEARTBEAT_MS: '5' }, () =>
        withCliCapture(() => runEmbed(engine, ['--stale', '--facts', '--batch-size', '1', '--json'])));
      expect(run.thrown).toBeUndefined();
      expect(run.result).toMatchObject({ lock_lost: true, failures: 0, total_chunks: 3 });
      expect(run.stderr.join('\n')).toContain('single-flight lock was stolen or released mid-run');
      // The printed JSON carries the abort too.
      expect(run.stdout.length).toBe(1);
      expect(JSON.parse(run.stdout[0])).toMatchObject({ lock_lost: true, total_stale: 3, failures: 0 });
      // The drain stopped at the lost lock: one provider call, not three.
      expect(calls.length).toBe(1);
      expect(await pendingCount()).toBeGreaterThanOrEqual(2);
    } finally {
      __setEmbedTransportForTests(null);
      pinGateway();
    }
  });

  test('progress: the embed.facts start event is on stderr before the first provider call', async () => {
    await seedStaleFacts(2);
    const chunks: string[] = [];
    let startSeenAtFirstCall: boolean | undefined;
    const calls = stubEmbedTransportWith(async (call) => {
      if (call === 1) startSeenAtFirstCall = chunks.some((c) => c.includes('"event":"start"') && c.includes('"phase":"embed.facts"'));
    });
    pinGateway({ OPENAI_API_KEY: 'sk-fake' });
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, progressJson: true });
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      const cb = rest.find((r) => typeof r === 'function') as ((err?: Error) => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stderr.write;
    try {
      const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts']));
      expect(run.thrown).toBeUndefined();
      expect(run.result).toMatchObject({ embedded: 2, failures: 0 });
      expect(calls.length).toBe(1);
      expect(startSeenAtFirstCall).toBe(true);
      const start = chunks.map((c) => c.trim()).filter((c) => c.includes('"event":"start"')).map((c) => JSON.parse(c) as { total?: number });
      expect(start).toHaveLength(1);
      expect(start[0].total).toBe(2);
    } finally {
      process.stderr.write = origWrite;
      _resetCliOptionsForTest();
      __setEmbedTransportForTests(null);
      pinGateway();
    }
  });

  test('fail-open: a throwing width probe and a throwing lock acquire both let the drain run', async () => {
    pinGateway({ OPENAI_API_KEY: 'sk-fake' });
    try {
      // Width probe unreadable → drift check falls open; the lock still works.
      await seedStaleFacts(2);
      let calls = stubEmbedTransportWith(async () => {});
      const probeDown = await withCliCapture(() => runEmbed(withFailingExecuteRaw(engine, /information_schema\.columns/), ['--stale', '--facts']));
      expect(probeDown.thrown).toBeUndefined();
      expect(probeDown.result).toMatchObject({ embedded: 2, failures: 0 });
      expect(calls.length).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(await lockRowCount()).toBe(0);

      // Lock table unreachable → single-flight is dropped for this run; the drain proceeds unlocked.
      await resetPgliteState(engine);
      await seedStaleFacts(2);
      calls = stubEmbedTransportWith(async () => {});
      const lockDown = await withCliCapture(() => runEmbed(withLockTableDown(engine), ['--stale', '--facts']));
      expect(lockDown.thrown).toBeUndefined();
      expect(lockDown.result).toMatchObject({ embedded: 2, failures: 0 });
      expect(lockDown.result?.lock_skipped).toBeUndefined();
      expect(lockDown.stderr.join('\n')).not.toContain('another facts backfill');
      expect(calls.length).toBe(1);
      expect(await pendingCount()).toBe(0);
    } finally {
      __setEmbedTransportForTests(null);
      pinGateway();
    }
  });

  test('keyless brain (embedding_disabled): a live run rejects with EmbeddingDisabledError, never a silent exit 0', async () => {
    await seedStaleFacts(1);
    const path = configPath();
    const prior = existsSync(path) ? readFileSync(path, 'utf-8') : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    try {
      const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts']));
      expect(run.thrown).toBeInstanceOf(EmbeddingDisabledError);
      expect(run.stdout).toEqual([]);
      expect(await pendingCount()).toBe(1);
    } finally {
      if (prior === null) unlinkSync(path); else writeFileSync(path, prior);
    }
  });

  test('facts.embedding width != configured width exits 1 before the lock and before any provider call', async () => {
    await seedStaleFacts(1);
    const calls = stubEmbedTransport();
    // Column is the preload's 1536; configure the gateway for 1280-d vectors.
    pinGateway({ OPENAI_API_KEY: 'sk-fake' }, 1280);
    try {
      const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--facts']));
      expect(exitCode(run)).toBe('__exit__1');
      const line = run.stderr.join('\n');
      expect(line).toMatch(new RegExp(`facts\\.embedding is (halfvec|vector)\\(${dims}\\)`));
      expect(line).toContain('produces 1280-d vectors');
      expect(line).toContain('gbrain doctor');
      expect(line).toContain('gbrain migrate embeddings');
      expect(calls).toEqual([]);
      expect(await pendingCount()).toBe(1);
      // Refused BEFORE the lock: the key is still free.
      const free = await tryAcquireDbLock(engine, EMBED_FACTS_BACKFILL_LOCK_ID, 60);
      expect(free).not.toBeNull();
      await free!.release();
    } finally {
      __setEmbedTransportForTests(null);
      pinGateway();
    }
  });
});

describe('embedStaleFacts loop edges', () => {
  test('pre-aborted signal, batchSize clamp, failure_samples cap, onProgress args, NaN vector', async () => {
    const ids = await seedStaleFacts(11);
    const progress: Array<[number, number, number]> = [];
    const onProgress = (done: number, total: number, embedded: number) => { progress.push([done, total, embedded]); };

    // dry-run early return still reports progress once.
    await embedStaleFacts(engine, { dryRun: true, embedFn: fakeEmbedFn, onProgress });
    expect(progress).toEqual([[0, 11, 0], [11, 11, 0]]);

    // Already-aborted signal breaks before selecting or embedding anything.
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const aborted = await embedStaleFacts(engine, {
      signal: ac.signal,
      embedFn: async (texts) => { calls += 1; return fakeEmbedFn(texts); },
    });
    expect(calls).toBe(0);
    expect(aborted).toMatchObject({ total_stale: 11, embedded: 0, failures: 0 });
    expect(await pendingCount()).toBe(11);

    // batchSize 0 clamps to 1; a provider that always throws counts every
    // fact as failed but keeps at most 10 samples; progress reaches total.
    progress.length = 0;
    const sizes: number[] = [];
    const failing = await embedStaleFacts(engine, {
      batchSize: 0,
      onProgress,
      embedFn: async (texts) => { sizes.push(texts.length); throw new Error(`boom ${sizes.length}`); },
    });
    expect(sizes).toEqual(Array(11).fill(1));
    expect(failing.failures).toBe(11);
    expect(failing.embedded).toBe(0);
    expect(failing.failure_samples.length).toBe(10);
    expect(failing.failure_samples[0]).toBe('boom 1');
    expect(progress.at(-1)).toEqual([11, 11, 0]);
    expect(await pendingCount()).toBe(11);

    // batchSize 2.7 floors to 2; progress never exceeds total and ends at
    // (total, total, embedded).
    progress.length = 0;
    sizes.length = 0;
    const ok = await embedStaleFacts(engine, {
      batchSize: 2.7,
      onProgress,
      embedFn: async (texts) => { sizes.push(texts.length); return fakeEmbedFn(texts); },
    });
    expect(sizes).toEqual([2, 2, 2, 2, 2, 1]);
    expect(ok.embedded).toBe(11);
    expect(ok.failures).toBe(0);
    expect(progress.map(([d]) => d)).toEqual([0, 2, 4, 6, 8, 10, 11]);
    expect(progress.every(([d, t]) => d <= t)).toBe(true);
    expect(progress.at(-1)).toEqual([11, 11, 11]);
    expect(await pendingCount()).toBe(0);

    // A non-finite vector is rejected before any SQL runs.
    await expect(engine.updateFactEmbeddings([{ fact_id: ids[0], embedding: Float32Array.of(NaN, 1) }]))
      .rejects.toThrow(/invalid embedding/);
    await expect(engine.updateFactEmbeddings([{ fact_id: 1.5, embedding: Float32Array.of(1) }]))
      .rejects.toThrow(/invalid fact_id/);
  });
});
