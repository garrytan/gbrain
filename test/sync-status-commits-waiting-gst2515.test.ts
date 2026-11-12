/**
 * GST-2515: a source whose checkout has commits past its last synced commit read "synced, nothing pending" whenever no
 * write, pass or hold was open, because the state never compared HEAD with the last synced commit. It now reads
 * resumable / commits_waiting with a next that runs the sync, and synced again once that sync imports them.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/one.md'), '---\ntitle: One\n---\n\nThe first note.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'one');
  };
  test('[' + backend + '] commits past the last synced commit read commits_waiting until a sync imports them', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    expect(await readSyncStatus(engine, 'default')).toMatchObject({ state: 'synced', reason: 'nothing_pending' });
    writeFileSync(join(root, 'notes/two.md'), '---\ntitle: Two\n---\n\nThe second note.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'two');
    const waiting = await readSyncStatus(engine, 'default');
    expect(waiting).toMatchObject({ state: 'resumable', reason: 'commits_waiting' });
    expect(waiting.next?.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    expect(waiting.next?.argv).toContain('default');
    expect(waiting.next?.why).toContain('1 commit(s) past the last synced commit');
    await performManagedSync(engine, OPTS);
    expect(await readSyncStatus(engine, 'default')).toMatchObject({ state: 'synced', reason: 'nothing_pending', last_commit: git(root, 'rev-parse', 'HEAD') });
  }, { databaseUrl, setup }), 120_000);
  test('[' + backend + '] a company-brain source, which syncs to its approved revision, never reads commits_waiting', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"company_brain":{}}'::jsonb WHERE id='default'`);
    writeFileSync(join(root, 'notes/two.md'), '---\ntitle: Two\n---\n\nThe second note.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'two');
    expect((await readSyncStatus(engine, 'default')).reason).not.toBe('commits_waiting');
  }, { databaseUrl, setup }), 120_000);
}
