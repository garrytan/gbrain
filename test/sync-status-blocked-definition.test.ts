/**
 * GBRA-150: one meaning of "blocked". A sync run (its drain outcome) and a sync job's `blocked` progress call a source
 * blocked only when it cannot advance without a person or an operator. `foresights sync status` used to say
 * `blocked / needs_human` for one file hold that waits on a person while the run that recorded it ended `synced` and
 * the rest of the source kept syncing, so a landing check reading jobs and an agent reading status disagreed. Now a
 * person-waiting file hold reads `synced` with reason `held_needs_human`; `needs_human` and `next` still carry the
 * decision; a run that stopped on a decision still reads blocked. Red on master: the state there is ['blocked', 'needs_human'].
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { syncStatusHeadline } from '../src/commands/sync/operator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-blocked-def-'));
let engine: BrainEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a file hold that waits on a person reads synced/held_needs_human, like the run that recorded it, with the decision still in needs_human and next', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = `bd-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), note('Alpha one.')); writeFileSync(join(root, 'd.md'), note('Delta one.'));
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
  expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
  writeFileSync(join(root, 'a.md'), note('Alpha two.')); writeFileSync(join(root, 'd.md'), note('Delta two.'));
  commit(root, 'version two');
  await engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.putPage('d', { type: 'note', title: 'Example', compiled_truth: 'Delta, edited in the database.', timeline: '', frontmatter: {}, content_hash: 'd-db' }, { sourceId: id }), TEST_WRITE_ATTRIBUTION));
  const run = await performManagedSync(engine, opts);
  expect(run.status).toBe('synced');
  expect(run.held?.map(hold => [hold.path, hold.code])).toEqual([['d.md', 'file_drift']]);
  expect((await engine.getPage('a', { sourceId: id }))?.compiled_truth).toContain('Alpha two.');

  const status = await readSyncStatus(engine, id);
  expect(status.holds.map(hold => [hold.path, hold.needs_human])).toEqual([['d.md', true]]);
  expect([status.state, status.reason]).toEqual(['synced', 'held_needs_human']);
  expect(status.needs_human).toBe(true);
  expect(status.needs_human_from).toEqual({ kind: 'hold', path: 'd.md', slug: 'd', code: 'file_drift' });
  expect(status.next).toMatchObject({ argv: ['gbrain', 'repair', 'file-drift', '--source', id, '--slug', 'd', '--prefer', 'database'] });
  expect(status.next!.user_message).toContain('page d');
  expect(syncStatusHeadline(status)).toBe(`Source ${id} is synced except 1 held file(s), some waiting on a person (see NEEDS HUMAN below); the rest keeps syncing.`);
}), 240_000);
