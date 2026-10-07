/**
 * #6122(a): a source claimed on a brain whose managed persistence was never activated fences classic sync,
 * and `gbrain sources writer deactivate` used to report `source_bindings: 0` and change nothing, leaving no
 * supported exit. The dry run now lists the claim, the state-bound deactivate releases it (bindings removed,
 * worktree retired, topology change recorded, brain still classic), the sync refusal names both choices behind
 * ask_user, and the unbound-source hint on a classic brain no longer sends the agent into the claim.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resolveSyncPersistenceMode } from '../src/core/persistence/sync-authority.ts';
import { unboundSourceError } from '../src/core/persistence/unbound-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performSync } from '../src/commands/sync.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const admin = (engine: BrainEngine, operation: string, params: Record<string, unknown> = {}) =>
  runPersistenceAdministration(engine, operation as never, params) as Promise<Record<string, any>>;

async function classicBrainWithClaim(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-preactivation-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'content'); mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await claimWorktree(engine, 'default', root);
        await run(engine, root);
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const bindings = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_source_bindings'))[0]!.n);

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6122 pre-activation claim (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('the dry run reports the claim, deactivate releases it and classic sync resumes', () => classicBrainWithClaim(databaseUrl, async (engine, root) => {
    const refusal = await resolveSyncPersistenceMode(engine, { sourceId: 'default' } as never).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'writer_coordinator_required' });
    expect(refusal.suggestion).toContain('gbrain sources writer activate --confirm-quiesced');
    const state = await writerAdminState(engine);
    expect(refusal.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'deactivate', '--admin-intent', 'writer_deactivate', '--expected-state', state],
      preview_argv: ['gbrain', 'sources', 'writer', 'deactivate', '--dry-run', '--json'], consent: ['destructive'] });
    expect(refusal.fix.user_message).toContain('default');

    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry).toMatchObject({ mode: 'classic', deactivated: false, source_bindings: 1, blockers: [],
      pre_activation_claims: [{ source_id: 'default', roots: [expect.any(String)] }],
      apply_command: `gbrain sources writer deactivate --admin-intent writer_deactivate --expected-state ${state}` });
    expect(await writerAdminState(engine)).toBe(state);
    expect(await bindings(engine)).toBe(1);

    const [{ mode_epoch: epochBefore }] = await engine.executeRaw<{ mode_epoch: string }>('SELECT mode_epoch::text FROM persistence_brain WHERE singleton=1');
    const done = await admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: state });
    expect(done).toMatchObject({ mode: 'classic', pre_activation_claims: [{ source_id: 'default' }], retired_worktrees: [{ id: expect.any(String) }] });
    expect(await bindings(engine)).toBe(0);
    const [brain] = await engine.executeRaw<{ enabled: boolean; mode_epoch: string }>('SELECT enabled, mode_epoch::text FROM persistence_brain WHERE singleton=1');
    expect(brain).toEqual({ enabled: false, mode_epoch: epochBefore });
    const [change] = await engine.executeRaw<{ state: string; pre: boolean }>(
      "SELECT state, (outcome->>'pre_activation')::boolean AS pre FROM persistence_topology_changes WHERE operation='writer_deactivate' ORDER BY created_at DESC LIMIT 1");
    expect(change).toEqual({ state: 'committed', pre: true });
    expect(await resolveSyncPersistenceMode(engine, { sourceId: 'default' } as never)).toBe(false);
    const synced = await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, noExtract: true });
    expect(['first_sync', 'synced']).toContain(synced.status);
    expect((await engine.getPage('notes/alice-example', { sourceId: 'default' }))?.title).toBe('Alice Example');

    // The source can be claimed again later (the retired worktree does not wedge its root).
    await claimWorktree(engine, 'default', root);
    expect(await bindings(engine)).toBe(1);
  }), 120_000);

  test('a stale expected state refuses and releases nothing', () => classicBrainWithClaim(databaseUrl, async engine => {
    await expect(admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    expect(await bindings(engine)).toBe(1);
  }), 120_000);
});

test('the unbound-source hint on a classic brain names the file and classic sync, and what a claim would block', () => {
  const classic = unboundSourceError('notes-example', '/srv/notes', 'file_backed', true).suggestion!;
  expect(classic).toContain('gbrain sync --source notes-example');
  expect(classic).toContain('gbrain sources writer deactivate');
  // A claim is offered only together with activation, never alone, and after the classic edit-and-sync path.
  expect(classic).toContain('gbrain sources writer activate --confirm-quiesced --dry-run --json');
  expect(classic.indexOf('gbrain sync --source notes-example')).toBeLessThan(classic.indexOf('gbrain sources writer claim notes-example'));
  const managed = unboundSourceError('notes-example', '/srv/notes', 'file_backed').suggestion!;
  expect(managed).toContain('gbrain sources writer claim notes-example --path /srv/notes');
});
