/**
 * #6278: the kill case on PGLite. Protects: when a process reopens the datastore
 * and `releaseAbandonedClaims` reclaims the dead owner's claims, a request whose
 * claim was stamped `preparing` under the reclaimed token is charged one
 * preparation attempt, while a publishing claim, a stamp from an earlier claim
 * and a switched-off brain are never charged (the same rule as the Postgres
 * expired-claim sweep). Fails when the reclaim charges nothing (a kill loop
 * never reaches the attempt limit) or charges every running row.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { releaseAbandonedClaims } from '../src/core/persistence/effect-journal.ts';
import { claimPhaseStamp, startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-kill-accounting-'));
const config: HarnessConfig = { kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 6278, schedules: 0, operations: 0, sourceIds: ['kill-accounting', 'kill-accounting-b', 'kill-accounting-c'], principalIds: [randomUUID()] };
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the PGLite reclaim charges a preparing claim of the reclaimed token only, and only with the switch on', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  // Three roots, one claimed request each: claimed (stamped preparing at claim), publishing, and an earlier claim's stamp.
  const rows = await Promise.all(sources.map((source, i) => admitWrite(engine, admission(config, source, `kill/${i}`, `body ${i}`))));
  const claimed: WriteRequest[] = [];
  for (let i = 0; i < 3; i++) claimed.push((await claimNextWrite(engine, config.hostId, 30_000, claimed.map(row => row.worktree_id!)))!);
  expect(claimed.map(row => row.slug).sort()).toEqual(rows.map(row => row.slug).sort());
  const byIndex = (i: number) => claimed.find(row => row.slug === `kill/${i}`)!;
  const publishing = startClaimPhase(); publishing.phase = 'publishing';
  await engine.executeRaw('UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid', [byIndex(1).id, claimPhaseStamp(publishing, byIndex(1).execution_token)]);
  await engine.executeRaw('UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid', [byIndex(2).id, claimPhaseStamp(startClaimPhase(), randomUUID())]);
  // The switch off: the dead owner's claims are released and nothing is charged.
  const future = new Date(Date.now() + 60_000);
  expect(await releaseAbandonedClaims(engine, future, false)).toBe(3);
  for (let i = 0; i < 3; i++) expect(await getWriteRequestById(engine, byIndex(i).id)).toMatchObject({ state: 'queued', preparation_attempts: 0 });
  // Claim again (fresh stamps), restore the two control stamps, then reclaim with the switch on.
  const again: WriteRequest[] = [];
  for (let i = 0; i < 3; i++) again.push((await claimNextWrite(engine, config.hostId, 30_000, again.map(row => row.worktree_id!)))!);
  const second = (i: number) => again.find(row => row.slug === `kill/${i}`)!;
  await engine.executeRaw('UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid', [second(1).id, claimPhaseStamp(publishing, second(1).execution_token)]);
  await engine.executeRaw('UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid', [second(2).id, claimPhaseStamp(startClaimPhase(), randomUUID())]);
  expect(await releaseAbandonedClaims(engine, future, true)).toBe(3);
  expect((await getWriteRequestById(engine, second(0).id))).toMatchObject({ state: 'queued', preparation_attempts: 1 });
  expect((await getWriteRequestById(engine, second(1).id))).toMatchObject({ state: 'queued', preparation_attempts: 0 });
  expect((await getWriteRequestById(engine, second(2).id))).toMatchObject({ state: 'queued', preparation_attempts: 0 });
}), 30_000);
