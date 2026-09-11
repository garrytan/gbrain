/** Destructive only within an already isolated test database. Rehearse the old queue shape. */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { authorizeLegacyJobs } from '../../src/core/minions/authorize-legacy.ts';
import { assertNoUnreviewedJobs } from '../../src/core/minions/submission-authority.ts';

export async function rehearseMinionAuthorityUpgrade(engine: BrainEngine): Promise<void> {
  const migration = MIGRATIONS.find(m => m.name === 'minion_submission_authority')!;
  // Releases through v0.49 already own these versions. The authority cutover
  // must still execute when upgrading that deployed ledger, not overwrite it.
  expect(MIGRATIONS.find(m => m.version === 147)?.name).toBe('oauth_client_capability_grants');
  expect(MIGRATIONS.find(m => m.version === 148)?.name).toBe('durable_fact_withdrawals');
  expect(migration.version).toBe(149);
  const originalVersion = await engine.getConfig('version');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DROP TRIGGER minion_queue_protocol ON minion_jobs');
  await engine.executeRaw('ALTER TABLE minion_jobs DROP COLUMN submission_authority, DROP COLUMN claim_generation');
  await engine.setConfig('version', '148');
  const upgrade = () => runMigrations(engine);
  try {
    const [old] = await engine.executeRaw<{ id: number }>("INSERT INTO minion_jobs (name, status, data, attempts_made, attempts_started) VALUES ('fixture-upgrade', 'active', $1::jsonb, 2, 2) RETURNING id", [{ example: true }]);
    await expect(upgrade()).rejects.toThrow('Drain or cancel active');
    expect(await engine.getConfig('version')).toBe('148');
    await engine.executeRaw("UPDATE minion_jobs SET status = 'paused' WHERE id = $1", [old.id]);
    await upgrade();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const queue = new MinionQueue(engine);
    const preserved = (await queue.getJob(old.id))!;
    expect(preserved.submission_authority).toBeNull();
    expect(preserved.status).toBe('paused');
    expect(preserved.attempts_made).toBe(2);
    expect(preserved.data).toEqual({ example: true });
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
    await expect(engine.executeRaw("INSERT INTO minion_jobs (name) VALUES ('old-producer')")).rejects.toThrow('protocol 1');
    const preview = await authorizeLegacyJobs(engine, [old.id]);
    await authorizeLegacyJobs(engine, [old.id], preview.snapshot_digest, true);
    await queue.resumeJob(old.id);
    await expect(engine.executeRaw("UPDATE minion_jobs SET status = 'active', lock_token = 'old' WHERE id = $1", [old.id])).rejects.toThrow('old workers');
    expect((await queue.claim('new', 30000, 'default', ['fixture-upgrade']))?.id).toBe(old.id);
  } finally {
    await engine.executeRaw('DELETE FROM minion_jobs');
    // Restore even after a failed assertion; sibling tests keep the current schema.
    await engine.transaction(async tx => { await tx.runMigration(migration.version, migration.sql); });
    await engine.setConfig('version', originalVersion ?? String(LATEST_VERSION));
  }
}
