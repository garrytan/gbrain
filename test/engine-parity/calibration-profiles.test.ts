/**
 * BrainEngine parity: the `calibration_profiles` table (engine-sql/calibration-profiles.ts): the latest-profile read
 * behind `gbrain calibration`, the "scorecard unchanged" check and the insert of the `calibration_profile` cycle phase,
 * the doctor's voice-gate read, and the undo-wave purge.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts): which row is the newest for a holder and a source filter, what an
 *    empty source list means, what a REAL column reads back as, which latest row the unchanged check compares, what an
 *    insert refuses, which rows the 7-day window counts, and which rows a wave purge removes and counts.
 *  - Regression: an engine that orders by `generated_at` ascending, ignores the `id DESC` tie-break, reads an empty
 *    `sourceIds` as "no filter", lets `sourceIds` lose to `sourceId`, compares the unchanged check against an older
 *    row than the latest, treats a NULL metric as different from a NULL metric, stores a missing source, counts rows
 *    outside the window, or deletes rows of another wave. Each decides what an operator is shown or whether a paid
 *    model call is skipped.
 *  - Why existing coverage misses it: test/calibration-profile.test.ts and test/doctor-calibration-checks.test.ts run
 *    on PGLite only, and a Rust engine has no raw SQL, so nothing compared the engines on one scenario.
 *  - Seam: none. Real engines, typed members only (no executeRaw: D18). Profiles are written through
 *    `insertCalibrationProfile` with explicit `generatedAt`, `waveVersion` and `published` (the cycle phase leaves them
 *    to the column defaults), so ordering and windows never wait on a clock. Ids differ per engine (a Postgres
 *    sequence keeps counting), so a case compares only that `id` is digits and the order ids give.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CalibrationProfileInsert, CalibrationProfileRow } from '../../src/core/engine-sql/calibration-profiles.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const DAY = 24 * 60 * 60 * 1000;
const T = (n: number) => new Date(Date.UTC(2026, 2, 1) + n * DAY);

function profile(extra: Partial<CalibrationProfileInsert> = {}): CalibrationProfileInsert {
  return {
    sourceId: 'default', holder: 'self', totalResolved: 12, brier: 0.3, accuracy: 0.7, partialRate: 0.1, gradeCompletion: 0.9,
    domainScorecards: { people: { n: 4, brier: 0.2 } }, patternStatements: ['You are over-confident on timing.', 'Naïve 日本語 stays intact.'],
    voiceGatePassed: true, voiceGateAttempts: 1, activeBiasTags: ['overconfident', 'anchoring'], modelId: 'model-a',
    generatedAt: T(0), ...extra,
  };
}

/** A row as a case compares it: no id value, the instant as text. */
function shown(row: CalibrationProfileRow | null) {
  if (!row) return null;
  expect(row.id).toMatch(/^[0-9]+$/);
  expect(typeof row.id).toBe('string');
  expect(row.generated_at).toBeInstanceOf(Date);
  const { id: _id, generated_at, ...rest } = row;
  return { ...rest, generated_at: generated_at.toISOString() };
}

async function refuses(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'src-a');
  await createSource(engine, backend, 'src-b');
}

