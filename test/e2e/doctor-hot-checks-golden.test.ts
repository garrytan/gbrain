/**
 * GBRA-75 wave 10: Postgres twin of test/doctor-hot-checks-golden.test.ts.
 * Full `gbrain doctor --json` on the hot-check fixture
 * (test/helpers/doctor-hot-checks-fixture.ts), first run and a second run
 * after edits, on a scratch database per capture
 * (`gbrain_test_doctor_hot_<uuid>`). Captured on 3f960312a before the doctor
 * speedups, which must reproduce it after the doctor-json-pg-v1 normalizer.
 *
 * Tier 1 (no API keys). Skips without DATABASE_URL.
 * Run: DATABASE_URL=... bun test test/e2e/doctor-hot-checks-golden.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from '../helpers/golden.ts';
import { doctorJsonNormalizer, makeDoctorHome, networkAttempts, runGbrain, type DoctorHome, type GbrainRun } from '../helpers/doctor-json-golden.ts';
import { buildHotCheckFixture, editHotCheckFixture, type Sql } from '../helpers/doctor-hot-checks-fixture.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log('Skipping E2E doctor hot-check golden (DATABASE_URL not set)');

const homes: DoctorHome[] = [];
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of drops) await drop();
  for (const h of homes) h.cleanup();
});

interface PgCaptures { first: GbrainRun; second: GbrainRun; url: string; name: string }

function pgNormalizer(base: URL) {
  const inner = (url: string, name: string) => doctorJsonNormalizer([
    [url, '<database_url>'],
    [name, '<database>'],
    [`${base.hostname}:${base.port || '5432'}`, '<pg_host>:<pg_port>'],
    [/\bgbrain_test_doctor_hot_[0-9a-f]{32}\b/g, '<database>'],
  ], 'doctor-json-pg-v1');
  return defineNormalizer<PgCaptures>('doctor-json-pg-v1', (c) => {
    const n = inner(c.url, c.name);
    return { first: n.apply(c.first), second: n.apply(c.second) };
  });
}

async function capture(adminUrl: string): Promise<PgCaptures> {
  const name = `gbrain_test_doctor_hot_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  drops.push(async () => {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  const h = makeDoctorHome('doctor-hot-checks-pg');
  homes.push(h);
  const init = await runGbrain(h, ['init', '--non-interactive', '--url', url, '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
  const sql: Sql = async (statements) => {
    const db = postgres(url, { max: 1, prepare: false });
    try {
      await db.begin(async (tx) => { for (const [q, p] of statements) await tx.unsafe(q, p as never[]); });
    } finally {
      await db.end();
    }
  };
  await buildHotCheckFixture(h, sql);
  const first = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  await editHotCheckFixture(h, sql);
  const second = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  expect(networkAttempts(h)).toEqual([]);
  return { first, second, url, name };
}

describeE2E('gbrain doctor --json golden on the hot-check fixture (Postgres)', () => {
  test('first and second doctor runs match the 3f960312a capture', async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    const normalizer = pgNormalizer(new URL(DATABASE_URL!));
    const c = await expectNormalizerStable(() => capture(DATABASE_URL!), normalizer);
    for (const run of [c.first, c.second]) expect((run.json as { engine?: string } | null)?.engine).toBe('postgres');
    expectGolden('doctor/hot-checks-postgres-json', c, normalizer);
  }, 400_000);
});
