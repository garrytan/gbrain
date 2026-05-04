import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadMounts,
  validateMountId,
  BrainRegistry,
  DuplicateMountPathError,
  UnknownBrainError,
  HOST_BRAIN_ID,
  type MountsFile,
  type MountEntry,
} from '../src/core/brain-registry.ts';
import { GBrainError } from '../src/core/types.ts';

/** Create a temp dir + write a mounts.json into it. Returns the path. */
function tempMountsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-registry-'));
  const path = join(dir, 'mounts.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

const toCleanup: string[] = [];
function track(p: string): string {
  toCleanup.push(p);
  return p;
}
afterEach(() => {
  while (toCleanup.length > 0) {
    const p = toCleanup.pop();
    if (!p) continue;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

describe('validateMountId', () => {
  test('accepts kebab-case ids', () => {
    expect(validateMountId('yc-media')).toBe('yc-media');
    expect(validateMountId('garrys-list')).toBe('garrys-list');
    expect(validateMountId('a')).toBe('a');
    expect(validateMountId('yc1')).toBe('yc1');
  });

  test('rejects empty / non-string', () => {
    expect(() => validateMountId('')).toThrow(GBrainError);
    expect(() => validateMountId(null as unknown as string)).toThrow(GBrainError);
    expect(() => validateMountId(undefined as unknown as string)).toThrow(GBrainError);
    expect(() => validateMountId(42 as unknown as string)).toThrow(GBrainError);
  });

  test('rejects reserved host id', () => {
    expect(() => validateMountId('host')).toThrow(/Reserved/);
  });

  test('rejects invalid patterns', () => {
    expect(() => validateMountId('UPPER')).toThrow();
    expect(() => validateMountId('has space')).toThrow();
    expect(() => validateMountId('-leading')).toThrow();
    expect(() => validateMountId('trailing-')).toThrow();
    expect(() => validateMountId('has_underscore')).toThrow();
    expect(() => validateMountId('a'.repeat(33))).toThrow();
  });
});

describe('loadMounts — file-level parsing', () => {
  test('returns empty array when mounts.json is absent', () => {
    const path = join(tmpdir(), `nonexistent-${Date.now()}.json`);
    expect(loadMounts(path)).toEqual([]);
  });

  test('throws on malformed JSON', () => {
    const path = track(tempMountsFile('{ not valid json'));
    expect(() => loadMounts(path)).toThrow(/Malformed mounts.json/);
  });

  test('throws on unsupported version', () => {
    const path = track(tempMountsFile({ version: 99, mounts: [] }));
    expect(() => loadMounts(path)).toThrow(/Unsupported mounts.json version: 99/);
  });

  test('throws when mounts is not an array', () => {
    const path = track(tempMountsFile({ version: 1, mounts: 'not-an-array' }));
    expect(() => loadMounts(path)).toThrow(/must be an array/);
  });

  test('throws when top-level is not an object', () => {
    const path = track(tempMountsFile([1, 2, 3]));
    expect(() => loadMounts(path)).toThrow(/must be a JSON object/);
  });
});

describe('loadMounts — entry validation', () => {
  test('accepts a minimal pglite entry', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [{ id: 'yc-media', path: '/tmp/yc-media', engine: 'pglite', database_path: '/tmp/yc-media/.pg' }],
    }));
    const mounts = loadMounts(path);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].id).toBe('yc-media');
    expect(mounts[0].engine).toBe('pglite');
    expect(mounts[0].enabled).toBe(true); // default
  });

  test('accepts a postgres entry', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [{
        id: 'yc-politics', path: '/tmp/yc-politics', engine: 'postgres',
        database_url: 'postgresql://localhost/luther',
      }],
    }));
    const mounts = loadMounts(path);
    expect(mounts[0].database_url).toBe('postgresql://localhost/luther');
  });

  test('resolves paths to absolute form', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [{ id: 'a', path: '/tmp/relative-test', engine: 'pglite', database_path: '/tmp/a/.pg' }],
    }));
    const mounts = loadMounts(path);
    expect(mounts[0].path.startsWith('/')).toBe(true);
  });

  test('enabled=false is preserved', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [{
        id: 'disabled-mount', path: '/tmp/disabled', engine: 'pglite',
        database_path: '/tmp/disabled/.pg', enabled: false,
      }],
    }));
    const mounts = loadMounts(path);
    expect(mounts[0].enabled).toBe(false);
  });

  test('rejects duplicate ids', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [
        { id: 'dup', path: '/tmp/a', engine: 'pglite', database_path: '/tmp/a/.pg' },
        { id: 'dup', path: '/tmp/b', engine: 'pglite', database_path: '/tmp/b/.pg' },
      ],
    }));
    expect(() => loadMounts(path)).toThrow(/duplicate id "dup"/);
  });

  test('rejects duplicate paths (Codex finding #9)', () => {
    const path = track(tempMountsFile({
      version: 1,
      mounts: [
        { id: 'first', path: '/tmp/shared', engine: 'pglite', database_path: '/tmp/shared/.pg' },
        { id: 'second', path: '/tmp/shared', engine: 'pglite', database_path: '/tmp/shared/.pg2' },
      ],
    }));
    expect(() => loadMounts(path)).toThrow(DuplicateMountPathError);
  });

  test('rejects entry missing id', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ path: '/tmp/x', engine: 'pglite', database_path: '/tmp/x/.pg' }],
    }));
    expect(() => loadMounts(path)).toThrow(/Invalid mounts\[0\].id/);
  });

  test('rejects entry missing path', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ id: 'no-path', engine: 'pglite', database_path: '/tmp/x/.pg' }],
    }));
    expect(() => loadMounts(path)).toThrow(/path is required/);
  });

  test('rejects invalid engine kind', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ id: 'bad', path: '/tmp/b', engine: 'sqlite' }],
    }));
    expect(() => loadMounts(path)).toThrow(/engine must be "postgres" or "pglite"/);
  });

  test('rejects postgres without database_url', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ id: 'pg-no-url', path: '/tmp/p', engine: 'postgres' }],
    }));
    expect(() => loadMounts(path)).toThrow(/postgres mount requires database_url/);
  });

  test('rejects pglite without database_path or url', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ id: 'pgl-no-path', path: '/tmp/p', engine: 'pglite' }],
    }));
    expect(() => loadMounts(path)).toThrow(/pglite mount requires database_path/);
  });

  test('rejects reserved host id', () => {
    const path = track(tempMountsFile({
      version: 1, mounts: [{ id: 'host', path: '/tmp/h', engine: 'pglite', database_path: '/tmp/h/.pg' }],
    }));
    expect(() => loadMounts(path)).toThrow(/Reserved/);
  });
});

