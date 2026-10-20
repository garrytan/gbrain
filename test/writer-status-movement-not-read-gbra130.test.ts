/**
 * GBRA-130 A-59 (#6712 PR 4b): `sources writer status` read source movement with `.catch(() => [])`, so a failed read
 * reported `movement: []`, which reads as "no managed source has anything to move" exactly when the reader could not tell.
 *
 * Protects (red before: `movement` is `[]`): with the movement reader failing, `movement` is
 * `{ status: 'not_read', code, fix }` naming the read-only movement command; with it working it stays the per-source list.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import * as movement from '../src/core/persistence/sync-movement.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const setup = ({ root }: { root: string }) => {
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'a.md'), '---\ntitle: A\n---\nAlpha.\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed']);
};

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-59: writer status when the movement read fails`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  let spy: { mockRestore(): void } | undefined;
  afterEach(() => { spy?.mockRestore(); spy = undefined; });
  test('movement is not_read with its code and the movement command, never an empty list', () => managedBrain(async ({ engine }) => {
    const ok = await runPersistenceAdministration(engine, 'writer_status', { source_id: 'default' });
    expect(Array.isArray(ok.movement)).toBe(true);
    spy = spyOn(movement, 'readSourceMovement').mockImplementation(async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); });
    const status = await runPersistenceAdministration(engine, 'writer_status', { source_id: 'default' });
    expect(status.movement).toMatchObject({ status: 'not_read', code: '57014', fix: { argv: ['gbrain', 'sources', 'writer', 'movement', 'default', '--json'] } });
  }, { databaseUrl, setup }), 120_000);
});
