import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../src/core/db-lock.ts';
import { embedBackfillLockId } from '../src/core/embed-backfill-lock.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let savedHome: string | undefined;

beforeAll(async () => {
  savedHome = process.env.GBRAIN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-embed-lock-'));
  process.env.GBRAIN_HOME = tmpHome;
  // Gateway BEFORE initSchema — the schema sizes the embedding column from
  // the configured dims (same order as migrate-embeddings-flow.serial).
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1024,
    env: { OPENAI_API_KEY: 'sk-test-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: 1024 } as never);
  await engine.initSchema(); // content_chunks.embedding at the shipped-default 1024 width
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
  if (savedHome !== undefined) process.env.GBRAIN_HOME = savedHome;
  else delete process.env.GBRAIN_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('EmbedResult.lock_skipped — single-flight bail is observable', () => {
  test('a held per-source lock makes runEmbedCore report lock_skipped', async () => {
    // Dims match the column (1024) so the embed dim preflight passes; the
    // fake key satisfies the credential preflight (no embed call happens —
    // the lock bail fires before any work).
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1024,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
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