describe('BrainRegistry — resolution', () => {
  test('listBrainIds includes host + enabled mounts only', () => {
    const mounts: MountEntry[] = [
      { id: 'a', path: '/tmp/a', engine: 'pglite', database_path: '/tmp/a/.pg', enabled: true },
      { id: 'b', path: '/tmp/b', engine: 'pglite', database_path: '/tmp/b/.pg', enabled: false },
      { id: 'c', path: '/tmp/c', engine: 'pglite', database_path: '/tmp/c/.pg', enabled: true },
    ];
    const reg = new BrainRegistry(mounts);
    expect(reg.listBrainIds()).toEqual([HOST_BRAIN_ID, 'a', 'c']);
  });

  test('disabled mount → UnknownBrainError', async () => {
    const reg = new BrainRegistry([
      { id: 'disabled', path: '/tmp/d', engine: 'pglite', database_path: '/tmp/d/.pg', enabled: false },
    ]);
    await expect(reg.getBrain('disabled')).rejects.toBeInstanceOf(UnknownBrainError);
  });

  test('unknown id → UnknownBrainError with available list', async () => {
    const reg = new BrainRegistry([
      { id: 'yc-media', path: '/tmp/m', engine: 'pglite', database_path: '/tmp/m/.pg', enabled: true },
    ]);
    try {
      await reg.getBrain('nonexistent');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownBrainError);
      if (e instanceof GBrainError) {
        expect(e.cause_description).toContain('yc-media');
      }
    }
  });

  test('listMounts returns only enabled mounts', () => {
    const reg = new BrainRegistry([
      { id: 'on', path: '/tmp/on', engine: 'pglite', database_path: '/tmp/on/.pg', enabled: true },
      { id: 'off', path: '/tmp/off', engine: 'pglite', database_path: '/tmp/off/.pg', enabled: false },
    ]);
    const listed = reg.listMounts();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('on');
  });

  test('disconnectAll on empty registry is idempotent', async () => {
    const reg = new BrainRegistry([]);
    await reg.disconnectAll();
    await reg.disconnectAll(); // second call must not throw
  });
});

describe('BrainRegistry — lazy init', () => {
  test('getBrain does not connect until called', () => {
    const reg = new BrainRegistry([
      { id: 'lazy', path: '/tmp/lazy', engine: 'pglite', database_path: '/tmp/lazy/.pg', enabled: true },
    ]);
    // No assertion on engine state: we just prove the constructor returned
    // without attempting to touch the filesystem. If init were eager, the
    // constructor would throw on the missing database_path.
    expect(reg.listBrainIds()).toContain('lazy');
  });

  test('empty/null/undefined id routes to host', async () => {
    // We can't actually call getBrain('') without a host config, so we just
    // verify the routing logic by observing the default-branch path. This
    // test proves the fall-through to HOST_BRAIN_ID happens before any
    // lookup, not that host init actually succeeds.
    const reg = new BrainRegistry([]);
    // Expect the host-init path to be attempted (it'll fail on missing
    // ~/.gbrain/config.json in test env, but the error will come from
    // initHostBrain, not UnknownBrainError — proving routing hit host).
    await expect(reg.getBrain(null)).rejects.not.toBeInstanceOf(UnknownBrainError);
    await expect(reg.getBrain(undefined)).rejects.not.toBeInstanceOf(UnknownBrainError);
    await expect(reg.getBrain('')).rejects.not.toBeInstanceOf(UnknownBrainError);
  });
});
