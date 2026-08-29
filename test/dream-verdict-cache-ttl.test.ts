/**
 * dream_verdicts TTL (#4069 reimplemented): every cached triage verdict gets
 * a 30-day expiry — reads treat expired rows as misses, re-judging refreshes
 * the expiry, and sweepDreamVerdicts garbage-collects expired rows.
 *
 * `triage_version`/`model` already invalidate rows SEMANTICALLY; the TTL is
 * the TEMPORAL bound: rows for deleted or re-hashed transcripts age out, and
 * long-lived transcripts re-judge at a 30-day cadence.
 *
 * PGLite-backed. The Postgres engine carries the identical predicates
 * (engine-parity iron rule); its triage path runs in
 * test/e2e/dream-triage-postgres.test.ts.
 *
 * Run: bun test test/dream-verdict-cache-ttl.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DREAM_VERDICT_TTL_SECONDS, type DreamVerdictInput } from '../src/core/engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM dream_verdicts');
});

/** Triage-v1-shaped verdict input (post-#4152 putDreamVerdict contract). */
function verdictInput(overrides: Partial<DreamVerdictInput> = {}): DreamVerdictInput {
  return {
    worth_processing: true,
    reasons: ['substantive strategy discussion'],
    score: 0.8,
    content_type: 'strategy',
    segments: [],
    entities: [],
    model: 'anthropic:claude-haiku-4-5-20251001',
    triage_version: TRIAGE_VERSION,
    ...overrides,
  };
}

