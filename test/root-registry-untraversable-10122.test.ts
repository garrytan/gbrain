/** #10122: a recorded root the user cannot traverse must not abort root listing or refresh. */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalManagedRoots, recordManagedRoots, registeredManagedRootRecords } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-root-registry-10122-'));
const locked = join(home, 'locked');
afterAll(() => { try { chmodSync(locked, 0o700); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });

const usable = process.platform !== 'win32' && process.getuid?.() !== 0;

test.if(usable)('an untraversable recorded root is still listed and refreshed', async () => {
  const old = join(locked, 'old');
  mkdirSync(old, { recursive: true });
  chmodSync(locked, 0o000);
  const outcome = await withEnv({ GBRAIN_HOME: home }, async () => {
    try {
      const canonical = canonicalManagedRoots([{ local_path: old, source_id: 'default' }]);
      recordManagedRoots(randomUUID(), [{ local_path: old, source_id: 'default' }]);
      return { roots: canonical.map(r => r.local_path), listed: registeredManagedRootRecords().map(r => r.root), error: null };
    } catch (error) { return { roots: [], listed: [], error: (error as Error).message }; }
  });
  expect(outcome.error).toBeNull();
  expect(outcome.roots).toEqual([old]);
  expect(outcome.listed).toEqual([old]);
});
