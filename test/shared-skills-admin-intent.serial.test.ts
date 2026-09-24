import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

async function fixture(run: (engine: BrainEngine, root: string) => Promise<void>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-shared-admin-')));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      const root = join(home, 'content'); mkdirSync(root);
      try { await run(engine, root); } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('shared activation requires reviewed administration intent and binds the protocol transition', () => fixture(async (engine, root) => {
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await claimWorktree(engine, 'default', root);
  await activatePersistence(engine, { confirmQuiesced: true });
  const state = await writerAdminState(engine);
  const input = { shared_skills: true, confirm_quiesced: true };
  await expect(runPersistenceAdministration(engine, 'writer_activate', input)).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
  await expect(runPersistenceAdministration(engine, 'writer_activate', { ...input, admin_intent: 'writer_claim', expected_state: state }))
    .rejects.toMatchObject({ code: 'writer_admin_intent_required' });
  await expect(runPersistenceAdministration(engine, 'writer_activate', { ...input, admin_intent: 'writer_activate', expected_state: '0'.repeat(64) }))
    .rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(await writerAdminState(engine)).toBe(state);
  expect(await runPersistenceAdministration(engine, 'writer_activate', { ...input, admin_intent: 'writer_activate', expected_state: state }))
    .toMatchObject({ activated: true, protocol_version: 2 });
  expect(await writerAdminState(engine)).not.toBe(state);
  await expect(runPersistenceAdministration(engine, 'writer_activate', { ...input, admin_intent: 'writer_activate', expected_state: state }))
    .rejects.toMatchObject({ code: 'writer_admin_state_changed' });
}), 120_000);

test('shared administration never partially activates an unreviewed base protocol', () => fixture(async (engine, root) => {
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await claimWorktree(engine, 'default', root);
  const state = await writerAdminState(engine);
  const preview = await runPersistenceAdministration(engine, 'writer_activate', { shared_skills: true, confirm_quiesced: true, dry_run: true });
  expect(preview.drift_audit).toMatchObject({ snapshot_only: true });
  expect(await writerAdminState(engine)).toBe(state);
  await expect(runPersistenceAdministration(engine, 'writer_activate', { shared_skills: true, confirm_quiesced: true,
    admin_intent: 'writer_activate', expected_state: state })).rejects.toMatchObject({ code: 'writer_registration_required' });
  expect(await writerAdminState(engine)).toBe(state);
  const [brain] = await engine.executeRaw<{ enabled: boolean; skill_bundles_enabled: boolean }>('SELECT enabled,skill_bundles_enabled FROM persistence_brain');
  expect(brain).toEqual({ enabled: false, skill_bundles_enabled: false });
}), 120_000);

test('shared activation dry-run does not create a missing host identity', () => fixture(async engine => {
  const path = join(persistenceHome(), 'host.json');
  expect(existsSync(path)).toBe(false);
  await expect(activateSharedSkillPersistence(engine, { confirmQuiesced: true, dryRun: true })).rejects.toMatchObject({ code: 'writer_registration_required' });
  expect(existsSync(path)).toBe(false);
}), 120_000);
