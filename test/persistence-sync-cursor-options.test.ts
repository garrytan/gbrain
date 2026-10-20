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
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #5632: an interrupted managed sync stores its processing options on the
// cursor. Autopilot (noEmbed+noExtract defaults) and a plain CLI run (neither)
// resolve different defaults, so each refused to finish the other's cursor
// forever. #6712 PR 1 (#6552 §1) rewrote these tests: the options refusal and
// the explicit-flag list are gone. A resume keeps the cursor's accepted
// opt-outs (`inherited_options`), and an opt-out the caller sets applies to the
// requests it freezes from then on; admitted requests keep their frozen options.
// #6712 PR 4b: a non-company source keeps no cursor; the open episode on its pass
// row (`obligations.episode.inherited`) carries the opt-outs instead. A remote
// job's pass is covered by sync-pass-completion-6712.test.ts (it commits its
// one-sided imports and names the owner host).

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
const episodeOptions = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ options: unknown }>(
  "SELECT c.completed_keys->0->'obligations'->'episode'->'inherited' AS options FROM op_checkpoints c WHERE c.op='managed-sync-pass' AND c.completed_keys->0->>'source_id'=$1", [id]))[0]?.options ?? null;
// What each caller passes: the autopilot job fills noEmbed/noExtract defaults; the plain CLI passes no flag.
const autopilot = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true });
const plainCli = (sourceId: string): SyncOpts => ({ sourceId, noPull: true });
const importOptions = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ options: unknown }>(
  "SELECT intent->'processingOptions' AS options FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [id])).map(row => row.options);
const none = { noEmbed: false, noExtract: false, noSchemaPack: false }, unattended = { noEmbed: true, noExtract: true, noSchemaPack: false };

test('a caller\'s processing options are the flags it set; no explicit-flag list remains', () => {
  expect(syncAuthority.syncProcessingOptions({ noEmbed: true, noExtract: false } as SyncOpts)).toEqual({ noEmbed: true, noExtract: false, noSchemaPack: false });
  expect((syncAuthority as Record<string, unknown>).explicitSyncProcessing).toBeUndefined();
  expect((syncAuthority as Record<string, unknown>).typedSyncProcessing).toBeUndefined();
});

test('a CLI-partial cursor is finished by an autopilot resume; its opt-outs apply to the pages it freezes', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, plainCli(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect(await episodeOptions(engine, id)).toBeNull();
  const finished = await performManagedSync(engine, autopilot(id));
  expect(finished.status).toBe('first_sync');
  expect(finished.inherited_options).toBeUndefined();
  expect(await engine.getPage('c', { sourceId: id })).not.toBeNull();
  expect(await importOptions(engine, id)).toEqual([none, unattended, unattended]);
  expect(await episodeOptions(engine, id)).toBeNull();
}), 120_000);

test('an autopilot-partial cursor is finished by a plain CLI resume that keeps its opt-outs', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, autopilot(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect(await episodeOptions(engine, id)).toEqual({ noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' });
  const finished = await performManagedSync(engine, plainCli(id));
  expect(finished.status).toBe('first_sync');
  expect(finished.inherited_options).toEqual(['noEmbed', 'noExtract']);
  expect(await importOptions(engine, id)).toEqual([unattended, unattended, unattended]);
}), 120_000);

// #6552 §1 probe: on the base this resume threw invalid_params (cursor_processing_options_conflict) and printed a command to retype the flags.
test('a resume whose flags differ from the stored options finishes the cursor instead of refusing', async () => isolated(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, autopilot(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const resumed = await performManagedSync(engine, { sourceId: id, noPull: true, noExtract: false, noSchemaPack: true } as SyncOpts);
  expect(resumed.status).toBe('first_sync');
  expect(resumed.inherited_options).toEqual(['noEmbed', 'noExtract']);
  expect(await importOptions(engine, id)).toEqual([unattended, { ...unattended, noSchemaPack: true }, { ...unattended, noSchemaPack: true }]);
}), 120_000);
