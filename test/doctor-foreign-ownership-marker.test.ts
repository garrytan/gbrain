/**
 * #5808: `foreign_ownership_marker` names the ownership marker files beside a
 * source checkout that record another brain or an unknown worktree, so the
 * operator learns which file blocks the claim instead of a bare
 * `recovery_required`. A marker of this brain's own claim is not reported.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkForeignOwnershipMarkers } from '../src/commands/doctor/checks/orphan-bindings.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, reservePhysicalRootRecord, writePhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-foreign-marker-')));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const isolated = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, run);

test('the finding is an operator-resolved wave check with a docs anchor', () => {
  const spec = WAVE_CHECKS.find(check => check.id === 'foreign_ownership_marker');
  expect(spec).toMatchObject({ resolution: 'operator', registration: 'wave' });
  expect(spec!.hostOnly).toBeTruthy();
  expect(spec!.instruction).toContain('write-refusals.md#foreign-ownership-marker');
  expect(spec!.count({ count: 3 })).toBe(3);
});

test('markers of this brain are ok; a retired brain\'s stamp and reservation are named with their file and brain id', () => isolated(async () => {
  await registerLocalWriter(engine, 'cli');
  const own = join(home, 'own'); mkdirSync(own);
  const ownId = `own-${randomUUID().slice(0, 6)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [ownId, own]);
  await claimWorktree(engine, ownId, own, localHostId());
  expect(await checkForeignOwnershipMarkers(engine)).toMatchObject({ name: 'foreign_ownership_marker', status: 'ok', details: { count: 0 } });

  // A checkout an earlier brain claimed: its reservation and stamp survive the brain.
  const stale = join(home, 'stale'); mkdirSync(stale);
  const staleId = `stale-${randomUUID().slice(0, 6)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [staleId, stale]);
  const retiredBrain = randomUUID();
  const reservation = reservePhysicalRootRecord(stale, { brainId: retiredBrain, worktreeId: randomUUID(), hostId: randomUUID(), coordinationPath: join(home, 'coordination') });
  writePhysicalRootStamp(stale, reservation);
  await expect(claimWorktree(engine, staleId, stale, localHostId())).rejects.toMatchObject({ code: 'recovery_required' });

  const check = await checkForeignOwnershipMarkers(engine);
  expect(check.status).toBe('warn');
  const markers = (check.details as { markers: Array<Record<string, unknown>> }).markers;
  expect(markers.map(marker => marker.path).sort()).toEqual([join(stale, PHYSICAL_ROOT_MARKER), physicalRootReservationPath(stale)].sort());
  for (const marker of markers) expect(marker).toMatchObject({ source_id: staleId, recorded_brain: retiredBrain, worktree_known: false, problem: expect.stringContaining(`records brain ${retiredBrain}`) });
  expect(check.message).toContain(join(stale, PHYSICAL_ROOT_MARKER));
  expect(check.message).toContain('never remove a marker of a brain that is still in use');
  expect(check.message).toContain('recovery_required');

  // A marker that is not a private, well-formed file is reported as unreadable rather than crashing the check.
  const broken = join(home, 'broken'); mkdirSync(broken);
  const brokenId = `broken-${randomUUID().slice(0, 6)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [brokenId, broken]);
  writeFileSync(join(broken, PHYSICAL_ROOT_MARKER), '{"version":1}', { mode: 0o644 });
  const unreadable = (await checkForeignOwnershipMarkers(engine)).details as { markers: Array<Record<string, unknown>> };
  expect(unreadable.markers.find(marker => marker.source_id === brokenId)).toMatchObject({ problem: expect.stringContaining('unreadable') });
}));
