import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveBrainId, __testing } from '../src/core/brain-resolver.ts';
import { HOST_BRAIN_ID, type MountEntry } from '../src/core/brain-registry.ts';

const toCleanup: string[] = [];
const originalEnv = { ...process.env };

function mktmp(prefix = 'brain-resolver-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  toCleanup.push(dir);
  return dir;
}

beforeEach(() => {
  // Clear relevant env so tests don't leak.
  delete process.env.GBRAIN_BRAIN_ID;
});

afterEach(() => {
  process.env = { ...originalEnv };
  while (toCleanup.length > 0) {
    const p = toCleanup.pop();
    if (!p) continue;
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function noMounts(): MountEntry[] { return []; }

describe('resolveBrainId — priority order', () => {
  test('explicit flag beats everything else', () => {
    process.env.GBRAIN_BRAIN_ID = 'from-env';
    const dir = mktmp();
    writeFileSync(join(dir, '.gbrain-mount'), 'from-dotfile\n');
    const mounts: MountEntry[] = [
      { id: 'from-path', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId('explicit-wins', dir, () => mounts)).toBe('explicit-wins');
  });

  test('env var beats dotfile + path', () => {
    process.env.GBRAIN_BRAIN_ID = 'from-env';
    const dir = mktmp();
    writeFileSync(join(dir, '.gbrain-mount'), 'from-dotfile\n');
    const mounts: MountEntry[] = [
      { id: 'from-path', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe('from-env');
  });

  test('dotfile beats path-prefix', () => {
    const dir = mktmp();
    writeFileSync(join(dir, '.gbrain-mount'), 'from-dotfile\n');
    const mounts: MountEntry[] = [
      { id: 'from-path', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe('from-dotfile');
  });

  test('path-prefix match used when no higher-priority signal', () => {
    const dir = mktmp();
    const mounts: MountEntry[] = [
      { id: 'yc-media', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe('yc-media');
  });

  test('falls back to host when no signal present', () => {
    const dir = mktmp();
    expect(resolveBrainId(null, dir, noMounts)).toBe(HOST_BRAIN_ID);
    expect(resolveBrainId(undefined, dir, noMounts)).toBe(HOST_BRAIN_ID);
    expect(resolveBrainId('', dir, noMounts)).toBe(HOST_BRAIN_ID);
  });
});

describe('resolveBrainId — dotfile behavior', () => {
  test('walks up to find .gbrain-mount in ancestor', () => {
    const parent = mktmp();
    const nested = join(parent, 'deep/nested/dir');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(parent, '.gbrain-mount'), 'luther\n');
    expect(resolveBrainId(null, nested, noMounts)).toBe('luther');
  });

  test('skips malformed dotfile, keeps walking', () => {
    const grandparent = mktmp();
    const parent = join(grandparent, 'mid');
    const child = join(parent, 'deep');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, '.gbrain-mount'), '!!!invalid!!!\n');
    writeFileSync(join(grandparent, '.gbrain-mount'), 'valid-id\n');
    expect(resolveBrainId(null, child, noMounts)).toBe('valid-id');
  });

  test('accepts "host" in dotfile (explicit opt-out of mount routing)', () => {
    const dir = mktmp();
    writeFileSync(join(dir, '.gbrain-mount'), `${HOST_BRAIN_ID}\n`);
    // Even with a mount whose path contains cwd, dotfile wins and picks host.
    const mounts: MountEntry[] = [
      { id: 'would-match', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe(HOST_BRAIN_ID);
  });

  test('trims whitespace + only uses first line', () => {
    const dir = mktmp();
    writeFileSync(join(dir, '.gbrain-mount'), '  yc-media  \n# comment line\n');
    expect(resolveBrainId(null, dir, noMounts)).toBe('yc-media');
  });
});

describe('resolveBrainId — path-prefix match', () => {
  test('longest-prefix wins for nested mounts', () => {
    const parent = mktmp();
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    const mounts: MountEntry[] = [
      { id: 'outer', path: parent, engine: 'pglite', database_path: `${parent}/.pg`, enabled: true },
      { id: 'inner', path: child, engine: 'pglite', database_path: `${child}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, child, () => mounts)).toBe('inner');
  });

  test('disabled mount is ignored', () => {
    const dir = mktmp();
    const mounts: MountEntry[] = [
      { id: 'off', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: false },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe(HOST_BRAIN_ID);
  });

  test('sibling directory does not match', () => {
    const parent = mktmp();
    const a = join(parent, 'a');
    const b = join(parent, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const mounts: MountEntry[] = [
      { id: 'a-mount', path: a, engine: 'pglite', database_path: `${a}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, b, () => mounts)).toBe(HOST_BRAIN_ID);
  });

  test('exact path match works', () => {
    const dir = mktmp();
    const mounts: MountEntry[] = [
      { id: 'exact', path: dir, engine: 'pglite', database_path: `${dir}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, dir, () => mounts)).toBe('exact');
  });

  test('prefix-without-separator does NOT match (no false positive)', () => {
    // Ensure /tmp/foo does NOT match /tmp/foobar. Resolver must require / boundary.
    const parent = mktmp();
    const foo = join(parent, 'foo');
    const foobar = join(parent, 'foobar');
    mkdirSync(foo, { recursive: true });
    mkdirSync(foobar, { recursive: true });
    const mounts: MountEntry[] = [
      { id: 'foo', path: foo, engine: 'pglite', database_path: `${foo}/.pg`, enabled: true },
    ];
    expect(resolveBrainId(null, foobar, () => mounts)).toBe(HOST_BRAIN_ID);
  });
});

describe('resolveBrainId — validation', () => {
  test('invalid --brain value throws', () => {
    expect(() => resolveBrainId('UPPERCASE', '/tmp', noMounts)).toThrow();
    expect(() => resolveBrainId('has space', '/tmp', noMounts)).toThrow();
    expect(() => resolveBrainId('-leading', '/tmp', noMounts)).toThrow();
  });

  test('invalid GBRAIN_BRAIN_ID value throws', () => {
    process.env.GBRAIN_BRAIN_ID = 'UPPER';
    expect(() => resolveBrainId(null, '/tmp', noMounts)).toThrow();
  });

  test('mounts loader failure falls through to host (no crash)', () => {
    const badLoader = () => { throw new Error('mounts.json exploded'); };
    // Should NOT throw: resolver swallows loader failures and returns host.
    // Any downstream brain registry call will surface the real error.
    expect(resolveBrainId(null, '/tmp', badLoader)).toBe(HOST_BRAIN_ID);
  });
});

describe('longestPathPrefixMount', () => {
  test('returns null when no mount contains cwd', () => {
    const result = __testing.longestPathPrefixMount([], '/tmp');
    expect(result).toBeNull();
  });
});
