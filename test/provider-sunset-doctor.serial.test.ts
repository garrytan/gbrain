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
import { ZEROENTROPY_SUNSET_DATE } from '../src/core/ai/defaults.ts';
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
    // The date must be stated plainly. (Consequence wording is pinned per
    // date-branch in the frozen-clock describe below — this test runs on the
    // real clock, so it only asserts date-independent structure.)
    expect(sunset!.message).toContain(ZEROENTROPY_SUNSET_DATE);
    // v0.46.3: paste-ready TARGET-AWARE migration commands — voyage at its valid
    // 1024 width (1280 is not a Voyage step) + the OpenAI keep-width
    // alternative carrying the brain's ACTUAL column width.
    expect(sunset!.message).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
    expect(sunset!.message).toContain('openai:text-embedding-3-small --dim 1280');
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
      // v0.46.3 target-aware hint: the OpenAI keep-width alternative carries the
      // ACTUAL width (640), never the drifted config value (1280); the voyage
      // headline is always at its valid 1024 step.
      expect(check.message).toContain('--dim 640');
      expect(check.message).not.toContain('--dim 1280');
    } finally {
      await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
      await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(1280)`);
    }
  });

  test('non-sunsetting provider (reranker disabled too) → ok', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    // The default (balanced) mode bundle reranks with a zeroentropyai model,
    // so being truly off the provider requires disabling the reranker too.
    await engine.setConfig('search.reranker.enabled', 'false');
    try {
      const check = await checkProviderSunset(engine);
      expect(check.status).toBe('ok');
    } finally {
      await engine.unsetConfig('search.reranker.enabled');
    }
  });

  test('reranker exposure resolves through the mode plane search actually reranks with', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    // NO gateway/config reranker configured at all — the default (balanced)
    // mode bundle still reranks with zeroentropyai:zerank-2. A gateway-plane
    // read here returns undefined and false-oks the exact post-embedding-
    // migration brains this check exists to protect.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    const check = await checkProviderSunset(engine);
    expect(FLAGGED).toContain(check.status);
    expect(check.message).toContain('zerank-2');
    expect(check.message).toContain('search.reranker');
    // Embeddings are safe — no migration command in this message.
    expect(check.message).not.toContain('migrate embeddings --to');

    // The documented fix — the search.reranker.enabled=false config
    // override — clears the exposure (mode plane honors config overrides).
    await engine.setConfig('search.reranker.enabled', 'false');
    try {
      const cleared = await checkProviderSunset(engine);
      expect(cleared.status).toBe('ok');
    } finally {
      await engine.unsetConfig('search.reranker.enabled');
    }
  });
});

describe('provider_sunset — date + exposure gating (frozen clock)', () => {
  const SUNSET = Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`);
  const PRE = SUNSET - 86_400_000;
  const POST = SUNSET + 86_400_000;
  const ZE_GATEWAY = {
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { OPENAI_API_KEY: 'sk-test-fake', ZEROENTROPY_API_KEY: 'ze-test-fake' },
  };

  test('post-date, zero embedded vectors → warn, NOT fail (doctor-as-CI-gate stays green)', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway(ZE_GATEWAY);
    // Blocker-1 repro: on the date, every stock-default brain — including
    // zero-vector fresh installs with no key — used to hard-fail and flip
    // doctor's exit code with no code change.
    const check = await checkProviderSunset(engine, POST);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('No embedded vectors');
  });

  test('post-date + embedded vectors on the dead provider → fail; pre-date → warn', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway(ZE_GATEWAY);
    const pageRows = await engine.executeRaw<{ id: string }>(
      `INSERT INTO pages (slug, type, title) VALUES ('sunset-exposure-probe', 'note', 'Sunset probe') RETURNING id`,
    );
    const vec = `[${Array(1280).fill(0).join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, 'probe', $2::vector)`,
      [pageRows[0].id, vec],
    );
    try {
      const past = await checkProviderSunset(engine, POST);
      expect(past.status).toBe('fail');
      expect(past.message).toContain('existing vectors');
      const before = await checkProviderSunset(engine, PRE);
      expect(before.status).toBe('warn');
    } finally {
      await engine.executeRaw(`DELETE FROM content_chunks WHERE page_id = $1`, [pageRows[0].id]);
      await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [pageRows[0].id]);
    }
  });

  test('doctor.suppress_provider_sunset silences the check', async () => {
    const { checkProviderSunset } = await import('../src/commands/doctor.ts');
    configureGateway(ZE_GATEWAY);
    await engine.setConfig('doctor.suppress_provider_sunset', 'true');
    try {
      const check = await checkProviderSunset(engine, POST);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('doctor.suppress_provider_sunset');
    } finally {
      await engine.unsetConfig('doctor.suppress_provider_sunset');
    }
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
