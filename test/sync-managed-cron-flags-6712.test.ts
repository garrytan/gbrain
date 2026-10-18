/**
 * #6712 PR 2: doctor's managed cron recipe (`gbrain sync --all --no-pull --hard-deadline 13m`) and the managed
 * catch-up knobs `--no-bulk` / `--no-lanes` are never refused on a managed source, on any path a CLI sync takes:
 * the in-process run (single source and `--all`), the serve ladder's argv gate, and the PGLite owner lane (which
 * used to refuse `--no-lanes` / `--lanes N`; a PGLite owner runs no bulk lanes, so the CLI accepts and drops them).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseDelegatedSyncArgs } from '../src/commands/sync-delegate.ts';
import { parsePersistenceSyncArgs } from '../src/commands/sync-persistence-delegate.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-cron-flags-'));
let engine: BrainEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1', OPENAI_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const id = `cron-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), '---\ntitle: a\n---\nA durable observation about acme-example.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [id]);
  return id;
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const origError = console.error, origLog = console.log, origWrite = process.stderr.write.bind(process.stderr), origOut = process.stdout.write.bind(process.stdout);
  console.error = () => {}; console.log = () => {};
  process.stderr.write = (() => true) as typeof process.stderr.write; process.stdout.write = (() => true) as typeof process.stdout.write;
  try { return await fn(); } finally { console.error = origError; console.log = origLog; process.stderr.write = origWrite; process.stdout.write = origOut; }
};
const KNOBS = ['--no-pull', '--no-embed', '--no-bulk', '--no-lanes', '--hard-deadline', '13m'];

test('a managed single-source sync with the cron knobs runs and imports', async () => withEnv(env, async () => {
  const id = await fixture();
  await quiet(() => runSync(engine, ['--source', id, ...KNOBS]));
  expect(await engine.getPage('a', { sourceId: id })).not.toBeNull();
}), 120_000);

test('doctor\'s managed cron recipe (--all) runs and imports', async () => withEnv(env, async () => {
  const id = await fixture();
  await quiet(() => runSync(engine, ['--all', ...KNOBS]));
  expect(await engine.getPage('a', { sourceId: id })).not.toBeNull();
}), 120_000);

test('the serve ladder and the PGLite owner lane accept the knobs', async () => {
  expect(parseDelegatedSyncArgs(['--source', 'notes', ...KNOBS])).toEqual({ ok: true, explicitSource: 'notes', options: { noPull: true, noEmbed: true, noBulk: true, lanes: 1 } });
  expect((await parsePersistenceSyncArgs(['--source', 'notes', ...KNOBS], home)).options).toEqual({ sourceId: 'notes', noPull: true, noEmbed: true, noBulk: true });
});
