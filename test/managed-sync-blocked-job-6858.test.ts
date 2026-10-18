/**
 * #6858 ask 3: a managed sync run stopped on a page that did not commit is no longer invisible. On master every autopilot
 * freshness sync job returned the parked run and ended `completed` (one source stopped 21 h with every job green). Now
 * the job ends dead with the run's next step in its error and progress, doctor `managed_sync_blocked` warns at once and
 * fails past an hour, and get_brain_health turns to `attention` with a `sync_blocked` band. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { managedSyncBlockedEntry } from '../src/commands/doctor/checks/managed-sync-blocked.ts';
import { readBrainHealthBands } from '../src/commands/doctor/brain-health-bands.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6858-blocked-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message: string): string { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
// A pinned import whose canonical correction (a fixable facts fence) must rewrite a file that holds newer uncommitted bytes.
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fixable = (body: string) => `---\ntitle: Fixable\n---\n${body}\n\n${FB}\n${FH}\n| 1 | Sentinelzq8 partners with an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n`;

function job(id: number, data: Record<string, unknown>, progress: unknown[]): MinionJobContext {
  return { id, name: 'sync', data, attempts_made: 0, signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs: Date.now() + 120_000,
    updateProgress: async (p: unknown) => { progress.push(p); }, updateTokens: async () => undefined, log: async () => undefined,
    isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
}

/** A managed source whose next sync stops blocked_by_failures (the old hold policy, sync.holds=fail, keeps the refusal a run failure). */
async function blockedSource(engine: BrainEngine) {
  const id = `blocked-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), note('Alpha one.'));
  commit(root, 'one');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  writeFileSync(join(root, 'a.md'), note('Alpha two.')); writeFileSync(join(root, 'people/fixable.md'), fixable('A synthetic page.'));
  commit(root, 'two');
  writeFileSync(join(root, 'people/fixable.md'), fixable('A synthetic page, edited while the catch-up drained.'));
  return { id, root };
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('#6858: a freshness sync job whose managed run is blocked ends dead with the next step; doctor and get_brain_health go red past the threshold', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  let nth = 0;
  for (const engine of engines) {
    const s = await blockedSource(engine);
    const ctx = { engine } as unknown as DoctorContext;
    const check = async () => (await managedSyncBlockedEntry.run(ctx)) as Check[];
    expect(await check()).toEqual([expect.objectContaining({ name: 'managed_sync_blocked', status: 'ok' })]);
    await engine.setConfig('sync.holds', 'fail');
    const progress: unknown[] = [];
    let thrown: unknown;
    try {
      await makeSyncHandler(engine)(job(920_001 + nth, { sourceId: s.id, repoPath: s.root, pull: false, auto_embed_backfill: false, embed_reason: 'autopilot_freshness' }, progress));
    } catch (error) { thrown = error; } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    // Before #6858 the handler returned the parked run (status blocked_by_failures) and the worker recorded the job completed.
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toContain(`Managed sync of source ${s.id} is blocked`);
    expect((thrown as Error).message).toContain('Next: gbrain sync');
    expect(progress.at(-1)).toMatchObject({ blocked: true, outcome: 'blocked', next: { safe_to_loop: false } });

    const blocked = await readBlockedManagedSyncs(engine, [s.id]);
    expect(blocked).toEqual([expect.objectContaining({ source_id: s.id, code: 'source_changed' })]);
    const [warned] = await check();
    expect(warned).toMatchObject({ name: 'managed_sync_blocked', status: 'warn', fix: { argv: ['gbrain', 'sync', 'status', '--source', s.id, '--json'] } });
    expect(warned!.message).not.toContain('fixable.md');
    const fresh = await readBrainHealthBands(engine, { sourceIds: [s.id] }, Date.now() + 1_000_000 + nth);
    expect(fresh.sync_blocked.band).toBe('none');

    // Blocked for two hours: the check fails and the remote health bands ask for attention.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,first_seen}',to_jsonb((now() - interval '2 hours')::text))
      WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1`, [s.id]);
    const [failed] = await check();
    expect(failed).toMatchObject({ name: 'managed_sync_blocked', status: 'fail' });
    expect(failed!.message).toContain(`${s.id} (source_changed, blocked 1`);
    const stale = await readBrainHealthBands(engine, { sourceIds: [s.id] }, Date.now() + 2_000_000 + nth);
    expect(stale).toMatchObject({ status: 'attention', sync_blocked: { band: '1-9' } });

    // A resumed run saves its cursor after the recorded stop while the failure row stays until the run finishes: it is
    // draining, not blocked. A stop recorded again after that save is blocked again.
    const [{ key }] = await engine.executeRaw<{ key: string }>("SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1", [s.id]);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()+interval '1 minute' WHERE op='managed-sync' AND fingerprint=$1", [key]);
    expect(await readBlockedManagedSyncs(engine, [s.id])).toEqual([]);
    expect(await check()).toEqual([expect.objectContaining({ name: 'managed_sync_blocked', status: 'ok' })]);
    expect((await readBrainHealthBands(engine, { sourceIds: [s.id] }, Date.now() + 3_000_000 + nth)).sync_blocked.band).toBe('none');
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()+interval '2 minutes' WHERE op='managed-sync-failure' AND fingerprint=$1", [key]);
    expect(await readBlockedManagedSyncs(engine, [s.id])).toEqual([expect.objectContaining({ source_id: s.id, code: 'source_changed' })]);
    nth++;
    await disposePersistenceConsumer(engine);
  }
}), 240_000);
