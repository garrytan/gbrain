/**
 * brainstorm_health doctor check
 * (checkBrainstormHealth in src/commands/doctor/checks/graph-embedding.ts).
 *
 * Pins:
 *   - ok baseline on a fresh schema (v79 column present, tracking default-on,
 *     zero calibration_profiles rows -> "profile not yet generated" message);
 *   - search.track_retrieval explicitly set to each of 'false','0','off','no'
 *     -> warn; 'true' (and unset) -> ok;
 *   - calibration row with empty active_bias_tags -> ok with the cold-start
 *     message; row with tags -> ok naming the tag count (latest row wins);
 *   - column probe throwing -> warn ("degraded"), never a crash.
 *
 * Reality note vs the plan: zero calibration_profiles ROWS produces the
 * "Calibration profile not yet generated" message; the literal "cold-start"
 * wording ("Calibration cold-start (no active_bias_tags)") belongs to the
 * row-with-empty-tags case. Both are ok-status; both are pinned below.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkBrainstormHealth } from '../src/commands/doctor/checks/graph-embedding.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Insert a calibration_profiles row with the given bias tags (SQL literal). */
async function insertProfile(tagsSql: string, generatedAt = 'now()'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO calibration_profiles
       (source_id, holder, generated_at, total_resolved, domain_scorecards,
        pattern_statements, voice_gate_passed, voice_gate_attempts,
        active_bias_tags, model_id)
     VALUES
       ('default', 'user', ${generatedAt}, 5, '{}'::jsonb,
        ARRAY[]::text[], true, 1,
        ${tagsSql}, 'test-model')`,
  );
}

describe('brainstorm_health', () => {
  test('fresh schema baseline -> ok; zero calibration rows -> profile-not-yet-generated message', async () => {
    const check = await checkBrainstormHealth(engine);
    expect(check.name).toBe('brainstorm_health');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Migration v79 applied; tracking enabled.');
    expect(check.message).toContain('Calibration profile not yet generated');
  });

  test.each(['false', '0', 'off', 'no'])(
    "search.track_retrieval = '%s' -> warn (explicitly off)",
    async (variant) => {
      await engine.setConfig('search.track_retrieval', variant);
      const check = await checkBrainstormHealth(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('search.track_retrieval is explicitly off');
      expect(check.message).toContain('gbrain config set search.track_retrieval true');
    },
  );

  test("search.track_retrieval = 'true' -> ok (only explicit-off warns)", async () => {
    await engine.setConfig('search.track_retrieval', 'true');
    const check = await checkBrainstormHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('tracking enabled');
  });

  test('calibration row with EMPTY active_bias_tags -> ok with the cold-start message', async () => {
    await insertProfile(`ARRAY[]::text[]`);
    const check = await checkBrainstormHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Calibration cold-start (no active_bias_tags)');
    expect(check.message).toContain('gbrain calibration --regenerate');
  });

  test('latest calibration row wins; tags -> ok naming the tag count', async () => {
    // Older empty-tag row must lose to the newer tagged row (ORDER BY generated_at DESC).
    await insertProfile(`ARRAY[]::text[]`, `now() - interval '2 days'`);
    await insertProfile(`ARRAY['overconfidence','anchoring']::text[]`);
    const check = await checkBrainstormHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('calibration profile with 2 bias tag(s) loaded');
    expect(check.message).not.toContain('cold-start');
  });

  test('column probe throwing -> warn (degraded), never a crash', async () => {
    const throwing = {
      executeRaw: async () => {
        throw new Error('probe-down');
      },
    } as unknown as BrainEngine;
    const check = await checkBrainstormHealth(throwing); // must resolve, not reject
    expect(check.name).toBe('brainstorm_health');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Could not probe pages.last_retrieved_at (probe-down)');
    expect(check.message).toContain('degraded signal');
  });
});