describe('dream_verdicts TTL', () => {
  test('migration v143 adds a 30-day expiry column and index', async () => {
    // Train port: v138 in the source branch, renumbered to 142 on the
    // wave-k train (pass 1 had already appended v138-v141), then to 143 on
    // the master retarget (master consumed v142 for the takes-embedding
    // resize).
    const migration = MIGRATIONS.find(item => item.name === 'dream_verdicts_ttl');
    expect(migration?.version).toBe(143);
    expect(migration?.idempotent).toBe(true);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(143);

    const columns = await engine.executeRaw<{
      is_nullable: string;
      column_default: string | null;
    }>(`SELECT is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'dream_verdicts' AND column_name = 'expires_at'`);
    expect(columns).toHaveLength(1);
    expect(columns[0].is_nullable).toBe('NO');
    expect(columns[0].column_default).toContain('30 days');

    const indexes = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'dream_verdicts'
          AND indexname = 'dream_verdicts_expires_idx'`,
    );
    expect(indexes).toHaveLength(1);
  });

  test('put assigns the default TTL and get returns a fresh verdict', async () => {
    await engine.putDreamVerdict('/tmp/fresh.md', 'fresh-hash', verdictInput());

    const hit = await engine.getDreamVerdict('/tmp/fresh.md', 'fresh-hash');
    expect(hit?.worth_processing).toBe(true);
    expect(hit?.score).toBe(0.8);

    // Compare against the DATABASE clock — expiry is written and enforced
    // server-side, so client-clock skew must not enter the assertion.
    const rows = await engine.executeRaw<{ ttl_seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS ttl_seconds
         FROM dream_verdicts WHERE content_hash = 'fresh-hash'`,
    );
    expect(rows[0].ttl_seconds).toBeGreaterThan(DREAM_VERDICT_TTL_SECONDS - 60);
    expect(rows[0].ttl_seconds).toBeLessThanOrEqual(DREAM_VERDICT_TTL_SECONDS);
  });

  test('re-judging via upsert refreshes a nearly-expired row', async () => {
    await engine.putDreamVerdict('/tmp/rejudged.md', 'rejudged-hash', verdictInput());
    await engine.executeRaw(
      `UPDATE dream_verdicts SET expires_at = now() + interval '1 minute'
        WHERE content_hash = 'rejudged-hash'`,
    );

    await engine.putDreamVerdict('/tmp/rejudged.md', 'rejudged-hash', verdictInput({ score: 0.9 }));

    const rows = await engine.executeRaw<{ ttl_seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS ttl_seconds
         FROM dream_verdicts WHERE content_hash = 'rejudged-hash'`,
    );
    expect(rows[0].ttl_seconds).toBeGreaterThan(DREAM_VERDICT_TTL_SECONDS - 60);
    expect((await engine.getDreamVerdict('/tmp/rejudged.md', 'rejudged-hash'))?.score).toBe(0.9);
  });

  test('a NULL-expiry row (bootstrap window, pre-v143 backfill) reads as a hit and survives the sweep (#4657)', async () => {
    // Simulate the Postgres upgrade window: the forward-reference bootstrap
    // added expires_at nullable, but v143's backfill/NOT NULL haven't run
    // yet (e.g. a pooler-swallowed migration). A NULL row is a pre-TTL row:
    // a read miss here would silently re-judge the whole corpus with paid
    // LLM calls, and a sweep delete would drop a valid verdict. v143 stamps
    // NULL rows from judged_at when it eventually succeeds.
    await engine.executeRaw(`ALTER TABLE dream_verdicts ALTER COLUMN expires_at DROP NOT NULL`);
    try {
      await engine.putDreamVerdict('/tmp/window.md', 'window-hash', verdictInput({ score: 0.7 }));
      await engine.executeRaw(
        `UPDATE dream_verdicts SET expires_at = NULL WHERE content_hash = 'window-hash'`,
      );
      expect((await engine.getDreamVerdict('/tmp/window.md', 'window-hash'))?.score).toBe(0.7);
      expect(await engine.sweepDreamVerdicts()).toBe(0);
    } finally {
      await engine.executeRaw(
        `UPDATE dream_verdicts SET expires_at = now() + interval '30 days' WHERE expires_at IS NULL`,
      );
      await engine.executeRaw(`ALTER TABLE dream_verdicts ALTER COLUMN expires_at SET NOT NULL`);
    }
  });

  test('expired rows miss on read and sweep deletes only expired rows', async () => {
    await engine.putDreamVerdict('/tmp/expired.md', 'expired-hash', verdictInput({
      worth_processing: false,
      score: 0.1,
      reasons: ['legacy poison'],
    }));
    await engine.putDreamVerdict('/tmp/fresh.md', 'fresh-hash', verdictInput());
    await engine.executeRaw(
      `UPDATE dream_verdicts SET expires_at = now() - interval '1 second'
        WHERE content_hash = 'expired-hash'`,
    );

    expect(await engine.getDreamVerdict('/tmp/expired.md', 'expired-hash')).toBeNull();
    expect(await engine.getDreamVerdict('/tmp/fresh.md', 'fresh-hash')).not.toBeNull();
    expect(await engine.sweepDreamVerdicts()).toBe(1);

    const rows = await engine.executeRaw<{ content_hash: string }>(
      'SELECT content_hash FROM dream_verdicts ORDER BY content_hash',
    );
    expect(rows.map(row => row.content_hash)).toEqual(['fresh-hash']);
  });

  test('upgrade backfill derives expiry from judged_at and is idempotent', async () => {
    // Simulate a pre-v138 brain: no expires_at column, one boolean-era row
    // judged 45 days ago. The backfill must preserve the row's original age
    // (judged_at + 30 days = already expired) instead of granting legacy
    // rows a fresh 30-day lifetime.
    await engine.executeRaw('ALTER TABLE dream_verdicts DROP COLUMN expires_at');
    await engine.executeRaw(`
      INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons, judged_at)
      VALUES ('/tmp/legacy.md', 'legacy-hash', false, '[]'::jsonb, now() - interval '45 days')
    `);
    await engine.setConfig('version', '137');

    const first = await runMigrations(engine);
    expect(first.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getDreamVerdict('/tmp/legacy.md', 'legacy-hash')).toBeNull();
    expect(await engine.sweepDreamVerdicts()).toBe(1);
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 30_000);
});
