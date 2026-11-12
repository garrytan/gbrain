/**
 * #8720: `doctor --fast` runs without an engine, so the brain config that
 * declines an opt-out migration (MIGRATION_OPT_OUT_KEYS) is unreadable. The
 * check listed such a version as "not run yet" with `apply-migrations --yes`,
 * which skips a declined migration and so can never clear the warning.
 * Without an engine an opt-out version is unknown, not pending; with an
 * engine an undeclined one is still reported.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATION_OPT_OUT_KEYS } from '../src/core/migration-ledger.ts';
import { minionsMigrationEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

const OPT_OUT = Object.keys(MIGRATION_OPT_OUT_KEYS)[0]!;
let home: string;
let engine: PGLiteEngine;

beforeAll(async () => {
  home = emptyHome();
  mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'),
    JSON.stringify({ version: '0.60.31', status: 'complete', ts: '2026-01-01T00:00:00Z' }) + '\n');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const pendingChecks = (engineOrNull: PGLiteEngine | null) => withEnv({ GBRAIN_HOME: home }, async () => {
  const ctx = { engine: engineOrNull, progress: { heartbeat() {}, finish() {} }, args: engineOrNull ? [] : ['--fast'] } as unknown as DoctorContext;
  return (await minionsMigrationEntry.run(ctx) as Check[]).filter(c => c.name === 'minions_migration' && c.status === 'warn');
});

test('without an engine an opt-out migration is not reported as not run', async () => {
  const warns = await pendingChecks(null);
  expect(warns.map(c => c.message).join(' ')).not.toContain(OPT_OUT);
});

test('with an engine and the migration not declined it is still reported as not run', async () => {
  const warns = await pendingChecks(engine);
  expect(warns.map(c => c.message).join(' ')).toContain(OPT_OUT);
});
