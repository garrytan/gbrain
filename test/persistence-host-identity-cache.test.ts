import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingLocalHostId, localHostId, localHostIdentity, persistenceHome } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

async function inHome(run: (hostFile: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-host-cache-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      mkdirSync(persistenceHome(), { recursive: true, mode: 0o700 });
      await run(join(persistenceHome(), 'host.json'));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const write = (path: string, id: string) => writeFileSync(path, JSON.stringify({ version: 1, id }), { mode: 0o600 });
/** A settled identity file: modified long enough ago to be cacheable. */
const writeSettled = (path: string, id: string) => { write(path, id); const old = new Date(Date.now() - 60_000); utimesSync(path, old, old); };

describe('host identity cache (stat-keyed)', () => {
  test('a repeated read of a settled, unchanged file is served without reading it again', async () => {
    await inHome(path => {
      writeSettled(path, ID_A);
      expect(localHostId()).toBe(ID_A);
      const reads = spyOn(fs, 'readFileSync');
      try {
        expect(localHostId()).toBe(ID_A);
        expect(localHostIdentity().id).toBe(ID_A);
        expect(existingLocalHostId()).toBe(ID_A);
        expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
      } finally { reads.mockRestore(); }
    });
  });

  test('an in-place edit is seen (mtime and ctime move)', async () => {
    await inHome(path => {
      writeSettled(path, ID_A);
      expect(localHostId()).toBe(ID_A);
      write(path, ID_B);
      expect(localHostId()).toBe(ID_B);
    });
  });

  test('same-size rewrites inside one timestamp tick are each seen (a recent file is never cached)', async () => {
    await inHome(path => {
      for (const id of [ID_A, ID_B, ID_A, ID_B]) {
        write(path, id);
        expect(localHostId()).toBe(id);
      }
    });
  });

  test('a rename over the path is seen (inode moves), as the fixture harness selects a host', async () => {
    await inHome(path => {
      writeSettled(path, ID_A);
      expect(localHostId()).toBe(ID_A);
      const staged = `${path}.staged`;
      writeSettled(staged, ID_B);
      renameSync(staged, path);
      expect(localHostId()).toBe(ID_B);
    });
  });

  test('a different home reads its own identity', async () => {
    await inHome(async path => {
      writeSettled(path, ID_A);
      expect(localHostId()).toBe(ID_A);
      await inHome(inner => {
        writeSettled(inner, ID_B);
        expect(localHostId()).toBe(ID_B);
      });
      expect(localHostId()).toBe(ID_A);
    });
  });

  test('an absent file is never minted by existingLocalHostId, even after a cached read elsewhere', async () => {
    await inHome(async path => {
      writeSettled(path, ID_A);
      expect(localHostId()).toBe(ID_A);
      rmSync(path);
      expect(existingLocalHostId()).toBeNull();
      expect(existsSync(path)).toBe(false);
      const minted = localHostId();
      expect(minted).not.toBe(ID_A);
      expect(JSON.parse(readFileSync(path, 'utf8')).id).toBe(minted);
      expect(localHostId()).toBe(minted);
    });
  });

  test('an invalid identity file throws on every call and is never cached', async () => {
    await inHome(path => {
      writeFileSync(path, JSON.stringify({ version: 2, id: ID_A }), { mode: 0o600 });
      const old = new Date(Date.now() - 60_000); utimesSync(path, old, old);
      for (let i = 0; i < 3; i++) expect(() => localHostId()).toThrow(expect.objectContaining({ code: 'writer_identity_invalid' }));
      expect(() => existingLocalHostId()).toThrow(expect.objectContaining({ code: 'writer_identity_invalid' }));
      write(path, ID_A);
      expect(localHostId()).toBe(ID_A);
    });
  });
});
