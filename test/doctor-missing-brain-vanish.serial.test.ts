/**
 * Protects: doctor's missing-brain check refuses (and so creates nothing) when the configured PGLite folder
 * cannot be stat'ed, for example because it vanished between the existence test and the stat (a drive
 * unmounting), instead of reading the failed stat as "the brain is there" and letting the connect build an
 * empty datastore. A mounts.json that does not load is not a missing brain: the check stays out of the way and
 * the registry reports that file's own error.
 * Fails when: connectWouldCreate answers false on a failed stat, or missingState throws on a bad mounts.json.
 * Seam: mock.module('node:fs') makes statSync throw ENOENT for one path.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

const realFs = { ...fs };
const home = realFs.mkdtempSync(join(tmpdir(), 'gbrain-doctor-vanish-'));
const store = join(home, '.gbrain', 'brain.pglite');
realFs.mkdirSync(store, { recursive: true });
realFs.writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: store }) + '\n');
let failPath: string | null = null;

mock.module('node:fs', () => ({
  ...realFs,
  statSync: (path: fs.PathLike, ...rest: unknown[]) => {
    if (failPath !== null && String(path) === failPath) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${String(path)}'`), { code: 'ENOENT' });
    }
    return (realFs.statSync as (...args: unknown[]) => unknown)(path, ...rest);
  },
}));
const { missingBrainRefusal } = await import('../src/commands/doctor/missing-brain.ts');

afterAll(() => realFs.rmSync(home, { recursive: true, force: true }));

describe('doctor missing-brain check on reads that fail', () => {
  test('a brain folder whose stat fails is refused as missing, not opened', async () => {
    failPath = store;
    try {
      const refusal = await withEnv({ GBRAIN_HOME: home, HOME: home }, () => missingBrainRefusal('host'));
      expect(refusal?.code).toBe('brain_missing');
    } finally {
      failPath = null;
    }
  });

  test('a mounts.json that does not load is left to the registry, not reported as a missing brain', async () => {
    realFs.writeFileSync(join(home, '.gbrain', 'mounts.json'), '{not json');
    try {
      const refusal = await withEnv({ GBRAIN_HOME: home, HOME: home }, () => missingBrainRefusal('team'));
      expect(refusal).toBeNull();
    } finally {
      realFs.rmSync(join(home, '.gbrain', 'mounts.json'), { force: true });
    }
  });
});
