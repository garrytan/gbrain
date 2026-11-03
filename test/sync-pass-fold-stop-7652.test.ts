/**
 * #7652 review: a folded stamp commits inside the round's last import and ends the pass row `synced` with the new
 * `converged` watermark. A transient failure after that commit, before the pass adopts the stamp, must not end the row
 * again from the stale in-memory value (`resumable`, the previous target, the writeback list gone).
 */
import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import * as passRowModule from '../src/core/persistence/sync-pass-row.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const readPassRow = passRowModule.readPassRow;
const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitFile = (root: string, name: string) => {
  writeFileSync(join(root, name), `---\ntype: concept\ntitle: ${name}\n---\n\nA note about ${name}.\n`);
  git(root, ['add', '-A']); git(root, ['commit', '-qm', name]);
};

test('a transient stop after a folded stamp committed leaves the synced pass row and its watermark', () => managedBrain(async ({ engine, root }) => {
  const sync = () => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
  await sync();
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const firstPass = (await readPassRow(engine, 'default', incarnation!))!.value.telemetry.pass_id;
  commitFile(root, 'b-example.md');
  const head = git(root, ['rev-parse', 'HEAD']);
  let thrown = false;
  const spy = spyOn(passRowModule, 'readPassRow').mockImplementation((async (...args: Parameters<typeof readPassRow>) => {
    const row = await readPassRow(...args);
    if (!thrown && row?.value.telemetry.outcome === 'synced' && row.value.telemetry.pass_id !== firstPass) {
      thrown = true;
      throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
    }
    return row;
  }) as typeof readPassRow);
  try {
    await expect(sync()).rejects.toThrow('Connection terminated unexpectedly');
  } finally {
    spy.mockRestore();
  }
  expect(thrown).toBe(true);
  const after = (await readPassRow(engine, 'default', incarnation!))!.value;
  expect(after.telemetry.outcome).toBe('synced');
  expect(after.obligations.converged?.target).toBe(head);
  const status = await readSyncStatus(engine, 'default', { detail: false });
  expect([status.state, status.reason]).toEqual(['synced', 'nothing_pending']);
}, { setup: ({ root }) => { git(root, ['init', '-q']); commitFile(root, 'a-example.md'); } }), 120_000);
