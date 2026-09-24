import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeCompiledSmokeDirectory } from '../../scripts/native/compiled-smoke-cleanup.ts';

describe('compiled native smoke cleanup', () => {
  test('removes the fixture after Windows releases a transient busy handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-native-cleanup-'));
    writeFileSync(join(root, 'probe.exe'), 'fixture');
    const busy = Object.assign(new Error('fixture handle is busy'), { code: 'EBUSY' });
    const waits: number[] = [];
    let attempts = 0;
    try {
      await removeCompiledSmokeDirectory(root, {
        platform: 'win32',
        remove: path => {
          if (++attempts <= 2) throw busy;
          rmSync(path, { recursive: true, force: true });
        },
        wait: async milliseconds => { waits.push(milliseconds); },
      });
      expect(attempts).toBe(3);
      expect(waits).toEqual([100, 200]);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persistent Windows EBUSY fails after a bounded cleanup allowance', async () => {
    const busy = Object.assign(new Error('still busy'), { code: 'EBUSY' });
    const waits: number[] = [];
    let attempts = 0;
    await expect(removeCompiledSmokeDirectory('unused-injected-fixture', {
      platform: 'win32',
      remove: () => { attempts++; throw busy; },
      wait: async milliseconds => { waits.push(milliseconds); },
    })).rejects.toBe(busy);
    expect(attempts).toBe(6);
    expect(waits).toEqual([100, 200, 300, 400, 500]);
  });

  test.each(['EACCES', 'EPERM', 'ENOTEMPTY', undefined])('does not retry Windows %s errors', async code => {
    const failure = Object.assign(new Error('cleanup failed'), { code });
    let attempts = 0;
    let waits = 0;
    await expect(removeCompiledSmokeDirectory('unused-injected-fixture', {
      platform: 'win32',
      remove: () => { attempts++; throw failure; },
      wait: async () => { waits++; },
    })).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(waits).toBe(0);
  });

  test.each(['linux', 'darwin'] as const)('does not retry EBUSY on %s', async platform => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    let attempts = 0;
    let waits = 0;
    await expect(removeCompiledSmokeDirectory('unused-injected-fixture', {
      platform,
      remove: () => { attempts++; throw busy; },
      wait: async () => { waits++; },
    })).rejects.toBe(busy);
    expect(attempts).toBe(1);
    expect(waits).toBe(0);
  });
});
