import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findRepoRoot } from '../src/core/repo-root.ts';

describe('findRepoRoot', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const p = created.pop()!;
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'repo-root-'));
    created.push(dir);
    return dir;
  }

  function seedRepo(dir: string): void {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'RESOLVER.md'), '# RESOLVER\n');
  }

  it('finds skills/RESOLVER.md in the passed startDir on first iteration', () => {
    const root = scratch();
    seedRepo(root);
    expect(findRepoRoot(root)).toBe(root);
  });

  it('walks up N directories to find the repo root', () => {
    const root = scratch();
    seedRepo(root);
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('returns null when no skills/RESOLVER.md exists up to filesystem root', () => {
    const empty = scratch();
    // Deliberately no seedRepo — empty dir; walk terminates at filesystem root.
    expect(findRepoRoot(empty)).toBeNull();
  });

  it('default arg uses process.cwd() (behavioral parity with prior doctor-private impl)', () => {
    // The default arg must match calling with an explicit process.cwd().
    // Don't assert on the path contents — it varies between local checkouts
    // and CI runners. What matters is parity: no-arg === cwd-arg.
    expect(findRepoRoot()).toBe(findRepoRoot(process.cwd()));
  });
});
