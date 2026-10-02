/**
 * Refactor wave 1 (W0): `gbrain doctor --json` goldens on PGLite.
 *
 * Real CLI subprocesses (the path agents and smoke tests consume), hermetic
 * env from test/helpers/doctor-json-golden.ts, normalizer `doctor-json-v1`.
 * Each golden is captured twice from two independent fresh homes and must
 * normalize to identical bytes (expectNormalizerStable) before it is compared.
 *
 * Variants:
 *   - pglite-fresh:     `gbrain init --pglite --no-embedding`, then doctor --json
 *   - pglite-fast:      same home, doctor --json --fast (DB checks skipped)
 *   - pglite-degraded:  same home, config declares openai:text-embedding-3-large
 *                       at 3072 dims (no key, column is vector(1024)) — warns
 *                       without any network
 *   - no-config:        empty home — the CLI refuses before doctor runs
 *   - postgres-unreachable: config points at a closed loopback port — the
 *                       dead-DB fallback (buildChecks(null, ..., connectError))
 *   - postgres-unreachable-fast: same config with --fast
 *
 * No variant may attempt a network call (fetch is refused and logged).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { expectGolden, expectNormalizerStable, defineNormalizer } from './helpers/golden.ts';
import {
  doctorJsonNormalizer,
  makeDoctorHome,
  networkAttempts,
  patchConfig,
  runGbrain,
  type DoctorHome,
  type GbrainRun,
} from './helpers/doctor-json-golden.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCTOR_JSON = doctorJsonNormalizer();
const homes: DoctorHome[] = [];
afterAll(() => {
  for (const h of homes) h.cleanup();
});

function home(prefix: string): DoctorHome {
  const h = makeDoctorHome(prefix);
  homes.push(h);
  return h;
}

type Captures = Record<string, GbrainRun>;
const ALL = defineNormalizer<Captures>(DOCTOR_JSON.name, (c) =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, DOCTOR_JSON.apply(v)])),
);

async function capturePglite(): Promise<Captures> {
  const h = home('doctor-golden-pglite');
  const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
  const fresh = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  const fast = await runGbrain(h, ['doctor', '--json', '--fast', '--skills-dir', h.skillsDir]);
  patchConfig(h, (cfg) => {
    delete cfg.embedding_disabled;
    cfg.embedding_model = 'openai:text-embedding-3-large';
    cfg.embedding_dimensions = 3072;
  });
  const degraded = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  expect(networkAttempts(h)).toEqual([]);
  return { fresh, fast, degraded };
}

async function captureEarlyStops(): Promise<Captures> {
  const empty = home('doctor-golden-noconfig');
  const noConfig = await runGbrain(empty, ['doctor', '--json', '--skills-dir', empty.skillsDir]);
  expect(networkAttempts(empty)).toEqual([]);

  const dead = home('doctor-golden-deadpg');
  mkdirSync(join(dead.home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(dead.home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'postgres', database_url: 'postgresql://gbrain@127.0.0.1:1/gbrain' }) + '\n', /* allow-pg-url-literal */
  );
  const unreachable = await runGbrain(dead, ['doctor', '--json', '--skills-dir', dead.skillsDir]);
  const unreachableFast = await runGbrain(dead, ['doctor', '--json', '--fast', '--skills-dir', dead.skillsDir]);
  expect(networkAttempts(dead)).toEqual([]);
  return { noConfig, unreachable, unreachableFast };
}

describe('gbrain doctor --json goldens (PGLite + early stops)', () => {
  test('PGLite fresh / --fast / degraded config', async () => {
    const c = await expectNormalizerStable(capturePglite, ALL);
    expect(c.fresh.json).not.toBeNull();
    expect(c.fast.json).not.toBeNull();
    expect(c.degraded.json).not.toBeNull();
    expectGolden('doctor/json-pglite-fresh', c.fresh, DOCTOR_JSON);
    expectGolden('doctor/json-pglite-fast', c.fast, DOCTOR_JSON);
    expectGolden('doctor/json-pglite-degraded', c.degraded, DOCTOR_JSON);
  }, 240_000);

  test('no config, unreachable Postgres, unreachable Postgres --fast', async () => {
    const c = await expectNormalizerStable(captureEarlyStops, ALL);
    expectGolden('doctor/json-no-config', c.noConfig, DOCTOR_JSON);
    expectGolden('doctor/json-postgres-unreachable', c.unreachable, DOCTOR_JSON);
    expectGolden('doctor/json-postgres-unreachable-fast', c.unreachableFast, DOCTOR_JSON);
  }, 240_000);
});
