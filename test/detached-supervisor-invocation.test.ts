import { expect, test, spyOn } from 'bun:test';
import * as detached from '../src/core/minions/detached-stderr.ts';

test('a compiled supervisor is re-executed without its virtual source path', () => {
  const args = ['jobs', 'supervisor', 'start', '--queue', 'example'];
  expect(detached.detachedSupervisorArgs('/opt/example/bin/gbrain', '/$bunfs/root/gbrain', args)).toEqual(args);
  expect(detached.detachedSupervisorArgs('/opt/example/bin/bun', '/source/cli.ts', args)).toEqual(['/source/cli.ts', ...args]);
  expect(detached.detachedSupervisorArgs('/opt/example/bin/node', '/source/cli.js', args)).toEqual(['/source/cli.js', ...args]);
  expect(args).toEqual(['jobs', 'supervisor', 'start', '--queue', 'example']);
});

import * as childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withEnv } from './helpers/with-env.ts';
test('the real supervisor launcher forwards compiled arguments to the spawn boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiled-supervisor-proof-'));
  const calls: unknown[][] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((...args: unknown[]) => {
    calls.push(args); return { pid: 123, unref() {} };
  }) as typeof childProcess.spawn);
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      detached.spawnDetachedSupervisor('/opt/example/bin/gbrain', '/$bunfs/root/gbrain', ['jobs', 'supervisor', 'start']);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/opt/example/bin/gbrain');
      expect(calls[0][1]).toEqual(['jobs', 'supervisor', 'start']);
      expect(calls[0][2]).toMatchObject({ detached: true, stdio: ['ignore', 'ignore', expect.any(Number)] });
    });
  } finally {
    spawn.mockRestore();
    const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, 'compiled-supervisor-proof-' + randomUUID()));
  }
});
