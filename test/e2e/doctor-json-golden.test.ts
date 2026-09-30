/**
 * Refactor wave 1 (W0): `gbrain doctor --json` golden on Postgres.
 *
 * Each capture creates a scratch database (`gbrain_test_doctor_golden_<uuid>`)
 * on the DATABASE_URL server, so the brain is pristine regardless of which
 * E2E files ran before (no carried-over column widths, config rows or
 * pg_stat counters), runs `gbrain init --non-interactive --url <scratch>
 * --no-embedding`, then `gbrain doctor --json` with the hermetic child env
 * from test/helpers/doctor-json-golden.ts. Captured twice (two scratch
 * databases); both must normalize to identical bytes before comparing.
 *
 * Normalizer `doctor-json-pg-v1` = doctor-json-v1 plus the scratch URL,
 * database name, server host:port and user replaced with placeholders.
 *
 * Tier 1 (no API keys). Skips without DATABASE_URL.
 * Run: DATABASE_URL=... bun test test/e2e/doctor-json-golden.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { expectGolden, expectNormalizerStable, defineNormalizer } from '../helpers/golden.ts';
import {
  doctorJsonNormalizer,
  makeDoctorHome,
  networkAttempts,
  runGbrain,
  type DoctorHome,
  type GbrainRun,
} from '../helpers/doctor-json-golden.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log('Skipping E2E doctor --json golden (DATABASE_URL not set)');

const homes: DoctorHome[] = [];
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of drops) await drop();
  for (const h of homes) h.cleanup();
});

interface PgRun {
  run: GbrainRun;
  url: string;
  name: string;
}

function pgNormalizer(base: URL) {
  const inner = (url: string, name: string) =>
    doctorJsonNormalizer([
      [url, '<database_url>'],
      [name, '<database>'],
      [`${base.hostname}:${base.port || '5432'}`, '<pg_host>:<pg_port>'],
      [/\bgbrain_test_doctor_golden_[0-9a-f]{32}\b/g, '<database>'],
    ], 'doctor-json-pg-v1');
  return defineNormalizer<PgRun>('doctor-json-pg-v1', (r) => inner(r.url, r.name).apply(r.run));
}

async function scratchDatabase(adminUrl: string) {
  const name = `gbrain_test_doctor_golden_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  drops.push(async () => {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  return { name, url: url.toString() };
}

async function capture(adminUrl: string): Promise<PgRun> {
  const db = await scratchDatabase(adminUrl);
  const h = makeDoctorHome('doctor-golden-pg');
  homes.push(h);
  const init = await runGbrain(h, ['init', '--non-interactive', '--url', db.url, '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
  const run = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
  expect(networkAttempts(h)).toEqual([]);
  return { run, url: db.url, name: db.name };
}

describeE2E('gbrain doctor --json golden (Postgres)', () => {
  test('fresh Postgres brain', async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    const normalizer = pgNormalizer(new URL(DATABASE_URL!));
    const first = await expectNormalizerStable(() => capture(DATABASE_URL!), normalizer);
    const report = first.run.json as { engine?: string; checks?: Array<{ name: string; status: string }> } | null;
    expect(report?.engine).toBe('postgres');
    expect(report?.checks?.find((c) => c.name === 'connection')?.status).toBe('ok');
    expectGolden('doctor/json-postgres-fresh', first, normalizer);
  }, 240_000);
});
