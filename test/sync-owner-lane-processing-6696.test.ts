/**
 * #6696 C1, revised by #6712 PR 1: the resident-owner sync lane (`writer_sync` → `runAuthenticatedSyncSlice`) resumes
 * a cursor with the cursor's processing opt-outs.
 *
 * What these tests protect:
 *   - a `false` processing key is not an opt-in that conflicts with the cursor: a flagless resume of a cursor that
 *     stores `noEmbed=true` finishes it instead of refusing `invalid_params`;
 *   - an older CLI's `explicitProcessing` list is accepted and ignored (`WIRE_SKEW_WINDOWS.explicitProcessing`): the
 *     opt-outs are inherited OR-wise, so `['noEmbed']` with `noEmbed=false` finishes with `noEmbed` and reports it.
 *
 * Regression that fails it: the owner lane refusing a resume over processing options, or the wire refusing the list.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runAuthenticatedSyncSlice } from '../src/core/persistence/sync-administration.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-owner-lane-processing-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1' };
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

/** A managed source with an unfinished cursor that stores noEmbed=true (one page of three committed). */
async function partialSource(): Promise<string> {
  const id = `owner-lane-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 3; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i} about acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true } as SyncOpts, { maxPages: 1, maxMs: 1000 }))
    .toMatchObject({ status: 'partial' });
  return id;
}

/** One owner-lane slice as the trusted CLI registration, drained to the end of the run. */
async function slice(options: Record<string, unknown>): Promise<Record<string, unknown> | { error: unknown }> {
  const registration = await registerLocalWriter(engine, 'cli');
  try {
    let result: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      result = await withVerifiedLocalRegistration(engine, { id: registration.id, credential: registration.credential, lane: 'cli' } as never,
        () => runAuthenticatedSyncSlice(engine, { options, cwd: home, timeoutSeconds: 60 }));
      if (result.status !== 'partial') break;
    }
    return result;
  } catch (error) { return { error }; }
}

test('a payload without a list counts only true-valued keys as typed: noEmbed=false adopts the cursor\'s noEmbed=true', async () => withEnv(env, async () => {
  const id = await partialSource();
  expect(await slice({ sourceId: id, noPull: true, noEmbed: false })).toMatchObject({ status: 'first_sync', source_id: id });
  expect(await engine.getPage('notes/n2', { sourceId: id })).not.toBeNull();
}), 180_000);

test('an older CLI\'s list is accepted and ignored: [] and [\'noEmbed\'] with noEmbed=false both inherit the cursor\'s noEmbed', async () => withEnv(env, async () => {
  const listed = await partialSource();
  expect(await slice({ sourceId: listed, noPull: true, noEmbed: false, explicitProcessing: ['noEmbed'] })).toMatchObject({ status: 'first_sync', source_id: listed, inherited_options: ['noEmbed'] });
  expect(await engine.getPage('notes/n2', { sourceId: listed })).not.toBeNull();
  const adopting = await partialSource();
  expect(await slice({ sourceId: adopting, noPull: true, explicitProcessing: [] })).toMatchObject({ status: 'first_sync', source_id: adopting });
}), 180_000);
