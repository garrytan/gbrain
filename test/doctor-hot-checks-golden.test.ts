/**
 * GBRA-75 wave 10: full `gbrain doctor --json` golden on a PGLite brain whose
 * content exercises every finding of the doctor hot checks
 * (`frontmatter_integrity`, `frontmatter_repairable`, the `timeline_history`
 * group, `fence_integrity`; fixture in test/helpers/doctor-hot-checks-fixture.ts).
 * Pins the first doctor run, then a second one after edits (incremental
 * census pass, resumed timeline state). Captured on 3f960312a before the
 * doctor speedups (shared parse pass, batched reads, Git memo), which must
 * reproduce it byte for byte after the hermetic doctor-json-v1 normalizer
 * (timings, timestamps and paths only).
 *
 * Postgres twin: test/e2e/doctor-hot-checks-golden.test.ts. PGLite, $0.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { doctorJsonNormalizer, makeDoctorHome, networkAttempts, runGbrain, type DoctorHome, type GbrainRun } from './helpers/doctor-json-golden.ts';
import { buildHotCheckFixture, editHotCheckFixture, pgliteSql } from './helpers/doctor-hot-checks-fixture.ts';

const DOCTOR = doctorJsonNormalizer();
const homes: DoctorHome[] = [];
afterAll(() => {
  for (const h of homes) h.cleanup();
});

type Captures = { first: GbrainRun; second: GbrainRun };
const BOTH = defineNormalizer<Captures>(DOCTOR.name, (c) => ({ first: DOCTOR.apply(c.first), second: DOCTOR.apply(c.second) }));

async function capture(): Promise<Captures> {
  const h = makeDoctorHome('doctor-hot-checks');
  homes.push(h);
  const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
  const { database_path } = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf8')) as { database_path: string };
  const sql = pgliteSql(database_path);
  await buildHotCheckFixture(h, sql);
  const first = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  await editHotCheckFixture(h, sql);
  const second = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  expect(networkAttempts(h)).toEqual([]);
  return { first, second };
}

describe('gbrain doctor --json golden on the hot-check fixture (PGLite)', () => {
  test('first and second doctor runs match the 3f960312a capture', async () => {
    const c = await expectNormalizerStable(capture, BOTH);
    for (const run of [c.first, c.second]) expect(run.json).not.toBeNull();
    expectGolden('doctor/hot-checks-pglite-json', c, BOTH);
  }, 300_000);
});
