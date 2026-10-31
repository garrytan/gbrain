/** A non-Git source root must not make its enclosing checkout managed. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isManagedFilesystemPath } from '../src/core/persistence/filesystem-guard.ts';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

test('a non-Git managed root inside a checkout marks only its own directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-root-7988-'));
  try {
    await withEnv({ GBRAIN_HOME: join(home, 'brain') }, () => {
      execFileSync('git', ['-C', home, 'init', '-q']);
      const root = join(home, '.gbrain', 'clones', 'calendar-example');
      mkdirSync(root, { recursive: true });
      recordManagedRoots(randomUUID(), [{ local_path: root, source_id: 'calendar-example' }]);

      expect(existsSync(join(home, '.git', 'gbrain-managed.json'))).toBe(false);
      expect(existsSync(join(root, '.gbrain-managed'))).toBe(true);
      expect(isManagedFilesystemPath(join(root, 'notes.md'))).toBe(true);
      expect(isManagedFilesystemPath(join(home, 'ordinary.txt'))).toBe(false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
