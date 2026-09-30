import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import * as syncAuthority from '../src/core/persistence/sync-authority.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #5632: an interrupted managed sync stores its processing options on the
// cursor. Autopilot (noEmbed+noExtract defaults) and a plain CLI run (neither)
// resolve different defaults, so each refused to finish the other's cursor
// forever. A resume that chose no processing flag now adopts the stored ones.

const home = mkdtempSync(join(tmpdir(), 'gbrain-cursor-options-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine) {
  const id = `options-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
const storedOptions = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ options: unknown }>(
  "SELECT c.completed_keys->0->'processingOptions' AS options FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1", [id]))[0]?.options;
// What each caller passes: the autopilot job fills noEmbed/noExtract defaults; the plain CLI passes no flag.
const autopilot = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] } as SyncOpts);
const plainCli = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, explicitProcessing: [] } as SyncOpts);

test('explicit processing flags are the ones the caller set', () => {
  const explicit = (syncAuthority as Record<string, any>).explicitSyncProcessing;
  expect(explicit({ noEmbed: true, noExtract: false })).toEqual(['noEmbed', 'noExtract']);
  expect(explicit({ noPull: true })).toEqual([]);
});

test('a CLI-partial cursor is finished by an autopilot resume with the stored options', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, plainCli(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect(await storedOptions(engine, id)).toEqual({ noEmbed: false, noExtract: false, noSchemaPack: false });
  expect((await performManagedSync(engine, autopilot(id))).status).toBe('first_sync');
  expect(await engine.getPage('c', { sourceId: id })).not.toBeNull();
  const intents = await engine.executeRaw<{ options: unknown }>("SELECT intent->'processingOptions' AS options FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [id]);
  expect(intents.map(row => row.options)).toEqual(Array(3).fill({ noEmbed: false, noExtract: false, noSchemaPack: false }));
}), 120_000);

test('an autopilot-partial cursor is finished by a plain CLI resume', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, autopilot(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect((await performManagedSync(engine, plainCli(id))).status).toBe('first_sync');
}), 120_000);

test('an explicit conflicting flag refuses with the stored options and the printed resume command finishes the cursor', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, autopilot(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const refused = await performManagedSync(engine, { sourceId: id, noPull: true, noExtract: false, explicitProcessing: ['noExtract'] } as SyncOpts)
    .then(() => null, (error: unknown) => error as { code: string; detail?: string; suggestion?: string });
  expect(refused).toMatchObject({ code: 'invalid_params', detail: 'cursor_processing_options_conflict' });
  expect(refused!.suggestion).toContain('noEmbed=true, noExtract=true, noSchemaPack=false');
  const command = `gbrain sync --source ${id} --no-pull --no-embed --no-extract`;
  expect(refused!.suggestion).toContain(command);
  const args = command.split(' ').slice(2);
  const resumed = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: args.includes('--no-embed'), noExtract: args.includes('--no-extract'),
    explicitProcessing: ['noEmbed', 'noExtract'] } as SyncOpts);
  expect(resumed.status).toBe('first_sync');
}), 120_000);

test('a remote sync job keeps its frozen options while the worker adds explicit processing keys', async () => isolated(async engine => {
  const id = await fixture(engine);
  const clientId = `options-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, id]);
  const ctx = { engine, remote: true, sourceId: id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: id,
    allowedOperations: ['submit_job'] } } as unknown as OperationContext;
  const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
  const explicit = (syncAuthority as Record<string, any>).explicitSyncProcessing;
  const result = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine,
    { ...accepted.data, explicitProcessing: explicit(accepted.data) } as SyncOpts));
  expect(result.status).toBe('first_sync');
  await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]);
}), 120_000);