describe('calibration profiles parity', () => {
  parityTest('getLatestCalibrationProfile returns the newest profile for a holder and source filter, ties by id, REAL columns as the shortest number',
    { methods: ['insertCalibrationProfile', 'getLatestCalibrationProfile'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.insertCalibrationProfile(profile({ generatedAt: T(1), brier: 0.25, modelId: 'default-old' }));
      await engine.insertCalibrationProfile(profile({ generatedAt: T(3), brier: 0.1, accuracy: 0.85, partialRate: 0.05, modelId: 'default-new' }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-a', generatedAt: T(4), modelId: 'a-newest-self' }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: T(2), modelId: 'b-self' }));
      await engine.insertCalibrationProfile(profile({ holder: 'alice', generatedAt: T(5), modelId: 'alice' }));
      // Two rows of one instant: the later insert (higher id) wins.
      await engine.insertCalibrationProfile(profile({ holder: 'tied', sourceId: 'src-b', generatedAt: T(6), modelId: 'tie-first' }));
      await engine.insertCalibrationProfile(profile({ holder: 'tied', sourceId: 'src-b', generatedAt: T(6), modelId: 'tie-second' }));
      // NULL metrics, an empty tag list and an unpublished/published flag read back as they were written.
      await engine.insertCalibrationProfile(profile({
        holder: 'sparse', generatedAt: T(7), brier: null, accuracy: null, partialRate: null, gradeCompletion: 1, patternStatements: [],
        activeBiasTags: [], voiceGatePassed: false, voiceGateAttempts: 3, published: true, waveVersion: 'v9.9', modelId: 'sparse',
      }));
      const get = async (spec: Parameters<BrainEngine['getLatestCalibrationProfile']>[0]) => shown(await engine.getLatestCalibrationProfile(spec));
      const out = {
        selfAny: await get({ holder: 'self' }),
        selfDefault: await get({ holder: 'self', sourceId: 'default' }),
        selfIds: await get({ holder: 'self', sourceIds: ['default', 'src-b'] }),
        selfNoIds: await get({ holder: 'self', sourceIds: [] }),
        idsBeatSourceId: await get({ holder: 'self', sourceId: 'src-a', sourceIds: ['src-b'] }),
        emptySourceId: await get({ holder: 'self', sourceId: '' }),
        anyHolderIds: await get({ sourceIds: ['default'] }),
        anyHolderOne: await get({ sourceId: 'src-b' }),
        anyHolderAny: await get({}),
        unknownHolder: await get({ holder: 'nobody' }),
        unknownSource: await get({ holder: 'self', sourceId: 'nowhere' }),
        tied: await get({ holder: 'tied' }),
        sparse: await get({ holder: 'sparse' }),
      };
      expect(out.selfAny?.model_id).toBe('a-newest-self');
      expect(out.selfDefault?.model_id).toBe('default-new');
      expect(out.selfNoIds).toBeNull();
      expect(out.idsBeatSourceId?.model_id).toBe('b-self');
      expect(out.tied?.model_id).toBe('tie-second');
      expect(out.selfDefault).toMatchObject({ brier: 0.1, accuracy: 0.85, partial_rate: 0.05, grade_completion: 0.9 });
      expect(out.sparse).toMatchObject({ brier: null, accuracy: null, partial_rate: null, published: true, wave_version: 'v9.9', voice_gate_passed: false });
      return out;
    });

  parityTest('isCalibrationProfileUnchanged compares only the latest profile of the source and holder, REAL-rounded, NULL-safe',
    { methods: ['insertCalibrationProfile', 'isCalibrationProfileUnchanged'] }, async (engine, backend) => {
      await seed(engine, backend);
      const spec = { sourceId: 'default', holder: 'self', totalResolved: 12, brier: 0.1234567, accuracy: 0.7, partialRate: 0.1, modelId: 'model-a' };
      const none = await engine.isCalibrationProfileUnchanged(spec);
      // An old profile that matches, then a newer one that does not: only the latest counts.
      await engine.insertCalibrationProfile(profile({ generatedAt: T(1), brier: 0.1234567 }));
      const matchesOnly = await engine.isCalibrationProfileUnchanged(spec);
      await engine.insertCalibrationProfile(profile({ generatedAt: T(2), brier: 0.5 }));
      const newerDiffers = await engine.isCalibrationProfileUnchanged(spec);
      await engine.insertCalibrationProfile(profile({ generatedAt: T(3), brier: 0.1234567 }));
      const newestMatches = await engine.isCalibrationProfileUnchanged(spec);
      const checks = {
        none, matchesOnly, newerDiffers, newestMatches,
        otherModel: await engine.isCalibrationProfileUnchanged({ ...spec, modelId: 'model-b' }),
        otherTotal: await engine.isCalibrationProfileUnchanged({ ...spec, totalResolved: 13 }),
        otherAccuracy: await engine.isCalibrationProfileUnchanged({ ...spec, accuracy: 0.71 }),
        otherPartial: await engine.isCalibrationProfileUnchanged({ ...spec, partialRate: null }),
        otherHolder: await engine.isCalibrationProfileUnchanged({ ...spec, holder: 'alice' }),
        otherSource: await engine.isCalibrationProfileUnchanged({ ...spec, sourceId: 'src-a' }),
      };
      // NULL metrics on both sides are the same; a NULL against a number is not.
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-a', generatedAt: T(4), brier: null, accuracy: null, partialRate: null }));
      const nulls = { ...spec, sourceId: 'src-a', brier: null, accuracy: null, partialRate: null };
      const nullBoth = await engine.isCalibrationProfileUnchanged(nulls);
      const nullVsNumber = await engine.isCalibrationProfileUnchanged({ ...nulls, brier: 0.3 });
      // A tie on the instant: the later insert is the latest.
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: T(5), modelId: 'tie-first' }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: T(5), modelId: 'tie-second' }));
      const tieLatest = await engine.isCalibrationProfileUnchanged({ ...spec, sourceId: 'src-b', brier: 0.3, modelId: 'tie-second' });
      const tieEarlier = await engine.isCalibrationProfileUnchanged({ ...spec, sourceId: 'src-b', brier: 0.3, modelId: 'tie-first' });
      expect(checks).toMatchObject({ none: false, matchesOnly: true, newerDiffers: false, newestMatches: true });
      expect({ nullBoth, nullVsNumber, tieLatest, tieEarlier }).toEqual({ nullBoth: true, nullVsNumber: false, tieLatest: true, tieEarlier: false });
      return { checks, nullBoth, nullVsNumber, tieLatest, tieEarlier };
    });

  parityTest('insertCalibrationProfile applies the column defaults and refuses a missing source or an out-of-range column without writing',
    { methods: ['insertCalibrationProfile', 'getLatestCalibrationProfile'] }, async (engine, backend) => {
      await seed(engine, backend);
      const before = Date.now();
      // The phase's own call: no generatedAt, waveVersion or published.
      const { generatedAt: _g, ...phase } = profile({ modelId: 'defaults' });
      await engine.insertCalibrationProfile(phase);
      const row = (await engine.getLatestCalibrationProfile({ holder: 'self' }))!;
      expect(Math.abs(row.generated_at.getTime() - before)).toBeLessThan(120_000);
      const refusals = {
        missingSource: await refuses(() => engine.insertCalibrationProfile(profile({ sourceId: 'no-such-source', holder: 'ghost' }))),
        attemptsOutOfRange: await refuses(() => engine.insertCalibrationProfile(profile({ holder: 'big-attempts', voiceGateAttempts: 40_000 }))),
        totalOutOfRange: await refuses(() => engine.insertCalibrationProfile(profile({ holder: 'big-total', totalResolved: 2 ** 31 }))),
      };
      expect(refusals).toEqual({ missingSource: true, attemptsOutOfRange: true, totalOutOfRange: true });
      // Nothing of a refused insert is kept.
      const ghosts = [] as Array<CalibrationProfileRow | null>;
      for (const holder of ['ghost', 'big-attempts', 'big-total']) ghosts.push(await engine.getLatestCalibrationProfile({ holder }));
      expect(ghosts).toEqual([null, null, null]);
      // Another insert still works (a refused one did not poison the sequence or the indexes).
      await engine.insertCalibrationProfile(profile({ holder: 'after', generatedAt: T(9), modelId: 'after' }));
      const { id: _id, generated_at: _at, ...stored } = row;
      return { stored, refusals, after: shown(await engine.getLatestCalibrationProfile({ holder: 'after' })) };
    });

  parityTest('readVoiceGateHealth counts the profiles of the last 7 days and those that failed the voice gate, per source list',
    { methods: ['insertCalibrationProfile', 'readVoiceGateHealth'] }, async (engine, backend) => {
      await seed(engine, backend);
      const ago = (days: number) => new Date(Date.now() - days * DAY);
      await engine.insertCalibrationProfile(profile({ generatedAt: ago(1), voiceGatePassed: true }));
      await engine.insertCalibrationProfile(profile({ generatedAt: ago(2), voiceGatePassed: false }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-a', generatedAt: ago(6), voiceGatePassed: false }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: ago(5), voiceGatePassed: true, holder: 'alice' }));
      // Outside the window: not counted, pass or fail.
      await engine.insertCalibrationProfile(profile({ generatedAt: ago(7.5), voiceGatePassed: false }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-a', generatedAt: ago(30), voiceGatePassed: true }));
      // Not yet generated by this engine's clock (a future stamp): the window has no upper bound.
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: ago(-2), voiceGatePassed: false }));
      const out = {
        all: await engine.readVoiceGateHealth({}),
        defaultOnly: await engine.readVoiceGateHealth({ sourceIds: ['default'] }),
        two: await engine.readVoiceGateHealth({ sourceIds: ['src-a', 'src-b'] }),
        empty: await engine.readVoiceGateHealth({ sourceIds: [] }),
        unknown: await engine.readVoiceGateHealth({ sourceIds: ['nowhere'] }),
      };
      expect(out).toEqual({
        all: { total: 5, failures: 3 }, defaultOnly: { total: 2, failures: 1 }, two: { total: 3, failures: 2 },
        empty: { total: 0, failures: 0 }, unknown: { total: 0, failures: 0 },
      });
      return out;
    });

  parityTest('purgeCalibrationProfilesByWave counts a wave on a dry run and deletes only that wave, leaving the latest read on the others',
    { methods: ['insertCalibrationProfile', 'getLatestCalibrationProfile', 'purgeCalibrationProfilesByWave'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.insertCalibrationProfile(profile({ generatedAt: T(1), modelId: 'default-wave' }));
      await engine.insertCalibrationProfile(profile({ generatedAt: T(2), waveVersion: 'v-doomed', modelId: 'doomed-1' }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-a', generatedAt: T(3), waveVersion: 'v-doomed', modelId: 'doomed-2' }));
      await engine.insertCalibrationProfile(profile({ holder: 'alice', generatedAt: T(4), waveVersion: 'v-doomed', modelId: 'doomed-3' }));
      await engine.insertCalibrationProfile(profile({ sourceId: 'src-b', generatedAt: T(5), waveVersion: 'v-kept', modelId: 'kept' }));
      const dry = await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-doomed', dryRun: true });
      const afterDry = shown(await engine.getLatestCalibrationProfile({ holder: 'self', sourceId: 'src-a' }));
      const unknownDry = await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-none', dryRun: true });
      const unknownReal = await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-none', dryRun: false });
      const purged = await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-doomed', dryRun: false });
      const again = await engine.purgeCalibrationProfilesByWave({ waveVersion: 'v-doomed', dryRun: false });
      const after = {
        selfDefault: shown(await engine.getLatestCalibrationProfile({ holder: 'self', sourceId: 'default' })),
        selfSrcA: shown(await engine.getLatestCalibrationProfile({ holder: 'self', sourceId: 'src-a' })),
        selfSrcB: shown(await engine.getLatestCalibrationProfile({ holder: 'self', sourceId: 'src-b' })),
        alice: shown(await engine.getLatestCalibrationProfile({ holder: 'alice' })),
      };
      expect({ dry, unknownDry, unknownReal, purged, again }).toEqual({ dry: 3, unknownDry: 0, unknownReal: 0, purged: 3, again: 0 });
      expect(afterDry?.model_id).toBe('doomed-2');
      expect(after.selfDefault?.model_id).toBe('default-wave');
      expect(after.selfSrcA).toBeNull();
      expect(after.selfSrcB?.model_id).toBe('kept');
      expect(after.alice).toBeNull();
      return { dry, unknownDry, unknownReal, purged, again, after };
    });
});
