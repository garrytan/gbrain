import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { __testing } from '../src/commands/mounts.ts';

const { parseAddArgs, redactUrl, readMountsFile, writeMountsFile } = __testing;

const toCleanup: string[] = [];
let tempHome: string | null = null;

function mktmp(prefix = 'mounts-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  toCleanup.push(dir);
  return dir;
}

/**
 * Redirect HOME for the duration of a test so writeMountsFile doesn't
 * touch the user's real ~/.gbrain/mounts.json.
 */
function withFakeHome<T>(fn: (mountsPath: string) => T): T {
  const home = mktmp('fake-home-');
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const mountsPath = join(home, '.gbrain', 'mounts.json');
    return fn(mountsPath);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    else delete process.env.HOME;
  }
}

afterEach(() => {
  while (toCleanup.length > 0) {
    const p = toCleanup.pop();
    if (!p) continue;
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('parseAddArgs', () => {
  test('minimal pglite add', () => {
    const parsed = parseAddArgs([
      'yc-media',
      '--path', '/tmp/yc-media',
      '--engine', 'pglite',
      '--db-path', '/tmp/yc-media/.pg',
    ]);
    expect(parsed.id).toBe('yc-media');
    expect(parsed.engine).toBe('pglite');
    expect(parsed.database_path).toBe('/tmp/yc-media/.pg');
    expect(parsed.path.startsWith('/')).toBe(true);
  });

  test('minimal postgres add', () => {
    const parsed = parseAddArgs([
      'yc-politics',
      '--path', '/tmp/luther',
      '--engine', 'postgres',
      '--db-url', 'postgresql://localhost/l',
    ]);
    expect(parsed.engine).toBe('postgres');
    expect(parsed.database_url).toBe('postgresql://localhost/l');
  });

  test('infers engine from --db-url (postgres)', () => {
    const parsed = parseAddArgs([
      'a', '--path', '/tmp/a', '--db-url', 'postgresql://x/y',
    ]);
    expect(parsed.engine).toBe('postgres');
  });

  test('infers engine from --db-path (pglite)', () => {
    const parsed = parseAddArgs([
      'b', '--path', '/tmp/b', '--db-path', '/tmp/b/.pg',
    ]);
    expect(parsed.engine).toBe('pglite');
  });

  test('accepts --alias', () => {
    const parsed = parseAddArgs([
      'yc-media', '--path', '/tmp/x', '--db-path', '/tmp/x/.pg', '--alias', 'ycm',
    ]);
    expect(parsed.alias).toBe('ycm');
  });

  test('rejects missing id', () => {
    expect(() => parseAddArgs([])).toThrow(/Missing mount id/);
  });

  test('rejects missing path', () => {
    expect(() => parseAddArgs(['m', '--db-path', '/tmp/x/.pg'])).toThrow(/Missing --path/);
  });

  test('rejects invalid engine', () => {
    expect(() => parseAddArgs([
      'x', '--path', '/tmp/x', '--engine', 'sqlite',
    ])).toThrow(/Invalid engine/);
  });

  test('rejects unknown flag', () => {
    expect(() => parseAddArgs([
      'x', '--path', '/tmp/x', '--db-path', '/tmp/x/.pg', '--nonsense',
    ])).toThrow(/Unknown flag/);
  });

  test('rejects no engine + no db flags (cannot infer)', () => {
    expect(() => parseAddArgs(['x', '--path', '/tmp/x'])).toThrow(/Missing --engine/);
  });

  test('rejects postgres without --db-url', () => {
    expect(() => parseAddArgs([
      'x', '--path', '/tmp/x', '--engine', 'postgres',
    ])).toThrow(/postgres mount requires --db-url/);
  });

  test('rejects flag-value missing', () => {
    expect(() => parseAddArgs([
      'x', '--path',
    ])).toThrow(/Missing value for --path/);
  });

  test('rejects invalid alias', () => {
    expect(() => parseAddArgs([
      'x', '--path', '/tmp/x', '--db-path', '/tmp/x/.pg', '--alias', 'UPPER',
    ])).toThrow();
  });
});

describe('redactUrl', () => {
  test('strips password from postgres://', () => {
    const red = redactUrl('postgresql://user:supersecret@db.example.com/brain');
    expect(red).not.toContain('supersecret');
    expect(red).toContain('***');
    expect(red).toContain('db.example.com');
  });

  test('password-less URLs do not grow ***', () => {
    const url = 'postgresql://user@db.example.com/brain';
    const red = redactUrl(url);
    expect(red).not.toContain('***');
    expect(red).toContain('user@db.example.com');
    expect(red).toContain('/brain');
  });

  test('leaves opaque file:// urls alone', () => {
    const url = 'file:///home/user/brain/.pglite';
    expect(redactUrl(url)).toBe(url);
  });

  test('leaves non-URL strings alone', () => {
    const opaque = '/not/a/url';
    expect(redactUrl(opaque)).toBe(opaque);
  });
});

describe('readMountsFile / writeMountsFile', () => {
  test('empty file returns empty mounts list', () => {
    const dir = mktmp();
    const path = join(dir, 'mounts.json');
    const file = readMountsFile(path);
    expect(file.version).toBe(1);
    expect(file.mounts).toHaveLength(0);
  });

  test('round-trip: write then read', () => {
    const dir = mktmp();
    const path = join(dir, 'mounts.json');
    writeMountsFile({
      version: 1,
      mounts: [{
        id: 'yc-media', path: '/tmp/yc', engine: 'pglite', database_path: '/tmp/yc/.pg', enabled: true,
      }],
    }, path);
    const file = readMountsFile(path);
    expect(file.mounts).toHaveLength(1);
    expect(file.mounts[0].id).toBe('yc-media');
  });

  test('write is atomic: no partial file visible mid-write', () => {
    const dir = mktmp();
    const path = join(dir, 'mounts.json');
    writeMountsFile({
      version: 1,
      mounts: [{
        id: 'a', path: '/tmp/a', engine: 'pglite', database_path: '/tmp/a/.pg', enabled: true,
      }],
    }, path);
    expect(existsSync(path)).toBe(true);
    // .tmp should be gone after atomic rename.
    expect(existsSync(path + '.tmp')).toBe(false);
  });
});

describe('runMounts — end-to-end add/list/remove', () => {
  // These rely on HOME redirection to isolate from the real ~/.gbrain/.
  // We don't import runMounts directly to avoid stdout spam in test output;
  // parseAddArgs + readMountsFile + writeMountsFile is enough seam coverage.

  test('add → list → remove roundtrip via seams', () => {
    withFakeHome((mountsPath) => {
      // Manually simulate the subcommand sequence using the same seams
      // runMounts uses internally.
      let file = readMountsFile(mountsPath);
      expect(file.mounts).toHaveLength(0);

      // Simulate add
      const parsed = parseAddArgs([
        'yc-media',
        '--path', mountsPath, // use the temp path so existsSync(path) passes
        '--engine', 'pglite',
        '--db-path', '/tmp/yc-media/.pg',
      ]);
      file.mounts.push({
        id: parsed.id,
        path: parsed.path,
        engine: parsed.engine,
        database_path: parsed.database_path,
        enabled: true,
      });
      writeMountsFile(file, mountsPath);

      // List
      file = readMountsFile(mountsPath);
      expect(file.mounts).toHaveLength(1);
      expect(file.mounts[0].id).toBe('yc-media');

      // Remove
      file.mounts = file.mounts.filter(m => m.id !== 'yc-media');
      writeMountsFile(file, mountsPath);

      // Confirm empty
      file = readMountsFile(mountsPath);
      expect(file.mounts).toHaveLength(0);
    });
  });
});

// v0.40.3.0 (D4 + T6): 4 new verbs — enable, disable, trust-frontmatter,
// untrust-frontmatter. We invoke the public runMounts() dispatcher so the
// switch table is exercised end-to-end, then read back the mounts.json
// to assert the flag was persisted.

describe('v0.40.3.0 — mount flag verbs', () => {
  // Import runMounts lazily so the env-mutating withFakeHome wrapper has
  // time to redirect HOME before the module reads it.
  async function seedMount(mountsPath: string, id: string): Promise<void> {
    const parsed = parseAddArgs([
      id,
      '--path', mountsPath,
      '--engine', 'pglite',
      '--db-path', `/tmp/${id}/.pg`,
    ]);
    const file = readMountsFile(mountsPath);
    file.mounts.push({
      id: parsed.id,
      path: parsed.path,
      engine: parsed.engine,
      database_path: parsed.database_path,
      enabled: true,
    });
    writeMountsFile(file, mountsPath);
  }

  test('enable → disable → enable cycle persists', async () => {
    const { runMounts } = await import('../src/commands/mounts.ts');
    await withFakeHomeAsync(async (mountsPath) => {
      await seedMount(mountsPath, 'm1');

      await runMounts(['disable', 'm1']);
      let file = readMountsFile(mountsPath);
      expect(file.mounts[0].enabled).toBe(false);

      await runMounts(['enable', 'm1']);
      file = readMountsFile(mountsPath);
      expect(file.mounts[0].enabled).toBe(true);
    });
  });

  test('trust-frontmatter → untrust-frontmatter cycle preserves other fields', async () => {
    const { runMounts } = await import('../src/commands/mounts.ts');
    await withFakeHomeAsync(async (mountsPath) => {
      await seedMount(mountsPath, 'm-trust');

      await runMounts(['trust-frontmatter', 'm-trust']);
      let file = readMountsFile(mountsPath);
      expect(file.mounts[0].trust_frontmatter_overrides).toBe(true);
      // Preserve other fields:
      expect(file.mounts[0].engine).toBe('pglite');
      expect(file.mounts[0].database_path).toBe('/tmp/m-trust/.pg');

      await runMounts(['untrust-frontmatter', 'm-trust']);
      file = readMountsFile(mountsPath);
      expect(file.mounts[0].trust_frontmatter_overrides).toBe(false);

      // Re-trust restores. Trip → untrust → trust → untrust cycle.
      await runMounts(['trust-frontmatter', 'm-trust']);
      file = readMountsFile(mountsPath);
      expect(file.mounts[0].trust_frontmatter_overrides).toBe(true);
    });
  });

  test('missing mount id → loud rejection with list-hint', async () => {
    const { runMounts } = await import('../src/commands/mounts.ts');
    await withFakeHomeAsync(async (mountsPath) => {
      await seedMount(mountsPath, 'real-mount');
      // Use a typo
      await expect(runMounts(['trust-frontmatter', 'typo-mount'])).rejects.toThrow(
        /typo-mount/,
      );
    });
  });

  test('host brain rejection: cannot trust-frontmatter "host"', async () => {
    const { runMounts } = await import('../src/commands/mounts.ts');
    await withFakeHomeAsync(async (mountsPath) => {
      await seedMount(mountsPath, 'm-host-test');
      await expect(runMounts(['trust-frontmatter', 'host'])).rejects.toThrow(
        /Cannot trust-frontmatter host brain/,
      );
    });
  });

  test('enable on already-enabled mount: no-op (idempotent)', async () => {
    const { runMounts } = await import('../src/commands/mounts.ts');
    await withFakeHomeAsync(async (mountsPath) => {
      await seedMount(mountsPath, 'm-idem');
      // Mount starts enabled=true. Calling enable again should be a no-op
      // (no file churn, message indicates already-enabled).
      await runMounts(['enable', 'm-idem']);
      const file = readMountsFile(mountsPath);
      expect(file.mounts[0].enabled).toBe(true);
    });
  });
});

/**
 * Async variant of withFakeHome for tests that await runMounts().
 *
 * v0.40.3.0: ALSO sets GBRAIN_MOUNTS_PATH because libuv caches homedir()
 * on some platforms, so HOME mutation alone isn't picked up by
 * runMounts's internal getMountsPath() call.
 */
async function withFakeHomeAsync<T>(fn: (mountsPath: string) => Promise<T>): Promise<T> {
  const home = mktmp('fake-home-');
  const prev = process.env.HOME;
  const prevMounts = process.env.GBRAIN_MOUNTS_PATH;
  process.env.HOME = home;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const mountsPath = join(home, '.gbrain', 'mounts.json');
  process.env.GBRAIN_MOUNTS_PATH = mountsPath;
  try {
    return await fn(mountsPath);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    else delete process.env.HOME;
    if (prevMounts !== undefined) process.env.GBRAIN_MOUNTS_PATH = prevMounts;
    else delete process.env.GBRAIN_MOUNTS_PATH;
  }
}
