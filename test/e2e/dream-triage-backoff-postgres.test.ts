/**
 * #6069 on real Postgres: the unreliable-verdict backoff marker round-trips
 * through postgres.js (score NULL, reasons JSONB) and holds off the next
 * judge call, the same as on PGLite (test/synthesize-triage-backoff.test.ts).
 *
 * Run: DATABASE_URL=... bun test test/e2e/dream-triage-backoff-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { runTriagePass, isTriageCacheValid, TRIAGE_VERSION, type JudgeClient } from '../../src/core/cycle/synthesize.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const MODEL = 'anthropic:claude-haiku-4-5-20251001';

describeE2E('E2E: triage backoff marker on Postgres (#6069)', () => {
  beforeAll(async () => { await setupDB(); }, 60_000);
  afterAll(async () => { await teardownDB(); });

  test('an unparseable verdict stores a score-NULL marker and the next pass makes no judge call', async () => {
    const engine = getEngine();
    const t = { filePath: '/corpus/pg-backoff.txt', contentHash: randomBytes(32).toString('hex'), content: 'a routine exchange '.repeat(80), basename: 'pg-backoff', inferredDate: null };
    let calls = 0;
    const judge: JudgeClient = { create: async () => { calls++; return { content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' } as never; } };
    const cfg = { model: MODEL, maxChars: 24_000, maxTokens: 2048, threshold: 0.5, concurrency: 1, maxMs: 0, judge };

    await runTriagePass(engine, [t], cfg);
    const row = await engine.getDreamVerdict(t.filePath, t.contentHash);
    expect(row?.score).toBeNull();
    expect(row?.content_type).toBe('triage_unreliable');
    expect(row?.reasons).toEqual(['unreliable:unparseable', 'attempt:1']);
    expect(row?.triage_version).toBe(TRIAGE_VERSION);
    expect(isTriageCacheValid(row!, MODEL)).toBe(false);

    const second = await runTriagePass(engine, [t], cfg);
    expect(calls).toBe(1);
    expect(second.backoff).toBe(1);
    expect(second.reports[0].code).toBe('triage_unreliable_backoff');
  });
});
