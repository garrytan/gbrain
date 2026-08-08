/**
 * provider_sunset doctor check + embed lock-skip visibility (#3390 follow-up).
 *
 * A brain whose effective embedding model is on a provider with an announced
 * hosted-API shutdown must be flagged on EVERY `gbrain doctor` run (the
 * upgrade banner is one-shot), with a paste-ready `gbrain migrate embeddings`
 * command whose `--dim` is the brain's ACTUAL column width — not the config
 * value, which can drift. Getting `--dim` wrong forces a needless dimension
 * transition + index rebuild.
 *
 * Also pins `EmbedResult.lock_skipped`: a single-flight embed run that did no
 * work because another backfill holds the per-source lock says so, instead of
 * letting `migrate embeddings` misreport "embed failures — re-run to resume"
 * (a hard-killed run leaves its lock behind for up to the lock TTL, so the
 * immediate re-run would no-op).
 *
 * The first test goes through the `buildChecks` orchestrator (exists on
 * master) so the assertion is behavioral: master's doctor simply never
 * surfaces the sunset, and the test fails on the missing check — not on a
 * missing export.
 *
 * `.serial.test.ts`: configures the process-global gateway + GBRAIN_HOME for
 * its whole lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../src/core/db-lock.ts';
import { embedBackfillLockId } from '../src/core/embed-backfill-lock.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let savedHome: string | undefined;

beforeAll(async () => {
  savedHome = process.env.GBRAIN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-sunset-'));
  process.env.GBRAIN_HOME = tmpHome;
  // Gateway BEFORE initSchema — the schema sizes the embedding column from
  // the configured dims (same order as migrate-embeddings-flow.serial).
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: 1280 } as never);
  await engine.initSchema(); // content_chunks.embedding at the shipped-default 1280 width
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
  if (savedHome !== undefined) process.env.GBRAIN_HOME = savedHome;
  else delete process.env.GBRAIN_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** The check may legitimately be warn (pre-date) or fail (post-date). */
const FLAGGED = ['warn', 'fail'];

describe('provider_sunset — doctor flags brains pinned to a sunsetting provider', () => {
  test('buildChecks surfaces the sunset for a zembed-1 brain, with the actual --dim filled in', async () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    const checks = await buildChecks(engine, []);
    const sunset = checks.find((c) => c.name === 'provider_sunset');
    expect(sunset, 'doctor never surfaced the provider sunset').toBeDefined();
    expect(FLAGGED).toContain(sunset!.status);
    // The date and BOTH consequences must be stated plainly.
    expect(sunset!.message).toContain('2026-09-04');
    expect(sunset!.message.toLowerCase()).toContain('existing vectors');
    // Paste-ready migration command with the brain's ACTUAL column width.
    expect(sunset!.message).toContain('gbrain migrate embeddings --to <provider:model> --dim 1280');
    // The self-host escape hatch gets equal billing (no migration at all).
    expect(sunset!.message).toContain('Apache-2.0');
  });

  test('the ACTUAL column width wins over drifted config', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    // Simulate config/schema drift: column rebuilt at 640, config still 1280.
    await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
    await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(640)`);
    try {
      configureGateway({
        embedding_model: 'zeroentropyai:zembed-1',
        embedding_dimensions: 1280,
        env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
      });
      const check = await checkProviderSunset(engine);
      expect(FLAGGED).toContain(check.status);
      expect(check.message).toContain('--dim 640');
      expect(check.message).not.toContain('--dim 1280');
    } finally {
      await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
      await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(1280)`);
    }
  });

  test('non-sunsetting provider → ok', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    const check = await checkProviderSunset(engine);
    expect(check.status).toBe('ok');
  });

  test('reranker on the sunsetting provider is flagged even when embeddings are elsewhere', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      reranker_model: 'zeroentropyai:zerank-2',
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    const check = await checkProviderSunset(engine);
    expect(FLAGGED).toContain(check.status);
    expect(check.message).toContain('zerank-2');
    expect(check.message).toContain('search.reranker');
    // Embeddings are safe — no migration command in this message.
    expect(check.message).not.toContain('migrate embeddings');
  });
});

describe('EmbedResult.lock_skipped — single-flight bail is observable', () => {
  test('a held per-source lock makes runEmbedCore report lock_skipped', async () => {
    // Dims match the column (1280) so the embed dim preflight passes; the
    // fake key satisfies the credential preflight (no embed call happens —
    // the lock bail fires before any work).
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1280,
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    const sources = await engine.listAllSources();
    const ids = sources.length > 0 ? sources.map((s) => s.id) : ['default'];
    const locks: DbLockHandle[] = [];
    for (const sid of ids) {
      const lock = await tryAcquireDbLock(engine, embedBackfillLockId(sid), 60);
      expect(lock).not.toBeNull();
      locks.push(lock!);
    }
    try {
      const result = await runEmbedCore(engine, { stale: true, singleFlight: true, quiet: true });
      expect(result.embedded).toBe(0);
      // Behavioral pin: master returns the same zero-work result WITHOUT the
      // flag, so `migrate embeddings` can't tell "lock held" from "embed
      // failures" and prints a resume hint that a re-run cannot honor.
      expect(result.lock_skipped).toBe(true);
    } finally {
      for (const l of locks) await l.release();
    }
  });

  test('no lock contention → lock_skipped is not set', async () => {
    const result = await runEmbedCore(engine, { stale: true, singleFlight: true, quiet: true });
    expect(result.lock_skipped).toBeFalsy();
  });
});
