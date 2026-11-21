import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedContentRoot } from '../src/core/shared-skills/setup-files.ts';

function outcome(fn: () => string): { value?: string; error?: string } {
  try { return { value: fn() }; } catch (e) { return { error: (e as Error).message }; }
}

describe('checkedContentRoot with OS-level top-level symlinks', () => {
  test('allows /var-style top-level symlink but refuses deeper symlinks', () => {
    const base = mkdtempSync(join(tmpdir(), 'content-root-'));
    try {
      const fakeRoot = join(base, 'os');
      mkdirSync(join(fakeRoot, 'private', 'var'), { recursive: true });
      symlinkSync(join(fakeRoot, 'private', 'var'), join(fakeRoot, 'var'));
      const ok = join(fakeRoot, 'var', 'home', 'content');
      mkdirSync(ok, { recursive: true });
      const allowed = outcome(() => checkedContentRoot(ok, fakeRoot));
      expect(allowed.error).toBeUndefined();
      expect(allowed.value).toBe(ok);

      symlinkSync(join(fakeRoot, 'private'), join(fakeRoot, 'var', 'home', 'link'));
      const refused = outcome(() => checkedContentRoot(join(fakeRoot, 'var', 'home', 'link'), fakeRoot));
      expect(refused.error).toContain('not a real directory');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
